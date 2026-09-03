#!/usr/bin/env node

/**
 * Build browser-sized Dutch public-transport map assets from the national
 * OVapi GTFS feed. The feed is derived from open NDOV operator data, but is a
 * best-effort aggregation without a service-level agreement. See:
 * https://gtfs.ovapi.nl/README
 *
 * This script deliberately ignores stop_times.txt (currently about 1 GB
 * uncompressed). It creates a physical/reference network for the map, not a
 * journey planner or an operational prediction. Route shapes are ranked by
 * the number of scheduled trip records, clipped to the European Netherlands,
 * simplified, and deduplicated before being written.
 *
 * Examples:
 *   node scripts/fetch-transit.mjs --download
 *   node scripts/fetch-transit.mjs --input /path/to/gtfs-nl.zip --output /tmp/transit
 *
 * Requirements: Node.js 22+ and the system `unzip` command.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, copyFile, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const execFileAsync = promisify(execFile)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUTPUT = resolve(SCRIPT_DIR, '../apps/web/public/data/transit')
const DEFAULT_FEED_URL = 'https://gtfs.ovapi.nl/nl/gtfs-nl.zip'
const SOURCE_README = 'https://gtfs.ovapi.nl/README'
const NDOV_SOURCE = 'https://www2.ndovloket.nl/'
const OUTPUT_FILES = [
  'transit-routes-bus.geojson',
  'transit-routes-urban-rail.geojson',
  'transit-routes-rail.geojson',
  'transit-routes-ferry.geojson',
  'transit-stops.geojson',
  'transit-manifest.json',
]

const MODE_BY_ROUTE_TYPE = new Map([
  [0, 'urban-rail'], // Tram/light rail
  [1, 'urban-rail'], // Metro
  [2, 'rail'],
  [3, 'bus'],
  [4, 'ferry'],
  [11, 'bus'], // Trolleybus (extended GTFS route type)
  [12, 'urban-rail'], // Monorail (extended GTFS route type)
])

const ROUTE_TYPE_LABEL = new Map([
  [0, 'tram'],
  [1, 'metro'],
  [2, 'rail'],
  [3, 'bus'],
  [4, 'ferry'],
  [11, 'trolleybus'],
  [12, 'monorail'],
])

const BASE_TOLERANCE_METRES = {
  bus: 55,
  'urban-rail': 20,
  rail: 35,
  ferry: 100,
}

function printHelp() {
  console.log(`Usage: node scripts/fetch-transit.mjs (--download | --input FILE) [options]

Options:
  --download                 Download the current national OVapi GTFS feed.
  --input FILE               Use an existing GTFS zip instead of downloading.
  --output DIR               Output directory (default: ${DEFAULT_OUTPUT}).
  --feed-url URL             Override the download URL.
  --bbox W,S,E,N             Clip to this WGS84 bounding box.
                             Default: 2.5,50.5,7.8,53.8.
  --max-shapes N             Maximum route shapes selected by trip count.
                             Default: 14000.
  --max-stops N              Fail if grouped stops exceed this count.
                             Default: 45000.
  --max-output-points N      Fail if simplified route points exceed this count.
                             Default: 1500000.
  --max-download-mb N        Download safety limit. Default: 300.
  --tolerance-scale N        Multiply mode-specific simplification tolerances.
                             Default: 1. Use a larger value for smaller files.
  --force                    Replace only the six known generated files.
  --help                     Show this message.

The raw GTFS archive is held in an OS temporary directory and deleted after a
successful or failed build. Existing local --input files are never removed.`)
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer; received ${value}`)
  }
  return parsed
}

function parsePositiveNumber(value, option) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number; received ${value}`)
  }
  return parsed
}

function parseBbox(value) {
  const parts = value.split(',').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isFinite(part)) ||
    parts[0] >= parts[2] ||
    parts[1] >= parts[3]
  ) {
    throw new Error(`--bbox must be W,S,E,N; received ${value}`)
  }
  return parts
}

function parseArgs(argv) {
  const options = {
    download: false,
    input: null,
    output: DEFAULT_OUTPUT,
    feedUrl: DEFAULT_FEED_URL,
    bbox: [2.5, 50.5, 7.8, 53.8],
    maxShapes: 14_000,
    maxStops: 45_000,
    maxOutputPoints: 1_500_000,
    maxDownloadBytes: 300 * 1024 * 1024,
    toleranceScale: 1,
    force: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`)
      }
      index += 1
      return value
    }

    switch (argument) {
      case '--download':
        options.download = true
        break
      case '--input':
        options.input = resolve(next())
        break
      case '--output':
        options.output = resolve(next())
        break
      case '--feed-url':
        options.feedUrl = next()
        break
      case '--bbox':
        options.bbox = parseBbox(next())
        break
      case '--max-shapes':
        options.maxShapes = parsePositiveInteger(next(), argument)
        break
      case '--max-stops':
        options.maxStops = parsePositiveInteger(next(), argument)
        break
      case '--max-output-points':
        options.maxOutputPoints = parsePositiveInteger(next(), argument)
        break
      case '--max-download-mb':
        options.maxDownloadBytes = Math.round(
          parsePositiveNumber(next(), argument) * 1024 * 1024,
        )
        break
      case '--tolerance-scale':
        options.toleranceScale = parsePositiveNumber(next(), argument)
        break
      case '--force':
        options.force = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (options.download === Boolean(options.input)) {
    throw new Error('Choose exactly one of --download or --input FILE')
  }
  return options
}

async function hashFile(path) {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadFeed(url, outputPath, maxBytes) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DisasterSimulator transit data builder (rikstokmans.com)',
      Accept: 'application/zip',
      'Accept-Encoding': 'identity',
    },
    redirect: 'follow',
  })
  if (!response.ok || !response.body) {
    throw new Error(`GTFS download failed: HTTP ${response.status} ${response.statusText}`)
  }

  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel()
    throw new Error(
      `GTFS download is ${declaredLength} bytes, above the ${maxBytes}-byte safety limit`,
    )
  }

  let bytes = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        callback(new Error(`GTFS download exceeded the ${maxBytes}-byte safety limit`))
        return
      }
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(outputPath))
  return {
    bytes,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    resolvedUrl: response.url,
  }
}

function parseCsvLine(line) {
  const values = []
  let value = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          value += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        value += character
      }
    } else if (character === ',') {
      values.push(value)
      value = ''
    } else if (character === '"' && value.length === 0) {
      quoted = true
    } else {
      value += character
    }
  }
  if (quoted) throw new Error('Unsupported multiline or unterminated quoted CSV field')
  values.push(value)
  return values
}

async function forEachZipCsv(zipPath, entryName, requiredColumns, onRow) {
  const child = spawn('unzip', ['-p', zipPath, entryName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 16_000) stderr += chunk
  })
  const closePromise = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose)
    child.once('close', (code) => {
      if (code === 0) resolveClose()
      else rejectClose(new Error(`unzip failed for ${entryName} (${code}): ${stderr.trim()}`))
    })
  })

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let indexes = null
  let rows = 0
  try {
    for await (const line of lines) {
      if (!indexes) {
        const headers = parseCsvLine(line.replace(/^\uFEFF/, ''))
        indexes = Object.fromEntries(headers.map((header, index) => [header, index]))
        for (const column of requiredColumns) {
          if (!(column in indexes)) {
            throw new Error(`${entryName} is missing required column ${column}`)
          }
        }
        continue
      }
      if (line.length === 0) continue
      const values = parseCsvLine(line)
      onRow(values, indexes)
      rows += 1
    }
    await closePromise
  } catch (error) {
    child.kill('SIGTERM')
    await closePromise.catch(() => {})
    throw error
  }
  if (!indexes) throw new Error(`${entryName} is empty`)
  return rows
}

async function inspectZip(zipPath) {
  let stdout
  try {
    ;({ stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { maxBuffer: 1_000_000 }))
  } catch (error) {
    throw new Error(`Cannot inspect GTFS zip. Is the system 'unzip' command installed? ${error}`)
  }
  const entries = new Set(stdout.split(/\r?\n/).filter(Boolean))
  const required = ['feed_info.txt', 'routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt']
  const missing = required.filter((entry) => !entries.has(entry))
  if (missing.length > 0) throw new Error(`GTFS zip is missing: ${missing.join(', ')}`)
}

function insideBbox(coordinate, bbox) {
  return (
    coordinate[0] >= bbox[0] &&
    coordinate[0] <= bbox[2] &&
    coordinate[1] >= bbox[1] &&
    coordinate[1] <= bbox[3]
  )
}

function equalCoordinates(left, right) {
  return Math.abs(left[0] - right[0]) < 1e-10 && Math.abs(left[1] - right[1]) < 1e-10
}

function clipSegmentToBbox(start, end, bbox) {
  const deltaX = end[0] - start[0]
  const deltaY = end[1] - start[1]
  const p = [-deltaX, deltaX, -deltaY, deltaY]
  const q = [
    start[0] - bbox[0],
    bbox[2] - start[0],
    start[1] - bbox[1],
    bbox[3] - start[1],
  ]
  let minimum = 0
  let maximum = 1

  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index] < 0) return null
      continue
    }
    const ratio = q[index] / p[index]
    if (p[index] < 0) minimum = Math.max(minimum, ratio)
    else maximum = Math.min(maximum, ratio)
    if (minimum > maximum) return null
  }

  return [
    [start[0] + minimum * deltaX, start[1] + minimum * deltaY],
    [start[0] + maximum * deltaX, start[1] + maximum * deltaY],
  ]
}

function clipLineToBbox(points, bbox) {
  const parts = []
  let current = []
  const finish = () => {
    if (current.length >= 2) parts.push(current)
    current = []
  }

  for (let index = 1; index < points.length; index += 1) {
    const clipped = clipSegmentToBbox(points[index - 1], points[index], bbox)
    if (!clipped) {
      finish()
      continue
    }
    const [start, end] = clipped
    if (current.length === 0) current.push(start, end)
    else if (equalCoordinates(current[current.length - 1], start)) current.push(end)
    else {
      finish()
      current.push(start, end)
    }
  }
  finish()

  return parts.map((part) =>
    part.filter((point, index) => index === 0 || !equalCoordinates(point, part[index - 1])),
  )
}

function squaredSegmentDistance(point, start, end, longitudeScale) {
  const pointX = point[0] * longitudeScale
  const pointY = point[1]
  const startX = start[0] * longitudeScale
  const startY = start[1]
  const endX = end[0] * longitudeScale
  const endY = end[1]
  const deltaX = endX - startX
  const deltaY = endY - startY

  if (deltaX === 0 && deltaY === 0) {
    return (pointX - startX) ** 2 + (pointY - startY) ** 2
  }
  const ratio = Math.max(
    0,
    Math.min(1, ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / (deltaX ** 2 + deltaY ** 2)),
  )
  const projectedX = startX + ratio * deltaX
  const projectedY = startY + ratio * deltaY
  return (pointX - projectedX) ** 2 + (pointY - projectedY) ** 2
}

function simplifyLine(points, toleranceMetres) {
  if (points.length <= 2) return points
  const meanLatitude = points.reduce((sum, point) => sum + point[1], 0) / points.length
  const longitudeScale = Math.cos((meanLatitude * Math.PI) / 180)
  const toleranceDegrees = toleranceMetres / 111_320
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]

  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop()
    let maximumDistance = 0
    let maximumIndex = -1
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = squaredSegmentDistance(
        points[index],
        points[startIndex],
        points[endIndex],
        longitudeScale,
      )
      if (distance > maximumDistance) {
        maximumDistance = distance
        maximumIndex = index
      }
    }
    if (maximumIndex !== -1 && maximumDistance > toleranceDegrees ** 2) {
      keep[maximumIndex] = 1
      stack.push([startIndex, maximumIndex], [maximumIndex, endIndex])
    }
  }

  return points
    .filter((_point, index) => keep[index] === 1)
    .map((point) => [Number(point[0].toFixed(6)), Number(point[1].toFixed(6))])
}

function canonicalPart(part) {
  const forward = JSON.stringify(part)
  const reverse = JSON.stringify([...part].reverse())
  return forward < reverse ? forward : reverse
}

function geometryDigest(mode, geometry) {
  const parts = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates
  const canonical = parts.map(canonicalPart).sort().join('|')
  return createHash('sha256').update(`${mode}\0${canonical}`).digest('hex')
}

function normalizedColor(value, fallback) {
  return /^[0-9a-f]{6}$/i.test(value ?? '') ? `#${value.toLowerCase()}` : fallback
}

function shapeMetadata(shapeId, summary, routes) {
  const rankedRoutes = [...summary.routeCounts.entries()]
    .map(([routeId, trips]) => ({ routeId, trips, route: routes.get(routeId) }))
    .filter((entry) => entry.route?.mode)
    .sort((left, right) => right.trips - left.trips || left.routeId.localeCompare(right.routeId))
  if (rankedRoutes.length === 0) return null
  const primary = rankedRoutes[0]
  return {
    shapeId,
    trips: summary.trips,
    mode: primary.route.mode,
    primary,
    routes: rankedRoutes,
  }
}

function mergeFeature(existing, metadata) {
  existing.shapeIds.add(metadata.shapeId)
  existing.tripRecords += metadata.trips
  for (const entry of metadata.routes) {
    existing.routeIds.add(entry.routeId)
    if (entry.route.shortName) existing.routeLabels.add(entry.route.shortName)
    if (entry.route.agencyId) existing.agencyIds.add(entry.route.agencyId)
    existing.routeTypes.add(entry.route.typeLabel)
  }
  if (metadata.trips > existing.primaryTrips) {
    existing.primaryTrips = metadata.trips
    existing.primary = metadata.primary
  }
}

function createFeatureRecord(digest, geometry, metadata) {
  const record = {
    digest,
    geometry,
    mode: metadata.mode,
    shapeIds: new Set(),
    routeIds: new Set(),
    routeLabels: new Set(),
    agencyIds: new Set(),
    routeTypes: new Set(),
    tripRecords: 0,
    primaryTrips: -1,
    primary: metadata.primary,
  }
  mergeFeature(record, metadata)
  return record
}

function finalizeRouteFeature(record) {
  const primaryRoute = record.primary.route
  return {
    type: 'Feature',
    id: `gtfs-${record.digest.slice(0, 20)}`,
    geometry: record.geometry,
    properties: {
      id: `gtfs-${record.digest.slice(0, 20)}`,
      mode: record.mode,
      route_types: [...record.routeTypes].sort().join('|'),
      primary_route_id: record.primary.routeId,
      route_label: primaryRoute.shortName || primaryRoute.longName || record.primary.routeId,
      route_name: primaryRoute.longName || primaryRoute.shortName || '',
      agency_id: primaryRoute.agencyId,
      color: normalizedColor(primaryRoute.color, record.mode === 'bus' ? '#4d9fff' : '#efc75e'),
      text_color: normalizedColor(primaryRoute.textColor, '#ffffff'),
      route_ids: [...record.routeIds].sort().slice(0, 24).join('|'),
      route_count: record.routeIds.size,
      route_labels: [...record.routeLabels].sort().slice(0, 24).join('|'),
      agency_ids: [...record.agencyIds].sort().join('|'),
      shape_ids: [...record.shapeIds].sort().slice(0, 24).join('|'),
      shape_count: record.shapeIds.size,
      scheduled_trip_records: record.tripRecords,
      source: 'OVapi GTFS (derived from NDOV operator data)',
    },
  }
}

function normalizeStopName(name) {
  return name.normalize('NFKD').toLowerCase().replace(/\s+/g, ' ').trim()
}

function newStopGroup(row, kind, groupKey) {
  return {
    groupKey,
    id: row.id,
    name: row.name,
    kind,
    parentStation: row.parentStation,
    zoneId: row.zoneId,
    latitudeTotal: row.latitude,
    longitudeTotal: row.longitude,
    coordinateCount: 1,
    platformCount: kind === 'stop-area' ? 0 : 1,
    wheelchairYes: row.wheelchair === '1' ? 1 : 0,
    wheelchairNo: row.wheelchair === '2' ? 1 : 0,
    wheelchairUnknown: row.wheelchair !== '1' && row.wheelchair !== '2' ? 1 : 0,
  }
}

function mergeStopRow(group, row, countAsPlatform = true) {
  if (countAsPlatform) {
    group.platformCount += 1
    if (group.kind !== 'stop-area') {
      group.latitudeTotal += row.latitude
      group.longitudeTotal += row.longitude
      group.coordinateCount += 1
    }
  }
  if (row.wheelchair === '1') group.wheelchairYes += 1
  else if (row.wheelchair === '2') group.wheelchairNo += 1
  else group.wheelchairUnknown += 1
  if (!group.zoneId && row.zoneId) group.zoneId = row.zoneId
}

function finalizeStopFeature(group) {
  const accessibility =
    group.wheelchairNo > 0 && group.wheelchairYes > 0
      ? 'partial'
      : group.wheelchairNo > 0
        ? 'no'
        : group.wheelchairYes > 0
          ? 'yes'
          : 'unknown'
  const longitude = group.longitudeTotal / group.coordinateCount
  const latitude = group.latitudeTotal / group.coordinateCount
  const digest = createHash('sha256')
    .update(`${group.groupKey}\0${longitude.toFixed(6)}\0${latitude.toFixed(6)}`)
    .digest('hex')
  return {
    type: 'Feature',
    id: `stop-${digest.slice(0, 20)}`,
    geometry: {
      type: 'Point',
      coordinates: [Number(longitude.toFixed(6)), Number(latitude.toFixed(6))],
    },
    properties: {
      id: group.id,
      name: group.name,
      kind: group.kind,
      parent_station: group.parentStation,
      zone_id: group.zoneId,
      platform_count: group.platformCount,
      wheelchair_accessible: accessibility,
      source: 'OVapi GTFS (derived from NDOV operator data)',
    },
  }
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain')
}

async function writeFeatureCollection(path, metadata, features) {
  const stream = createWriteStream(path, { encoding: 'utf8' })
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    stream.once('error', rejectCompletion)
    stream.once('finish', resolveCompletion)
  })
  const header = JSON.stringify({ type: 'FeatureCollection', ...metadata })
  await writeChunk(stream, `${header.slice(0, -1)},"features":[`)
  for (let index = 0; index < features.length; index += 1) {
    if (index > 0) await writeChunk(stream, ',')
    await writeChunk(stream, JSON.stringify(features[index]))
  }
  stream.end(']}\n')
  await completion
}

async function fileDescription(path, featureCount) {
  const details = await stat(path)
  return {
    bytes: details.size,
    sha256: await hashFile(path),
    featureCount,
  }
}

async function ensureTargetsAreSafe(outputDir, force) {
  const existing = []
  for (const filename of OUTPUT_FILES) {
    try {
      await stat(join(outputDir, filename))
      existing.push(filename)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (existing.length > 0 && !force) {
    throw new Error(
      `Refusing to replace existing generated files: ${existing.join(', ')}. Use --force.`,
    )
  }
}

async function build(options, zipPath, sourceDownload, workDir) {
  await inspectZip(zipPath)
  const generatedAt = new Date().toISOString()
  const zipStats = await stat(zipPath)
  const zipSha256 = await hashFile(zipPath)
  const buildDir = join(workDir, 'output')
  await mkdir(buildDir, { recursive: true })

  let feedInfo = {}
  const feedInfoRows = await forEachZipCsv(
    zipPath,
    'feed_info.txt',
    ['feed_publisher_name', 'feed_publisher_url', 'feed_start_date', 'feed_end_date', 'feed_version'],
    (row, columns) => {
      if (Object.keys(feedInfo).length > 0) return
      feedInfo = {
        publisherName: row[columns.feed_publisher_name],
        publisherUrl: row[columns.feed_publisher_url],
        feedId: columns.feed_id === undefined ? null : row[columns.feed_id],
        language: columns.feed_lang === undefined ? null : row[columns.feed_lang],
        startDate: row[columns.feed_start_date],
        endDate: row[columns.feed_end_date],
        version: row[columns.feed_version],
      }
    },
  )
  if (feedInfoRows === 0) throw new Error('feed_info.txt contains no feed record')

  const routes = new Map()
  const routeRows = await forEachZipCsv(
    zipPath,
    'routes.txt',
    ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'],
    (row, columns) => {
      const routeId = row[columns.route_id]
      const routeType = Number(row[columns.route_type])
      routes.set(routeId, {
        routeId,
        agencyId: row[columns.agency_id],
        shortName: row[columns.route_short_name],
        longName: row[columns.route_long_name],
        routeType,
        typeLabel: ROUTE_TYPE_LABEL.get(routeType) ?? `type-${routeType}`,
        mode: MODE_BY_ROUTE_TYPE.get(routeType) ?? null,
        color: columns.route_color === undefined ? '' : row[columns.route_color],
        textColor: columns.route_text_color === undefined ? '' : row[columns.route_text_color],
      })
    },
  )

  const shapeSummaries = new Map()
  const tripRows = await forEachZipCsv(
    zipPath,
    'trips.txt',
    ['route_id', 'shape_id'],
    (row, columns) => {
      const routeId = row[columns.route_id]
      const shapeId = row[columns.shape_id]
      if (!shapeId || !routes.get(routeId)?.mode) return
      let summary = shapeSummaries.get(shapeId)
      if (!summary) {
        summary = { trips: 0, routeCounts: new Map() }
        shapeSummaries.set(shapeId, summary)
      }
      summary.trips += 1
      summary.routeCounts.set(routeId, (summary.routeCounts.get(routeId) ?? 0) + 1)
    },
  )

  const candidates = [...shapeSummaries.entries()]
    .map(([shapeId, summary]) => shapeMetadata(shapeId, summary, routes))
    .filter(Boolean)
    .sort((left, right) => right.trips - left.trips || left.shapeId.localeCompare(right.shapeId))
  const selectedMetadata = new Map(
    candidates.slice(0, options.maxShapes).map((metadata) => [metadata.shapeId, metadata]),
  )

  const routeFeatures = new Map()
  const seenShapes = new Set()
  const shapeStats = {
    inputShapeRows: 0,
    inputShapes: 0,
    candidateShapes: candidates.length,
    selectedShapes: selectedMetadata.size,
    omittedByShapeLimit: Math.max(0, candidates.length - selectedMetadata.size),
    selectedInputPoints: 0,
    invalidPoints: 0,
    clippedOutShapes: 0,
    clippedParts: 0,
    simplifiedPoints: 0,
    deduplicatedGeometries: 0,
  }
  let currentShapeId = null
  let currentPoints = []

  const flushShape = () => {
    if (currentShapeId === null) return
    shapeStats.inputShapes += 1
    const metadata = selectedMetadata.get(currentShapeId)
    if (!metadata) return
    currentPoints.sort((left, right) => left.sequence - right.sequence)
    const coordinates = currentPoints.map((point) => point.coordinate)
    const clipped = clipLineToBbox(coordinates, options.bbox)
    const tolerance = BASE_TOLERANCE_METRES[metadata.mode] * options.toleranceScale
    const simplified = clipped
      .map((part) => simplifyLine(part, tolerance))
      .filter((part) => part.length >= 2)
    if (simplified.length === 0) {
      shapeStats.clippedOutShapes += 1
      return
    }
    shapeStats.clippedParts += simplified.length
    shapeStats.simplifiedPoints += simplified.reduce((sum, part) => sum + part.length, 0)
    if (shapeStats.simplifiedPoints > options.maxOutputPoints) {
      throw new Error(
        `Simplified routes exceeded --max-output-points=${options.maxOutputPoints}. ` +
          'Increase --tolerance-scale or explicitly raise the limit.',
      )
    }
    const geometry =
      simplified.length === 1
        ? { type: 'LineString', coordinates: simplified[0] }
        : { type: 'MultiLineString', coordinates: simplified }
    const digest = geometryDigest(metadata.mode, geometry)
    const existing = routeFeatures.get(digest)
    if (existing) {
      mergeFeature(existing, metadata)
      shapeStats.deduplicatedGeometries += 1
    } else routeFeatures.set(digest, createFeatureRecord(digest, geometry, metadata))
  }

  const shapeRows = await forEachZipCsv(
    zipPath,
    'shapes.txt',
    ['shape_id', 'shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon'],
    (row, columns) => {
      shapeStats.inputShapeRows += 1
      const shapeId = row[columns.shape_id]
      if (shapeId !== currentShapeId) {
        if (currentShapeId !== null) {
          flushShape()
          seenShapes.add(currentShapeId)
        }
        if (seenShapes.has(shapeId)) {
          throw new Error(
            `shapes.txt is not grouped by shape_id (${shapeId} reappeared); ` +
              'the current OVapi feed is expected to be grouped.',
          )
        }
        currentShapeId = shapeId
        currentPoints = []
      }
      if (!selectedMetadata.has(shapeId)) return
      shapeStats.selectedInputPoints += 1
      const latitude = Number(row[columns.shape_pt_lat])
      const longitude = Number(row[columns.shape_pt_lon])
      const sequence = Number(row[columns.shape_pt_sequence])
      if (![latitude, longitude, sequence].every(Number.isFinite)) {
        shapeStats.invalidPoints += 1
        return
      }
      currentPoints.push({ sequence, coordinate: [longitude, latitude] })
    },
  )
  flushShape()
  if (shapeRows !== shapeStats.inputShapeRows) {
    throw new Error('Internal shape row-count mismatch')
  }

  const featuresByMode = {
    bus: [],
    'urban-rail': [],
    rail: [],
    ferry: [],
  }
  for (const record of routeFeatures.values()) {
    featuresByMode[record.mode].push(finalizeRouteFeature(record))
  }
  for (const features of Object.values(featuresByMode)) {
    features.sort(
      (left, right) =>
        right.properties.scheduled_trip_records - left.properties.scheduled_trip_records ||
        left.id.localeCompare(right.id),
    )
  }

  const stopRows = []
  let inputStopRows = 0
  await forEachZipCsv(
    zipPath,
    'stops.txt',
    ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
    (row, columns) => {
      inputStopRows += 1
      const latitude = Number(row[columns.stop_lat])
      const longitude = Number(row[columns.stop_lon])
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return
      if (!insideBbox([longitude, latitude], options.bbox)) return
      stopRows.push({
        id: row[columns.stop_id],
        name: row[columns.stop_name],
        latitude,
        longitude,
        locationType: columns.location_type === undefined ? '0' : row[columns.location_type] || '0',
        parentStation: columns.parent_station === undefined ? '' : row[columns.parent_station],
        wheelchair:
          columns.wheelchair_boarding === undefined ? '0' : row[columns.wheelchair_boarding] || '0',
        zoneId: columns.zone_id === undefined ? '' : row[columns.zone_id],
      })
    },
  )

  const parentRows = new Map(stopRows.filter((row) => row.locationType === '1').map((row) => [row.id, row]))
  const stopGroups = new Map()
  for (const row of parentRows.values()) {
    const key = `parent:${row.id}`
    stopGroups.set(key, newStopGroup(row, 'stop-area', key))
  }
  for (const row of stopRows) {
    if (row.locationType === '1') continue
    const parent = row.parentStation ? parentRows.get(row.parentStation) : null
    if (parent) {
      mergeStopRow(stopGroups.get(`parent:${parent.id}`), row, true)
      continue
    }
    // About a 35–55 metre grid at Dutch latitudes. Combined with the name,
    // this groups opposing quays into one useful map stop without merging
    // differently named nearby stops.
    const gridX = Math.round(row.longitude * 2_000)
    const gridY = Math.round(row.latitude * 2_000)
    const key = `local:${normalizeStopName(row.name)}:${gridX}:${gridY}`
    const existing = stopGroups.get(key)
    if (existing) mergeStopRow(existing, row, true)
    else stopGroups.set(key, newStopGroup(row, 'stop', key))
  }
  if (stopGroups.size > options.maxStops) {
    throw new Error(
      `Grouped stops (${stopGroups.size}) exceed --max-stops=${options.maxStops}. ` +
        'Raise the explicit limit after checking the browser payload.',
    )
  }
  const stopFeatures = [...stopGroups.values()].map(finalizeStopFeature)
  stopFeatures.sort(
    (left, right) =>
      right.properties.platform_count - left.properties.platform_count ||
      left.properties.name.localeCompare(right.properties.name, 'nl'),
  )

  const source = {
    title: 'OVapi national Netherlands GTFS (NDOV-derived)',
    url: sourceDownload?.resolvedUrl ?? options.feedUrl,
    readme: SOURCE_README,
    underlyingSource: NDOV_SOURCE,
    inputMethod: options.download ? 'download' : 'local-file',
    usage:
      'Free use under OVapi terms; best effort, no SLA, and do not represent or impersonate listed operators.',
    retrievedAt: generatedAt,
    lastModified: sourceDownload?.lastModified ?? null,
    etag: sourceDownload?.etag ?? null,
    inputBytes: zipStats.size,
    inputSha256: zipSha256,
  }
  const collectionMetadata = {
    generatedAt,
    bbox: options.bbox,
    source,
    feed: feedInfo,
    caveat: 'Reference geometry and scheduled-service metadata; not live operations or a journey planner.',
  }

  const outputDefinitions = [
    ['transit-routes-bus.geojson', 'Dutch scheduled bus route shapes', featuresByMode.bus],
    [
      'transit-routes-urban-rail.geojson',
      'Dutch scheduled tram, metro and light-rail route shapes',
      featuresByMode['urban-rail'],
    ],
    ['transit-routes-rail.geojson', 'Dutch scheduled rail route shapes', featuresByMode.rail],
    ['transit-routes-ferry.geojson', 'Dutch scheduled ferry route shapes', featuresByMode.ferry],
    ['transit-stops.geojson', 'Dutch public-transport stop areas and grouped stops', stopFeatures],
  ]
  const files = {}
  for (const [filename, name, features] of outputDefinitions) {
    const path = join(buildDir, filename)
    await writeFeatureCollection(path, { ...collectionMetadata, name }, features)
    files[filename] = await fileDescription(path, features.length)
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt,
    source,
    feed: feedInfo,
    processing: {
      bbox: options.bbox,
      selectedBy: 'scheduled trip-record count',
      maxShapes: options.maxShapes,
      maxStops: options.maxStops,
      maxOutputPoints: options.maxOutputPoints,
      toleranceScale: options.toleranceScale,
      toleranceMetresByMode: Object.fromEntries(
        Object.entries(BASE_TOLERANCE_METRES).map(([mode, tolerance]) => [
          mode,
          tolerance * options.toleranceScale,
        ]),
      ),
      routeGeometryClipping: 'Liang-Barsky line clipping to bbox',
      routeGeometrySimplification: 'iterative Douglas-Peucker',
      routeGeometryDeduplication: 'direction-independent SHA-256 of simplified geometry per mode',
      stopGrouping:
        'GTFS parent stations, otherwise normalized name plus approximately 35–55 metre coordinate grid',
    },
    counts: {
      routeRows,
      tripRows,
      inputStopRows,
      stopsInsideBounds: stopRows.length,
      groupedStops: stopFeatures.length,
      ...shapeStats,
      outputRouteGeometries: routeFeatures.size,
      outputRouteGeometriesByMode: Object.fromEntries(
        Object.entries(featuresByMode).map(([mode, features]) => [mode, features.length]),
      ),
    },
    files,
    caveats: [
      'OVapi is a best-effort NDOV-derived aggregate without an SLA.',
      'scheduled_trip_records ranks map relevance but is not trips per day or passenger demand.',
      'stop_times.txt is intentionally not processed; these assets cannot answer journey-planning questions.',
      'Vehicle capacity, ridership, disruption probability and disaster impacts are not present in GTFS.',
      'The bounding box includes a small cross-border buffer but excludes distant international route sections.',
    ],
  }
  const manifestPath = join(buildDir, 'transit-manifest.json')
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  await ensureTargetsAreSafe(options.output, options.force)
  await mkdir(options.output, { recursive: true })
  for (const filename of OUTPUT_FILES) {
    await copyFile(join(buildDir, filename), join(options.output, filename))
  }
  return manifest
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  // Fail before a potentially large download if the target is already occupied.
  // The same check is repeated immediately before copying to cover races.
  await ensureTargetsAreSafe(options.output, options.force)
  const workDir = await mkdtemp(join(tmpdir(), 'disaster-transit-'))
  let sourceDownload = null
  try {
    let zipPath = options.input
    if (options.download) {
      zipPath = join(workDir, 'gtfs-nl.zip')
      console.log(`Downloading ${options.feedUrl}`)
      sourceDownload = await downloadFeed(options.feedUrl, zipPath, options.maxDownloadBytes)
      console.log(`Downloaded ${(sourceDownload.bytes / 1024 / 1024).toFixed(1)} MiB`)
    } else {
      const inputStats = await stat(zipPath)
      if (!inputStats.isFile() || inputStats.size === 0) {
        throw new Error(`Input is not a non-empty file: ${zipPath}`)
      }
    }

    const manifest = await build(options, zipPath, sourceDownload, workDir)
    console.log(`Wrote transit assets to ${options.output}`)
    for (const [filename, details] of Object.entries(manifest.files)) {
      console.log(
        `  ${filename}: ${details.featureCount.toLocaleString('en')} features, ` +
          `${(details.bytes / 1024 / 1024).toFixed(2)} MiB`,
      )
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
