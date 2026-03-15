import { FacilitatorFetchError } from "../errors.js";
import { FACILITATOR_ENDPOINTS } from "../setting.js";
import { PaymentPayload, PaymentRequirements } from "../types/payment.js";
import { FeeQuoteResponse, SettleResponse, SupportedResponse, VerifyResponse } from "../types/responses.js";

class Facilitator {
  static baseUrl = "/api/x402/facilitator";
  constructor(public endpoint: string = FACILITATOR_ENDPOINTS.popular) {}

  async #request<T>(url: string, init?: RequestInit) {
    try {
      const response = await fetch(`${Facilitator.baseUrl}${url}`, init);
      return (await response.json()) as T;
    } catch (error) {
      throw new FacilitatorFetchError(`Fetch ${url} failed`, (error as Error).message);
    }
  }

  async feeQuote(accepts: PaymentRequirements[], context?: Record<string, unknown>): Promise<FeeQuoteResponse[]> {
    return await this.#request("/fee/quote", { method: "GET", body: JSON.stringify({ accepts, context }) });
  }

  async supported(): Promise<SupportedResponse> {
    return await this.#request("/supported", { method: "GET" });
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return await this.#request("/verify", { method: "POST", body: JSON.stringify({ payload, requirements }) });
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return await this.#request("/settle", { method: "POST", body: JSON.stringify({ payload, requirements }) });
  }
}

export { Facilitator };
