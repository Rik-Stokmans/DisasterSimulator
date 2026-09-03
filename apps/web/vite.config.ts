import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { fetchNdwCurrentSituations } from '../../scripts/lib/ndw-current-situations.mjs'

const warroomBasePath = process.env.WARROOM_BASE_PATH
const normalizedBasePath = warroomBasePath
  ? `/${warroomBasePath.replace(/^\/+|\/+$/g, '')}`
  : ''
const roadSituationApiPath = `${normalizedBasePath}/api/ndw-road-situations`
const roadSituationFallbackPath = fileURLToPath(
  new URL('./public/data/public-context/ndw-road-situations.geojson.gz', import.meta.url),
)
const roadSituationRefreshMs = 60_000
const unusedRuntimeTransitStops = fileURLToPath(
  new URL('./dist/data/transit/transit-stops.geojson', import.meta.url),
)
const lazyRuntimeDirectories = [
  {
    path: fileURLToPath(new URL('./dist/data/regions', import.meta.url)),
    rawPattern: /^GM\d{4}\.json$/,
  },
  {
    path: fileURLToPath(new URL('./dist/data/settlements', import.meta.url)),
    rawPattern: /^GM\d{4}\.geojson$/,
  },
]

type NdwRuntimeCollection = Awaited<ReturnType<typeof fetchNdwCurrentSituations>>['collection'] & {
  source: Awaited<ReturnType<typeof fetchNdwCurrentSituations>>['collection']['source'] & {
    deliveryMode?: 'live-server-proxy' | 'live-server-proxy-stale' | 'deployment-snapshot-fallback'
    refreshIntervalSeconds?: number
    liveRefreshError?: string
  }
}

/**
 * NDW's public gzip is not a browser-CORS API. Vite is also the Gatekeeper
 * preview process, so this same-origin adapter retrieves, filters and caches
 * the official current picture server-side. A checked-in snapshot remains as
 * an explicitly labelled fail-closed fallback when NDW cannot be reached.
 */
function ndwRoadSituationApi(): Plugin {
  let cached: { collection: NdwRuntimeCollection; expiresAt: number } | null = null
  let lastLiveCollection: NdwRuntimeCollection | null = null
  let inFlight: Promise<NdwRuntimeCollection> | null = null

  const annotate = (
    collection: NdwRuntimeCollection,
    deliveryMode: NonNullable<NdwRuntimeCollection['source']['deliveryMode']>,
    liveRefreshError?: string,
  ): NdwRuntimeCollection => ({
    ...collection,
    source: {
      ...collection.source,
      deliveryMode,
      refreshIntervalSeconds: roadSituationRefreshMs / 1_000,
      ...(liveRefreshError ? { liveRefreshError } : {}),
    },
  })

  const fallback = async () => {
    const compressed = await readFile(roadSituationFallbackPath)
    const collection = JSON.parse(gunzipSync(compressed).toString('utf8')) as NdwRuntimeCollection
    return annotate(
      collection,
      'deployment-snapshot-fallback',
      'The upstream refresh failed; showing the last deployment snapshot.',
    )
  }

  const refresh = async () => {
    try {
      const { collection } = await fetchNdwCurrentSituations({
        signal: AbortSignal.timeout(12_000),
      })
      const live = annotate(collection as NdwRuntimeCollection, 'live-server-proxy')
      lastLiveCollection = live
      return live
    } catch {
      if (lastLiveCollection) {
        return annotate(
          lastLiveCollection,
          'live-server-proxy-stale',
          'The latest upstream refresh failed; retaining the last successful live response.',
        )
      }
      return fallback()
    }
  }

  const load = () => {
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.collection)
    if (inFlight) return inFlight
    inFlight = refresh()
      .then((collection) => {
        cached = {
          collection,
          expiresAt: Date.now() + (
            collection.source.deliveryMode === 'live-server-proxy' ? roadSituationRefreshMs : 30_000
          ),
        }
        return collection
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const handler: Connect.NextHandleFunction = (request, response, next) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname !== roadSituationApiPath) {
      next()
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      response.end('Method Not Allowed')
      return
    }
    void load()
      .then((collection) => {
        const body = JSON.stringify(collection)
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/geo+json; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          'x-content-type-options': 'nosniff',
          'x-ndw-delivery-mode': collection.source.deliveryMode ?? 'unknown',
        })
        response.end(request.method === 'HEAD' ? undefined : body)
      })
      .catch(() => {
        response.writeHead(503, {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
          'retry-after': '30',
        })
        response.end(JSON.stringify({ status: 'unknown', reason: 'NDW current picture unavailable' }))
      })
  }

  return {
    name: 'same-origin-ndw-current-picture',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

export default defineConfig({
  base: warroomBasePath
    ? `${warroomBasePath.replace(/\/+$/, '')}/`
    : '/',
  plugins: [
    react(),
    ndwRoadSituationApi(),
    {
      name: 'exclude-audit-only-and-uncompressed-runtime-data',
      apply: 'build',
      async closeBundle() {
        // The audit pipeline uses this source file, but no runtime code requests
        // it. Keep it in public/data for provenance checks without shipping the
        // extra 11 MB in every preview release.
        await rm(unusedRuntimeTransitStops, { force: true })
        // The checked-in JSON remains the auditable/generator input. Runtime
        // city drill-down requests its deterministic gzip twin, so do not ship
        // both representations in the size-constrained Gatekeeper release.
        for (const group of lazyRuntimeDirectories) {
          const files = await readdir(group.path)
          await Promise.all(
            files
              .filter((file) => group.rawPattern.test(file))
              .map((file) => rm(fileURLToPath(new URL(file, `file://${group.path}/`)), { force: true })),
          )
        }
      },
    },
  ],
  optimizeDeps: {
    exclude: ['maplibre-gl', 'maplibre-gl/dist/maplibre-gl-worker.mjs'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    allowedHosts: ['rikstokmans.com', 'www.rikstokmans.com', 'localhost', '127.0.0.1'],
  },
})
