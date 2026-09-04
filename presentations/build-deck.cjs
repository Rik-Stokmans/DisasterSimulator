const pptxgen = require('pptxgenjs')
const path = require('node:path')

const pptx = new pptxgen()
pptx.layout = 'LAYOUT_WIDE'
pptx.author = 'Rik Stokmans'
pptx.company = 'Fontys'
pptx.subject = 'NL Resilience Lab — project overview, simulation model and data couplings'
pptx.title = 'NL Resilience Lab — Disaster Simulator'
pptx.lang = 'en-US'
pptx.theme = {
  headFontFace: 'Avenir Next',
  bodyFontFace: 'Avenir Next',
  lang: 'en-US',
}
pptx.defineSlideMaster({
  title: 'MASTER_DARK',
  background: { color: '071216' },
  objects: [],
  slideNumber: { x: 12.16, y: 7.05, w: 0.52, h: 0.18, color: '668087', fontFace: 'Avenir Next', fontSize: 8, align: 'right' },
})

const W = 13.333
const H = 7.5
const C = {
  bg: '071216',
  panel: '0D1C21',
  panel2: '12272D',
  line: '294047',
  white: 'F4F7F6',
  muted: '9BB0B5',
  dim: '688087',
  mint: '65E2CB',
  cyan: '59D5F6',
  purple: 'B784F5',
  amber: 'F4B85D',
  coral: 'F56F7C',
  green: '89D49A',
}

const img = (name) => path.join(__dirname, '..', 'artifacts', name)
const output = path.join(__dirname, 'NL-Resilience-Lab-overview.pptx')
const framedSlides = []

function addText(slide, text, x, y, w, h, opts = {}) {
  slide.addText(text, {
    x, y, w, h,
    margin: 0,
    fontFace: 'Avenir Next',
    fontSize: 15,
    color: C.white,
    breakLine: false,
    valign: 'mid',
    fit: 'shrink',
    ...opts,
  })
}

function rect(slide, x, y, w, h, fill, radius = 0.12, line = fill) {
  slide.addShape(radius > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
    x, y, w, h,
    rectRadius: radius,
    fill: { color: fill },
    line: { color: line, width: line === fill ? 0 : 1 },
  })
}

function line(slide, x1, y1, x2, y2, color = C.line, width = 1, dash = 'solid') {
  slide.addShape(pptx.ShapeType.line, {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
    line: { color, width, dashType: dash, beginArrowType: 'none', endArrowType: 'none' },
  })
}

function arrow(slide, x1, y1, x2, y2, color = C.mint, width = 1.5, dash = 'solid') {
  slide.addShape(pptx.ShapeType.line, {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
    line: { color, width, dashType: dash, beginArrowType: 'none', endArrowType: 'triangle' },
  })
}

function circle(slide, x, y, d, fill, lineColor = fill, lineWidth = 0) {
  slide.addShape(pptx.ShapeType.ellipse, {
    x, y, w: d, h: d,
    fill: { color: fill },
    line: { color: lineColor, width: lineWidth },
  })
}

function pill(slide, text, x, y, w, color = C.mint, fill = C.panel2, opts = {}) {
  rect(slide, x, y, w, 0.34, fill, 0.17, C.line)
  circle(slide, x + 0.14, y + 0.125, 0.09, color)
  addText(slide, text, x + 0.32, y + 0.05, w - 0.42, 0.24, {
    fontSize: opts.fontSize ?? 9.5,
    color: C.white,
    bold: true,
    charSpacing: 0.2,
  })
}

function addBrand(slide, x = 0.55, y = 0.32) {
  circle(slide, x, y, 0.34, C.panel2, C.mint, 1)
  circle(slide, x + 0.103, y + 0.09, 0.13, C.bg, C.mint, 1)
  line(slide, x + 0.17, y + 0.07, x + 0.17, y + 0.27, C.mint, 1.2)
}

function addFrame(slide, section, number, opts = {}) {
  slide.background = { color: opts.background ?? C.bg }
  framedSlides.push({ slide, section })
}

function addFrameChrome(slide, section) {
  addBrand(slide)
  addText(slide, 'NL RESILIENCE LAB', 0.98, 0.34, 2.2, 0.22, {
    fontSize: 9,
    bold: true,
    color: C.muted,
    charSpacing: 1.4,
  })
  addText(slide, section.toUpperCase(), 9.9, 0.34, 2.75, 0.22, {
    fontSize: 8.5,
    bold: true,
    color: C.dim,
    align: 'right',
    charSpacing: 1.25,
  })
  line(slide, 0.55, 0.82, 12.23, 0.82, C.line, 0.7)
}

function title(slide, kicker, heading, subheading) {
  addText(slide, kicker.toUpperCase(), 0.65, 1.04, 2.6, 0.22, {
    fontSize: 9,
    bold: true,
    color: C.mint,
    charSpacing: 1.65,
  })
  addText(slide, heading, 0.65, 1.3, 12.0, 0.62, {
    fontSize: 29,
    bold: true,
    color: C.white,
  })
  if (subheading) addText(slide, subheading, 0.65, 1.91, 11.8, 0.43, {
    fontSize: 12.5,
    color: C.muted,
  })
}

function footerSource(slide, textValue, url) {
  addText(slide, textValue, 0.65, 7.05, 9.5, 0.18, {
    fontSize: 7.6,
    color: C.dim,
    hyperlink: url ? { url } : undefined,
  })
}

