import { buildNationalNetwork } from './network'
import { simulateFrames } from './model'
import {
  MAX_HOURS,
  MINUTES_PER_STEP,
  TIMELINE_STEPS,
  hazardHistoryMetricIds,
  serviceHistoryMetricIds,
} from './types'
import type {
  ChartSeries,
  HazardHistoryMetricId,
  MunicipalityDefinition,
  MunicipalityHistorySnapshot,
  RouteDefinition,
  ServiceHistoryMetricId,
  ServiceId,
  SimulationHistory,
  SimulationHistoryOptions,
  SimulationOptions,
} from './types'

const serviceIds: ServiceId[] = [
  'power',
  'water',
  'drainage',
  'gas',
  'telecom',
  'mobility',
  'facilities',
  'supply',
]

const hazardMetricMetadata: Record<
  HazardHistoryMetricId,
  { label: string; unit: string }
> = {
  rainMmH: { label: 'Rain intensity', unit: 'mm/h' },
  floodDepthM: { label: 'Inundation stress', unit: 'fraction' },
  windGustMs: { label: 'Wind gust', unit: 'm/s' },
  heatC: { label: 'Air temperature', unit: '°C' },
  snowCmH: { label: 'Snowfall', unit: 'cm/h' },
  iceSeverity: { label: 'Ice severity', unit: 'index' },
  coldStress: { label: 'Cold stress', unit: 'index' },
  droughtSeverity: { label: 'Drought severity', unit: 'index' },
  wildfireIntensity: { label: 'Wildfire intensity', unit: 'index' },
  smokeSeverity: { label: 'Smoke severity', unit: 'index' },
  groundMotionG: { label: 'Ground motion', unit: 'g' },
  cyberDisruption: { label: 'Cyber disruption', unit: 'index' },
  climateTemperatureDeltaC: { label: 'Climate temperature delta', unit: '°C' },
  climatePrecipitationMultiplier: {
    label: 'Climate precipitation multiplier',
    unit: '×',
  },
  climateSeaLevelDeltaM: { label: 'Climate sea-level delta', unit: 'm' },
  severity: { label: 'Current hazard severity', unit: 'fraction' },
  peakSeverity: { label: 'Peak hazard severity', unit: 'fraction' },
}

const serviceMetricMetadata: Record<
  ServiceHistoryMetricId,
  { label: string; unit: string }
> = {
  availability: { label: 'Availability', unit: 'fraction' },
  demand: { label: 'Demand', unit: 'service units/hour' },
  delivered: { label: 'Delivered', unit: 'service units/hour' },
  reserveHours: { label: 'Reserve duration', unit: 'hours' },
}

function normalizeStep(step: number, name: string): number {
  if (!Number.isFinite(step)) throw new RangeError(`${name} must be finite`)
  return Math.max(0, Math.min(TIMELINE_STEPS - 1, Math.round(step)))
}

function resolveSteps(options: SimulationHistoryOptions): {
  startStep: number
  endStep: number
  intervalSteps: number
  steps: number[]
} {
  const startStep = normalizeStep(options.startStep ?? 0, 'History start step')
  const endStep = normalizeStep(options.endStep ?? TIMELINE_STEPS - 1, 'History end step')
  if (startStep > endStep) throw new RangeError('History start step must not exceed end step')
  if (options.intervalSteps !== undefined && !Number.isFinite(options.intervalSteps)) {
    throw new RangeError('History interval must be finite')
  }
  // Hourly is deliberately the default for responsive charts; callers can opt
  // into all 289 quarter-hour samples with intervalSteps: 1.
  const intervalSteps = Math.max(1, Math.round(options.intervalSteps ?? 4))
  const steps: number[] = []
  for (let step = startStep; step <= endStep; step += intervalSteps) steps.push(step)
  if (steps.at(-1) !== endStep) steps.push(endStep)
  return { startStep, endStep, intervalSteps, steps }
}

function projectMunicipality(
  municipality: ReturnType<typeof simulateFrames>[number]['municipalities'][number],
): MunicipalityHistorySnapshot {
  return {
    id: municipality.id,
    name: municipality.name,
    population: municipality.population,
    hazard: Object.fromEntries(
      hazardHistoryMetricIds.map((metric) => [metric, municipality.hazard[metric]]),
    ) as MunicipalityHistorySnapshot['hazard'],
    services: Object.fromEntries(
      serviceIds.map((service) => [
        service,
        Object.fromEntries(
          serviceHistoryMetricIds.map((metric) => [metric, municipality.services[service][metric]]),
        ),
      ]),
    ) as MunicipalityHistorySnapshot['services'],
    systemPressure: municipality.systemPressure,
    affectedPopulation: municipality.affectedPopulation,
    deprivedPersonHours: municipality.deprivedPersonHours,
  }
}

/**
 * Produces compact, chart-ready simulation history without retaining map
 * geometry, causal ledgers or route snapshots. The default is 73 hourly points
 * in isolated mode. Pass `networkMode: 'full'` when network balancing must be
 * represented; that explicitly incurs national-frame cost.
 */
