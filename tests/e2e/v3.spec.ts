import { expect, test } from '@playwright/test'
import { observeBrowserDiagnostics, openReadyApp } from './support'

test.describe.configure({ mode: 'serial' })

test('shows an official safety region and a structured causal trace', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  const safetyRegionResponse = page.waitForResponse((response) =>
    response.url().includes('/data/safety-regions.geojson'),
  )

  await openReadyApp(page)

  const response = await safetyRegionResponse
  expect(response.ok()).toBe(true)
  const collection = await response.json() as {
    features: Array<{
      properties: { name: string; municipalityCodes: string[] }
    }>
  }
  expect(collection.features).toHaveLength(25)
  expect(
    collection.features.find((feature) =>
      feature.properties.municipalityCodes.includes('GM0772'),
    )?.properties.name,
  ).toBe('Brabant-Zuidoost')

  const inspector = page.getByRole('complementary', { name: 'Selected location details' })
  await expect(inspector.getByText(/VR Brabant-Zuidoost/)).toBeVisible()
  await expect(inspector.getByText('Official response geography', { exact: true })).toBeVisible()
  await expect(inspector.getByText('Safety region Brabant-Zuidoost · CBS/PDOK 2025')).toBeVisible()

  await expect(inspector.getByRole('heading', { name: 'Why this state?' })).toBeVisible()
  await expect(inspector.getByRole('list', { name: 'Largest model contributions' })).toBeVisible()
  await expect(inspector.getByText('What-if checks', { exact: true })).toBeVisible()
  await expect(
    inspector.getByText('What would local availability be without direct event damage?'),
  ).toBeVisible()
  await expect(inspector.getByText(/exact stage substitution/).first()).toBeVisible()

  diagnostics.assertClean()
})

