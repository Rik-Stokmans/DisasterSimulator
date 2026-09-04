import { chromium } from '@playwright/test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, 'overview.html')
const output = path.join(here, 'NL-Resilience-Lab-overview.pdf')

const browser = await chromium.launch({ headless: true })

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  await page.goto(pathToFileURL(source).href, { waitUntil: 'networkidle' })
  await page.emulateMedia({ media: 'print' })

  const issues = await page.locator('.slide').evaluateAll((slides) => slides.flatMap((slide, index) => {
    const bounds = slide.getBoundingClientRect()
    const outside = []
    for (const element of slide.querySelectorAll(':scope > *, .content > *')) {
      if (element.matches('.notes')) continue
      const rect = element.getBoundingClientRect()
      const tolerance = 2
      if (rect.left < bounds.left - tolerance || rect.top < bounds.top - tolerance ||
          rect.right > bounds.right + tolerance || rect.bottom > bounds.bottom + tolerance) {
        outside.push(element.className || element.tagName.toLowerCase())
      }
    }
    return outside.length ? [{ slide: index + 1, outside }] : []
  }))

  if (issues.length) {
    throw new Error(`Presentation overflow detected:\n${JSON.stringify(issues, null, 2)}`)
  }

  await page.pdf({
    path: output,
    width: '13.333in',
    height: '7.5in',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  })

  console.log(`Built ${path.relative(process.cwd(), output)}`)
} finally {
  await browser.close()
}
