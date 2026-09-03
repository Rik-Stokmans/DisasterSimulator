#!/usr/bin/env node

import { access, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outputDirectory = resolve(here, '../apps/web/dist')
const maximumReleaseBytes = 205_000_000

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

const files = await collectFiles(outputDirectory)
const sizes = await Promise.all(files.map(async (path) => (await stat(path)).size))
const releaseBytes = sizes.reduce((sum, size) => sum + size, 0)
if (releaseBytes > maximumReleaseBytes) {
  throw new Error(
    `Runtime release is ${releaseBytes.toLocaleString('en')} bytes; budget is ${maximumReleaseBytes.toLocaleString('en')}.`,
  )
}

const auditOnlyStops = resolve(
  outputDirectory,
  'data/transit/transit-stops.geojson',
)
try {
  await access(auditOnlyStops)
  throw new Error('Audit-only transit-stops.geojson leaked into the runtime release.')
} catch (error) {
  if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
}

for (const group of [
  { directory: 'regions', compressedPattern: /^GM\d{4}\.json\.gz$/, rawPattern: /^GM\d{4}\.json$/ },
  { directory: 'settlements', compressedPattern: /^GM\d{4}\.geojson\.gz$/, rawPattern: /^GM\d{4}\.geojson$/ },
]) {
  const names = await readdir(resolve(outputDirectory, 'data', group.directory))
  const compressed = names.filter((name) => group.compressedPattern.test(name))
  const raw = names.filter((name) => group.rawPattern.test(name))
  if (compressed.length !== 342 || raw.length !== 0) {
    throw new Error(
      `Runtime ${group.directory} must contain 342 gzip bundles and no duplicate raw bundles; found ${compressed.length} gzip and ${raw.length} raw.`,
    )
  }
}

const requestedBasePath = process.env.WARROOM_BASE_PATH?.replace(/\/+$/, '')
if (requestedBasePath) {
  const index = await readFile(resolve(outputDirectory, 'index.html'), 'utf8')
  if (!index.includes(`${requestedBasePath}/assets/`)) {
    throw new Error(`Built index does not contain the requested base path ${requestedBasePath}.`)
  }
}

console.log(JSON.stringify({ files: files.length, releaseBytes, maximumReleaseBytes, status: 'valid' }, null, 2))
