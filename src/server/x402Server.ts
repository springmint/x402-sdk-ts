import { randomBytes } from "node:crypto";
import type { PaymentPayload, PaymentRequirements, Permit402 } from "../types/payment.js";
import type { PaymentRequired, ResourceInfo, SettleResponse, VerifyResponse } from "../types/responses.js";
import type { Facilitator } from "./facilitator.js";
import { SCHEMES } from "../setting.js";

export const PAYMENT_ONLY = "PAYMENT_ONLY";

export interface ServerMechanism {
  scheme(): string;
  parsePrice(price: string, network: string): Promise<{ amount: string | number | bigint; asset: string }>;
  enhancePaymentRequirements(requirements: PaymentRequirements, kind: string): Promise<PaymentRequirements>;
  validatePaymentRequirements(requirements: PaymentRequirements): boolean;
  verifySignature?(permit: Permit402, signature: string, network: string): Promise<boolean>;
}

export interface ResourceConfigInit {
  scheme: string;
  network: string;
  price: string;
  payTo?: string;
  pay_to?: string;
  validFor?: number;
  valid_for?: number;
  deliveryMode?: string;
  delivery_mode?: string;
}

export class ResourceConfig {
  scheme: string;
  network: string;
  price: string;
  payTo: string;
  validFor: number;
  deliveryMode: string;

  constructor(init: ResourceConfigInit) {
    const payTo = init.payTo ?? init.pay_to;
    if (!payTo) {
      throw new Error("pay_to (or payTo) is required");
    }

    this.scheme = init.scheme;
    this.network = init.network;
    this.price = init.price;
    this.payTo = payTo;
    this.validFor = init.validFor ?? init.valid_for ?? 3600;
    this.deliveryMode = init.deliveryMode ?? init.delivery_mode ?? PAYMENT_ONLY;
  }

  get pay_to(): string {
    return this.payTo;
  }

  get valid_for(): number {
    return this.validFor;
  }

  get delivery_mode(): string {
    return this.deliveryMode;
  }
}

export class X402Server {
  private mechanisms: Record<string, Record<string, ServerMechanism>> = {};
  private facilitator: Facilitator | null = null;

  constructor(autoRegisterTron = true) {
    if (autoRegisterTron) {
      this.registerDefaultTronMechanisms();
    }
  }

  register(network: string, mechanism: ServerMechanism): X402Server {
    const scheme = mechanism.scheme();
    if (!this.mechanisms[network]) {
      this.mechanisms[network] = {};
    }

    this.mechanisms[network][scheme] = mechanism;
    return this;
  }

  setFacilitator(client: Facilitator): X402Server {
    this.facilitator = client;
    return this;
  }

  set_facilitator(client: Facilitator): X402Server {
    return this.setFacilitator(client);
  }

  async buildPaymentRequirements(configs: ResourceConfig[]): Promise<PaymentRequirements[]> {
    const requirementsList: PaymentRequirements[] = [];

    for (const config of configs) {
      const mechanism = this.findMechanism(config.network, config.scheme);
      if (!mechanism) {
        throw new Error(`No mechanism registered for network=${config.network}, scheme=${config.scheme}`);
      }

      const assetInfo = await mechanism.parsePrice(config.price, config.network);
      const requirements: PaymentRequirements = {
        scheme: config.scheme,
        network: config.network,
        amount: String(assetInfo.amount),
        asset: assetInfo.asset,
        payTo: config.payTo,
        maxTimeoutSeconds: config.validFor,
      };

      const enhanced = await mechanism.enhancePaymentRequirements(requirements, config.deliveryMode);
      requirementsList.push(enhanced);
    }

    if (!this.facilitator) {
      throw new Error("Facilitator is not set");
    }

    const permitReqs = requirementsList.filter((r) => r.scheme !== SCHEMES.erc3009);
    const exactReqs = requirementsList.filter((r) => r.scheme === SCHEMES.erc3009);
    const supported: PaymentRequirements[] = [...exactReqs];

    if (permitReqs.length === 0) {
      return supported;
    }

    const feeQuotes = (await this.facilitator.feeQuote(permitReqs)) ?? [];
    const quoteMap = new Map<string, (typeof feeQuotes)[number]>();
    for (const quote of feeQuotes) {
      quoteMap.set(`${quote.scheme}|${quote.network}|${quote.asset}`.toLowerCase(), quote);
    }

    for (const req of permitReqs) {
      const key = `${req.scheme}|${req.network}|${req.asset}`.toLowerCase();
      const feeQuote = quoteMap.get(key);
      if (!feeQuote) {
        continue;
      }

      req.extra = req.extra ?? {};
      req.extra.fee = {
        facilitatorId: this.facilitator.facilitatorId,
        feeTo: feeQuote.fee.feeTo,
        feeAmount: feeQuote.fee.feeAmount,
      };
      supported.push(req);
    }

    return supported;
  }

