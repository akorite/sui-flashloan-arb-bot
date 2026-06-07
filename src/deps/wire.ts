/**
 * Production dependency wiring.
 *
 * Builds the live SuiClient, loads the operator keypair from the
 * config's `privateKey` field, and returns them along with a
 * helper that the loop can use to poll DEX state.
 *
 * The `privateKey` field accepts either:
 *   - a `suiprivkey1...` bech32 string (the Sui CLI export format)
 *   - a base64 ed25519 32-byte secret key
 *   - the string `env:VAR_NAME` to read from process.env
 *
 * In test runs and unit tests, this module is bypassed — the
 * runTick() function takes injected deps directly.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromB64 } from '@mysten/sui/utils';
import type { Config } from '../config.js';
import type { Signer } from '../ptb/submit.js';

export interface WireResult {
  client: SuiClient;
  signer: Signer;
}

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

export function buildClient(rpcUrl: string): SuiClient {
  if (!rpcUrl) {
    throw new WireError('rpcUrl is empty; cannot build SuiClient');
  }
  if (rpcUrl === 'testnet' || rpcUrl === 'mainnet' || rpcUrl === 'devnet' || rpcUrl === 'localnet') {
    return new SuiClient({ url: getFullnodeUrl(rpcUrl) });
  }
  return new SuiClient({ url: rpcUrl });
}

export function buildSigner(privateKey: string): Signer {
  const secret = resolveSecret(privateKey);
  const kp = decodeKeypair(secret);
  return keypairToSigner(kp);
}

function resolveSecret(input: string): string {
  if (!input) {
    throw new WireError('privateKey is empty');
  }
  if (input.startsWith('env:')) {
    const varName = input.slice(4);
    const fromEnv = process.env[varName];
    if (!fromEnv) {
      throw new WireError(`privateKey 'env:${varName}' not found in process.env`);
    }
    return fromEnv;
  }
  return input;
}

function decodeKeypair(secret: string): Ed25519Keypair {
  // Bech32 Sui private key (e.g. suiprivkey1...) — official Sui CLI format.
  if (secret.startsWith('suiprivkey1')) {
    return Ed25519Keypair.fromSecretKey(secret);
  }
  // Try base64. Could be either the 32-byte raw secret OR a base64
  // encoding of the bech32 string itself (which is what
  // Ed25519Keypair.getSecretKey() returns and what some pipelines
  // serialize through).
  try {
    const bytes = fromB64(secret);
    // Case 1: bech32 encoded as base64 (length 70 ascii → ~94 bytes)
    const decoded = new TextDecoder().decode(bytes);
    if (decoded.startsWith('suiprivkey1')) {
      return Ed25519Keypair.fromSecretKey(decoded);
    }
    // Case 2: raw 32-byte secret
    return Ed25519Keypair.fromSecretKey(bytes);
  } catch {
    throw new WireError(
      'privateKey is neither a suiprivkey1... bech32 string, a base64 encoding of one, ' +
        'nor a 32-byte raw secret. Run `sui keytool export <address>` to get the bech32 form, ' +
        'or set env:VAR_NAME to a valid bech32 / base64 secret.'
    );
  }
}

function keypairToSigner(kp: Ed25519Keypair): Signer {
  return {
    async signTransaction(bytes: Uint8Array) {
      const { signature } = await kp.signTransaction(bytes);
      return { signature };
    },
    getAddress() {
      return kp.getPublicKey().toSuiAddress();
    },
  };
}

export function wireProduction(config: Config): WireResult {
  return {
    client: buildClient(config.rpcUrl),
    signer: buildSigner(config.privateKey),
  };
}
