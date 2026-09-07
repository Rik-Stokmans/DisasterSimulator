import { chromium } from '@playwright/test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, 'showcase.html')
const pdfOutput = path.join(here, 'DisasterSimulator-showcase.pdf')
const pngOutput = path.join(here, 'DisasterSimulator-showcase.png')

const browser = await chromium.launch({ headless: true })

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  })
  await page.goto(pathToFileURL(source).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)

  const requiredCopy = [
    'Project member',
    'The problem',
    'Target group',
    'What I developed',
    'How I tested whether it could work',
    'Most important learning',
  ]
  const renderedText = (await page.locator('#showcase').textContent()) ?? ''
  const missingCopy = requiredCopy.filter((text) => !renderedText.includes(text))
  if (missingCopy.length) {
    throw new Error(`Required showcase copy is missing: ${missingCopy.join(', ')}`)
  }

  const imageProblems = await page.locator('#showcase img').evaluateAll((images) =>
    images.flatMap((image) => image.complete && image.naturalWidth > 0
      ? []
      : [image.getAttribute('src') ?? 'unknown image']),
  )
  if (imageProblems.length) {
    throw new Error(`Showcase images failed to load: ${imageProblems.join(', ')}`)
  }

  const layoutProblems = await page.locator('#showcase').evaluate((sheet) => {
    const sheetBounds = sheet.getBoundingClientRect()
    const tolerance = 2
    const problems = []
    for (const element of sheet.querySelectorAll('.topbar, .main, .story, .visual, .metrics, .bottom, .tested, .learned, .footer')) {
      const bounds = element.getBoundingClientRect()
      if (bounds.width === 0 || bounds.height === 0) continue
      if (bounds.left < sheetBounds.left - tolerance || bounds.top < sheetBounds.top - tolerance ||
          bounds.right > sheetBounds.right + tolerance || bounds.bottom > sheetBounds.bottom + tolerance) {
        problems.push(element.className || element.tagName.toLowerCase())
      }
    }
    for (const element of sheet.querySelectorAll('[data-overflow-check]')) {
      if (element.scrollWidth > element.clientWidth + tolerance ||
          element.scrollHeight > element.clientHeight + tolerance) {
        problems.push(`${element.className || element.tagName.toLowerCase()} (overflow)`)
      }
    }
    return [...new Set(problems)]
  })
  if (layoutProblems.length) {
    throw new Error(`Showcase layout overflow detected: ${layoutProblems.join(', ')}`)
  }

  await page.locator('#showcase').screenshot({ path: pngOutput })

  await page.emulateMedia({ media: 'print' })
  await page.pdf({
    path: pdfOutput,
    width: '13.333in',
    height: '7.5in',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  })

  console.log(`Built ${path.relative(process.cwd(), pdfOutput)}`)
  console.log(`Built ${path.relative(process.cwd(), pngOutput)}`)
} finally {
  await browser.close()
}
