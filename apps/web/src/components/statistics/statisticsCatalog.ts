import { MINUTES_PER_STEP } from '@disaster/sim-core'
import type {
  MunicipalitySnapshot,
  ServiceId,
  SimulationFrame,
  SimulationHistory,
  SimulationHistoryPoint,
} from '@disaster/sim-core'
import type { RegionalStatistics } from '../../data'

export type StatisticValueFormat =
  | 'count'
  | 'decimal'
  | 'percent'
  | 'currency-thousands'
  | 'urbanity'
  | 'ratio'
  | 'temperature'
  | 'factor'

export interface MetricDescriptor {
  id: string
  label: string
  description: string
  unit: string
  format: StatisticValueFormat
  decimals?: number
  domain?: readonly [number, number]
  includeZero?: boolean
}

export interface RegionalMetricDescriptor extends MetricDescriptor {
  key: keyof RegionalStatistics
}

export interface RegionalMetricGroup {
  id: string
  label: string
  description: string
  color: string
  metrics: readonly RegionalMetricDescriptor[]
}

const regionalMetric = (
  key: keyof RegionalStatistics,
  label: string,
  description: string,
  unit: string,
  format: StatisticValueFormat = 'count',
  decimals?: number,
): RegionalMetricDescriptor => ({
  id: key,
  key,
  label,
  description,
  unit,
  format,
  decimals,
  includeZero: false,
})

/**
 * Complete display catalogue for the 36 fields emitted by fetch-realism-data.
 * The runtime coverage test deliberately fails when the ingest contract and
 * this catalogue drift apart.
 */
