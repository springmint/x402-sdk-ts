/**
 * Payment policies for filtering or reordering payment requirements.
 *
 * Policies are applied in order after mechanism filtering and before token selection.
 */

import type { PaymentRequirements } from "../types/index.js";
import type { PaymentPolicy } from "./x402Client.js";
import type { X402Client } from "./x402Client.js";

/**
 * Policy that filters out requirements with insufficient balance.
 *
 * When the server accepts multiple tokens (e.g. USDT and USDD),
 * this policy checks the user's on-chain balance for each option
 * and removes requirements the user cannot afford.
 *
 * Signers are auto-resolved from registered mechanisms via the
 * X402Client instance passed at construction time.
 *
 * Usage:
 *   x402.registerPolicy(SufficientBalancePolicy);
 *
 * Requirements whose network has no matching signer are kept as-is
 * (not filtered out), so downstream mechanism matching can still work.
 *
 * If all requirements are unaffordable, returns an empty array so the
 * caller can raise an appropriate error.
 */
export class SufficientBalancePolicy implements PaymentPolicy {
  private client: X402Client;

  constructor(client: X402Client) {
    this.client = client;
  }

  async apply(requirements: PaymentRequirements[]): Promise<PaymentRequirements[]> {
    const affordable: PaymentRequirements[] = [];
    for (const req of requirements) {
      const signer = this.client.resolveSigner(req.scheme, req.network);
      if (!signer) {
        // No signer for this network — keep the requirement so mechanism
        // matching can still select it (balance check is best-effort).
        affordable.push(req);
        continue;
      }

      let balance: bigint;
      try {
        balance = await signer.checkBalance(req.asset, req.network);
      } catch {
        // Signer cannot query this network; keep the requirement.
        affordable.push(req);
        continue;
      }

      let needed = BigInt(req.amount);
      if (req.extra?.fee?.feeAmount) {
        needed += BigInt(req.extra.fee.feeAmount);
      }
      if (balance >= needed) {
        affordable.push(req);
      }
    }
    return affordable;
  }
}
