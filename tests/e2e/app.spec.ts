import { expect, test, type Page } from '@playwright/test'
import { appPath } from './support'

// Each page owns a live WebGL map and simulation model. Serializing this file
// avoids browser/CPU starvation while the V3 acceptance file runs beside it.
test.describe.configure({ mode: 'serial' })

function captureErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  return errors
}

test('loads the production map, layers, provenance, and complete timeline', async ({ page }) => {
  const errors = captureErrors(page)
  const workerResponses: Array<{ status: number; contentType: string }> = []
  page.on('response', async (response) => {
    if (response.url().includes('maplibre-gl-worker')) {
      workerResponses.push({
        status: response.status(),
        contentType: response.headers()['content-type'] ?? '',
      })
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('heading', { level: 1, name: 'NL Resilience Lab' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Current simulation scale' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await expect(page.locator('.layer-button')).toHaveCount(11)
  await expect(page.locator('.map-fidelity-badge')).toContainText('Official geography, transport & public assets')
  await expect(page.getByText('Official geography', { exact: true })).toBeVisible()
  await expect(page.getByText('Official transport')).toBeVisible()
  await expect(page.getByText('Scenario operations')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Scenario assumptions and comparison controls' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Modeled people under pressure' })).toBeVisible()
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()

  const timeline = page.getByRole('slider', { name: /Simulation time/ })
  await expect(timeline).toHaveAttribute('max', '288')
  await timeline.fill('288')
  await expect(page.locator('.current-time strong')).toHaveText('T+72:00')
  await page.getByRole('button', { name: 'Reset timeline' }).click()
  await expect(page.locator('.current-time strong')).toHaveText('T+00:00')

  await expect.poll(() => workerResponses.length).toBeGreaterThan(0)
  expect(workerResponses.every((response) => response.status === 200)).toBe(true)
  expect(workerResponses.every((response) => /javascript/.test(response.contentType))).toBe(true)
  expect(errors).toEqual([])
})

test('adds daily CC0 BGT object geography only at street scale', async ({ page }) => {
  const errors = captureErrors(page)
  const bgtRequests: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  await page.route(
    'https://service.pdok.nl/kadaster/bgt/wmts/v1_0/**',
    async (route) => {
      bgtRequests.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
    },
  )

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(bgtRequests).toEqual([])

  await page.getByLabel('Open municipality').selectOption({ label: 'Amsterdam' })
  await expect(page.getByText('Official street-scale object geography · BGT', { exact: true })).toBeVisible()
  await expect(page.getByText(/reference geometry, not building occupancy, route passability/)).toBeVisible()
  expect(bgtRequests).toEqual([])

  const sourceContract = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): { serialize(): { tiles?: string[]; minzoom?: number; maxzoom?: number; attribution?: string } } | undefined
        getLayer(id: string): unknown
      }
    }).__resilienceMap!
    return {
      source: map.getSource('pdok-bgt-detail')?.serialize(),
      layerReady: Boolean(map.getLayer('pdok-bgt-detail')),
    }
  })
  expect(sourceContract.source?.minzoom).toBe(17)
  expect(sourceContract.source?.maxzoom).toBe(21)
  expect(sourceContract.source?.tiles?.[0]).toContain('/kadaster/bgt/wmts/v1_0/achtergrondvisualisatie/')
  expect(sourceContract.source?.attribution).toContain('daily · CC0 1.0')
  expect(sourceContract.layerReady).toBe(true)

  await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: { jumpTo(options: { zoom: number }): void }
    }).__resilienceMap!
    map.jumpTo({ zoom: 17 })
  })
  await expect.poll(() => bgtRequests.length).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('adds daily public-domain BAG buildings only to relevant street-scale maps', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Amsterdam' })
  const bagEvidence = page.getByText('Official building register · BAG', { exact: true })
  await expect(bagEvidence).toBeVisible()
  await expect(page.getByText(/Registered status, year and use-purpose attributes are reference context/)).toBeVisible()

  const bagContract = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): { serialize(): { tiles?: string[]; minzoom?: number; maxzoom?: number; attribution?: string } } | undefined
        getStyle(): { layers?: Array<{ id: string; source?: string; 'source-layer'?: string; filter?: unknown }> }
        getLayoutProperty(id: string, property: string): unknown
      }
    }).__resilienceMap!
    const fill = map.getStyle().layers?.find((layer) => layer.id === 'official-bag-building-fill')
    return {
      source: map.getSource('pdok-bag-buildings')?.serialize(),
      fill: fill ? { source: fill.source, sourceLayer: fill['source-layer'], filter: fill.filter } : null,
      fillVisibility: map.getLayoutProperty('official-bag-building-fill', 'visibility'),
      outlineVisibility: map.getLayoutProperty('official-bag-building-outline', 'visibility'),
    }
  })

  let contract = await bagContract()
  expect(contract.source?.minzoom).toBe(17)
  expect(contract.source?.maxzoom).toBe(17)
  expect(contract.source?.tiles?.[0]).toContain('/tiles/WebMercatorQuad/{z}/{y}/{x}?f=mvt')
  expect(contract.source?.attribution).toContain('daily · Public Domain Mark 1.0')
  expect(contract.fill?.source).toBe('pdok-bag-buildings')
  expect(contract.fill?.sourceLayer).toBe('pand')
  expect(JSON.stringify(contract.fill?.filter)).toContain('Pand in gebruik')
  expect(contract.fillVisibility).toBe('none')

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect.poll(async () => (await bagContract()).fillVisibility).toBe('visible')
  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  contract = await bagContract()
  expect(contract.fillVisibility).toBe('none')
  expect(contract.outlineVisibility).toBe('none')
  expect(errors).toEqual([])
})

test('defers scheduled transit assets until their map scale can use them', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  const transitRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/data/transit/')) transitRequests.push(request.url())
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(500)
  expect(transitRequests).toEqual([])

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect.poll(() => transitRequests.length).toBe(3)
  expect(transitRequests.some((url) => url.includes('transit-routes-bus.geojson'))).toBe(false)

  await page.getByLabel('Open municipality').selectOption({ label: 'Amsterdam' })
  await expect.poll(() =>
    transitRequests.some((url) => url.includes('transit-routes-bus.geojson')),
  ).toBe(true)
  expect(new Set(transitRequests).size).toBe(4)
  expect(errors).toEqual([])
})

test('loads the server-refreshed, time-bounded NDW road feed only for mobility and supply maps', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  const ndwRequests: string[] = []
  page.on('request', (request) => {
    if (
      request.url().includes('/api/ndw-road-situations') ||
      request.url().includes('ndw-road-situations.geojson.gz')
    ) ndwRequests.push(request.url())
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(ndwRequests).toEqual([])

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.getByText('Observed NDW road situations', { exact: true })).toBeVisible()
  await expect(page.getByText(/\d[\d,.]* real, unrestricted DATEX II records/)).toBeVisible()
  expect(ndwRequests).toHaveLength(1)

  const roadSituationState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-road-situations')),
      lineVisibility: map.getLayoutProperty('official-road-situation-lines', 'visibility'),
      pointVisibility: map.getLayoutProperty('official-road-situation-points', 'visibility'),
    }
  })
  await expect.poll(roadSituationState).toEqual({
    sourceReady: true,
    lineVisibility: 'visible',
    pointVisibility: 'visible',
  })

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Observed NDW road situations', { exact: true })).toHaveCount(0)
  expect(await roadSituationState()).toEqual({
    sourceReady: true,
    lineVisibility: 'none',
    pointVisibility: 'none',
  })

  await page.getByRole('button', { name: 'Emergency supply: Delivered / demand' }).click()
  await expect(page.getByText('Observed NDW road situations', { exact: true })).toBeVisible()
  expect(ndwRequests).toHaveLength(1)
  expect(errors).toEqual([])
})

test('loads and identifies authoritative public water assets only on water maps', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  const waterRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('water-assets.geojson.gz')) waterRequests.push(request.url())
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(waterRequests).toEqual([])

  await page.getByRole('button', { name: 'Drinking water: Service availability' }).click()
  await expect(page.getByText('Official water assets', { exact: true })).toBeVisible()
  await expect(page.getByText(/63[,.]545 IMWA\/DAMO register objects not explicitly withdrawn/)).toBeVisible()
  await expect(page.getByText(/22 records marked “niet meer aanwezig”.*excluded from the map/)).toBeVisible()
  expect(waterRequests).toHaveLength(1)

  await page.getByLabel('Open municipality').selectOption({ label: 'Geertruidenberg' })
  await expect(page.getByText(/42 objects are assigned to Geertruidenberg by full-resolution CBS 2025 polygon containment/)).toBeVisible()
  expect(waterRequests).toHaveLength(1)

  const mapState = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getLayoutProperty(layer: string, property: string): unknown
        getSource(id: string): { serialize(): { data?: { features?: Array<{ properties?: { status?: string } }> } } } | undefined
      }
    }).__resilienceMap!
    const displayedFeatures = map.getSource('official-water-assets')?.serialize().data?.features ?? []
    return {
      visibility: map.getLayoutProperty('official-water-asset-points', 'visibility'),
      sourceReady: Boolean(map.getSource('official-water-assets')),
      displayedFeatureCount: displayedFeatures.length,
      withdrawnInDefaultSource: displayedFeatures.some(
        (feature) => feature.properties?.status?.toLocaleLowerCase() === 'niet meer aanwezig',
      ),
      damoVisibility: map.getLayoutProperty('official-wastewater-damo-lines', 'visibility'),
      gwswVisibility: map.getLayoutProperty('official-wastewater-gwsw-lines', 'visibility'),
      managementVisibility: map.getLayoutProperty('official-water-management-areas', 'visibility'),
      damoSourceReady: Boolean(map.getSource('official-wastewater-damo-lines')),
      gwswSourceReady: Boolean(map.getSource('official-wastewater-gwsw-lines')),
      managementSourceReady: Boolean(map.getSource('official-water-management-areas')),
    }
  })
  expect(mapState.visibility).toBe('visible')
  expect(mapState.displayedFeatureCount).toBe(63_545)
  expect(mapState.withdrawnInDefaultSource).toBe(false)
  expect(mapState.damoVisibility).not.toBe('none')
  expect(mapState.gwswVisibility).not.toBe('none')
  expect(mapState.managementVisibility).not.toBe('none')
  expect(mapState.sourceReady).toBe(true)
  expect(mapState.damoSourceReady).toBe(true)
  expect(mapState.gwswSourceReady).toBe(true)
  expect(mapState.managementSourceReady).toBe(true)
  await expect(page.getByText('Official wastewater geometry', { exact: true })).toBeVisible()
  await expect(page.getByText('Official water-management areas', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Official water assets', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: { getLayoutProperty(layer: string, property: string): unknown }
    }).__resilienceMap!
    return [
      map.getLayoutProperty('official-water-asset-points', 'visibility'),
      map.getLayoutProperty('official-wastewater-damo-lines', 'visibility'),
      map.getLayoutProperty('official-wastewater-gwsw-lines', 'visibility'),
      map.getLayoutProperty('official-water-management-areas', 'visibility'),
    ]
  })).toEqual(['none', 'none', 'none', 'none'])
  expect(errors).toEqual([])
})

test('shows BRO groundwater registrations at city scale without presenting them as live levels', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  const groundwaterRequests: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  await page.route(
    'https://service.pdok.nl/tno/bro-grondwatermonitoring-in-samenhang-karakteristieken/wms/v1_0**',
    async (route) => {
      groundwaterRequests.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
    },
  )

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  const groundwaterState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-bro-groundwater-monitoring')),
      visibility: map.getLayer('official-bro-groundwater-monitoring')
        ? map.getLayoutProperty('official-bro-groundwater-monitoring', 'visibility')
        : 'not-ready',
    }
  })
  await expect.poll(groundwaterState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(groundwaterRequests).toEqual([])

  await page.getByLabel('Open municipality').selectOption({ label: 'Breda' })
  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  const groundwaterEvidence = page.getByText(
    'Official BRO groundwater-monitoring registrations',
    { exact: true },
  )
  await expect(groundwaterEvidence).toBeVisible()
  await expect(page.getByText(/legal-register summary, not the full registered contents/)).toBeVisible()
  await expect(page.getByText(/does not provide a current level, continuous groundwater surface.*forecast.*causal simulation input/)).toBeVisible()
  await expect(page.getByText(/Missing geometry is no-data, never proof of dry or safe conditions/)).toBeVisible()
  await expect.poll(groundwaterState).toEqual({ sourceReady: true, visibility: 'visible' })
  await expect.poll(() => groundwaterRequests.length).toBeGreaterThan(0)
  expect(groundwaterRequests.every((url) => {
    const parameters = new URL(url).searchParams
    return parameters.get('layers') === 'gm_gmw,gm_gld' &&
      parameters.get('crs') === 'EPSG:3857'
  })).toBe(true)

  await page.getByRole('button', { name: 'Telecom & messaging: Reachable capacity' }).click()
  await expect(groundwaterEvidence).toHaveCount(0)
  await expect.poll(groundwaterState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(errors).toEqual([])
})

test('loads timestamped RWS Waterinfo station observations only on water and flood maps', async ({ page }) => {
  const errors = captureErrors(page)
  const waterinfoRequests: string[] = []
  const remoteWaterinfoRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('rws-waterinfo-observations.geojson.gz')) {
      waterinfoRequests.push(request.url())
    }
    if (request.url().startsWith('https://waterinfo.rws.nl/api/')) {
      remoteWaterinfoRequests.push(request.url())
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(waterinfoRequests).toEqual([])

  await page.getByRole('button', { name: 'Drinking water: Service availability' }).click()
  await expect(page.getByText('Observed water levels and discharge · RWS Waterinfo', { exact: true })).toBeVisible()
  await expect(page.getByText(/310 latest water-level and 65 latest discharge station observations/)).toBeVisible()
  await expect(page.getByText(/8 stale.*8 publisher-flagged possibly faulty/)).toBeVisible()
  await expect(page.getByText(/No municipal station means no data, never zero or safe/)).toBeVisible()
  expect(waterinfoRequests).toHaveLength(1)

  const waterinfoState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    const visibility = (id: string) => map.getLayer(id)
      ? map.getLayoutProperty(id, 'visibility')
      : 'missing'
    return {
      sourceReady: Boolean(map.getSource('official-waterinfo-observations')),
      levels: visibility('official-waterinfo-water-levels'),
      levelWarnings: visibility('official-waterinfo-level-warnings'),
      discharges: visibility('official-waterinfo-discharges'),
      dischargeWarnings: visibility('official-waterinfo-discharge-warnings'),
    }
  })
  await expect.poll(waterinfoState).toEqual({
    sourceReady: true,
    levels: 'visible',
    levelWarnings: 'visible',
    discharges: 'visible',
    dischargeWarnings: 'visible',
  })

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Observed water levels and discharge · RWS Waterinfo', { exact: true })).toHaveCount(0)
  await expect.poll(waterinfoState).toEqual({
    sourceReady: true,
    levels: 'none',
    levelWarnings: 'none',
    discharges: 'none',
    dischargeWarnings: 'none',
  })

  await page.getByLabel('Disaster').selectOption('river-flood')
  await expect(page.getByText('Observed water levels and discharge · RWS Waterinfo', { exact: true })).toBeVisible()
  await expect.poll(waterinfoState).toMatchObject({ levels: 'visible', discharges: 'visible' })

  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await expect.poll(waterinfoState).toMatchObject({ levels: 'visible', discharges: 'none' })

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.getByText('Observed water levels and discharge · RWS Waterinfo', { exact: true })).toHaveCount(0)
  await expect.poll(waterinfoState).toMatchObject({ levels: 'none', discharges: 'none' })
  expect(waterinfoRequests).toHaveLength(1)
  expect(remoteWaterinfoRequests).toEqual([])
  expect(errors).toEqual([])
})