export const REGIONAL_STATISTIC_GROUPS: readonly RegionalMetricGroup[] = [
  {
    id: 'population',
    label: 'Population',
    description: 'Residents, sex and age structure reported by CBS.',
    color: '#7edcc8',
    metrics: [
      regionalMetric('population', 'Residents', 'Registered residents in the buurt.', 'people'),
      regionalMetric('men', 'Men', 'Registered male residents.', 'people'),
      regionalMetric('women', 'Women', 'Registered female residents.', 'people'),
      regionalMetric('age0To14', 'Age 0–14', 'Residents aged 0 through 14.', 'people'),
      regionalMetric('age15To24', 'Age 15–24', 'Residents aged 15 through 24.', 'people'),
      regionalMetric('age25To44', 'Age 25–44', 'Residents aged 25 through 44.', 'people'),
      regionalMetric('age45To64', 'Age 45–64', 'Residents aged 45 through 64.', 'people'),
      regionalMetric('age65Plus', 'Age 65+', 'Residents aged 65 and older.', 'people'),
    ],
  },
  {
    id: 'households',
    label: 'Households',
    description: 'Household composition and average household size.',
    color: '#83b9ff',
    metrics: [
      regionalMetric('households', 'Households', 'Private households in the buurt.', 'households'),
      regionalMetric(
        'onePersonHouseholds',
        'One-person households',
        'Private households occupied by one person.',
        'households',
      ),
      regionalMetric(
        'householdsWithoutChildren',
        'Households without children',
        'Multi-person households without children.',
        'households',
      ),
      regionalMetric(
        'householdsWithChildren',
        'Households with children',
        'Private households with one or more children.',
        'households',
      ),
      regionalMetric(
        'averageHouseholdSize',
        'Average household size',
        'Mean number of residents per private household.',
        'people / household',
        'decimal',
        1,
      ),
    ],
  },
  {
    id: 'housing',
    label: 'Housing & energy',
    description: 'Buildings, tenure, dwelling form, value and heating context.',
    color: '#d9b071',
    metrics: [
      regionalMetric('homes', 'Homes', 'Residential dwellings in the buurt.', 'homes'),
      regionalMetric(
        'nonResidentialBuildings',
        'Non-residential buildings',
        'Buildings whose main use is not residential.',
        'buildings',
      ),
      regionalMetric(
        'averageHomeValueThousands',
        'Average home value',
        'Average WOZ property value, reported in thousands of euros.',
        '€ × 1,000',
        'currency-thousands',
      ),
      regionalMetric(
        'singleFamilyHomePct',
        'Single-family homes',
        'Share of homes classified as single-family.',
        '%',
        'percent',
      ),
      regionalMetric(
        'multiFamilyHomePct',
        'Multi-family homes',
        'Share of homes classified as multi-family.',
        '%',
        'percent',
      ),
      regionalMetric(
        'ownerOccupiedPct',
        'Owner occupied',
        'Share of occupied homes owned by their residents.',
        '%',
        'percent',
      ),
      regionalMetric('rentalPct', 'Rental homes', 'Share of occupied homes that are rented.', '%', 'percent'),
      regionalMetric(
        'socialRentalPct',
        'Housing-corporation rent',
        'Share of homes rented from a housing corporation.',
        '%',
        'percent',
      ),
      regionalMetric(
        'districtHeatingPct',
        'District heating',
        'Share of homes connected to district or block heating.',
        '%',
        'percent',
      ),
    ],
  },
  {
    id: 'support-economy',
    label: 'Support & economy',
    description: 'Benefits, business activity and public charging infrastructure.',
    color: '#c89cf4',
    metrics: [
      regionalMetric(
        'socialAssistanceRecipients',
        'Social-assistance recipients',
        'People receiving social-assistance benefits.',
        'people',
      ),
      regionalMetric(
        'disabilityBenefitRecipients',
        'Disability-benefit recipients',
        'People receiving disability benefits.',
        'people',
      ),
      regionalMetric(
        'oldAgePensionRecipients',
        'Old-age pension recipients',
        'People receiving statutory old-age pension.',
        'people',
      ),
      regionalMetric('businesses', 'Business establishments', 'Registered business establishments.', 'establishments'),
      regionalMetric(
        'publicChargingPoints',
        'Public charging points',
        'Publicly accessible electric-vehicle charging points.',
        'charging points',
      ),
    ],
  },
  {
    id: 'mobility-access',
    label: 'Mobility & access',
    description: 'Car availability and straight-line proximity to essential services.',
    color: '#67c5f0',
    metrics: [
      regionalMetric('cars', 'Passenger cars', 'Registered passenger cars.', 'cars'),
      regionalMetric(
        'carsPerHousehold',
        'Cars per household',
        'Passenger cars per private household.',
        'cars / household',
        'decimal',
        1,
      ),
      regionalMetric(
        'distanceToDoctorKm',
        'Distance to general practitioner',
        'Mean road distance to the nearest general-practitioner practice.',
        'km',
        'decimal',
        1,
      ),
      regionalMetric(
        'distanceToSupermarketKm',
        'Distance to supermarket',
        'Mean road distance to the nearest large supermarket.',
        'km',
        'decimal',
        1,
      ),
    ],
  },
  {
    id: 'land-urbanity',
    label: 'Land & urbanity',
    description: 'Area, density and degree of urbanisation.',
    color: '#98d47b',
    metrics: [
      regionalMetric('populationDensity', 'Population density', 'Residents per square kilometre of land.', 'people / km²'),
      regionalMetric('landAreaHa', 'Land area', 'Land surface area.', 'ha'),
      regionalMetric('waterAreaHa', 'Water area', 'Inland-water surface area.', 'ha'),
      regionalMetric(
        'urbanityClass',
        'Urbanity class',
        'CBS five-class degree of urbanisation: 1 is most urban and 5 least urban.',
        'class 1–5',
        'urbanity',
      ),
      regionalMetric(
        'addressDensity',
        'Surrounding address density',
        'Average number of addresses within a one-kilometre radius.',
        'addresses / km²',
      ),
    ],
  },
] as const

export const REGIONAL_STATISTICS = REGIONAL_STATISTIC_GROUPS.flatMap((group) =>
  group.metrics.map((metric) => ({ ...metric, groupId: group.id, groupLabel: group.label })),
)

export interface DistributionSummary {
  observedCount: number
  missingCount: number
  minimum: number | null
  p10: number | null
  median: number | null
  p90: number | null
  maximum: number | null
  selectedValue: number | null
  comparisonValue: number | null
  selectedPercentile: number | null
  comparisonPercentile: number | null
  bins: Array<{ minimum: number; maximum: number; count: number }>
}

function finiteValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function quantile(sorted: readonly number[], probability: number): number | null {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const fraction = position - lower
  return sorted[lower] + (sorted[Math.min(sorted.length - 1, lower + 1)] - sorted[lower]) * fraction
}

function percentileRank(sorted: readonly number[], value: number | null): number | null {
  if (value === null || !sorted.length) return null
  const below = sorted.filter((candidate) => candidate < value).length
  const equal = sorted.filter((candidate) => candidate === value).length
  return ((below + equal * 0.5) / sorted.length) * 100
}