function imageCrop(slide, file, x, y, w, h, imageW, imageH, crop = {}) {
  // PptxGenJS calculates the OOXML crop from addImage's original w/h. Give it
  // a cover-scaled source rectangle, then crop that rectangle to the frame.
  // Passing the frame size as both the original and target size produces an
  // empty srcRect and stretches the bitmap in PowerPoint.
  const sourceRatio = imageW / imageH
  const frameRatio = w / h
  const focusX = Math.min(1, Math.max(0, crop.focusX ?? 0.5))
  const focusY = Math.min(1, Math.max(0, crop.focusY ?? 0.5))
  const scaledW = sourceRatio > frameRatio ? h * sourceRatio : w
  const scaledH = sourceRatio > frameRatio ? h : w / sourceRatio
  const cropX = Math.min(scaledW - w, Math.max(0, focusX * scaledW - w / 2))
  const cropY = Math.min(scaledH - h, Math.max(0, focusY * scaledH - h / 2))

  slide.addImage({
    path: file,
    x,
    y,
    w: scaledW,
    h: scaledH,
    sizing: { type: 'crop', x: cropX, y: cropY, w, h },
  })
  if (crop.border !== false) {
    slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: 'FFFFFF', transparency: 100 }, line: { color: C.line, width: 1 } })
  }
}

function card(slide, x, y, w, h, heading, body, accent = C.mint, opts = {}) {
  rect(slide, x, y, w, h, opts.fill ?? C.panel, 0.14, opts.line ?? C.line)
  rect(slide, x, y, 0.055, h, accent, 0, accent)
  addText(slide, heading.toUpperCase(), x + 0.26, y + 0.19, w - 0.45, 0.24, {
    fontSize: 9.5,
    bold: true,
    color: accent,
    charSpacing: 1.0,
  })
  addText(slide, body, x + 0.26, y + 0.53, w - 0.46, h - 0.68, {
    fontSize: opts.bodySize ?? 12.2,
    color: opts.bodyColor ?? C.white,
    valign: 'top',
    breakLine: true,
    paraSpaceAfterPt: 8,
  })
}

function numberedStep(slide, n, heading, body, x, y, w, accent = C.mint) {
  circle(slide, x, y, 0.4, C.panel2, accent, 1)
  addText(slide, String(n), x, y + 0.02, 0.4, 0.34, { fontSize: 11, bold: true, align: 'center', color: accent })
  addText(slide, heading, x + 0.55, y - 0.01, w - 0.55, 0.27, { fontSize: 12.2, bold: true })
  addText(slide, body, x + 0.55, y + 0.26, w - 0.55, 0.45, { fontSize: 9.5, color: C.muted, valign: 'top' })
}

// 01 — Cover
{
  const slide = pptx.addSlide('MASTER_DARK')
  imageCrop(slide, img('gatekeeper-v2.png'), 7.15, 0, 6.18, 7.5, 1920, 1200, { focusX: 0.58, focusY: 0.5, border: false })
  slide.addShape(pptx.ShapeType.rect, { x: 6.35, y: 0, w: 2.4, h: 7.5, fill: { color: C.bg, transparency: 20 }, line: { color: C.bg, transparency: 100 } })
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 7.4, h: 7.5, fill: { color: C.bg }, line: { color: C.bg } })
  addBrand(slide, 0.72, 0.64)
  addText(slide, 'NL RESILIENCE LAB', 1.18, 0.7, 3.1, 0.25, { fontSize: 10, bold: true, charSpacing: 1.8, color: C.mint })
  addText(slide, 'Exploring the\nfirst 72 hours', 0.72, 1.75, 6.0, 1.55, { fontSize: 36, bold: true, valign: 'top', breakLine: true, breakLineOnTextOverflow: false })
  addText(slide, 'A transparent disaster-cascade simulator for the Netherlands', 0.75, 3.52, 5.75, 0.72, { fontSize: 17, color: C.muted, valign: 'top' })
  pill(slide, 'SCENARIO EXPLORATION', 0.75, 4.55, 2.28, C.cyan, C.panel2, { fontSize: 8.5 })
  pill(slide, 'EXPLAINABLE MODEL', 3.15, 4.55, 2.12, C.purple, C.panel2, { fontSize: 8.5 })
  pill(slide, 'OFFICIAL DUTCH DATA', 0.75, 5.0, 2.28, C.amber, C.panel2, { fontSize: 8.5 })
  addText(slide, 'Rik Stokmans  /  DisasterSimulator', 0.75, 6.58, 4.6, 0.22, { fontSize: 9.5, color: C.muted })
  addText(slide, 'github.com/Rik-Stokmans/DisasterSimulator', 0.75, 6.9, 4.9, 0.2, { fontSize: 8.2, color: C.mint, hyperlink: { url: 'https://github.com/Rik-Stokmans/DisasterSimulator' } })
  slide.addNotes('Opening: The project asks what happens after the initial hazard—when essential services start depending on one another. It is an interactive scenario-exploration prototype, not a forecast or calibrated digital twin.')
}

// 02 — Framing
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Problem framing', 2)
  title(slide, 'Why', 'A disaster is not one failure.', 'It is a sequence of dependencies, delays and constrained choices.')
  const labels = [
    ['01', 'INITIATING EVENT', 'Wind, water, heat, cyber, ground motion or fire', C.cyan],
    ['02', 'SERVICE CASCADE', 'Power, telecom, water, mobility and supply degrade on different clocks', C.purple],
    ['03', 'HUMAN PRESSURE', 'Consequences emerge from duration, geography and response—not severity alone', C.coral],
  ]
  labels.forEach((v, i) => {
    const x = 0.7 + i * 4.18
    rect(slide, x, 2.65, 3.72, 2.55, C.panel, 0.16, C.line)
    addText(slide, v[0], x + 0.28, 2.9, 0.62, 0.35, { fontSize: 19, bold: true, color: v[3] })
    addText(slide, v[1], x + 0.28, 3.45, 3.15, 0.32, { fontSize: 10, bold: true, color: v[3], charSpacing: 1.05 })
    addText(slide, v[2], x + 0.28, 3.92, 3.15, 0.85, { fontSize: 13, color: C.white, valign: 'top' })
    if (i < 2) arrow(slide, x + 3.8, 3.92, x + 4.08, 3.92, C.mint, 1.5)
  })
  rect(slide, 0.7, 5.66, 11.95, 0.82, C.panel2, 0.14, C.line)
  addText(slide, 'CORE QUESTION', 0.98, 5.92, 1.35, 0.24, { fontSize: 9.2, bold: true, color: C.mint, charSpacing: 1.1 })
  addText(slide, 'How does the system evolve—and which intervention changes the outcome?', 2.53, 5.84, 9.65, 0.38, { fontSize: 17, bold: true })
  slide.addNotes('Frame the project around cascades. The simulator does not just color a hazard map; it steps through how service availability, reserves, repair and transport access interact across 72 hours.')
}

