'use strict'

import { Buffer } from 'bare-buffer'
import { getAddressFromPublicKey, getPublicKeyFromAddress } from '@solana/addresses'
import { verifySignature, signatureBytes } from '@solana/keys'
import { getTransactionDecoder, getTransactionEncoder } from '@solana/transactions'

import { getDefaultBareSigner } from '../bare-signer.js'

const BIP44_SOL_PREFIX = "m/44'/501'"
const DEFAULT_PATH = "m/44'/501'/0'/0'"

/**
 * @typedef {Object} SolanaSignerConfig
 * @property {import('@idyllicvision/bare-universal-signer').Signer} [bareSigner] - Signer instance
 * @property {string} [path="m/44'/501'/0'/0'"] - Full SLIP-10 derivation path (all hardened)
 * @property {Object} [keychainOpts={}] - Keychain options
 */

/**
 * Solana signer backed by bare-signer (iOS Keychain secure storage).
 * Implements the ISignerSolana interface from @tetherto/wdk-wallet-solana.
 *
 * Private keys never leave the keychain — only signatures and public keys
 * are returned.
 */
export default class BareSolanaSigner {
  /**
   * Create a new Solana signer.
   * @param {SolanaSignerConfig} [config={}]
   */
  constructor (config = {}) {
    if (config.path && !/^m(\/\d+')+$/.test(config.path)) {
      throw new Error(
        "Invalid Solana path: all components must be hardened (e.g. m/44'/501'/0'/0')"
      )
    }

    this._bareSigner = config.bareSigner || getDefaultBareSigner()
    this._path = config.path || DEFAULT_PATH
    this._opts = config.keychainOpts || {}
    this._isActive = true
    this._config = {}
    this._address = undefined
    this._publicKey = undefined

    // isRoot when the path is only the BIP-44 prefix (no account/change components).
    // A root signer is passed to WalletManagerSolana; it derives leaf signers internally.
    const depth = this._path.split('/').length - 1 // number of components after 'm'
    this._isRoot = depth <= 2 // "m/44'/501'" has depth 2
  }

  /** @returns {boolean} */
  get isActive () { return this._isActive }

  /** @returns {boolean} */
  get isRoot () { return this._isRoot }

  /**
   * Account index — the 4th path component (after m/44'/501').
   * @returns {number|undefined}
   */
  get index () {
    if (!this._path) return undefined
    return +this._path.replace(/'/g, '').split('/').at(3)
  }

  /** @returns {string} */
  get path () { return this._path }

  /** @returns {object} */
  get config () { return this._config }

  /**
   * Key pair. Private key is never exposed (stays in the iOS Keychain).
   * @returns {{ privateKey: undefined, publicKey: Uint8Array|undefined }}
   */
  get keyPair () {
    return { privateKey: undefined, publicKey: this._publicKey }
  }

  /**
   * Throws if the signer has been disposed.
   * @private
   */
  _assertActive () {
    if (!this._isActive) {
      throw new Error('The signer has been disposed.')
    }
  }

  /**
   * Get the raw 32-byte ed25519 public key.
   * @returns {Promise<Uint8Array>}
   */
  async getPublicKey () {
    this._assertActive()
    if (this._publicKey) return this._publicKey
    this._publicKey = await this._bareSigner.getPublicKey({
      path: this._path,
      curve: 'ed25519',
      opts: this._opts
    })
    return this._publicKey
  }

  /**
   * Get the Solana address (base58-encoded 32-byte public key).
   * Uses WebCrypto + @solana/addresses for standard address derivation.
   * @returns {Promise<import('@solana/addresses').Address>}
   */
  async getAddress () {
    if (this._address) return this._address
    const pubkey = await this.getPublicKey()
    // micro-key-producer SLIP-10 publicKey is 33 bytes (0x00 prefix + 32-byte point).
    // bare-crypto's importKey('raw') requires exactly 32 bytes, so strip the prefix.
    const rawKey = pubkey.length === 33 ? pubkey.slice(1) : pubkey
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey, 'Ed25519', true, ['verify'])
    this._address = await getAddressFromPublicKey(cryptoKey)
    return this._address
  }

  /**
   * Derive a child signer from this signer.
   *
   * All Solana derivation path components must be hardened (SLIP-10).
   *
   * @param {string} relPath - Relative path, e.g. "0'/0'" for account 0
   * @param {object} [cfg={}] - Optional keychain option overrides
   * @returns {BareSolanaSigner}
   */
  derive (relPath, cfg = {}) {
    if (!relPath || typeof relPath !== 'string') {
      throw new Error('Invalid relative path: must be a non-empty string')
    }
    if (!/^(\d+'\/?)*\d+'$/.test(relPath)) {
      throw new Error("Invalid Solana path: all components must be hardened (e.g. \"0'/0'\")")
    }

    const fullPath = `${BIP44_SOL_PREFIX}/${relPath}`
    const mergedOpts = Object.assign({}, this._opts, cfg)

    const child = new BareSolanaSigner({
      bareSigner: this._bareSigner,
      path: fullPath,
      keychainOpts: mergedOpts
    })
    // A derived signer is always a leaf (not root)
    child._isRoot = false
    return child
  }

  /**
   * Sign a UTF-8 message with ed25519.
   * @param {string} message
   * @returns {Promise<string>} 128-character hex-encoded 64-byte signature
   */
  async sign (message) {
    this._assertActive()
    const messageBytes = Buffer.from(message, 'utf8')
    const sigBytes = await this._bareSigner.sign({
      path: this._path,
      curve: 'ed25519',
      data: messageBytes,
      opts: this._opts
    })
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
   *
   * Decodes the wire-format transaction using @solana/transactions, signs the
   * message bytes with ed25519 via the keychain, and reconstructs a fully
   * encoded signed transaction.
   *
   * Supports both legacy and versioned (V0) transaction formats.
   *
   * @param {Uint8Array} unsignedTx - Wire-format transaction bytes
   * @returns {Promise<Buffer>} Signed transaction in wire format
   */
  async signTransaction (unsignedTx) {
    this._assertActive()
    const tx = getTransactionDecoder().decode(Buffer.from(unsignedTx))

    // Sign the message bytes with ed25519 (key stays in the iOS Keychain)
    const sigBytes = await this._bareSigner.sign({
      path: this._path,
      curve: 'ed25519',
      data: tx.messageBytes,
      opts: this._opts
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

  /**
   * Mark this signer as inactive and clear cached key material.
   */
  dispose () {
    this._isActive = false
    this._address = undefined
    this._publicKey = undefined
  }
}

export { BareSolanaSigner as SolanaSigner }