export function summarizeRegionalDistribution(
  metric: RegionalMetricDescriptor,
  selected: RegionalStatistics | null | undefined,
  peers: readonly (RegionalStatistics | null | undefined)[],
  comparison?: RegionalStatistics | null,
  binCount = 12,
): DistributionSummary {
  const peerValues = peers
    .map((statistics) => finiteValue(statistics?.[metric.key]))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  const selectedValue = finiteValue(selected?.[metric.key])
  const comparisonValue = finiteValue(comparison?.[metric.key])
  const minimum = peerValues[0] ?? null
  const maximum = peerValues.at(-1) ?? null
  const safeBinCount = Math.max(1, Math.round(binCount))
  const bins: DistributionSummary['bins'] = []

  if (minimum !== null && maximum !== null) {
    const spread = maximum - minimum
    for (let index = 0; index < safeBinCount; index += 1) {
      const binMinimum = spread === 0 ? minimum : minimum + (spread * index) / safeBinCount
      const binMaximum = spread === 0 ? maximum : minimum + (spread * (index + 1)) / safeBinCount
      bins.push({ minimum: binMinimum, maximum: binMaximum, count: 0 })
    }
    for (const value of peerValues) {
      const index =
        spread === 0
          ? Math.floor(safeBinCount / 2)
          : Math.min(safeBinCount - 1, Math.floor(((value - minimum) / spread) * safeBinCount))
      bins[index].count += 1
    }
  }

  return {
    observedCount: peerValues.length,
    missingCount: Math.max(0, peers.length - peerValues.length),
    minimum,
    p10: quantile(peerValues, 0.1),
    median: quantile(peerValues, 0.5),
    p90: quantile(peerValues, 0.9),
    maximum,
    selectedValue,
    comparisonValue,
    selectedPercentile: percentileRank(peerValues, selectedValue),
    comparisonPercentile: percentileRank(peerValues, comparisonValue),
    bins,
  }
}

const urbanityLabels: Record<number, string> = {
  1: 'Very strongly urban',
  2: 'Strongly urban',
  3: 'Moderately urban',
  4: 'Slightly urban',
  5: 'Not urban',
}

const integerFormatter = new Intl.NumberFormat('en-NL', { maximumFractionDigits: 0 })
const decimalFormatters = new Map<number, Intl.NumberFormat>()

