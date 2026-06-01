'use strict'

import { jest, describe, expect, test } from '@jest/globals'

// The signers import native Bare modules (`bare-buffer`) and the keychain
// package (`@idyllicvision/bare-universal-signer`) at load time; neither loads
// under Node. Map them to Node-compatible stand-ins — the tests inject their own
// real-crypto mock bare signer via `config.bareSigner`.
jest.unstable_mockModule('bare-buffer', () => ({ Buffer: globalThis.Buffer }))
jest.unstable_mockModule('@idyllicvision/bare-universal-signer', () => ({
  Signer: class { dispose () {} }
}))

const { default: BareSolanaSigner } = await import('../src/signers/bare-solana-signer.js')
const { getPublicKeyFromAddress } = await import('@solana/addresses')
const { verifySignature, signatureBytes } = await import('@solana/keys')
const {
  createMockBareSigner,
  buildTwoSignerTransferTransaction,
  encodeTx,
  decodeTx
} = await import('./helpers/mock-ed25519-bare-signer.js')

const newSigner = async (config = {}) =>
  new BareSolanaSigner({ bareSigner: await createMockBareSigner(), ...config })

describe('BareSolanaSigner', () => {
  test('constructor rejects a non-hardened SLIP-10 path', async () => {
    const bareSigner = await createMockBareSigner()
    expect(() => new BareSolanaSigner({ bareSigner, path: "m/44'/501'/0'/0" }))
      .toThrow('all components must be hardened')
  })

  test('isRoot is true for the BIP-44 prefix and false for a full path', async () => {
    expect((await newSigner({ path: "m/44'/501'" })).isRoot).toBe(true)
    expect((await newSigner({ path: "m/44'/501'/0'/0'" })).isRoot).toBe(false)
  })

  test('derive enforces hardened components, composes the full path, and yields a leaf', async () => {
    const root = await newSigner({ path: "m/44'/501'" })
    expect(() => root.derive('0/0')).toThrow('all components must be hardened')

    const child = root.derive("3'/0'")
    expect(child.path).toBe("m/44'/501'/3'/0'")
    expect(child.index).toBe(3)
    expect(child.isRoot).toBe(false)
  })

  test('getPublicKey caches the keychain lookup', async () => {
    const bareSigner = await createMockBareSigner()
    const signer = new BareSolanaSigner({ bareSigner })
    await signer.getPublicKey()
    await signer.getPublicKey()
    expect(bareSigner.calls.getPublicKey).toBe(1) // one keychain hit, not per call
  })

  test('getAddress derives the base58 address, stripping a 33-byte SLIP-10 prefix', async () => {
    // micro-key-producer returns a 33-byte (0x00-prefixed) key; getAddress must
    // strip it to 32 bytes before importKey, yielding the same address.
    const bareSigner = await createMockBareSigner({ prefix33: true })
    const signer = new BareSolanaSigner({ bareSigner })

    expect((await bareSigner.getPublicKey()).length).toBe(33)
    expect(await signer.getAddress()).toBe(bareSigner.address)
  })

  test('sign produces a 64-byte ed25519 signature that verifies for the address', async () => {
    const signer = await newSigner()
    const message = 'gm solana'

    const hex = await signer.sign(message)
    expect(hex).toMatch(/^[0-9a-f]{128}$/) // 64-byte signature, hex-encoded

    expect(await signer.verify(message, hex)).toBe(true)
    expect(await signer.verify('tampered', hex)).toBe(false)
  })

  test('signTransaction signs its own slot and preserves an existing co-signer signature', async () => {
    const bareSigner = await createMockBareSigner()
    const signer = new BareSolanaSigner({ bareSigner })
    const feePayer = await signer.getAddress()

    const coSigner = (await createMockBareSigner()).address
    const compiled = buildTwoSignerTransferTransaction({ feePayer, coSigner })

    // Pre-fill the co-signer's slot with a distinctive signature.
    const coSig = signatureBytes(new Uint8Array(64).fill(9))
    const unsigned = encodeTx({ messageBytes: compiled.messageBytes, signatures: { ...compiled.signatures, [coSigner]: coSig } })

    const signed = decodeTx(await signer.signTransaction(unsigned))

    // Co-signer slot untouched...
    expect(Buffer.from(signed.signatures[coSigner]).equals(Buffer.from(coSig))).toBe(true)
    // ...and our slot now holds a signature that verifies over the message bytes.
    const pubkey = await getPublicKeyFromAddress(feePayer)
    expect(await verifySignature(pubkey, signed.signatures[feePayer], signed.messageBytes)).toBe(true)
  })

  test('dispose deactivates the signer; subsequent operations throw', async () => {
    const signer = await newSigner()
    await signer.getAddress()
    signer.dispose()

    expect(signer.isActive).toBe(false)
    expect(signer.keyPair.publicKey).toBeUndefined()
    await expect(signer.getPublicKey()).rejects.toThrow('disposed')
    await expect(signer.sign('x')).rejects.toThrow('disposed')
  })
})