// 03 — At a glance
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Project overview', 3)
  title(slide, 'Overview', 'The simulator at a glance', 'A national model that stays inspectable down to municipality and CBS neighbourhood scale.')
  const stats = [
    ['342', 'MUNICIPALITIES', C.mint],
    ['72 h', 'SIMULATION WINDOW', C.cyan],
    ['289', '15-MINUTE STATES', C.purple],
    ['10', 'SCENARIO PRESETS', C.amber],
    ['8', 'ESSENTIAL SERVICES', C.coral],
    ['11', 'MAP QUESTIONS', C.green],
  ]
  stats.forEach((s, i) => {
    const col = i % 3
    const row = Math.floor(i / 3)
    const x = 0.7 + col * 2.06
    const y = 2.62 + row * 1.45
    rect(slide, x, y, 1.82, 1.14, C.panel, 0.13, C.line)
    addText(slide, s[0], x + 0.18, y + 0.16, 1.46, 0.46, { fontSize: 23, bold: true, color: s[2] })
    addText(slide, s[1], x + 0.18, y + 0.72, 1.47, 0.24, { fontSize: 7.8, bold: true, color: C.muted, charSpacing: 0.85 })
  })
  imageCrop(slide, img('final-hazard.png'), 7.22, 2.55, 5.43, 3.9, 1440, 1000, { focusX: 0.58, focusY: 0.48 })
  pill(slide, 'NATIONAL → MUNICIPAL → BUURT', 7.56, 5.88, 2.72, C.mint, C.bg, { fontSize: 8.3 })
  pill(slide, '2D / 3D / REALISTIC', 10.3, 5.88, 2.0, C.cyan, C.bg)
  footerSource(slide, 'Counts from the current repository snapshot · 4 September 2026', null)
  slide.addNotes('The national experience contains 342 municipalities and 289 quarter-hour states. Users can switch between ten hazard presets, eight modeled services and eleven map modes, then zoom into municipality and neighbourhood detail.')
}

// 04 — Scales
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'System design', 4)
  title(slide, 'Geography', 'One model, three spatial scales', 'The same time, service state and intervention remain coherent while the view changes.')

  const layers = [
    { x: 0.9, y: 2.88, w: 3.25, h: 2.46, n: '01', head: 'NETHERLANDS', body: '342 municipalities\nNational service balancing\nAffected-region footprint', color: C.cyan },
    { x: 4.98, y: 2.68, w: 3.36, h: 2.86, n: '02', head: 'MUNICIPALITY', body: 'One stable gateway\nDemand, delivery and reserve\nLocal causal trace', color: C.mint },
    { x: 9.16, y: 2.48, w: 3.15, h: 3.26, n: '03', head: 'CBS BUURT', body: 'Population + vulnerability weights\nLocal impact allocation\nOfficial regional context', color: C.purple },
  ]
  layers.forEach((l, i) => {
    rect(slide, l.x, l.y, l.w, l.h, C.panel, 0.16, l.color)
    addText(slide, l.n, l.x + 0.3, l.y + 0.23, 0.52, 0.3, { fontSize: 16, bold: true, color: l.color })
    addText(slide, l.head, l.x + 0.3, l.y + 0.72, l.w - 0.6, 0.34, { fontSize: 12, bold: true, color: l.color, charSpacing: 0.9 })
    addText(slide, l.body, l.x + 0.3, l.y + 1.22, l.w - 0.6, l.h - 1.42, { fontSize: 12.2, color: C.white, valign: 'top', breakLine: true })
    if (i < 2) arrow(slide, l.x + l.w + 0.15, 4.05, layers[i + 1].x - 0.15, 4.05, C.mint, 1.6)
  })
  rect(slide, 1.6, 6.2, 10.2, 0.46, C.panel2, 0.12, C.line)
  addText(slide, 'CONSERVATION RULE', 1.86, 6.31, 1.62, 0.2, { fontSize: 8.5, bold: true, color: C.amber, charSpacing: 1.0 })
  addText(slide, 'Local allocation redistributes municipal inflow; it never creates supply.', 3.62, 6.25, 7.8, 0.28, { fontSize: 12.5, bold: true })
  slide.addNotes('The view changes, not the underlying state. National transfer totals are preserved. When users zoom in, the municipality’s inflow is distributed across CBS neighbourhoods using population and vulnerability context, then reconciled exactly back to the municipal total.')
}

// 05 — Simulation pipeline
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Simulation model', 5)
  title(slide, 'Engine', 'How a simulation is produced', 'Each quarter-hour frame is a deterministic sequence of visible model stages.')
  const steps = [
    ['SCENARIO', 'Hazard, season, climate, intensity, start and duration', C.cyan],
    ['HAZARD', 'Time envelope + spatial eligibility + audited guards', C.purple],
    ['DAMAGE', 'Service-specific pressure × resilience and preparedness', C.coral],
    ['CASCADE', 'Power and mobility propagate into dependent services', C.amber],
    ['BALANCE', 'Conservative route transfers reduce local shortfalls', C.mint],
    ['EXPLAIN', 'Impacts, status, causes and counterfactuals', C.green],
  ]
  steps.forEach((s, i) => {
    const x = 0.62 + i * 2.09
    const y = 2.7
    circle(slide, x + 0.63, y, 0.58, C.panel2, s[2], 1.2)
    addText(slide, String(i + 1).padStart(2, '0'), x + 0.63, y + 0.12, 0.58, 0.28, { fontSize: 11, bold: true, color: s[2], align: 'center' })
    addText(slide, s[0], x, y + 0.8, 1.84, 0.27, { fontSize: 9, bold: true, color: s[2], align: 'center', charSpacing: 1.1 })
    addText(slide, s[1], x, y + 1.18, 1.84, 1.1, { fontSize: 10.1, color: C.muted, align: 'center', valign: 'top' })
    if (i < steps.length - 1) arrow(slide, x + 1.48, y + 0.29, x + 2.0, y + 0.29, C.line, 1.25)
  })
  rect(slide, 1.22, 5.48, 10.9, 0.95, C.panel, 0.14, C.line)
  addText(slide, 'REPRODUCIBILITY', 1.52, 5.68, 1.6, 0.2, { fontSize: 8.8, bold: true, color: C.mint, charSpacing: 1.1 })
  addText(slide, 'same configuration + same stable seed  →  same state and same explanation', 3.18, 5.59, 8.35, 0.36, { fontSize: 15.5, bold: true })
  addText(slide, 'Deterministic means repeatable—not calibrated or forecast-certain.', 3.18, 6.02, 7.9, 0.2, { fontSize: 9, color: C.muted })
  slide.addNotes('Walk left to right. The engine resolves scenario controls, generates a time- and place-dependent hazard state, applies service-specific damage and recovery, propagates dependencies, balances only supported route flows, then emits outputs plus their explanation metadata. No runtime random draws are used.')
}

