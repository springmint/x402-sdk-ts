import { describe, it, expect, vi } from "vitest";
import { Permit402EvmClientMechanism } from "./exactEvm.js";
import { EvmClientSigner } from "../signers/evmSigner.js";
import { PermitValidationError } from "../errors.js";
import { SCHEMES } from "../setting.js";

describe("Permit402EvmClientMechanism", () => {
  const privateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const signer = new EvmClientSigner(privateKey);
  const mechanism = new Permit402EvmClientMechanism(signer);

  const requirements = {
    scheme: SCHEMES.permit402,
    network: "eip155:1",
    amount: "1000000",
    asset: "0x1234567890123456789012345678901234567890",
    payTo: "0x0987654321098765432109876543210987654321",
  };

  const context = {
    meta: {
      ptype: "PAYMENT_ONLY" as const,
      paymentId: "0x12121212121212121212121212121212",
      nonce: "1",
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
    },
  };

  it("should have correct scheme", () => {
    expect(mechanism.scheme()).toBe(SCHEMES.permit402);
  });

  it("should create payment payload", async () => {
    // Mock ensureAllowance to avoid network calls
    vi.spyOn(signer, "ensureAllowance").mockResolvedValue(true);

    const payload = await mechanism.createPaymentPayload(requirements, "https://api.example.com/resource", {
      permit402Context: context,
    });

    expect(payload.x402Version).toBe(2);
    expect(payload.payload.signature).toBeDefined();
    expect(payload.payload.permit402.buyer).toBe(signer.getAddress());
  });

  it("should throw if context is missing", async () => {
    await expect(mechanism.createPaymentPayload(requirements, "resource")).rejects.toThrow(PermitValidationError);
  });
});