test('steps through issued RWS Waterinfo forecast checkpoints without turning NoData into zero', async ({ page }) => {
  const errors = captureErrors(page)
  const forecastRequests: string[] = []
  const remoteWaterinfoRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('rws-waterinfo-forecasts.geojson.gz')) {
      forecastRequests.push(request.url())
    }
    if (request.url().startsWith('https://waterinfo.rws.nl/api/')) {
      remoteWaterinfoRequests.push(request.url())
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(forecastRequests).toEqual([])

  await page.getByRole('button', { name: 'Drinking water: Service availability' }).click()
  const forecastEvidence = page.getByText(
    'Issued water-level and discharge guidance · RWS Waterinfo',
    { exact: true },
  )
  await expect(forecastEvidence).toBeVisible()
  await expect(page.getByText(/nearest cached rolling context is the requested \+1h checkpoint/)).toBeVisible()
  await expect(page.getByText(/no single model-cycle issue time, so issue time remains Unknown/)).toBeVisible()
  await expect(page.getByText(/does not affect the simulation.*Missing local coverage is NoData, never zero or safe/)).toBeVisible()
  await expect(page.locator('.map-utility-badge')).toContainText(
    'Issued Waterinfo +1h · 145 level · 11 discharge points · context, not exercise forcing',
  )
  expect(forecastRequests).toHaveLength(1)

  const forecastState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): { serialize(): { data?: { features?: unknown[] } } } | undefined
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    const sourceCount = (id: string) =>
      map.getSource(id)?.serialize().data?.features?.length ?? -1
    const visibility = (id: string) => map.getLayer(id)
      ? map.getLayoutProperty(id, 'visibility')
      : 'missing'
    return {
      waterLevels: sourceCount('official-waterinfo-forecast-water-levels'),
      discharges: sourceCount('official-waterinfo-forecast-discharges'),
      waterLevelVisibility: visibility('official-waterinfo-forecast-water-levels'),
      dischargeVisibility: visibility('official-waterinfo-forecast-discharges'),
    }
  })
  await expect.poll(forecastState).toEqual({
    waterLevels: 145,
    discharges: 11,
    waterLevelVisibility: 'visible',
    dischargeVisibility: 'visible',
  })

  await page.getByRole('slider', { name: /Simulation time/ }).fill('192')
  await expect(page.locator('.current-time strong')).toHaveText('T+48:00')
  await expect(page.getByText(/requested \+48h checkpoint: 52 water-level and 0 discharge point forecasts/)).toBeVisible()
  await expect(page.getByText(/no discharge point coverage at this \+48h horizon.*NoData\/Unknown/)).toBeVisible()
  await expect(page.locator('.map-utility-badge')).toContainText(
    'Issued Waterinfo +48h · 52 level · 0 discharge points · context, not exercise forcing',
  )
  await expect.poll(forecastState).toMatchObject({ waterLevels: 52, discharges: 0 })

  await page.getByRole('slider', { name: /Simulation time/ }).fill('288')
  await expect(page.locator('.current-time strong')).toHaveText('T+72:00')
  await expect(page.getByText(/source returned no point coverage at this \+72h horizon/)).toBeVisible()
  await expect(page.getByText(/NoData\/Unknown, never zero water, zero discharge or safe/)).toBeVisible()
  await expect(page.locator('.map-utility-badge')).toContainText(
    'Issued Waterinfo +72h · no point coverage · NoData, not zero',
  )
  await expect.poll(forecastState).toMatchObject({ waterLevels: 0, discharges: 0 })

  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect.poll(forecastState).toMatchObject({
    waterLevelVisibility: 'visible',
    dischargeVisibility: 'none',
  })
  expect(forecastRequests).toHaveLength(1)
  expect(remoteWaterinfoRequests).toEqual([])
  expect(errors).toEqual([])
})

test('shows official ROR, defence and LIWO breach-selection context only for flood hazard maps', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Official flood-risk and defence context', { exact: true })).toBeVisible()
  await expect(page.getByText('Official LIWO candidate breach locations', { exact: true })).toBeVisible()
  await expect(page.getByText(/2018 report \/ ROR second cycle 2016–2021 \(no planned refresh\)/)).toBeVisible()

  const floodContextState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      riskSource: Boolean(map.getSource('official-flood-risk-areas')),
      defenceSource: Boolean(map.getSource('official-water-defences')),
      liwoSource: Boolean(map.getSource('official-liwo-breach-locations')),
      riskVisibility: map.getLayoutProperty('official-flood-risk-areas', 'visibility'),
      defenceVisibility: map.getLayoutProperty('official-water-defences', 'visibility'),
      liwoVisibility: map.getLayoutProperty('official-liwo-breach-locations', 'visibility'),
    }
  })
  await expect.poll(floodContextState).toEqual({
    riskSource: true,
    defenceSource: true,
    liwoSource: true,
    riskVisibility: 'visible',
    defenceVisibility: 'visible',
    liwoVisibility: 'visible',
  })

  await page.getByLabel('Disaster').selectOption('severe-storm')
  await expect(page.getByText('Official flood-risk and defence context', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Official LIWO candidate breach locations', { exact: true })).toHaveCount(0)
  expect(await floodContextState()).toEqual({
    riskSource: true,
    defenceSource: true,
    liwoSource: true,
    riskVisibility: 'none',
    defenceVisibility: 'none',
    liwoVisibility: 'none',
  })
  expect(errors).toEqual([])
})

test('shows the official RWS 70 mm cloudburst depth raster only for pluvial scenarios', async ({ page }) => {
  const errors = captureErrors(page)
  const cloudburstRequests: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  await page.route(
    'https://geo.rijkswaterstaat.nl/services/ogc/gdr/klimaat_effect_atlas/ows**',
    async (route) => {
      cloudburstRequests.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
    },
  )

  await page.goto(appPath)
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const cloudburstState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-pluvial-depth-scenario')),
      visibility: map.getLayer('official-pluvial-depth-scenario')
        ? map.getLayoutProperty('official-pluvial-depth-scenario', 'visibility')
        : 'not-ready',
    }
  })
  await expect.poll(cloudburstState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(cloudburstRequests).toEqual([])

  await page.getByLabel('Disaster').selectOption('pluvial-flood')
  await expect(page.getByText('Official cloudburst depth scenario · Rijkswaterstaat', { exact: true })).toBeVisible()
  await expect(page.getByText(/70 mm rainfall in two hours.*catalogue updated 5 August 2026.*CC0/)).toBeVisible()
  await expect(page.getByText(/not a current observation, forecast, selected incident, local municipal stress test or T\+72 prediction/)).toBeVisible()
  await expect(page.getByText(/missing coverage remains Unknown, never dry or safe/)).toBeVisible()
  await expect.poll(cloudburstState).toEqual({ sourceReady: true, visibility: 'visible' })
  await expect.poll(() => cloudburstRequests.length).toBeGreaterThan(0)
  expect(cloudburstRequests.every((url) => {
    const parameters = new URL(url).searchParams
    return parameters.get('layers') === 'bij_70mm_per_2uur' &&
      parameters.get('crs') === 'EPSG:3857'
  })).toBe(true)

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.getByText('Official cloudburst depth scenario · Rijkswaterstaat', { exact: true })).toHaveCount(0)
  await expect.poll(cloudburstState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(errors).toEqual([])
})

test('shows official AHN4 ground elevation at city scale only for flood hazard context', async ({ page }) => {
  const errors = captureErrors(page)
  const terrainRequests: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  await page.route('https://service.pdok.nl/rws/ahn/wms/v1_0**', async (route) => {
    terrainRequests.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
  })

  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Breda' })
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const terrainState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-ahn-terrain')),
      visibility: map.getLayer('official-ahn-terrain')
        ? map.getLayoutProperty('official-ahn-terrain', 'visibility')
        : 'not-ready',
    }
  })
  await expect.poll(terrainState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(terrainRequests).toEqual([])

  await page.getByLabel('Disaster').selectOption('river-flood')
  await expect(page.getByText('Official terrain elevation · AHN4 DTM', { exact: true })).toBeVisible()
  await expect(page.getByText(/0\.5 m ground-elevation raster at city scale.*laser acquisition 2020–2022/)).toBeVisible()
  await expect(page.getByText(/not current water level, water depth, hydraulic connectivity, flow direction, road passability or event state/)).toBeVisible()
  await expect(page.getByText(/Missing terrain coverage remains Unknown/)).toBeVisible()
  await expect.poll(terrainState).toEqual({ sourceReady: true, visibility: 'visible' })
  await expect.poll(() => terrainRequests.length).toBeGreaterThan(0)
  expect(terrainRequests.every((url) => {
    const parameters = new URL(url).searchParams
    return parameters.get('layers') === 'dtm_05m' &&
      parameters.get('crs') === 'EPSG:3857'
  })).toBe(true)

  await page.getByLabel('Disaster').selectOption('heatwave')
  await expect(page.getByText('Official terrain elevation · AHN4 DTM', { exact: true })).toHaveCount(0)
  await expect.poll(terrainState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(errors).toEqual([])
})

test('shows REV external-safety context only on its relevant maps and keeps it non-causal', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  const revLayers: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  await page.route('https://rev-portaal.nl/geoserver/wms**', async (route) => {
    revLayers.push(new URL(route.request().url()).searchParams.get('layers') ?? '')
    await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
  })
  await page.route('https://public.geodata.mijnaansluiting.nl/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('request')?.toLowerCase() === 'getfeatureinfo') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  expect(revLayers).toEqual([])

  const state = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    const visibility = (id: string) => map.getLayer(id)
      ? map.getLayoutProperty(id, 'visibility')
      : null
    return {
      activitiesSource: Boolean(map.getSource('official-rev-risk-activities')),
      activities: visibility('official-rev-risk-activities'),
      attention: visibility('official-rev-attention-areas'),
      pipelines: visibility('official-rev-pipelines'),
      basisnet: visibility('official-rev-basisnet'),
    }
  })

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Official regulated external-safety context · REV', { exact: true })).toBeVisible()
  await expect(page.getByText(/not a current release, damage report, plume footprint, probability or scenario impact/)).toBeVisible()
  await expect.poll(state).toEqual({
    activitiesSource: true,
    activities: 'visible',
    attention: 'visible',
    pipelines: 'none',
    basisnet: 'none',
  })
  await expect.poll(() => [...new Set(revLayers)]).toEqual(expect.arrayContaining([
    'rev_public:qs_ev_activiteiten',
    'rev_public:qs_aandachtsgebieden',
  ]))

  await page.getByRole('button', { name: 'Gas & heating: Service availability' }).click()
  await expect(page.getByText('Official hazardous-substance pipeline context · REV', { exact: true })).toBeVisible()
  await expect.poll(state).toEqual({
    activitiesSource: true,
    activities: 'none',
    attention: 'none',
    pipelines: 'visible',
    basisnet: 'none',
  })
  await expect.poll(() => revLayers).toContain('rev_public:bl_buisleidingreferentie')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.getByText('Official hazardous-goods route context · REV Basisnet', { exact: true })).toBeVisible()
  await expect.poll(state).toEqual({
    activitiesSource: true,
    activities: 'none',
    attention: 'none',
    pipelines: 'none',
    basisnet: 'visible',
  })
  await expect.poll(() => revLayers).toContain('rev_public:bn_locatie_activiteiten')
  expect(errors).toEqual([])
})

test('switches from cached KNMI radar to bounded T+1/T+3/T+6 precipitation probabilities', async ({ page }) => {
  const errors = captureErrors(page)
  const radarMetadataRequests: string[] = []
  const probabilityMetadataRequests: string[] = []
  const remoteKnmiRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('knmi-radar.json')) radarMetadataRequests.push(request.url())
    if (request.url().includes('knmi-precipitation-probability.json')) {
      probabilityMetadataRequests.push(request.url())
    }
    if (request.url().includes('anonymous.api.dataplatform.knmi.nl')) {
      remoteKnmiRequests.push(request.url())
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(radarMetadataRequests).toEqual([])
  expect(probabilityMetadataRequests).toEqual([])

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Observed KNMI precipitation radar', { exact: true })).toBeVisible()
  await expect(page.getByText(/5-minute cadence, locally cached/)).toBeVisible()
  expect(radarMetadataRequests).toHaveLength(1)
  expect(probabilityMetadataRequests).toHaveLength(1)

  const radarState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-knmi-radar')),
      visibility: map.getLayoutProperty('official-knmi-radar-observation', 'visibility'),
      probabilitySources: [1, 3, 6].map((lead) =>
        Boolean(map.getSource(`official-knmi-precipitation-probability-t-plus-${lead}`)),
      ),
      probabilityVisibility: [1, 3, 6].map((lead) =>
        map.getLayoutProperty(
          `official-knmi-precipitation-probability-t-plus-${lead}`,
          'visibility',
        ),
      ),
    }
  })
  await expect.poll(radarState).toEqual({
    sourceReady: true,
    visibility: 'visible',
    probabilitySources: [true, true, true],
    probabilityVisibility: ['none', 'none', 'none'],
  })

  const timeline = page.getByRole('slider', { name: /Simulation time/ })
  await timeline.fill('4')
  await expect(page.locator('.current-time strong')).toHaveText('T+01:00')
  await expect(page.getByText('Issued KNMI precipitation probability · T+1', { exact: true })).toBeVisible()
  await expect(page.getByText(/probability of precipitation intensity exceeding 3 mm\/h/)).toBeVisible()
  await expect(page.getByText(/transparent pixels remain NoData/)).toBeVisible()
  await expect.poll(radarState).toEqual({
    sourceReady: true,
    visibility: 'none',
    probabilitySources: [true, true, true],
    probabilityVisibility: ['visible', 'none', 'none'],
  })

  await timeline.fill('48')
  await expect(page.locator('.current-time strong')).toHaveText('T+12:00')
  await expect(page.getByText('KNMI precipitation-probability coverage ends at T+6', { exact: true })).toBeVisible()
  await expect(page.getByText(/missing later horizon is NoData\/Unknown, not zero rain/)).toBeVisible()
  await expect.poll(radarState).toEqual({
    sourceReady: true,
    visibility: 'none',
    probabilitySources: [true, true, true],
    probabilityVisibility: ['none', 'none', 'none'],
  })

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.getByText('Observed KNMI precipitation radar', { exact: true })).toHaveCount(0)
  await expect(page.getByText('KNMI precipitation-probability coverage ends at T+6', { exact: true })).toHaveCount(0)
  await expect.poll(radarState).toEqual({
    sourceReady: true,
    visibility: 'none',
    probabilitySources: [true, true, true],
    probabilityVisibility: ['none', 'none', 'none'],
  })
  expect(remoteKnmiRequests).toEqual([])
  expect(errors).toEqual([])
})

test('loads sparse KNMI 10-minute station observations without turning them into municipal forcing', async ({ page }) => {
  const errors = captureErrors(page)
  const observationRequests: string[] = []
  const remoteKnmiRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('knmi-weather-observations.geojson.gz')) {
      observationRequests.push(request.url())
    }
    if (request.url().startsWith('https://api.dataplatform.knmi.nl/')) {
      remoteKnmiRequests.push(request.url())
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(observationRequests).toEqual([])

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Observed KNMI 10-minute weather stations', { exact: true })).toBeVisible()
  await expect(page.getByText(/55 European-Netherlands and offshore stations/)).toBeVisible()
  await expect(page.getByText(/A nearest fixed station is not a municipal value or continuous field/)).toBeVisible()
  await expect(page.getByText(/observations do not affect the simulation/)).toBeVisible()
  expect(observationRequests).toHaveLength(1)

  const observationState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): { serialize(): { data?: { features?: unknown[] } } } | undefined
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      features: map.getSource('official-knmi-weather-observations')?.serialize().data?.features?.length,
      wind: map.getLayoutProperty('official-knmi-weather-wind-points', 'visibility'),
      rain: map.getLayoutProperty('official-knmi-weather-rain-points', 'visibility'),
      temperature: map.getLayoutProperty('official-knmi-weather-temperature-points', 'visibility'),
    }
  })
  await expect.poll(observationState).toEqual({
    features: 55,
    wind: 'visible',
    rain: 'none',
    temperature: 'none',
  })

  await page.getByLabel('Disaster').selectOption('pluvial-flood')
  await expect.poll(observationState).toEqual({
    features: 55,
    wind: 'none',
    rain: 'visible',
    temperature: 'none',
  })

  await page.getByLabel('Disaster').selectOption('heatwave')
  await expect.poll(observationState).toEqual({
    features: 55,
    wind: 'none',
    rain: 'none',
    temperature: 'visible',
  })

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.getByText('Observed KNMI 10-minute weather stations', { exact: true })).toHaveCount(0)
  await expect.poll(observationState).toEqual({
    features: 55,
    wind: 'none',
    rain: 'none',
    temperature: 'none',
  })
  expect(observationRequests).toHaveLength(1)
  expect(remoteKnmiRequests).toEqual([])
  expect(errors).toEqual([])
})