function decimalFormatter(decimals = 1) {
  const cached = decimalFormatters.get(decimals)
  if (cached) return cached
  const formatter = new Intl.NumberFormat('en-NL', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  decimalFormatters.set(decimals, formatter)
  return formatter
}

export function formatStatisticValue(
  value: number | null | undefined,
  metric: Pick<MetricDescriptor, 'format' | 'unit' | 'decimals'>,
): string {
  if (finiteValue(value) === null) return 'No observation'
  const numericValue = value as number
  switch (metric.format) {
    case 'currency-thousands':
      return `€${integerFormatter.format(numericValue)}k`
    case 'percent':
      return `${decimalFormatter(metric.decimals ?? 0).format(numericValue)}%`
    case 'ratio':
      return `${decimalFormatter(metric.decimals ?? 0).format(numericValue * 100)}%`
    case 'temperature':
      return `${decimalFormatter(metric.decimals ?? 1).format(numericValue)} °C`
    case 'factor':
      return `${decimalFormatter(metric.decimals ?? 2).format(numericValue)}×`
    case 'urbanity':
      return urbanityLabels[Math.round(numericValue)] ?? `Class ${integerFormatter.format(numericValue)}`
    case 'decimal':
      return `${decimalFormatter(metric.decimals ?? 1).format(numericValue)}${metric.unit ? ` ${metric.unit}` : ''}`
    case 'count':
    default:
      return `${integerFormatter.format(numericValue)}${metric.unit ? ` ${metric.unit}` : ''}`
  }
}

export interface SimulationMetricDescriptor extends MetricDescriptor {
  read: (frame: SimulationFrame, municipalityId?: string) => number | null
}

export interface SimulationMetricGroup {
  id: string
  label: string
  description: string
  color: string
  scope: 'national' | 'municipality'
  metrics: readonly SimulationMetricDescriptor[]
}

function selectedMunicipality(
  frame: SimulationFrame,
  municipalityId?: string,
): MunicipalitySnapshot | undefined {
  return municipalityId
    ? frame.municipalities.find((municipality) => municipality.id === municipalityId)
    : undefined
}

const nationalMetric = (
  key: keyof SimulationFrame['national'],
  label: string,
  description: string,
  unit: string,
  format: StatisticValueFormat,
  options: Partial<MetricDescriptor> = {},
): SimulationMetricDescriptor => ({
  id: `national.${key}`,
  label,
  description,
  unit,
  format,
  includeZero: true,
  ...options,
  read: (frame) => finiteValue(frame.national[key]),
})

const municipalityMetric = (
  key: 'population' | 'systemPressure' | 'affectedPopulation' | 'deprivedPersonHours',
  label: string,
  description: string,
  unit: string,
  format: StatisticValueFormat,
  options: Partial<MetricDescriptor> = {},
): SimulationMetricDescriptor => ({
  id: `municipality.${key}`,
  label,
  description,
  unit,
  format,
  includeZero: true,
  ...options,
  read: (frame, municipalityId) => finiteValue(selectedMunicipality(frame, municipalityId)?.[key]),
})

type HazardNumericKey = {
  [Key in keyof MunicipalitySnapshot['hazard']]-?: NonNullable<MunicipalitySnapshot['hazard'][Key]> extends number
    ? Key
    : never
}[keyof MunicipalitySnapshot['hazard']]

const hazardMetric = (
  key: HazardNumericKey,
  label: string,
  description: string,
  unit: string,
  format: StatisticValueFormat,
  options: Partial<MetricDescriptor> = {},
): SimulationMetricDescriptor => ({
  id: `hazard.${key}`,
  label,
  description,
  unit,
  format,
  includeZero: true,
  ...options,
  read: (frame, municipalityId) =>
    finiteValue(selectedMunicipality(frame, municipalityId)?.hazard[key]),
})

const serviceMetric = (
  service: ServiceId,
  key: 'availability' | 'demand' | 'delivered' | 'reserveHours',
  label: string,
  unit: string,
  format: StatisticValueFormat,
  options: Partial<MetricDescriptor> = {},
): SimulationMetricDescriptor => ({
  id: `service.${service}.${key}`,
  label,
  description: `${label} for the modeled ${service} service.`,
  unit,
  format,
  includeZero: true,
  ...options,
  read: (frame, municipalityId) =>
    finiteValue(selectedMunicipality(frame, municipalityId)?.services[service][key]),
})

const SERVICE_IDS: readonly ServiceId[] = [
  'power',
  'water',
  'drainage',
  'gas',
  'telecom',
  'mobility',
  'facilities',
  'supply',
]

const serviceLabels: Record<ServiceId, string> = {
  power: 'Electricity',
  water: 'Drinking water',
  drainage: 'Drainage',
  gas: 'Gas & heating',
  telecom: 'Telecom',
  mobility: 'Mobility',
  facilities: 'Critical facilities',
  supply: 'Emergency supply',
}

const serviceColors: Record<ServiceId, string> = {
  power: '#ffd866',
  water: '#52c8ff',
  drainage: '#4dd6bf',
  gas: '#ff9d5c',
  telecom: '#bd8cff',
  mobility: '#7db4ff',
  facilities: '#ff7e93',
  supply: '#e7d488',
}

export const SIMULATION_METRIC_GROUPS: readonly SimulationMetricGroup[] = [
  {
    id: 'national',
    label: 'National picture',
    description: 'Population-weighted and aggregate model outputs for the Netherlands.',
    color: '#78d8cc',
    scope: 'national',
    metrics: [
      nationalMetric('population', 'National population', 'Population represented by the simulation.', 'people', 'count'),
      nationalMetric('affectedPopulation', 'Modeled people under pressure', 'Current post-network equivalent resident count derived from population and the modeled essential-service pressure threshold; includes the logical transfer stage and is not identified people.', 'people', 'count'),
      nationalMetric('averageAvailability', 'Average service availability', 'Population-weighted essential-service availability.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      nationalMetric('criticalMunicipalities', 'Critical municipalities', 'Municipalities in critical or failed state.', 'municipalities', 'count'),
      nationalMetric('activeBottlenecks', 'Active route bottlenecks', 'Bottleneck routes for the currently projected service.', 'routes', 'count'),
      nationalMetric('deprivedPersonHours', 'Local pre-network deprived person-hours', 'Cumulative event-attributable local-service shortfall above the matched no-event baseline. It excludes intermunicipal logical transfers, so it is not directly comparable with the current post-network people-under-pressure count.', 'person-hours', 'count'),
    ],
  },
  {
    id: 'impact',
    label: 'Municipal impact',
    description: 'Population exposure and accumulated service pressure for the selected municipality.',
    color: '#ff8798',
    scope: 'municipality',
    metrics: [
      municipalityMetric('population', 'Municipal population', 'Population represented by the selected municipality.', 'people', 'count'),
      municipalityMetric('affectedPopulation', 'Modeled residents under pressure', 'Current post-network equivalent resident count derived from population and the modeled essential-service pressure threshold; includes the logical transfer stage and is not identified people.', 'people', 'count'),
      {
        id: 'municipality.affectedShare',
        label: 'Modeled pressure share',
        description: 'Share of the municipality represented by the modelled equivalent count under service pressure.',
        unit: '%',
        format: 'ratio',
        decimals: 0,
        domain: [0, 1],
        includeZero: true,
        read: (frame, municipalityId) => {
          const municipality = selectedMunicipality(frame, municipalityId)
          return municipality
            ? municipality.affectedPopulation / Math.max(1, municipality.population)
            : null
        },
      },
      municipalityMetric('systemPressure', 'System pressure', 'Current post-network weighted shortfall across essential services.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      municipalityMetric('deprivedPersonHours', 'Local pre-network deprived person-hours', 'Cumulative event-attributable local-service burden above the matched no-event baseline. It excludes intermunicipal logical transfers, so zero here can coexist with a nonzero current post-network pressure count.', 'person-hours', 'count'),
    ],
  },
  {
    id: 'hazard',
    label: 'Hazard forcing',
    description: 'Every numeric physical, climate and digital forcing exposed by the engine.',
    color: '#bd79ed',
    scope: 'municipality',
    metrics: [
      hazardMetric('severity', 'Current hazard severity', 'Combined current forcing severity.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      hazardMetric('peakSeverity', 'Peak hazard severity', 'Highest severity reached up to this frame.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      hazardMetric('rainMmH', 'Rainfall intensity', 'Modelled rainfall intensity.', 'mm/h', 'decimal', { decimals: 1 }),
      {
        id: 'hazard.floodDepthM',
        label: 'Inundation stress proxy',
        description: 'Normalized depth-like scenario stress; not a hydraulic-model or LIWO water-depth observation.',
        unit: '%',
        format: 'ratio',
        decimals: 0,
        domain: [0, 1],
        includeZero: true,
        read: (frame, municipalityId) => {
          const value = finiteValue(selectedMunicipality(frame, municipalityId)?.hazard.floodDepthM)
          return value === null ? null : Math.max(0, Math.min(1, value / 1.5))
        },
      },
      hazardMetric('windGustMs', 'Wind gust', 'Modelled peak gust speed.', 'm/s', 'decimal', { decimals: 1 }),
      hazardMetric('heatC', 'Air temperature', 'Modelled air temperature.', '°C', 'temperature', { decimals: 1, includeZero: false }),
      hazardMetric('snowCmH', 'Snowfall intensity', 'Modelled snowfall rate.', 'cm/h', 'decimal', { decimals: 1 }),
      hazardMetric('iceSeverity', 'Ice severity', 'Dimensionless ice-impact forcing.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      hazardMetric('coldStress', 'Cold stress', 'Dimensionless cold-exposure stress.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      hazardMetric('droughtSeverity', 'Drought severity', 'Dimensionless drought stress.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      hazardMetric('wildfireIntensity', 'Wildfire intensity', 'Dimensionless wildfire forcing.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      hazardMetric('smokeSeverity', 'Smoke severity', 'Dimensionless smoke exposure.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      hazardMetric('groundMotionG', 'Scenario ground-motion proxy', 'Synthetic peak-ground-acceleration-like output; not a calibrated seismic estimate.', 'g', 'decimal', { decimals: 3 }),
      hazardMetric('cyberDisruption', 'Cyber disruption', 'Dimensionless digital-service disruption.', '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      hazardMetric('climateTemperatureDeltaC', 'Climate temperature delta', 'Climate-path temperature adjustment used by the scenario.', '°C', 'temperature', { decimals: 1, includeZero: false }),
      hazardMetric('climatePrecipitationMultiplier', 'Climate precipitation multiplier', 'Climate-path multiplier applied to extreme precipitation.', '×', 'factor', { decimals: 2, includeZero: false }),
      hazardMetric('climateSeaLevelDeltaM', 'Climate sea-level delta', 'Climate-path sea-level adjustment.', 'm', 'decimal', { decimals: 2, includeZero: false }),
    ],
  },
  ...SERVICE_IDS.map<SimulationMetricGroup>((service) => ({
    id: `service-${service}`,
    label: serviceLabels[service],
    description: `Modeled delivery, demand, availability and reserves for ${serviceLabels[service].toLowerCase()}.`,
    color: serviceColors[service],
    scope: 'municipality',
    metrics: [
      serviceMetric(service, 'availability', `${serviceLabels[service]} availability`, '%', 'ratio', { decimals: 0, domain: [0, 1] }),
      serviceMetric(service, 'demand', `${serviceLabels[service]} demand`, 'u/h', 'decimal', { decimals: 1 }),
      serviceMetric(service, 'delivered', `${serviceLabels[service]} delivered`, 'u/h', 'decimal', { decimals: 1 }),
      serviceMetric(service, 'reserveHours', `${serviceLabels[service]} reserve`, 'h', 'decimal', { decimals: 1 }),
    ],
  })),
] as const

export const SIMULATION_METRICS = SIMULATION_METRIC_GROUPS.flatMap((group) =>
  group.metrics.map((metric) => ({ ...metric, groupId: group.id, groupLabel: group.label })),
)

export interface TimelinePoint {
  step: number
  hour: number
  value: number | null
}

export type SimulationTimeline = Record<string, TimelinePoint[]>

export interface CompiledSimulationTimeline {
  timeline: SimulationTimeline
  frameCount: number
  minimumHour: number | null
  maximumHour: number | null
  season: SimulationFrame['scenario']['season'] | null
  intervalMinutes: number | null
  municipalityId?: string
}

function inferIntervalMinutes(points: readonly { hour: number }[]): number | null {
  const orderedHours = [...new Set(points.map((point) => point.hour))].sort(
    (left, right) => left - right,
  )
  let smallestDifference = Number.POSITIVE_INFINITY
  for (let index = 1; index < orderedHours.length; index += 1) {
    const difference = orderedHours[index] - orderedHours[index - 1]
    if (difference > 0) smallestDifference = Math.min(smallestDifference, difference)
  }
  return Number.isFinite(smallestDifference) ? smallestDifference * 60 : null
}

/**
 * Compile frames in one pass. Supplying a generator lets callers extract the
 * graph values without retaining the route-heavy SimulationFrame objects.
 */
export function compileSimulationTimeline(
  frames: Iterable<SimulationFrame>,
  municipalityId?: string,
): CompiledSimulationTimeline {
  const timeline = Object.fromEntries(
    SIMULATION_METRICS.map((metric) => [metric.id, [] as TimelinePoint[]]),
  ) as SimulationTimeline
  let frameCount = 0
  let minimumHour: number | null = null
  let maximumHour: number | null = null
  let season: SimulationFrame['scenario']['season'] | null = null
  const encounteredHours: number[] = []

  for (const frame of frames) {
    frameCount += 1
    minimumHour = minimumHour === null ? frame.hour : Math.min(minimumHour, frame.hour)
    maximumHour = maximumHour === null ? frame.hour : Math.max(maximumHour, frame.hour)
    season ??= frame.scenario.season
    encounteredHours.push(frame.hour)
    for (const metric of SIMULATION_METRICS) {
      timeline[metric.id].push({
        step: frame.step,
        hour: frame.hour,
        value: metric.read(frame, municipalityId),
      })
    }
  }

  for (const points of Object.values(timeline)) {
    points.sort((left, right) => left.hour - right.hour)
  }

  return {
    timeline,
    frameCount,
    minimumHour,
    maximumHour,
    season,
    intervalMinutes: inferIntervalMinutes(encounteredHours.map((hour) => ({ hour }))),
    ...(municipalityId ? { municipalityId } : {}),
  }
}

function readHistoryMetric(
  metricId: string,
  point: SimulationHistoryPoint,
  municipalityId?: string,
): number | null {
  if (metricId.startsWith('national.')) {
    const key = metricId.slice('national.'.length) as keyof SimulationHistoryPoint['national']
    return finiteValue(point.national[key])
  }

  const municipality = municipalityId
    ? point.municipalities.find((candidate) => candidate.id === municipalityId)
    : undefined
  if (!municipality) return null

  if (metricId === 'municipality.affectedShare') {
    return municipality.affectedPopulation / Math.max(1, municipality.population)
  }
  if (metricId.startsWith('municipality.')) {
    const key = metricId.slice('municipality.'.length) as
      | 'population'
      | 'systemPressure'
      | 'affectedPopulation'
      | 'deprivedPersonHours'
    return finiteValue(municipality[key])
  }
  if (metricId.startsWith('hazard.')) {
    const key = metricId.slice('hazard.'.length) as keyof typeof municipality.hazard
    const value = finiteValue(municipality.hazard[key])
    return key === 'floodDepthM' && value !== null
      ? Math.max(0, Math.min(1, value / 1.5))
      : value
  }
  if (metricId.startsWith('service.')) {
    const [, service, key] = metricId.split('.') as [
      'service',
      ServiceId,
      keyof (typeof municipality.services)[ServiceId],
    ]
    return finiteValue(municipality.services[service]?.[key])
  }
  return null
}

/** Compile the sim-core lightweight history contract without recreating frames. */
export function compileSimulationHistory(
  history: SimulationHistory,
  municipalityId?: string,
): CompiledSimulationTimeline {
  const timeline = Object.fromEntries(
    SIMULATION_METRICS.map((metric) => [
      metric.id,
      history.points
        .map((point): TimelinePoint => ({
          step: point.step,
          hour: point.hour,
          value: readHistoryMetric(metric.id, point, municipalityId),
        }))
        .sort((left, right) => left.hour - right.hour),
    ]),
  ) as SimulationTimeline
  const hours = history.points.map((point) => point.hour)

  return {
    timeline,
    frameCount: history.points.length,
    minimumHour: hours.length ? Math.min(...hours) : null,
    maximumHour: hours.length ? Math.max(...hours) : null,
    season: history.scenario.season,
    intervalMinutes: history.intervalSteps * MINUTES_PER_STEP,
    ...(municipalityId ? { municipalityId } : {}),
  }
}

export function buildSimulationTimeline(
  frames: readonly SimulationFrame[],
  municipalityId?: string,
): SimulationTimeline {
  return compileSimulationTimeline(frames, municipalityId).timeline
}

export function splitFiniteRuns(points: readonly TimelinePoint[]): TimelinePoint[][] {
  const runs: TimelinePoint[][] = []
  let current: TimelinePoint[] = []
  for (const point of points) {
    if (point.value === null || !Number.isFinite(point.value)) {
      if (current.length) runs.push(current)
      current = []
    } else {
      current.push(point)
    }
  }
  if (current.length) runs.push(current)
  return runs
}

export function timelineExtent(
  timelines: readonly (readonly TimelinePoint[])[],
  metric: Pick<MetricDescriptor, 'domain' | 'includeZero'>,
): readonly [number, number] {
  if (metric.domain) return metric.domain
  const values = timelines
    .flatMap((timeline) => timeline.map((point) => point.value))
    .filter((value): value is number => value !== null && Number.isFinite(value))
  if (!values.length) return [0, 1]
  let minimum = Math.min(...values)
  let maximum = Math.max(...values)
  if (metric.includeZero) {
    minimum = Math.min(0, minimum)
    maximum = Math.max(0, maximum)
  }
  if (minimum === maximum) {
    const padding = Math.max(1, Math.abs(minimum) * 0.08)
    return [minimum - padding, maximum + padding]
  }
  const padding = (maximum - minimum) * 0.08
  return [metric.includeZero ? Math.max(0, minimum - padding) : minimum - padding, maximum + padding]
}

export function timelineSummary(points: readonly TimelinePoint[]) {
  const observed = points.filter(
    (point): point is TimelinePoint & { value: number } =>
      point.value !== null && Number.isFinite(point.value),
  )
  if (!observed.length) {
    return { observedCount: 0, missingCount: points.length, minimum: null, maximum: null, latest: null, maximumHour: null }
  }
  const maximumPoint = observed.reduce((current, point) =>
    point.value > current.value ? point : current,
  )
  return {
    observedCount: observed.length,
    missingCount: points.length - observed.length,
    minimum: Math.min(...observed.map((point) => point.value)),
    maximum: maximumPoint.value,
    latest: observed.at(-1)?.value ?? null,
    maximumHour: maximumPoint.hour,
  }
}