// 06 — Dependencies
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Simulation model', 6)
  title(slide, 'Dependencies', 'The cascade has two structural hubs', 'Power constrains dependent services; mobility constrains emergency supply.')

  circle(slide, 2.5, 3.15, 1.25, C.panel2, C.cyan, 2)
  addText(slide, 'POWER', 2.5, 3.51, 1.25, 0.28, { fontSize: 13, bold: true, align: 'center', color: C.cyan })
  const deps = [
    { x: 0.7, y: 2.26, t: 'WATER', c: C.mint, note: 'backup window', from: [2.72, 3.31], to: [2.4, 2.78] },
    { x: 4.15, y: 2.26, t: 'DRAINAGE', c: C.mint, note: 'continuous', from: [3.53, 3.31], to: [4.15, 2.78] },
    { x: 0.7, y: 4.66, t: 'TELECOM', c: C.purple, note: 'battery window', from: [2.72, 4.24], to: [2.4, 4.88] },
    { x: 4.15, y: 4.66, t: 'GAS CONTROLS', c: C.amber, note: 'partial passive', from: [3.53, 4.24], to: [4.15, 4.88] },
    { x: 2.42, y: 5.48, t: 'FACILITIES', c: C.coral, note: 'generators', from: [3.13, 4.4], to: [3.27, 5.48] },
  ]
  deps.forEach((d) => {
    arrow(slide, d.from[0], d.from[1], d.to[0], d.to[1], C.line, 1.15)
    rect(slide, d.x, d.y, 1.7, 0.62, C.panel, 0.14, d.c)
    addText(slide, d.t, d.x + 0.1, d.y + 0.11, 1.5, 0.2, { fontSize: 9.3, bold: true, color: d.c, align: 'center' })
    addText(slide, d.note, d.x + 0.1, d.y + 0.34, 1.5, 0.16, { fontSize: 7.5, color: C.muted, align: 'center' })
  })

  line(slide, 6.55, 2.28, 6.55, 6.2, C.line, 1)
  circle(slide, 8.0, 3.15, 1.25, C.panel2, C.amber, 2)
  addText(slide, 'MOBILITY', 8.0, 3.5, 1.25, 0.28, { fontSize: 11.5, bold: true, align: 'center', color: C.amber })
  arrow(slide, 9.3, 3.78, 10.38, 3.78, C.mint, 1.7)
  rect(slide, 10.43, 3.21, 1.75, 1.15, C.panel, 0.16, C.mint)
  addText(slide, 'EMERGENCY\nSUPPLY', 10.58, 3.48, 1.45, 0.48, { fontSize: 11.4, bold: true, align: 'center', color: C.mint })
  addText(slide, 'Road access + logistics', 7.35, 4.74, 5.35, 0.26, { fontSize: 10.8, color: C.muted, align: 'center' })
  addText(slide, 'NWB corridors are causal only for Mobility and explicitly modeled road logistics / Supply.', 7.15, 5.28, 5.55, 0.66, { fontSize: 12.1, bold: true, align: 'center', color: C.white })
  pill(slide, 'DIRECT HAZARD PRESSURE CAN AFFECT EVERY SERVICE', 7.25, 2.38, 4.55, C.coral)
  slide.addNotes('Power is the main upstream service. Water and telecom are protected by finite backup windows; drainage and gas controls degrade with power; facilities use modeled generators. Mobility is the upstream service for supply. The road graph is deliberately not reused as electricity, water, gas or telecom topology.')
}

// 07 — Timeline
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Simulation model', 7)
  title(slide, 'Time', 'The answer changes across 72 hours', 'Shock, backup endurance, cascading shortfall and restoration happen on different clocks.')
  const x0 = 0.85
  const x1 = 12.25
  const y = 4.12
  line(slide, x0, y, x1, y, C.line, 3)
  const points = [
    [0, 'T+0', 'EVENT START', C.cyan],
    [6, 'T+6', 'EARLY RESPONSE', C.mint],
    [24, 'T+24', 'BACKUPS DEPLETE', C.amber],
    [48, 'T+48', 'CASCADE / REPAIR', C.coral],
    [72, 'T+72', 'RECOVERY STATE', C.purple],
  ]
  points.forEach((p, i) => {
    const px = x0 + (p[0] / 72) * (x1 - x0)
    circle(slide, px - 0.14, y - 0.14, 0.28, p[3], p[3], 0)
    addText(slide, p[1], px - 0.48, y + 0.28, 0.96, 0.27, { fontSize: 11.2, bold: true, color: p[3], align: 'center' })
    addText(slide, p[2], px - 0.68, i % 2 === 0 ? 3.17 : 4.78, 1.36, 0.35, { fontSize: 8.1, bold: true, color: C.muted, align: 'center', charSpacing: 0.65 })
    if (i % 2 === 0) line(slide, px, 3.58, px, y - 0.18, C.line, 0.8, 'dash')
    else line(slide, px, y + 0.18, px, 4.72, C.line, 0.8, 'dash')
  })
  const notes = [
    ['RESPONSE DELAY', 'sets when organized restoration may begin', C.mint],
    ['BACKUP ENDURANCE', 'temporarily decouples dependent services from power', C.amber],
    ['ACCESS GUARD', 'standing-water stress can pause generic repair', C.cyan],
    ['PEAK DAMAGE', 'can persist after current forcing has declined', C.purple],
  ]
  notes.forEach((n, i) => card(slide, 0.7 + i * 3.12, 5.55, 2.82, 0.86, n[0], n[1], n[2], { bodySize: 9.2 }))
  addText(slide, '289 quarter-hour states', 5.4, 2.56, 2.5, 0.34, { fontSize: 12, bold: true, color: C.white, align: 'center' })
  slide.addNotes('Scrubbing the timeline is central. A service may remain healthy while backup lasts, fall later as upstream power fails, and recover only after both response delay and access constraints allow repair. The map therefore tells a different story at T+6, T+24 and T+72.')
}

