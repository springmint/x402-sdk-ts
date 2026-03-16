import { FacilitatorFetchError } from "../errors.js";
import { FACILITATOR_ENDPOINTS } from "../setting.js";
import { PaymentPayload, PaymentRequirements } from "../types/payment.js";
import { FeeQuoteResponse, SettleResponse, SupportedResponse, VerifyResponse } from "../types/responses.js";

class Facilitator {
  static readonly name = "Cppay.Finanace Facilitator";
  static readonly version = "v1";
  static readonly apikey_header = "X-API-KEY";

  readonly facilitatorId = `${Facilitator.name} ${Facilitator.version}`;

  constructor(
    public apikey: string,
    public endpoint: string = FACILITATOR_ENDPOINTS.popular,
  ) {}

  async #request<T>(url: string, init?: RequestInit) {
    try {
      const fullUrl = new URL(`${this.endpoint}${url}`);
      const response = await fetch(fullUrl, {
        ...init,
        headers: { ...init?.headers, [Facilitator.apikey_header]: this.apikey },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new FacilitatorFetchError(`Request "${url}" failed, Status ${response.status}: ${text}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof FacilitatorFetchError) throw error;
      throw new FacilitatorFetchError(`Request "${url}" failed, ${(error as Error).message}`);
    }
  }

  async feeQuote(
    accepts: PaymentRequirements[],
    context?: Record<string, unknown>,
  ): Promise<FeeQuoteResponse[] | null> {
    return await this.#request("/fee/quote", {
      method: "POST",
      body: JSON.stringify({ accepts, permit402Context: context }),
    });
  }

  async supported(): Promise<SupportedResponse | null> {
    return await this.#request("/supported", { method: "GET" });
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return await this.#request("/verify", {
      method: "POST",
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
    });
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return await this.#request("/settle", {
      method: "POST",
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
    });
  }
}

export { Facilitator };
