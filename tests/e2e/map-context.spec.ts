import { expect, test } from '@playwright/test'
import { observeBrowserDiagnostics, openReadyApp } from './support'

test.describe.configure({ mode: 'serial' })

test('keeps affected regions visible across time, map questions, aerial imagery, and 3D', async ({ page }) => {
  test.setTimeout(60_000)
  const diagnostics = observeBrowserDiagnostics(page)
  const cameraRequests: string[] = []
  const roadSituationRequests: string[] = []
  const threeDimensionalRequests: string[] = []
  const aerialRequests: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  const emptyOfficialTileset = {
    asset: { version: '1.1' },
    geometricError: 0,
    root: {
      boundingVolume: {
        region: [0.06, 0.88, 0.13, 0.94, -5, 250],
      },
      geometricError: 0,
      refine: 'ADD',
    },
  }

  page.on('request', (request) => {
    if (request.url().includes('traffic-cameras.geojson')) cameraRequests.push(request.url())
    if (
      request.url().includes('/api/ndw-road-situations') ||
      request.url().includes('ndw-road-situations.geojson.gz')
    ) {
      roadSituationRequests.push(request.url())
    }
  })
  await page.route('https://service.pdok.nl/hwh/luchtfotorgb/**', async (route) => {
    aerialRequests.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
  })
  await page.route(
    /https:\/\/api\.pdok\.nl\/kadaster\/3d-basisvoorziening\/ogc\/v1\/collections\/(gebouwen|terreinen)\/3dtiles\?f=json$/,
    async (route) => {
      threeDimensionalRequests.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyOfficialTileset) })
    },
  )

  await openReadyApp(page)
  await page.waitForFunction(() => {
    const map = (window as Window & { __resilienceMap?: { getLayer(id: string): unknown } })
      .__resilienceMap
    return Boolean(map?.getLayer('affected-region-overlay-outline'))
  })

  const overlayState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getLayoutProperty(id: string, property: string): unknown
        getSource(id: string): { serialize(): { data?: { features?: Array<{ id?: string | number }> } } } | undefined
        getFeatureState(target: { source: string; id: string | number }): Record<string, unknown>
      }
    }).__resilienceMap!
    const features = map.getSource('municipalities-state')?.serialize().data?.features ?? []
    const counts: Record<string, number> = {}
    for (const feature of features) {
      if (feature.id === undefined) continue
      const state = map.getFeatureState({ source: 'municipalities-state', id: feature.id })
      const impactState = String(state.impactState ?? 'missing')
      counts[impactState] = (counts[impactState] ?? 0) + 1
    }
    return {
      counts,
      fill: map.getLayoutProperty('affected-region-overlay-fill', 'visibility'),
      halo: map.getLayoutProperty('affected-region-overlay-halo', 'visibility'),
      outline: map.getLayoutProperty('affected-region-overlay-outline', 'visibility'),
      gatewayMarkers: map.getLayoutProperty('affected-region-gateway-markers', 'visibility'),
    }
  })

  expect(await overlayState()).toMatchObject({
    fill: 'visible',
    halo: 'visible',
    outline: 'visible',
    gatewayMarkers: 'visible',
  })
  await page.locator('select').nth(2).selectOption('coastal-flood')
  await page.getByRole('slider', { name: /Simulation time/ }).fill('96')
  await expect(page.locator('.affected-overlay-key')).toContainText('T+24:00')
  await expect.poll(async () => {
    const { counts } = await overlayState()
    return (counts.affected ?? 0) + (counts.critical ?? 0)
  }).toBeGreaterThan(0)
  await expect(page.locator('.map-overlay-switch.affected')).toContainText(/\d+ affected · \d+ critical/)

  await page.getByRole('button', {
    name: 'Population & needs: Modeled residents under service pressure',
  }).click()
  expect((await overlayState()).outline).toBe('visible')

  await page.getByRole('button', { name: 'Toggle affected regions overlay' }).click()
  expect(await overlayState()).toMatchObject({
    fill: 'none',
    halo: 'none',
    outline: 'none',
    gatewayMarkers: 'none',
  })
  await page.getByRole('button', { name: 'Toggle affected regions overlay' }).click()

  await page.getByRole('button', { name: 'Use official aerial imagery basemap' }).click()
  await expect.poll(() => aerialRequests.length).toBeGreaterThan(0)
  const aerialState = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getLayoutProperty(id: string, property: string): unknown
        getSource(id: string): { serialize(): { tiles?: string[]; attribution?: string } } | undefined
      }
    }).__resilienceMap!
    return {
      aerial: map.getLayoutProperty('pdok-aerial', 'visibility'),
      cartographic: map.getLayoutProperty('pdok-grey', 'visibility'),
      bgt: map.getLayoutProperty('pdok-bgt-detail', 'visibility'),
      impact: map.getLayoutProperty('affected-region-overlay-outline', 'visibility'),
      source: map.getSource('pdok-aerial')?.serialize(),
    }
  })
  expect(aerialState).toMatchObject({
    aerial: 'visible',
    cartographic: 'none',
    bgt: 'none',
    impact: 'visible',
  })
  expect(aerialState.source?.tiles?.[0]).toContain('/Actueel_ortho25/EPSG:3857/')
  expect(aerialState.source?.attribution).toContain('annual context, not live satellite imagery')

  expect(roadSituationRequests).toEqual([])
  await page.getByRole('button', { name: 'Toggle observed traffic and accidents overlay' }).click()
  await expect.poll(() => roadSituationRequests.length).toBe(1)
  await expect(page.locator('.map-overlay-switch.traffic')).toContainText(/\d+ accidents · \d+ congestion/)
  await expect(page.getByText(/real DATEX II records · .*observed context, not a 72-hour forecast/)).toBeVisible()
  const trafficState = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getLayoutProperty(id: string, property: string): unknown
        getSource(id: string): { serialize(): { data?: { features?: Array<{ properties?: { recordClass?: string } }> } } } | undefined
      }
    }).__resilienceMap!
    const features = map.getSource('official-road-situations')?.serialize().data?.features ?? []
    return {
      accidents: features.filter((feature) => feature.properties?.recordClass === 'Accident').length,
      congestion: features.filter((feature) => feature.properties?.recordClass === 'AbnormalTraffic').length,
      accidentPoints: map.getLayoutProperty('official-road-accident-points', 'visibility'),
      congestionLines: map.getLayoutProperty('official-road-congestion-lines', 'visibility'),
      impact: map.getLayoutProperty('affected-region-overlay-outline', 'visibility'),
    }
  })
  expect(trafficState.accidents).toBeGreaterThan(0)
  expect(trafficState.congestion).toBeGreaterThan(0)
  expect(trafficState).toMatchObject({
    accidentPoints: 'visible',
    congestionLines: 'visible',
    impact: 'visible',
  })

  expect(cameraRequests).toEqual([])
  await page.getByRole('button', { name: 'Toggle traffic camera overlay' }).click()
  await expect(page.getByText('Empty means not configured, never zero cameras or clear roads.')).toBeVisible()
  await expect.poll(() => cameraRequests.length).toBe(1)
  const cameraState = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getLayoutProperty(id: string, property: string): unknown
        getSource(id: string): { serialize(): { data?: { features?: unknown[] } } } | undefined
      }
    }).__resilienceMap!
    return {
      featureCount: map.getSource('official-traffic-cameras')?.serialize().data?.features?.length,
      points: map.getLayoutProperty('official-traffic-camera-points', 'visibility'),
      clusters: map.getLayoutProperty('official-traffic-camera-clusters', 'visibility'),
    }
  })
  expect(cameraState).toEqual({ featureCount: 0, points: 'visible', clusters: 'visible' })

  await page.getByRole('button', { name: 'Use official 3D buildings and terrain' }).click()
  await expect.poll(() => threeDimensionalRequests.length).toBe(2)
  await expect(page.locator('.map-source-status.ready')).toContainText(
    'PDOK terrain + buildings · annual source data',
  )
  const perspectiveState = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getZoom(): number
        getPitch(): number
        getLayer(id: string): unknown
        getLayoutProperty(id: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      terrain: Boolean(map.getLayer('official-pdok-3d-terrain')),
      buildings: Boolean(map.getLayer('official-pdok-3d-buildings')),
      impact: map.getLayoutProperty('affected-region-overlay-outline', 'visibility'),
    }
  })
  expect(perspectiveState.zoom).toBeGreaterThanOrEqual(12.5)
  expect(perspectiveState.pitch).toBeGreaterThanOrEqual(38)
  expect(perspectiveState).toMatchObject({ terrain: true, buildings: true, impact: 'visible' })
  expect(threeDimensionalRequests.some((url) => url.includes('/gebouwen/'))).toBe(true)
  expect(threeDimensionalRequests.some((url) => url.includes('/terreinen/'))).toBe(true)

  diagnostics.assertClean()
})