test('loads issued KNMI 48-hour province warnings as non-causal hazard context', async ({ page }) => {
  const errors = captureErrors(page)
  const warningRequests: string[] = []
  const remoteKnmiRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('knmi-weather-warnings.geojson.gz')) {
      warningRequests.push(request.url())
    }
    if (request.url().startsWith('https://api.dataplatform.knmi.nl/')) {
      remoteKnmiRequests.push(request.url())
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(warningRequests).toEqual([])

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Issued KNMI 48-hour warning · Noord-Brabant', { exact: true })).toBeVisible()
  await expect(page.getByText(/No warning is issued for this province in the cached product/)).toBeVisible()
  await expect(page.getByText(/accepted only because KNMI’s official national page explicitly reported no warnings/)).toBeVisible()
  await expect(page.getByText(/not gridded weather, local occurrence, impact, an all-clear, or a scenario-clock input/)).toBeVisible()
  expect(warningRequests).toHaveLength(1)

  const warningState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-knmi-weather-warnings')),
      fill: map.getLayoutProperty('official-knmi-warning-fill', 'visibility'),
      outline: map.getLayoutProperty('official-knmi-warning-outline', 'visibility'),
    }
  })
  await expect.poll(warningState).toEqual({
    sourceReady: true,
    fill: 'visible',
    outline: 'visible',
  })

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.getByText('Issued KNMI 48-hour warning · Noord-Brabant', { exact: true })).toHaveCount(0)
  await expect.poll(warningState).toEqual({
    sourceReady: true,
    fill: 'none',
    outline: 'none',
  })
  expect(warningRequests).toHaveLength(1)
  expect(remoteKnmiRequests).toEqual([])
  expect(errors).toEqual([])
})

test('loads indicative RIVM air-quality stations only for wildfire smoke context', async ({ page }) => {
  const errors = captureErrors(page)
  const airQualityRequests: string[] = []
  const remoteRivmRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('rivm-air-quality-pm25.geojson.gz')) {
      airQualityRequests.push(request.url())
    }
    if (request.url().startsWith('https://api.luchtmeetnet.nl/')) {
      remoteRivmRequests.push(request.url())
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(airQualityRequests).toEqual([])

  await page.getByLabel('Disaster').selectOption('wildfire')
  await page.waitForTimeout(150)
  expect(airQualityRequests).toEqual([])

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Observed air quality · RIVM Luchtmeetnet', { exact: true })).toBeVisible()
  await expect(page.getByText(/72 indicative PM2\.5 station readings/)).toBeVisible()
  await expect(page.getByText(/not a continuous national surface, population exposure, source attribution, smoke plume, forecast or scenario-clock input/)).toBeVisible()
  await expect(page.getByText(/zero municipal station count means no mapped reporting station.*not zero pollution/)).toBeVisible()
  expect(airQualityRequests).toHaveLength(1)

  const airQualityState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    const visibility = (id: string) => map.getLayer(id)
      ? map.getLayoutProperty(id, 'visibility')
      : 'missing'
    return {
      sourceReady: Boolean(map.getSource('official-air-quality')),
      halos: visibility('official-air-quality-halos'),
      points: visibility('official-air-quality-points'),
      labels: visibility('official-air-quality-labels'),
    }
  })
  await expect.poll(airQualityState).toEqual({
    sourceReady: true,
    halos: 'visible',
    points: 'visible',
    labels: 'visible',
  })

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.getByText('Observed air quality · RIVM Luchtmeetnet', { exact: true })).toHaveCount(0)
  await expect.poll(airQualityState).toEqual({
    sourceReady: true,
    halos: 'none',
    points: 'none',
    labels: 'none',
  })
  expect(airQualityRequests).toHaveLength(1)
  expect(remoteRivmRequests).toEqual([])
  expect(errors).toEqual([])
})

test('loads observed KNMI seismic events only for earthquake hazard context', async ({ page }) => {
  const errors = captureErrors(page)
  const seismicEventRequests: string[] = []
  const remoteKnmiRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('knmi-seismic-events.geojson.gz')) {
      seismicEventRequests.push(request.url())
    }
    if (request.url().startsWith('https://rdsa.knmi.nl/')) {
      remoteKnmiRequests.push(request.url())
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(seismicEventRequests).toEqual([])

  await page.getByLabel('Disaster').selectOption('earthquake')
  await page.waitForTimeout(150)
  expect(seismicEventRequests).toEqual([])

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(page.getByText('Observed seismic-event catalogue · KNMI FDSN', { exact: true })).toBeVisible()
  await expect(page.getByText(/63 earthquake or induced-event source points/)).toBeVisible()
  await expect(page.getByText(/Controlled explosions, quarry blasts and sonic booms are excluded/)).toBeVisible()
  await expect(page.getByText(/not ground motion, felt intensity, building damage, probability, forecast or scenario-clock input; they do not affect the simulation/)).toBeVisible()
  await expect(page.getByText(/No assigned event means no catalogue point in this window, never zero seismic hazard or proof of safety/)).toBeVisible()
  expect(seismicEventRequests).toHaveLength(1)

  const seismicEventState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    const visibility = (id: string) => map.getLayer(id)
      ? map.getLayoutProperty(id, 'visibility')
      : 'missing'
    return {
      sourceReady: Boolean(map.getSource('official-knmi-seismic-events')),
      halos: visibility('official-knmi-seismic-event-halos'),
      points: visibility('official-knmi-seismic-event-points'),
      labels: visibility('official-knmi-seismic-event-labels'),
    }
  })
  await expect.poll(seismicEventState).toEqual({
    sourceReady: true,
    halos: 'visible',
    points: 'visible',
    labels: 'visible',
  })

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.getByText('Observed seismic-event catalogue · KNMI FDSN', { exact: true })).toHaveCount(0)
  await expect.poll(seismicEventState).toEqual({
    sourceReady: true,
    halos: 'none',
    points: 'none',
    labels: 'none',
  })
  expect(seismicEventRequests).toHaveLength(1)
  expect(remoteKnmiRequests).toEqual([])
  expect(errors).toEqual([])
})

test('shows IPO combustible nature-area context only for wildfire scenarios', async ({ page }) => {
  const errors = captureErrors(page)
  const natureAreaRequests: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  await page.route('https://servicespub.risicokaart.nl/geoserver/ISOR_RK/wms**', async (route) => {
    natureAreaRequests.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
  })

  await page.goto(appPath)
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const natureAreaState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-combustible-nature-areas')),
      visibility: map.getLayer('official-combustible-nature-areas')
        ? map.getLayoutProperty('official-combustible-nature-areas', 'visibility')
        : 'not-ready',
    }
  })
  await expect.poll(natureAreaState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(natureAreaRequests).toEqual([])

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.getByText('Official combustible nature areas · IPO Risicokaart', { exact: true })).toBeVisible()
  await expect(page.getByText(/forest, heath and dune polygons.*metadata updated 19 February 2026.*Public Domain/)).toBeVisible()
  await expect(page.getByText(/not a current ignition, fuel or moisture state, incident perimeter, spread\/smoke forecast, evacuation area or response status/)).toBeVisible()
  await expect(page.getByText(/Missing geometry remains Unknown, never proof that an area cannot burn or is safe/)).toBeVisible()
  await expect.poll(natureAreaState).toEqual({ sourceReady: true, visibility: 'visible' })
  await expect.poll(() => natureAreaRequests.length).toBeGreaterThan(0)
  expect(natureAreaRequests.every((url) => {
    const parameters = new URL(url).searchParams
    return parameters.get('layers') === 'isor_brandbaar_natuurgebied' &&
      parameters.get('styles') === 'Natuurbrandvlak'
  })).toBe(true)

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.getByText('Official combustible nature areas · IPO Risicokaart', { exact: true })).toHaveCount(0)
  await expect.poll(natureAreaState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(errors).toEqual([])
})

test('shows annual RVO crop parcels only as non-causal drought, fire and supply context', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  const agriculturalParcelRequests: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  await page.route(
    'https://service.pdok.nl/rvo/gewaspercelen/wms/v1_0**',
    async (route) => {
      agriculturalParcelRequests.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
    },
  )

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  const agriculturalParcelState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-agricultural-parcels')),
      visibility: map.getLayer('official-agricultural-parcels')
        ? map.getLayoutProperty('official-agricultural-parcels', 'visibility')
        : 'not-ready',
    }
  })
  await expect.poll(agriculturalParcelState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(agriculturalParcelRequests).toEqual([])

  await page.getByLabel('Open municipality').selectOption({ label: 'Breda' })
  await page.getByLabel('Disaster').selectOption('heatwave')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  const agriculturalEvidence = page.getByText(
    'Official agricultural parcel context · RVO BRP',
    { exact: true },
  )
  await expect(agriculturalEvidence).toBeVisible()
  await expect(page.getByText(/2025 definitive Basisregistratie Gewaspercelen/)).toBeVisible()
  await expect(page.getByText(/annually for the 15 May reference date/)).toBeVisible()
  await expect(page.getByText(/Public Domain Mark 1\.0.*current WMS capabilities declare CC0/)).toBeVisible()
  await expect(page.getByText(/not current crop presence or condition, drought, ignition\/fuel state, harvest\/yield, food\/fodder stock/)).toBeVisible()
  await expect(page.getByText(/Missing\/transparent parcels mean no mapped declaration.*never no agriculture, food supply or risk/)).toBeVisible()
  await expect.poll(agriculturalParcelState).toEqual({ sourceReady: true, visibility: 'visible' })

  await page.evaluate(() => {
    const map = (window as Window & { __resilienceMap?: { setZoom(zoom: number): void } })
      .__resilienceMap!
    map.setZoom(13)
  })
  await expect.poll(() => agriculturalParcelRequests.length).toBeGreaterThan(0)
  expect(agriculturalParcelRequests.every((url) => {
    const parameters = new URL(url).searchParams
    return parameters.get('layers') === 'BrpGewas' &&
      parameters.get('styles') === 'Default' &&
      parameters.get('crs') === 'EPSG:3857'
  })).toBe(true)

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(agriculturalEvidence).toHaveCount(0)
  await expect.poll(agriculturalParcelState).toEqual({ sourceReady: true, visibility: 'none' })

  await page.getByRole('button', { name: 'Emergency supply: Delivered / demand' }).click()
  await expect(agriculturalEvidence).toBeVisible()
  await expect.poll(agriculturalParcelState).toEqual({ sourceReady: true, visibility: 'visible' })
  expect(errors).toEqual([])
})

test('shows RWS FIS waterways only as static mobility and supply context', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  const waterwayRequests: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  await page.route(
    'https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/fis_vnds/MapServer/export**',
    async (route) => {
      waterwayRequests.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
    },
  )

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  const waterwayState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-fis-waterways')),
      visibility: map.getLayer('official-fis-waterways')
        ? map.getLayoutProperty('official-fis-waterways', 'visibility')
        : 'not-ready',
    }
  })
  await expect.poll(waterwayState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(waterwayRequests).toEqual([])

  await page.getByLabel('Open municipality').selectOption({ label: 'De Fryske Marren' })
  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  const evidence = page.locator('.evidence-row').filter({
    hasText: 'Official inland-waterway geometry · RWS FIS-VNDS',
  })
  await expect(evidence).toBeVisible()
  await expect(evidence).toContainText(/fairway-line register plus city-scale bridge and lock points/)
  await expect(evidence).toContainText(/catalogue updated 15 April 2026.*CC0/)
  await expect(evidence).toContainText(/not current navigability, water depth, restriction, bridge\/lock operation/)
  await expect(evidence).toContainText(/“vaarwegstatus” codes classify route roles.*not open\/closed status/)
  await expect(evidence).toContainText(/Missing geometry or notices remain Unknown/)
  await expect.poll(waterwayState).toEqual({ sourceReady: true, visibility: 'visible' })
  await expect.poll(() => waterwayRequests.length).toBeGreaterThan(0)
  expect(waterwayRequests.every((url) => {
    const parameters = new URL(url).searchParams
    return parameters.get('layers') === 'show:55,3,19' &&
      parameters.get('bboxSR') === '3857' &&
      parameters.get('imageSR') === '3857' &&
      parameters.get('format') === 'png32' &&
      parameters.get('transparent') === 'true'
  })).toBe(true)

  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await expect(evidence).toHaveCount(0)
  await expect.poll(waterwayState).toEqual({ sourceReady: true, visibility: 'none' })
  expect(errors).toEqual([])
})

test('loads official Liander and Stedin utility context without treating it as telemetry', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  const lianderRequests: string[] = []
  const stedinRequests: string[] = []
  const nationalOverheadLineRequests: string[] = []
  const zuidHollandStationRequests: string[] = []
  const rasterFixturePath = new URL(
    '../../apps/web/public/data/public-context/knmi-radar.png',
    import.meta.url,
  ).pathname
  await page.route('https://services1.arcgis.com/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    lianderRequests.push(requestUrl.toString())
    if (requestUrl.searchParams.get('returnCountOnly') === 'true') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1 }),
      })
      return
    }
    const layer = requestUrl.pathname.match(/FeatureServer\/(\d+)\/query/)?.[1]
    const pointLayer = layer === '641' || layer === '642' || layer === '643'
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 1,
          geometry: pointLayer
            ? { type: 'Point', coordinates: [5.12, 52.09] }
            : { type: 'LineString', coordinates: [[5.1, 52.08], [5.14, 52.1]] },
          properties: {
            OBJECTID: 1,
            SPANNINGSNIVEAU: 50,
            DATUM_AANLEG: 1_577_836_800_000,
          },
        }],
        properties: { exceededTransferLimit: false },
      }),
    })
  })
  await page.route('https://services-eu1.arcgis.com/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    stedinRequests.push(requestUrl.toString())
    if (requestUrl.searchParams.get('returnCountOnly') === 'true') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1 }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 2,
          geometry: { type: 'LineString', coordinates: [[5.1, 52.08], [5.14, 52.1]] },
          properties: {
            OBJECTID: 2,
            Id: 'stedin-test',
            Naam: 'Stedin test geometry',
            Status: 'replacement context',
          },
        }],
        properties: { exceededTransferLimit: false },
      }),
    })
  })
  await page.route('https://geodata.zuid-holland.nl/geoserver/energie/wms**', async (route) => {
    zuidHollandStationRequests.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
  })
  await page.route('https://data.rivm.nl/geo/nl/wms**', async (route) => {
    nationalOverheadLineRequests.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'image/png', path: rasterFixturePath })
  })

  await page.goto(appPath)
  await page.waitForTimeout(250)
  expect(lianderRequests).toEqual([])
  expect(stedinRequests).toEqual([])

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.getByText('Official Liander + Stedin electricity geometry', { exact: true })).toBeVisible()
  await expect(page.getByText('Official national overhead high-voltage lines · RIVM', { exact: true })).toBeVisible()
  await expect(page.getByText(/source explicitly represents the November 2023 situation/)).toBeVisible()
  await expect(page.getByText('Official Zuid-Holland 2025 electricity-station atlas', { exact: true })).toBeVisible()
  await expect(page.getByText(/outside the province is out of scope rather than “no station”/)).toBeVisible()
  const outageGap = page.getByText('Operational feed gap · Energieonderbrekingen.nl', { exact: true }).locator('..')
  await expect(outageGap).toContainText('requires approved OAuth client credentials')
  await expect(outageGap).toContainText('Missing access is Unknown—not “no outage”')
  await expect(outageGap).toContainText('never an arbitrary T+72 exercise')
  await expect(page.locator('.map-utility-badge')).toContainText('3 Liander backbone assets')
  await expect.poll(() => lianderRequests.length).toBe(6)
  expect(stedinRequests).toEqual([])

  await expect.poll(() => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(source: string): unknown
      }
    }).__resilienceMap
    return Boolean(map?.getSource('official-power-backbone'))
  })).toBe(true)
  const powerVisibility = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: { getLayoutProperty(layer: string, property: string): unknown }
    }).__resilienceMap!
    return map.getLayoutProperty('official-power-high-underground', 'visibility')
  })
  expect(powerVisibility).not.toBe('none')
  const nationalOverheadLineState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(source: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-national-overhead-high-voltage-lines')),
      visibility: map.getLayoutProperty('official-national-overhead-high-voltage-lines', 'visibility'),
    }
  })
  await expect.poll(nationalOverheadLineState).toEqual({ sourceReady: true, visibility: 'visible' })
  const zuidHollandStationState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(source: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      sourceReady: Boolean(map.getSource('official-zuid-holland-electricity-stations')),
      visibility: map.getLayoutProperty('official-zuid-holland-electricity-stations', 'visibility'),
    }
  })
  await expect.poll(zuidHollandStationState).toEqual({ sourceReady: true, visibility: 'visible' })

  await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: { jumpTo(options: { center: [number, number]; zoom: number }): void }
    }).__resilienceMap!
    map.jumpTo({ center: [4.48, 51.92], zoom: 14 })
  })
  await expect.poll(() => stedinRequests.length).toBe(4)
  await expect(page.locator('.map-utility-badge')).toContainText('4 visible distribution records')
  await expect.poll(() => nationalOverheadLineRequests.length).toBeGreaterThan(0)
  expect(nationalOverheadLineRequests.every((request) => {
    const parameters = new URL(request).searchParams
    return parameters.get('layers') === 'netkaart_actuele_versie_atlas_rivm' &&
      parameters.get('crs') === 'EPSG:3857' &&
      parameters.get('format') === 'image/png' &&
      parameters.get('transparent') === 'true'
  })).toBe(true)
  await expect.poll(() => zuidHollandStationRequests.length).toBeGreaterThan(0)
  expect(zuidHollandStationRequests.every((request) => {
    const parameters = new URL(request).searchParams
    return parameters.get('layers') === [
      'energie:RV_ET_ELEKTRICITEITSSTATIONS_LIANDER_PZH_2025_PUNTLOCATIES',
      'energie:RV_ET_ELEKTRICITEITSSTATIONS_STEDIN_PZH_2025_PUNTLOCATIES',
    ].join(',') &&
      parameters.get('crs') === 'EPSG:3857' &&
      parameters.get('format') === 'image/png' &&
      parameters.get('transparent') === 'true'
  })).toBe(true)

  await page.getByRole('button', { name: 'Gas & heating: Service availability' }).click()
  await expect(page.getByText('Official Liander gas + Stedin replacement context', { exact: true })).toBeVisible()
  await expect(page.locator('.map-utility-badge')).toContainText('2 visible DSO gas-context records')
  await expect.poll(() => stedinRequests.length).toBe(6)
  const gasVisibility = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: { getLayoutProperty(layer: string, property: string): unknown }
    }).__resilienceMap!
    return {
      liander: map.getLayoutProperty('official-gas-pipes', 'visibility'),
      stedin: map.getLayoutProperty('official-gas-replacement-pipes', 'visibility'),
    }
  })
  expect(gasVisibility.liander).not.toBe('none')
  expect(gasVisibility.stedin).not.toBe('none')
  await expect.poll(nationalOverheadLineState).toEqual({ sourceReady: true, visibility: 'none' })
  await expect.poll(zuidHollandStationState).toEqual({ sourceReady: true, visibility: 'none' })
  await expect(page.getByText('Official national overhead high-voltage lines · RIVM', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Official Zuid-Holland 2025 electricity-station atlas', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/no pressure, flow, valve, capacity, outage or restoration inference/i)).toBeVisible()
  expect(errors).toEqual([])
})