test('changes an advanced assumption and exposes that exact driver in the explanation', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  await openReadyApp(page)

  await page.getByRole('button', { name: 'Electricity: Service availability' }).click()
  await page.getByRole('button', { name: /Advanced/ }).click()

  const dialog = page.getByRole('dialog', { name: 'Operational assumptions' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '')
  const demand = dialog.getByRole('slider', { name: /System demand/ })
  await expect(demand).toHaveValue('1')
  await demand.fill('1.6')
  await expect(demand).toHaveValue('1.6')
  await expect(dialog.getByText('1.60×', { exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '')

  const inspector = page.getByRole('complementary', { name: 'Selected location details' })
  const driverDisclosure = inspector.getByText(/Inspect \d+ drivers & methods/)
  await driverDisclosure.click()
  const demandDriver = inspector.getByText('Operations demand', { exact: true })
  await expect(demandDriver).toBeVisible()
  const demandDriverRow = demandDriver.locator('../..')
  await expect(demandDriverRow).toContainText('1.60 ×')
  await expect(demandDriverRow).toContainText('editable')

  diagnostics.assertClean()
})

test('builds a complete 72-hour history and graphs all 36 official fields', async ({ page }) => {
  test.setTimeout(45_000)
  const diagnostics = observeBrowserDiagnostics(page)
  await openReadyApp(page)

  const timeline = page.getByRole('slider', { name: /Simulation time/ })
  await timeline.fill('288')
  await expect(page.getByText('T+72:00', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Open analytics and evidence' }).click()
  const dialog = page.getByRole('dialog', { name: 'Analytics & evidence' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '')
  await expect(dialog.getByText(/25 full-network states · 3h interval/)).toBeVisible({ timeout: 20_000 })
  await expect(dialog.getByRole('heading', { name: 'All modeled statistics · Eindhoven' })).toBeVisible()
  await expect(dialog.getByText(/25 supplied frames · 0\.00–72\.00 h/)).toBeVisible()
  await expect(dialog.getByRole('img', { name: /over the first 72 hours/ }).first()).toBeVisible()
  await expect(dialog.getByText('now', { exact: true }).first()).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Filter simulation statistics by category' }).selectOption('all')
  await expect(dialog.getByText('60 graphs', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('article')).toHaveCount(60)
  await expect(dialog.getByRole('article').filter({
    hasText: 'Modeled residents under pressure',
  })).toContainText('Current post-network equivalent resident count')
  const localBurdenCards = dialog.getByRole('article').filter({
    hasText: 'Local pre-network deprived person-hours',
  })
  await expect(localBurdenCards.first()).toContainText('excludes intermunicipal logical transfers')

  await dialog.getByRole('button', { name: '36 official statistics' }).click()
  await expect(dialog.getByRole('heading', { name: 'All 36 official statistics · Eindhoven' })).toBeVisible()
  await expect(dialog.getByText('36 of 36 graphs', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('article')).toHaveCount(36)

  const search = dialog.getByRole('searchbox', { name: 'Search all 36 official statistics' })
  await search.fill('doctor')
  await expect(dialog.getByText('1 of 36 graphs', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Distance to general practitioner' })).toBeVisible()
  await expect(dialog.getByRole('article')).toHaveCount(1)

  await search.fill('')
  await dialog.getByRole('combobox', { name: 'Filter official statistics by category' }).selectOption('housing')
  await expect(dialog.getByText('9 of 36 graphs', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('article')).toHaveCount(9)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '')
  await page.getByRole('button', { name: 'Open analytics and evidence' }).click()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-history-cache-hit', 'true')
  const cachedDuration = Number(
    await page.locator('.app-shell').getAttribute('data-history-duration-ms'),
  )
  expect(cachedDuration).toBeLessThan(50)
  await page.getByRole('button', { name: 'Close analytics' }).click()
  diagnostics.assertClean()
})

test('honors reduced motion for map and modal animation loops', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window)
    ;(window as Window & { __e2eRafCount?: number }).__e2eRafCount = 0
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      originalRequestAnimationFrame((time) => {
        const state = window as Window & { __e2eRafCount?: number }
        state.__e2eRafCount = (state.__e2eRafCount ?? 0) + 1
        callback(time)
      })
  })

  await openReadyApp(page)
  expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  await page.waitForTimeout(1_000)
  await page.evaluate(() => {
    ;(window as Window & { __e2eRafCount?: number }).__e2eRafCount = 0
  })
  await page.waitForTimeout(400)
  const idleAnimationFrames = await page.evaluate(
    () => (window as Window & { __e2eRafCount?: number }).__e2eRafCount ?? 0,
  )
  expect(idleAnimationFrames).toBeLessThanOrEqual(3)

  await page.getByRole('button', { name: 'Open analytics and evidence' }).click()
  const analytics = page.getByRole('dialog', { name: 'Analytics & evidence' })
  await expect(analytics).toBeVisible()
  expect(await analytics.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await page.getByRole('button', { name: 'Close analytics' }).click()

  await page.getByRole('button', { name: /Advanced/ }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await expect(assumptions).toBeVisible()
  expect(await assumptions.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await page.getByRole('button', { name: 'Close operational assumptions' }).click()

  diagnostics.assertClean()
})

test('keeps V3 controls and analytics usable in the mobile viewport', async ({ page }) => {
  const diagnostics = observeBrowserDiagnostics(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await openReadyApp(page)

  const analyticsButton = page.getByRole('button', { name: 'Open analytics and evidence' })
  await expect(analyticsButton).toBeVisible()
  await analyticsButton.click()
  const analytics = page.getByRole('dialog', { name: 'Analytics & evidence' })
  await expect(analytics).toBeVisible()
  const analyticsBox = await analytics.boundingBox()
  expect(analyticsBox).not.toBeNull()
  expect(analyticsBox!.x).toBeGreaterThanOrEqual(0)
  expect(analyticsBox!.y).toBeGreaterThanOrEqual(0)
  expect(analyticsBox!.width).toBeLessThanOrEqual(375)
  expect(analyticsBox!.height).toBeLessThanOrEqual(812)
  await expect(analytics.getByRole('navigation', { name: 'Analytics views' })).toBeVisible()
  await analytics.getByRole('button', { name: '36 official statistics' }).click()
  await expect(analytics.getByRole('searchbox', { name: 'Search all 36 official statistics' })).toBeVisible()
  await analytics.getByRole('button', { name: 'Close analytics' }).click()

  await page.getByRole('button', { name: /Advanced/ }).click()
  const assumptions = page.getByRole('dialog', { name: 'Operational assumptions' })
  await expect(assumptions).toBeVisible()
  const assumptionsBox = await assumptions.boundingBox()
  expect(assumptionsBox).not.toBeNull()
  expect(assumptionsBox!.x).toBeGreaterThanOrEqual(0)
  expect(assumptionsBox!.y).toBeGreaterThanOrEqual(0)
  expect(assumptionsBox!.width).toBeLessThanOrEqual(375)
  expect(assumptionsBox!.height).toBeLessThanOrEqual(812)
  await expect(assumptions.getByRole('slider', { name: /Household preparedness/ })).toBeVisible()
  await assumptions.getByRole('button', { name: 'Close operational assumptions' }).click()

  await expect(page.getByRole('button', { name: /Details · Eindhoven/ })).toBeVisible()
  diagnostics.assertClean()
})
