'use strict'

import { Buffer } from 'bare-buffer'
import { getAddressFromPublicKey, getPublicKeyFromAddress } from '@solana/addresses'
import { verifySignature, signatureBytes } from '@solana/keys'
import { getTransactionDecoder, getTransactionEncoder } from '@solana/transactions'

import { Signer } from '@idyllicvision/bare-universal-signer'

/**
 * @typedef {Object} PrivateKeySignerSolanaConfig
 * @property {import('@idyllicvision/bare-universal-signer').Signer} [bareSigner] - Pre-constructed Signer instance
 * @property {Object} [keychainOpts={}] - Keychain options forwarded to new Signer if bareSigner omitted
 */

/**
 * Solana signer backed by a raw private key stored in the iOS Keychain.
 * Compatible with ISignerSolana (wdk-wallet-solana). No HD derivation supported.
 */
export default class BarePrivateKeySolanaSigner {
  /**
   * @param {PrivateKeySignerSolanaConfig} [config={}]
   */
  constructor (config = {}) {
    this._bareSigner = config.bareSigner ||
      new Signer({ secretType: 'privateKey', autoLockMs: 30000, opts: config.keychainOpts || {} })
    this._isActive = true
    this._config = {}
    this._address = undefined
    this._publicKey = undefined
  }

  get isPrivateKey () { return true }
  get isActive () { return this._isActive }
  get isRoot () { return false }
  get index () { return 0 }
  get path () { return undefined }
  get config () { return this._config }

  /**
   * Key pair. Private key is never exposed (stays in the iOS Keychain).
   * @returns {{ privateKey: undefined, publicKey: Uint8Array|undefined }}
   */
  get keyPair () {
    return { privateKey: undefined, publicKey: this._publicKey }
  }

  /** @throws {Error} Always */
  derive () {
    throw new Error('PrivateKeySolanaSigner: derivation is not supported for private-key signers.')
  }

  /**
   * Get the raw 32-byte ed25519 public key.
   * @returns {Promise<Uint8Array>}
   */
  async getPublicKey () {
    if (this._publicKey) return this._publicKey
    this._publicKey = await this._bareSigner.getPublicKey({ curve: 'ed25519' })
    return this._publicKey
  }

  /**
   * Get the Solana address (base58-encoded 32-byte public key).
   * @returns {Promise<import('@solana/addresses').Address>}
   */
  async getAddress () {
    if (this._address) return this._address
    const pubkey = await this.getPublicKey()
    // Strip the 0x00 prefix if present (SLIP-10 style 33-byte key)
    const rawKey = pubkey.length === 33 ? pubkey.slice(1) : pubkey
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey, 'Ed25519', true, ['verify'])
    this._address = await getAddressFromPublicKey(cryptoKey)
    return this._address
  }

  /**
   * Sign a UTF-8 message with ed25519.
   * @param {string} message
   * @returns {Promise<string>} 128-character hex-encoded 64-byte signature
   */
  async sign (message) {
    const messageBytes = Buffer.from(message, 'utf8')
    const sigBytes = await this._bareSigner.sign({ curve: 'ed25519', data: messageBytes })
    return Buffer.from(sigBytes).toString('hex')
  }

  /**
   * Verify an ed25519 message signature.
   * @param {string} message
   * @param {string} signature - Hex-encoded 64-byte signature
   * @returns {Promise<boolean>}
   */
  async verify (message, signature) {
    const messageBytes = new Uint8Array(Buffer.from(message, 'utf8'))
    const sigBytes = new Uint8Array(Buffer.from(signature, 'hex'))
    const addr = await this.getAddress()
    const pubkey = await getPublicKeyFromAddress(addr)
    return verifySignature(pubkey, sigBytes, messageBytes)
  }

  /**
   * Sign a compiled Solana transaction (wire format).
   * @param {Uint8Array} unsignedTx - Wire-format transaction bytes
   * @returns {Promise<Buffer>} Signed transaction in wire format
   */
  async signTransaction (unsignedTx) {
    const tx = getTransactionDecoder().decode(Buffer.from(unsignedTx))

    const sigBytes = await this._bareSigner.sign({
      curve: 'ed25519',
      data: tx.messageBytes
    })

    const addr = await this.getAddress()

    // Merge this signer's signature into the existing signatures map, preserving
    // any pre-existing signatures (e.g. multisig co-signers, separate fee payer).
    const signedTx = getTransactionEncoder().encode({
      messageBytes: tx.messageBytes,
      signatures: {
        ...tx.signatures,
        [addr]: signatureBytes(new Uint8Array(sigBytes))
      }
    })

    return Buffer.from(signedTx)
  }

  /** Mark this signer as inactive and clear cached key material. */
  dispose () {
    this._isActive = false
    this._address = undefined
    this._publicKey = undefined
  }
}