// 08 — Coupling tiers
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Data coupling', 8)
  title(slide, 'Coupling rules', 'What actually drives the model?', 'The simulator separates causal inputs from visible evidence and from unresolved gaps.')
  const tiers = [
    { y: 2.52, label: 'CAUSAL', color: C.mint, head: 'Scenario + model inputs', body: 'Disaster, intensity, duration, climate, preparedness, response, demand, backup, network and repair controls' },
    { y: 3.58, label: 'STRUCTURAL', color: C.cyan, head: 'Geography + allocation', body: 'CBS municipality/buurt context; audited NWB/GTFS/lifeline connectivity for Mobility and road-logistics Supply' },
    { y: 4.64, label: 'CONTEXT', color: C.amber, head: 'Observed / official overlays', body: 'KNMI, NDW, RWS, RIVM and utility geometry—timestamped and visible, but non-causal unless explicitly bound' },
    { y: 5.70, label: 'UNKNOWN', color: C.purple, head: 'Unsupported or missing evidence', body: 'NoData remains Unknown. It is never silently converted into zero impact, open roads or operational services.' },
  ]
  tiers.forEach((t) => {
    rect(slide, 0.72, t.y, 2.0, 0.78, C.panel2, 0.14, t.color)
    addText(slide, t.label, 0.92, t.y + 0.21, 1.6, 0.28, { fontSize: 10, bold: true, color: t.color, align: 'center', charSpacing: 1.2 })
    rect(slide, 2.95, t.y, 9.68, 0.78, C.panel, 0.14, C.line)
    addText(slide, t.head, 3.22, t.y + 0.12, 2.95, 0.25, { fontSize: 11.5, bold: true, color: t.color })
    addText(slide, t.body, 6.18, t.y + 0.1, 6.1, 0.48, { fontSize: 10.5, color: C.white, valign: 'mid' })
  })
  pill(slide, 'affectsSimulation = false by default for operational context', 7.58, 1.92, 4.74, C.coral)
  footerSource(slide, 'Model contract: README “Data and provenance” + packages/sim-core', 'https://github.com/Rik-Stokmans/DisasterSimulator')
  slide.addNotes('This is the most important data-governance slide. Some inputs are deliberately causal. Others exist only to orient the operator. Near-real-time road, weather, water or air-quality observations do not automatically become a 72-hour scenario. They need explicit time, location and semantics before they can affect the engine.')
}

// 09 — Data ecosystem
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Data coupling', 9)
  title(slide, 'Sources', 'A Dutch public-data ecosystem', 'Official and public datasets are grouped by role, provenance and valid time.')
  const groups = [
    ['PLACE + PEOPLE', 'CBS / PDOK\nBAG / BRT TOP10NL', C.cyan],
    ['MOBILITY', 'NWB / ProRail\nOVapi · NDOV / NDW / FIS', C.mint],
    ['WEATHER + HAZARDS', 'KNMI / RWS Waterinfo / LIWO\nAHN4 / RIVM / Risicokaart / RVO', C.purple],
    ['ESSENTIAL SERVICES', 'Liander / Stedin / Netbeheer NL\nHWH · DAMO · GWSW / RDI / ENTSOG', C.amber],
    ['FACILITIES', 'KVK public services\nRIVM acute care / DUO education', C.coral],
  ]
  const widths = [2.0, 2.0, 2.6, 2.7, 2.0]
  let gx = 0.58
  groups.forEach((g, i) => {
    card(slide, gx, 2.48, widths[i], 2.08, g[0], g[1], g[2], { bodySize: 10.4 })
    gx += widths[i] + 0.16
  })
  const counts = [
    ['63,567', 'WATER ASSETS'],
    ['32,270', 'ANTENNA SITES'],
    ['12,883', 'EDUCATION LOCATIONS'],
    ['79', 'ACUTE-CARE LOCATIONS'],
  ]
  counts.forEach((c, i) => {
    const x = 0.72 + i * 3.05
    rect(slide, x, 5.08, 2.76, 1.03, C.panel2, 0.14, C.line)
    addText(slide, c[0], x + 0.22, 5.25, 1.25, 0.38, { fontSize: 20, bold: true, color: C.mint })
    addText(slide, c[1], x + 1.45, 5.31, 1.05, 0.26, { fontSize: 7.9, bold: true, color: C.muted, align: 'right', charSpacing: 0.6 })
  })
  addText(slide, 'Every refresh preserves source URL, edition, licence, retrieval time and caveats.', 0.72, 6.38, 11.7, 0.33, { fontSize: 13, bold: true, color: C.white, align: 'center' })
  footerSource(slide, 'Checked-in dataset counts from the current repository snapshot', null)
  slide.addNotes('Do not read this as one giant fused truth layer. The integrations are categorized. CBS and PDOK anchor place and people; transport geometry comes from NWB, ProRail and public transport feeds; weather and hazards come from KNMI, Rijkswaterstaat and related public sources; service and facility layers provide context with explicit coverage limits.')
}

