import { agroLedgerAbi } from "@agro-cpr/spec";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { AnchorReceipt, ChainAdapter } from "./ledger.js";

export interface ViemChainConfig {
  rpcUrl: string;
  privateKey: Hex;
  address: Hex;
}

/**
 * AgroLedger on Base Sepolia. Sends one transaction at a time and waits for its
 * receipt, so the relayer never races on nonces (the worker runs one job at a time).
 */
export function createViemChain(config: ViemChainConfig): ChainAdapter {
  const transport = http(config.rpcUrl);
  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  const contract = { address: config.address, abi: agroLedgerAbi } as const;

  async function confirm(hash: Hex): Promise<AnchorReceipt> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
    return { txHash: hash, blockNumber: receipt.blockNumber };
  }

  return {
    chainId: baseSepolia.id,
    async issueCpr(cpr, event) {
      await publicClient.simulateContract({ ...contract, account, functionName: "issueCpr", args: [cpr, event] });
      return confirm(await walletClient.writeContract({ ...contract, functionName: "issueCpr", args: [cpr, event] }));
    },
    async settleCpr(tokenId, event) {
      await publicClient.simulateContract({ ...contract, account, functionName: "settleCpr", args: [tokenId, event] });
      return confirm(await walletClient.writeContract({ ...contract, functionName: "settleCpr", args: [tokenId, event] }));
    },
    async recordEvent(event) {
      await publicClient.simulateContract({ ...contract, account, functionName: "recordEvent", args: [event] });
      return confirm(await walletClient.writeContract({ ...contract, functionName: "recordEvent", args: [event] }));
    },
    async isRecorded(eventId) {
      return publicClient.readContract({ ...contract, functionName: "isRecorded", args: [eventId] });
    },
    async headOf(subjectKey) {
      const [seq, head] = await publicClient.readContract({ ...contract, functionName: "headOf", args: [subjectKey] });
      return { seq, head };
    },
  };
}
