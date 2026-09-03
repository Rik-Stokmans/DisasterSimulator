import type { ScenarioConfig, Season } from '@disaster/sim-core'

const NETHERLANDS_SOLAR_REFERENCE = { latitude: 52.1326, longitude: 5.2913 }
const AMSTERDAM_TIME_ZONE = 'Europe/Amsterdam'
const MINUTE_MS = 60_000
const amsterdamOffsetFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: AMSTERDAM_TIME_ZONE,
  timeZoneName: 'longOffset',
})
const amsterdamWallClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: AMSTERDAM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const amsterdamOffsetCache = new Map<string, number>()

const representativeDateBySeason: Record<Season, string> = {
  winter: '2026-01-15',
  spring: '2026-04-15',
  summer: '2026-07-15',
  autumn: '2026-10-15',
}

export type DaylightBand = 'daylight' | 'twilight' | 'night'

export interface RealisticLightingState {
  azimuthDegrees: number
  daylightBand: DaylightBand
  elevationDegrees: number
  localDate: string
  localTime: string
  nightFactor: number
  usesScenarioDate: boolean
}

interface WallClockParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function smoothstep(value: number) {
  const bounded = clamp(value, 0, 1)
  return bounded * bounded * (3 - 2 * bounded)
}

function validReferenceDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function amsterdamUtcOffsetHours(instant: Date) {
  const cacheKey = instant.toISOString().slice(0, 13)
  const cached = amsterdamOffsetCache.get(cacheKey)
  if (cached !== undefined) return cached
  const timeZoneName = amsterdamOffsetFormatter.formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value
  const match = timeZoneName?.match(/^GMT([+-])(\d{1,2}):?(\d{2})$/)
  if (!match) return 1
  const sign = match[1] === '-' ? -1 : 1
  const offset = sign * (Number(match[2]) + Number(match[3]) / 60)
  amsterdamOffsetCache.set(cacheKey, offset)
  return offset
}

function amsterdamWallClockParts(instant: Date): WallClockParts {
  const values = Object.fromEntries(
    amsterdamWallClockFormatter.formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  }
}