// 10 — Evidence semantics
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Data coupling', 10)
  title(slide, 'Evidence', 'Observed is not the same as simulated', 'Each layer tells the user what it can—and cannot—support.')
  const cols = [
    ['OFFICIAL CONTEXT', 'Boundaries, assets, provider areas and registers', 'Where things are', C.cyan],
    ['OBSERVED CONTEXT', 'Radar, stations, incidents and current measurements', 'What was observed', C.mint],
    ['SCENARIO STATE', 'Synthetic hazard, availability, demand and recovery', 'What the model explores', C.purple],
    ['UNKNOWN / NODATA', 'Missing coverage, horizon, permission or semantics', 'What must not be inferred', C.amber],
  ]
  cols.forEach((c, i) => {
    const x = 0.62 + i * 3.15
    rect(slide, x, 2.52, 2.9, 3.15, C.panel, 0.16, C.line)
    circle(slide, x + 0.22, 2.78, 0.18, c[3])
    addText(slide, c[0], x + 0.52, 2.7, 2.08, 0.36, { fontSize: 9.5, bold: true, color: c[3], charSpacing: 0.75 })
    addText(slide, c[1], x + 0.24, 3.28, 2.42, 0.85, { fontSize: 12, color: C.white, valign: 'top' })
    line(slide, x + 0.24, 4.34, x + 2.66, 4.34, C.line, 0.8)
    addText(slide, c[2], x + 0.24, 4.62, 2.42, 0.58, { fontSize: 11, bold: true, color: C.muted, align: 'center' })
  })
  rect(slide, 1.35, 6.08, 10.65, 0.56, C.panel2, 0.14, C.line)
  addText(slide, 'NO DATA  ≠  ZERO HAZARD  ≠  OPEN ROUTE  ≠  HEALTHY SERVICE', 1.6, 6.19, 10.15, 0.27, { fontSize: 13, bold: true, color: C.coral, align: 'center', charSpacing: 0.5 })
  slide.addNotes('A current radar image is an observation, not a future scenario. A road incident feed is not automatically a future closure. A utility line on a map is not outage telemetry. Unknown is a first-class state so missing evidence cannot masquerade as safety.')
}

// 11 — Explainability
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Explainability', 11)
  title(slide, 'Why this state?', 'Explainability is part of the engine', 'Every municipality frame returns its own drivers, stage deltas and counterfactuals.')
  rect(slide, 0.7, 2.45, 5.05, 3.85, C.panel, 0.16, C.line)
  addText(slide, 'SERVICE AVAILABILITY TRACE', 1.0, 2.72, 3.35, 0.26, { fontSize: 9.5, bold: true, color: C.mint, charSpacing: 1.0 })
  const trace = [
    ['BASELINE RESILIENCE', 'starting state', C.cyan],
    ['DIRECT HAZARD', 'exact stage change', C.coral],
    ['RESTORATION', 'repair progress', C.green],
    ['UPSTREAM DEPENDENCY', 'power / mobility effect', C.amber],
    ['INTERVENTION', 'selected policy effect', C.purple],
    ['NETWORK TRANSFER', 'supported route effect', C.mint],
  ]
  trace.forEach((t, i) => {
    const yy = 3.15 + i * 0.48
    circle(slide, 1.02, yy + 0.08, 0.11, t[2])
    addText(slide, t[0], 1.28, yy, 2.42, 0.25, { fontSize: 8.8, bold: true, color: C.white, charSpacing: 0.45 })
    addText(slide, t[1], 3.62, yy, 1.72, 0.25, { fontSize: 8.5, color: C.muted, align: 'right' })
    if (i < trace.length - 1) line(slide, 1.07, yy + 0.22, 1.07, yy + 0.51, C.line, 0.8)
  })
  const qs = [
    ['DRIVERS', 'Which inputs and assumptions were active?', C.cyan],
    ['CONTRIBUTIONS', 'Which stage increased or reduced availability?', C.mint],
    ['DEPENDENCY CHAIN', 'Which upstream service caused the constraint?', C.amber],
    ['COUNTERFACTUALS', 'What changes without damage, delay or dependency?', C.purple],
  ]
  qs.forEach((q, i) => {
    const x = 6.2 + (i % 2) * 3.15
    const y = 2.48 + Math.floor(i / 2) * 1.72
    card(slide, x, y, 2.88, 1.42, q[0], q[1], q[2], { bodySize: 10.4 })
  })
  rect(slide, 6.2, 5.95, 6.03, 0.42, C.panel2, 0.12, C.line)
  addText(slide, 'Generated by deterministic reruns—not post-hoc AI prose.', 6.48, 6.03, 5.48, 0.22, { fontSize: 10.8, bold: true, color: C.white, align: 'center' })
  slide.addNotes('The explanation is not a narrative invented after the fact. The engine records the calculation stages. Counterfactuals are exact deterministic reruns: for example, the same frame without direct hazard damage or with an upstream service restored to full availability.')
}