test('keeps available DSO geometry visible when another public provider layer fails', async ({ page }) => {
  const errors = captureErrors(page)
  await page.route('https://services1.arcgis.com/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    if (requestUrl.searchParams.get('returnCountOnly') === 'true') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"count":1}' })
      return
    }
    const layer = requestUrl.pathname.match(/FeatureServer\/(\d+)\/query/)?.[1]
    const pointLayer = layer === '641' || layer === '642' || layer === '643'
    await route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 1,
          geometry: pointLayer
            ? { type: 'Point', coordinates: [5.12, 52.09] }
            : { type: 'LineString', coordinates: [[5.1, 52.08], [5.14, 52.1]] },
          properties: { OBJECTID: 1, SPANNINGSNIVEAU: 50 },
        }],
      }),
    })
  })
  await page.route('https://services-eu1.arcgis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'temporary provider outage' } }),
    })
  })

  await page.goto(appPath)
  await page.waitForTimeout(250)
  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.map-utility-badge')).toContainText('3 Liander backbone assets')
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: { jumpTo(options: { center: [number, number]; zoom: number }): void }
    }).__resilienceMap!
    map.jumpTo({ center: [5.12, 52.09], zoom: 14 })
  })

  await expect(page.locator('.map-utility-badge')).toContainText('2 visible distribution records')
  await expect(page.locator('.map-utility-badge')).toContainText(
    'partial response: Stedin Netbeheer layer unavailable',
  )
  await expect.poll(() => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(source: string): { serialize(): { data?: { features?: Array<{ properties?: { sourceId?: string } }> } } } | undefined
      }
    }).__resilienceMap!
    const features = map.getSource('official-power-detail')?.serialize().data?.features ?? []
    return features.map((feature) => feature.properties?.sourceId)
  })).toEqual(['liander-open-data', 'liander-open-data'])
  expect(errors).toEqual([])
})

test('loads nationwide NBNL capacity samples as non-causal electricity planning context', async ({ page }) => {
  const errors = captureErrors(page)
  const capacityRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('nbnl-capacity-samples.geojson.gz')) {
      capacityRequests.push(request.url())
    }
  })
  await page.route('https://services1.arcgis.com/**', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        url.searchParams.get('returnCountOnly') === 'true'
          ? { count: 0 }
          : { type: 'FeatureCollection', features: [] },
      ),
    })
  })

  await page.goto(appPath)
  await page.waitForTimeout(250)
  expect(capacityRequests).toEqual([])
  await page.getByLabel('Open municipality').selectOption({ label: 'Den Helder' })
  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()

  const evidence = page.getByText(
    'Official electricity-capacity sample · Netbeheer Nederland',
    { exact: true },
  ).locator('..')
  await expect(evidence).toBeVisible()
  await expect(evidence).toContainText('Liander')
  await expect(evidence).toContainText('44 MW present')
  await expect(evidence).toContainText(/11[,.]6 MW queued across 26 requests/)
  await expect(evidence).toContainText('339 of 342 municipalities sampled')
  await expect(evidence).toContainText('one point is not complete municipal coverage')
  await expect(evidence).toContainText('not outage telemetry, physical topology')
  expect(capacityRequests).toHaveLength(1)

  await expect.poll(() => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): { serialize(): { data?: { features?: unknown[] } } } | undefined
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      features: map.getSource('official-nbnl-capacity-samples')?.serialize().data?.features?.length,
      points: map.getLayoutProperty('official-nbnl-capacity-sample-points', 'visibility'),
      halos: map.getLayoutProperty('official-nbnl-capacity-sample-halos', 'visibility'),
    }
  })).toEqual({ features: 342, points: 'visible', halos: 'visible' })
  expect(errors).toEqual([])
})

test('loads hourly GTS transmission flows as non-additive observed Gas context', async ({ page }) => {
  const errors = captureErrors(page)
  const fixtureRequests: string[] = []
  const remoteEntsogRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('entsog-gts-physical-flow.json.gz')) {
      fixtureRequests.push(request.url())
    }
    if (request.url().startsWith('https://transparency.entsog.eu/')) {
      remoteEntsogRequests.push(request.url())
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(fixtureRequests).toEqual([])

  await page.getByRole('button', { name: 'Gas & heating: Service availability' }).click()
  const evidence = page.getByText('Observed GTS transmission flows · ENTSOG', { exact: true }).locator('..')
  await expect(evidence).toBeVisible()
  await expect(evidence).toContainText('70 public directional records across 48 point keys')
  await expect(evidence).toContainText('37 reported numeric zero and 20 missing/N/A')
  await expect(evidence).toContainText('All 70 records are labelled provisional')
  await expect(evidence).toContainText('Directions, virtual and aggregated points are non-additive')
  await expect(evidence).toContainText('not municipal distribution pressure, customer supply, outage state')
  await expect(evidence).toContainText('does not affect the simulation')
  expect(fixtureRequests).toHaveLength(1)

  await page.getByRole('button', { name: 'Telecom & messaging: Reachable capacity' }).click()
  await expect(evidence).toHaveCount(0)
  await page.getByRole('button', { name: 'Gas & heating: Service availability' }).click()
  await expect(evidence).toBeVisible()
  expect(fixtureRequests).toHaveLength(1)
  expect(remoteEntsogRequests).toEqual([])
  expect(errors).toEqual([])
})

test('maps national provider territories and identifies the selected municipality provider', async ({ page }) => {
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  const providerRequests: string[] = []
  await page.route('https://public.geodata.mijnaansluiting.nl/**', async (route) => {
    const url = new URL(route.request().url())
    providerRequests.push(url.toString())
    if (url.searchParams.get('request')?.toLowerCase() === 'getfeatureinfo') {
      const layer = url.searchParams.get('query_layers') ?? ''
      const provider = layer.includes('media')
        ? 'Ziggo'
        : layer.includes('water')
          ? 'Evides'
          : layer.includes('riolering')
            ? null
            : 'Stedin'
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: provider
            ? [{
                type: 'Feature',
                geometry: null,
                properties: {
                  netbeheerderCode: provider.toLowerCase(),
                  netbeheerderName: provider,
                  netbeheerderLabel: provider,
                  website: `https://www.${provider.toLowerCase()}.nl/`,
                  lastUpdated: '2026-07-22T06:32:57.586Z',
                },
              }]
            : [],
        }),
      })
      return
    }
    await route.continue()
  })
  await page.route('https://services1.arcgis.com/**', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        url.searchParams.get('returnCountOnly') === 'true'
          ? { count: 0 }
          : { type: 'FeatureCollection', features: [] },
      ),
    })
  })

  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Barendrecht' })
  await page.getByRole('button', { name: 'Gas & heating: Service availability' }).click()
  await expect(page.getByText('Public provider territory', { exact: true })).toBeVisible()
  await expect(page.getByText(/Stedin at the municipal reference point/)).toBeVisible()

  const readProviderVisibility = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getLayer(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      gasReady: Boolean(map.getLayer('official-provider-area-gas')),
      gasHidden: map.getLayer('official-provider-area-gas')
        ? map.getLayoutProperty('official-provider-area-gas', 'visibility') === 'none'
        : true,
      powerHidden: map.getLayer('official-provider-area-power')
        ? map.getLayoutProperty('official-provider-area-power', 'visibility') === 'none'
        : false,
    }
  })
  await expect.poll(readProviderVisibility).toEqual({
    gasReady: true,
    gasHidden: false,
    powerHidden: true,
  })

  await page.getByRole('button', { name: 'Telecom & messaging: Reachable capacity' }).click()
  await expect(page.getByText(/Ziggo at the municipal reference point/)).toBeVisible()
  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.getByText(/No provider polygon returned at the municipal reference point/)).toBeVisible()
  expect(providerRequests.some((url) => url.includes('netbeheergebieden_gas'))).toBe(true)
  expect(providerRequests.some((url) => url.includes('netbeheergebieden_media'))).toBe(true)
  expect(providerRequests.some((url) => url.includes('netbeheergebieden_riolering'))).toBe(true)
  expect(errors).toEqual([])
})

test('loads governmental-service, RIVM acute-care and DUO education context only on the facilities map', async ({ page }) => {
  const errors = captureErrors(page)
  const facilityRequests: string[] = []
  const acuteCareRequests: string[] = []
  const educationRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('government-service-locations.geojson.gz')) {
      facilityRequests.push(request.url())
    }
    if (request.url().includes('rivm-acute-care-locations.geojson.gz')) {
      acuteCareRequests.push(request.url())
    }
    if (request.url().includes('duo-education-locations.geojson.gz')) {
      educationRequests.push(request.url())
    }
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(facilityRequests).toEqual([])
  expect(acuteCareRequests).toEqual([])
  expect(educationRequests).toEqual([])

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.getByText('Official governmental-service locations', { exact: true })).toBeVisible()
  await expect(page.getByText(/2[,.]885 KVK\/PDOK public-order/)).toBeVisible()
  await expect(page.getByText('Official acute-care roles · RIVM 2026', { exact: true })).toBeVisible()
  await expect(page.getByText(/79 SEH locations: 76 reported 24\/7 and 71 reported acute obstetrics/)).toBeVisible()
  await expect(page.getByText('Official active education locations · DUO RIO', { exact: true })).toBeVisible()
  await expect(page.getByText(/12[,.]883 current location-use records in European Netherlands/)).toBeVisible()
  await expect(page.getByText(/Creative Commons Attribution \(publisher version unspecified\)/)).toBeVisible()
  expect(facilityRequests).toHaveLength(1)
  expect(acuteCareRequests).toHaveLength(1)
  expect(educationRequests).toHaveLength(1)
  expect(await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      government: map.getLayoutProperty('official-government-service-points', 'visibility'),
      acuteCare: map.getLayoutProperty('official-acute-care-points', 'visibility'),
      acuteCareSource: Boolean(map.getSource('official-acute-care')),
      education: map.getLayoutProperty('official-education-location-points', 'visibility'),
      educationSource: Boolean(map.getSource('official-education-locations')),
    }
  })).toEqual({
    government: 'visible',
    acuteCare: 'visible',
    acuteCareSource: true,
    education: 'visible',
    educationSource: true,
  })

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.getByText('Official governmental-service locations', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Official acute-care roles · RIVM 2026', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Official active education locations · DUO RIO', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: { getLayoutProperty(layer: string, property: string): unknown }
    }).__resilienceMap!
    return [
      map.getLayoutProperty('official-government-service-points', 'visibility'),
      map.getLayoutProperty('official-acute-care-points', 'visibility'),
      map.getLayoutProperty('official-education-location-points', 'visibility'),
    ]
  })).toEqual(['none', 'none', 'none'])
  expect(errors).toEqual([])
})

test('loads statutory RDI antenna-installation context only on the telecom map', async ({ page }) => {
  const errors = captureErrors(page)
  const antennaRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('rdi-antenna-sites.geojson.gz')) antennaRequests.push(request.url())
  })

  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(antennaRequests).toEqual([])

  await page.getByRole('button', { name: 'Telecom & messaging: Reachable capacity' }).click()
  await expect(page.getByText('Official antenna installations · RDI Antenneregister', { exact: true })).toBeVisible()
  await expect(page.getByText(/32[,.]270 public installation sites representing 67[,.]508 registered antennas/)).toBeVisible()
  await expect(page.getByText(/does not establish radio coverage, operator ownership, backhaul, capacity/)).toBeVisible()
  expect(antennaRequests).toHaveLength(1)
  expect(await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getLayoutProperty(layer: string, property: string): unknown
      }
    }).__resilienceMap!
    return {
      source: Boolean(map.getSource('official-antenna-sites')),
      clusters: map.getLayoutProperty('official-antenna-site-clusters', 'visibility'),
      points: map.getLayoutProperty('official-antenna-site-points', 'visibility'),
    }
  })).toEqual({ source: true, clusters: 'visible', points: 'visible' })

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.getByText('Official antenna installations · RDI Antenneregister', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: { getLayoutProperty(layer: string, property: string): unknown }
    }).__resilienceMap!
    return [
      map.getLayoutProperty('official-antenna-site-clusters', 'visibility'),
      map.getLayoutProperty('official-antenna-site-points', 'visibility'),
    ]
  })).toEqual(['none', 'none'])
  expect(errors).toEqual([])
})

