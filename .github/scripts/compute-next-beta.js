// Copyright 2024 Tether Operations Limited
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Compute the next `${base}-beta.N` version to publish to GitHub Packages.
//
// Invoked from the publish workflow. The exported function is pure so it
// can be unit-tested; the CLI entry wraps it with disk and `npm view` I/O.
//
// Algorithm (see plan docs/plans/20260419-github-packages-beta-publish.md):
//   1. Derive `base` (major.minor.patch) and optional local beta suffix
//      from `currentVersion`.
//   2. Filter `registryVersions` to `^${base}-beta\.(\d+)$`, take the max.
//   3. Seed N = max(registryMax, localSuffix) and return
//      `${base}-beta.${N + 1}`. Seeding from the local suffix prevents
//      going backwards when the registry is empty but the committed
//      version already has a beta counter.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import semver from 'semver'

export function nextBetaVersion ({ currentVersion, registryVersions }) {
  const parsed = semver.parse(currentVersion)
  if (!parsed) {
    throw new Error(`invalid currentVersion: ${currentVersion}`)
  }

  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  const localSuffix = extractBetaSuffix(parsed.prerelease)
  const registryMax = maxBetaSuffix(base, registryVersions)
  const next = Math.max(registryMax, localSuffix) + 1

  return `${base}-beta.${next}`
}

function extractBetaSuffix (prerelease) {
  if (!Array.isArray(prerelease) || prerelease.length !== 2) return -1
  const [label, n] = prerelease
  if (label !== 'beta') return -1
  // semver.parse yields numeric prerelease components as numbers.
  return Number.isInteger(n) && n >= 0 ? n : -1
}

function maxBetaSuffix (base, registryVersions) {
  const list = normalizeVersions(registryVersions)
  const re = new RegExp(`^${escapeRegExp(base)}-beta\\.(\\d+)$`)
  let max = -1
  for (const v of list) {
    const m = re.exec(v)
    if (!m) continue
    const n = Number.parseInt(m[1], 10)
    if (Number.isInteger(n) && n > max) max = n
  }
  return max
}

// `npm view ... versions --json` may emit `[]`, a JSON array, or a bare
// string (for a 1-version package). Normalize to array; null/undefined
// and non-string entries are dropped.
export function normalizeVersions (input) {
  if (input == null) return []
  if (typeof input === 'string') return [input]
  if (Array.isArray(input)) return input.filter((v) => typeof v === 'string')
  return []
}

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Pure helper for testing: turn a completed `npm view` invocation (or the
// error thrown by it) into the versions array. E404 means "package not
// published yet" — treat as empty list. All other failures re-throw.
export function parseNpmViewResult ({ stdout, stderr, err } = {}) {
  if (err) {
    const combined = `${err.stdout || ''}${err.stderr || ''}`
    if (combined.includes('E404')) return []
    throw err
  }
  const trimmed = (stdout || '').trim()
  if (!trimmed) return []
  return normalizeVersions(JSON.parse(trimmed))
}

export function fetchRegistryVersions ({ packageName, registry }) {
  try {
    const stdout = execFileSync(
      'npm',
      ['view', packageName, 'versions', '--json', `--registry=${registry}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    return parseNpmViewResult({ stdout })
  } catch (err) {
    return parseNpmViewResult({ err })
  }
}

export function parseArgs (argv) {
  const flags = {
    '--package-name': 'packageName',
    '--registry': 'registry'
  }
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const key = flags[arg]
    if (!key) {
      throw new Error(`unknown argument: ${arg}`)
    }
    const value = argv[i + 1]
    // Reject values that look like another flag. Intentional: package
    // names and URLs never start with `--`, so this catches a missing-
    // value mistake more loudly than silently consuming the next flag.
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for ${arg}`)
    }
    out[key] = value
    i += 1
  }
  for (const required of ['packageName', 'registry']) {
    if (!out[required]) {
      throw new Error(`missing required flag for: ${required}`)
    }
  }
  return out
}

function readCurrentVersion () {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgPath = resolve(here, '..', '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return pkg.version
}

async function main () {
  const { packageName, registry } = parseArgs(process.argv.slice(2))
  const currentVersion = readCurrentVersion()
  const registryVersions = fetchRegistryVersions({ packageName, registry })
  const next = nextBetaVersion({ currentVersion, registryVersions })
  process.stdout.write(`${next}\n`)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message || err}\n`)
    process.exit(1)
  })
}
