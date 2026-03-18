/**
 * EvmClientSigner - EVM client signer for x402 protocol
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  fallback,
  type WalletClient,
  type PublicClient,
  type Account,
  type Hex,
  parseAbi,
  type Transport,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia, bsc, bscTestnet } from "viem/chains";
import type { ClientSigner } from "../client/x402Client.js";
import {
  getPermit402Address,
  resolveRpcUrls,
  type RpcUrlMap,
  InsufficientAllowanceError,
  UnsupportedNetworkError,
} from "../index.js";

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

export class EvmClientSigner implements ClientSigner {
  private walletClient: WalletClient<Transport, Chain, Account>;
  private publicClients: Map<number, PublicClient> = new Map();
  private account: Account;
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
    const hexKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    this.account = privateKeyToAccount(hexKey as Hex);
    this.rpcUrl = options?.rpcUrl;
    this.rpcUrls = options?.rpcUrls;
    this.rpcByNetwork = options?.rpcByNetwork;
    this.walletClient = createWalletClient({
      account: this.account,
      chain: mainnet,
      transport: http(),
    });
  }

  getAddress(): string {
    return this.account.address;
  }

  getEvmAddress(): Hex {
    return this.account.address;
  }

  async signMessage(message: Uint8Array): Promise<string> {
    return this.walletClient.signMessage({
      message: { raw: message },
    });
  }

  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, unknown>,
    message: Record<string, unknown>,
  ): Promise<string> {
    const primaryType = types.Permit402Details ? "Permit402Details" : Object.keys(types).pop();

    if (!primaryType) {
      throw new Error("No primary type found in types definition");
    }

    return this.walletClient.signTypedData({
      domain: domain as any,
      types: types as any,
      primaryType,
      message: message as any,
    });
  }

  async checkBalance(token: string, network: string): Promise<bigint> {
    const chainId = this.parseNetworkToChainId(network);
    const client = this.getPublicClient(chainId, network);

    return await client.readContract({
      address: token as Hex,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.account.address],
    });
  }

  async checkAllowance(token: string, _amount: bigint, network: string): Promise<bigint> {
    const chainId = this.parseNetworkToChainId(network);
    const client = this.getPublicClient(chainId, network);
    const spender = getPermit402Address(network) as Hex;

    return await client.readContract({
      address: token as Hex,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.account.address, spender],
    });
  }

  async ensureAllowance(
    token: string,
    amount: bigint,
    network: string,
    mode: "auto" | "interactive" | "skip" = "auto",
  ): Promise<boolean> {
    if (mode === "skip") return true;

    const currentAllowance = await this.checkAllowance(token, amount, network);
    if (currentAllowance >= amount) return true;

    if (mode === "interactive") {
      throw new InsufficientAllowanceError("Interactive approval required");
    }

    const chainId = this.parseNetworkToChainId(network);
    const client = this.getPublicClient(chainId, network);
    const spender = getPermit402Address(network) as Hex;
    const chain = this.getChain(chainId);

    try {
      const transport = this.createTransport(network);
      const walletClient = createWalletClient({
        account: this.account,
        chain: chain,
        transport,
      });

      const hash = await walletClient.writeContract({
        address: token as Hex,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, BigInt(2) ** BigInt(256) - BigInt(1)],
      });

      const receipt = await client.waitForTransactionReceipt({ hash });

      return receipt.status === "success";
    } catch (error) {
      throw new InsufficientAllowanceError(
        `ERC20 approval transaction failed for ${token}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getPublicClient(chainId: number, network: string): PublicClient {
    let client = this.publicClients.get(chainId);
    if (!client) {
      const transport = this.createTransport(network);
      client = createPublicClient({
        chain: this.getChain(chainId),
        transport,
      });
      this.publicClients.set(chainId, client);
    }
    return client;
  }

  private createTransport(network: string): Transport {
    const candidates = this.getRpcCandidates(network);
    if (candidates.length === 0) {
      throw new UnsupportedNetworkError(`No RPC URL configured for network: ${network}`);
    }

    if (candidates.length === 1) {
      return http(candidates[0]);
    }

    return fallback(
      candidates.map((url) => http(url)),
      { rank: false, retryCount: 1 },
    );
  }

  private getRpcCandidates(network: string): string[] {
    const perNetwork = this.rpcByNetwork?.[network];
    const perNetworkList = Array.isArray(perNetwork) ? perNetwork : perNetwork ? [perNetwork] : [];
    const globalList = this.rpcUrls?.length ? this.rpcUrls : this.rpcUrl ? [this.rpcUrl] : [];
    const overrides: RpcUrlMap = {
      ...(this.rpcByNetwork ?? {}),
      [network]: [...perNetworkList, ...globalList],
    };
    return resolveRpcUrls(network, overrides);
  }

  private getChain(chainId: number): Chain {
    const chains: Record<number, Chain> = {
      1: mainnet,
      11155111: sepolia,
      56: bsc,
      97: bscTestnet,
    };

    const chain = chains[chainId];
    if (!chain) {
      throw new UnsupportedNetworkError(`Unsupported EVM chain ID: ${chainId}`);
    }
    return chain;
  }

  private parseNetworkToChainId(network: string): number {
    if (!network.startsWith("eip155:")) {
      throw new UnsupportedNetworkError(`Invalid EVM network format: ${network}`);
    }
    const chainId = parseInt(network.split(":")[1], 10);
    if (isNaN(chainId)) {
      throw new UnsupportedNetworkError(`Invalid EVM chain ID in: ${network}`);
    }
    return chainId;
  }
}