test('shows audited ferry lifelines only for mobility and emergency supply', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.waitForFunction(() => Boolean(
    (window as Window & {
      __resilienceMap?: {
        getSource(id: string): unknown
        getFeatureState(target: { source: string; id: string }): unknown
      }
    }).__resilienceMap?.getSource('national-routes'),
  ))

  const ferryState = (id: string) => page.evaluate((routeId) => {
    const map = (window as Window & {
      __resilienceMap?: {
        getFeatureState(target: { source: string; id: string }): Record<string, number>
      }
    }).__resilienceMap!
    return map.getFeatureState({
      source: 'national-routes',
      id: routeId,
    }) ?? {}
  }, id)
  const layers = page.getByRole('navigation', { name: 'Simulation map layers' })
  const ferryIds = [
    'gtfs-ferry-wpd-holwerd-ameland',
    'audited-ferry-kessel-reuver',
    'audited-ferry-bergen-vierlingsbeek',
    'audited-ferry-broekhuizen-arcen',
    'audited-ferry-lottum-lomm',
    'audited-ferry-velden-grubbenvorst',
  ]

  await layers.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  for (const id of ferryIds) {
    await expect.poll(async () => (await ferryState(id)).opacity).toBeGreaterThan(0)
    expect((await ferryState(id)).width).toBe(1.8)
  }

  await layers.getByRole('button', { name: 'Electricity: Service availability' }).click()
  for (const id of ferryIds) {
    await expect.poll(async () => (await ferryState(id)).opacity).toBe(0)
    expect((await ferryState(id)).width).toBe(0)
  }

  await layers.getByRole('button', { name: 'Emergency supply: Delivered / demand' }).click()
  for (const id of ferryIds) {
    await expect.poll(async () => (await ferryState(id)).opacity).toBeGreaterThan(0)
    expect((await ferryState(id)).width).toBe(1.8)
  }
  expect(errors).toEqual([])
})

test('keeps heavy geometry static when the simulation time changes', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()
  await page.waitForFunction(() => Boolean(
    (window as Window & {
      __resilienceMap?: { getSource(id: string): unknown }
    }).__resilienceMap?.getSource('municipalities-state'),
  ))
  expect(await page.evaluate(() => Boolean(
    (window as Window & {
      __resilienceMap?: { getLayer(id: string): unknown }
    }).__resilienceMap?.getLayer('municipality-status-outline'),
  ))).toBe(true)

  await page.evaluate(() => {
    const browserWindow = window as Window & {
      __resilienceMap?: {
        getSource(id: string): { setData(data: unknown): unknown } | undefined
        getStyle(): { sources: Record<string, unknown> }
        setFeatureState(target: { source: string; id: string | number }, state: unknown): unknown
      }
      __e2eUpdatedSources?: string[]
      __e2eFeatureStateSources?: string[]
    }
    const map = browserWindow.__resilienceMap!
    browserWindow.__e2eUpdatedSources = []
    browserWindow.__e2eFeatureStateSources = []
    for (const sourceId of Object.keys(map.getStyle().sources)) {
      const source = map.getSource(sourceId)
      if (!source || typeof source.setData !== 'function') continue
      const original = source.setData.bind(source)
      source.setData = (data: unknown) => {
        browserWindow.__e2eUpdatedSources!.push(sourceId)
        return original(data)
      }
    }
    const originalSetFeatureState = map.setFeatureState.bind(map)
    map.setFeatureState = (target, state) => {
      browserWindow.__e2eFeatureStateSources!.push(target.source)
      return originalSetFeatureState(target, state)
    }
  })

  await page.getByRole('slider', { name: /Simulation time/ }).fill('24')
  await expect(page.locator('.current-time strong')).toHaveText('T+06:00')
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __e2eFeatureStateSources?: string[] }).__e2eFeatureStateSources?.length ?? 0,
  )).toBeGreaterThan(0)
  const updatedSources = await page.evaluate(() =>
    (window as Window & { __e2eUpdatedSources?: string[] }).__e2eUpdatedSources ?? [],
  )
  expect(updatedSources).toEqual([])
  const featureStateSources = await page.evaluate(() =>
    (window as Window & { __e2eFeatureStateSources?: string[] }).__e2eFeatureStateSources ?? [],
  )
  expect(new Set(featureStateSources)).toEqual(new Set([
    'municipalities-state',
    'city-gateways',
    'national-routes',
  ]))
  expect(errors).toEqual([])
})

test('switches layers, scrubs time, and keeps inspector semantics aligned', async ({ page }) => {
  // Full-suite parallelism runs several WebGL canvases at once; allow enough
  // time for a throttled CI renderer without weakening any assertion timeout.
  test.setTimeout(45_000)
  const errors = captureErrors(page)
  await page.goto(appPath)
  const layerNavigation = page.getByRole('navigation', { name: 'Simulation map layers' })
  await expect(layerNavigation.locator('.layer-button')).toHaveCount(11)

  await layerNavigation.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await page.getByRole('slider', { name: /Simulation time/ }).fill('48')
  await expect(page.locator('.current-time strong')).toHaveText('T+12:00')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.status-hero-copy')).toContainText('evidence class unsupported')
  await expect(page.locator('.mini-grid').getByText('Local hazard', { exact: true }).locator('..')).toContainText('Unknown')
  await expect(page.locator('.mini-grid').getByText('Spatial evidence', { exact: true }).locator('..')).toContainText('Unsupported')

  await layerNavigation.getByRole('button', { name: 'Population & needs: Modeled residents under service pressure' }).click()
  await expect(page.locator('.status-hero-copy')).toContainText('CBS context + scenario')
  await expect(page.getByText('Impact share')).toBeVisible()

  await page.getByLabel('Intervention').selectOption('generator-priority')
  await expect(page.getByLabel('Intervention')).toHaveValue('generator-priority')
  expect(errors).toEqual([])
})

test('changes disaster, season and climate assumptions without changing map workflow', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)

  await page.getByLabel('Disaster').selectOption('cyberattack')
  await page.getByLabel('Season').selectOption('summer')
  await page.getByLabel('Climate').selectOption('Hn')
  await page.getByLabel('Horizon').selectOption('2100')
  await page.getByLabel('Compare with').selectOption('winter')
  await expect(page.locator('.scenario-console-heading')).toContainText('reference Winter with the same intervention')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await page.getByRole('slider', { name: /Simulation time/ }).fill('96')

  await expect(page.getByText('Digital disruption', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Disaster')).toHaveValue('cyberattack')
  await expect(page.getByLabel('Season')).toHaveValue('summer')
  await expect(page.getByLabel('Climate')).toHaveValue('Hn')
  await expect(page.getByLabel('Horizon')).toHaveValue('2100')
  expect(errors).toEqual([])
})

test('labels Amsterdam river evidence unknown instead of presenting a false all-clear', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Amsterdam' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await page.getByRole('slider', { name: /Simulation time/ }).fill('288')

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.getByText('Known pathway, missing local scenario layer', { exact: true })).toBeVisible()
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('unknown, not an all-clear')
  await expect(page.getByRole('group', { name: 'Modeled people under pressure' }))
    .toContainText(/\d+ municipal hazard results? unsupported/)

  const featureState = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getFeatureState(target: { source: string; id: string }): Record<string, string | number>
      }
    }).__resilienceMap!
    return map.getFeatureState({ source: 'municipalities-state', id: 'GM0363' })
  })
  expect(featureState).toMatchObject({ color: '#7f8c93', status: 'unknown', evidence: 'unsupported' })
  const readUnsupportedDistricts = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getSource(id: string): { serialize(): { data?: { features?: Array<{ properties?: Record<string, unknown> }> } } } | undefined
      }
    }).__resilienceMap!
    const features = map.getSource('city-areas')?.serialize().data?.features ?? []
    return {
      count: features.length,
      allGrey: features.length > 0 && features.every((feature) =>
        feature.properties?.color === '#7f8c93' && feature.properties?.evidence === 'unsupported'
      ),
    }
  })
  await expect.poll(readUnsupportedDistricts).toMatchObject({ allGrey: true })
  expect(errors).toEqual([])
})

test('labels Apeldoorn river screening unknown instead of presenting unsupported precision', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Apeldoorn' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await page.getByRole('slider', { name: /Simulation time/ }).fill('288')

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.getByText('Known pathway, missing local scenario layer', { exact: true })).toBeVisible()
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('unsupported, not a forecast')

  const featureState = await page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getFeatureState(target: { source: string; id: string }): Record<string, string | number>
      }
    }).__resilienceMap!
    return map.getFeatureState({ source: 'municipalities-state', id: 'GM0200' })
  })
  expect(featureState).toMatchObject({ color: '#7f8c93', status: 'unknown', evidence: 'unsupported' })
  expect(errors).toEqual([])
})

test('keeps Borsele nuclear and industrial incidents outside the generic hazard model', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Borsele' })
  await page.getByLabel('Disaster').selectOption('cyberattack')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const scopeExclusion = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario scope exclusion · Borsele nuclear/industrial incidents',
  })
  await expect(scopeExclusion).toBeVisible()
  await expect(scopeExclusion).toContainText('no KCB Borssele/Doel radiological source term')
  await expect(scopeExclusion).toContainText('must not be interpreted as reactor/vital-control failure or a release')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('must not be read as failure of KCB Borssele reactor/vital control')

  await page.getByLabel('Open municipality').selectOption({ label: 'Breda' })
  await expect(scopeExclusion).toHaveCount(0)
  expect(errors).toEqual([])
})

test('keeps Brummen Cortenoever actions and RWZI dependencies outside unconfirmed model state', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Brummen' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const workflowGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario workflow gap · Brummen Cortenoever/RWZI',
  })
  await expect(workflowGap).toBeVisible()
  await expect(workflowGap).toContainText('historic 72/48/24-hour warning–preparation–evacuation workflow')
  await expect(workflowGap).toContainText('published local playbook is from 2017/2018 and requires revalidation')
  await expect(workflowGap).toContainText('never mean Brummen, VNOG, Rijkswaterstaat, Vallei en Veluwe or a utility has issued or completed an action')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('real IJssel/Cortenoever pathway')

  await page.getByLabel('Open municipality').selectOption({ label: 'Breda' })
  await expect(workflowGap).toHaveCount(0)
  expect(errors).toEqual([])
})

test('separates Brunssum former-mining pathways from the Groningen earthquake exercise', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Brunssum' })
  await page.getByLabel('Disaster').selectOption('earthquake')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const scopeGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario scope gap · Brunssum seismic/mining pathways',
  })
  await expect(scopeGap).toBeVisible()
  await expect(scopeGap).toContainText('synthetic Groningen-centred earthquake')
  await expect(scopeGap).toContainText('does not model a Zuid-Limburg event')
  await expect(scopeGap).toContainText('not observed shaking, a forecast, probability, ground state or damage report')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('former-coal-mining ground-movement pathways')

  await page.getByLabel('Open municipality').selectOption({ label: 'Breda' })
  await expect(scopeGap).toHaveCount(0)
  expect(errors).toEqual([])
})

test('keeps Bunschoten Eemmeer pathways distinct from generic river and coastal screens', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Bunschoten' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const scopeGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario scope gap · Bunschoten Eem/Eemmeer water',
  })
  await expect(scopeGap).toBeVisible()
  await expect(scopeGap).toContainText('neither is a selected Eem inflow, Eemmeer/Randmeren storm-setup')
  await expect(scopeGap).toContainText('not an all-clear')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('false sustained named-major-river amplitude is suppressed')

  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await expect(scopeGap).toBeVisible()
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  expect(errors).toEqual([])
})

test('keeps Buren design-storm and river evidence distinct from the synthetic 72-hour fields', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Buren' })
  await page.getByLabel('Disaster').selectOption('pluvial-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const evidenceGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Buren water events',
  })
  await expect(evidenceGap).toBeVisible()
  await expect(evidenceGap).toContainText('126 measured-floor ingress buildings at T100')
  await expect(evidenceGap).toContainText('not current inundation or a forecast')
  await expect(evidenceGap).toContainText('gray/white classes remain Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('2021 integrated sewer/surface model')

  await page.getByLabel('Disaster').selectOption('river-flood')
  await expect(evidenceGap).toBeVisible()
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('retained amplitude is diagnostic only')
  expect(errors).toEqual([])
})

test('requires a Capelle barrier event and keeps Kralingseveer outside generic service state', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Capelle aan den IJssel' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const floodGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Capelle flood pathways',
  })
  await expect(floodGap).toBeVisible()
  await expect(floodGap).toContainText('no Hollandsche IJsselkering state')
  await expect(floodGap).toContainText('3,063 affected-building polygons')
  await expect(floodGap).toContainText('not a current closure, observation or T+72 forecast')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  const serviceGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Kralingseveer wastewater system',
  })
  await expect(serviceGap).toBeVisible()
  await expect(serviceGap).toContainText('about 360,000 people')
  await expect(serviceGap).toContainText('not live flow or spare capacity')
  await expect(serviceGap).toContainText('must not be read as Kralingseveer performance')
  expect(errors).toEqual([])
})

test('keeps Castricum dune, drinking-water and ferry pathways explicitly unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Castricum' })
  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const duneGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Castricum dune defence',
  })
  await expect(duneGap).toBeVisible()
  await expect(duneGap).toContainText('a coastal location does not itself select a present failure')
  await expect(duneGap).toContainText('not an observed breach, warning, forecast or evacuation basis')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByRole('button', { name: 'Drinking water: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · PWN Castricum dune infiltration',
  })).toContainText('roughly three weeks of infiltration')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  const ferryGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · De Woude and Akersloot ferries',
  })
  await expect(ferryGap).toBeVisible()
  await expect(ferryGap).toContainText('No stable machine-readable live-status API')
  await expect(ferryGap).toContainText('cannot establish ferry operation')
  expect(errors).toEqual([])
})

test('suppresses Cranendonck major-river precision while preserving brook and RWZI unknowns', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Cranendonck' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario scope gap · Cranendonck water pathways',
  })
  await expect(waterGap).toBeVisible()
  await expect(waterGap).toContainText('generic Rhine/Meuse/IJssel amplitude is disabled')
  await expect(waterGap).toContainText('scoped zero is not an all-clear')
  await expect(waterGap).toContainText('not a current observation, forecast or T+72 footprint')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('Belgian-fed brook')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  const rwziGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · RWZI Soerendonk',
  })
  await expect(rwziGap).toBeVisible()
  await expect(rwziGap).toContainText('38,000 population equivalents and 1,830 m³/hour')
  await expect(rwziGap).toContainText('not live inflow, usable spare capacity')
  await expect(rwziGap).toContainText('must not be read as current RWZI performance')
  expect(errors).toEqual([])
})

test('keeps Culemborg hydraulic, ferry and road-derived utility gaps explicit', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Culemborg' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const floodGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Culemborg Lek and rainwater',
  })
  await expect(floodGap).toBeVisible()
  await expect(floodGap).toContainText('selects no water level, defence segment/state')
  await expect(floodGap).toContainText('P1 pluvial sites in Voorkoop, Componistenbuurt, Binnenstad and Pavijen')
  await expect(floodGap).toContainText('Neither source is a current observation or arbitrary T+72 forecast')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  const ferryGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Culemborg–Houten ferry',
  })
  await expect(ferryGap).toBeVisible()
  await expect(ferryGap).toContainText('15-tonne vehicle limit')
  await expect(ferryGap).toContainText('must not be replayed as a T+72 forecast')

  await page.getByRole('button', { name: 'Drinking water: Service availability' }).click()
  const networkGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Culemborg road-derived lifelines',
  })
  await expect(networkGap).toBeVisible()
  await expect(networkGap).toContainText('NWB proves road geometry only')
  await expect(networkGap).toContainText('must not be read as physical utility flow')
  expect(errors).toEqual([])
})

test('keeps Dalfsen river, Vecht bridge and road-derived utility states unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Dalfsen' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const riverGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dalfsen Vecht/IJssel water',
  })
  await expect(riverGap).toBeVisible()
  await expect(riverGap).toContainText('no river boundary, defence/breach/overtopping state')
  await expect(riverGap).toContainText('non-operational diagnostic—not current flooding, a warning or a T+72 forecast')
  await expect(riverGap).toContainText('Missing event coverage remains Unknown, never dry or safe')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  const bridgeGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Dalfsen Vecht bridge',
  })
  await expect(bridgeGap).toBeVisible()
  await expect(bridgeGap).toContainText('reachability unresolved if the deck or approaches are inundated')
  await expect(bridgeGap).toContainText('passability and alternative-route capacity remain Unknown')
  await expect(bridgeGap).toContainText('must not trigger an inferred utility failure')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  const networkGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Dalfsen road-derived lifelines',
  })
  await expect(networkGap).toBeVisible()
  await expect(networkGap).toContainText('NWB proves road geometry only')
  await expect(networkGap).toContainText('not operator assets or live flows')
  expect(errors).toEqual([])
})

