import { expect, type Page } from '@playwright/test'

export const appPath = process.env.WARROOM_BASE_PATH
  ? `${process.env.WARROOM_BASE_PATH.replace(/\/+$/, '')}/`
  : '/'

/**
 * Collect failures that can otherwise be easy to miss in a canvas-heavy UI.
 * The returned assertion is intentionally called at the end of each test so
 * asynchronous worker and MapLibre errors are included.
 */
export function observeBrowserDiagnostics(page: Page) {
  const errors: string[] = []
  const failedLocalResponses: string[] = []

  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('response', (response) => {
    if (
      response.status() >= 400 &&
      /127\.0\.0\.1|localhost/.test(response.url())
    ) {
      failedLocalResponses.push(`${response.status()} ${response.url()}`)
    }
  })

  return {
    errors,
    failedLocalResponses,
    assertClean() {
      expect(errors, 'browser console and uncaught errors').toEqual([])
      expect(failedLocalResponses, 'failed same-origin app/data/worker responses').toEqual([])
    },
  }
}

export async function openReadyApp(page: Page) {
  await page.goto(appPath)
  await expect(page.getByRole('navigation', { name: 'Simulation map layers' })).toBeVisible()
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()
}