// 12 — Scenarios
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Scenario design', 12)
  title(slide, 'Scenario lab', 'Ten starting points, many controlled variants', 'Presets provide a reproducible baseline; operators can then test assumptions.')
  addText(slide, 'WEATHER + WATER', 0.72, 2.48, 3.0, 0.25, { fontSize: 9.5, bold: true, color: C.cyan, charSpacing: 1.2 })
  const weather = [
    ['Severe windstorm', C.cyan], ['Urban cloudburst', C.cyan], ['River high water', C.cyan],
    ['Coastal surge', C.cyan], ['Heatwave + drought', C.cyan], ['Winter storm', C.cyan],
  ]
  weather.forEach((p, i) => pill(slide, p[0].toUpperCase(), 0.72 + (i % 2) * 2.65, 2.87 + Math.floor(i / 2) * 0.58, 2.42, p[1]))
  addText(slide, 'SYSTEM + GEOPHYSICAL', 6.25, 2.48, 3.2, 0.25, { fontSize: 9.5, bold: true, color: C.purple, charSpacing: 1.2 })
  const system = [
    ['Cyberattack', C.purple], ['Groningen earthquake', C.purple], ['Wildfire + smoke', C.purple], ['Compound cascade', C.coral],
  ]
  system.forEach((p, i) => pill(slide, p[0].toUpperCase(), 6.25 + (i % 2) * 2.75, 2.87 + Math.floor(i / 2) * 0.58, 2.52, p[1]))
  rect(slide, 0.72, 5.02, 11.88, 1.18, C.panel, 0.14, C.line)
  addText(slide, 'CONTROL LEVERS', 0.98, 5.24, 1.64, 0.22, { fontSize: 9.3, bold: true, color: C.mint, charSpacing: 1.1 })
  addText(slide, 'season · KNMI’23 path + horizon · intensity · duration · response delay · infrastructure preparedness', 2.82, 5.16, 9.18, 0.31, { fontSize: 11.5, bold: true })
  addText(slide, 'day type · local start time · demand · backup · repair · network capacity · household preparedness · reference date', 2.82, 5.62, 9.18, 0.31, { fontSize: 10.2, color: C.muted })
  slide.addNotes('The ten presets cover meteorological, hydrological, geophysical, digital and compound events. The strength of the Scenario Lab is that users can hold the event constant and vary preparedness, response delay, backup endurance, repair capacity, climate path, season and demand assumptions.')
}

// 13 — Audit safeguards
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Model assurance', 13)
  title(slide, 'Safety guards', 'Designed to fail safely', 'Unsupported local precision is withheld instead of rendered as confident detail.')
  addText(slide, '245', 0.78, 2.62, 2.52, 0.82, { fontSize: 42, bold: true, color: C.mint })
  addText(slide, 'OF 342 MUNICIPALITIES\nAUDITED', 0.82, 3.46, 2.6, 0.62, { fontSize: 10, bold: true, color: C.muted, breakLine: true, charSpacing: 0.8 })
  addText(slide, 'as of 3 September 2026', 0.82, 4.28, 2.6, 0.22, { fontSize: 8.5, color: C.dim })
  const checks = [
    ['AUDIT', 'Scenario matrix, numerical invariants, spatial plausibility, dependencies and T+72 recovery', C.cyan],
    ['COMPILE', 'Correction-required or blocked findings become deterministic generated guards', C.purple],
    ['WITHHOLD', 'Unsupported hazard pathways and downstream claims become Unknown / neutral', C.amber],
    ['BLOCK BUILD', 'A missing or stale generated guard prevents production output', C.coral],
  ]
  checks.forEach((c, i) => numberedStep(slide, i + 1, c[0], c[1], 3.65 + (i % 2) * 4.45, 2.55 + Math.floor(i / 2) * 1.65, 4.12, c[3]))
  rect(slide, 0.82, 5.65, 11.52, 0.82, C.panel2, 0.14, C.line)
  addText(slide, 'Audit prose never becomes a causal model automatically.', 1.18, 5.86, 10.78, 0.32, { fontSize: 15, bold: true, color: C.white, align: 'center' })
  footerSource(slide, 'Audit manifest generated 3 September 2026', null)
  slide.addNotes('The municipality audit program is a notable assurance mechanism. It checks numerical and spatial plausibility and compiles explicit guards. If a location-specific pathway is unsupported, the simulator withholds the consequence rather than showing false precision. Human review remains necessary for hydraulic and coastal corrections.')
}

// 14 — Capabilities and limits
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Critical reflection', 14)
  title(slide, 'Scope', 'Powerful for exploration—careful about claims', 'The prototype is explicit about what is modeled, observed, assumed and unresolved.')
  rect(slide, 0.7, 2.45, 5.75, 3.75, C.panel, 0.16, C.mint)
  addText(slide, 'WHAT IT DOES WELL', 1.0, 2.74, 3.0, 0.28, { fontSize: 10.5, bold: true, color: C.mint, charSpacing: 1.1 })
  const does = [
    'Compare assumptions and response policies',
    'Reveal time-dependent service cascades',
    'Keep national and local views coherent',
    'Expose drivers and counterfactuals',
    'Preserve provenance and uncertainty',
  ]
  does.forEach((t, i) => {
    circle(slide, 1.02, 3.31 + i * 0.49, 0.11, C.mint)
    addText(slide, t, 1.3, 3.22 + i * 0.49, 4.72, 0.3, { fontSize: 12.3, color: C.white })
  })
  rect(slide, 6.86, 2.45, 5.75, 3.75, C.panel, 0.16, C.coral)
  addText(slide, 'WHAT IT DOES NOT CLAIM', 7.16, 2.74, 3.5, 0.28, { fontSize: 10.5, bold: true, color: C.coral, charSpacing: 1.1 })
  const doesnt = [
    'A calibrated digital twin or forecast',
    'Live utility outage or capacity telemetry',
    'Physical power / water / telecom topology',
    'Observed affected-person headcounts',
    'Real-world units for generalized route capacity',
  ]
  doesnt.forEach((t, i) => {
    line(slide, 7.18, 3.37 + i * 0.49, 7.33, 3.37 + i * 0.49, C.coral, 2)
    addText(slide, t, 7.48, 3.22 + i * 0.49, 4.7, 0.3, { fontSize: 12.3, color: C.white })
  })
  addText(slide, 'The honest limitation is a feature: uncertainty stays visible.', 0.72, 6.54, 11.9, 0.33, { fontSize: 14, bold: true, color: C.amber, align: 'center' })
  slide.addNotes('Use this slide to calibrate expectations. The project is valuable for asking comparative “what if” questions and revealing dependencies. It should not be presented as an operational forecast, exact headcount or digital twin. Route capacities are generalized units and utility geometry is context, not full topology or live state.')
}

