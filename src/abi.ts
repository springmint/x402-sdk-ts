/**
 * ABI and EIP-712 type definitions for x402 protocol
 * Shared across all mechanisms
 */

import type { DeliveryKind } from "./types/payment.js";

/** EIP-712 Primary Type for Permit402 */
export const PERMIT402_PRIMARY_TYPE = "Permit402Details";

/**
 * EIP-712 Domain Type
 * Based on contract: keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)")
 * Domain name must be "Permit402" to match contract EIP712.sol
 */
export const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/**
 * EIP-712 type definitions for Permit402
 * Based on PermitHash.sol from the contract
 */
export const PERMIT402_TYPES = {
  PermitMeta: [
    { name: "ptype", type: "uint8" },
    { name: "paymentId", type: "bytes16" },
    { name: "nonce", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
  Payment: [
    { name: "payToken", type: "address" },
    { name: "payAmount", type: "uint256" },
    { name: "payTo", type: "address" },
  ],
  Fee: [
    { name: "feeTo", type: "address" },
    { name: "feeAmount", type: "uint256" },
  ],
  Permit402Details: [
    { name: "meta", type: "PermitMeta" },
    { name: "buyer", type: "address" },
    { name: "payment", type: "Payment" },
    { name: "fee", type: "Fee" },
  ],
} as const;

/** Ptype mapping for EIP-712 (string to numeric) */
export const PTYPE_MAP: Record<DeliveryKind, number> = {
  PAYMENT_ONLY: 0,
};

/** ERC20 ABI for allowance/approve calls */
export const ERC20_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
