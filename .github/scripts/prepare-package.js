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

// Rewrite `package.json` for the GitHub Packages publish step.
//
// The exported `rewritePackageJson` is pure (no disk I/O), so it can be
// unit-tested without filesystem fixtures. The CLI entry wraps it with a
// read/write of `./package.json` from the process cwd.
//
// Overridden fields (see plan docs/plans/20260419-github-packages-beta-publish.md):
//   - `name`                         → the `@idyllicvision` scoped name
//   - `version`                      → computed next beta
//   - `publishConfig.registry`       → https://npm.pkg.github.com
//   - `publishConfig.access`         → `public` (required by GitHub Packages
//                                      for scoped packages to be consumable
//                                      without per-consumer auth tweaks)
//   - `repository.url`               → git+https URL of the publishing repo;
//                                      GitHub Packages rejects the publish
//                                      if the owner here does not match the
//                                      repo running the workflow
//
// `repository.type` (if present) is preserved; all other fields pass through
// untouched.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function rewritePackageJson (pkg, { name, version, registry, repositoryUrl }) {
  if (!pkg || typeof pkg !== 'object') {
    throw new Error('pkg must be an object')
  }

  const existingRepo = pkg.repository
  const existingPublishConfig =
    pkg.publishConfig && typeof pkg.publishConfig === 'object'
      ? pkg.publishConfig
      : {}

  return {
    ...pkg,
    name,
    version,
    repository: {
      ...existingRepo,
      url: repositoryUrl
    },
    publishConfig: {
      ...existingPublishConfig,
      registry,
      access: 'public'
    }
  }
}

export function parseArgs (argv) {
  const flags = {
    '--name': 'name',
    '--version': 'version',
    '--registry': 'registry',
    '--repository-url': 'repositoryUrl'
  }
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const key = flags[arg]
    if (!key) {
      throw new Error(`unknown argument: ${arg}`)
    }
    const value = argv[i + 1]
    // Reject values that look like another flag. Intentional: semver
    // versions, package names, URLs, etc. never start with `--`, so this
    // catches a missing-value mistake more loudly than silently consuming
    // the next flag name as the current flag's value.
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for ${arg}`)
    }
    out[key] = value
    i += 1
  }
  for (const required of ['name', 'version', 'registry', 'repositoryUrl']) {
    if (!out[required]) {
      throw new Error(`missing required flag for: ${required}`)
    }
  }
  return out
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const pkgPath = resolve(process.cwd(), 'package.json')
  const original = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const rewritten = rewritePackageJson(original, opts)
  // Trailing newline matches the convention most package managers write.
  writeFileSync(pkgPath, `${JSON.stringify(rewritten, null, 2)}\n`)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message || err}\n`)
    process.exit(1)
  })
}
