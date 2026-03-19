import type { RequestHandler, Response as ExpressResponse } from "express";
import { decodePaymentPayload, encodePaymentPayload } from "../utils/encoding.js";
import { JSON_CONTENT_TYPE, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "../config.js";
import { getToken } from "../tokens.js";
import { PAYMENT_ONLY, ResourceConfig, type X402Server } from "../server/x402Server.js";
import type { PaymentPayload, PaymentRequirements } from "../types/payment.js";
import { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "http";

export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export interface TransactionVerificationResult {
  success: boolean;
  txHash: string;
  blockNumber?: string | null;
  errorReason?: string | null;
  statusVerified?: boolean;
  paymentVerified?: boolean;
  feeVerified?: boolean;
}

export interface TransactionVerifier {
  verifyTransaction(
    txHash: string,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<TransactionVerificationResult>;
}

export interface MiddlewareRequestLike {
  headers?: Headers | IncomingHttpHeaders;
  url?: string | URL;
}

type ProtectedHandler<TRequest extends MiddlewareRequestLike, TResult> = (
  request: TRequest,
  ...args: unknown[]
) => TResult | Promise<TResult>;

export class X402Middleware {
  private server: X402Server;
  private verifiers: Map<string, TransactionVerifier>;

  constructor(server: X402Server, verifiers?: Map<string, TransactionVerifier>) {
    this.server = server;
    this.verifiers = verifiers ?? new Map();
  }

  protect(
    prices: string[],
    schemes: string[],
    network?: string,
    pay_to?: string,
    valid_for = 3600,
    delivery_mode = PAYMENT_ONLY,
  ) {
    if (!prices || !schemes || !network || !pay_to) {
      throw new Error("prices, schemes, network, and pay_to are required");
    }

    if (schemes.length !== prices.length) {
      throw new Error(`schemes length (${schemes.length}) must match prices length (${prices.length})`);
    }

    for (const price of prices) {
      const parts = price.trim().split(/\s+/);
      if (parts.length !== 2) {
        throw new Error(`Invalid price format: ${price}`);
      }

      const symbol = parts[1];
      const token = getToken(network, symbol);
      if (!token) {
        throw new Error(`Unknown token symbol ${symbol} on ${network}`);
      }
    }

    const configs = prices.map(
      (price, index) =>
        new ResourceConfig({
          scheme: schemes[index],
          network,
          price,
          pay_to,
          valid_for,
          delivery_mode,
        }),
    );

    return <TRequest extends MiddlewareRequestLike, TResult>(func: ProtectedHandler<TRequest, TResult>) => {
      return async (request: TRequest, ...args: unknown[]): Promise<Response> => {
        const paymentHeader = this.readHeader(request.headers, PAYMENT_SIGNATURE_HEADER);
        if (!paymentHeader) {
          console.log("[x402] No payment header, returning 402 Payment Required");
          return this.returnPaymentRequired(request, configs);
        }

        console.log("[x402] Payment header present, decoding payload...");
        let payload: PaymentPayload;
        try {
          payload = decodePaymentPayload<PaymentPayload>(paymentHeader);
          console.log("[x402] Payload decoded:", {
            network: payload.accepted?.network,
            asset: payload.accepted?.asset,
            scheme: payload.accepted?.scheme,
          });
        } catch (error) {
          console.error("[x402] Invalid payment payload:", (error as Error).message);
          return this.jsonResponse({ error: `Invalid payment payload: ${(error as Error).message}` }, 400);
        }

        const config = this.matchConfig(configs, payload.accepted.network, payload.accepted.asset);
        if (!config) {
          console.error("[x402] No matching config for", {
            network: payload.accepted.network,
            asset: payload.accepted.asset,
          });
          return this.jsonResponse({ error: "Unsupported payment token or network" }, 400);
        }
        console.log("[x402] Config matched:", { price: config.price, scheme: config.scheme });

        const requirements = (await this.server.buildPaymentRequirements([config]))[0];
        console.log("[x402] Requirements built:", {
          amount: requirements.amount,
          asset: requirements.asset,
          payTo: requirements.payTo,
        });

        let verifyed;
        try {
          verifyed = await this.server.verifyPayment(payload, requirements);
          console.log("[x402] verifyPayment result:", verifyed);
        } catch (error) {
          console.error("[x402] verifyPayment threw:", error);
          return this.jsonResponse({ error: `Verify request failed: ${(error as Error).message}` }, 500);
        }
        if (!verifyed.isValid) {
          console.error("[x402] Verify failed:", verifyed.invalidReason);
          const content: Record<string, unknown> = {
            error: `Verify failed: ${verifyed.invalidReason}`,
          };
          return this.jsonResponse(content, 500);
        }

        let settleResult;
        try {
          settleResult = await this.server.settlePayment(payload, requirements);
          console.log("[x402] settlePayment result:", settleResult);
        } catch (error) {
          console.error("[x402] settlePayment threw:", error);
          return this.jsonResponse({ error: `Settlement request failed: ${(error as Error).message}` }, 500);
        }
        if (!settleResult.success) {
          console.error("[x402] Settlement failed:", settleResult.errorReason);
          const content: Record<string, unknown> = {
            error: `Settlement failed: ${settleResult.errorReason}`,
          };

          if (settleResult.transaction) {
            content.txHash = settleResult.transaction;
          }

          if (settleResult.network) {
            content.network = settleResult.network;
          }

          return this.jsonResponse(content, 500);
        }

        if (settleResult.transaction) {
          const txVerifyResult = await this.verifyTransactionOnChain(
            settleResult.transaction,
            payload,
            requirements,
            requirements.network,
          );
          if (!txVerifyResult.success) {
            console.error("[x402] Transaction verification failed:", txVerifyResult.errorReason);
            return this.jsonResponse(
              {
                error: `Transaction verification failed: ${txVerifyResult.errorReason}`,
                txHash: settleResult.transaction,
              },
              500,
            );
          }
        }

        console.log("[x402] Payment verified and settled, invoking handler");
        const response = await func(request, ...args);
        const encodedSettle = encodePaymentPayload(settleResult);

        if (response instanceof Response) {
          response.headers.set(PAYMENT_RESPONSE_HEADER, encodedSettle);
          return response;
        }

        const wrapped = this.jsonResponse(response, 200);
        wrapped.headers.set(PAYMENT_RESPONSE_HEADER, encodedSettle);
        return wrapped;
      };
    };
  }

  private matchConfig(configs: ResourceConfig[], network: string, asset: string): ResourceConfig | null {
    for (const config of configs) {
      if (config.network !== network) {
        continue;
      }

      const parts = config.price.trim().split(/\s+/);
      if (parts.length !== 2) {
        continue;
      }

      const symbol = parts[1];
      const token = getToken(config.network, symbol);
      if (token && token.address.toLowerCase() === asset.toLowerCase()) {
        return config;
      }
    }

    return null;
  }

  private async verifyTransactionOnChain(
    txHash: string,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    network: string,
  ): Promise<TransactionVerificationResult> {
    const verifier = this.verifiers.get(network);
    if (!verifier) {
      // No verifier registered for this network — skip on-chain verification
      return { success: true, txHash, statusVerified: true };
    }

    try {
      return await verifier.verifyTransaction(txHash, payload, requirements);
    } catch (error) {
      return {
        success: false,
        txHash,
        errorReason: (error as Error).message,
      };
    }
  }

  private async returnPaymentRequired(
    request: MiddlewareRequestLike,
    configs: ResourceConfig[],
    error?: string,
  ): Promise<Response> {
    const requirementsList = await this.server.buildPaymentRequirements(configs);
    if (requirementsList.length === 0) {
      return this.jsonResponse({ error: "No supported payment options available" }, 500);
    }

    const paymentRequired = this.server.createPaymentRequiredResponse(requirementsList, {
      url: request.url ? String(request.url) : undefined,
    });

    const responseData: Record<string, unknown> = { ...paymentRequired };
    if (error) {
      responseData.error = error;
    }

    const response = this.jsonResponse(responseData, 402);
    response.headers.set(PAYMENT_REQUIRED_HEADER, encodePaymentPayload(responseData));

    return response;
  }

  private readHeader(headers: Headers | IncomingHttpHeaders | undefined, key: string): string | null {
    if (!headers) {
      return null;
    }

    if (headers instanceof Headers) {
      return headers.get(key);
    }

    if (Array.isArray(headers)) {
      const normalized = key.toLowerCase();
      for (const entry of headers) {
        if (!Array.isArray(entry) || entry.length < 2) {
          continue;
        }

        if (entry[0].toLowerCase() === normalized) {
          return entry[1];
        }
      }

      return null;
    }

    const value = headers[key as keyof typeof headers];
    if (typeof value === "string") {
      return value;
    }

    const lower = headers[key.toLowerCase() as keyof typeof headers];
    return typeof lower === "string" ? lower : null;
  }

  private jsonResponse(payload: unknown, status: number): Response {
    const headers = new Headers();
    headers.set("content-type", JSON_CONTENT_TYPE);
    return new Response(JSON.stringify(payload), { status, headers });
  }
}

export function x402Protected(
  server: X402Server,
  prices: string[],
  schemes: string[],
  network: string,
  pay_to: string,
  options?: { valid_for?: number; delivery_mode?: string; verifiers?: Map<string, TransactionVerifier> },
) {
  const middleware = new X402Middleware(server, options?.verifiers);
  return middleware.protect(
    prices,
    schemes,
    network,
    pay_to,
    options?.valid_for ?? 3600,
    options?.delivery_mode ?? PAYMENT_ONLY,
  );
}

export function x402_protected(
  server: X402Server,
  prices: string[],
  schemes: string[],
  network: string,
  pay_to: string,
  options?: { valid_for?: number; delivery_mode?: string; verifiers?: Map<string, TransactionVerifier> },
) {
  return x402Protected(server, prices, schemes, network, pay_to, options);
}

/**
 * 把 Express req 转成 Fetch Request
 */
async function toFetchRequest(req: any): Promise<Request> {
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  // 关键：缓存 body，避免 stream 被消费
  let body: Buffer | undefined;

  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  return new Request(url, {
    method: req.method,
    headers: req.headers as any,
    body: body,
  });
}

async function writeFetchResponse(res: ExpressResponse, response: Response) {
  res.status(response.status);

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  res.send(buffer);
}

export function expressMiddleware(
  server: any,
  prices: string[],
  schemes: string[],
  network: string,
  payTo: string,
): RequestHandler {
  const protectedFn = x402Protected(server, prices, schemes, network, payTo);

  return async (req, res, next) => {
    try {
      const fetchReq = await toFetchRequest(req);
      const response = await protectedFn(async () => {
        return new Response(null, { status: 200 });
      })(fetchReq);

      if (response.status === 402) {
        await writeFetchResponse(res, response);
        return;
      }

      const paymentHeader = response.headers.get(PAYMENT_RESPONSE_HEADER);
      if (paymentHeader) {
        res.setHeader(PAYMENT_RESPONSE_HEADER, paymentHeader);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

export function express_middleware(
  server: any,
  prices: string[],
  schemes: string[],
  network: string,
  payTo: string,
): RequestHandler {
  return expressMiddleware(server, prices, schemes, network, payTo);
}