// 15 — Demo plan
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Presentation flow', 15)
  title(slide, 'Live demo', 'A four-minute walkthrough', 'Tell one causal story instead of showing every control.')
  const demo = [
    ['START NATIONAL', 'Choose Compound cascade; keep the affected-region overlay visible.', C.cyan],
    ['MOVE THROUGH TIME', 'Scrub from T+0 to T+24 and call out the changing headline metrics.', C.mint],
    ['FOLLOW A DEPENDENCY', 'Switch Power → Telecom, or Mobility → Supply, to reveal the cascade.', C.purple],
    ['ZOOM TO EINDHOVEN', 'Open municipality and buurt detail; compare demand, delivery and reserve.', C.amber],
    ['CHANGE ONE LEVER', 'Increase backup or reduce response delay—keep everything else constant.', C.coral],
    ['EXPLAIN THE RESULT', 'Open “Why this state?” and finish with the exact causal trace.', C.green],
  ]
  demo.forEach((d, i) => numberedStep(slide, i + 1, d[0], d[1], 0.72 + (i % 2) * 6.08, 2.44 + Math.floor(i / 2) * 1.24, 5.74, d[2]))
  rect(slide, 1.2, 6.26, 10.95, 0.46, C.panel2, 0.12, C.line)
  addText(slide, 'Presenter rule: change one assumption, then show one downstream effect.', 1.46, 6.35, 10.42, 0.24, { fontSize: 11.2, bold: true, color: C.white, align: 'center' })
  slide.addNotes('Recommended demo: start national, move the timeline, follow one dependency, zoom into Eindhoven, change exactly one assumption, and open the explanation. Avoid touring every layer. The audience should leave understanding one causal chain and one policy comparison.')
}

// 16 — Roadmap
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Next steps', 16)
  title(slide, 'Roadmap', 'From exploration prototype to calibrated exercises', 'The next gains come from stronger event binding, topology and validation—not more visual layers.')
  const roadmap = [
    ['01', 'EVENT-BOUND WEATHER', 'Bind checksum-versioned forecast cycles; preserve the T+60–T+72 coverage gap.', C.cyan],
    ['02', 'HYDRAULIC CALIBRATION', 'Select compatible LIWO / breach scenarios with depth, arrival and recession.', C.mint],
    ['03', 'SERVICE-SPECIFIC NETWORKS', 'Add authorized topology, capacity, switching and restoration semantics.', C.purple],
    ['04', 'FACILITIES + RESPONSE', 'Calibrate shelter, acute-care, staffing, generators, fuel and dispatch resources.', C.amber],
    ['05', 'VALIDATION', 'Compare outputs with historical incidents and expert tabletop exercises.', C.coral],
  ]
  roadmap.forEach((r, i) => {
    const y = 2.45 + i * 0.78
    addText(slide, r[0], 0.78, y + 0.04, 0.55, 0.3, { fontSize: 13, bold: true, color: r[3] })
    line(slide, 1.48, y + 0.24, 2.02, y + 0.24, r[3], 2)
    addText(slide, r[1], 2.18, y, 3.15, 0.31, { fontSize: 11.5, bold: true, color: r[3] })
    addText(slide, r[2], 5.46, y - 0.02, 6.75, 0.45, { fontSize: 10.4, color: C.white })
    if (i < roadmap.length - 1) line(slide, 0.72, y + 0.63, 12.35, y + 0.63, C.line, 0.55)
  })
  pill(slide, 'CALIBRATION', 2.55, 6.43, 1.56, C.mint)
  pill(slide, 'GOVERNANCE', 4.34, 6.43, 1.5, C.amber)
  pill(slide, 'VALIDATION', 6.08, 6.43, 1.43, C.purple)
  pill(slide, 'EXERCISE DESIGN', 7.75, 6.43, 1.78, C.cyan)
  slide.addNotes('The next stage should prioritize calibration and validation. Weather forecasts must be bound to explicit cycles; flood impacts need compatible hydraulic scenarios; utility models need service-specific topology; and response resources need real inventories and endurance. Historical events and expert exercises can then test whether the model behaves credibly.')
}

// 17 — Close
{
  const slide = pptx.addSlide('MASTER_DARK')
  addFrame(slide, 'Close', 17)
  imageCrop(slide, img('gatekeeper-v2.png'), 7.15, 1.02, 5.48, 5.72, 1920, 1200, { focusX: 0.6, focusY: 0.5 })
  slide.addShape(pptx.ShapeType.rect, { x: 7.15, y: 1.02, w: 5.48, h: 5.72, fill: { color: C.bg, transparency: 58 }, line: { color: C.line, width: 1 } })
  addText(slide, 'See the cascade.\nQuestion the assumptions.\nImprove the response.', 0.75, 1.78, 5.9, 2.2, { fontSize: 31, bold: true, valign: 'top', breakLine: true })
  addText(slide, 'Questions?', 0.76, 4.48, 3.2, 0.56, { fontSize: 23, bold: true, color: C.mint })
  addText(slide, 'GitHub', 0.76, 5.58, 0.82, 0.23, { fontSize: 8.5, bold: true, color: C.dim, charSpacing: 0.9 })
  addText(slide, 'github.com/Rik-Stokmans/DisasterSimulator', 1.72, 5.54, 4.65, 0.28, { fontSize: 10.2, color: C.white, hyperlink: { url: 'https://github.com/Rik-Stokmans/DisasterSimulator' } })
  addText(slide, 'Preview', 0.76, 6.0, 0.82, 0.23, { fontSize: 8.5, bold: true, color: C.dim, charSpacing: 0.9 })
  addText(slide, 'rikstokmans.com/warroom/projects/disasterSimulator', 1.72, 5.96, 4.82, 0.28, { fontSize: 10.2, color: C.white, hyperlink: { url: 'https://rikstokmans.com/warroom/projects/disasterSimulator' } })
  slide.addNotes('Closing line: The simulator is valuable because it makes the cascade, the assumptions and the uncertainty inspectable. Invite questions about either the system model, the public-data couplings or the next calibration steps.')
}

// Render shared slide chrome last. Keeping it on the top drawing layer avoids
// intermittent header/brand loss in PowerPoint and LibreOffice importers.
framedSlides.forEach(({ slide, section }) => addFrameChrome(slide, section))

pptx.writeFile({ fileName: output })
  .then(() => console.log(`Wrote ${output}`))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
