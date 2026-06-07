/**
 * PTB submission.
 *
 * Signs a constructed `Transaction` with the operator's keypair and
 * submits it to the configured RPC endpoint. Returns a structured
 * result so the bot loop can log success/revert/error distinctly.
 *
 * The submission path is intentionally separate from the builder so it
 * can be unit-tested with a fake SuiClient without standing up a real
 * RPC connection.
 */

import type { Transaction } from '@mysten/sui/transactions';
import type { SuiClient } from '@mysten/sui/client';

export type SubmitStatus = 'success' | 'revert' | 'error';

export interface SubmitResult {
  status: SubmitStatus;
  digest?: string;
  gasUsed?: bigint;
  error?: string;
}

export interface SubmitArgs {
  tx: Transaction;
  client: SuiClient;
  signer: Signer;
}

export interface Signer {
  /** Sign transaction bytes. The signer decides how to serialize. */
  signTransaction: (bytes: Uint8Array) => Promise<{ signature: string }>;
  getAddress: () => string;
}

export async function submitPtb({ tx, client, signer }: SubmitArgs): Promise<SubmitResult> {
  try {
    const bytes = await tx.build({ client });
    const { signature } = await signer.signTransaction(bytes);
    const result = await client.executeTransactionBlock({
      transactionBlock: bytes,
      signature,
      options: { showEffects: true, showEvents: false },
    });

    if (result.effects?.status?.status === 'success') {
      return {
        status: 'success',
        digest: result.digest,
        gasUsed:
          BigInt(result.effects.gasUsed?.computationCost ?? '0') +
          BigInt(result.effects.gasUsed?.storageCost ?? '0') +
          BigInt(result.effects.gasUsed?.storageRebate ?? '0'),
      };
    }
    return {
      status: 'revert',
      digest: result.digest,
      error: result.effects?.status?.error ?? 'unknown revert',
    };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}