function wallClockStamp(parts: WallClockParts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

function amsterdamLocalInstantMs(parts: WallClockParts) {
  const requestedWallClock = wallClockStamp(parts)
  const halfDayMs = 12 * 60 * MINUTE_MS
  const offsets = new Set([
    amsterdamUtcOffsetHours(new Date(requestedWallClock - halfDayMs)),
    amsterdamUtcOffsetHours(new Date(requestedWallClock)),
    amsterdamUtcOffsetHours(new Date(requestedWallClock + halfDayMs)),
  ])
  const candidates = [...offsets].map((offsetHours) => {
    const instant = requestedWallClock - offsetHours * 60 * MINUTE_MS
    const resolvedParts = amsterdamWallClockParts(new Date(instant))
    return { instant, resolvedWallClock: wallClockStamp(resolvedParts) }
  })
  const exactMatches = candidates
    .filter(({ resolvedWallClock }) => resolvedWallClock === requestedWallClock)
    .sort((left, right) => left.instant - right.instant)
  if (exactMatches.length) return exactMatches[0].instant

  // A local clock time in the spring DST gap does not exist. Resolve it to
  // the first representable instant after the gap instead of inventing a
  // repeated/nonexistent hour. An autumn overlap uses its first occurrence.
  const firstAfterGap = candidates
    .filter(({ resolvedWallClock }) => resolvedWallClock > requestedWallClock)
    .sort((left, right) =>
      left.resolvedWallClock - right.resolvedWallClock || left.instant - right.instant,
    )[0]
  return firstAfterGap?.instant ?? candidates[0].instant
}

function dayOfYear(wallClock: Date) {
  const year = wallClock.getUTCFullYear()
  return Math.floor(
    (Date.UTC(year, wallClock.getUTCMonth(), wallClock.getUTCDate()) - Date.UTC(year, 0, 0)) /
      86_400_000,
  )
}

/**
 * Approximate NOAA solar position for the geographic centre of the European
 * Netherlands. The simulation clock is local Europe/Amsterdam time. A run
 * without an explicit calendar date uses a documented representative date for
 * its selected season, because an exact sunrise cannot be inferred from a
 * season label alone.
 */
export function realisticLightingForFrame(
  scenario: Pick<ScenarioConfig, 'referenceDate' | 'season' | 'startClockHour'>,
  elapsedMinutes: number,
): RealisticLightingState {
  const scenarioDate = validReferenceDate(scenario.referenceDate) ? scenario.referenceDate : null
  const usesScenarioDate = scenarioDate !== null
  const date = scenarioDate ?? representativeDateBySeason[scenario.season]
  const [year, month, day] = date.split('-').map(Number)
  const startMinutes = Math.round(clamp(scenario.startClockHour ?? 8, 0, 23) * 60)
  const startInstant = amsterdamLocalInstantMs({
    year,
    month,
    day,
    hour: Math.floor(startMinutes / 60),
    minute: startMinutes % 60,
  })
  const instant = new Date(
    startInstant +
      Math.max(0, Number.isFinite(elapsedMinutes) ? elapsedMinutes : 0) * MINUTE_MS,
  )
  const localParts = amsterdamWallClockParts(instant)
  // UTC fields are only used as a locale-independent carrier for the resolved
  // local calendar. The real instant above owns DST and elapsed-time behavior.
  const wallClock = new Date(Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour,
    localParts.minute,
  ))
  const localHour = localParts.hour + localParts.minute / 60
  const daysThisYear = new Date(Date.UTC(wallClock.getUTCFullYear(), 1, 29)).getUTCDate() === 29
    ? 366
    : 365
  const fractionalYear =
    (2 * Math.PI / daysThisYear) * (dayOfYear(wallClock) - 1 + (localHour - 12) / 24)
  const equationOfTime = 229.18 * (
    0.000075 +
    0.001868 * Math.cos(fractionalYear) -
    0.032077 * Math.sin(fractionalYear) -
    0.014615 * Math.cos(2 * fractionalYear) -
    0.040849 * Math.sin(2 * fractionalYear)
  )
  const solarDeclination =
    0.006918 -
    0.399912 * Math.cos(fractionalYear) +
    0.070257 * Math.sin(fractionalYear) -
    0.006758 * Math.cos(2 * fractionalYear) +
    0.000907 * Math.sin(2 * fractionalYear) -
    0.002697 * Math.cos(3 * fractionalYear) +
    0.00148 * Math.sin(3 * fractionalYear)
  const offsetHours = amsterdamUtcOffsetHours(instant)
  const localMinutes = localParts.hour * 60 + localParts.minute
  const solarMinutes = (
    localMinutes +
    equationOfTime +
    4 * NETHERLANDS_SOLAR_REFERENCE.longitude -
    60 * offsetHours +
    1_440
  ) % 1_440
  const hourAngleDegrees = solarMinutes / 4 - 180
  const hourAngle = hourAngleDegrees * Math.PI / 180
  const latitude = NETHERLANDS_SOLAR_REFERENCE.latitude * Math.PI / 180
  const cosineZenith = clamp(
    Math.sin(latitude) * Math.sin(solarDeclination) +
      Math.cos(latitude) * Math.cos(solarDeclination) * Math.cos(hourAngle),
    -1,
    1,
  )
  const elevationDegrees = 90 - Math.acos(cosineZenith) * 180 / Math.PI
  const azimuthDegrees = (
    Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(latitude) -
        Math.tan(solarDeclination) * Math.cos(latitude),
    ) * 180 / Math.PI + 180
  ) % 360
  const nightFactor = smoothstep((4 - elevationDegrees) / 12)
  const daylightBand: DaylightBand = elevationDegrees >= 6
    ? 'daylight'
    : elevationDegrees >= -6
      ? 'twilight'
      : 'night'

  return {
    azimuthDegrees: Math.round(azimuthDegrees * 10) / 10,
    daylightBand,
    elevationDegrees: Math.round(elevationDegrees * 10) / 10,
    localDate: `${localParts.year}-${String(localParts.month).padStart(2, '0')}-${String(localParts.day).padStart(2, '0')}`,
    localTime: `${String(localParts.hour).padStart(2, '0')}:${String(localParts.minute).padStart(2, '0')}`,
    nightFactor: Math.round(nightFactor * 1_000) / 1_000,
    usesScenarioDate,
  }
}
