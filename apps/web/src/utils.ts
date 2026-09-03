import type {
  LayerId,
  MunicipalitySnapshot,
  OperationalStatus,
  ScenarioConfig,
} from '@disaster/sim-core'

export const numberFormat = new Intl.NumberFormat('en-NL', { maximumFractionDigits: 0 })
export const compactNumber = new Intl.NumberFormat('en-NL', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

export function colorForAvailability(value: number, status?: OperationalStatus) {
  if (status === 'recovering') return '#76b8ff'
  if (value >= 0.88) return '#54d7b0'
  if (value >= 0.7) return '#d6d45e'
  if (value >= 0.48) return '#ffad4d'
  if (value >= 0.22) return '#ff6577'
  return '#8e2d48'
}

export function colorForSeverity(value: number) {
  if (value < 0.22) return '#2b6c88'
  if (value < 0.48) return '#5fb7d7'
  if (value < 0.72) return '#b56dd8'
  return '#ff5b8c'
}

export function colorForImpact(value: number) {
  if (value < 0.08) return '#425461'
  if (value < 0.24) return '#a681aa'
  if (value < 0.52) return '#ec7fab'
  return '#ff526f'
}

export function metricForLayer(city: MunicipalitySnapshot, layer: LayerId) {
  if (layer === 'hazard') return city.hazard.severity
  if (layer === 'population') return city.affectedPopulation / Math.max(1, city.population)
  if (layer === 'overview') return 1 - city.systemPressure
  return city.services[layer].availability
}

export function colorForLayer(city: MunicipalitySnapshot, layer: LayerId) {
  const metric = metricForLayer(city, layer)
  if (layer === 'hazard') return colorForSeverity(metric)
  if (layer === 'population') return colorForImpact(metric)
  if (layer === 'overview') return colorForAvailability(metric, city.status)
  return colorForAvailability(metric, city.services[layer].status)
}

export function formatHour(
  step: number,
  scenario: ScenarioConfig & { startClockHour?: number },
) {
  const startClockHour = Math.max(0, Math.min(23, scenario.startClockHour ?? 12))
  const totalMinutes = Math.round(startClockHour * 60 + step * 15)
  const day = Math.floor(totalMinutes / (24 * 60)) + 1
  const minuteOfDay = totalMinutes % (24 * 60)
  const hour = Math.floor(minuteOfDay / 60)
  const minute = minuteOfDay % 60
  const season = `${scenario.season[0].toUpperCase()}${scenario.season.slice(1)}`
  const dayType = scenario.dayType === 'holiday' ? 'holiday profile' : scenario.dayType ?? 'weekday'
  return `${season} ${dayType} · day ${day}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