test('keeps De Bilt water, Heuvelrug fire and road-derived service claims unsupported', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'De Bilt' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · De Bilt water pathways',
  })
  await expect(waterGap).toBeVisible()
  await expect(waterGap).toContainText('blank/255/out-of-waterboard cells remain NoData')
  await expect(waterGap).toContainText('non-operational diagnostic—not current flooding, a forecast or a T+72 footprint')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  const fireGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · De Bilt Heuvelrug fire',
  })
  await expect(fireGap).toBeVisible()
  await expect(fireGap).toContainText('fourteenth of 24')
  await expect(fireGap).toContainText('Unknown rather than forecast')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · RWZI De Bilt and Biltse Grift',
  })).toContainText('documented 2023 treatment/control failure and 2024 rain-overflow consequences')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · De Bilt road-derived lifelines',
  })).toContainText('NWB establishes A27/A28/N-road geometry only')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario-scope gap · Utrecht Science Park Bilthoven',
  })).toContainText('no biological-release preset')
  expect(errors).toEqual([])
})

test('keeps Dantumadiel flood mechanisms, rural access and utility topology unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Dantumadiel' })
  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dantumadiel water systems',
  })
  await expect(waterGap).toBeVisible()
  await expect(waterGap).toContainText('selects no water level, mainland dike segment/state')
  await expect(waterGap).toContainText('without an established raw numeric, licence, resolution, NoData or refresh contract')
  await expect(waterGap).toContainText('not current flooding, a forecast or proof of safety')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('river-flood')
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('zero is not an all-clear')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Dantumadiel pressure sewer and water chain',
  })).toContainText('not Wetterskip performance')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Dantumadiel rural roads and rail',
  })).toContainText('Unreported routes remain Unknown—not automatically open')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Dantumadiel road-derived lifelines',
  })).toContainText('must not be read as operator routes or flows')
  expect(errors).toEqual([])
})

test('keeps Coevorden local water, Gees fire and cross-border service gaps explicit', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Coevorden' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario scope gap · Coevorden water pathways',
  })
  await expect(waterGap).toBeVisible()
  await expect(waterGap).toContainText('scoped zero is not an all-clear')
  await expect(waterGap).toContainText('cumulative event-attributable person-hours excludes intermunicipal transfers')
  await expect(waterGap).toContainText('neither figure is an observed outage')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  const fireGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Coevorden Gees forest fire',
  })
  await expect(fireGap).toBeVisible()
  await expect(fireGap).toContainText('fortieth of 68')
  await expect(fireGap).toContainText('nearly 12 km away')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Coevorden regional water and drainage',
  })).toContainText('not connected catchments')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Coevorden cross-border logistics',
  })).toContainText('German, rail and waterway continuity')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Coevorden road-derived lifelines',
  })).toContainText('not operator assets or observed flows')
  expect(errors).toEqual([])
})

test('keeps De Fryske Marren water, Gaasterlan fire and road-derived services unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'De Fryske Marren' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · De Fryske Marren water systems',
  })
  await expect(waterGap).toBeVisible()
  await expect(waterGap).toContainText('selects no IJssel–IJsselmeer boundary condition')
  await expect(waterGap).toContainText('asset and observation context—not connectivity, operation or a T+72 forecast')
  await expect(waterGap).toContainText('Local water impact remains Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  const fireGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · De Fryske Marren Gaasterlân fire',
  })
  await expect(fireGap).toBeVisible()
  await expect(fireGap).toContainText('fortieth of 70')
  await expect(fireGap).toContainText('rather than observations or forecasts')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · De Fryske Marren managed-water chain',
  })).toContainText('one observation cannot be extended through T+72')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · De Fryske Marren crossings and external care',
  })).toContainText('an absent NDW match never proves a crossing open')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · De Fryske Marren road-derived lifelines',
  })).toContainText('must not be read as operator assets, live flows or outage predictions')
  expect(errors).toEqual([])
})

test('keeps De Wolden water, Ruinen fire and road-derived services unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'De Wolden' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · De Wolden water pathways',
  })
  await expect(waterGap).toBeVisible()
  await expect(waterGap).toContainText('selects no connected Meppelerdiep, Reest or Wold Aa pathway')
  await expect(waterGap).toContainText('non-operational diagnostic—not current flooding, a warning or a T+72 forecast')
  await expect(waterGap).toContainText('Missing event coverage remains Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · De Wolden Boswachterij Ruinen fire',
  })).toContainText('Oosteinde-Buiten about 6.553 km away ranks first')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · De Wolden sewer and managed water',
  })).toContainText('incomplete coverage—not no wastewater dependency')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · De Wolden local continuity',
  })).toContainText('transport geometry must never trigger an automatic utility failure')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · De Wolden road-derived lifelines',
  })).toContainText('not operator assets, live flows or outage predictions')
  expect(errors).toEqual([])
})

test('keeps De Ronde Venen hydraulic, asset-coverage and network states unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'De Ronde Venen' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const floodGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · De Ronde Venen hydraulic events',
  })
  await expect(floodGap).toBeVisible()
  await expect(floodGap).toContainText('select no Lek/Rijn or regional-water boundary')
  await expect(floodGap).toContainText('past observation—not a future forecast')
  await expect(floodGap).toContainText('missing HWH geometry never means no asset, flood pathway or risk')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('heatwave')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · De Ronde Venen local priorities',
  })).toContainText('Mijdrecht Dorp last')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · De Ronde Venen AGV asset coverage',
  })).toContainText('contributor-coverage gap, not zero assets')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · De Ronde Venen local roads and transit',
  })).toContainText('cannot be replayed as a future T+72 closure')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · De Ronde Venen road-derived lifelines',
  })).toContainText('must not be read as operator routes, live flows or outage predictions')
  expect(errors).toEqual([])
})

test('keeps Delft flood sources, Abtswoude fire, access and lifelines unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Delft' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const floodGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Delft rain and flood sources',
  })
  await expect(floodGap).toBeVisible()
  await expect(floodGap).toContainText('Rhine/Meuse/IJssel field is disabled for Delft')
  await expect(floodGap).toContainText('narrow zero is not an all-clear')
  await expect(floodGap).toContainText('Local depth and impact remain Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Delft Abtswoudse Bos fire',
  })).toContainText('twenty-third of 91')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Delft polder, boezem and water chain',
  })).toContainText('past mechanism, not recurrence or present operation')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Delft tunnel, crossings and acute care',
  })).toContainText('One valid-time bridge message is an observation, not a future T+72 state')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Delft road-derived lifelines',
  })).toContainText('must not be read as operator routes, live flows or outage predictions')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Unmodeled hazard scope · Delft RID and technology incidents',
  })).toContainText('must not be silently mapped to wildfire, cyberattack or earthquake')
  expect(errors).toEqual([])
})

test('keeps Den Helder coastal impacts unsupported and scopes TESO to mobility and supply', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Den Helder' })
  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Den Helder coast and water systems',
  })
  await expect(waterGap).toBeVisible()
  await expect(waterGap).toContainText('no North Sea/Wadden Sea level')
  await expect(waterGap).toContainText('Local impact remains Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Den Helder Donkere Duinen fire',
  })).toContainText('thirty-third of 65')

  await page.getByRole('button', { name: 'Drinking water: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Den Helder HHNK and near-shore coverage',
  })).toContainText('association and contributor-coverage gaps')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model scope · Den Helder TESO and Kooybrug',
  })).toContainText('mobility/supply-only logical route')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Den Helder road-derived lifelines',
  })).toContainText('TESO is explicitly restricted to Mobility and Supply')
  expect(errors).toEqual([])
})

test('suppresses Deurne major-river precision and exposes peat, water and N279 limits', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Deurne' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Deurne local water pathways',
  })
  await expect(waterGap).toContainText('outside direct large-river influence')
  await expect(waterGap).toContainText('not an all-clear')
  await expect(waterGap).toContainText('Local depth, duration and T+72 recession remain Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Deurne peat fire',
  })).toContainText('twenty-fifth of 29')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Deurne peat fire',
  })).toContainText('months-long smoke')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Deurne managed-water chain',
  })).toContainText('incomplete scoped coverage')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Deurne roads, rail and Peel',
  })).toContainText('two series edges')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Deurne road-derived lifelines',
  })).toContainText('rather than operator assets, live flows or outage forecasts')
  expect(errors).toEqual([])
})

test('keeps Deventer IJssel, rain, crossings and utility topology unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Deventer' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const floodGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Deventer IJssel and rain',
  })
  await expect(floodGap).toContainText('4.50, 6.10 and 6.30 m NAP')
  await expect(floodGap).toContainText('not generic inundation values')
  await expect(floodGap).toContainText('a current Waterinfo observation is not T+72')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Deventer Lettele fire',
  })).toContainText('twenty-fifth of 69')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Deventer three-waterboard chain',
  })).toContainText('missing or partial records remain Unknown')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Deventer crossings and acute care',
  })).toContainText('hospital questionnaire do not establish passability')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Deventer road-derived lifelines',
  })).toContainText('must not be read as operator flows, outages or a T+72 prediction')
  expect(errors).toEqual([])
})

test('keeps Dijk en Waard coastal, polder, recovery and lifeline precision unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Dijk en Waard' })
  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const coastGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dijk en Waard polder and coast',
  })
  await expect(coastGap).toContainText('selects no North Sea or IJsselmeer/Markermeer boundary')
  await expect(coastGap).toContainText('not an all-clear')
  await expect(coastGap).toContainText('Local impact and T+72 recovery remain Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dijk en Waard Bomenbuurt fire',
  })).toContainText('fiftieth of 69')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Dijk en Waard compartments and pumps',
  })).toContainText('Plan targets are not observed performance')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Dijk en Waard internal continuity',
  })).toContainText('absent current incident record does not prove a route open')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Dijk en Waard road-derived lifelines',
  })).toContainText('must not be read as operator assets, live flows or a T+72 prediction')
  expect(errors).toEqual([])
})

test('keeps Diemen hydraulic, AGV, source-fire and road-proxy precision unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Diemen' })
  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Diemen IJmeer, canal and rain',
  })
  await expect(waterGap).toContainText('no IJmeer/Markermeer or Amsterdam-Rijnkanaal boundary')
  await expect(waterGap).toContainText('Local water impact and T+72 service consequences remain Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Diemen Gemeenschapspolder fire',
  })).toContainText('seventeenth of 37')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Diemen Gemeenschapspolder fire',
  })).toContainText('zero-resident Diemer Vijfhoek ranks first')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Diemen AGV coverage',
  })).toContainText('coverage result—not no assets')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Diemen tunnel and transit',
  })).toContainText('absent NDW match do not prove scenario-time passability')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Diemen road-derived lifelines',
  })).toContainText('must not be read as operator routes, live flows, outages or a T+72 prediction')
  expect(errors).toEqual([])
})

test('keeps Doesburg IJssel, Beinum and first-72-hour lifeline precision unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Doesburg' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Doesburg IJssel and rain',
  })
  await expect(waterGap).toContainText('dike-ring-48 defence state')
  await expect(waterGap).toContainText('diagnostic rather than a local metre claim or T+72 forecast')
  await expect(waterGap).toContainText('Local impact and recovery remain Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Doesburg Beinum fire',
  })).toContainText('eighth of eleven')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Doesburg Beinum and water chain',
  })).toContainText('Registers remain non-causal')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Doesburg bridge and historic centre',
  })).toContainText('do not prove scenario-time passability or throughput')

  await page.getByRole('button', { name: 'Telecom & messaging: Reachable capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Doesburg road-derived lifelines',
  })).toContainText('must not be read as operator routes, outages or T+72 predictions')
  expect(errors).toEqual([])
})

test('keeps Dinkelland Dinkel, cross-border and network-pressure scopes explicit', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Dinkelland' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dinkelland Dinkel and rain',
  })
  await expect(waterGap).toContainText('cross-border Dinkel')
  await expect(waterGap).toContainText('not an all-clear')
  await expect(waterGap).toContainText('Local depth, access and recession remain Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByRole('button', { name: 'Population & needs: Modeled residents under service pressure' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Metric scope · Dinkelland network pressure',
  })).toContainText('zero local pre-network deprived person-hours')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Dinkelland Vechtstromen coverage',
  })).toContainText('contributor/query NoData—not absence')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Dinkelland cross-border continuity',
  })).toContainText('do not prove operation')

  await page.getByRole('button', { name: 'Telecom & messaging: Reachable capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Dinkelland road-derived lifelines',
  })).toContainText('Cross-border dependencies are absent')
  expect(errors).toEqual([])
})

test('keeps Doetinchem Oude IJssel, Slangenburg and continuity precision unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Doetinchem' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Doetinchem Oude IJssel and rain',
  })
  await expect(waterGap).toContainText('no boundary hydrograph, gauge datum')
  await expect(waterGap).toContainText('diagnostic rather than a local metre claim or T+72 forecast')
  await expect(waterGap).toContainText('Local impact and recovery remain Unknown')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Doetinchem Slangenburg fire',
  })).toContainText('twenty-eighth of 84')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Doetinchem WRIJ water chain',
  })).toContainText('not observed performance')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Doetinchem continuity and Slingeland',
  })).toContainText('prove neither future passability, acceptance, staffing, capacity')

  await page.getByRole('button', { name: 'Telecom & messaging: Reachable capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model gap · Doetinchem road-derived lifelines',
  })).toContainText('not operator assets, live flows, outages or T+72 forecasts')
  expect(errors).toEqual([])
})

test('keeps Dordrecht flood, Biesbosch, lifeline and reference-date semantics explicit', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Dordrecht' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dordrecht dike ring, tide and rain',
  })
  await expect(waterGap).toContainText('dike-ring-22')
  await expect(waterGap).toContainText('non-operational diagnostic')
  await expect(waterGap).toContainText('coastal zero')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dordtse Biesbosch fire',
  })).toContainText('130th of 132')

  await page.getByRole('button', { name: 'Advanced' }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await assumptions.getByLabel('Reference date').fill('2026-09-03')
  await assumptions.getByRole('button', { name: 'Close operational assumptions' }).click()

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  const n3 = page.locator('.evidence-row.assumed').filter({
    hasText: 'Official valid-time restriction · N3 Papendrechtsebrug',
  })
  await expect(n3).toContainText('aligned to 2026-09-03')
  await expect(n3).toContainText('closed at zero scenario capacity')
  await expect(n3).toContainText('capacity remains Unknown')

  await page.getByRole('button', { name: 'Drinking water: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Dordrecht water chain',
  })).toContainText('quantity/pressure/quality')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Dordrecht physical lifelines',
  })).toContainText('restricted to Mobility')
  expect(errors).toEqual([])
})

test('keeps Gorinchem hydraulic uncertainty and A27 vehicle classes distinct', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Gorinchem' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Molenvliet fire-source containment',
  })).toContainText('river-flood municipality result remains Unknown')

  await page.getByRole('button', { name: 'Advanced' }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await assumptions.getByLabel('Reference date').fill('2026-09-03')
  await assumptions.getByRole('button', { name: 'Close operational assumptions' }).click()

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  const a27 = page.locator('.evidence-row.assumed').filter({
    hasText: 'Official vehicle-class restriction · A27 Merwedebrug',
  })
  await expect(a27).toContainText('trucks and touring coaches')
  await expect(a27).toContainText('passenger cars, scheduled buses and emergency services remain allowed')
  await expect(a27).toContainText('inside the interval verified through retrieval')
  await expect(a27).toContainText('does not reduce generalized route capacity')
  await expect(a27).toContainText('no expiry')
  expect(errors).toEqual([])
})