  async build_payment_requirements(configs: ResourceConfig[]): Promise<PaymentRequirements[]> {
    return this.buildPaymentRequirements(configs);
  }

  createPaymentRequiredResponse(
    requirements: PaymentRequirements[],
    resourceInfo?: ResourceInfo,
    paymentId?: string,
    nonce?: string,
    validAfter?: number,
    validBefore?: number,
  ): PaymentRequired {
    const now = Math.floor(Date.now() / 1000);

    return {
      x402Version: 2,
      error: "Payment required",
      resource: resourceInfo,
      accepts: requirements,
      extensions: {
        permit402Context: {
          meta: {
            ptype: PAYMENT_ONLY,
            paymentId: paymentId ?? this.generatePaymentId(),
            nonce: nonce ?? this.generateNonce(),
            validAfter: validAfter ?? now,
            validBefore: validBefore ?? now + 3600,
          },
        },
      },
    };
  }

  create_payment_required_response(
    requirements: PaymentRequirements[],
    resourceInfo?: ResourceInfo,
    paymentId?: string,
    nonce?: string,
    validAfter?: number,
    validBefore?: number,
  ): PaymentRequired {
    return this.createPaymentRequiredResponse(requirements, resourceInfo, paymentId, nonce, validAfter, validBefore);
  }

  async verifyPayment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    if (!this.validatePayloadMatchesRequirements(payload, requirements)) {
      return { isValid: false, invalidReason: "payload_mismatch" };
    }

    const mechanism = this.findMechanism(requirements.network, requirements.scheme);
    if (mechanism?.verifySignature) {
      const isValid = await mechanism.verifySignature(
        payload.payload.permit402,
        payload.payload.signature,
        requirements.network,
      );
      if (!isValid) {
        return { isValid: false, invalidReason: "invalid_signature_server" };
      }
    }

    if (!this.facilitator) {
      return { isValid: false, invalidReason: "no_facilitator" };
    }

    return this.facilitator.verify(payload, requirements);
  }

  async verify_payment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.verifyPayment(payload, requirements);
  }

  async settlePayment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    if (!this.facilitator) {
      return { success: false, errorReason: "no_facilitator" };
    }

    return this.facilitator.settle(payload, requirements);
  }

  async settle_payment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.settlePayment(payload, requirements);
  }

  private registerDefaultTronMechanisms(): void {
    // Keep constructor parity with Python API. Default mechanism registration is opt-in by explicit register().
  }

  private findMechanism(network: string, scheme: string): ServerMechanism | null {
    const networkMechanisms = this.mechanisms[network];
    if (!networkMechanisms) {
      return null;
    }

    return networkMechanisms[scheme] ?? null;
  }

  private validatePayloadMatchesRequirements(payload: PaymentPayload, requirements: PaymentRequirements): boolean {
    const permit = payload.payload.permit402;

    if (permit.payment.payToken.toLowerCase() !== requirements.asset.toLowerCase()) {
      return false;
    }

    if (permit.payment.payTo.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return false;
    }

    return BigInt(permit.payment.payAmount) >= BigInt(requirements.amount);
  }

  private generatePaymentId(): string {
    return `0x${randomBytes(16).toString("hex")}`;
  }

  private generateNonce(): string {
    return BigInt(`0x${randomBytes(16).toString("hex")}`).toString();
  }
}
