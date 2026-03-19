/**
 * TronClientSigner - TRON client signer for x402 protocol
 *
 * Uses TronWeb's signTypedData (TIP-712) for EIP-712 compatible signing.
 */

import type { ClientSigner } from "../index.js";
import {
  getPermit402Address,
  toEvmHex,
  type Hex,
  SignatureCreationError,
  InsufficientAllowanceError,
  UnsupportedNetworkError,
  resolveRpcUrls,
  type RpcUrlMap,
} from "../index.js";
import { TronWeb as TronWebClass } from "tronweb";
import type { TronWeb, TypedDataDomain, TypedDataField } from "./types.js";

/** ERC20 function selectors */
const ERC20_ALLOWANCE_SELECTOR = "allowance(address,address)";
const ERC20_APPROVE_SELECTOR = "approve(address,uint256)";

/**
 * TRON client signer implementation using TronWeb's signTypedData
 */
export class TronClientSigner implements ClientSigner {
  private privateKey: string;
  private address: string; // Base58 format
  private tronWebInstances: Map<string, TronWeb> = new Map();
  private rpcUrl?: string;
  private rpcUrls?: string[];
  private rpcByNetwork?: RpcUrlMap;

  constructor(
    privateKey: string,
    options?: {
      rpcUrl?: string;
      rpcUrls?: string[];
      rpcByNetwork?: RpcUrlMap;
    },
  ) {
    const cleanKey = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
    this.privateKey = cleanKey;
    this.rpcUrl = options?.rpcUrl;
    this.rpcUrls = options?.rpcUrls;
    this.rpcByNetwork = options?.rpcByNetwork;
    // Derive address using a temporary TronWeb instance (pure crypto, no network needed)
    const tw = this.getDefaultTronWeb();
    this.address = tw.address.fromPrivateKey(cleanKey);
  }

  /**
   * Get or create a TronWeb instance for the given network.
   */
  private getTronWeb(network?: string): TronWeb {
    const host = this.getRpcCandidates(network)[0];
    if (!host) {
      throw new UnsupportedNetworkError(`No RPC URL configured for network: ${network}`);
    }
    return this.getOrCreateTronWeb(host);
  }

  private getDefaultTronWeb(): TronWeb {
    const host = this.getRpcCandidates("tron:nile")[0] ?? "https://nile.trongrid.io";
    return this.getOrCreateTronWeb(host);
  }

  private getOrCreateTronWeb(host: string): TronWeb {
    let tw = this.tronWebInstances.get(host);
    if (!tw) {
      tw = this.createTronWeb(host);
      this.tronWebInstances.set(host, tw);
    }
    return tw;
  }

  private getRpcCandidates(network?: string): string[] {
    if (!network) {
      const global = this.rpcUrls?.length ? this.rpcUrls : this.rpcUrl ? [this.rpcUrl] : [];
      const deduped = global.filter((url, index) => global.indexOf(url) === index);
      return deduped.length > 0 ? deduped : ["https://nile.trongrid.io"];
    }

    const perNetwork = this.rpcByNetwork?.[network];
    const perNetworkList = Array.isArray(perNetwork) ? perNetwork : perNetwork ? [perNetwork] : [];
    const globalList = this.rpcUrls?.length ? this.rpcUrls : this.rpcUrl ? [this.rpcUrl] : [];
    const overrides: RpcUrlMap = {
      ...(this.rpcByNetwork ?? {}),
      [network]: [...perNetworkList, ...globalList],
    };
    return resolveRpcUrls(network, overrides);
  }

