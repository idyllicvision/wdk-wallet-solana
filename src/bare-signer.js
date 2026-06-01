'use strict'

import { Signer } from '@idyllicvision/bare-universal-signer'

let signer = null

/**
 * Get the default bare-signer instance.
 * Creates a singleton Signer with 30s auto-lock.
 * @param {Object} [opts={}] - Keychain options to use if creating new instance
 * @returns {Signer}
 */
export function getDefaultBareSigner (opts = {}) {
  if (!signer) {
    signer = new Signer({ autoLockMs: 30000, opts })
  }
  return signer
}

export * from '@idyllicvision/bare-universal-signer'
