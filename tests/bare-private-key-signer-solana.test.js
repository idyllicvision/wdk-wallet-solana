'use strict'

import { jest, describe, expect, test } from '@jest/globals'

jest.unstable_mockModule('bare-buffer', () => ({ Buffer: globalThis.Buffer }))
jest.unstable_mockModule('@idyllicvision/bare-universal-signer', () => ({
  Signer: class { dispose () {} }
}))

const { default: BarePrivateKeySolanaSigner } = await import('../src/signers/bare-private-key-signer-solana.js')
const { getPublicKeyFromAddress } = await import('@solana/addresses')
const { verifySignature, signatureBytes } = await import('@solana/keys')
const {
  createMockBareSigner,
  buildTwoSignerTransferTransaction,
  encodeTx,
  decodeTx
} = await import('./helpers/mock-ed25519-bare-signer.js')

const newSigner = async (config = {}) =>
  new BarePrivateKeySolanaSigner({ bareSigner: await createMockBareSigner(), ...config })

describe('BarePrivateKeySolanaSigner', () => {
  test('is a non-HD private-key signer that cannot derive', async () => {
    const signer = await newSigner()
    expect(signer.isPrivateKey).toBe(true)
    expect(signer.isRoot).toBe(false)
    expect(signer.index).toBe(0)
    expect(signer.path).toBeUndefined()
    expect(() => signer.derive()).toThrow('derivation is not supported')
  })

  test('getAddress derives the base58 address and caches the keychain lookup', async () => {
    const bareSigner = await createMockBareSigner()
    const signer = new BarePrivateKeySolanaSigner({ bareSigner })
    expect(await signer.getAddress()).toBe(bareSigner.address)
    await signer.getAddress()
    expect(bareSigner.calls.getPublicKey).toBe(1)
  })

  test('sign produces a 64-byte ed25519 signature that verifies for the address', async () => {
    const signer = await newSigner()
    const hex = await signer.sign('gm')
    expect(hex).toMatch(/^[0-9a-f]{128}$/)
    expect(await signer.verify('gm', hex)).toBe(true)
    expect(await signer.verify('not gm', hex)).toBe(false)
  })

  test('signTransaction signs its own slot and preserves an existing co-signer signature', async () => {
    const bareSigner = await createMockBareSigner()
    const signer = new BarePrivateKeySolanaSigner({ bareSigner })
    const feePayer = await signer.getAddress()

    const coSigner = (await createMockBareSigner()).address
    const compiled = buildTwoSignerTransferTransaction({ feePayer, coSigner })
    const coSig = signatureBytes(new Uint8Array(64).fill(9))
    const unsigned = encodeTx({ messageBytes: compiled.messageBytes, signatures: { ...compiled.signatures, [coSigner]: coSig } })

    const signed = decodeTx(await signer.signTransaction(unsigned))

    expect(Buffer.from(signed.signatures[coSigner]).equals(Buffer.from(coSig))).toBe(true)
    const pubkey = await getPublicKeyFromAddress(feePayer)
    expect(await verifySignature(pubkey, signed.signatures[feePayer], signed.messageBytes)).toBe(true)
  })

  test('dispose deactivates the signer and clears cached key material', async () => {
    const signer = await newSigner()
    await signer.getAddress()
    signer.dispose()
    expect(signer.isActive).toBe(false)
    expect(signer.keyPair.publicKey).toBeUndefined()
  })
})