  private async executeWithRpcFallback<T>(network: string, action: (tw: TronWeb) => Promise<T>): Promise<T> {
    const candidates = this.getRpcCandidates(network);
    if (candidates.length === 0) {
      throw new UnsupportedNetworkError(`No RPC URL configured for network: ${network}`);
    }

    let lastError: unknown;
    for (const host of candidates) {
      const tw = this.getOrCreateTronWeb(host);
      try {
        return await action(tw);
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      `All RPC endpoints failed for ${network}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private createTronWeb(fullHost: string): TronWeb {
    const apiKey = typeof process !== "undefined" ? process.env?.TRON_GRID_API_KEY : undefined;
    const headers = apiKey ? { "TRON-PRO-API-KEY": apiKey } : undefined;
    return new TronWebClass({ fullHost, privateKey: this.privateKey, headers }) as unknown as TronWeb;
  }

  getAddress(): string {
    return this.address;
  }

  getEvmAddress(): Hex {
    return toEvmHex(this.address);
  }

  async signMessage(message: Uint8Array): Promise<string> {
    const messageHex = Array.from(message)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // Signing is pure crypto — any TronWeb instance works
    const tw = this.getDefaultTronWeb();
    return tw.trx.signMessageV2(messageHex, this.privateKey);
  }

  /**
   * Sign EIP-712 typed data using TronWeb's signTypedData (TIP-712)
   */
  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, unknown>,
    message: Record<string, unknown>,
  ): Promise<string> {
    // Prepare domain
    const typedDomain: TypedDataDomain = {
      name: domain.name as string,
      chainId: domain.chainId as number,
      verifyingContract: domain.verifyingContract as string,
    };

    // Signing is pure crypto — any TronWeb instance works
    const tw = this.getDefaultTronWeb();
    // Use signTypedData (stable API) or fall back to _signTypedData (legacy)
    const signFn = tw.trx.signTypedData || tw.trx._signTypedData;
    if (!signFn) {
      throw new SignatureCreationError("TronWeb does not support signTypedData. Please upgrade to TronWeb >= 5.0");
    }

    return signFn.call(tw.trx, typedDomain, types as Record<string, TypedDataField[]>, message, this.privateKey);
  }

  async checkBalance(token: string, network: string): Promise<bigint> {
    const ownerHex = toEvmHex(this.address);

    return this.executeWithRpcFallback(network, async (tw) => {
      const result = await tw.transactionBuilder.triggerConstantContract(
        token,
        "balanceOf(address)",
        {},
        [{ type: "address", value: ownerHex }],
        this.address,
      );

      if (result.result?.result && result.constant_result?.length) {
        return BigInt("0x" + result.constant_result[0]);
      }

      throw new Error(`checkBalance failed for ${token} on ${network}: no result from RPC`);
    });
  }

  async checkAllowance(token: string, _amount: bigint, network: string): Promise<bigint> {
    const spender = getPermit402Address(network);

    const ownerHex = toEvmHex(this.address);
    const spenderHex = toEvmHex(spender);

    return this.executeWithRpcFallback(network, async (tw) => {
      const result = await tw.transactionBuilder.triggerConstantContract(
        token,
        ERC20_ALLOWANCE_SELECTOR,
        {},
        [
          { type: "address", value: ownerHex },
          { type: "address", value: spenderHex },
        ],
        this.address,
      );

      if (result.result?.result && result.constant_result?.length) {
        return BigInt("0x" + result.constant_result[0]);
      }

      throw new Error(`checkAllowance failed for ${token} on ${network}: no result from RPC`);
    });
  }

  async ensureAllowance(
    token: string,
    amount: bigint,
    network: string,
    mode: "auto" | "interactive" | "skip" = "auto",
  ): Promise<boolean> {
    if (mode === "skip") {
      return true;
    }

    const currentAllowance = await this.checkAllowance(token, amount, network);
    if (currentAllowance >= amount) {
      return true;
    }

    if (mode === "interactive") {
      throw new InsufficientAllowanceError("Interactive approval not implemented - use wallet UI");
    }

    // Auto mode: send approve transaction
    const spender = getPermit402Address(network);
    const spenderHex = toEvmHex(spender);

    // Use maxUint160 (2^160 - 1) to avoid repeated approvals
    const maxUint160 = BigInt(2) ** BigInt(160) - BigInt(1);

    try {
      return await this.executeWithRpcFallback(network, async (tw) => {
        // Build approve transaction
        const tx = await tw.transactionBuilder.triggerSmartContract(
          token,
          ERC20_APPROVE_SELECTOR,
          {
            feeLimit: 100_000_000,
            callValue: 0,
          },
          [
            { type: "address", value: spenderHex },
            { type: "uint256", value: maxUint160.toString() },
          ],
          this.address,
        );

        if (!tx.result?.result) {
          throw new InsufficientAllowanceError("Failed to build approve transaction");
        }

        // Sign transaction
        const signedTx = await tw.trx.sign(tx.transaction, this.privateKey);

        // Broadcast transaction
        const broadcast = await tw.trx.sendRawTransaction(signedTx);

        if (!broadcast.result) {
          throw new InsufficientAllowanceError(`Failed to broadcast approve transaction: ${JSON.stringify(broadcast)}`);
        }

        // Wait for confirmation (poll for ~30 seconds)
        const txid = broadcast.txid;
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          try {
            const info = await tw.trx.getTransactionInfo(txid);
            if (info && info.blockNumber) {
              if (info.receipt?.result === "SUCCESS") {
                return true;
              }
              throw new InsufficientAllowanceError(
                `Approve transaction failed on-chain for tx ${txid}: ${info.receipt?.result ?? "UNKNOWN"}`,
              );
            }
          } catch (error) {
            if (error instanceof InsufficientAllowanceError) {
              throw error;
            }
            // Not confirmed yet, continue polling
          }
        }

        throw new InsufficientAllowanceError(`Approve transaction not confirmed within timeout: ${txid}`);
      });
    } catch (error) {
      if (error instanceof InsufficientAllowanceError) throw error;
      throw new InsufficientAllowanceError(
        `Approve transaction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
