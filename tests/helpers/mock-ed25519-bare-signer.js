'use strict'

import { pipe } from '@solana/functional'
import { getAddressFromPublicKey } from '@solana/addresses'
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction
} from '@solana/transaction-messages'
import {
  compileTransaction,
  getTransactionEncoder,
  getTransactionDecoder
} from '@solana/transactions'
import { getTransferSolInstruction } from '@solana-program/system'

/**
 * Builds a mock `@idyllicvision/bare-universal-signer` backed by a REAL ed25519
 * key (Node WebCrypto), so signatures and addresses the signer-under-test
 * produces actually verify. Injected via the signer `config.bareSigner`.
 *
 * Shape matches what the Solana signers call:
 *   - `getPublicKey({ path?, curve, opts? })` → raw ed25519 public key bytes
 *   - `sign({ path?, curve, data })` → 64-byte ed25519 signature
 *
 * @param {object} [o]
 * @param {boolean} [o.prefix33] - return the public key as 33 bytes (0x00 + point),
 *   emulating micro-key-producer's SLIP-10 output, to exercise the prefix strip.
 */
export async function createMockBareSigner ({ prefix33 = false } = {}) {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  const cryptoKey = await crypto.subtle.importKey('raw', raw, 'Ed25519', true, ['verify'])
  const address = await getAddressFromPublicKey(cryptoKey)
  const pub = prefix33 ? new Uint8Array([0, ...raw]) : raw

  return {
    address,
    rawPublicKey: raw,
    calls: { sign: 0, getPublicKey: 0 },
    async getPublicKey () {
      this.calls.getPublicKey++
      return pub
    },
    async sign ({ data }) {
      this.calls.sign++
      return new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, data))
    }
  }
}

const BLOCKHASH = {
  blockhash: '11111111111111111111111111111111',
  lastValidBlockHeight: 1n
}

/**
 * Compiles a real V0 transfer transaction that requires TWO signers: `feePayer`
 * (the signer under test) and `coSigner` (the transfer source). Used to verify
 * `signTransaction` fills its own slot while preserving a co-signer's signature.
 *
 * @param {object} o
 * @param {import('@solana/addresses').Address} o.feePayer
 * @param {import('@solana/addresses').Address} o.coSigner
 * @returns {{ messageBytes: Uint8Array, signatures: object }} compiled transaction
 */
export function buildTwoSignerTransferTransaction ({ feePayer, coSigner }) {
  // A minimal TransactionSigner marks `source` as a required signer in the
  // compiled message (a plain address would not).
  const source = { address: coSigner, signTransactions: async () => [] }
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
    (m) => appendTransactionMessageInstruction(
      getTransferSolInstruction({ source, destination: feePayer, amount: 1n }),
      m
    )
  )
  return compileTransaction(message)
}

export const encodeTx = (tx) => new Uint8Array(getTransactionEncoder().encode(tx))
export const decodeTx = (bytes) => getTransactionDecoder().decode(new Uint8Array(bytes))
