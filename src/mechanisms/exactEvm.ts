/**
 * ExactPermitEvmClientMechanism - EVM client mechanism for "permit402" payment scheme
 */

import type {
  ClientMechanism,
  ClientSigner,
  PaymentRequirements,
  PaymentPayload,
  Permit402,
  Permit402Context,
} from "../index.js";
import {
  PTYPE_MAP,
  PERMIT402_TYPES,
  getChainId,
  getPermit402Address,
  EVM_ZERO_ADDRESS,
  EvmAddressConverter,
  ZERO_ADDRESS_HEX,
  PermitValidationError,
} from "../index.js";

/**
 * EVM client mechanism for "permit402" payment scheme
 */
export class ExactPermitEvmClientMechanism implements ClientMechanism {
  private signer: ClientSigner;
  private addressConverter = new EvmAddressConverter();

  constructor(signer: ClientSigner) {
    this.signer = signer;
  }

  getSigner(): ClientSigner {
    return this.signer;
  }

  scheme(): string {
    return "permit402";
  }

  async createPaymentPayload(
    requirements: PaymentRequirements,
    resource: string,
    extensions?: { permit402Context?: Permit402Context },
  ): Promise<PaymentPayload> {
    const context = extensions?.permit402Context;
    if (!context) {
      throw new PermitValidationError("missing_context", "permit402Context is required");
    }

    const buyerAddress = this.signer.getAddress();
    const zeroAddress = EVM_ZERO_ADDRESS;

    const permit: Permit402 = {
      meta: {
        ptype: context.meta.ptype,
        paymentId: context.meta.paymentId,
        nonce: context.meta.nonce,
        validAfter: context.meta.validAfter,
        validBefore: context.meta.validBefore,
      },
      buyer: buyerAddress,
      payment: {
        payToken: requirements.asset,
        payAmount: requirements.amount,
        payTo: requirements.payTo,
      },
      fee: {
        feeTo: requirements.extra?.fee?.feeTo || zeroAddress,
        feeAmount: requirements.extra?.fee?.feeAmount || "0",
      },
    };

    // Ensure allowance
    const totalAmount = BigInt(permit.payment.payAmount) + BigInt(permit.fee.feeAmount);
    await this.signer.ensureAllowance(permit.payment.payToken, totalAmount, requirements.network);

    // Build EIP-712 domain
    const permitAddress = getPermit402Address(requirements.network);
    const domain = {
      name: "Permit402",
      chainId: getChainId(requirements.network),
      verifyingContract: this.addressConverter.toEvmFormat(permitAddress),
    };

    // Convert permit to EIP-712 compatible format
    const permitForSigning = {
      meta: {
        ptype: PTYPE_MAP[permit.meta.ptype],
        paymentId: permit.meta.paymentId,
        nonce: BigInt(permit.meta.nonce),
        validAfter: permit.meta.validAfter,
        validBefore: permit.meta.validBefore,
      },
      buyer: this.addressConverter.toEvmFormat(permit.buyer),
      payment: {
        payToken: this.addressConverter.toEvmFormat(permit.payment.payToken),
        payAmount: BigInt(permit.payment.payAmount),
        payTo: this.addressConverter.toEvmFormat(permit.payment.payTo),
      },
      fee: {
        feeTo: this.addressConverter.toEvmFormat(permit.fee.feeTo),
        feeAmount: BigInt(permit.fee.feeAmount),
      },
    };

    const signature = await this.signer.signTypedData(
      domain,
      PERMIT402_TYPES,
      permitForSigning as unknown as Record<string, unknown>,
    );

    return {
      x402Version: 2,
      resource: { url: resource },
      accepted: requirements,
      payload: {
        signature,
        permit402: permit,
      },
      extensions: {},
    };
  }
}
