/**
 * Network configuration for x402 protocol
 * Centralized configuration for contract addresses and chain IDs
 */

import { UnsupportedNetworkError } from "./errors.js";

/** Chain IDs for supported networks */
export const CHAIN_IDS: Record<string, number> = {
  // TRON networks
  "tron:mainnet": 728126428, // 0x2b6653dc
  "tron:shasta": 2494104990, // 0x94a9059e
  "tron:nile": 3448148188, // 0xcd8690dc

  // EVM networks
  "eip155:1": 1, // Ethereum Mainnet
  "eip155:11155111": 11155111, // Sepolia
  "eip155:56": 56, // BSC Mainnet
  "eip155:97": 97, // BSC Testnet
};

/** Network identifier constants */
export const NETWORKS = {
  TRON_MAINNET: "tron:mainnet",
  TRON_SHASTA: "tron:shasta",
  TRON_NILE: "tron:nile",
  EVM_MAINNET: "eip155:1",
  EVM_SEPOLIA: "eip155:11155111",
  BSC_MAINNET: "eip155:56",
  BSC_TESTNET: "eip155:97",
} as const;

/** Permit402 contract addresses */
export const PERMIT402_ADDRESSES: Record<string, string> = {
  "tron:mainnet": "TK5kfgbNK5B5sFWSbtDs2HyCaSUuEzfN2B",
  "tron:shasta": "TSNfGRDkyyDY4dHsWzQ6rWWG63p9iczz1k",
  "tron:nile": "TRK2rYmbyFZKcPTDREEF36rEsLfDWZXnjA",
  "eip155:97": "",
  "eip155:56": "0x105a6f4613a1d1c17ef35d4d5f053fa2e659a958",
};

/** Default RPC URLs for EVM networks */
export const EVM_RPC_URLS: Record<string, string> = {
  "eip155:97": "https://data-seed-prebsc-2-s2.bnbchain.org:8545",
  "eip155:56": "https://rpc-bsc.48.club",
  // 'eip155:1': 'https://eth.llamarpc.com',
};

/** Default TronGrid hosts for TRON networks */
export const TRON_RPC_URLS: Record<string, string> = {
  "tron:mainnet": "https://api.trongrid.io",
  "tron:shasta": "https://api.shasta.trongrid.io",
  "tron:nile": "https://nile.trongrid.io",
};

/**
 * Resolve a network identifier to an RPC URL.
 * Returns the URL from the built-in map, or undefined if not configured.
 */
export function resolveRpcUrl(network: string): string | undefined {
  return EVM_RPC_URLS[network] ?? TRON_RPC_URLS[network];
}

/** Zero address for TRON */
export const TRON_ZERO_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

/** Zero address for EVM */
export const EVM_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Get chain ID for network
 */
export function getChainId(network: string): number {
  // EVM networks encode chain ID directly in the identifier
  if (network.startsWith("eip155:")) {
    const id = parseInt(network.split(":")[1], 10);
    if (isNaN(id)) {
      throw new UnsupportedNetworkError(`Invalid EVM network: ${network}`);
    }
    return id;
  }

  const chainId = CHAIN_IDS[network];
  if (chainId === undefined) {
    throw new UnsupportedNetworkError(`Unsupported network: ${network}`);
  }
  return chainId;
}

/**
 * Get Permit402 contract address for network
 */
export function getPermit402Address(network: string): string {
  const addr = PERMIT402_ADDRESSES[network];
  if (addr) return addr;
  // EVM fallback: zero address (not yet deployed)
  if (network.startsWith("eip155:")) return EVM_ZERO_ADDRESS;
  return TRON_ZERO_ADDRESS;
}

/**
 * Check if network is TRON
 */
export function isTronNetwork(network: string): boolean {
  return network.startsWith("tron:");
}

/**
 * Check if network is EVM
 */
export function isEvmNetwork(network: string): boolean {
  return network.startsWith("eip155:");
}

/**
 * Get zero address for network
 */
export function getZeroAddress(network: string): string {
  if (isEvmNetwork(network)) return EVM_ZERO_ADDRESS;
  if (isTronNetwork(network)) return TRON_ZERO_ADDRESS;
  throw new UnsupportedNetworkError(`Unsupported network: ${network}`);
}

export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const JSON_CONTENT_TYPE = "application/json";
