#!/usr/bin/env node

import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')
const groups = [
  {
    directory: resolve(dataDirectory, 'regions'),
    pattern: /^GM\d{4}\.json$/,
    label: 'municipality region bundles',
  },
  {
    directory: resolve(dataDirectory, 'settlements'),
    pattern: /^GM\d{4}\.geojson$/,
    label: 'municipality settlement bundles',
  },
]

async function replaceIfChanged(path, bytes) {
  try {
    const current = await readFile(path)
    if (current.equals(bytes)) return false
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, bytes)
  try {
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    })
  }
  return true
}

const summary = []
for (const group of groups) {
  const files = (await readdir(group.directory)).filter((file) => group.pattern.test(file)).sort()
  if (files.length !== 342) {
    throw new Error(`Expected 342 ${group.label}; found ${files.length}`)
  }

  let rawBytes = 0
  let compressedBytes = 0
  let changedFiles = 0
  for (const file of files) {
    const input = await readFile(resolve(group.directory, file))
    const compressed = gzipSync(input, { level: 9 })
    if (!gunzipSync(compressed).equals(input)) {
      throw new Error(`Gzip round-trip failed for ${file}`)
    }
    if (await replaceIfChanged(resolve(group.directory, `${file}.gz`), compressed)) changedFiles += 1
    rawBytes += input.length
    compressedBytes += compressed.length
  }
  summary.push({
    group: group.label,
    files: files.length,
    changedFiles,
    rawBytes,
    compressedBytes,
    savedBytes: rawBytes - compressedBytes,
  })
}

console.log(JSON.stringify({ groups: summary, status: 'valid' }, null, 2))