export function simulateHistory(
  municipalities: MunicipalityDefinition[],
  simulationOptions: SimulationOptions,
  historyOptions: SimulationHistoryOptions = {},
): SimulationHistory {
  const { startStep, endStep, intervalSteps, steps } = resolveSteps(historyOptions)
  const requestedIds = historyOptions.municipalityIds
    ? [...new Set(historyOptions.municipalityIds)]
    : municipalities.map((municipality) => municipality.code)
  if (!requestedIds.length) throw new RangeError('History requires at least one municipality')
  const municipalityById = new Map(
    municipalities.map((municipality) => [municipality.code, municipality]),
  )
  const unknownIds = requestedIds.filter((id) => !municipalityById.has(id))
  if (unknownIds.length) {
    throw new RangeError(`Unknown history municipality: ${unknownIds.join(', ')}`)
  }
  const networkMode = historyOptions.networkMode ?? 'isolated'
  const simulatedMunicipalities =
    networkMode === 'isolated'
      ? requestedIds.map((id) => municipalityById.get(id)!)
      : municipalities
  const network: RouteDefinition[] =
    networkMode === 'isolated'
      ? []
      : historyOptions.network ?? buildNationalNetwork(simulatedMunicipalities)
  const frames = simulateFrames(simulatedMunicipalities, steps, simulationOptions, network)
  const requested = new Set(requestedIds)
  return {
    scenario: frames[0].scenario,
    startStep,
    endStep,
    intervalSteps,
    networkMode,
    aggregateScope:
      networkMode === 'full' ? 'national-network' : 'selected-municipalities',
    points: frames.map((frame) => ({
      step: frame.step,
      minute: frame.minute,
      hour: frame.hour,
      municipalities: frame.municipalities
        .filter((municipality) => requested.has(municipality.id))
        .map(projectMunicipality),
      national: { ...frame.national },
    })),
  }
}

function municipalityAt(
  history: SimulationHistory,
  municipalityId: string,
  pointIndex: number,
): MunicipalityHistorySnapshot {
  const municipality = history.points[pointIndex]?.municipalities.find(
    (candidate) => candidate.id === municipalityId,
  )
  if (!municipality) throw new RangeError(`History does not contain municipality ${municipalityId}`)
  return municipality
}

function pointsFor(
  history: SimulationHistory,
  valueAt: (pointIndex: number) => number,
): ChartSeries['points'] {
  return history.points.map((point, pointIndex) => ({
    step: point.step,
    minute: point.minute,
    hour: point.hour,
    value: valueAt(pointIndex),
  }))
}

/** Returns every numeric hazard, service and municipality metric in stable order. */
export function municipalityChartSeries(
  history: SimulationHistory,
  municipalityId: string,
): ChartSeries[] {
  municipalityAt(history, municipalityId, 0)
  const hazardSeries = hazardHistoryMetricIds.map((metric): ChartSeries => ({
    id: `${municipalityId}:hazard:${metric}`,
    label: hazardMetricMetadata[metric].label,
    unit: hazardMetricMetadata[metric].unit,
    category: 'hazard',
    municipalityId,
    metric,
    points: pointsFor(history, (index) => {
      const value = municipalityAt(history, municipalityId, index).hazard[metric]
      return metric === 'floodDepthM' ? Math.max(0, Math.min(1, value / 1.5)) : value
    }),
  }))
  const serviceSeries = serviceIds.flatMap((service) =>
    serviceHistoryMetricIds.map((metric): ChartSeries => ({
      id: `${municipalityId}:service:${service}:${metric}`,
      label: `${service} ${serviceMetricMetadata[metric].label.toLowerCase()}`,
      unit: serviceMetricMetadata[metric].unit,
      category: 'service',
      municipalityId,
      service,
      metric,
      points: pointsFor(
        history,
        (index) => municipalityAt(history, municipalityId, index).services[service][metric],
      ),
    })),
  )
  const municipalityMetrics = [
    { metric: 'population', label: 'Population', unit: 'people' },
    { metric: 'systemPressure', label: 'System pressure', unit: 'fraction' },
    {
      metric: 'affectedPopulation',
      label: 'Modeled equivalent population under service pressure',
      unit: 'people-equivalent',
    },
    {
      metric: 'deprivedPersonHours',
      label: 'Local essential-service deprivation',
      unit: 'person-hours',
    },
  ] as const
  const municipalitySeries = municipalityMetrics.map(({ metric, label, unit }): ChartSeries => ({
    id: `${municipalityId}:municipality:${metric}`,
    label,
    unit,
    category: 'municipality',
    municipalityId,
    metric,
    points: pointsFor(history, (index) => municipalityAt(history, municipalityId, index)[metric]),
  }))
  return [...hazardSeries, ...serviceSeries, ...municipalitySeries]
}

/** Returns every numeric national headline metric in stable order. */
export function nationalChartSeries(history: SimulationHistory): ChartSeries[] {
  const metrics = [
    { metric: 'population', label: 'Population', unit: 'people' },
    {
      metric: 'affectedPopulation',
      label: 'Modeled equivalent population under service pressure',
      unit: 'people-equivalent',
    },
    { metric: 'averageAvailability', label: 'Average availability', unit: 'fraction' },
    { metric: 'criticalMunicipalities', label: 'Critical municipalities', unit: 'municipalities' },
    { metric: 'activeBottlenecks', label: 'Active bottlenecks', unit: 'routes' },
    {
      metric: 'deprivedPersonHours',
      label: 'Local essential-service deprivation',
      unit: 'person-hours',
    },
  ] as const
  return metrics.map(({ metric, label, unit }): ChartSeries => ({
    id: `national:${metric}`,
    label,
    unit,
    category: 'national',
    metric,
    points: pointsFor(history, (index) => history.points[index].national[metric]),
  }))
}

export const historyCoverage = {
  hours: MAX_HOURS,
  quarterHourSteps: TIMELINE_STEPS,
  defaultIntervalMinutes: MINUTES_PER_STEP * 4,
  hazardMetrics: hazardHistoryMetricIds.length,
  serviceMetricsPerService: serviceHistoryMetricIds.length,
  services: serviceIds.length,
} as const