test('keeps the Algerabrug ordinary-motor closure distinct from emergency and active modes', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Krimpen aan den IJssel' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'current Algerabrug closure',
  })).toContainText('river-flood municipality result remains Unknown')

  await page.getByRole('button', { name: 'Advanced' }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await assumptions.getByLabel('Reference date').fill('2026-09-03')
  await assumptions.getByRole('button', { name: 'Close operational assumptions' }).click()

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  const algerabrug = page.locator('.evidence-row.assumed').filter({
    hasText: 'Official role-specific restriction · N210 Algerabrug',
  })
  await expect(algerabrug).toContainText('ordinary motor traffic is closed')
  await expect(algerabrug).toContainText('controlled emergency services retain a lane')
  await expect(algerabrug).toContainText('inside the published maintenance interval')
  await expect(algerabrug).toContainText('does not reduce generalized route capacity')
  await expect(algerabrug).toContainText('exercise date cannot resolve the 05:00 endpoint')
  await expect(algerabrug).toContainText('remain Unknown')
  expect(errors).toEqual([])
})

test('shows the dated Spanjaardsbrug restriction without inventing route capacity', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Leiderdorp' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'primary, regional and polder/boezem pathways',
  })).toContainText('river-flood municipality result remains Unknown')

  await page.getByRole('button', { name: 'Advanced' }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await assumptions.getByLabel('Reference date').fill('2026-09-03')
  await assumptions.getByRole('button', { name: 'Close operational assumptions' }).click()

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.getByText('Context / unknown capacity', { exact: true })).toBeVisible()
  const crossingState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getFeatureState(target: { source: string; id: string }): Record<string, number | string>
      }
    }).__resilienceMap!
    return map.getFeatureState({
      source: 'national-routes',
      id: 'audited-road-lage-rijndijk-spanjaardsbrug',
    }) ?? {}
  })
  await expect.poll(async () => Number((await crossingState()).opacity)).toBeGreaterThan(0)
  expect((await crossingState()).width).toBe(1.35)
  expect((await crossingState()).flowDirection).toBe(0)
  expect((await crossingState()).motionOpacity).toBe(0)

  const restriction = page.locator('.evidence-row.assumed').filter({
    hasText: 'Official role-specific restriction · Lage Rijndijk / Spanjaardsbrug',
  })
  await expect(restriction).toContainText('closed to cars and buses')
  await expect(restriction).toContainText('Emergency services, cycles and mopeds can pass')
  await expect(restriction).toContainText('inside the published closure interval')
  await expect(restriction).toContainText('excluded from causal transfers')
  await expect(restriction).toContainText('Unknown rather than open or available')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect.poll(async () => Number((await crossingState()).opacity)).toBe(0)
  expect((await crossingState()).width).toBe(0)
  expect(errors).toEqual([])
})

test('keeps the Kelperbrug heavy-vehicle restriction scoped and validity bounded', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Leudal' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Maas, defence and groundwater pathways',
  })).toContainText('river-flood municipality result remains Unknown')

  await page.getByRole('button', { name: 'Advanced' }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await assumptions.getByLabel('Reference date').fill('2026-09-03')
  await assumptions.getByRole('button', { name: 'Close operational assumptions' }).click()

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  const restriction = page.locator('.evidence-row.assumed').filter({
    hasText: 'Official vehicle-class restriction · N280 Kelperbrug',
  })
  await expect(restriction).toContainText('trucks, agricultural vehicles and non-scheduled buses')
  await expect(restriction).toContainText('Scheduled public transport and emergency services are exempt')
  await expect(restriction).toContainText('inside the evidence interval verified through retrieval')
  await expect(restriction).toContainText('does not reduce the generalized route capacity')
  await expect(restriction).toContainText('has no end date')
  await expect(restriction).toContainText('empty NDW match never proves the bridge open')
  await expect(restriction).toContainText('throughput remains Unknown')
  expect(errors).toEqual([])
})

test('shows the dated Lingewaard Rijndijk closure as visible non-causal context', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Lingewaard' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Waal, Pannerdensch Kanaal or Nederrijn event',
  })).toContainText('river-flood municipality result remains Unknown')
  const hazardGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Lingewaard river branches, Linge and Pannerling',
  })
  await expect(hazardGap).toContainText('fixed pump restarted and the temporary pumps were removed')
  await expect(hazardGap).toContainText('T+48 and T+72 remain NoData')

  await page.getByRole('button', { name: 'Advanced' }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await assumptions.getByLabel('Reference date').fill('2026-09-03')
  await assumptions.getByRole('button', { name: 'Close operational assumptions' }).click()

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.getByText('Context / unknown capacity', { exact: true })).toBeVisible()
  const routeState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getFeatureState(target: { source: string; id: string }): Record<string, number | string>
      }
    }).__resilienceMap!
    return map.getFeatureState({
      source: 'national-routes',
      id: 'audited-road-rijndijk-angeren-doornenburg',
    }) ?? {}
  })
  await expect.poll(async () => Number((await routeState()).opacity)).toBeGreaterThan(0)
  expect((await routeState()).width).toBe(1.35)
  expect((await routeState()).flowDirection).toBe(0)
  expect((await routeState()).motionOpacity).toBe(0)

  const restriction = page.locator('.evidence-row.assumed').filter({
    hasText: 'Official valid-time restriction · Rijndijk Angeren–Doornenburg',
  })
  await expect(restriction).toContainText('24 August through 2 October 2026')
  await expect(restriction).toContainText('Lodderhoeksestraat/N838')
  await expect(restriction).toContainText('inside the published closure interval')
  await expect(restriction).toContainText('excluded from causal transfers')
  await expect(restriction).toContainText('Empty NDW remains Unknown rather than open')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect.poll(async () => Number((await routeState()).opacity)).toBe(0)
  expect((await routeState()).width).toBe(0)
  expect(errors).toEqual([])
})

test('keeps Lisse flood mechanisms, road lifecycle and seasonal demand source-specific', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Lisse' })
  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'dike-trajectory-14 failure scenario',
  })).toContainText('coastal-flood municipality result remains Unknown')
  const hazardGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Lisse trajectory 14, Ringvaart and polder system',
  })
  await expect(hazardGap).toContainText('coastal and named-major-river amplitudes are suppressed')
  await expect(hazardGap).toContainText('Twenty-five public water objects do not establish connectivity')

  await page.getByRole('button', { name: 'Advanced' }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await assumptions.getByLabel('Reference date').fill('2026-09-06')
  await assumptions.getByRole('button', { name: 'Close operational assumptions' }).click()
  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()

  const lifecycle = page.locator('.evidence-row.assumed').filter({
    hasText: 'Official lifecycle context · Lisse access and seasonal demand',
  })
  await expect(lifecycle).toContainText('planned reopening day')
  await expect(lifecycle).toContainText('state remains Unknown rather than being switched to open')
  await expect(lifecycle).toContainText('zero bounded NDW matches never proves passage')
  await expect(lifecycle).toContainText('1.4 million seasonal visits')
  await expect(lifecycle).toContainText('not current occupancy and never annual residents')
  expect(errors).toEqual([])
})

test('keeps the Stuw Linne restriction scoped to active modes and its valid interval', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Maasgouw' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Maas/canal boundary, defence-reach or connected-footprint state',
  })).toContainText('river-flood municipality result remains Unknown')
  const hazardGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Maasgouw Maas, canals and source water',
  })
  await expect(hazardGap).toContainText('T+48/T+72 remain NoData')
  await expect(hazardGap).toContainText('Project evidence remains reach-specific')

  await page.getByRole('button', { name: 'Advanced' }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await assumptions.getByLabel('Reference date').fill('2026-09-03')
  await assumptions.getByRole('button', { name: 'Close operational assumptions' }).click()
  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()

  const restriction = page.locator('.evidence-row.assumed').filter({
    hasText: 'Official mode-specific restriction · Stuw Linne crossing',
  })
  await expect(restriction).toContainText('28 August through 4 September 2026')
  await expect(restriction).toContainText('pedestrian/cycle crossing only')
  await expect(restriction).toContainText('cannot numerically close or reduce an A-road logistics edge')
  await expect(restriction).toContainText('zero bounded NDW matches never means open')
  await expect(restriction).toContainText('remains Unknown')
  expect(errors).toEqual([])
})

test('keeps the N216 Schoonhoven-Gelkenes ferry visible but non-causal while state is unknown', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Krimpenerwaard' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'N216 ferry is misclassified',
  })).toContainText('river-flood municipality result remains Unknown')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.getByText('Context / unknown capacity', { exact: true })).toBeVisible()
  const ferryState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getFeatureState(target: { source: string; id: string }): Record<string, number | string>
      }
    }).__resilienceMap!
    return map.getFeatureState({
      source: 'national-routes',
      id: 'nwb-link-933-GM1931-GM1978',
    }) ?? {}
  })
  await expect.poll(async () => Number((await ferryState()).opacity)).toBeGreaterThan(0)
  expect((await ferryState()).width).toBe(1.8)
  expect((await ferryState()).flowDirection).toBe(0)
  expect((await ferryState()).motionOpacity).toBe(0)
  const ferry = page.locator('.evidence-row.assumed').filter({
    hasText: 'Transport provenance correction · N216 Schoonhoven–Gelkenes ferry',
  })
  await expect(ferry).toContainText('one typed ferry corridor instead of a 150-unit regional road')
  await expect(ferry).toContainText('Capacity and operational state remain Unknown')
  await expect(ferry).toContainText('excluded from causal transfers')
  await expect(ferry).toContainText('high-water landing thresholds are triggers')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect.poll(async () => Number((await ferryState()).opacity)).toBe(0)
  expect((await ferryState()).width).toBe(0)
  expect(errors).toEqual([])
})

test('suppresses Laarbeek major-river precision without hiding local Aa-system risk', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Laarbeek' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'remote water-control dependency',
  })).toContainText('river-flood municipality result remains Unknown')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  const water = page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Laarbeek Aa system and remote control',
  })
  await expect(water).toContainText('excludes direct Rhine, Meuse and sea flooding')
  await expect(water).toContainText('not evidence of a cyber incident')
  await expect(water).toContainText('major-river screen is suppressed')
  await expect(water).toContainText('remain Unknown')
  expect(errors).toEqual([])
})

test('keeps Land van Cuijk and Landsmeer water mechanisms source-specific and unknown', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Land van Cuijk' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const cuijk = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Land van Cuijk EDO 36 and Maas system',
  })
  await expect(cuijk).toContainText('non-operational diagnostic')
  await expect(cuijk).toContainText('T+48 and T+72 local coverage is NoData')
  await expect(cuijk).toContainText('N324 road bridge, Stuw Grave and lock are a shared dependency')

  await page.getByLabel('Open municipality').selectOption({ label: 'Landsmeer' })
  await page.getByLabel('Disaster').selectOption('coastal-flood')
  const landsmeer = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Landsmeer Waterland pathways',
  })
  await expect(landsmeer).toContainText('North Sea coast-distance amplitude is suppressed')
  await expect(landsmeer).toContainText('narrow Rhine/Meuse/IJssel zero is not an all-clear')
  await expect(landsmeer).toContainText('remain Unknown rather than zero or safe')
  expect(errors).toEqual([])
})

test('keeps Dongen rain, thermal, water-chain and road scope unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Dongen' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dongen rain and river systems',
  })
  await expect(waterGap).toContainText('Donge/Wilhelminakanaal')
  await expect(waterGap).toContainText('ninth through seventeenth')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('heatwave')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dongen heat and drought',
  })).toContainText('Tichelrijt and Wildert')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Dongen water chain',
  })).toContainText('Missing objects remain NoData')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Dongen physical lifelines',
  })).toContainText('never operator flows or outage forecasts')
  expect(errors).toEqual([])
})

test('keeps Drimmelen Amer, partial hydraulic, Biesbosch and lifeline scope unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Drimmelen' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Drimmelen Amer and rain',
  })
  await expect(waterGap).toContainText('Amer/Benedenrivieren')
  await expect(waterGap).toContainText('partial coverage')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Drimmelen Rupsenhoek fire',
  })).toContainText('does not lead its containing neighbourhood')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Drimmelen water chain',
  })).toContainText('Partial coverage and empty queries remain Unknown')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Drimmelen dispersed cores and Biesbosch',
  })).toContainText('Scenario-time passability')
  expect(errors).toEqual([])
})

test('keeps Druten Waal, Horssen, water-chain and external-care precision unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Druten' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Druten Waal and rain',
  })
  await expect(waterGap).toContainText('Zuidelijke Waaldijk')
  await expect(waterGap).toContainText('non-operational diagnostic')
  await expect(waterGap).toContainText('60 mm/one-hour')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Druten Horssen fire',
  })).toContainText('seventeenth of 26')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Druten water chain',
  })).toContainText('Missing coverage remains Unknown')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Druten Waal crossings and external care',
  })).toContainText('Proposed emergency support points and schools are not activated shelters')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Druten physical lifelines',
  })).toContainText('never operator flows or outage forecasts')
  expect(errors).toEqual([])
})

test('keeps Dronten polder, Roggebotzand and first-72-hour continuity unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Dronten' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dronten polder and rain',
  })
  await expect(waterGap).toContainText('IJssel–Ketelmeer–Reevediep')
  await expect(waterGap).toContainText('63.4 mm/hour')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Dronten Roggebotzand fire',
  })).toContainText('twelfth of 42')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Dronten polder drainage chain',
  })).toContainText('precise recovery requires event-time operator state')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Dronten crossings, visitors and external care',
  })).toContainText('authority action ledger')
  expect(errors).toEqual([])
})

test('corrects Drechterland N307/N506 provenance and keeps local hazard precision unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Drechterland' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Drechterland Markermeer and rain',
  })
  await expect(waterGap).toContainText('Lakenmanweg pump')
  await expect(waterGap).toContainText('non-operational diagnostics')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Drechterland Oosterleek fire',
  })).toContainText('eleventh of 27')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Transport provenance correction · Drechterland N307/N506',
  })).toContainText('removes N506 sections 285443011/014 from N307 provenance')

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Drechterland physical lifelines',
  })).toContainText('corrected N307/N506 provenance')
  expect(errors).toEqual([])
})

test('keeps Edam-Volendam Markermeer, Warder and first-72-hour continuity unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Edam-Volendam' })
  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Edam-Volendam Markermeer and rain',
  })
  await expect(waterGap).toContainText('Slobbeland')
  await expect(waterGap).toContainText('non-operational diagnostic')
  await expect(waterGap).toContainText('Rokersgracht')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Edam-Volendam Warder fire',
  })).toContainText('fourteenth of 29')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Edam-Volendam water and continuity',
  })).toContainText('Missing coverage remains Unknown')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Edam-Volendam bridges and continuity',
  })).toContainText('First-72-hour reachability')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Edam-Volendam physical lifelines',
  })).toContainText('not operator flows or outage forecasts')
  expect(errors).toEqual([])
})

test('keeps Duiven Rhine, Loo, InnoFase and service continuity unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Duiven' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Duiven Rhine system and rain',
  })
  await expect(waterGap).toContainText('Gemaal de Liemers')
  await expect(waterGap).toContainText('T100/T1000')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Duiven Loo fire',
  })).toContainText('eleventh of 14')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Duiven water and dewatering chain',
  })).toContainText('exact first-72-hour percentages are synthetic')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Unmodeled hazard scope · Duiven InnoFase and industry',
  })).toContainText('no industrial-release')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Duiven A12, rail and external care',
  })).toContainText('first-72-hour reachability')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Duiven physical lifelines',
  })).toContainText('live operator performance')
  expect(errors).toEqual([])
})

test('keeps Echt-Susteren Maas, woodland and cross-border continuity unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Echt-Susteren' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Echt-Susteren Maas and brooks',
  })
  await expect(waterGap).toContainText('Geleenbeek')
  await expect(waterGap).toContainText('non-operational diagnostic')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Echt-Susteren woodland fire',
  })).toContainText('twelfth of 58')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Echt-Susteren water chain',
  })).toContainText('Cross-border catchments and operators are absent')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Cross-border model gap · Echt-Susteren continuity',
  })).toContainText('German and Belgian roads')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Echt-Susteren physical lifelines',
  })).toContainText('German and Belgian dependencies are absent')
  expect(errors).toEqual([])
})

test('keeps Eemnes Eemmeer, Heidehoek and first-72-hour continuity unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Eemnes' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eemnes Eemmeer and rain',
  })
  await expect(waterGap).toContainText('74 mm/hour')
  await expect(waterGap).toContainText('non-operational diagnostic')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eemnes Heidehoek fire',
  })).toContainText('sixth of nine')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Eemnes managed-water chain',
  })).toContainText('Partial coverage and empty results remain Unknown')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Eemnes A1 and external care',
  })).toContainText('First-72-hour travel')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Eemnes physical lifelines',
  })).toContainText('municipality-level synthetic indices')
  expect(errors).toEqual([])
})

