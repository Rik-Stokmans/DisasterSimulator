#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { fetchNdwCurrentSituations } from './lib/ndw-current-situations.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(
  here,
  '../apps/web/public/data/public-context/ndw-road-situations.geojson.gz',
)

const { collection } = await fetchNdwCurrentSituations()

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, gzipSync(`${JSON.stringify(collection)}\n`, { level: 9 }))
process.stdout.write(`${JSON.stringify({
  publicationTime: collection.source.publicationTime,
  features: collection.features.length,
  totalSituations: collection.processing.totalSituations,
  confidentialSituationsExcluded: collection.processing.confidentialSituationsExcluded,
  recordsOutside72HoursExcluded: collection.processing.recordsOutside72HoursExcluded,
  recordsWithoutUsableGeometryExcluded: collection.processing.recordsWithoutUsableGeometryExcluded,
  outputPath,
}, null, 2)}\n`)
