import { beforeEach, describe, expect, it, vi } from "vitest";
import { config as loadEnv } from "dotenv";
import { Facilitator } from "../../server/facilitator";
import { type ServerMechanism, X402Server } from "../../server/x402Server";
import { EvmClientSigner } from "../../signers/evmSigner";
import { x402_protected, type MiddlewareRequestLike, type NodeResponseLike } from "../middleware";
import { X402Client } from "../../client";
import { Permit402EvmClientMechanism, SCHEMES, X402FetchClient } from "../..";
import { resolve } from "node:path";

loadEnv({ path: resolve(__dirname, "../../../.env") });

const DEFAULT_TEST_PRIVATE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY ?? DEFAULT_TEST_PRIVATE_KEY;
const API_KEY = process.env.API_KEY ?? "";

// eip155:97 USDT — must match the token registry
const TEST_NETWORK = "eip155:97";
const TEST_USDT_ADDRESS = "0x64544969ed7EBf5f083679233325356EbE738930";
const TEST_PAY_TO = "0xc8724eddb741b2bebebe7aaf2cb2c51300000000";

describe("x402_protected", () => {
  let server: X402Server;
  let facilitator: Facilitator;
  let signer: EvmClientSigner;
  let fetchClient: X402FetchClient;
  const serverMechanism: ServerMechanism = {
    scheme: () => SCHEMES.permit402,
    parsePrice: async () => ({ amount: "1000000", asset: TEST_USDT_ADDRESS }),
    enhancePaymentRequirements: async (requirements) => requirements,
    validatePaymentRequirements: () => true,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    facilitator = new Facilitator(API_KEY);

    signer = new EvmClientSigner(EVM_PRIVATE_KEY);
    expect(signer.getAddress()).toBeTruthy();

    server = new X402Server(false);
    server.setFacilitator(facilitator);
    server.register(TEST_NETWORK, serverMechanism);

    const x402Client = new X402Client();
    const clientMechanism = new Permit402EvmClientMechanism(signer);
    x402Client.register(TEST_NETWORK, clientMechanism);

    fetchClient = new X402FetchClient(x402Client);
  });

  it("throws at decoration time when prices/schemes length mismatch", () => {
    expect(() =>
      x402_protected(server, ["0.01 USDT", "0.01 USDC"], [SCHEMES.permit402], TEST_NETWORK, TEST_PAY_TO),
    ).toThrow("schemes length");
  });

  it("throws at decoration time when token symbol is unknown for the network", () => {
    expect(() => x402_protected(server, ["0.01 UNKNOWNTOKEN"], [SCHEMES.permit402], TEST_NETWORK, TEST_PAY_TO)).toThrow(
      "Unknown token symbol",
    );
  });

  it("simulates real /api request flow with X402FetchClient and retries with payment", async () => {
    const decorator = x402_protected(server, ["0.01 USDC"], [SCHEMES.permit402], TEST_NETWORK, TEST_PAY_TO);
    const handler = vi.fn(async (_req: MiddlewareRequestLike) => ({ data: "secret" }));
    const wrapped = decorator(handler);

    const realFetch = fetch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== "https://example.com/api/protected") {
        return realFetch(input, init);
      }

      const response = await wrapped({
        url,
        headers: init?.headers,
      });
      if (!response) {
        throw new Error("Expected a fetch-style Response");
      }

      return response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchClient.get("https://example.com/api/protected");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toBe("secret");
  }, 0);

  it("supports Express style direct middleware usage", async () => {
    const middleware = x402_protected(server, ["0.01 USDC"], [SCHEMES.permit402], TEST_NETWORK, TEST_PAY_TO);

    const next = vi.fn();
    const res: NodeResponseLike = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      end: vi.fn(),
    };

    await middleware(
      {
        url: "https://example.com/api/protected",
      },
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    const [statusCode] = (res.status as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(typeof statusCode).toBe("number");
    expect(statusCode).toBeGreaterThanOrEqual(400);
    expect(res.setHeader).toHaveBeenCalled();
  });

  it("supports Express style middleware returned by decorator", async () => {
    const decorator = x402_protected(server, ["0.01 USDC"], [SCHEMES.permit402], TEST_NETWORK, TEST_PAY_TO);
    const wrapped = decorator(async () => ({ message: "private data" }));

    const res: NodeResponseLike = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      end: vi.fn(),
    };

    await wrapped(
      {
        url: "https://example.com/api/paid-endpoint",
      },
      res,
      vi.fn(),
    );

    const [statusCode] = (res.status as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(typeof statusCode).toBe("number");
    expect(statusCode).toBeGreaterThanOrEqual(400);
    expect(res.send).toHaveBeenCalled();
  });
});