test('keeps Eemsdelta coast, earthquake, Woldendorp and Oosterhorn unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Eemsdelta' })
  await page.getByLabel('Disaster').selectOption('coastal-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eemsdelta Ems-Dollard coast',
  })).toContainText('non-operational diagnostic')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eemsdelta earthquake',
  })).toContainText('KNMI event ID')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eemsdelta Woldendorp fire',
  })).toContainText('seventieth of 92')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Eemsdelta coastal water chain',
  })).toContainText('security-sensitive coverage remains Unknown')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Unmodeled hazard scope · Eemsdelta Oosterhorn industry',
  })).toContainText('no industrial source-term')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Eemsdelta settlements, port and care',
  })).toContainText('First-72-hour passability')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Eemsdelta physical lifelines',
  })).toContainText('not operator flows or outage forecasts')
  expect(errors).toEqual([])
})

test('keeps Ede river, Reemst, transient people and accessibility semantics unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Ede' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Ede river and rain',
  })).toContainText('non-operational diagnostic')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Exposure-model gap · Ede transient population',
  })).toContainText('Veluwe visitors')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  const liveStatus = page.locator('.visually-hidden[role="status"]')
  await expect(liveStatus).toContainText('local result unavailable; spatial evidence unsupported')
  await expect(liveStatus).not.toContainText('available.')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Ede Reemst fire',
  })).toContainText('thirty-ninth of 71')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Ede water and drainage chain',
  })).toContainText('Missing coverage remains Unknown')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Ede Veluwe and first-72-hour continuity',
  })).toContainText('support-point locations remain under investigation')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Ede physical lifelines',
  })).toContainText('synthetic indices rather than operator forecasts')
  expect(errors).toEqual([])
})

test('keeps Elburg Randmeren, mixed-forest and water-chain state unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Elburg' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const floodGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Elburg Randmeren and rain',
  })
  await expect(floodGap).toContainText('about 0.75 m too high at Elburg')
  await expect(floodGap).toContainText('not an all-clear')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Elburg mixed-forest fire',
  })).toContainText('last of 22')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario-scope gap · Elburg historic-centre fire',
  })).toContainText('outside this nature-fire preset')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Elburg Randmeren water chain',
  })).toContainText('57 intersecting public records')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Elburg regional continuity',
  })).toContainText('Zero matched NDW records does not prove routes open')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Elburg physical lifelines',
  })).toContainText('synthetic indices, not operator forecasts')
  expect(errors).toEqual([])
})

test('keeps Enkhuizen lake evidence and Houtribdijk capacity non-additive', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Enkhuizen' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Enkhuizen lake, polder and rain',
  })
  await expect(waterGap).toContainText('non-operational diagnostic')
  await expect(waterGap).toContainText('70 mm in one hour')
  await expect(waterGap).toContainText('national 70 mm in two hours layer')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Enkhuizen Enkhuizerzand fire',
  })).toContainText('sixth of 19')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  const corridor = page.locator('.evidence-row.assumed').filter({
    hasText: 'Transport provenance correction · Enkhuizen Houtribdijk',
  })
  await expect(corridor).toContainText('N307, Markermeerdijk and Markerwaarddijk')
  await expect(corridor).toContainText('one NWB-road-307 physical corridor and one 150-unit ceiling')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Enkhuizen regional continuity',
  })).toContainText('Hoorn or Lelystad')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Enkhuizen water and pump chain',
  })).toContainText('13 main pumps, 94 pressure pumps')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Enkhuizen physical lifelines',
  })).toContainText('synthetic indices, not operator forecasts')
  expect(errors).toEqual([])
})

test('keeps Epe IJssel, Gortel and first-72-hour recovery unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Epe' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const floodGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Epe IJssel and rain',
  })
  await expect(floodGap).toContainText('3.14 m-class')
  await expect(floodGap).toContainText('not an all-clear')
  await expect(floodGap).toContainText('74 mm in one hour')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Epe Gortel forest fire',
  })).toContainText('twenty-third of 29')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Epe brooks and water chain',
  })).toContainText('143 intersecting HWH records')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Epe forest, settlements and external care',
  })).toContainText('First-72-hour resources, failed actions and restoration remain Unknown')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Epe physical lifelines',
  })).toContainText('synthetic indices, not operator forecasts')
  expect(errors).toEqual([])
})

test('keeps Emmen Bargerveen, earthquake and A37-B402 state unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Emmen' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const waterGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Emmen peat, brooks and rain',
  })
  await expect(waterGap).toContainText('zero only within those narrow source scopes')
  await expect(waterGap).toContainText('not an all-clear')
  await expect(waterGap).toContainText('empty national HWH coverage does not mean zero assets')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Emmen earthquake',
  })).toContainText('0.071 g-class')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario-scope gap · Emmen industry and mining',
  })).toContainText('must not be silently mapped to earthquake or cyberattack')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Emmen Bargerveen fire',
  })).toContainText('twenty-fourth of 83')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Emmen peat and water chain',
  })).toContainText('RWZI Emmen plus 54 main-watercourse and 137 pipeline')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Cross-border model gap · Emmen A37–B402 continuity',
  })).toContainText('shared validity-aligned authority/resource ledger')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Emmen physical lifelines',
  })).toContainText('German dependencies are absent')
  expect(errors).toEqual([])
})

test('keeps Eersel direct-major-river, Oeienbos and first-72-hour state unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Eersel' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const floodGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eersel rivers and rain',
  })
  await expect(floodGap).toContainText('false Rhine/Meuse/IJssel amplitude is suppressed')
  await expect(floodGap).toContainText('not an all-clear')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eersel Oeienbos fire',
  })).toContainText('last of 24')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Eersel pressure-sewer and water chain',
  })).toContainText('483 pump units and 107.2 km')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Eersel A67 and external care',
  })).toContainText('resource/action ledger')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Eersel physical lifelines',
  })).toContainText('synthetic indices, not operator forecasts')
  expect(errors).toEqual([])
})

test('keeps Eijsden-Margraten Maas, Savelsbos and cross-border state unresolved', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Eijsden-Margraten' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eijsden-Margraten Maas and Noor',
  })).toContainText('Belgian/French upstream hydrograph')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eijsden-Margraten Savelsbos fire',
  })).toContainText('twelfth of 34')

  await page.getByLabel('Disaster').selectOption('earthquake')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario scope gap · Eijsden-Margraten underground and industrial hazards',
  })).toContainText('must not be silently mapped to earthquake or cyberattack')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Eijsden-Margraten cross-border water chain',
  })).toContainText('No match remains Unknown')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Eijsden-Margraten cross-border continuity',
  })).toContainText('shared NL-BE authority/resource ledger')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Eijsden-Margraten physical lifelines',
  })).toContainText('Belgian physical and operational dependencies are absent')
  expect(errors).toEqual([])
})

test('keeps Eindhoven water, Gennep and A2 first-72-hour evidence scoped', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Eindhoven' })
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  const floodGap = page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eindhoven rivers and drainage',
  })
  await expect(floodGap).toContainText('false Rhine/Meuse/IJssel amplitude is suppressed')
  await expect(floodGap).toContainText('not an all-clear')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario-scope gap · Eindhoven airport, Brainport and complex incidents',
  })).toContainText('not selectable source-term')

  await page.getByLabel('Disaster').selectOption('wildfire')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Scenario evidence gap · Eindhoven Gennep fire',
  })).toContainText('112th of 116')

  await page.getByRole('button', { name: 'Drainage & surface water: Drainage availability' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Service-model gap · Eindhoven sewer and Dommel chain',
  })).toContainText('diameter zero and empty national HWH/provider subsets remain Unknown')

  await page.getByRole('button', { name: 'Roads & mobility: Accessible capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Transport provenance correction · Eindhoven A2 ramp',
  })).toContainText('A2/RW2 access-ramp class OPR')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Transport provenance correction · Eindhoven A2 ramp',
  })).toContainText('instead of appearing as a third route named 002')

  await page.getByRole('button', { name: 'Critical facilities: Operational capacity' }).click()
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Access-model gap · Eindhoven regional continuity',
  })).toContainText('action ledger')
  await expect(page.locator('.evidence-row.assumed').filter({
    hasText: 'Network-model boundary · Eindhoven physical lifelines',
  })).toContainText('synthetic indices, not operator forecasts')
  expect(errors).toEqual([])
})

test('keeps the latest municipality-audit results visibly unavailable', async ({ page }) => {
  test.setTimeout(90_000)
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()

  // Keep this browser gate as a rolling recent sample; the unit matrix above
  // retains every integrated municipality without making the UI test unbounded.
  for (const [name, evidence] of [
    ['Landsmeer', 'empty logical road graph'],
    ['Landgraaf', 'post-coal-mining uplift'],
    ['Lansingerland', 'Eendragtspolder and Bergboezem actions'],
    ['Laren (NH.)', 'high-area infiltration'],
    ['Leeuwarden', 'precise catastrophic local result'],
    ['Leiden', 'managed Oude Rijn/boezem municipality'],
    ['Leiderdorp', 'primary, regional and polder/boezem pathways'],
    ['Leidschendam-Voorburg', 'Rhine/Vliet/boezem pathway'],
    ['Lelystad', 'IJsselmeer/Markermeer defence breach'],
    ['Leudal', 'Maas, defence and groundwater pathways'],
    ['Leusden', 'plausible dike-ring-45 threat'],
    ['Lingewaard', 'Waal, Pannerdensch Kanaal or Nederrijn event'],
    ['Lisse', 'dike-trajectory-14 failure scenario'],
    ['Lochem', 'geographically bounded IJssel defence-failure mechanism'],
    ['Loon op Zand', 'conditional north-west Loon op Zand Maas-breach case'],
    ['Lopik', 'locally plausible Lek flood'],
    ['Maasdriel', 'physically plausible major-river threat'],
    ['Losser', 'without local Rhine, Meuse or IJssel evidence'],
    ['Maasgouw', 'Maas/canal boundary, defence-reach or connected-footprint state'],
  ] as const) {
    await page.getByLabel('Open municipality').selectOption({ label: name })
    await expect(page.locator('.inspector-header h2')).toContainText(name)
    await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
    await expect(page.locator('.evidence-row.assumed').filter({ hasText: evidence })).toContainText(
      'river-flood municipality result remains Unknown',
    )
  }

  expect(errors).toEqual([])
})

test('preserves Baarle-Nassau enclave topology and suppresses false major-river precision', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Baarle-Nassau' })
  await expect(page.getByText('Audited full-resolution boundary', { exact: true })).toBeVisible()
  await expect(page.getByText(/preserves Baarle-Nassau's 9 components and 22 Belgian enclave holes/)).toBeVisible()

  const readBoundaryState = () => page.evaluate(() => {
    const map = (window as Window & {
      __resilienceMap?: {
        getLayoutProperty(layer: string, property: string): unknown
        getLayer(id: string): unknown
        getSource(id: string): { serialize(): { data?: { features?: Array<{ geometry?: { type?: string; coordinates?: unknown[] } }> } } } | undefined
      }
    }).__resilienceMap!
    const geometry = map.getSource('city-operational-boundary')?.serialize().data?.features?.[0]?.geometry
    const coordinates = geometry?.coordinates ?? []
    const polygons = geometry?.type === 'Polygon' ? [coordinates] : coordinates
    const rings = polygons.reduce((sum, polygon) => sum + (Array.isArray(polygon) ? polygon.length : 0), 0)
    return {
      components: polygons.length,
      rings,
      visibility: map.getLayer('city-operational-boundary-outline')
        ? map.getLayoutProperty('city-operational-boundary-outline', 'visibility')
        : 'not-ready',
    }
  })
  await expect.poll(readBoundaryState).toMatchObject({ components: 9, rings: 31 })
  const boundaryState = await readBoundaryState()
  expect(boundaryState.visibility).not.toBe('none')

  await page.getByLabel('Disaster').selectOption('river-flood')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await page.getByRole('slider', { name: /Simulation time/ }).fill('288')
  await expect(page.locator('.status-hero-copy')).toContainText('Local result unavailable')
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('cross-border water-system dependencies remain unresolved, not safe')
  expect(errors).toEqual([])
})

test('preserves Arnhem wildfire smoke while marking centroid-missed direct flame unknown', async ({ page }) => {
  const errors = captureErrors(page)
  await page.goto(appPath)
  await page.getByLabel('Open municipality').selectOption({ label: 'Arnhem' })
  await page.getByLabel('Disaster').selectOption('wildfire')
  await page.getByRole('button', { name: 'Hazard forcing: Scenario severity' }).click()
  await page.getByRole('slider', { name: /Simulation time/ }).fill('96')

  await expect(page.getByText('Smoke', { exact: true })).toBeVisible()
  await expect(page.getByText('Direct flame', { exact: true })).toBeVisible()
  await expect(page.getByText('Direct flame', { exact: true }).locator('..')).toContainText('Unknown')
  await expect(page.locator('.evidence-row.assumed').filter({ hasText: 'Known pathway' }))
    .toContainText('spatially unresolved, not zero')
  expect(errors).toEqual([])
})

test('enters city detail immediately and returns to the national model', async ({ page }) => {
  const errors = captureErrors(page)
  await page.setViewportSize({ width: 2560, height: 1440 })
  await page.goto(appPath, { waitUntil: 'domcontentloaded' })

  const municipality = page.getByLabel('Open municipality')
  await municipality.waitFor()
  const regionBundle = page.waitForResponse((response) =>
    response.url().endsWith('/data/regions/GM0363.json.gz'),
  )
  const settlementBundle = page.waitForResponse((response) =>
    response.url().endsWith('/data/settlements/GM0363.geojson.gz'),
  )
  await municipality.selectOption({ label: 'Amsterdam' })
  expect((await regionBundle).status()).toBe(200)
  expect((await settlementBundle).status()).toBe(200)
  await expect(page.locator('.inspector .eyebrow')).toHaveText('Municipal simulation')
  await expect(page.locator('.inspector h2')).toHaveText('Amsterdam')
  await expect(page.getByText('network flow')).toBeVisible()

  await page.getByRole('button', { name: 'National', exact: true }).click()
  await expect(page.locator('.inspector .eyebrow')).toHaveText('National gateway')
  await expect(page.locator('.mode-breadcrumb button.active')).toContainText('Netherlands')
  expect(errors).toEqual([])
})

test('keeps mobile navigation reachable and preserves an edge district selection', async ({ page }) => {
  const errors = captureErrors(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(appPath)

  await page.getByLabel('Open municipality').selectOption({ label: 'Amsterdam' })
  await page.getByRole('button', { name: 'Open operations menu' }).click()
  await expect(page.getByTitle('Reset national view')).toBeVisible()
  await page.getByRole('button', { name: 'Close operations menu' }).click()
  await page.waitForTimeout(1_200)

  const mapTools = page.getByRole('button', { name: 'Open map view and overlays' })
  await expect(mapTools).toBeVisible()
  await expect(mapTools).toHaveAttribute('aria-expanded', 'false')

  // Real CBS buurt polygons replace the old six schematic sectors. Selecting a
  // rendered polygon must open and retain that official region in the inspector.
  const canvas = page.locator('.maplibregl-canvas')
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  await canvas.click({ position: { x: bounds!.width / 2, y: bounds!.height / 2 } })
  const selectedRegion = page.locator('.inspector.mobile-open h2')
  await expect(selectedRegion).toBeVisible()
  const regionName = await selectedRegion.textContent()
  expect(regionName).toBeTruthy()
  await expect(page.getByText('Official buurt context · 2025')).toBeVisible()
  await page.waitForTimeout(600)
  await expect(selectedRegion).toHaveText(regionName!)

  await page.getByRole('button', { name: 'Close details' }).click()
  const zoomOut = page.getByTitle('Zoom out')
  await expect(zoomOut).toBeVisible()
  await zoomOut.click({ trial: true })

  await page.getByRole('button', { name: 'Open operations menu' }).click()
  await page.getByTitle('Reset national view').click()
  await expect(page.locator('.inspector .eyebrow')).toHaveText('National gateway')
  expect(errors).toEqual([])
})
