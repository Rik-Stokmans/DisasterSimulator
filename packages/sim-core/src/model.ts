import { clamp, distanceKm, geometryCentroid, hashString, seededUnit } from './geometry'
import { buildNationalNetwork } from './network'
import { generatedMunicipalityAuditGuardNotes } from './audited-municipality-guards.generated'
import type {
  CauseContribution,
  CityDetailFrame,
  ClimateSettings,
  Coordinates,
  CounterfactualResult,
  DependencyChain,
  DriverMetadata,
  DisasterType,
  DistrictSnapshot,
  ExplainedHazardState,
  ExplainedServiceState,
  HazardDimension,
  HazardState,
  LayerId,
  LocalAllocationExplanation,
  LocalRegionContext,
  LocalRegionDefinition,
  MunicipalityDefinition,
  MunicipalityExplanation,
  MunicipalitySnapshot,
  OperationalStatus,
  RouteDefinition,
  RouteSnapshot,
  ScenarioConfig,
  ScenarioPresetId,
  Season,
  ServiceDependencyEffect,
  ServiceId,
  SimulationFrame,
  SimulationOptions,
} from './types'
import {
  MAX_HOURS,
  MAX_SCENARIO_DURATION_HOURS,
  MINUTES_PER_STEP,
  TIMELINE_STEPS,
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

const serviceDemandFactor: Record<ServiceId, number> = {
  power: 1,
  water: 0.82,
  drainage: 0.55,
  gas: 0.62,
  telecom: 0.48,
  mobility: 0.75,
  facilities: 0.42,
  supply: 0.58,
}

const systemServiceWeights: Record<ServiceId, number> = {
  power: 0.18,
  water: 0.15,
  drainage: 0.08,
  gas: 0.09,
  telecom: 0.12,
  mobility: 0.12,
  facilities: 0.14,
  supply: 0.12,
}

function effectDirection(effect: number): CauseContribution['direction'] {
  return effect > 1e-12 ? 'increases' : effect < -1e-12 ? 'decreases' : 'neutral'
}

const statusColors: Record<OperationalStatus, string> = {
  operational: '#54d7b0',
  strained: '#d6d45e',
  degraded: '#ffad4d',
  critical: '#ff6577',
  failed: '#a12e4d',
  recovering: '#76b8ff',
}

const referenceClimate = (): ClimateSettings => ({
  path: 'reference',
  horizon: 'current',
})

const makePreset = (
  disaster: ScenarioPresetId,
  name: string,
  season: Season,
  intensity: number,
  durationHours: number,
  responseDelayHours: number,
  options: {
    startHour?: number
    preparedness?: number
    components?: ScenarioConfig['components']
    epicenter?: Coordinates
  } = {},
): ScenarioConfig => ({
  id: `nl-${disaster}-v3`,
  name,
  disaster,
  components: options.components,
  season,
  climate: referenceClimate(),
  intensity,
  durationHours,
  startHour: options.startHour ?? 0,
  preparedness: options.preparedness ?? 0.48,
  responseDelayHours,
  seed: 20260831,
  epicenter: options.epicenter,
  dayType: 'weekday',
  startClockHour: 8,
  demandMultiplier: 1,
  backupMultiplier: 1,
  networkCapacityMultiplier: 1,
  repairCapacityMultiplier: 1,
  // National 2026 preparedness-survey proxy, deliberately editable and not
  // represented as a municipality observation.
  householdPreparedness: 0.44,
})

/**
 * Inspectable starting points, not calibrated forecasts. All physical values
 * remain derived in the hazard functions and can be replaced by official
 * forcing without changing the simulation contract.
 */
export const scenarioPresets: Record<ScenarioPresetId, ScenarioConfig> = {
  'severe-storm': makePreset('severe-storm', 'Severe windstorm', 'autumn', 0.78, 18, 8, { preparedness: 0.55 }),
  'pluvial-flood': makePreset('pluvial-flood', 'Urban cloudburst', 'summer', 0.82, 12, 6, { startHour: 2, preparedness: 0.48 }),
  // High-water episodes can remain elevated well beyond the 72-hour operations
  // window. Keeping the forcing active prevents an artificial all-clear at T+72.
  'river-flood': makePreset('river-flood', 'Rhine, Meuse & IJssel high water', 'winter', 0.72, 168, 8, { startHour: 4, preparedness: 0.62 }),
  'coastal-flood': makePreset('coastal-flood', 'Coastal surge', 'autumn', 0.76, 42, 7, { startHour: 1, preparedness: 0.68 }),
  // A KNMI heatwave requires at least five consecutive warm days. The regional
  // Amsterdam-Amstelland risk profile also uses a multi-week heat case. Keep
  // forcing active beyond the 72-hour operations view so T+72 is not rendered
  // as an artificial all-clear.
  heatwave: makePreset('heatwave', 'Heatwave & drought', 'summer', 0.82, 336, 10, { preparedness: 0.46 }),
  'winter-storm': makePreset('winter-storm', 'Winter storm', 'winter', 0.8, 36, 10, { preparedness: 0.58 }),
  cyberattack: makePreset('cyberattack', 'Cyberattack', 'winter', 0.75, 48, 12, { startHour: 3, preparedness: 0.5 }),
  earthquake: makePreset('earthquake', 'Groningen earthquake', 'spring', 0.68, 10, 5, {
    startHour: 2,
    preparedness: 0.6,
    epicenter: [6.5665, 53.2194],
  }),
  wildfire: makePreset('wildfire', 'Wildfire & smoke', 'summer', 0.74, 40, 5, {
    startHour: 6,
    preparedness: 0.52,
    epicenter: [5.75, 52.18],
  }),
  compound: makePreset(
    'compound',
    'Compound cascade',
    'autumn',
    0.84,
    54,
    12,
    {
      preparedness: 0.46,
      components: ['severe-storm', 'pluvial-flood', 'cyberattack'],
    },
  ),
}

export const SCENARIO_PRESETS = scenarioPresets

type ScenarioOverrides = Partial<Omit<ScenarioConfig, 'climate'>> & {
  climate?: Partial<ClimateSettings>
}

export function createScenarioConfig(
  presetId: ScenarioPresetId,
  overrides: ScenarioOverrides = {},
): ScenarioConfig {
  const preset = scenarioPresets[presetId]
  return normalizeScenarioConfig({
    ...preset,
    ...overrides,
    climate: { ...preset.climate, ...overrides.climate },
    components: overrides.components ? [...overrides.components] : preset.components?.slice(),
    targetMunicipalityIds: overrides.targetMunicipalityIds?.slice(),
  })
}

export function normalizeScenarioConfig(config: ScenarioConfig): ScenarioConfig {
  const climatePath = config.climate.path
  const horizon = config.climate.horizon
  const defaultComponents = scenarioPresets.compound.components ?? []
  const requestedComponents = [
    ...new Set(
      config.disaster === 'compound' ? config.components ?? defaultComponents : [config.disaster],
    ),
  ]
  const components = requestedComponents.length ? requestedComponents : [...defaultComponents]
  const finiteClimateOverride = (
    value: number | undefined,
    min: number,
    max: number,
  ): number | undefined =>
    value === undefined || !Number.isFinite(value) ? undefined : clamp(value, min, max)
  const epicenter =
    config.epicenter && config.epicenter.every(Number.isFinite)
      ? ([
          clamp(config.epicenter[0], -180, 180),
          clamp(config.epicenter[1], -90, 90),
        ] as Coordinates)
      : undefined
  const referenceDate = (() => {
    if (!config.referenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(config.referenceDate)) return undefined
    const parsed = new Date(`${config.referenceDate}T00:00:00Z`)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === config.referenceDate
      ? config.referenceDate
      : undefined
  })()
  return {
    ...config,
    intensity: clamp(Number.isFinite(config.intensity) ? config.intensity : 0.8),
    durationHours: clamp(
      Number.isFinite(config.durationHours) ? config.durationHours : 24,
      0.25,
      MAX_SCENARIO_DURATION_HOURS,
    ),
    startHour: clamp(Number.isFinite(config.startHour) ? config.startHour : 0, 0, MAX_HOURS),
    preparedness: clamp(Number.isFinite(config.preparedness) ? config.preparedness : 0.5),
    responseDelayHours: clamp(
      Number.isFinite(config.responseDelayHours) ? config.responseDelayHours : 6,
      0,
      MAX_HOURS,
    ),
    seed: Number.isFinite(config.seed) ? Math.round(config.seed) : hashString(config.id),
    components,
    epicenter,
    referenceDate,
    targetMunicipalityIds: config.targetMunicipalityIds?.slice(),
    dayType:
      config.dayType === 'weekend' || config.dayType === 'holiday'
        ? config.dayType
        : 'weekday',
    startClockHour: clamp(
      Number.isFinite(config.startClockHour) ? config.startClockHour! : 0,
      0,
      23,
    ),
    demandMultiplier: clamp(
      Number.isFinite(config.demandMultiplier) ? config.demandMultiplier! : 1,
      0.25,
      2.5,
    ),
    backupMultiplier: clamp(
      Number.isFinite(config.backupMultiplier) ? config.backupMultiplier! : 1,
      0.25,
      3,
    ),
    networkCapacityMultiplier: clamp(
      Number.isFinite(config.networkCapacityMultiplier)
        ? config.networkCapacityMultiplier!
        : 1,
      0,
      3,
    ),
    repairCapacityMultiplier: clamp(
      Number.isFinite(config.repairCapacityMultiplier)
        ? config.repairCapacityMultiplier!
        : 1,
      0.25,
      3,
    ),
    householdPreparedness: clamp(
      Number.isFinite(config.householdPreparedness) ? config.householdPreparedness! : 0.5,
    ),
    climate: {
      ...config.climate,
      path: climatePath,
      horizon,
      temperatureDeltaC: finiteClimateOverride(
        config.climate.temperatureDeltaC,
        -10,
        10,
      ),
      precipitationMultiplier: finiteClimateOverride(
        config.climate.precipitationMultiplier,
        0.25,
        2.5,
      ),
      seaLevelDeltaM: finiteClimateOverride(config.climate.seaLevelDeltaM, -0.5, 3),
    },
  }
}

function resolveScenario(input: SimulationOptions['scenario']): ScenarioConfig {
  return typeof input === 'string'
    ? createScenarioConfig(input)
    : input
      ? normalizeScenarioConfig(input)
      : createScenarioConfig('severe-storm')
}

type FutureClimatePath = Exclude<ClimateSettings['path'], 'reference'>

/**
 * Inspectable KNMI'23 scenario transforms for sensitivity analysis. The 2100
 * endpoints and the linear horizon factors are model inputs, not a weather
 * forecast or a municipality-level calibration. Explicit climate overrides
 * always take precedence.
 */
const temperatureDelta2100: Record<FutureClimatePath, Record<Season, number>> = {
  Ld: { winter: 0.7, spring: 0.8, summer: 1.2, autumn: 1 },
  Ln: { winter: 0.7, spring: 0.7, summer: 1.1, autumn: 0.9 },
  Md: { winter: 2.1, spring: 2.2, summer: 2.8, autumn: 2.7 },
  Mn: { winter: 2.2, spring: 2, summer: 2.6, autumn: 2.6 },
  Hd: { winter: 3.7, spring: 3.6, summer: 5.1, autumn: 5 },
  Hn: { winter: 3.9, spring: 3.3, summer: 4.7, autumn: 4.8 },
}

const extremeRainMultiplier2100: Record<FutureClimatePath, Record<Season, number>> = {
  Ld: { winter: 0.98, spring: 1.03, summer: 1.04, autumn: 1.04 },
  Ln: { winter: 1.02, spring: 1.05, summer: 1.06, autumn: 1.06 },
  Md: { winter: 1.04, spring: 1.08, summer: 1.11, autumn: 1.08 },
  Mn: { winter: 1.08, spring: 1.1, summer: 1.16, autumn: 1.12 },
  Hd: { winter: 1.08, spring: 1.12, summer: 1.15, autumn: 1.12 },
  Hn: { winter: 1.15, spring: 1.18, summer: 1.31, autumn: 1.2 },
}

const seaLevelDelta2100: Record<FutureClimatePath, number> = {
  Ld: 0.44,
  Ln: 0.44,
  Md: 0.63,
  Mn: 0.63,
  Hd: 0.82,
  Hn: 0.82,
}

function climateHorizonFactor(horizon: ClimateSettings['horizon']): number {
  if (horizon === 'current') return 0
  if (horizon === 2033) return 0.28
  if (horizon === 2050) return 0.45
  if (horizon === 2100) return 1
  return 1.15
}

function climateModifiers(scenario: ScenarioConfig) {
  const { climate, season } = scenario
  if (climate.path === 'reference') {
    return {
      temperatureDeltaC: climate.temperatureDeltaC ?? 0,
      precipitationMultiplier: climate.precipitationMultiplier ?? 1,
      seaLevelDeltaM: climate.seaLevelDeltaM ?? 0,
    }
  }
  const factor = climateHorizonFactor(climate.horizon)
  return {
    temperatureDeltaC:
      climate.temperatureDeltaC ?? temperatureDelta2100[climate.path][season] * factor,
    precipitationMultiplier:
      climate.precipitationMultiplier ??
      1 + (extremeRainMultiplier2100[climate.path][season] - 1) * factor,
    seaLevelDeltaM: climate.seaLevelDeltaM ?? seaLevelDelta2100[climate.path] * factor,
  }
}

export function statusForAvailability(
  availability: number,
  recovering = false,
): OperationalStatus {
  if (recovering && availability >= 0.48 && availability < 0.92) return 'recovering'
  if (availability >= 0.88) return 'operational'
  if (availability >= 0.7) return 'strained'
  if (availability >= 0.48) return 'degraded'
  if (availability >= 0.22) return 'critical'
  return 'failed'
}

function pulse(hour: number, start: number, peak: number, end: number): number {
  if (hour <= start || hour >= end) return 0
  if (hour <= peak) return (hour - start) / (peak - start)
  return 1 - (hour - peak) / (end - peak)
}

function recoveryCurve(hour: number, begins: number, ends: number): number {
  if (hour <= begins) return 0
  if (hour >= ends) return 1
  const x = (hour - begins) / (ends - begins)
  return x * x * (3 - 2 * x)
}

function smoothEnvelope(hour: number, start: number, duration: number): number {
  if (hour <= start || hour >= start + duration) return 0
  const ramp = Math.min(5, Math.max(0.25, duration * 0.2))
  if (hour < start + ramp) return recoveryCurve(hour, start, start + ramp)
  if (hour > start + duration - ramp) {
    return 1 - recoveryCurve(hour, start + duration - ramp, start + duration)
  }
  return 1
}

function seasonalTemperature(
  city: MunicipalityDefinition,
  hour: number,
  season: Season,
  climateDeltaC: number,
): number {
  const means: Record<Season, number> = { winter: 4, spring: 10.5, summer: 18, autumn: 11 }
  const amplitudes: Record<Season, number> = { winter: 2.8, spring: 4.5, summer: 5.2, autumn: 3.8 }
  const local = seededUnit(city.seed, 31)
  const urbanHeat = clamp((city.density ?? 450) / 6_000) * 0.8
  return (
    means[season] +
    Math.sin(((hour + local * 2.5) / 24) * Math.PI * 2 - 1.7) * amplitudes[season] +
    urbanHeat +
    climateDeltaC
  )
}

function distanceToSegmentKm(point: [number, number], start: [number, number], end: [number, number]) {
  const latitudeScale = Math.cos((point[1] * Math.PI) / 180)
  const px = point[0] * latitudeScale
  const py = point[1]
  const ax = start[0] * latitudeScale
  const ay = start[1]
  const bx = end[0] * latitudeScale
  const by = end[1]
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared)
  return distanceKm(point, [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t])
}

const auditedRiverExposureExclusions = new Set([
  'GM0197', 'GM0141', 'GM1723', 'GM0362', 'GM0743', 'GM0744', 'GM0203', 'GM0888',
  'GM1954', 'GM1724', 'GM1721', 'GM0753', 'GM1728', 'GM0376', 'GM0755', 'GM0147',
  'GM0654', 'GM0758', 'GM0899', 'GM0313', 'GM1706', 'GM0109', 'GM1891', 'GM0503',
  'GM0762', 'GM0770', 'GM0772', 'GM0230', 'GM0232', 'GM0153', 'GM0233', 'GM1771',
  'GM1652', 'GM0784', 'GM0664', 'GM1942', 'GM1729', 'GM0158', 'GM0160', 'GM0074',
  'GM0917', 'GM0794', 'GM0163', 'GM0164', 'GM0402', 'GM0798', 'GM1735', 'GM0118',
  'GM0406', 'GM0677', 'GM1884', 'GM0678', 'GM0537', 'GM0928', 'GM1659', 'GM0882',
  'GM0417', 'GM0546', 'GM0547', 'GM1916', 'GM0995', 'GM0553', 'GM0168',
])

const riverScreeningCorridors: Array<[[number, number], [number, number]]> = [
  [[6.78, 51.88], [4.1, 51.82]],
  [[6.13, 51.98], [5.82, 52.68]],
  [[5.72, 50.84], [4.5, 51.73]],
]

const coastalScreeningSegments: Array<[[number, number], [number, number]]> = [
  [[3.45, 51.35], [4.62, 52.48]],
  [[4.62, 52.48], [5.15, 53.25]],
  [[5.15, 53.25], [7.05, 53.45]],
]

const auditedCoastalExposureExclusions = new Set([
  'GM0059', 'GM1942', 'GM0014', 'GM0158', 'GM0405', 'GM0677', 'GM1884', 'GM0166',
  'GM0537', 'GM1598', 'GM0542', 'GM0415', 'GM1621', 'GM0080', 'GM0546', 'GM0547',
  'GM1916', 'GM0553',
])

function riverExposure(city: MunicipalityDefinition): number {
  // Municipality-specific exclusions are added only after an independent
  // audit finds a contradiction against a current primary risk profile. They
  // are an interim safety screen until source-specific LIWO catchment/breach
  // masks replace the proximity field (see audits GM0197, GM0141, GM1723,
  // GM0362, GM0743, GM0744, GM0203, GM0888, GM1954, GM1724, GM1721, GM0753,
  // GM1728, GM0376, GM0755, GM0147, GM0654, GM0758, GM0899, GM0313, GM1706,
  // GM0109, GM1891, GM0503, GM0762, GM0770, GM0772, GM0230, GM0232,
  // GM0153, GM0233, GM1771, GM1652, GM0784, GM0664, GM1942, GM1729,
  // GM0158, GM0160, GM0074, GM0917, GM0794, GM0163, GM0164, GM0402, GM0798,
  // GM1735, GM0118, GM0406, GM0537, GM0928, GM1659, GM0882, GM0417,
  // GM0546, GM0547, GM1916, GM0995, GM0553 and GM0168
  // and the correction log). These municipalities have separately documented
  // local/regional-water mechanisms that the named major-river preset must not
  // silently replace with a diagonal line-distance field.
  if (auditedRiverExposureExclusions.has(city.code)) return 0
  const distance = Math.min(
    ...riverScreeningCorridors.map(([from, to]) => distanceToSegmentKm(city.coordinates, from, to)),
  )
  // This remains a proximity screening field, not a hydraulic flood model.
  // A finite support is safer than assigning a small fictitious Rhine/Meuse/
  // IJssel depth to every municipality in the country.
  return distance <= 50 ? Math.exp(-distance / 24) : 0
}

function coastalExposure(city: MunicipalityDefinition): number {
  // Municipality-specific exclusions are narrow audit corrections, not flood
  // all-clears. Achtkarspelen has a distinct polder/boezem mechanism and
  // Gooise Meren has lake, defence, pump and polder pathways, Groningen has
  // Reitdiep, Drentsche Aa, Eemskanaal, boezem and pluvial pathways, and inland
  // Haaksbergen has brook, groundwater, sewer and culvert pathways, while
  // Hoorn requires a distinct Markermeer/outer-dike or defence event; none is
  // a direct North Sea coast-distance event. Keep those mechanisms Unknown
  // until a governed LIWO/water-authority scenario is selected.
  if (auditedCoastalExposureExclusions.has(city.code)) return 0
  const distance = Math.min(
    ...coastalScreeningSegments.map(([from, to]) => distanceToSegmentKm(city.coordinates, from, to)),
  )
  // Direct coastal inundation is screened to near-coast municipalities. An
  // official LIWO/breach pathway is still required before treating the result
  // as a local depth; indirect national service effects are modeled separately.
  return distance <= 35 ? Math.exp(-distance / 38) : 0
}

function nearestExposure(city: MunicipalityDefinition, centers: Array<[number, number]>, scaleKm: number) {
  const distance = Math.min(...centers.map((center) => distanceKm(city.coordinates, center)))
  return Math.exp(-distance / scaleKm)
}

function nearestDistance(city: MunicipalityDefinition, centers: Array<[number, number]>) {
  return Math.min(...centers.map((center) => distanceKm(city.coordinates, center)))
}

const hazardDimensionsByDisaster: Readonly<
  Record<Exclude<DisasterType, 'compound'>, HazardDimension[]>
> = {
  'severe-storm': ['wind', 'rain', 'flood'],
  'pluvial-flood': ['rain', 'flood'],
  'river-flood': ['flood'],
  'coastal-flood': ['flood'],
  heatwave: ['heat', 'drought'],
  'winter-storm': ['cold', 'snowIce', 'wind'],
  cyberattack: ['cyber'],
  earthquake: ['groundMotion'],
  wildfire: ['fire'],
}

// A municipality-wide audit guard is broader than a mechanism-specific note:
// every event-produced dimension must be neutral downstream until the audit's
// evidence gates are resolved. Raw values remain available as diagnostics.
const municipalityGuardDimensionsByDisaster: Readonly<
  Record<Exclude<DisasterType, 'compound'>, HazardDimension[]>
> = {
  ...hazardDimensionsByDisaster,
  'coastal-flood': ['flood', 'wind'],
  wildfire: ['fire', 'smoke', 'heat', 'drought'],
}

let auditedUnsupportedSpatialNotesCache: Readonly<Record<string, string>> | undefined
let auditedMunicipalityGapNotesCache: Readonly<Record<string, string>> | undefined

function baseHazard(
  city: MunicipalityDefinition,
  hour: number,
  scenario: ScenarioConfig,
  disaster: Exclude<DisasterType, 'compound'>,
): HazardState {
  const climate = climateModifiers(scenario)
  const local = seededUnit(city.seed ^ scenario.seed, hashString(disaster) % 997)
  const temperature = seasonalTemperature(city, hour, scenario.season, climate.temperatureDeltaC)
  const auditedUnsupportedSpatialNotes = auditedUnsupportedSpatialNotesCache ??
    (auditedUnsupportedSpatialNotesCache = {
    'river-flood:GM0363':
      'The Amsterdam-Amstelland risk profile documents a Lek–Amsterdam-Rijnkanaal flood pathway, but a pinned LIWO scenario mask has not yet been sampled. Zero in the internal screening field is unknown, not an all-clear; downstream service impacts omit this mechanism.',
    'river-flood:GM0200':
      'Apeldoorn reports only a very small IJssel flood probability on its eastern side, while the municipality-wide proximity screen produces severe sustained stress. The local amplitude and affected area are unsupported, not a forecast; downstream service impacts may be materially overstated until an expert-selected LIWO/VNOG scenario is intersected.',
    'river-flood:GM0743':
      'The Brabant-Zuidoost risk profile excludes direct sea and major-river influence in Asten, so the generic Rhine/Meuse/IJssel proximity screen is suppressed. Local Aa/Astense Aa flooding and high-river backwater effects remain spatially unresolved, not safe; they require a selected LIWO or catchment-specific footprint.',
    'river-flood:GM0308':
      'Baarn\'s generic Rhine/Meuse/IJssel proximity stress does not model its relevant Eem, Eemmeer, low-polder, dike or pumping pathways. The local amplitude and affected area are unsupported, not an official prediction; a versioned expert-selected LIWO or water-manager scenario is required.',
    'river-flood:GM0744':
      'Baarle-Nassau has no evidenced direct Rhine/Meuse/IJssel inundation pathway for this generic preset, so its false municipality-wide stress is suppressed. Local pluvial flooding, high-sandy-soil drought, regional-water effects and cross-border water-system dependencies remain unresolved, not safe; a selected hydraulic footprint is required.',
    'river-flood:GM0489':
      'Barendrecht has real barrier- and breach-dependent flood risk, but this generic centre-distance field selects no failed defence, IJsselmonde compartment, raised outer-dike strip, connected footprint, arrival time or duration. Its local amplitude and exposed population are unsupported until a named LIWO or water-board scenario is intersected.',
    'coastal-flood:GM0489':
      'Barendrecht has real barrier- and breach-dependent flood risk, but this generic coast-distance field selects no failed defence, IJsselmonde compartment, raised outer-dike strip, connected footprint, arrival time or duration. Its local amplitude and exposed population are unsupported until a named LIWO or water-board scenario is intersected.',
    'pluvial-flood:GM0489':
      'Barendrecht documents rain-water hotspots including Paddewei, Meerwede, Oranjewijk, Centrum and the Oude Dorpskern/Zeeheldenbuurt, but the current shared neighbourhood seed ranks them without hydraulic evidence. Local distribution is unsupported until a versioned municipal stress-test footprint is sampled.',
    'river-flood:GM0203':
      'The published Gelderland-Midden risk profile does not identify Barneveld as a source municipality for its location-bound major-river flood scenario, so the false persistent proximity amplitude is suppressed. Indirect regional effects and local water mechanisms remain unresolved, not safe, until a selected LIWO or Vallei en Veluwe footprint is intersected.',
    'wildfire:GM0203':
      'The synthetic wildfire source lies inside Buitengebied Kootwijk, but the current shared neighbourhood seed does not follow ignition containment, Veluwe fuels, wind, access, extinguishing water or escape routes. The local direct-fire distribution is unsupported until an authoritative fire-sensitivity/perimeter adapter replaces it.',
    'river-flood:GM0888':
      'Beek\'s generic Rhine/Meuse/IJssel proximity amplitude is suppressed because no selected connected hydraulic footprint supports municipality-wide sustained water. Geleenbeek and hillside-runoff pathways remain unresolved, not safe; a versioned LIWO or Waterschap Limburg scenario with no-data semantics is required.',
    'pluvial-flood:GM0888':
      'Beek documents distinct eastern Beek, Neerbeek and Spaubeek runoff and building-risk pathways, but the shared neighbourhood seed does not sample them. The local distribution is unsupported until the applicable Waterschap Limburg raster and water-system context are intersected.',
    'river-flood:GM0889':
      'Beesel has real Maas flood risk, but this generic centre-distance screen selects no current dike state, breach, connected depth footprint, arrival or recession and does not represent the reinforcement completed in 2022. The retained amplitude is diagnostic only and the local result remains Unknown until an expert-selected current hydraulic scenario is intersected.',
    'pluvial-flood:GM0889':
      'Beesel documents Schelkensbeek/Rijksweg, Huilbeek and sewer-overload pathways, while the current shared neighbourhood seed does not use terrain, catchments or control assets. Local distribution is unsupported until a versioned municipal or Waterschap Limburg footprint is sampled.',
    'river-flood:GM1954':
      'Beekdaelen\'s generic Rhine/Meuse/IJssel proximity amplitude is suppressed because it selects no connected Maas, Geul, Hekerbeek or Geleenbeek scenario. Local tributary, hill-runoff, buffer and defence effects remain unresolved, not safe; a named hydraulic footprint is required.',
    'pluvial-flood:GM1954':
      'Beekdaelen documents mechanism-specific runoff toward Hegge, Wijnandsrade, Aalbeek and Hulsberg, but the shared neighbourhood seed does not sample those slopes, streams, roads or buffers. Local distribution is unsupported until a versioned T25/T100 source layer is intersected.',
    'river-flood:GM1724':
      'The Brabant-Zuidoost risk profile places Bergeijk outside direct sea and large-river influence, so the generic Rhine/Meuse/IJssel proximity amplitude is suppressed. Dommel, Beerze, Nete, groundwater, regional-defence and pluvial pathways remain unresolved, not safe; a selected connected hydraulic footprint is required.',
    'pluvial-flood:GM1724':
      'Bergeijk documents rainwater vulnerability in parts of \u2019t Loo, \u2019t Hof, Luyksgestel and Weebosch and groundwater concern along Keersop and Run, but the shared neighbourhood seed samples none of those mechanisms. Local distribution is unsupported until a versioned stress-test or water-depth raster is intersected.',
    'wildfire:GM1724':
      'A source inside De Pielis does not control the current shared neighbourhood allocation: its containing Buitengebied Zuid-West ranks below a town neighbourhood nearly eight kilometres away. Direct-fire distribution is unsupported until source/perimeter, land-cover, fuel, wind and access inputs govern local allocation.',
    'river-flood:GM0893':
      'Bergen has real Maas flood risk, but the generic centre-distance screen selects no breach or defence state, connected floodplain, depth, arrival or recession scenario. The retained amplitude is diagnostic only and the local result remains Unknown until an expert-selected LIWO or Waterschap Limburg scenario is intersected.',
    'pluvial-flood:GM0893':
      'Bergen\u2019s current shared neighbourhood seed does not use its named local drainage assets, terrain, Maas access zone or flood-sensitive approaches. Local distribution is unsupported until a versioned hydraulic or municipal stress-test layer is sampled.',
    'wildfire:GM0893':
      'The canonical remote ignition does not represent the locally material Maasduinen wildfire pathway, while its generic smoke field is not wind- or perimeter-resolved. Local fire and smoke distribution remains unsupported until an explicit incident/scenario perimeter, fuels and timestamped KNMI weather are selected.',
    'river-flood:GM1945':
      'Berg en Dal spans the low Waal/Ooijpolder floodplain and high Groesbeek moraine, but the generic centre-distance screen selects no breach, defence state, connected footprint, arrival, probability band or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected LIWO or water-board scenario is intersected without converting no-data to zero.',
    'pluvial-flood:GM1945':
      'Berg en Dal documents distinct moraine-to-polder flow paths, sloping sand, flat clay, cross-border drainage and completed Breedeweg measures, none of which the shared neighbourhood seed samples. Local pluvial distribution is unsupported until a versioned municipal stress test or validated AHN-derived surface is intersected.',
    'wildfire:GM1945':
      'The canonical remote-smoke exercise does not represent the officially recognised high-risk Groesbeek forest area. Its local smoke and drought allocation remains unsupported until a separately named ignition/perimeter, eligible land cover, weather, access and suppression-water assumptions are supplied.',
    'coastal-flood:GM0373':
      'Bergen (NH.) has real North Sea and defence-dependent coastal risk, but the generic coast-distance screen selects no failed dune or defence section, present condition, surge level, connected footprint, arrival or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected LIWO/HHNK scenario is intersected.',
    'pluvial-flood:GM0373':
      'Bergen (NH.) documents the Sammerspolder and Egmondermeer as acute rainwater locations, but the shared neighbourhood seed uses no polder, elevation, drainage, sewer, pump or control state. Local pluvial distribution is unsupported until a versioned stress-test or water-depth footprint is sampled.',
    'wildfire:GM0373':
      'A source inside Schoorl met Bregtdorp does not control the current shared neighbourhood allocation: its containing neighbourhood ranks below one more than nine kilometres away. Direct-fire distribution is unsupported until source/perimeter, dune fuels, wind, access and extinguishing-water inputs govern local allocation.',
    'river-flood:GM1721':
      'Bernheze is outside a defensible direct Rhine/Meuse/IJssel footprint for this generic preset, so its false major-river amplitude is suppressed. Aa, Leijgraaf, Wetering, groundwater, regional barriers and Maas-backwater mechanisms remain unresolved, not safe; they require a named connected Aa en Maas or LIWO hydraulic scenario.',
    'pluvial-flood:GM1721':
      'Bernheze drains through distinct Aa, Leijgraaf, Wetering and local low-area systems, but the shared neighbourhood seed samples no terrain, catchment, historic channel, drainage or Peelland-fault groundwater mechanism. Local distribution is unsupported until a versioned water-board or municipal footprint is intersected.',
    'wildfire:GM1721':
      'A source inside Hooge Wijst–De Vorssel near the Maashorst edge does not control the shared neighbourhood allocation: distant built-up neighbourhoods can rank above the source area. Direct-fire distribution is unsupported until source/perimeter, eligible vegetation, wind, access and suppression-water inputs govern local allocation.',
    'river-flood:GM1859':
      'Berkelland has low-probability, named dike-failure context, but the generic centre-distance screen selects no IJssel/Rhine dike, connected footprint, probability band, depth, arrival or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected WRIJ or LIWO hydraulic scenario is intersected.',
    'pluvial-flood:GM1859':
      'Waterschap Rijn en IJssel publishes Berkelland T100/T1000 depth, duration, affected-building and road-passability layers, but the current shared neighbourhood seed samples none of them. Local distribution is unsupported until a pinned, licensed KEA scenario with units, vintage and no-data semantics is intersected.',
    'wildfire:GM1859':
      'The canonical event is a remote-smoke exercise and does not represent Berkelland’s published local nature-fire susceptibility, vegetation, users, drought or wind. Local fire distribution is unsupported until a separately named ignition/perimeter and event-valid weather govern eligible land-cover cells.',
    'river-flood:GM0753':
      'The Brabant-Zuidoost risk profile places Best outside direct sea and major-river flood danger, so the generic Rhine/Meuse/IJssel proximity amplitude is suppressed. Local waterlogging and indirect blocked southern drainage during northern high water remain unresolved, not safe; a named connected hydraulic scenario is required.',
    'pluvial-flood:GM0753':
      'Best publishes a native 70 mm/h stress-test surface with materially different hotspots in Breeven, Wilhelminadorp and Speelheide, but the shared neighbourhood seed does not sample it. Local distribution is unsupported until that versioned depth footprint, units and no-data semantics are intersected.',
    'heatwave:GM0753':
      'Best’s climate stress test identifies Breeven among the municipality’s hottest areas, while the shared neighbourhood seed ranks it near the bottom. Local heat distribution is unsupported until the official heat surface and its edition, units and time-of-day assumptions replace the generic seed.',
    'wildfire:GM0753':
      'A source placed at Heide’s official centre does not control the shared neighbourhood allocation: Aarlesche Erven can rank first several kilometres away while Heide ranks sixth. Direct-fire distribution is unsupported until source/perimeter, eligible land cover, wind, access and suppression inputs govern local allocation.',
    'river-flood:GM0209':
      'Beuningen has real Waal and Zuidelijke Waaldijk exposure, but the generic centre-distance screen selects no dike section or breach, defence state, connected footprint, probability, depth, arrival, rise or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected LIWO/LDO or Waterschap Rivierenland scenario is intersected.',
    'pluvial-flood:GM0209':
      'Beuningen documents distinct mixed, separated and pressure-sewer systems plus Winssen seepage, retention and culvert constraints, but the shared neighbourhood seed samples none of these mechanisms or known sensitive locations. Local distribution is unsupported until a versioned municipal or water-board hydraulic footprint is intersected.',
    'wildfire:GM0209':
      'A focused source can rank below unrelated neighbourhoods because the shared allocation does not follow source containment, eligible vegetation, wind, access or suppression water. Direct-fire distribution is unsupported until source/perimeter and event-valid conditions govern local allocation.',
    'river-flood:GM1728':
      'The Brabant-Zuidoost risk profile and Bladel stress test exclude direct primary or regional-defence flooding, so the false Rhine/Meuse/IJssel amplitude is suppressed. Groote Beerze, Dalems Stroompje, groundwater, pluvial and indirectly blocked southern drainage remain unresolved, not safe; a named connected hydraulic scenario is required.',
    'pluvial-flood:GM1728':
      'Bladel publishes distinct rainwater, water-system, drought, surface-temperature and heat-stress maps, but the shared neighbourhood seed samples none of those mechanisms. Local pluvial distribution is unsupported until the native versioned stress-test footprint, units and no-data semantics are intersected.',
    'wildfire:GM1728':
      'A source at Ten Vorsel does not control the shared neighbourhood allocation: its containing area can rank fifteenth while cells nearly seven kilometres away rank first. Direct-fire distribution is unsupported until source/perimeter, eligible Kempen vegetation, wind, access, wetting and suppression inputs govern local allocation.',
    'severe-storm:GM0375':
      'Beverwijk neighbourhood ranks reuse a shared seed rather than event-valid gust, tree/building exposure or infrastructure geometry. Local storm distribution is unsupported until a versioned wind field and exposed-object evidence are sampled.',
    'pluvial-flood:GM0375':
      'Beverwijk documents high-to-low runoff toward Wijkermeerpolder plus Wijckermolen, street, tunnel and cellar waterlogging, but the shared neighbourhood seed samples none of those pathways. Local distribution is unsupported until a pinned municipal or HHNK depth-duration surface is intersected.',
    'coastal-flood:GM0375':
      'Beverwijk has distinct dune and Hoogovens sea-defence pathways, but the generic coast-distance screen selects no failed segment, surge, connected footprint, probability, arrival or dewatering curve. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected LIWO or HHNK scenario is intersected.',
    'heatwave:GM0375':
      'Beverwijk heat rankings reuse the same neighbourhood seed as flood, storm, winter and cyber rather than a versioned surface-temperature, shade, building or vulnerability layer. Local distribution is unsupported until hazard-specific evidence replaces the shared seed.',
    'winter-storm:GM0375':
      'Beverwijk winter rankings reuse the same neighbourhood seed as unrelated hazards and do not sample road, tunnel, rail, bridge or exposed-object icing. Local distribution is unsupported until event-valid weather and asset-specific exposure are intersected.',
    'cyberattack:GM0375':
      'Beverwijk cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary or network dependency. Local distribution is unsupported until an explicit exercise target and authorized dependency model are supplied.',
    'wildfire:GM0375':
      'The canonical event is a remote-smoke exercise and does not represent Beverwijk’s dune-fire pathway, Wijk aan Zee access, eligible vegetation, wind, escape routes or extinguishing water. Local distribution is unsupported until a separately named ignition/perimeter and event-valid conditions are supplied.',
    'river-flood:GM0376':
      'Blaricum’s generic Rhine/Meuse/IJssel amplitude is suppressed because no selected breach, defence, connected footprint, water level, probability, arrival or recession supports it. Laagwatersloot, Gooiergracht, Eemmeer, regional-water and pluvial mechanisms remain unresolved, not safe; an expert-selected LIWO or water-board scenario is required.',
    'pluvial-flood:GM0376':
      'Blaricum documents water nuisance around Park Laagwatersloot and the Gooiergracht drainage chain, but the shared neighbourhood seed samples no rain raster, depression, slope, sewer catchment, receiving-water level, asset connectivity or control state. Local distribution is unsupported until a versioned hydraulic footprint is intersected.',
    'wildfire:GM0376':
      'A source inside Blaricummer Heide does not control the shared neighbourhood allocation: the source area can rank fifth while De Kampen, about five kilometres away, ranks first. Direct-fire distribution is unsupported until source/perimeter, eligible heath/forest, event-valid weather, access and suppression inputs govern local allocation.',
    'severe-storm:GM1901':
      'Bodegraven-Reeuwijk neighbourhood ranks reuse a shared seed rather than event-valid gust, tree/building, A12/rail or exposed-object evidence. Local storm distribution is unsupported until a versioned wind field and asset-specific exposure replace the common ranking.',
    'pluvial-flood:GM1901':
      'Bodegraven-Reeuwijk publishes separate 2025 neighbourhood water-nuisance information, while the shared seed samples no polder/boezem catchment, sewer, terrain, storage, pump, weir, sluice or receiving-water state. Local distribution is unsupported until a versioned municipal or water-board depth-duration footprint is intersected.',
    'river-flood:GM1901':
      'Bodegraven-Reeuwijk has real Dijktraject 14/Lek and local or regional-defence flood risk, but the generic centre-distance screen selects no failed defence, source water, level, connected footprint, arrival or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected versioned LVO/LIWO scenario is intersected.',
    'coastal-flood:GM1901':
      'Bodegraven-Reeuwijk has real defence-dependent flood pathways, but the generic coast-distance screen selects no extreme sea-level chain, failed primary or regional defence, connected footprint, arrival or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected versioned LVO/LIWO scenario is intersected.',
    'heatwave:GM1901':
      'Bodegraven-Reeuwijk publishes separate neighbourhood heat, drought and subsidence context, but the shared ranking samples no surface temperature, shade, paving, building, peat, groundwater or vulnerability evidence. Local heat/drought distribution is unsupported until hazard-specific versioned surfaces replace the common seed.',
    'winter-storm:GM1901':
      'Bodegraven-Reeuwijk winter rankings reuse the same seed as unrelated hazards and do not sample event-valid snow/ice, A12/N11/rail exposure, bridge/underpass conditions or asset-specific access. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1901':
      'Bodegraven-Reeuwijk cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary or authorized dependency topology. Local distribution is unsupported until an explicit exercise target and system model are supplied.',
    'wildfire:GM1901':
      'A source inside Reeuwijkse Hout does not control the shared neighbourhood allocation: its containing neighbourhood can rank fiftieth while cells more than three kilometres away rank first. Direct-fire distribution is unsupported until source/perimeter, eligible reed/peat/vegetation, event-valid weather, access, extinguishing water and suppression inputs govern allocation.',
    'river-flood:GM0755':
      'Boekel is outside a defensible direct Rhine/Meuse/IJssel footprint for this generic preset, so its false persistent major-river amplitude is suppressed. Leijgraaf, De Aa, Peelrand-fault, groundwater, regional-water, pluvial and sewer pathways remain unresolved, not safe; they require a named connected hydraulic scenario.',
    'pluvial-flood:GM0755':
      'Boekel documents different cloudburst, bowl/fault-zone, Boschberg, Venhorst, wijst and sandy-soil mechanisms, but the shared neighbourhood seed samples no terrain, catchment, sewer, groundwater or water-control evidence. Local distribution is unsupported until a versioned municipal or water-board footprint is intersected.',
    'heatwave:GM0755':
      'Boekel heat and drought rankings reuse the same neighbourhood seed as river and pluvial flooding rather than the municipality’s distinct Venhorst, wet-wijst, dry-sand, shade, paving and vulnerability context. Local distribution is unsupported until versioned heat/drought surfaces replace the shared seed.',
    'wildfire:GM0755':
      'A source inside TOP10NL mixed forest and BU07550009 does not control the shared neighbourhood allocation: Venhorst can rank first 3.409 kilometres away while the source neighbourhood ranks second. Direct-fire distribution is unsupported until source/perimeter, eligible cover, fuel, event-valid weather, access, extinguishing water and suppression govern allocation.',
    'coastal-flood:GM0377':
      'Bloemendaal has real defence-dependent coastal exposure, but the generic coast-distance screen selects no Rijnland defence section or failure, surge, connected dune/polder footprint, probability, arrival or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected versioned LIWO/Rijnland scenario is intersected with full-resolution geometry.',
    'pluvial-flood:GM0377':
      'Bloemendaal documents distinct water-nuisance locations and steep dune-to-polder terrain, but the shared neighbourhood seed samples no municipal stress-test cell, AHN flow path, surface cover, sewer, receiving-water or drainage state. Local distribution is unsupported until a versioned depth-duration footprint is intersected.',
    'heatwave:GM0377':
      'Bloemendaal heat rankings reuse the same neighbourhood seed as coastal, pluvial and wildfire maps rather than shade, surface temperature, building, resident/visitor or dune/forest evidence. Local heat/drought distribution is unsupported until hazard-specific versioned surfaces replace the common ranking.',
    'wildfire:GM0377':
      'The canonical event is a remote-smoke exercise and does not represent Bloemendaal’s defining dune/forest fire and visitor-access pathway; the shared seed can place the 1,699-hectare dune/beach neighbourhood last. Local flame and smoke distribution is unsupported until a separately named source/perimeter, eligible combustible-area geometry, event-valid weather, access and suppression inputs are supplied.',
    'severe-storm:GM1681':
      'Borger-Odoorn spans the Hondsrug, Hunzedal and peat areas, but the shared neighbourhood seed samples no event-valid gust, tree/building, overhead-line, road or exposed-object evidence. Local storm ranking is unsupported until hazard-specific weather and asset layers replace the common order.',
    'pluvial-flood:GM1681':
      'Borger-Odoorn has distinct high-ground runoff, Hunze/Veenkoloniën water, peat, groundwater, sewer, pump and retention mechanisms, while the shared neighbourhood seed samples none of them. Local pluvial distribution is unsupported until a versioned stress-test or hydraulic footprint with explicit NoData semantics is intersected.',
    'heatwave:GM1681':
      'Borger-Odoorn heat/drought ranking reuses the same neighbourhood seed as storm, water, winter, cyber and fire rather than surface temperature, shade, peat/groundwater, building, age or vulnerability evidence. Local distribution is unsupported until hazard-specific versioned layers replace it.',
    'winter-storm:GM1681':
      'Borger-Odoorn winter ranking reuses a shared geographic seed and samples no event-valid snow/ice, N34/access, bus, ambulance, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1681':
      'Borger-Odoorn cyber ranking reuses a geographic seed without a declared target, affected organization, system boundary or authorized dependency topology. Local distribution is unsupported until an explicit exercise target and system model are supplied.',
    'wildfire:GM1681':
      'A source inside Exloo Buitengebied does not control the shared neighbourhood allocation: its containing area can rank eleventh behind areas five to twelve kilometres away. Direct-fire distribution is unsupported until source/perimeter, Hondsrug fuels, wind, access, extinguishing water and suppression govern allocation.',
    'river-flood:GM0147':
      'Borne is outside a defensible direct Rhine/Meuse/IJssel footprint for this generic preset, so its false persistent major-river amplitude is suppressed. Local brook, groundwater, pluvial, sewer and indirect IJssel transport/supply pathways remain unresolved, not safe; they require a named connected ROR/LIWO or water-manager scenario.',
    'pluvial-flood:GM0147':
      'Borne documents Wensink-Zuid rain nuisance, a north-flowing gravity sewer, storage, clean-water conveyance and retention interventions, but the shared neighbourhood seed samples no terrain, catchment, inlet, pipe, buffer, outlet or receiving-water state. Local distribution is unsupported until a versioned municipal/Twente stress-test footprint is intersected without converting NoData to zero.',
    'heatwave:GM0147':
      'Borne heat ranking reuses the same neighbourhood order as unrelated water hazards rather than a versioned surface-temperature, shade, building or vulnerability layer. Local distribution is unsupported until hazard-specific evidence replaces the common seed.',
    'wildfire:GM0147':
      'A source inside TOP10NL broadleaf forest and BU01470009 Verspreide huizen Borne-West does not control the shared neighbourhood allocation: the source area can rank eleventh. Direct-fire distribution is unsupported until source/perimeter, eligible fuel, wind, access, scarce firewater and suppression inputs govern allocation.',
    'coastal-flood:GM0654':
      'Borsele has real Westerschelde and defence-dependent coastal risk, but the generic coast-distance screen selects no Scheldestromen reach or state, surge event, probability, connected footprint, depth, arrival, recession or dewatering condition. The retained amplitude is diagnostic only and local impact remains Unknown until an authority-reviewed versioned LIWO/Zeeland event is intersected; a future strengthening programme is not a current breach.',
    'river-flood:GM0654':
      'Borsele has no evidenced direct Rhine/Meuse/IJssel pathway for this generic preset, so its false persistent major-river amplitude is suppressed. Westerschelde coastal and regional polder-water mechanisms remain separately unresolved, not safe; they require a named hydraulically connected scenario.',
    'pluvial-flood:GM0654':
      'Borsele documents distinct village, Sloe industrial-area, polder, sewer and low-point mechanisms, but the shared neighbourhood seed samples no terrain, drainage, receiving-water, pump or control state. Local distribution is unsupported until a versioned municipal or Scheldestromen depth-duration footprint is intersected.',
    'heatwave:GM0654':
      'Borsele heat/drought ranking reuses the same neighbourhood seed as flood and fire rather than Sloe hard-surface, shade, building, population, crop, groundwater or salinisation evidence. Local distribution is unsupported until hazard-specific versioned layers replace the common ranking.',
    'cyberattack:GM0654':
      'The generic cyber exercise represents municipal service disruption only and must not be read as failure of KCB Borssele reactor/vital control, a Sloe industrial release or a radiological source term. No declared target, authorized control-system dependency, release, dose or protective-action decision is modeled; local distribution and those incident pathways remain unsupported.',
    'wildfire:GM0654':
      'Borsele wildfire ranking reuses the common neighbourhood seed without an explicit source/perimeter, eligible vegetation or crop cover, wind, access, firewater or suppression state. Local flame/smoke distribution is unsupported until a separately named incident or authority-reviewed exercise is supplied.',
    'severe-storm:GM0757':
      'Boxtel storm rankings reuse a shared neighbourhood seed rather than event-valid gust, tree/building, overhead-line, A2/rail or exposed-object evidence. Local distribution is unsupported until a versioned wind field and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0757':
      'Boxtel has distinct low-terrain, Essche Stroom/Kleine Aa, storage, sewer and drainage constraints around Boxtel Noordwest, but the shared neighbourhood seed samples no terrain, catchment, barrier, inlet, pipe, storage, pump or receiving-water state. Local distribution is unsupported until a versioned municipal or De Dommel depth-duration footprint is intersected with explicit NoData semantics.',
    'river-flood:GM0757':
      'Boxtel has a real but conditional Maas–Dommel–Essche Stroom backwater pathway that can affect low areas and the A2, but the generic centre-distance screen selects no Maas boundary condition, connected footprint, defence or control state, depth, arrival, duration or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an authority-reviewed versioned hydraulic scenario is intersected.',
    'heatwave:GM0757':
      'Boxtel heat and drought rankings reuse the same neighbourhood order as unrelated water and storm hazards rather than surface temperature, shade, paving, building, groundwater, age or vulnerability evidence. Local distribution is unsupported until hazard-specific versioned surfaces replace the shared seed.',
    'winter-storm:GM0757':
      'Boxtel winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, A2/rail exposure, bridge or underpass condition, overhead-line state, ambulance access or clearance evidence. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0757':
      'Boxtel cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary or authorized Enexis, Brabant Water, telecom, municipal or response dependency topology. Local distribution is unsupported until an explicit exercise target and reviewed system model are supplied.',
    'wildfire:GM0757':
      'A synthetic source beside Kampina does not control Boxtel fire allocation: the nearest source area can rank third behind more distant neighbourhoods. Direct-fire distribution is unsupported until source/perimeter, eligible Kampina forest and heath, fuel/moisture, event-valid weather, access, extinguishing water and suppression inputs govern allocation.',
    'pluvial-flood:GM1876':
      'Bronckhorst has published WRIJ T100/T1000 depth, duration and road-passability layers, but the shared neighbourhood seed samples no selected raster cell, terrain, catchment, sewer, receiving-water or control state. Local distribution is unsupported until a versioned WRIJ scenario is intersected with native resolution, units, licence and explicit NoData semantics.',
    'river-flood:GM1876':
      'Bronckhorst has a documented dijkring-50 Hackfort breach scenario with a bounded footprint, 0.5–1 metre depth, pre-impact evacuation and long duration, but the generic centre-distance screen selects no breach, defence state, connected footprint, probability, arrival or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected versioned LIWO/VNOG scenario is intersected.',
    'heatwave:GM1876':
      'Bronckhorst heat and drought rankings reuse the same neighbourhood order as water and fire hazards rather than surface temperature, shade, building, vegetation, soil, groundwater, age or vulnerability evidence. Local distribution is unsupported until hazard-specific versioned surfaces replace the shared seed.',
    'wildfire:GM1876':
      'The canonical event is a remote-smoke exercise and does not represent Bronckhorst’s documented nature-fire pathway; a source/eligibility check can rank Hummelo first while the combustible Wildenborch countryside ranks around fortieth. Local flame and smoke distribution is unsupported until source/perimeter, eligible forest/heath, fuel/moisture, event-valid weather, access, extinguishing water and suppression inputs govern allocation.',
    'river-flood:GM0758':
      'Breda is outside a defensible direct Rhine/Meuse/IJssel footprint for this generic preset, so its false persistent named-major-river amplitude is suppressed. Bovenmark, Aa of Weerijs, Mark-Dintel, regional-defence, pluvial, sewer and indirectly blocked drainage pathways remain unresolved, not safe; they require a named connected hydraulic scenario.',
    'pluvial-flood:GM0758':
      'Breda publishes separate water-depth and road-passability surfaces, while the shared neighbourhood seed samples no selected event, terrain, catchment, sewer, storage, receiving-water or control evidence. Local distribution is unsupported until a pinned, licence-cleared municipal or Brabantse Delta depth-duration footprint is intersected with explicit NoData semantics.',
    'heatwave:GM0758':
      'Breda publishes a distinct PET heat surface, but the current heat ranking reuses the same neighbourhood order as river and pluvial flooding rather than the versioned temperature, shade, building or vulnerability evidence. Local heat distribution is unsupported until hazard-specific licensed evidence replaces the common seed.',
    'wildfire:GM0758':
      'A source inside Mastbos does not control Breda fire allocation: its source neighbourhood can rank forty-eighth of fifty-six while Sportpark ranks first. Direct-fire distribution is unsupported until source/perimeter, eligible Mastbos/Liesbos/Ulvenhout forest, fuel/moisture, event-valid weather, access, extinguishing water and suppression inputs govern allocation.',
    'severe-storm:GM0213':
      'Brummen storm rankings reuse a shared neighbourhood seed rather than event-valid gust, tree/building, overhead-line, IJssel crossing, road/rail or exposed-object evidence. Local distribution is unsupported until a versioned wind field and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0213':
      'Brummen and Eerbeek have distinct fast cloudburst, sewer surcharge, saturated Veluwe-flank groundwater and extraction-regime mechanisms, but the shared seed and short recovery curve sample no antecedent groundwater, terrain, catchment, infiltration, pipe, receiving-water or control state. Local distribution and timing remain unsupported until a versioned municipal/water-board event and quality-qualified BRO series are selected.',
    'river-flood:GM0213':
      'Brummen has a real IJssel/Cortenoever pathway with relocated defences, protected and unprotected areas and a historic forecast-relative 72/48/24-hour workflow, but the generic centre-distance screen selects no defence state, connected footprint, Zutphen-Noord level, depth, arrival or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected versioned hydraulic event and current validated response plan are supplied.',
    'coastal-flood:GM0213':
      'Brummen has no direct sea-inundation footprint in this exercise; its inland wind distribution reuses a shared neighbourhood seed without event-valid wind or exposed-object evidence. Local distribution is unsupported, and zero direct coastal water must not be interpreted as zero indirect or inland-weather risk.',
    'heatwave:GM0213':
      'Brummen heat and drought rankings reuse the same neighbourhood order as water, storm and fire hazards rather than surface temperature, shade, building, vegetation, groundwater, age or vulnerability evidence. Local distribution is unsupported until hazard-specific versioned surfaces replace the shared seed.',
    'winter-storm:GM0213':
      'Brummen winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, IJssel crossing, N-road/rail, ferry, overhead-line, ambulance access or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0213':
      'Brummen cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary or authorized utility, municipal, telecom, facility or response dependency topology. Local distribution is unsupported until an explicit exercise target and reviewed system model are supplied.',
    'earthquake:GM0213':
      'The remote Groningen earthquake exercise has no selected event, Brummen ground-motion surface, local soil/site response or service-asset fragility; VNOG does not develop this crisis type for expected local damage. Any retained low-amplitude sensitivity is unsupported and must not be read as observed damage, probability or an operator impact forecast.',
    'wildfire:GM0213':
      'The canonical event is a remote-smoke exercise and a source inside Coldenhove does not control local fire allocation: Coldenhove can rank twenty-eighth of thirty-nine behind areas more than ten kilometres away. Local flame and smoke distribution is unsupported until source/perimeter, eligible forest/heath, fuel/moisture, event-valid weather, access, extinguishing water and suppression inputs govern allocation.',
    'river-flood:GM0899':
      'Brunssum has no selected direct Rhine/Meuse/IJssel pathway for this generic preset, so the false sustained named-major-river amplitude is suppressed. Roode Beek, regional tributary, hill-runoff, cross-border and drainage pathways remain unresolved, not safe; they require a named Waterschap Limburg or LIWO hydraulic event with depth, arrival, duration and NoData semantics.',
    'pluvial-flood:GM0899':
      'Brunssum has distinct slope, flow-path, sewer, buffer and road-passability mechanisms in Parkstad and Waterschap Limburg scenario layers, but the shared neighbourhood seed samples none of them. Local distribution is unsupported until a versioned, licence-cleared pluvial footprint is intersected at native resolution without converting NoData to zero.',
    'heatwave:GM0899':
      'Brunssum heat and drought ranks reuse the same neighbourhood order as flood and fire rather than a versioned temperature, shade, paving, vegetation, building or vulnerability surface. Local distribution is unsupported until hazard-specific evidence replaces the shared seed.',
    'earthquake:GM0899':
      'The canonical Groningen earthquake exercise omits Brunssum’s distinct Zuid-Limburg seismic screening and former-coal-mining ground-movement pathways. Its retained remote sensitivity is unsupported locally and must not be read as observed shaking, future probability, mine-water movement or damage; a separately named expert-reviewed exercise is required.',
    'wildfire:GM0899':
      'The canonical event is a remote-smoke exercise and does not represent a Brunssummerheide ignition: the shared seed can rank Emma above the official combustible Brunssumer Heide/De Heide areas. Local flame and smoke distribution is unsupported until a separately named source/perimeter, eligible vegetation, event-valid weather, access and suppression assumptions are supplied.',
    'severe-storm:GM0313':
      'Bunschoten storm ranks reuse a shared neighbourhood seed rather than event-valid gust, Eemmeer setup, tree/building, overhead-line, defence, road or exposed-object evidence. Local distribution is unsupported until weather and asset-specific evidence replace the common order.',
    'pluvial-flood:GM0313':
      'Bunschoten has distinct low-polder, sewer, surface-water, pump, culvert and receiving-water mechanisms, but the shared neighbourhood seed samples none of them. Local distribution is unsupported until a versioned municipal or Vallei en Veluwe depth-duration footprint is selected with explicit NoData semantics.',
    'river-flood:GM0313':
      'Bunschoten is not supported as a direct Rhine/Meuse/IJssel exposure municipality by the audited regional profile, so the false sustained named-major-river amplitude is suppressed. Eem inflow, Eemmeer/Randmeren level, polder, defence and pump pathways remain unresolved, not safe; they require a selected connected hydraulic event.',
    'coastal-flood:GM0313':
      'Zero direct North Sea inundation in this preset says nothing about Bunschoten’s Eemmeer/Randmeren storm-setup, Eem inflow, defence, overtopping, polder or pumping pathways. Its local wind ranking is unsupported until a separately typed lake/defence event and event-valid wind are selected.',
    'heatwave:GM0313':
      'Bunschoten heat and drought ranks reuse the same neighbourhood order as flood, storm and fire rather than temperature, shade, paving, building, vegetation, resident/visitor or vulnerability evidence. Local distribution is unsupported until hazard-specific versioned surfaces replace the shared seed.',
    'winter-storm:GM0313':
      'Bunschoten winter ranks reuse the same seed as unrelated hazards and sample no event-valid snow/ice, N-road, ferry, bus, bridge, defence, power-line, treatment or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0313':
      'Bunschoten cyber ranks reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized utility/municipal/response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0313':
      'The remote Groningen earthquake exercise has no selected event, Bunschoten ground-motion surface, local soil/site response, exposed building set or service-asset fragility. Any retained low sensitivity is unsupported and must not be read as observation, probability or a damage forecast.',
    'wildfire:GM0313':
      'The canonical event is a remote-smoke exercise with no Bunschoten source, perimeter, eligible fuel, weather, access, extinguishing-water or suppression state. Local flame and smoke distribution is unsupported until a separately named source-aware exercise is supplied.',
    'severe-storm:GM0502':
      'Capelle aan den IJssel storm rankings reuse a shared neighbourhood seed rather than event-valid gust, tree/building, high-rise, overhead asset, Hollandsche IJssel, bridge or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0502':
      'Capelle’s public climate atlas exposes distinct affected-building, road-passability, flow-path and maximum-depth layers, including 3,063 affected-building polygons and 298 source-classified impassable road segments in the current query. The shared neighbourhood seed samples none of those surfaces or their scenario metadata. Local distribution is unsupported until the publisher confirms licence, event, units, edition, resolution and NoData semantics for a pinned footprint.',
    'river-flood:GM0502':
      'Capelle has genuine Hollandsche IJssel flood pathways, but the generic centre-distance screen selects no Hollandsche IJsselkering state, defence or breach segment, water level or probability, connected footprint, arrival, duration or dewatering curve. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected, versioned LIWO/HHSK/Rijkswaterstaat event is intersected.',
    'coastal-flood:GM0502':
      'Capelle’s barrier- and defence-dependent delta flood risk is not a direct generic coast-distance event. The preset selects no Hollandsche IJsselkering state, defence or breach, connected footprint, water level, arrival or dewatering curve; its retained water and shared neighbourhood order are diagnostic only until a versioned expert-selected hydraulic event is intersected.',
    'heatwave:GM0502':
      'Capelle’s public climate atlas contains heat and vulnerable-object layers, while the generic heat/drought ranking reuses the same neighbourhood order as pluvial, coastal and wildfire exercises. Local distribution is unsupported until a versioned surface-temperature or heat-stress surface and explicit vulnerability semantics replace the shared seed.',
    'winter-storm:GM0502':
      'Capelle winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, Algerabrug, A20/N210, metro, rail, underpass, ambulance-access or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0502':
      'Capelle cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Stedin, Evides, HHSK, telecom, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0502':
      'The remote Groningen-centred earthquake exercise has no selected event, Capelle ground-motion surface, local soft-soil/site response, exposed-building set or service-asset fragility. Its retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0502':
      'The canonical event is a remote-smoke exercise and does not represent a local Capelle incident, perimeter, eligible fuel, wind, access or suppression state; its neighbourhood ranking reuses the same seed as unrelated hazards. Local flame and smoke distribution is unsupported until a separately named source-aware exercise is supplied.',
    'severe-storm:GM0383':
      'Castricum storm rankings reuse a shared neighbourhood seed rather than event-valid gust, dune/coastal, tree/building, overhead-line, ferry, rail, beach-access or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0383':
      'Castricum has distinct east/northeast polder, surface-water pumping, built-up paving/sewer, groundwater and De Zanderij retention mechanisms, but the shared neighbourhood seed samples no catchment, terrain, sewer, receiving-water or control state. Local distribution is unsupported until a versioned HHNK or municipal depth-duration footprint is selected with explicit units and NoData semantics.',
    'river-flood:GM0383':
      'Zero direct Rhine/Meuse/IJssel water in this scoped preset does not resolve Castricum’s separate polder, regional-water, groundwater, pluvial, IJsselmeer/Markermeer or coastal pathways. Local distribution is unsupported until a separately typed, connected water-manager scenario is selected; zero is not an all-clear.',
    'coastal-flood:GM0383':
      'Castricum has a managed dune defence and real coastal exposure, but the generic coast-distance screen selects no North Sea boundary condition, defence section or state, breach/overtopping mechanism, connected footprint, depth units, arrival, duration or recession. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected versioned LIWO/HHNK event is intersected.',
    'heatwave:GM0383':
      'Castricum heat/drought rankings reuse the same neighbourhood order as storm, flood, cyber and fire rather than surface temperature, shade, paving, vegetation, dune groundwater, resident/visitor or vulnerability evidence. Local distribution is unsupported until hazard-specific versioned surfaces replace the shared seed.',
    'winter-storm:GM0383':
      'Castricum winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, A9/N-roads, rail, bridge, ferry, coastal access, ambulance route or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0383':
      'Castricum cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized PWN, Liander, Stedin, telecom, municipal, ferry or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0383':
      'The remote Groningen-centred earthquake exercise has no selected event, Castricum ground-motion surface, dune/polder soil response, exposed-building set or service-asset fragility. Its retained low sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0383':
      'A focused source at Duingebied can rank eleventh behind Limmen Oost 5.218 kilometres away because the shared allocation samples no source containment, eligible dune vegetation, fuel/moisture, wind, paths, access, firefighting water or suppression. Local direct-fire distribution is unsupported until a named source/perimeter-aware exercise governs eligible land cover.',
    'severe-storm:GM0214':
      'Buren storm rankings reuse a shared neighbourhood seed rather than event-valid gust, tree/building, overhead-line, dispersed-core, road or exposed-object evidence. Local distribution is unsupported until a versioned wind field and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0214':
      'Buren publishes a distinct 2021 integrated sewer/surface model for T10, T100 and T1000 design storms; its T100 result includes 126 measured-floor ingress buildings, 384 possible-water buildings with unmeasured floors and 14,230 buildings with unmeasured floors. The current shared neighbourhood seed samples none of those classes, terrain, sewer, receiving-water or control states. Local distribution is unsupported until a licence-cleared, versioned event footprint is intersected with gray/white and NoData classes kept Unknown.',
    'river-flood:GM0214':
      'Buren has genuine river-flood and seepage pathways, but the generic centre-distance screen selects no connected defence or breach, water level, depth footprint, arrival, duration or recession and holds a precise municipality-wide value through T+72. The retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected, versioned LIWO or Waterschap Rivierenland event is intersected.',
    'coastal-flood:GM0214':
      'Buren has no selected direct North Sea inundation event in this preset; the retained inland wind distribution reuses a shared neighbourhood seed without event-valid wind or exposed-object evidence. Zero direct coastal water is not an all-clear for river, seepage, regional-water, pluvial or indirect service pathways.',
    'heatwave:GM0214':
      'Buren’s local heat plan identifies Maurik, Lienden, Buren, Zoelmond, Beusichem and Eck en Wiel as built-up attention areas, while the generic heat/drought ranking reuses the same neighbourhood order as river and pluvial flooding. Local distribution is unsupported until versioned apparent-temperature, cool-place, shade, building and vulnerability evidence replaces the shared seed.',
    'winter-storm:GM0214':
      'Buren winter rankings reuse the same geographic seed as unrelated hazards and sample no event-valid snow/ice, dispersed-road, bridge, ferry, bus, overhead-line, ambulance-access or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0214':
      'Buren cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized utility, municipal, telecom or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0214':
      'The remote Groningen-centred earthquake exercise has no selected event, Buren ground-motion surface, local soil/site response, exposed-building set or service-asset fragility. Its retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0214':
      'A focused source inside official TOP10NL deciduous forest and BU02140206 can rank twelfth because the shared allocation does not follow source containment, eligible vegetation, fuel/moisture, wind, access, extinguishing water or suppression. Local direct-fire distribution is unsupported until a source/perimeter-aware exercise governs eligible land cover.',
    'severe-storm:GM1706':
      'Cranendonck storm rankings reuse a shared neighbourhood seed rather than event-valid KNMI gust/rain, tree, building, A2, rail, local-road or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM1706':
      'Cranendonck’s dated climate maps distinguish extreme-rain problems in Budel and Maarheeze, Grootschoterweg access and Buulder Aa, Strijper Aa and Sterkselsche Aa overflow, but the shared neighbourhood seed samples no terrain, catchment, sewer, receiving-water or control state. Local distribution is unsupported until a versioned licensed municipal or De Dommel footprint is intersected with explicit NoData semantics.',
    'river-flood:GM1706':
      'The adopted Brabant-Zuidoost risk profile places Cranendonck outside direct sea and large-river influence, so the false Rhine/Meuse/IJssel proximity amplitude is suppressed. Buulder Aa, Strijper Aa, Sterkselsche Aa, Belgian-fed brook, groundwater, pluvial, drainage, access and indirect supply pathways remain unresolved, not safe; a named connected LIWO, De Dommel or authorized hydraulic event is required.',
    'coastal-flood:GM1706':
      'Cranendonck has no selected direct North Sea inundation event in this preset; its retained remote wind tail reuses a shared neighbourhood seed without event-valid wind or exposed-object evidence. Zero direct coastal water is not an all-clear for brook, groundwater, pluvial, drainage or indirect national-service pathways.',
    'heatwave:GM1706':
      'Cranendonck’s dated climate vision distinguishes heat in cores and industrial areas, sandy-soil/ecological drought and older-resident vulnerability, while the current heat/drought ranking repeats the river and pluvial order. Local distribution is unsupported until versioned apparent-temperature, shade, land-cover, groundwater and vulnerability evidence replaces the common seed.',
    'winter-storm:GM1706':
      'Cranendonck winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, A2, rail, local-road, cross-border, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1706':
      'Cranendonck cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Brabant Water, Ziggo, municipal, RWZI, transport or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1706':
      'The remote Groningen-centred earthquake exercise has no selected event, Cranendonck ground-motion surface, local soil/site response, exposed-building set or service-asset fragility. Its retained low sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM1706':
      'A focused source inside official forest in Verspreide huizen in het Oosten can rank nineteenth behind Budel because the shared allocation samples no source containment, eligible vegetation, fuel/moisture, wind, access, extinguishing water or suppression. Local direct-fire distribution is unsupported until a named source/perimeter-aware exercise governs eligible land cover.',
    'severe-storm:GM0216':
      'Culemborg storm rankings reuse a shared neighbourhood seed rather than event-valid KNMI gust/rain, tree, building, dike, A2/N-road, rail, ferry or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0216':
      'Culemborg’s adopted 2024 programme identifies P1 pluvial locations in Voorkoop, Componistenbuurt, Binnenstad and Pavijen, but the common seed places Binnenstad last and Pavijen second-last. The public 90 mm/hour tiles lack raw values, source resolution, licence, scenario edition and cadence, so local distribution remains unsupported until a versioned licensed footprint with units and NoData is supplied.',
    'river-flood:GM0216':
      'Culemborg has genuine Lek, seepage, primary-defence and outer-dike flood pathways, but the generic centre-distance screen selects no water level, defence segment/state, breach or overflow, probability, connected footprint, arrival, duration or dewatering curve. The retained amplitude is a non-operational diagnostic only and local impact remains Unknown until an expert-selected versioned LIWO or Waterschap Rivierenland event is intersected.',
    'coastal-flood:GM0216':
      'Culemborg has no selected direct North Sea inundation mechanism in this preset; zero direct coastal water accompanies a remote wind/system exercise whose neighbourhood order has no event-valid wind or exposed-object evidence. This scoped zero is not an all-clear for Lek, seepage, pluvial, defence or indirect national-service pathways.',
    'heatwave:GM0216':
      'Culemborg’s adopted programme identifies Markt, Varkensmarkt and other Binnenstad locations plus Winkelcentrum Parijsch as P1 heat areas, while the common heat seed ranks Binnenstad last and Parijsch low. Local distribution is unsupported until a versioned heat-risk surface, time-of-day, shade, building and vulnerability evidence replace the shared order.',
    'winter-storm:GM0216':
      'Culemborg winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, A2, N320, N833, rail, bridge, water-level-sensitive ferry, ambulance-access or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0216':
      'Culemborg cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, telecom, water-board, municipal, ferry, rail or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0216':
      'The remote Groningen-centred earthquake exercise has no selected event, Culemborg ground-motion surface, local soil/site response, exposed-building set or service-asset fragility. Its retained low sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0216':
      'The canonical wildfire is a remote smoke/drought exercise with zero local flame and no selected Culemborg ignition, perimeter, eligible vegetation, vulnerable object, wind, access, extinguishing water or suppression state. Local distribution is unsupported until a separately named source-aware exercise is supplied.',
    'severe-storm:GM0148':
      'Dalfsen storm rankings reuse a shared neighbourhood seed rather than event-valid KNMI gust/rain, tree, building, overhead-line, Vecht bridge, rural-road or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0148':
      'Dalfsen’s pluvial ranking samples no AHN terrain, sewer/catchment, Vecht or regional-water level, pump/weir, receiving-water or control state and exactly repeats unrelated hazards. Local distribution is unsupported until a versioned WDODelta or municipal depth-duration footprint is intersected with explicit units and NoData semantics.',
    'river-flood:GM0148':
      'Dalfsen has genuine Vecht, western IJssel/backwater, outside-dike and defence-dependent flood pathways, but the generic centre-distance screen selects none of their boundary conditions, defence/breach/overtopping states, connected footprints, terrain, arrival, duration or recession. The retained amplitude is a non-operational diagnostic only and local impact remains Unknown until an expert-selected versioned LIWO/WDODelta event is intersected.',
    'coastal-flood:GM0148':
      'Dalfsen has no selected direct North Sea inundation mechanism in this preset; zero direct coastal water accompanies a remote wind exercise whose neighbourhood order has no event-valid wind or exposed-object evidence. This scoped zero is not an all-clear for Vecht, IJssel/backwater, regional-water, pluvial, drainage or indirect national-service pathways.',
    'heatwave:GM0148':
      'Dalfsen heat/drought rankings reuse the same neighbourhood order as water, winter and cyber rather than apparent temperature, shade, building, woodland, groundwater, older-resident or other vulnerability evidence. Local distribution is unsupported until hazard-specific versioned surfaces and population context replace the shared seed.',
    'winter-storm:GM0148':
      'Dalfsen winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, Vecht bridge, N-road, rural-road, rail, bus, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0148':
      'Dalfsen cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Vitens, Ziggo, water-board, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0148':
      'The remote Groningen-centred earthquake exercise has no selected event, Dalfsen ground-motion surface, local soil/site response, exposed-building set or service-asset fragility. Its retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0148':
      'A focused source inside Verspreide huizen Hessum-Rechteren can rank its containing neighbourhood thirty-second of thirty-six behind Gernermarke-Oosterdalfsen because the shared allocation samples no source containment, forest/heath eligibility, fuel/moisture, wind, access, extinguishing water or suppression. Local direct-fire distribution is unsupported until a named source/perimeter-aware exercise governs eligible land cover.',
    'severe-storm:GM0310':
      'De Bilt storm rankings reuse a shared neighbourhood seed rather than event-valid KNMI gust/rain, tree, building, rail, A27/A28/N-road or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0310':
      'Province Utrecht and municipal evidence distinguish Maartensdijk, De Bilt, Westbroek and waterboard-specific rain/drainage conditions, but the shared neighbourhood seed samples no native rainfall-depth cell, terrain, sewer, receiving-water or control state. Local distribution is unsupported until a versioned HDSR/AGV/municipal footprint with units and NoData masks is intersected.',
    'river-flood:GM0310':
      'De Bilt’s generic Rhine/Meuse/IJssel proximity screen selects no Lek or regional-water event, water level, defence/breach/overflow state, connected footprint, depth unit, arrival, duration or recession. The retained amplitude is a non-operational diagnostic only and local impact remains Unknown until an expert-selected versioned WMCN/HDSR/AGV event is intersected.',
    'coastal-flood:GM0310':
      'De Bilt has no selected direct North Sea inundation mechanism in this preset; zero direct coastal water accompanies a remote wind/system exercise whose neighbourhood order has no event-valid wind or exposed-object evidence. This scoped zero is not an all-clear for Lek, regional-water, groundwater, pluvial, sewer or indirect service pathways.',
    'heatwave:GM0310':
      'Province Utrecht diagnostics distinguish urban heat in De Bilt and Maartensdijk from wooded, shaded and lowland areas, while the current heat/drought ranking repeats unrelated flood and fire orders. Local distribution is unsupported until versioned apparent-temperature, warm-night, drought, shade, building and vulnerability surfaces replace the shared seed.',
    'winter-storm:GM0310':
      'De Bilt winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, A27/A28/N-road, rail, bridge/underpass, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0310':
      'De Bilt cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Stedin, Vitens, water-board, telecom, USPB, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0310':
      'The remote Groningen-centred earthquake exercise has no selected KNMI event, De Bilt ground-motion surface, local soil/site response, exposed-building set or service-asset fragility. Its retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0310':
      'A focused source inside Ridderoordsche Bossen and BU03100603 can rank its containing neighbourhood fourteenth because the shared allocation samples no source containment, eligible Heuvelrug forest/heath, fuel/moisture, event-valid wind, access, care-location evacuation, extinguishing water or suppression. Local direct-fire distribution is unsupported until a named source/perimeter-aware exercise governs eligible land cover.',
    'severe-storm:GM1891':
      'Dantumadiel storm rankings reuse a shared neighbourhood seed rather than event-valid KNMI gust/rain, tree/building, rural road, rail, overhead-line, water-control or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM1891':
      'Dantumadiel has distinct prolonged-rain, polder, boezem, village-drainage and rural pressure-sewer/pump pathways, but the shared neighbourhood seed samples no source raster, catchment, terrain, sewer, receiving-water or control state. Local distribution is unsupported until a versioned Wetterskip/municipal footprint with units and NoData is selected.',
    'river-flood:GM1891':
      'The named river preset covers Rhine, Meuse and IJssel and its scoped zero for Dantumadiel says nothing about sea/IJsselmeer, boezem, polder, prolonged-rain, pressure-sewer or groundwater pathways. Those mechanisms remain Unknown until separately typed, connected Wetterskip/LIWO events are selected; zero is not an all-clear.',
    'coastal-flood:GM1891':
      'Dantumadiel has real defence- and water-system-dependent Frisian exposure, but the coast-distance screen selects no sea/IJsselmeer level, mainland dike segment/state, breach/overflow, boezem/polder pathway, connected footprint, arrival, duration, recession or dewatering curve. The retained amplitude is a non-operational diagnostic only and local impact remains Unknown until an expert-selected versioned Wetterskip/LIWO event is intersected.',
    'heatwave:GM1891':
      'Dantumadiel heat/drought rankings reuse the same neighbourhood order as flood and remote smoke rather than apparent temperature, shade, paving, peat, salinization, groundwater, building or vulnerability evidence. Local distribution is unsupported until hazard-specific versioned surfaces replace the common seed.',
    'winter-storm:GM1891':
      'Dantumadiel winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, N-road, rural-road, culvert, De Westereen/Feanwâlden rail, bus, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1891':
      'Dantumadiel cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Stedin, Vitens, Wetterskip, telecom, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1891':
      'The Groningen-centred earthquake exercise selects no reproducible KNMI event ID, magnitude or depth and has no Dantumadiel ground-motion/site-response field, exposed-building set or service-asset fragility. Its material retained sensitivity is unsupported; the observed FDSN origin catalogue is context and does not turn this synthetic attenuation into observed shaking, probability or a damage forecast.',
    'wildfire:GM1891':
      'The canonical wildfire is a remote smoke/drought exercise with zero local flame and no selected Dantumadiel ignition, perimeter, eligible vegetation/peat, event-valid wind, access, extinguishing water or suppression state. Omission from a planning risk profile is not proof of safety; local distribution remains unsupported until a separately named source-aware exercise is supplied.',
    'severe-storm:GM0109':
      'Coevorden storm rankings reuse a shared neighbourhood seed rather than event-valid KNMI gust/rain, tree/building, industrial, cross-border, rail, N-road, overhead-line or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0109':
      'Coevorden has distinct sewer-overload, low-road, brook, canal, regional-water and three-waterboard pathways, but the shared neighbourhood seed samples no source rainfall/depth cell, terrain, catchment, sewer, receiving-water or control state. Local distribution is unsupported until a versioned municipal/water-board footprint with units and NoData is selected.',
    'river-flood:GM0109':
      'The named river preset covers Rhine, Meuse and IJssel and is numerically neutral for Coevorden. This scoped zero says nothing about local brooks/canals, Stadsgracht, regional-water, drainage, sewer, N34 access or indirect supply effects; they remain Unknown until a separately typed, connected and versioned water-manager event is selected. Zero is not an all-clear.',
    'coastal-flood:GM0109':
      'Coevorden has no selected direct North Sea inundation mechanism in this preset; zero direct coastal water accompanies a remote wind/system exercise whose neighbourhood order has no event-valid wind or exposed-object evidence. This scoped zero is not an all-clear for brooks, canals, regional water, pluvial drainage, N34 access or indirect service pathways.',
    'heatwave:GM0109':
      'Coevorden heat/drought rankings reuse the same neighbourhood order as water, winter and fire rather than apparent temperature, shade, paving, woodland, peat/groundwater, building, resident or vulnerability evidence. Local distribution is unsupported until hazard-specific versioned surfaces replace the common seed.',
    'winter-storm:GM0109':
      'Coevorden winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, N34/A37/N-road, German connection, rail/waterway terminal, bridge/culvert, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0109':
      'Coevorden cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Rendo, WMD, water-board, telecom, industrial, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0109':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Coevorden ground-motion/site-response field, exposed-building set or service-asset fragility and does not separately represent Drenthe induced-seismic context. Its retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0109':
      'A focused source inside official Boswachterij Gees/Hooge Loo forest and BU01093039 can rank its containing neighbourhood fortieth while Lootuinen nearly twelve kilometres away ranks first because the shared allocation ignores source containment. Local direct-fire distribution is unsupported until eligible vegetation, a named source/perimeter, fuel/moisture, event-valid wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM1940':
      'De Fryske Marren storm rankings reuse a shared 70-neighbourhood seed rather than event-valid KNMI gust/rain, tree/building, IJsselmeer/lake crossing, bridge/lock, A6/A7/N-road, overhead-line or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM1940':
      'De Fryske Marren has distinct Lemmer, Balk, Sloten, Terherne, boezem, polder, fragmented level-area, pump, sewer and receiving-water pathways, but the shared seed samples no rainfall/depth cell, terrain, catchment, control state or versioned NoData mask. Local distribution is unsupported until a selected municipal or Wetterskip Fryslân footprint with explicit units and scenario semantics is intersected.',
    'river-flood:GM1940':
      'The generic Rhine/Meuse/IJssel proximity screen selects no IJssel-IJsselmeer boundary condition, primary-defence state, boezem or polder pathway, connected footprint, depth unit, arrival, duration or recession for De Fryske Marren. The retained nonzero amplitude is a non-operational diagnostic only and local impact remains Unknown until an expert-selected, versioned WMCN/Wetterskip/LIWO event is intersected.',
    'coastal-flood:GM1940':
      'The selected direct North Sea water component is zero for De Fryske Marren, while a remote wind/system exercise still produces consequences without selecting an IJsselmeer wind-setup or level event, defence state, boezem/polder pathway, connected footprint or exposed object. This narrow zero is not an all-clear; local water impact remains Unknown until separately typed, authority-selected scenarios are supplied.',
    'heatwave:GM1940':
      'De Fryske Marren heat and drought rankings repeat unrelated flood, winter and cyber orders rather than apparent temperature, warm nights, shade, paving, peat, groundwater, crop/woodland condition, building or vulnerability evidence. Annual crop declarations and planning maps are context, not current condition; local distribution remains unsupported until versioned hazard-specific surfaces replace the shared seed.',
    'winter-storm:GM1940':
      'De Fryske Marren winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, A6/A7/N-road, bridge, lock, waterway, bus, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1940':
      'De Fryske Marren cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, Wetterskip, telecom, municipal, mobility, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1940':
      'The Groningen-centred earthquake exercise has no selected KNMI event, De Fryske Marren ground-motion/site-response field, exposed-building set or service-asset fragility. The observed FDSN origin catalogue is context only; retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM1940':
      'A controlled source in Oudemirdum can rank its containing neighbourhood fortieth of seventy despite the official Gaasterlan-Rysterbosk nature-fire context because the shared allocation samples no source containment, eligible woodland/fuel, moisture, event-valid wind, access, extinguishing water or suppression. Local direct-fire distribution is unsupported until a named source/perimeter-aware exercise governs eligible land cover.',
    'severe-storm:GM1690':
      'De Wolden storm rankings reuse a shared 40-neighbourhood seed rather than event-valid KNMI gust/rain, tree/building, rural-road, bridge/culvert, A28/N-road, overhead-line or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM1690':
      'De Wolden identifies distinct rain-water overload near Julianaweg De Wijk, west Zuidwolde, Koekange, Ruinen and Groene Hart/Oosterweg, yet the shared seed ranks De Wijk and Ruinen ninth and tenth and west-Zuidwolde fifteenth and sixteenth. Local distribution is unsupported until a versioned depth-duration surface, terrain, drainage and receiving-water state with explicit units and NoData replace the common order.',
    'river-flood:GM1690':
      'The generic Rhine/Meuse/IJssel proximity screen selects no connected Meppelerdiep, Reest or Wold Aa pathway, high-water boundary, defence/control state, footprint, depth unit, arrival, duration or recession for De Wolden. The retained nonzero amplitude is a non-operational diagnostic only; possible Meppel-area access and service effects and local brook/canal pathways remain Unknown until an expert-selected WMCN/WDODelta/LIWO event is intersected.',
    'coastal-flood:GM1690':
      'De Wolden has no selected direct North Sea inundation event; the remote coastal wind/system exercise reuses the same neighbourhood order without event-valid wind or exposed-object evidence. Any narrow direct-water zero is not an all-clear for Meppel-area high water, brooks, canals, pluvial drainage or indirect national-service pathways.',
    'heatwave:GM1690':
      'De Wolden planning evidence distinguishes location-specific heat, drought, brook/canal and rain-water patterns, while the current heat/drought order exactly repeats unrelated flood rankings. Local distribution is unsupported until versioned apparent-temperature, shade, land-cover, groundwater and vulnerability evidence replace the shared seed.',
    'winter-storm:GM1690':
      'De Wolden winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, A28/N-road, local-road, bridge/culvert, bus, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1690':
      'De Wolden cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Rendo, WMD, water-board, telecom, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1690':
      'The Groningen-centred earthquake exercise has no selected KNMI event, De Wolden ground-motion/site-response field, exposed-building set or service-asset fragility and does not resolve local induced-seismic context. The FDSN origin catalogue is context only; retained sensitivity is unsupported and is not observed shaking, probability or a damage forecast.',
    'wildfire:GM1690':
      'A controlled source inside official Boswachterij Ruinen and Verspreide huizen Echten ranks its containing neighbourhood third while Oosteinde-Buiten about 6.553 kilometres away ranks first because the shared allocator ignores source containment. Local direct-fire distribution is unsupported until eligible vegetation, a named source/perimeter, fuel/moisture, event-valid wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0736':
      'De Ronde Venen storm rankings reuse a shared 25-neighbourhood seed rather than event-valid KNMI gust/rain, tree/building, polder, bridge/culvert, A2/N-road, rail, overhead-line or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0736':
      'De Ronde Venen pluvial allocation ranks Vinkeveen Plassengebied twentieth despite an observed June 2026 event reported especially in Vinkeveen and samples no event rainfall, terrain, polder, sewer, pump, receiving-water or control state. That observation is evidence of a pathway, not a forecast; local distribution remains unsupported pending a versioned depth-duration footprint with units and NoData.',
    'river-flood:GM0736':
      'De Ronde Venen has defence-, Lek/Rijn-, polder- and boezem-dependent pathways, but the generic river screen selects no water level, dike segment/state, breach/overflow, probability, connected footprint, arrival, duration, recession or dewatering path. The retained amplitude is a non-operational diagnostic only and local impact remains Unknown until an AGV/WMCN-approved, versioned LIWO/LDO event is intersected.',
    'coastal-flood:GM0736':
      'The generic coast-distance field selects no relevant regional-water source, water level, defence state, breach/overflow, connected footprint, probability, arrival, duration, recession or dewatering path for De Ronde Venen. Its retained amplitude is a non-operational diagnostic, not current flooding or a T+72 forecast, pending an authority-selected AGV/LIWO event.',
    'heatwave:GM0736':
      'De Ronde Venen heat allocation ranks Mijdrecht Dorp last although Centrum Mijdrecht is an official heat priority, because it reuses the same order as flood and fire rather than apparent temperature, warm nights, shade, paving, building or vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the shared seed.',
    'winter-storm:GM0736':
      'De Ronde Venen winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, A2/N-road, local-road, bridge/culvert, Abcoude rail, bus, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0736':
      'De Ronde Venen cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Stedin, drinking-water, AGV, telecom, municipal, rail, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0736':
      'The Groningen-centred earthquake exercise has no selected KNMI event, De Ronde Venen ground-motion/site-response field, exposed-building set or service-asset fragility. Regional omission is not proof of zero hazard; the retained low sensitivity is unsupported and is not observed shaking, probability or a damage forecast.',
    'wildfire:GM0736':
      'A diagnostic source at Vinkeveen Plassengebied can leave its own neighbourhood twentieth because the shared allocator samples no source containment, eligible vegetation/fuel, moisture, event-valid wind, access, extinguishing water or suppression. Local direct-fire distribution is unsupported; a synthetic source is not an observed ignition or forecast.',
    'severe-storm:GM0503':
      'Delft storm rankings reuse a shared 91-neighbourhood seed rather than event-valid KNMI gust/rain, dense-building/tree, rail/tunnel, A13/N470, bridge, overhead-line or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0503':
      'Delft has official urban-rain depth, model-coverage, building-vulnerability and road-passability context plus distinct hard-surface, sewer, polder, boezem and Schie pathways, but the current shared seed samples none of it. Local distribution is unsupported until a versioned 100 mm/two-hour footprint, sewer-model coverage and Delfland catchment evidence with true units, uncertainty and NoData are intersected.',
    'river-flood:GM0503':
      'The named Rhine/Meuse/IJssel proximity field has no selected connected direct pathway for Delft and is therefore numerically neutral. This narrow zero says nothing about coastal, regional-boezem-dyke, polder, Schie, pluvial, drainage, access or indirect regional-service effects; they remain Unknown until separately typed, authority-selected Delfland/VRH/WMCN/LIWO events are supplied. Zero is not an all-clear.',
    'coastal-flood:GM0503':
      'Delft has real defence- and source-dependent coastal and regional-water exposure, but the coast-distance screen selects no boundary level, defence segment/state, breach/overtopping pathway, connected footprint, probability class, arrival, duration or recession. The retained amplitude is a non-operational diagnostic only and local impact remains Unknown pending a Delfland/VRH/WMCN-selected, versioned LIWO event.',
    'heatwave:GM0503':
      'Delft heat rankings reuse the same order as flood, winter and cyber rather than hard-surface temperature, shade, warm nights, building, resident or vulnerability evidence. Local distribution is unsupported until versioned apparent-temperature and exposure surfaces with time-of-day and NoData semantics replace the shared seed.',
    'winter-storm:GM0503':
      'Delft winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, rail tunnel, A13/N470, bridge, tram/bus, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0503':
      'Delft cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Stedin, Evides, Delfland, telecom, municipal, TU/research, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0503':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Delft ground-motion/site-response field, exposed-building set or service-asset fragility. Its retained low sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0503':
      'A controlled source in Abtswoude can rank its containing neighbourhood twenty-third of ninety-one despite direct flame and official Abtswoudse Bos interface context because the shared allocator ignores source containment. Local distribution is unsupported until eligible forest/fuel, a named source/perimeter, valid-time wind and moisture, rail/road access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0400':
      'Den Helder storm rankings reuse a shared 65-neighbourhood seed rather than event-valid KNMI wind, rain, trees, buildings, dunes, harbour, ferry, bridge, overhead-line or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0400':
      'Den Helder has distinct urban-rain, Koegraspolder, sewer, surface-water and pumping pathways, but the shared neighbourhood seed samples no event rainfall, depth surface, terrain, catchment, sewer or control state. Local distribution is unsupported until a versioned HHNK or municipal footprint with units, cell size and NoData is selected.',
    'river-flood:GM0400':
      'The named Rhine/Meuse/IJssel preset is numerically neutral for Den Helder. This scoped zero says nothing about North Sea, Wadden Sea, Marsdiep, polder, regional-water, salinity, pluvial, sewer, access or indirect service pathways; those remain Unknown until separately typed, connected authority-selected events are supplied. Zero is not an all-clear.',
    'coastal-flood:GM0400':
      'The coast-distance screen selects no North Sea or Wadden Sea water level, tide/surge, named HHNK defence segment/state, breach or overtopping, connected footprint, probability, arrival, duration, recession or dewatering path for Den Helder. Its retained amplitude is a non-operational diagnostic only and local impact remains Unknown until an HHNK/Rijkswaterstaat-approved, versioned event is selected.',
    'heatwave:GM0400':
      'Den Helder heat and drought rankings reuse the same neighbourhood order as flood and fire rather than apparent temperature, warm nights, shade, paving, dunes, salinity, groundwater, building, resident or vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the shared seed.',
    'winter-storm:GM0400':
      'Den Helder winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, N9/N99/N502, Kooybrug, ferry, rail, airport, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0400':
      'Den Helder cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, PWN, HHNK, telecom, port, naval, airport, ferry, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0400':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Den Helder ground-motion/site-response field, exposed-building set or service-asset fragility. A zero local origin-catalogue match is not zero hazard; the retained sensitivity is unsupported and is not observed shaking, probability or a damage forecast.',
    'wildfire:GM0400':
      'A controlled source in Donkere Duinen can leave its containing neighbourhood thirty-third of sixty-five because the shared allocator ignores source containment, eligible dune/forest fuel, moisture, event-valid wind, access, extinguishing water and suppression. Local flame, smoke and evacuation distribution is unsupported until a named source/perimeter-aware exercise governs eligible land cover.',
    'severe-storm:GM0762':
      'Deurne storm rankings reuse a shared 29-neighbourhood seed rather than event-valid gust, tree/building, overhead-line, A67/N-road, rail or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0762':
      'Deurne has distinct smaller-brook, extreme-rain, high-groundwater, sewer, pump and receiving-water pathways, but the shared seed samples none of the official 70 mm/two-hour, terrain, catchment or control evidence. Local distribution remains unsupported until a versioned Aa en Maas or municipal footprint is selected with units, resolution and NoData.',
    'river-flood:GM0762':
      'The Brabant-Zuidoost risk profile places Deurne outside direct sea and large-river influence, so its false Rhine/Meuse/IJssel proximity amplitude is suppressed. Aa, smaller-waterway, groundwater, drainage and indirect high-water pathways remain unresolved rather than safe and require a selected connected hydraulic event.',
    'coastal-flood:GM0762':
      'The selected direct North Sea water component is zero for inland Deurne. This narrow source result does not resolve wind, national supply, regional-water, groundwater, sewer or access effects and is not an all-clear; local distribution remains unsupported without event-valid weather and exposed-object evidence.',
    'heatwave:GM0762':
      'Deurne heat and drought rankings repeat the flood and fire order rather than apparent temperature, shade, buildings, peat, groundwater, crops, age or vulnerability. Local distribution is unsupported until hazard-specific versioned surfaces replace the common seed.',
    'winter-storm:GM0762':
      'Deurne winter rankings reuse a shared seed and sample no event-valid snow/ice, A67/N270/N279, rail, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0762':
      'Deurne cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Brabant Water, Aa en Maas, telecom, municipal or response topology. Local distribution is unsupported until a named exercise target and reviewed dependency model are supplied.',
    'earthquake:GM0762':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Deurne ground-motion/site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0762':
      'A controlled source inside mapped swampy deciduous forest in the Deurnsche Peel can leave its containing neighbourhood twenty-fifth of twenty-nine because the shared allocator ignores source containment. It also supplies no peat-smoulder persistence despite official months-long smoke evidence from 2020. Local flame, smoke and T+72 duration remain unsupported until a named perimeter, eligible fuel/peat, moisture, event-valid wind, access, extinguishing water and suppression state govern the exercise.',
    'severe-storm:GM0150':
      'Deventer storm rankings reuse a shared 69-neighbourhood seed rather than event-valid gust, tree/building, overhead-line, IJssel crossing, A1/N-road, rail or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0150':
      'Deventer and Overijssel publish distinct extreme-rain, depth and road-usability evidence, but the common seed samples no selected rainfall surface, terrain, sewer, catchment, barrier, pump or receiving-water state. Local distribution is unsupported until a versioned licensed footprint with true units, coverage and NoData is intersected.',
    'river-flood:GM0150':
      'Deventer has a genuine IJssel pathway and published 4.50, 6.10 and 6.30 m NAP access thresholds, but the centre-distance screen selects no gauge hydrograph, datum-aligned boundary, defence state, breach/overtopping, connected footprint, arrival, duration or recession. Its retained amplitude is diagnostic only and local impact remains Unknown until an expert-selected versioned hydraulic event is supplied.',
    'coastal-flood:GM0150':
      'Zero direct North Sea water in this inland preset says nothing about IJssel, regional-water, drainage, access or national-service effects. Its wind ranking reuses the common seed without event-valid weather or exposed-object evidence, so the local result is unsupported rather than an all-clear.',
    'heatwave:GM0150':
      'Deventer heat and drought rankings reuse the same order as flood, winter and cyber rather than apparent temperature, warm nights, shade, paving, buildings, vegetation, groundwater or vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the common seed.',
    'winter-storm:GM0150':
      'Deventer winter rankings sample no event-valid snow/ice, IJssel bridges or ferry, A1/N-road, rail, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0150':
      'Deventer cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Vitens, water-board, telecom, municipal, rail, hospital or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0150':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Deventer ground-motion/site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and is not observed shaking, probability or a damage forecast.',
    'wildfire:GM0150':
      'A controlled source in Buitengebied Lettele en Okkenbroek can leave its containing neighbourhood twenty-fifth of sixty-nine while Handelspark De Weteringen ranks first because the common allocator ignores source containment. Local flame and smoke remain unsupported until a named perimeter, eligible fuel, moisture, event-valid wind, access, extinguishing water and suppression state govern allocation.',
    'severe-storm:GM1980':
      'Dijk en Waard storm rankings reuse a shared 69-neighbourhood seed rather than event-valid gust, tree/building, overhead-line, polder, bridge, rail, N-road or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM1980':
      'Dijk en Waard has compartmentalized polder, Zandhorst-Huygendijk, Westertocht, sewer, pump and rain-water road pathways, but the shared seed samples no selected rain/depth surface, terrain, catchment, barrier, inlet or control state. Local distribution is unsupported until a versioned municipal or HHNK footprint is selected with units, resolution and NoData.',
    'river-flood:GM1980':
      'The named Rhine/Meuse/IJssel preset is numerically neutral for Dijk en Waard. This narrow source result says nothing about IJsselmeer/Markermeer, canal, boezem, polder, defence, drainage, access or indirect high-water pathways; local distribution remains unsupported rather than an all-clear.',
    'coastal-flood:GM1980':
      'The coast-distance scalar selects no North Sea or IJsselmeer/Markermeer boundary, tide/surge, named HHNK defence segment/state, breach/overtopping, connected footprint, probability, arrival, duration, recession or dewatering path. Its retained amplitude is a non-operational diagnostic only and local impact remains Unknown until an authority-selected versioned event is supplied.',
    'heatwave:GM1980':
      'Dijk en Waard heat and drought rankings reuse the same order as flood and fire rather than apparent temperature, warm nights, shade, paving, buildings, peat/soil, groundwater, age or vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the common seed.',
    'winter-storm:GM1980':
      'Dijk en Waard winter rankings reuse a shared seed and sample no event-valid snow/ice, N-road, bridge, rail, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1980':
      'Dijk en Waard cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, PWN, HHNK, telecom, municipal, rail, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1980':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Dijk en Waard ground-motion/site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM1980':
      'A controlled source inside mapped Bomenbuurt deciduous forest can leave its containing neighbourhood fiftieth of sixty-nine because the common allocator ignores source containment. Local flame and smoke remain unsupported until a named perimeter, eligible vegetation/fuel, moisture, event-valid wind, access, extinguishing water and suppression state govern allocation.',
    'severe-storm:GM0384':
      'Diemen storm rankings reuse a shared 37-neighbourhood seed rather than event-valid gust, tree/building, overhead-line, A1/A9, tunnel, rail/metro/tram or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0384':
      'Diemen has distinct urban-rain, polder, sewer, defence, pump and receiving-water pathways plus official modeled rain context, but the common seed samples none of them and can rank zero-resident Diemer Vijfhoek first. Local distribution is unsupported until a versioned AGV or municipal footprint is selected with units, resolution, licence and NoData.',
    'river-flood:GM0384':
      'The generic Rhine/Meuse/IJssel screen selects no Amsterdam-Rijnkanaal, IJmeer/Markermeer, boezem or polder boundary, defence/gate state, breach/overflow, connected footprint, arrival, duration or dewatering path for Diemen. Any retained amplitude is diagnostic only and local impact remains Unknown until an authority-selected versioned event is supplied.',
    'coastal-flood:GM0384':
      'The coast-distance scalar selects no IJmeer/Markermeer or North Sea boundary, named primary/regional defence state, breach/overflow, canal connection, probability, footprint, arrival, duration or dewatering path for Diemen. Its retained amplitude is a non-operational diagnostic only and not a T+72 forecast.',
    'heatwave:GM0384':
      'Diemen heat and drought rankings repeat the pluvial, coastal and wildfire order rather than the official PET context, warm nights, shade, paving, buildings, vegetation, age or vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the common seed.',
    'winter-storm:GM0384':
      'Diemen winter rankings reuse a shared seed and sample no event-valid snow/ice, A1/A9, Gaasperdammertunnel, rail/metro/tram, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0384':
      'Diemen cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, drinking-water, AGV, telecom, tunnel, transit, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0384':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Diemen ground-motion/site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0384':
      'A controlled source in Diemerbos/Gemeenschapspolder can leave its source neighbourhood seventeenth of thirty-seven while zero-resident Diemer Vijfhoek ranks first because the common allocator ignores source containment. Local flame and smoke remain unsupported until a named perimeter, eligible forest/fuel, moisture, event-valid wind, access, extinguishing water and suppression state govern allocation.',
    'severe-storm:GM0221':
      'Doesburg storm rankings reuse the same eleven-neighbourhood seed as unrelated hazards and sample no event-valid KNMI gust/rain, tree/building, historic-centre, bridge, N317/N338, overhead-line or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0221':
      'Doesburg publishes distinct WRIJ T100/T1000 rain-depth, affected-building and road-passability products, but the shared seed samples none of their cells, classes or NoData. Under T100 context, official classifications concentrate severe road records in Noordelijk and Zuidelijk Molenveld and Beinum I rather than model-first Verspreide huizen Noordoost. Local distribution is unsupported until a pinned licensed WRIJ event with units, resolution and NoData is intersected.',
    'river-flood:GM0221':
      'Doesburg has a genuine IJssel/Oude IJssel and dike-ring pathway, but the reference-point proximity scalar selects no hydrograph, datum, defence segment/state, breach/overtopping mechanism, connected footprint, probability, arrival, duration or recession. Its retained amplitude is a non-operational diagnostic only; local impact and recovery remain Unknown pending an expert-selected versioned LIWO/WRIJ/Rijkswaterstaat event.',
    'coastal-flood:GM0221':
      'Doesburg has no selected direct North Sea inundation mechanism in this preset. Any zero direct coastal water is narrow and says nothing about IJssel/Oude IJssel, regional water, drainage, access or indirect national-service effects; the wind allocation also lacks event-valid local exposure evidence.',
    'heatwave:GM0221':
      'Doesburg heat/drought ranking repeats the shared flood and fire order rather than the published WRIJ heat geography, shade, paving, historic-centre buildings, vegetation, groundwater, age or vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the common seed.',
    'winter-storm:GM0221':
      'Doesburg winter rankings reuse a shared geographic seed and sample no event-valid snow/ice, bridge, N317/N338, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0221':
      'Doesburg cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, WRIJ, telecom, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0221':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Doesburg ground-motion/site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0221':
      'A controlled source inside current TOP10NL deciduous forest in Beinum I can rank its source neighbourhood only eighth of eleven because the common allocator ignores source containment. Vegetation fire also differs from Doesburg historic-centre building fire. Local direct-fire distribution is unsupported until a named source/perimeter, eligible fuel, moisture, event-valid wind, access, extinguishing water and suppression state govern allocation.',
    'severe-storm:GM1774':
      'Dinkelland storm rankings reuse the same 46-neighbourhood seed as unrelated hazards and sample no event-valid KNMI gust/rain, rural tree/building, Ootmarsum access, N342/B403, overhead-line or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM1774':
      'Dinkelland applies a municipal 70 mm in one hour planning test while Overijssel publishes a separate 70 mm in two hours scenario; the shared seed consumes neither and samples no terrain, catchment, sewer, culvert, receiving-water or control state. These scenarios must remain distinct, and local distribution is unsupported until a selected versioned footprint with units, resolution, licence and NoData is intersected.',
    'river-flood:GM1774':
      'The named Rhine/Meuse/IJssel preset is numerically neutral for Dinkelland, but that narrow zero does not cover the cross-border Dinkel, Regge/Dinkel regional water, brook valleys, drainage, roads or indirect supply. Those pathways remain Unknown until an authority-selected cross-border hydrograph/rainfall and connected footprint with arrival, recession, uncertainty, licence and NoData are supplied; zero is not an all-clear.',
    'coastal-flood:GM1774':
      'Dinkelland has no selected direct North Sea inundation event; the remote coastal wind/system exercise reuses a common local order without event-valid weather or exposed-object evidence. Its narrow direct-water zero is not an all-clear for Dinkel, regional-water, pluvial, drainage, access or indirect national-service pathways.',
    'heatwave:GM1774':
      'Dinkelland heat/drought ranking repeats unrelated water and infrastructure orders rather than apparent temperature, shade, paving, high sandy soils, groundwater, vegetation, buildings, older residents or other vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the common seed.',
    'winter-storm:GM1774':
      'Dinkelland winter rankings reuse a shared seed and sample no event-valid snow/ice, dispersed-village access, narrow Ootmarsum streets, N342/B403, rail, ambulance routes, overhead lines or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1774':
      'Dinkelland cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis/Coteq, Vitens, Vechtstromen, telecom, municipal, cross-border or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1774':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Dinkelland ground-motion/site-response field, exposed-building set or service-asset fragility. The event catalogue is context only; retained sensitivity is unsupported and is not observed shaking, probability or a damage forecast.',
    'wildfire:GM1774':
      'The canonical wildfire is remote and its shared neighbourhood order selects no Dinkelland ignition, perimeter, eligible rural vegetation, fuel/moisture, event-valid wind, narrow-road access, extinguishing water or suppression state. A separate controlled Breklenkamp source-containment regression passes but does not validate the canonical local ranking or live fuel; local distribution remains unsupported.',
    'severe-storm:GM0222':
      'Doetinchem storm rankings reuse a common 84-neighbourhood order and sample no event-valid KNMI gust/rain, tree/building, A18/N-road, rail, overhead-line or exposed-asset evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the shared order.',
    'pluvial-flood:GM0222':
      'Doetinchem and WRIJ publish distinct 70 mm/one-hour, 90 mm/one-hour, 160 mm/two-hour and 120 mm/48-hour depth and road-passability products, but the common seed samples none of their cells, classes or NoData. Local distribution and T+72 drainage are unsupported until one governed versioned event with units, resolution, coverage, licence and dewatering assumptions is selected.',
    'river-flood:GM0222':
      'Doetinchem has genuine Oude IJssel/IJssel and defence pathways, but the proximity scalar selects no boundary hydrograph, gauge datum, Grutbroek or other defence state, breach/overtopping mechanism, connected footprint, probability, arrival, recession or dewatering. Its retained amplitude is a non-operational diagnostic only; local impact and T+72 service consequences remain Unknown pending a WRIJ/WMCN-approved versioned event.',
    'coastal-flood:GM0222':
      'Doetinchem has no selected direct North Sea inundation mechanism in this preset. Its zero direct coastal water is narrowly scoped and says nothing about Oude IJssel, regional-water, pluvial, drainage, access or indirect national-service pathways; the reused wind allocation also lacks event-valid local exposure evidence.',
    'heatwave:GM0222':
      'Doetinchem heat and drought rankings repeat the same 84-neighbourhood water and wildfire order rather than WRIJ heat/groundwater surfaces, apparent temperature, warm nights, shade, paving, vegetation, buildings, age or vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the common seed.',
    'winter-storm:GM0222':
      'Doetinchem winter rankings reuse a shared seed and sample no event-valid snow/ice, A18/N-road, rail, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0222':
      'Doetinchem cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, WRIJ, telecom, hospital, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0222':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Doetinchem ground-motion/site-response field, exposed-building set or service-asset fragility. Catalogue absence is not zero probability; retained sensitivity is unsupported and is not observed shaking or a damage forecast.',
    'wildfire:GM0222':
      'A controlled source inside official mixed forest in Buitengebied - Slangenburg can rank its source neighbourhood only twenty-eighth of 84 while De Huet leads because the common allocator ignores source containment. Local direct flame remains unsupported until a named ignition/perimeter, eligible fuel, moisture, event-valid wind, access, extinguishing water and suppression state govern allocation; remote smoke is a separate mechanism.',
    'severe-storm:GM0505':
      'Dordrecht storm rankings reuse a shared 132-neighbourhood seed and sample no event-valid KNMI gust/rain, tree/building, port, bridge/tunnel, rail, overhead-line or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0505':
      'Dordrecht has published provincial 100 mm/two-hour urban-rain context plus distinct sewer, surface-water and groundwater pathways, but the common seed samples no governed depth raster, model-information layer, catchment, control state, resolution or NoData. Local distribution and T+72 drainage are unsupported until a selected versioned event is intersected.',
    'river-flood:GM0505':
      'Dordrecht has genuine dike-ring-22, outer-dike, tidal and major-river pathways, but the proximity scalar selects no LIWO/WSHD case, defence or breach/overtopping state, river/sea/tide boundary, datum, connected footprint, probability, arrival, duration or recession. Its retained amplitude is a non-operational diagnostic only; local impact and T+72 recovery remain Unknown pending an authority-selected versioned event.',
    'coastal-flood:GM0505':
      'The direct coastal-distance value is narrowly zero for Dordrecht and excludes its sea/storm-driven tidal, combined river-sea, outer-dike and indirect access pathways. Zero is not an all-clear: local water exposure remains Unknown until a selected LIWO/WSHD/Rijkswaterstaat case retains boundary conditions, defence state, connected footprint, probability, arrival and recession.',
    'heatwave:GM0505':
      'Dordrecht heat and drought rankings repeat the same 132-neighbourhood water, cyber and wildfire order rather than apparent temperature, warm nights, shade, paving, vegetation, buildings, age, care dependence or event-valid vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the common seed.',
    'winter-storm:GM0505':
      'Dordrecht winter rankings reuse a shared seed and sample no event-valid snow/ice, N3/A16 crossing, bridge/tunnel, rail, port, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0505':
      'Dordrecht cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Stedin, Evides, water-board, telecom, hospital, port, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0505':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Dordrecht ground-motion/site-response field, exposed-building set or service-asset fragility. Catalogue absence is not zero probability; retained sensitivity is unsupported and is not observed shaking or a damage forecast.',
    'wildfire:GM0505':
      'A controlled source inside mapped broadleaf forest in Dordtse Biesbosch can rank its containing neighbourhood only 130th of 132 because the common allocator ignores source containment. Aged land-cover geometry proves only possible fuel eligibility, not a current ignition or fuel state; local direct flame remains unsupported until a named source/perimeter, moisture, event-valid wind, access, extinguishing water and suppression state govern allocation.',
    'severe-storm:GM0766':
      'Dongen storm rankings reuse the same seventeen-neighbourhood seed as unrelated hazards and sample no event-valid KNMI gust/rain, tree/building, N629/N632, overhead-line or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0766':
      'Dongen publishes distinct 70 and 90 mm/one-hour and 160 mm/two-hour hydraulic tests whose named road and building hotspots differ from the shared seed: several official hotspots rank only ninth through seventeenth while Buitengebied Oost leads. Local distribution is unsupported until a governed native surface retains event, units, resolution, edition, licence, coverage and NoData.',
    'river-flood:GM0766':
      'Dongen has real flood pathways and probability-band context, but the proximity scalar selects no Donge/Wilhelminakanaal or major-river boundary, defence state, breach/overtopping mechanism, connected footprint, probability, arrival, duration or recession. Its retained amplitude is a non-operational diagnostic only; local impact and T+72 recovery remain Unknown pending an authority-selected LIWO/Brabantse Delta/Rijkswaterstaat event.',
    'coastal-flood:GM0766':
      'Dongen has no selected direct North Sea inundation mechanism in this preset. Any direct coastal-distance result is narrowly scoped and says nothing about Donge, Wilhelminakanaal, regional water, pluvial drainage, access or indirect national-service pathways; reused wind allocation also lacks event-valid local evidence.',
    'heatwave:GM0766':
      'Dongen heat and drought rankings repeat the shared flood and cyber order and can put rural Buitengebied Oost first while published thermal context identifies Tichelrijt and Wildert as strong heat islands. Local distribution is unsupported until versioned thermal, drought, apparent-temperature and vulnerability surfaces replace the common seed.',
    'winter-storm:GM0766':
      'Dongen winter rankings reuse a shared seed and sample no event-valid snow/ice, N629/N632, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0766':
      'Dongen cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Brabant Water, Brabantse Delta, telecom, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0766':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Dongen ground-motion/site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0766':
      'The canonical wildfire allocation reuses Dongen\'s shared neighbourhood seed without a selected local ignition, perimeter, eligible fuel, moisture, event-valid wind, access, extinguishing water or suppression state. Local flame and smoke distribution remains unsupported; public land cover alone cannot establish a current incident or spread.',
    'severe-storm:GM1719':
      'Drimmelen storm rankings use a shared 38-neighbourhood seed rather than event-valid KNMI gust/rain, trees, buildings, Amer/bridge/road, overhead-line or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM1719':
      'Drimmelen has official hydraulic planning layers with partial coverage and distinct event semantics, but the shared seed samples no governed surface, terrain, catchment, sewer, culvert, control state, resolution or NoData. Local distribution and T+72 drainage remain unsupported until a municipality-wide versioned event is selected.',
    'river-flood:GM1719':
      'Drimmelen has genuine Amer/Benedenrivieren and defence-dependent flood pathways, but the proximity scalar selects no boundary hydrograph, datum, defence or breach/overtopping state, connected footprint, probability, arrival, duration or recession. Its retained amplitude is a non-operational diagnostic only; local impact and T+72 recovery remain Unknown pending an authority-selected LIWO/LVO/Brabantse Delta event.',
    'coastal-flood:GM1719':
      'Drimmelen coastal and tidal influence is defence-, Amer- and Benedenrivieren-dependent, while the generic coast-distance screen selects no sea/river/tide boundary, defence state, connected footprint, probability, arrival or recession. Any retained value is an unsupported diagnostic, not current flooding or a T+72 forecast.',
    'heatwave:GM1719':
      'Drimmelen heat and drought rankings repeat the shared water and wildfire order rather than published Made/Terheijden heat context, apparent temperature, warm nights, shade, paving, vegetation, buildings, age or vulnerability evidence. Local distribution is unsupported until versioned hazard-specific surfaces replace the common seed.',
    'winter-storm:GM1719':
      'Drimmelen winter rankings reuse a shared seed and sample no event-valid snow/ice, dispersed-road, bridge, rail, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1719':
      'Drimmelen cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Brabant Water, Brabantse Delta, telecom, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1719':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Drimmelen ground-motion/site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM1719':
      'A controlled source inside official Rupsenhoek/Sluishoek woodland and Verspreide huizen Biesbosch does not lead its containing neighbourhood because the common allocator ignores source containment. Woodland geometry establishes context, not current fuel or ignition; local flame remains unsupported until a named source/perimeter, moisture, event-valid wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0225':
      'Druten storm rankings reuse a shared 26-neighbourhood seed and sample no event-valid KNMI gust/rain, Waal crossing, tree, building, overhead-line or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0225':
      'Druten does not sample Rivierenland\'s public 60 mm/one-hour depth and flow-path scenario, terrain, sewer catchment, pump/control state, receiving water, resolution or NoData. Local distribution and drainage timing remain unsupported until a governed versioned event is validated with the municipality and water board.',
    'river-flood:GM0225':
      'Druten has genuine Waal, outer-dike and Zuidelijke Waaldijk pathways, but the proximity scalar selects no hydrograph/datum, defence or breach/overtopping state, connected footprint, probability, arrival, recession or dewatering. Its retained amplitude is a non-operational diagnostic only; local impact and T+72 recovery remain Unknown pending an authority-selected event.',
    'coastal-flood:GM0225':
      'Druten has no selected direct North Sea inundation mechanism in this preset. Any direct coastal-distance result is narrowly scoped and says nothing about Waal, regional-water, pluvial, access or indirect national-service pathways; local distribution remains unsupported.',
    'heatwave:GM0225':
      'Druten heat and drought rankings reuse the shared flood and cyber order rather than apparent temperature, warm nights, shade, paving, vegetation, groundwater, buildings, age or vulnerability evidence. Local distribution is unsupported until versioned mechanism-specific surfaces replace the common seed.',
    'winter-storm:GM0225':
      'Druten winter rankings reuse a shared seed and sample no event-valid snow/ice, Waal crossing, local-road, ferry, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0225':
      'Druten cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, Rivierenland, telecom, care, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0225':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Druten ground-motion/site-response field, exposed-building set or service-asset fragility. Catalogue absence is not zero probability; retained sensitivity is unsupported and is not observed shaking or a damage forecast.',
    'wildfire:GM0225':
      'A controlled source inside official Horssen woodland can leave Verspreide huizen Horssen seventeenth of 26 because the common allocator ignores source containment. Local direct flame remains unsupported until a named ignition/perimeter, eligible fuel, moisture, event-valid wind, access, extinguishing water and suppression state govern allocation; remote smoke is separate.',
    'severe-storm:GM0303':
      'Dronten storm rankings reuse a shared 42-neighbourhood seed and sample no event-valid KNMI gust/rain, polder, bridge, road, tree, building, overhead-line or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0303':
      'Dronten does not sample its official 63.4 mm/hour extreme-rain footprint, terrain, sewer and surface-water catchments, pump/control dependencies, polder receiving levels, resolution or NoData. Local distribution and T+72 drainage remain unsupported until a governed versioned event is selected.',
    'river-flood:GM0303':
      'Dronten\'s polder exposure can depend on IJssel, Ketelmeer or Reevediep levels and defence state, but the generic river scalar selects no connected hydraulic event, boundary level/datum, failure mechanism, depth, arrival, recession or dewatering path. Retained water stress is a non-operational diagnostic only.',
    'coastal-flood:GM0303':
      'Dronten has no selected direct North Sea inundation mechanism in this preset. Any coast-distance value is narrowly scoped and says nothing about IJsselmeer-region water, polder defences, pumping, pluvial drainage, access or indirect service pathways; local distribution remains unsupported.',
    'heatwave:GM0303':
      'Dronten heat and drought rankings reuse the shared water, cyber and wildfire order rather than apparent temperature, warm nights, shade, paving, vegetation, agriculture, groundwater, visitor exposure, buildings, age or vulnerability evidence. Local distribution is unsupported.',
    'winter-storm:GM0303':
      'Dronten winter rankings reuse a shared seed and sample no event-valid snow/ice, N-road, bridge, scheduled-transit, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0303':
      'Dronten cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, Zuiderzeeland, telecom, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0303':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Dronten ground-motion/site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0303':
      'A controlled direct-fire source inside mapped Roggebotzand forest can rank its containing neighbourhood only twelfth of 42 because the common allocator ignores source containment. Local flame remains unsupported until a named source/perimeter, eligible fuel, moisture, event-valid wind, access, extinguishing water and suppression state govern allocation.',
    'severe-storm:GM0498':
      'Drechterland storm rankings reuse a shared 27-neighbourhood seed and sample no event-valid KNMI gust/rain, Markermeer crossing, tree, building, overhead-line or exposed-object evidence. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0498':
      'Drechterland does not sample its published Hoogkarspel, Venhuizen, Lakenmanweg pump and N307 underpass mechanisms, nor a governed depth surface, catchment, sewer/control state, resolution or NoData. Local distribution and drainage timing remain unsupported.',
    'river-flood:GM0498':
      'The Rhine/Meuse/IJssel preset selects no relevant Drechterland hydraulic event and does not model Markermeer, regional-water, polder or defence pathways. Its retained amplitude is a non-operational diagnostic only; local impact and T+72 recovery remain Unknown pending an authority-selected versioned event.',
    'coastal-flood:GM0498':
      'Drechterland\'s relevant water pathways depend on Markermeer level, wind setup, polder defences and pumping, but the generic coast-distance screen selects none of those conditions or a connected footprint, probability, arrival, duration or recession. Local magnitude and recovery remain unsupported.',
    'heatwave:GM0498':
      'Drechterland heat and drought rankings repeat the shared water and cyber order rather than published Zuiderkogge, Schellinkhout and Markermeerdijk context, apparent temperature, warm nights, shade, vegetation, groundwater, salinity, buildings, age or vulnerability evidence. Local distribution is unsupported.',
    'winter-storm:GM0498':
      'Drechterland winter rankings reuse a shared seed and sample no event-valid snow/ice, N307/N506, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0498':
      'Drechterland cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, PWN, HHNK, telecom, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0498':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Drechterland ground-motion/site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0498':
      'A controlled source inside Oosterleek can leave that containing neighbourhood eleventh of 27 because the common allocator ignores source containment. Local direct flame remains unsupported until a named ignition/perimeter, eligible fuel, moisture, event-valid wind, access, extinguishing water and suppression state govern allocation.',
    'severe-storm:GM0385':
      'Edam-Volendam storm rankings reuse a shared 29-neighbourhood seed and sample no event-valid KNMI gust or rain field, Markermeer exposure, bridge, tree, building, overhead-line or exposed-object state. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0385':
      'Edam-Volendam does not sample the published Volendam, Rokersgracht, sewer, pump and receiving-water mechanisms, nor a governed rain-duration, depth, flow-path, catchment, control, resolution or NoData surface. Local distribution and T+72 drainage remain unsupported.',
    'river-flood:GM0385':
      'The Rhine/Meuse/IJssel preset selects no named major-river event relevant to Edam-Volendam and does not model Markermeer, regional-water, polder or defence pathways. Any retained amplitude is a non-operational diagnostic only; local impact and recovery remain Unknown pending an authority-selected event.',
    'coastal-flood:GM0385':
      'Edam-Volendam has genuine Markermeer, Slobbeland, harbour, polder and defence-dependent pathways, but the generic coastal screen selects no lake level, wind setup, defence state, connected footprint, probability, arrival, duration, recession or pumping condition. Its retained amplitude is a non-operational diagnostic, not current flooding or a T+72 forecast.',
    'heatwave:GM0385':
      'Edam-Volendam heat and drought rankings reuse the shared water and cyber order rather than Broeckgouw, Zeestraat, bridge and subsidence context, apparent temperature, warm nights, shade, paving, vegetation, groundwater, buildings, age or vulnerability evidence. Local distribution is unsupported.',
    'winter-storm:GM0385':
      'Edam-Volendam winter rankings reuse a shared seed and sample no event-valid snow or ice, bridge, local-road, bus, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0385':
      'Edam-Volendam cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, PWN, HHNK, telecom, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0385':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Edam-Volendam ground-motion or site-response field, exposed-building set or service-asset fragility. Warder and Kwadijk historical context does not select a local event; retained sensitivity is unsupported and is not observed shaking, probability or a damage forecast.',
    'wildfire:GM0385':
      'A controlled source inside mapped Warder vegetation can rank its containing neighbourhood only fourteenth of 29 because the common allocator ignores source containment. Land cover establishes context, not current fuel or ignition; local flame remains unsupported until a named source or perimeter, moisture, event-valid wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0226':
      'Duiven storm rankings reuse a shared 14-neighbourhood seed and sample no event-valid KNMI gust or rain, A12, rail, tree, building, overhead-line or exposed-object state. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0226':
      'Duiven does not sample WRIJ duration-specific T100 or T1000 depth and road-passability surfaces, terrain, sewer catchment, pump or control state, receiving water, resolution or NoData. Local distribution, access and T+72 drainage remain unsupported.',
    'river-flood:GM0226':
      'Duiven has genuine Rhine, Pannerdensch Kanaal and IJssel pathways, but the generic river scalar selects no hydrograph or datum, defence or breach/overtopping state, Gemaal de Liemers operation, connected footprint, probability, arrival, recession or dewatering. Its retained amplitude is a non-operational diagnostic only.',
    'coastal-flood:GM0226':
      'Duiven has no selected direct North Sea inundation mechanism in this preset. The direct coastal zero is narrowly scoped and says nothing about Rhine-system, regional-water, pluvial, access or indirect national-service pathways; local distribution remains unsupported.',
    'heatwave:GM0226':
      'Duiven heat and drought rankings reuse a common seed rather than WRIJ heat context, apparent temperature, warm nights, shade, paving, vegetation, groundwater, buildings, age or vulnerable-resident evidence. Local distribution is unsupported until versioned mechanism-specific surfaces are joined to valid-time forcing.',
    'winter-storm:GM0226':
      'Duiven winter rankings reuse a shared seed and sample no event-valid snow or ice, A12, rail, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0226':
      'Duiven cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, WRIJ, telecom, municipal, care, industrial or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0226':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Duiven ground-motion or site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0226':
      'A controlled source inside mapped vegetation near Loo can leave its containing neighbourhood eleventh of 14 because the common allocator ignores source containment. Land cover establishes context, not current fuel or ignition; local flame remains unsupported until a named source or perimeter, moisture, event-valid wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM1711':
      'Echt-Susteren storm rankings reuse a shared 58-neighbourhood seed and sample no event-valid KNMI or adjoining-country gust and rain, cross-border road or rail, tree, building, overhead-line or exposed-object state. Local distribution is unsupported.',
    'pluvial-flood:GM1711':
      'Echt-Susteren does not sample a governed local rain-depth or flow-path event, catchment, sewer and surface-water topology, pump or control state, receiving water, resolution or NoData. Geleenbeek and Rode Beek pathways and T+72 drainage remain unsupported.',
    'river-flood:GM1711':
      'Echt-Susteren has genuine Maas, Geleenbeek and Rode Beek pathways, but the generic river scalar selects no hydrograph or datum, defence or breach/overtopping state, connected footprint, probability, arrival, recession, pumping or dewatering. Its retained amplitude is a non-operational diagnostic only.',
    'coastal-flood:GM1711':
      'Echt-Susteren has no selected direct North Sea inundation mechanism in this preset. The direct coastal zero is narrowly scoped and says nothing about Maas, brook, pluvial, cross-border access or indirect service pathways; local distribution remains unsupported.',
    'heatwave:GM1711':
      'Echt-Susteren heat and drought rankings reuse a common seed rather than local paving, vegetation, agriculture, groundwater, apparent temperature, warm nights, buildings, age or vulnerability evidence. Local distribution is unsupported until versioned mechanism-specific surfaces replace the common order.',
    'winter-storm:GM1711':
      'Echt-Susteren winter rankings reuse a shared seed and sample no event-valid Dutch, German or Belgian snow or ice, cross-border road or rail, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1711':
      'Echt-Susteren cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, WML, Limburg water, telecom, cross-border, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1711':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Echt-Susteren or Maria Hoop ground-motion or site-response field, exposed-building set or service-asset fragility. Historical local context does not select an event; retained sensitivity is unsupported and is not a damage forecast.',
    'wildfire:GM1711':
      'A controlled source inside mapped Echt-Susteren woodland can leave its containing neighbourhood twelfth of 58 because the common allocator ignores source containment. Woodland geometry establishes context, not current fuel or ignition; local flame remains unsupported until a named source or perimeter, moisture, event-valid wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0317':
      'Eemnes storm rankings reuse the same nine-neighbourhood order as unrelated hazards and sample no event-valid KNMI gust or rain field, Eemmeer exposure, tree, building, overhead-line or exposed-object state. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0317':
      'Eemnes does not sample the Province Utrecht and Vallei en Veluwe 74 mm/hour depth surface, including its published local variation and NoData cells, nor a duration-matched sewer, catchment, pump, control or receiving-water state. Local distribution and T+72 drainage remain unsupported.',
    'river-flood:GM0317':
      'Eemnes has Eem, Eemmeer, Randmeren and Eempolder pathways, but the generic Rhine, Meuse and IJssel field selects no local boundary level, defence or failure state, connected footprint, probability, arrival, duration, recession or pump state. Its retained amplitude is a non-operational diagnostic only.',
    'coastal-flood:GM0317':
      'Eemnes has no selected direct North Sea inundation mechanism in this preset. The direct coastal zero is narrowly scoped and says nothing about Eemmeer, Randmeren, Eempolder, regional-water, pluvial, pumping or indirect service pathways; local distribution remains unsupported.',
    'heatwave:GM0317':
      'Eemnes heat and drought rankings reuse the shared water and cyber order rather than apparent temperature, warm nights, shade, paving, vegetation, groundwater, buildings, age or vulnerability evidence. Local distribution is unsupported until versioned mechanism-specific surfaces are joined to valid-time forcing.',
    'winter-storm:GM0317':
      'Eemnes winter rankings reuse a shared seed and sample no event-valid snow or ice, A1, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0317':
      'Eemnes cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Stedin, Vitens, Vallei en Veluwe, telecom, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0317':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Eemnes ground-motion or site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0317':
      'A controlled source inside Heidehoek can leave its containing neighbourhood sixth of nine because the common allocator ignores source containment. The available combustible-nature layer returns no local match, which is Unknown rather than safe; direct flame remains unsupported until a named source or perimeter, eligible fuel, moisture, valid-time wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM1979':
      'Eemsdelta storm rankings reuse the same 92-neighbourhood order as unrelated hazards and sample no event-valid KNMI wind or rain field, Ems-Dollard exposure, port, tree, building, overhead-line or exposed-object state. Local distribution is unsupported until time-aligned forcing and asset-specific exposure replace the common order.',
    'pluvial-flood:GM1979':
      'Eemsdelta does not sample a duration-specific local rain-depth or flow-path surface, terrain, sewer and surface-water catchments, pump and control state, receiving-water level, resolution or NoData. Local exposure, access and T+72 drainage remain unsupported.',
    'river-flood:GM1979':
      'The Rhine, Meuse and IJssel preset selects no direct Eemsdelta major-river event and does not model Ems-Dollard, canal, regional-water, polder or defence pathways. A direct major-river zero is narrowly scoped and cannot establish an all-flood all-clear; local distribution remains unsupported.',
    'coastal-flood:GM1979':
      'Eemsdelta has genuine Ems-Dollard, Eemshaven, Delfzijl and Dollarddijk pathways, but the generic coastal field selects no tide or storm identifier, gauge and datum, defence segment or breach/overtopping state, coupure, pump, connected footprint, arrival or recession. Its retained amplitude is a non-operational diagnostic, not current flooding or a T+72 forecast.',
    'heatwave:GM1979':
      'Eemsdelta heat and drought rankings reuse the shared flood, cyber and fire order rather than apparent temperature, warm nights, shade, paving, vegetation, salinity, groundwater, buildings, age, port workers or vulnerability evidence. Local distribution is unsupported.',
    'winter-storm:GM1979':
      'Eemsdelta winter rankings reuse a shared seed and sample no event-valid snow, ice or coastal wind, dispersed-road, rail, port, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM1979':
      'Eemsdelta cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Groningen water, telecom, port, industrial, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1979':
      'The Eemsdelta earthquake exercise selects no KNMI event ID, origin revision, ground-motion field, local site response, exposed-building or NCG strengthening state, or service-asset fragility. The retained 0.153 g-class output is a synthetic diagnostic and is not observed shaking, probability or a damage forecast.',
    'wildfire:GM1979':
      'A controlled source inside official Woldendorp forest can leave its containing neighbourhood seventieth of 92 because the common allocator ignores source containment. Forest geometry establishes context, not current fuel or ignition; local flame remains unsupported until a named source or perimeter, moisture, event-valid wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0228':
      'Ede storm rankings reuse the same 71-neighbourhood order as unrelated hazards and sample no event-valid KNMI gust or rain, Veluwe forest, recreation, military, tree, building, overhead-line or exposed-object state. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0228':
      'Ede does not sample the applicable official pluvial depth and water-system context, nor a duration-matched terrain, sewer, catchment, pump, control, receiving-water, resolution or NoData surface. Local distribution and T+72 drainage remain unsupported.',
    'river-flood:GM0228':
      'The Rhine, Meuse and IJssel preset produces persistent Ede water stress without selecting a connected local hydraulic event, hydrograph and datum, defence state, footprint, depth, velocity, arrival, recession or dewatering. Its retained amplitude is a non-operational diagnostic only; local impact remains Unknown.',
    'coastal-flood:GM0228':
      'Ede has no selected direct North Sea inundation mechanism in this preset. The direct coastal zero is narrowly scoped and says nothing about local or regional water, pluvial, groundwater, access or indirect national-service pathways; local distribution remains unsupported.',
    'heatwave:GM0228':
      'Ede heat and drought rankings reuse the shared water and cyber order rather than apparent temperature, warm nights, shade, paving, Veluwe vegetation, groundwater, transient visitors, buildings, age or vulnerability evidence. Local distribution is unsupported.',
    'winter-storm:GM0228':
      'Ede winter rankings reuse a shared seed and sample no event-valid snow or ice, Veluwe and local-road access, rail, ambulance access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0228':
      'Ede cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, Vallei en Veluwe, telecom, military, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0228':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Ede ground-motion or site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0228':
      'A controlled source inside Reemst heathland can leave its containing neighbourhood thirty-ninth of 71 because the common allocator ignores source containment. Heathland geometry establishes context, not current fuel or ignition; local flame remains unsupported until a named source or perimeter, moisture, event-valid wind, barriers, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0230':
      'Elburg storm rankings reuse the same 22-neighbourhood order as unrelated hazards and sample no event-valid KNMI gust or rain, A28/N309, Drontermeer crossing, rail, tree, building, overhead-line or exposed-object state. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0230':
      'Elburg does not sample its evolving urban-water system, street-scale stress test, Aquaflow, infiltration sewer, wadi overflow, terrain, sewer and receiving-water topology, pump/control state, resolution or NoData. Local distribution, access and T+72 drainage remain unsupported until a governed rain event and versioned municipal surface are selected.',
    'river-flood:GM0230':
      'Elburg has genuine Randmeren, Drontermeer, IJssel and defence pathways, but the generic Rhine, Meuse and IJssel proximity field selects no local boundary condition, defence or sluice state, connected footprint, depth, arrival, duration, recession or dewatering. The contradicted amplitude is suppressed; published older PROMOVERA levels may be about 0.75 m too high at Elburg, so local impact remains Unknown pending a versioned authority-selected event.',
    'coastal-flood:GM0230':
      'Elburg has no selected direct North Sea inundation mechanism in this preset. The direct coastal zero is narrowly scoped and says nothing about Randmeren setup, IJssel inflow, regional water, pluvial drainage, defences, access or indirect national-service pathways; local distribution remains unsupported.',
    'heatwave:GM0230':
      'Elburg heat and drought rankings reuse the shared flood and cyber order rather than the updated regional perceived-temperature, warm-night, groundwater, rain and water-supply surfaces, shade, paving, vegetation, buildings, age or vulnerability evidence. Local distribution is unsupported until versioned mechanism-specific layers are joined to valid-time forcing.',
    'winter-storm:GM0230':
      'Elburg winter rankings reuse a shared seed and sample no event-valid snow or ice, A28/N309 and local-road access, Drontermeer crossing, rail, ambulance access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0230':
      'Elburg cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, water-board, telecom, rail, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0230':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Elburg ground-motion or site-response field, exposed-building set or service-asset fragility. The regional profile does not expect building-damaging earthquakes; retained sensitivity is unsupported and must not be read as observed shaking, probability, a forecast or an all-clear for other hazards.',
    'wildfire:GM0230':
      'A controlled source inside official mixed forest and Buitengebied ’t Harde Zuid can leave its containing neighbourhood last of 22 while Broeklanden ranks first because the common allocator ignores source containment. Combustible-area geometry establishes eligibility, not ignition or current fuel; local flame remains unsupported until a named source or perimeter, moisture, event-valid wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0388':
      'Enkhuizen storm rankings reuse the same 19-neighbourhood order as unrelated hazards and sample no event-valid KNMI lake wind, gust or rain field, historic buildings, trees, Liander assets, Houtribdijk, rail or exposed-object state. Local distribution is unsupported until time-aligned forcing and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0388':
      'Enkhuizen does not sample its separate 70 mm in one hour stress-test footprint, named street and emergency-access hotspots, sewer catchments, 13 main and 94 pressure pumps, receiving-water state, emptying time, resolution or NoData. The national 70 mm in two hours layer is a different event; local distribution and T+72 drainage remain unsupported.',
    'river-flood:GM0388':
      'Enkhuizen has genuine IJsselmeer, Markermeer, polder and defence pathways, but the generic river scalar selects no named lake boundary level, hydrograph or datum, wind setup, defence or control state, connected footprint, depth, velocity, arrival, duration, recession or dewatering. The retained amplitude is a non-operational diagnostic only; local impact remains Unknown.',
    'coastal-flood:GM0388':
      'Enkhuizen lake and polder pathways are not a direct North Sea distance field. The generic coastal scalar selects no IJsselmeer/Markermeer boundary, wind setup, defence or Sassluis state, outer-dike mask, connected footprint, arrival or recession. Its retained amplitude is a non-operational diagnostic, not current flooding or a T+72 forecast.',
    'heatwave:GM0388':
      'Enkhuizen heat and drought rankings reuse the shared flood and cyber order rather than historic-centre fabric, older residents, schools, southern industry, apparent temperature, warm nights, shade, paving, groundwater, buildings or vulnerability evidence. Local distribution is unsupported until versioned surfaces are joined to valid-time forcing.',
    'winter-storm:GM0388':
      'Enkhuizen winter rankings reuse a shared seed and sample no event-valid snow, ice or lake wind, Houtribdijk/naviduct and local-road access, rail, ambulance routes to Hoorn or Lelystad, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0388':
      'Enkhuizen cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, PWN, sewer, telecom, transport, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0388':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Enkhuizen ground-motion or site-response field, exposed-building set or service-asset fragility. Retained sensitivity and later service memory are unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0388':
      'A controlled source inside official Enkhuizerzand broadleaf woodland can leave its containing neighbourhood sixth of 19 while Ketenwaal about 5.5 km away ranks first because the common allocator ignores source containment. Land cover establishes eligibility, not ignition or current fuel; local flame remains unsupported until a named source or perimeter, moisture, valid-time wind, barriers, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0232':
      'Epe storm rankings reuse a common 29-neighbourhood order and sample no event-valid KNMI gust or rain field, Veluwe forest, holiday parks, trees, buildings, local roads, overhead lines or exposed-object state. Local distribution is unsupported until time-aligned forcing and asset-specific exposure replace the shared seed.',
    'pluvial-flood:GM0232':
      'Epe does not sample its named brooks, streets, culverts, ponds, high-groundwater areas, sewer and receiving-water topology, pumps and controls, or its separate 74 mm in one hour stress test. The national 70 mm in two hours layer is a different event; local distribution, access and T+72 drainage remain unsupported.',
    'river-flood:GM0232':
      'The generic Rhine, Meuse and IJssel proximity field produced a persistent 3.14 m-class value without a selected IJssel water level, defence or breach state, connected footprint, probability, arrival, duration, recession or dewatering. That exact amplitude is suppressed. IJssel-influenced groundwater, dike seepage, constrained inflow, pumps and the eastern low area remain unresolved, not safe.',
    'coastal-flood:GM0232':
      'Epe has no selected direct North Sea inundation mechanism in this preset. The direct coastal zero is narrowly scoped and says nothing about IJssel, brooks, groundwater, pluvial drainage, access, indirect evacuee demand or national-service pathways; local distribution remains unsupported.',
    'heatwave:GM0232':
      'Epe heat and drought rankings reuse the shared flood and fire order rather than older residents, non-adapted homes, Veluwe forest and soils, water availability, shade, apparent temperature, warm nights, buildings and vulnerability evidence. Current restrictions are observations, not this exercise’s T+72 forcing; local distribution is unsupported.',
    'winter-storm:GM0232':
      'Epe winter rankings reuse a shared seed and sample no event-valid snow or ice, dispersed settlements, forest and local-road access, bus operation, external-care routes, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0232':
      'Epe cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Liander, Vitens, water-board, telecom, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0232':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Epe ground-motion or site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0232':
      'A controlled source inside official mixed forest near Gortel and Buitengebied Vaassen can leave its containing neighbourhood twenty-third of 29 while urban Heggerenk ranks first because the common allocator ignores source containment. Forest geometry establishes eligibility, not ignition or current fuel; local flame remains unsupported until a named source or perimeter, moisture, valid-time wind, park and visitor exposure, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0114':
      'Emmen storm rankings reuse a common 83-neighbourhood order and sample no event-valid KNMI gust or rain field, dispersed settlements, peat and forest, A37/B402, trees, buildings, overhead lines or exposed-object state. Local distribution is unsupported until time-aligned forcing and asset-specific exposure replace the shared seed.',
    'pluvial-flood:GM0114':
      'Emmen does not sample its coupled peat, Buffer Zuid, Schoonebeekerdiep, 14.5 km watercourse/culvert works, sewer, RWZI and pressure-main systems, AHN terrain, antecedent groundwater, receiving-water and control state, resolution or NoData. Empty national HWH coverage is not zero assets; local distribution and T+72 drainage remain unsupported.',
    'river-flood:GM0114':
      'The named Rhine, Meuse and IJssel screen is zero in Emmen only within that direct source scope. It says nothing about Schoonebeekerdiep, canals, brooks, peat and groundwater, German boundary water, pluvial flooding, drainage controls or indirect national-service pathways. Local distribution remains unsupported pending a selected connected hydraulic event.',
    'coastal-flood:GM0114':
      'The regional profile does not place direct sea flooding in Emmen, so direct coastal water remains zero only within that narrow mechanism. Coastal-event evacuees and supply demand, local water, peat/groundwater, access and national-service dependencies remain unresolved, not safe; local distribution is unsupported.',
    'heatwave:GM0114':
      'Emmen heat and drought rankings reuse the shared water and fire order rather than peat oxidation, groundwater extraction, subsidence, Bargerveen retention, shade, apparent temperature, warm nights, buildings, older/care residents or vulnerability evidence. Planning layers and current gauges are not T+72 forcing; local distribution is unsupported.',
    'winter-storm:GM0114':
      'Emmen winter rankings reuse a shared seed and sample no event-valid snow or ice, dispersed-settlement and A37/B402 access, rail and bus operation, ambulance routes, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0114':
      'Emmen cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, WMD, water-board, telecom, hospital, cross-border, municipal or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0114':
      'Emmen has historical induced events, but this exercise selects no KNMI event ID or revision, source model, ground-motion field, local site response, exposed-building set or service-asset fragility. The retained 0.071 g-class sensitivity is unsupported and is not observed shaking, probability or a damage forecast; no recent local catalogue match is not zero future risk.',
    'wildfire:GM0114':
      'A controlled source inside official Bargerveen/Weiteveen heath and BU01143209 can leave its containing neighbourhood twenty-fourth of 83 while Hoofdkanaal about 18 km away ranks first because the common allocator ignores source containment. Heath geometry establishes eligibility, not ignition or current fuel; local flame remains unsupported until a named source or perimeter, moisture, valid-time wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0770':
      'Eersel storm rankings reuse the same 24-neighbourhood order as unrelated hazards and sample no event-valid KNMI gust or rain field, A67/N397, tree, building, overhead-line or exposed-object state. Local distribution is unsupported until time-aligned weather and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0770':
      'Eersel does not sample its published Eersel-kom en Lindeakkers and Eersel-Zuid bottlenecks, Kleine Beerze/Run terrain, sewer and surface-water catchments, pump/control state, receiving water, resolution or NoData. Local distribution and T+72 drainage remain unsupported.',
    'river-flood:GM0770':
      'The Brabant-Zuidoost risk profile places high-lying Eersel outside direct sea and major-river flood danger, so the generic Rhine, Meuse and IJssel proximity amplitude is suppressed. Local streams, regional water, pluvial flooding and indirect blocked southern drainage during northern high water remain unresolved, not safe; a selected connected hydraulic footprint is required.',
    'coastal-flood:GM0770':
      'Eersel has no selected direct North Sea inundation mechanism in this preset. The direct coastal zero is narrowly scoped and says nothing about local streams, regional water, pluvial drainage, groundwater, access or indirect national-service pathways; local distribution remains unsupported.',
    'heatwave:GM0770':
      'Eersel heat and drought rankings reuse the shared water and cyber order rather than published core heat and Vessem, Knegsel and Wintelre groundwater patterns, apparent temperature, warm nights, shade, paving, vegetation, buildings, age or vulnerability evidence. Local distribution is unsupported.',
    'winter-storm:GM0770':
      'Eersel winter rankings reuse a shared seed and sample no event-valid snow or ice, A67/N397 and local-road access, scheduled transit, external-care route, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0770':
      'Eersel cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Brabant Water, sewer, telecom, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0770':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Eersel ground-motion or site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0770':
      'A controlled source inside official Oeienbos and Knegsel-Oeyenbos can leave its containing neighbourhood last of 24 because the common allocator ignores source containment. Combustible-nature geometry establishes context, not current fuel or ignition; local flame remains unsupported until a named source or perimeter, moisture, event-valid wind, access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM1903':
      'Eijsden-Margraten storm rankings reuse a shared 34-neighbourhood order and sample no event-valid Dutch or Belgian gust and rain field, plateau, tree, building, overhead-line, cross-border road or rail, or exposed-object state. Local distribution is unsupported.',
    'pluvial-flood:GM1903':
      'Eijsden-Margraten does not sample its six Noor catchments, plateau-to-valley runoff, buffers, erosion, terrain, sewer and surface-water topology, pump/control state, receiving water, resolution or NoData. Local distribution, access and T+72 drainage remain unsupported.',
    'river-flood:GM1903':
      'Eijsden-Margraten has genuine Maas and tributary pathways, but the generic river scalar selects no Belgian/French upstream hydrograph, datum, saturated-soil state, defence or breach/overtopping state, connected footprint, arrival, recession, pumping or dewatering. Its retained amplitude is a non-operational diagnostic only.',
    'coastal-flood:GM1903':
      'Eijsden-Margraten has no selected direct North Sea inundation mechanism in this preset. The direct coastal zero is narrowly scoped and says nothing about Maas, Noor, regional-water, pluvial, cross-border access or indirect service pathways; local distribution remains unsupported.',
    'heatwave:GM1903':
      'Eijsden-Margraten heat and drought rankings reuse the shared flood and fire order rather than plateau/slope land cover, groundwater, agriculture, apparent temperature, warm nights, shade, buildings, age or vulnerability evidence. Local distribution is unsupported.',
    'winter-storm:GM1903':
      'Eijsden-Margraten winter rankings reuse a shared seed and sample no event-valid Dutch or Belgian snow and ice, A2/E25, Eijsden-Visé rail, local-road, ambulance-access, overhead-line or clearance state. Local distribution is unsupported until cross-border forcing and exposed-object evidence are intersected.',
    'cyberattack:GM1903':
      'Eijsden-Margraten cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, WML, Limburg water, telecom, cross-border, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM1903':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Eijsden-Margraten ground-motion or site-response field, underground-work condition, exposed-building set or service-asset fragility. Static quarry and underground-work labels do not select current instability; retained sensitivity is unsupported.',
    'wildfire:GM1903':
      'A controlled BRT forest source inside BU19030409 can leave its containing neighbourhood twelfth of 34 because the common allocator ignores source containment. Savelsbos and forest geometry establish eligibility context, not ignition or current fuel; local flame remains unsupported until a named source or perimeter, moisture, event-valid wind, hollow-road access, extinguishing water and suppression govern allocation.',
    'severe-storm:GM0772':
      'Eindhoven storm rankings reuse the same 116-neighbourhood order as unrelated hazards and sample no event-valid KNMI gust or rain field, airport, A2/A67, rail, tree, building, high-rise, overhead-line or exposed-object state. Local distribution is unsupported until time-aligned forcing and asset-specific exposure replace the common order.',
    'pluvial-flood:GM0772':
      'Eindhoven does not sample its published runoff, watercourse and sewer geometry, Dommel/Tongelreep/Gender catchments, AHN depressions, pump/control state, receiving water, resolution or NoData. Local distribution, road access and T+72 drainage remain unsupported until a governed hydraulic event is selected.',
    'river-flood:GM0772':
      'The Brabant-Zuidoost risk profile places high-lying Eindhoven outside direct sea and large-river flood danger, so the generic Rhine, Meuse and IJssel amplitude is suppressed. Dommel, Tongelreep, Gender, smaller streams, regional defences, groundwater, pluvial and indirect blocked-drainage pathways remain unresolved, not safe; a selected connected hydraulic footprint is required.',
    'coastal-flood:GM0772':
      'Eindhoven has no selected direct North Sea inundation mechanism in this preset. The direct coastal zero is narrowly scoped and says nothing about Dommel-system water, pluvial drainage, groundwater, access or indirect national-service pathways; local distribution remains unsupported.',
    'heatwave:GM0772':
      'Eindhoven heat and drought rankings reuse the shared flood and cyber order rather than apparent temperature, warm nights, shade, paving, high-rise and event exposure, vegetation, groundwater, buildings, age or vulnerability evidence. Local distribution is unsupported until versioned surfaces are joined to valid-time forcing.',
    'winter-storm:GM0772':
      'Eindhoven winter rankings reuse a shared seed and sample no event-valid snow or ice, airport, A2/A67/N2 and local-road access, rail, ambulance access, overhead-line or clearance state. Local distribution is unsupported until time-aligned weather and exposed-object evidence are intersected.',
    'cyberattack:GM0772':
      'Eindhoven cyber rankings reuse a geographic seed without a declared target, affected organization, system boundary, attack path or authorized Enexis, Brabant Water, sewer, telecom, Brainport, airport, municipal, care or response dependency topology. Local distribution is unsupported until a named exercise target and reviewed system model are supplied.',
    'earthquake:GM0772':
      'The Groningen-centred earthquake exercise has no selected KNMI event, Eindhoven ground-motion or site-response field, exposed-building set or service-asset fragility. Retained sensitivity is unsupported and must not be read as observed shaking, probability or a damage forecast.',
    'wildfire:GM0772':
      'A controlled source inside official Gennep broadleaf forest can leave Gennep 112th of 116 while Wielewaal ranks first because the common allocator ignores source containment. Forest geometry establishes eligibility, not ignition or current fuel; local flame remains unsupported until a named source or perimeter, moisture, valid-time wind, visitors, access, extinguishing water and suppression govern allocation.',
    })
  const auditedMunicipalityGapNotes = auditedMunicipalityGapNotesCache ??
    (auditedMunicipalityGapNotesCache = {
    GM0153:
      'Enschede\'s completed audit found that the common neighbourhood ranking samples no event-valid local forcing, selected Dinkel, brook, canal or municipal cloudburst footprint, Lonnekerberg fire spread, German continuation, physical lifeline topology or action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; local and cross-border pathways are unresolved, not safe.',
    GM0233:
      'Ermelo\'s completed audit found that the common neighbourhood ranking samples no selected Randmeren or local-water event, official rain-depth and road-passability surface, heath-fire spread, care-campus continuity, physical lifeline topology or first-72-hour action/resource state. The unrelated Rhine, Meuse and IJssel amplitude is suppressed; local pathways are unresolved, not safe.',
    GM0777:
      'Etten-Leur\'s completed audit found that the common neighbourhood ranking contradicts the verified northern Hollands Diep exposure and samples no selected defence/breach event, Vosdonk and local drainage chain, external-care access, physical lifeline topology or first-72-hour action/resource state. The retained water amplitude is only a non-operational diagnostic.',
    GM1771:
      'Geldrop-Mierlo\'s completed audit found that the common neighbourhood ranking samples neither its distinct 87 mm/5 h, 90 mm/1 h and 160 mm/2 h rain scenarios nor Kleine Dommel and local-stream pathways, Molenbos conditions, Anna care continuity, physical lifeline topology or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; local pathways are unresolved, not safe.',
    GM1652:
      'Gemert-Bakel\'s completed audit found that the common neighbourhood ranking contradicts its local rain, heat, drought and Stippelberg geography and samples no Aa or stream event, sewer/water controls, rural and external-care access, physical lifeline topology or first-72-hour action/resource state. The regional profile excludes direct major-river flooding, so the false Rhine, Meuse and IJssel amplitude is suppressed.',
    GM0779:
      'Geertruidenberg\'s completed audit found that the common neighbourhood ranking samples no selected Amer, Bergsche Maas, Donge or Wilhelminakanaal event, managed-water topology/state, Amercentrale electricity/heat/shipping dependency, industrial source term, Hooipolder/Keizersveer continuity, external-care route or first-72-hour action/resource state. Retained water values are only non-operational diagnostics.',
    GM0784:
      'Gilze en Rijen\'s completed audit found that the common neighbourhood ranking contradicts its regional rain, drought, heat and Heiningen nature-fire geography and samples no selected local-water event, drainage chain, physical lifeline topology, village/rail/external-care continuity, airbase incident scope or first-72-hour action/resource state. The regional stress test contradicts direct major-river flooding, so the false Rhine, Meuse and IJssel amplitude is suppressed.',
    GM0907:
      'Gennep\'s completed audit found that the common neighbourhood ranking samples no authority-selected Maas/Niers/defence event, local pluvial/heat surface, Heijensebos fire spread, German-fed Niers warning chain and N291-B504-A57 continuation, connected water/sewer/RWZI topology, external-care/telecom continuity or first-72-hour action/resource state. Retained river values are non-operational diagnostics.',
    GM1924:
      'Goeree-Overflakkee\'s completed audit found that the common neighbourhood ranking samples no authority-selected Haringvliet, Brouwers, Grevelingen or Volkerak forcing and defence event, Oosterduinpad dune-fire spread, island crossing state, connected water/drainage topology, external-care and mutual-aid route or first-72-hour action/resource state. Retained river and coastal values are non-operational diagnostics.',
    GM0664:
      'Goes\'s completed audit found that the common neighbourhood ranking samples no selected Oosterschelde, Veerse Meer, Goese Sas, canal or polder-water event, Poelbos source-aware fire spread, pump/sluice/external-wastewater topology, rail/waterway/acute-care continuity, industrial and Borssele-response scope or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; coastal values remain non-operational diagnostics and local water pathways remain unresolved, not safe.',
    GM0785:
      'Goirle\'s completed audit found that the common neighbourhood ranking samples no selected Leij or regional-water event, Tijvoort and centre pluvial surface, De Zeven Vennen fire spread, N630-N12/A58 Belgian continuation, connected water and drainage topology, physical lifeline state, external-care and mutual-aid route or first-72-hour action/resource state. Retained major-river proximity values are non-operational diagnostics; local and cross-border water pathways remain unresolved, not safe.',
    GM1942:
      'Gooise Meren\'s completed audit found that the common neighbourhood ranking samples no selected IJmeer, Markermeer, Gooimeer, defence, pump or polder-water event, local pluvial and heat surface, Valkeveen fire spread, Hollandse Brug, A1, A6 or rail state, connected physical lifeline topology, external-care and mutual-aid route or first-72-hour action/resource state. Direct major-river and North Sea coastal amplitudes are suppressed; lake and polder pathways remain unresolved, not safe.',
    GM0512:
      'Gorinchem\'s completed audit found that the common neighbourhood ranking samples no authority-selected dike-ring 16 or 43 breach, Waal, Boven-Merwede, Linge or canal event, local pluvial and heat surface, Molenvliet fire-source containment, vehicle-class-aware Merwedebrug state, ferry, rail, waterway or external-care continuity, connected physical lifeline topology or first-72-hour action/resource state. Retained river values are non-operational diagnostics; the direct North Sea coastal zero is narrow and combined backwater, defence and drainage pathways remain unresolved, not safe.',
    GM0513:
      'Gouda\'s completed audit found that the common neighbourhood ranking samples no authority-selected Hollandsche IJssel, Gouwe, boezem, polder or defence/control event, hazard-specific Kort Haarlem vulnerability, complete 20-area sewer and AWZI chain, historic-centre complex-fire or industrial source, rail, waterway, bridge or lock state, connected physical lifeline topology, external-care and mutual-aid route or first-72-hour action/resource state. Retained river and coastal values are non-operational diagnostics; local pathways remain unresolved, not safe.',
    GM0014:
      'Groningen\'s completed audit found that the common neighbourhood ranking samples no selected KNMI earthquake, ShakeMap/site-response and building-fragility chain, Reitdiep, Drentsche Aa, Eemskanaal, boezem or pluvial event, Haren/Glimmen source-aware fire spread, industrial or cyber source, A7, A28, rail, waterway, bridge or lock state, connected physical lifeline topology, hospital or mutual-aid route or first-72-hour action/resource state. The unrelated North Sea coast-distance amplitude is suppressed; the major-river zero is narrowly scoped and local water pathways remain unresolved, not safe.',
    GM1729:
      'Gulpen-Wittem\'s completed audit found that the common neighbourhood ranking samples no selected transboundary Geul, Gulp, Eyserbeek, Selzerbeek or Mechelderbeek event, local slope, mud or sediment surface, Vijlnerbos source-aware fire spread, Belgian catchment and route continuation, connected drinking-water, sewer or treatment topology, external-care and mutual-aid route, industrial source or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; local and cross-border stream pathways remain unresolved, not safe.',
    GM0392:
      'Haarlem\'s completed audit found that the common neighbourhood ranking samples no authority-selected LIWO or Rijnland coastal, Spaarne, boezem, kade or pluvial event, Haarlemmerhout source-aware fire spread, local rain and drainage-control state, bridge, tunnel, A9, rail or waterway continuity, connected physical lifeline topology, hospital or mutual-aid route, industrial source or first-72-hour action/resource state. Retained coastal proximity is a non-operational diagnostic; the direct major-river zero is narrow and local water pathways remain unresolved, not safe.',
    GM0158:
      'Haaksbergen\'s completed audit found that the common neighbourhood ranking samples no selected local brook, rain, groundwater, sewer or culvert event, Buurserzand source-aware fire spread, Ahaus/Alstätte cross-border response and route state, complete 30-station and 876-pump-unit drainage chain, physical lifeline topology, external-care and rural-supply route, mining or industrial source or first-72-hour action/resource state. False direct Rhine, Meuse, IJssel and North Sea coastal effects are suppressed; local and cross-border pathways remain unresolved, not safe.',
    GM0394:
      'Haarlemmermeer\'s completed audit found that the common neighbourhood ranking samples no authority-selected LIWO defence/breach event, combined ground, sewer and surface-water stress test, Schiphol transient exposure, aviation or industrial source, separate airport water and utility system, tunnel, A4, A5, A9, A44 or rail state, connected physical lifeline topology, care or mutual-aid route or first-72-hour action/resource state. Retained coastal proximity is a non-operational diagnostic; the direct major-river zero is narrow and local pathways remain unresolved, not safe.',
    GM1655:
      'Halderberge\'s completed audit found that the common neighbourhood ranking samples no authority-selected Mark, Dintel or Benedenrivieren hydraulic and defence/control event, high/low-polder and local drainage state, Bosschenhoofd source-aware fire spread, industrial or hazardous-transport source, current rail/crossing validity, connected physical lifeline topology, external acute-care or mutual-aid route or first-72-hour action/resource state. Retained major-river proximity is a non-operational diagnostic; the direct coastal zero is narrow and transition-water, polder and local pathways remain unresolved, not safe.',
    GM0160:
      'Hardenberg\'s completed audit found that the common neighbourhood ranking samples no authority-selected Overijsselse Vecht hydrograph, Noord or Zuid Meene retention, coupure, defence or control event, versioned local rain and complete sewer/drainage chain, Klimberg and Rheezerveen source-aware fire spread, N34, N36, rail, bridge or German-border state, connected physical lifeline topology, Saxenburgh care or mutual-aid route, industrial/mining source or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; Vecht, local-water and indirect network pathways remain unresolved, not safe.',
    GM0243:
      'Harderwijk\'s completed audit found that the common neighbourhood ranking samples no authority-selected Wolderwijd or Veluwemeer Randmeren source-water, lake wind-setup, defence, breach/overtopping, connected footprint, arrival or recession event, versioned local rain/drainage field, Harderwijkerbos source-aware fire spread, industrial/hazardous-material source, Aquaduct Veluwemeer, A28 or rail state, connected physical lifeline topology, St Jansdal or mutual-aid route or first-72-hour action/resource state. Retained major-river proximity is a non-operational diagnostic; direct North Sea coastal zero is narrow and lake, regional-water and local pathways remain unresolved, not safe.',
    GM0523:
      'Hardinxveld-Giessendam\'s completed audit found that the common neighbourhood ranking samples no authority-selected dike-ring 16 or Merwede breach/overtopping, boundary, connected LIWO footprint, arrival, recession or dewatering event, forecast-triggered extra pumps and peil lowering, Kolff, Kinderdijk or future NWA dependency state, local rain/drainage field, ferry, rail or hazardous-goods route state, connected physical lifeline topology, external acute-care or mutual-aid route or first-72-hour action/resource state. Retained major-river proximity is a non-operational diagnostic; direct coastal zero is narrow and Benedenrivieren, backwater, wind-setup and local pathways remain unresolved, not safe.',
    GM0072:
      'Harlingen\'s completed audit found that the common neighbourhood ranking samples no authority-selected Tjerk Hiddessluis collision/failure, Wadden Sea tide, primary-defence breach/overtopping, connected LIWO footprint or arrival event, polder, boezem, discharge, pluvial or sewer state, port and hazardous-material source, Harlingen Haven rail or Terschelling/Vlieland ferry continuity, Waddenpromenade transient exposure, connected physical lifeline topology or first-72-hour action/resource state. Retained coastal proximity is a non-operational diagnostic; direct Rhine, Meuse and IJssel zero is narrow and local, Wadden and managed-water pathways remain unresolved, not safe.',
    GM0396:
      'Heemskerk\'s completed audit found that the common neighbourhood ranking samples no authority-selected North Sea level, D79 dune-defence failure/overtopping and connected LIWO event, separate pluvial, groundwater, sewer or dune-seepage field, Duingebied source-aware fire spread, Tata or Linde release/plume, Jan Lagrand cross-municipal drinking-water dependency, event-valid dune, industrial, A9, A22, N197 or rail access, transient exposure, connected physical lifeline topology or first-72-hour action/resource state. Retained coastal proximity is a non-operational diagnostic; the direct Rhine, Meuse and IJssel zero is narrow and local water, industrial and service pathways remain unresolved, not safe.',
    GM0244:
      'Hattem\'s completed audit found that the common neighbourhood ranking samples no authority-selected IJssel, Hattem breach, Veessen-Wapenveld high-water-channel, Hoenwaard or defence/control event, connected depth, arrival, recession or dewatering field, versioned pluvial, groundwater or sewer state, Hattem5 source-aware fire spread, IJsselbrug and Zuiderzeestraatweg access to Zwolle and Isala, complete water-chain or physical lifeline topology or first-72-hour action/resource state. Retained IJssel proximity is a non-operational diagnostic; direct North Sea coastal zero is narrow and river, polder and local-water pathways remain unresolved, not safe.',
    GM0397:
      'Heemstede\'s completed audit found that the common neighbourhood ranking samples no authority-selected North Sea, Rijnland boezem, Ringvaart, Spaarne, Leidsevaart, regional-kade, polder or pluvial/sewer event, connected depth, arrival, recession or dewatering field, De Glip and Groenendaal source-aware fire spread, N201 west/east and N208 north/south continuity, modal Cruquiusbrug state, complete water/wastewater or physical lifeline topology, external-care route or first-72-hour action/resource state. Retained coastal proximity is a non-operational diagnostic; direct Rhine, Meuse and IJssel zero is narrow and local water and service pathways remain unresolved, not safe.',
    GM0246:
      'Heerde\'s completed audit found that the common neighbourhood ranking samples no authority-selected IJssel, LIWO breach or Veessen-Wapenveld high-water-channel event, 5.65 m+NAP activation, staged inlet flaps, temporary islanding, Gemaal Doornbos shutdown, outlet/free-drainage and restart state, connected depth, arrival, duration, recession or pluvial field, Heerde186 source-aware fire spread, Kerkdijk/inlet, east-side village, ferry or external-care access, complete water-chain or physical lifeline topology or first-72-hour action/resource state. Retained IJssel proximity is a non-operational diagnostic; direct North Sea coastal zero is narrow and channel, polder and local-water pathways remain unresolved, not safe.',
    GM0074:
      'Heerenveen\'s completed audit found that the common neighbourhood ranking samples no authority-selected dike-ring-six mainland sea-defence failure, Boezem Friesland regional-water breach, polder, sewer or pluvial event, connected depth, arrival, duration or recession field, Oranjewoud source-aware fire spread, site-response and fragility, A7/A32, rail, village, hospital or mutual-aid access, connected water-chain or physical lifeline topology or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; direct coastal zero is not a mainland-defence, boezem, polder or local-water all-clear.',
    GM0917:
      'Heerlen\'s completed audit found that the common neighbourhood ranking samples no authority-selected Caumerbeek/Geleenbeek, hillslope, groundwater, sewer or pluvial event, connected depth, arrival, recession or drainage field, Heksenberg source-aware fire spread, selected KNMI earthquake/ground-motion/site/fragility replay, separate mine-water, uplift, subsidence or sinkhole pathway, Parkstad-Aachen multimodal and destination-aware care/supply continuity, connected water-chain or physical lifeline topology or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; direct North Sea coastal zero is narrow and local water, ground and indirect pathways remain unresolved, not safe.',
    GM0399:
      'Heiloo\'s completed audit found that the common neighbourhood ranking samples no authority-selected North Sea/dune, regional-water, Egmondervaart, Hoevervaart, Baafjespolder, groundwater, sewer or pluvial event, connected depth, arrival, recession or drainage field, Gemeentebos source-aware fire spread, A9/N203, rail or crossing state, Willibrordus and external Alkmaar care continuity, connected water/wastewater or physical lifeline topology or first-72-hour action/resource state. Retained coastal proximity is a non-operational diagnostic; direct Rhine, Meuse and IJssel zero is narrow and local water and service pathways remain unresolved, not safe.',
    GM0794:
      'Helmond\'s completed audit found that the common neighbourhood ranking samples no authority-selected Goorloop, Bakelse Aa, Nieuwe Aa, Zuid-Willemsvaart, groundwater, sewer or pluvial event, connected depth, arrival, recession or drainage field, BZOB sewer-pump design exceedance and contaminated-discharge state, Warandebos source-aware fire spread, tunnel/canal/rail/industrial-response access, Elkerliek and transient demand, connected water-chain or physical lifeline topology, industrial-release cascade or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; direct North Sea coastal zero is narrow and local water and service pathways remain unresolved, not safe.',
    GM0163:
      'Hellendoorn\'s completed audit found that the common neighbourhood ranking samples no authority-selected Regge, brook, pluvial, sewer, groundwater or indirect IJssel event, connected depth, arrival, recession or drainage field, Sallandse Heuvelrug source-aware fire spread, N35 west/east and 493 m Salland-Twentetunnel shared road/rail state, care/recreation transient demand, connected two-water-board chain or physical lifeline topology or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; direct North Sea coastal zero is narrow and local water, access and indirect pathways remain unresolved, not safe.',
    GM0531:
      'Hendrik-Ido-Ambacht\'s completed audit found that the common neighbourhood ranking samples no authority-selected dike-ring 17, Noord/benedenrivieren, primary/regional breach, outside-dike, tide, surge or barrier event, connected depth, arrival, recession or dewatering field, governed pluvial/sewer/groundwater state, industrial-release scenario, Noordtunnel/Bridge over the Noord/ADR/Waterbus/rail/external-care continuity, split Oasen/Evides drinking-water and sewer-to-RWZI chain, heat-network or other physical lifeline topology or first-72-hour action/resource state. Retained river eligibility is a non-operational diagnostic; direct open-coast zero is narrow and coupled benedenrivieren and service pathways remain unresolved, not safe.',
    GM0164:
      'Hengelo\'s completed audit found that the common neighbourhood ranking samples no authority-selected brook, Twentekanaal, groundwater, sewer or pluvial event, connected depth, arrival, recession or drainage field, Weusthag Noord source-aware fire spread, Twentekanaal HCH/Nobian/RWZI/heat and industrial-water cascade, physical utility topology, canal/brook/rail crossings, acute transfer to ZGT Almelo or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; direct North Sea coastal zero is narrow and local water, access and indirect service pathways remain unresolved, not safe.',
    GM1966:
      'Het Hogeland\'s completed audit found that the common neighbourhood ranking samples no authority-selected Wadden Sea, Ems-Dollard, primary/regional defence, breach/overtopping, Lauwersmeer, boezem, polder, seepage, pluvial or drainage event, connected depth, arrival, recession or dewatering field, R.J. Clevering discharge windows and sluice/pump state, Zandeweer earthquake or Marnewaard fire source-aware field, Eemshaven workers/passengers/industry/national dependencies, typed rail/ferry/port transfers, regional care access, physical lifeline topology or first-72-hour action/resource state. Retained coastal proximity is a non-operational diagnostic; zero HWH and other contributor matches are coverage gaps, and official zero residents in Eemshaven is not zero transient or critical-service exposure.',
    GM0252:
      'Heumen\'s completed audit found that the common neighbourhood ranking samples no authority-selected Maas/Maas-Waalkanaal hydrograph, four contained LIWO breach candidates, Heumen high-water gate or defence/control event, connected depth, arrival, recession or dewatering field, governed Malden/Overasselt pluvial/groundwater/drainage state, Heumensoord/vennen source-aware fire spread, bridge/gate/local-road and destination/care/shelter access, physical water-chain or utility topology or first-72-hour action/resource state. Retained Maas/canal eligibility is a non-operational diagnostic; direct open-coast zero is narrow and missing T+48/T+72 forecasts, null fields and record no-matches remain Unknown rather than zero or safe.',
    GM0797:
      'Heusden\'s completed audit found that the common neighbourhood ranking samples no authority-selected Maas/Bergsche Maas, Aa/Dommel/Dieze, Drongelens Kanaal, Howabo, Doeveren defence, breach/overtopping or Bovenlandse Sluis control event, connected depth, arrival, recession or dewatering field, governed 70-mm pluvial/sewer/hotspot state, Venne-Oost and Loonse en Drunense Duinen source-aware fire spread, A59/N267/Heusdense bridge and canal/defence crossings, external acute-care/transient demand, physical water-chain or utility topology or first-72-hour action/resource state. Retained flood eligibility is a non-operational diagnostic; direct coastal zero is narrow and missing T+72 Waterinfo coverage remains NoData rather than zero or safe.',
    GM0534:
      'Hillegom\'s completed audit found that the common neighbourhood ranking samples no authority-selected North Sea/defence, Ringvaart, Rijnland boezem, regional-kade, polder, sewer, groundwater or pluvial event, connected depth, arrival, recession or dewatering field, source-aware cross-boundary dune/fire smoke, N206/N208 and Ringvaart bridge/rail/transit state, industrial-release scenario, care/labour-migrant/event transient demand, physical water-chain or utility topology or first-72-hour action/resource state. Retained coastal proximity is a non-operational diagnostic; direct Rhine, Meuse and IJssel zero is narrow and zero matched observations/assets remain Unknown rather than safe or available.',
    GM0402:
      'Hilversum\'s completed audit found that the common neighbourhood ranking samples no authority-selected localized Kerkelanden/Hilversumse Meent external-water event, governed 40/70-mm low-point/pluvial/sewer/storage state, connected depth, arrival, recession or dewatering field, Landelijk Gebied 94 source-aware forest/heath fire spread, named Media Park cyber/power/telecom continuity target and transient crowd state, internal ring/tunnel/viaduct/rail and Tergooi/forest access, physical water/wastewater/power or other lifeline topology or first-72-hour action/resource state. The false municipality-wide Rhine, Meuse and IJssel amplitude is suppressed; coastal zero is narrow and empty public-data matches remain Unknown rather than zero or safe.',
    GM0798:
      'Hilvarenbeek\'s completed audit found that the common neighbourhood ranking samples no authority-selected Reusel/Rosep/Spruitenstroompje, Wilhelminakanaal, regional breach, brook-valley storage, groundwater, sewer or pluvial event, connected depth, arrival, recession or drainage field, local forest/heath ignition and suppression state, time-valid Beekse Bergen festival exposure of roughly 60,000–90,000 visitors, venue/core/Belgian access, external-care and communications continuity, physical water/utility topology or first-72-hour action/resource state. The false direct Rhine, Meuse and IJssel amplitude is suppressed; two regional candidates near Haghorst and all local pathways remain Unknown, while canonical open-coast, remote-fire and earthquake zeros stay narrowly source-scoped.',
    GM1963:
      'Hoeksche Waard\'s completed audit found that the common neighbourhood ranking samples no authority-selected dike sections 21-1/21-2, sea-river forcing, defence/breach/control, compartment or safer-middle event, connected depth, arrival, recession or dewatering field, Tiengemeten source/perimeter and visitor-aware fire spread, Heinenoordtunnel/Haringvlietbrug/Kiltunnel and Tiengemeten pont/boat state, catchment/pump/salinity intervention lifecycle, external-care/transient demand, physical utility topology or first-72-hour action/resource state. Retained river and coastal values are non-operational diagnostics; zero nature/care/observation matches and missing T+72 forecasts remain Unknown/NoData rather than zero or safe.',
    })
  const municipalityGapNote =
    auditedMunicipalityGapNotes[city.code] ?? generatedMunicipalityAuditGuardNotes[city.code]
  const mechanismSpecificNote = auditedUnsupportedSpatialNotes[`${disaster}:${city.code}`]
  const unsupportedSpatialNote =
    mechanismSpecificNote ??
    (municipalityGapNote
      ? `${municipalityGapNote} The ${disaster} municipality result remains Unknown until governed, versioned and event-valid local evidence is selected; public context and missing records do not establish current operation, absence, recovery or a T+72 forecast.`
      : undefined)
  const common = {
    disaster: scenario.disaster,
    components: [disaster],
    rainMmH: 0,
    floodDepthM: 0,
    windGustMs: 0,
    heatC: temperature,
    snowCmH: 0,
    iceSeverity: 0,
    coldStress: 0,
    droughtSeverity: 0,
    wildfireIntensity: 0,
    smokeSeverity: 0,
    groundMotionG: 0,
    cyberDisruption: 0,
    climateTemperatureDeltaC: climate.temperatureDeltaC,
    climatePrecipitationMultiplier: climate.precipitationMultiplier,
    climateSeaLevelDeltaM: climate.seaLevelDeltaM,
    severity: 0,
    peakSeverity: 0,
    spatialEvidence: unsupportedSpatialNote
      ? 'unsupported'
      : disaster === 'river-flood' || disaster === 'coastal-flood'
        ? 'derived-screening'
        : 'synthetic',
    unsupportedDimensions: unsupportedSpatialNote
      ? mechanismSpecificNote
        ? hazardDimensionsByDisaster[disaster]
        : municipalityGuardDimensionsByDisaster[disaster]
      : undefined,
    evidenceNote: unsupportedSpatialNote,
  } satisfies HazardState
  const intensity = scenario.intensity

  // Zero intensity is an explicit no-event counterfactual. Seasonal
  // temperature and climate context remain visible, but event hazard fields
  // and headline severity must not be synthesized from the schedule envelope.
  if (intensity <= 0) return common

  if (disaster === 'severe-storm') {
    const westOffset = clamp((city.coordinates[0] - 3.4) / 4.1) * Math.min(7, scenario.durationHours * 0.32)
    const arrival = scenario.startHour + westOffset
    const event = pulse(
      hour,
      arrival,
      arrival + Math.max(0.25, scenario.durationHours * 0.38),
      arrival + scenario.durationHours,
    )
    const floodTail = smoothEnvelope(
      hour,
      arrival + scenario.durationHours * 0.16,
      Math.min(MAX_HOURS, scenario.durationHours + 18),
    )
    const peakRainMmH = intensity * (42 + local * 34) * climate.precipitationMultiplier
    const rainMmH = event * peakRainMmH
    const windGustMs = event * intensity * (27 + local * 15)
    const floodDepthM =
      clamp((peakRainMmH - 18) / 58) * (0.18 + local * 0.5) * floodTail
    const severity = clamp(
      event * 0.38 + clamp(floodDepthM / 0.65) * 0.36 + clamp((windGustMs - 18) / 22) * 0.26,
    )
    return { ...common, rainMmH, windGustMs, floodDepthM, severity, peakSeverity: severity }
  }

  if (disaster === 'pluvial-flood') {
    const arrival = scenario.startHour + local * 3
    const rainEvent = pulse(
      hour,
      arrival,
      arrival + Math.max(0.25, scenario.durationHours * 0.22),
      arrival + scenario.durationHours * 0.62,
    )
    const waterEnvelope = smoothEnvelope(hour, arrival + 0.5, scenario.durationHours + 22)
    const peakRainMmH = intensity * (72 + local * 58) * climate.precipitationMultiplier
    const rainMmH = rainEvent * peakRainMmH
    const impervious = clamp((city.density ?? 450) / 4_500, 0.08, 0.9)
    const floodDepthM =
      clamp((peakRainMmH - 22) / 100) *
      (0.35 + impervious * 0.75 + local * 0.25) *
      waterEnvelope
    const severity = clamp(clamp(rainMmH / 100) * 0.35 + clamp(floodDepthM / 0.9) * 0.65)
    return { ...common, rainMmH, floodDepthM, severity, peakSeverity: severity }
  }

  if (disaster === 'river-flood') {
    const exposure = riverExposure(city)
    const envelope = smoothEnvelope(hour, scenario.startHour, scenario.durationHours)
    const floodDepthM = clamp(4.5 * intensity * exposure * envelope * (0.86 + local * 0.28), 0, 5)
    const severity = clamp((floodDepthM / 3.2) * 0.9 + envelope * exposure * 0.1)
    return { ...common, floodDepthM, severity, peakSeverity: severity }
  }

  if (disaster === 'coastal-flood') {
    const exposure = coastalExposure(city)
    const envelope = smoothEnvelope(hour, scenario.startHour, scenario.durationHours)
    const surgeScale = 1 + climate.seaLevelDeltaM / 2
    const floodDepthM = clamp(3.4 * intensity * exposure * envelope * surgeScale, 0, 5)
    const windGustMs = envelope * intensity * (31 + local * 14) * (0.65 + exposure * 0.35)
    // Use the same wind activation threshold as direct service pressure. This
    // prevents a coastal wind tail from damaging services while the hazard
    // headline and explanation incorrectly report zero active forcing.
    const severity = clamp(clamp(floodDepthM / 2.7) * 0.7 + clamp((windGustMs - 15) / 25) * 0.3)
    return { ...common, floodDepthM, windGustMs, severity, peakSeverity: severity }
  }

  if (disaster === 'heatwave') {
    const envelope = smoothEnvelope(hour, scenario.startHour, scenario.durationHours)
    const heatC = temperature + envelope * intensity * (11 + local * 5)
    const droughtSeverity = clamp(envelope * intensity * (0.48 + local * 0.32))
    const severity = clamp(clamp((heatC - 27) / 12) * 0.82 + droughtSeverity * 0.18)
    return { ...common, heatC, droughtSeverity, severity, peakSeverity: severity }
  }

  if (disaster === 'winter-storm') {
    const arrival = scenario.startHour + local * 2
    const envelope = smoothEnvelope(hour, arrival, scenario.durationHours)
    const heatC = temperature - envelope * intensity * (8 + local * 6)
    const windGustMs = envelope * intensity * (20 + local * 15)
    const snowCmH = envelope * intensity * (2.5 + local * 3.5)
    const iceSeverity = clamp(envelope * intensity * (0.45 + local * 0.55))
    const coldStress =
      envelope * clamp((2 - heatC) / 16) * (0.7 + clamp(windGustMs / 30) * 0.3)
    const severity = clamp(
      coldStress * 0.42 + clamp(snowCmH / 4) * 0.3 + iceSeverity * 0.2 + clamp(windGustMs / 35) * 0.08,
    )
    return {
      ...common,
      heatC,
      windGustMs,
      snowCmH,
      iceSeverity,
      coldStress,
      severity,
      peakSeverity: severity,
    }
  }

  if (disaster === 'cyberattack') {
    const elapsed = hour - scenario.startHour
    const attackGrowth = recoveryCurve(
      hour,
      scenario.startHour,
      scenario.startHour + Math.min(7, scenario.durationHours * 0.25),
    )
    const attackActive =
      elapsed < 0 ? 0 : elapsed <= scenario.durationHours ? attackGrowth : 1
    const responseStart = scenario.startHour + scenario.responseDelayHours
    const response = recoveryCurve(
      hour,
      responseStart,
      responseStart +
        (20 + (1 - scenario.preparedness) * 30) /
          (scenario.repairCapacityMultiplier ?? 1),
    )
    const explicitTargets = scenario.targetMunicipalityIds
    const targetWeight = explicitTargets?.length
      ? explicitTargets.includes(city.code)
        ? 1
        : elapsed > 5
          ? 0.12 + local * 0.08
          : 0
      : 0.68 + local * 0.32
    const cyberDisruption = clamp(
      intensity * targetWeight * attackActive * (1 - scenario.preparedness * 0.38) * (1 - response * 0.9),
    )
    return { ...common, cyberDisruption, severity: cyberDisruption, peakSeverity: cyberDisruption }
  }

  if (disaster === 'earthquake') {
    const epicenter = scenario.epicenter ?? ([6.78, 53.2] as const)
    const distance = distanceKm(city.coordinates, epicenter)
    const exposure = Math.exp(-distance / 42)
    const event = pulse(
      hour,
      scenario.startHour,
      scenario.startHour + Math.min(0.25, scenario.durationHours * 0.35),
      scenario.startHour + scenario.durationHours,
    )
    const groundMotionG = clamp(0.42 * intensity * exposure * event * (0.88 + local * 0.24), 0, 0.5)
    const severity = clamp(groundMotionG / 0.32)
    return { ...common, groundMotionG, severity, peakSeverity: severity }
  }

  const fireCenters = scenario.epicenter
    ? [scenario.epicenter]
    : [
        [5.82, 52.17],
        [5.93, 51.35],
        [6.62, 52.9],
      ] satisfies Coordinates[]
  const fireDistanceKm = nearestDistance(city, fireCenters)
  const elapsedFireHours = Math.max(0, hour - scenario.startHour)
  // Direct flame is confined to a finite, time-growing scenario footprint.
  // This is deliberately conservative and remains a planning proxy until
  // land-cover, fuels, wind and fire-spread inputs are available. Transported
  // smoke retains its separate wider screening field.
  const directFireRadiusKm = Math.min(18, 2 + elapsedFireHours * 0.9)
  const fireExposure = fireDistanceKm <= directFireRadiusKm
    ? Math.exp(-fireDistanceKm / 9)
    : 0
  // The Arnhem audit demonstrated an exact polygon/centroid false negative:
  // the T+24 circle intersects official GM0202 geometry at 15.828 km while
  // the retained municipality point is 23.151 km away. Until land-cover and
  // polygon intersection are part of the national adapter, preserve this as
  // unknown direct flame instead of converting it to a defensible zero.
  const arnhemBoundaryDistanceKm = city.code === 'GM0202' ? 15.827549821368576 : null
  const unresolvedDirectFire =
    fireExposure === 0 &&
    arnhemBoundaryDistanceKm !== null &&
    directFireRadiusKm >= arnhemBoundaryDistanceKm
  const smokeExposure = nearestExposure(city, scenario.epicenter ? [scenario.epicenter] : [[5.82, 52.17]], 125)
  const envelope = smoothEnvelope(hour, scenario.startHour, scenario.durationHours)
  const heatC = temperature + envelope * intensity * (6 + local * 3)
  const droughtSeverity = clamp(envelope * intensity * (0.62 + local * 0.34))
  const wildfireIntensity = clamp(envelope * intensity * fireExposure * (0.82 + local * 0.36))
  const smokeSeverity = clamp(envelope * intensity * smokeExposure * (0.55 + local * 0.3))
  const severity = clamp(wildfireIntensity * 0.68 + smokeSeverity * 0.2 + droughtSeverity * 0.12)
  return {
    ...common,
    heatC,
    droughtSeverity,
    wildfireIntensity,
    smokeSeverity,
    severity,
    peakSeverity: severity,
    unsupportedDimensions: unresolvedDirectFire ? ['fire'] : common.unsupportedDimensions,
    evidenceNote: unresolvedDirectFire
      ? 'The synthetic fire footprint intersects official Arnhem geometry while missing its municipality point. Direct flame is spatially unresolved, not zero; smoke and drought remain separate modeled dimensions until polygon and combustible-land-cover inputs are integrated.'
      : common.evidenceNote,
  }
}

function hazardForMunicipality(
  city: MunicipalityDefinition,
  hour: number,
  scenario: ScenarioConfig,
): HazardState {
  const components = scenario.disaster === 'compound' ? scenario.components ?? [] : [scenario.disaster]
  const hazards = components.map((disaster) =>
    baseHazard(city, hour, { ...scenario, disaster, components: undefined }, disaster),
  )
  if (hazards.length === 1) return { ...hazards[0], disaster: scenario.disaster, components }
  const climate = climateModifiers(scenario)
  const baselineTemperature = seasonalTemperature(
    city,
    hour,
    scenario.season,
    climate.temperatureDeltaC,
  )
  const heatC = hazards.reduce((selected, hazard) =>
    Math.abs(hazard.heatC - baselineTemperature) > Math.abs(selected - baselineTemperature)
      ? hazard.heatC
      : selected,
  baselineTemperature)
  const severity = clamp(1 - hazards.reduce((remaining, hazard) => remaining * (1 - hazard.severity), 1))
  return {
    disaster: scenario.disaster,
    components,
    rainMmH: Math.max(...hazards.map((hazard) => hazard.rainMmH)),
    floodDepthM: Math.max(...hazards.map((hazard) => hazard.floodDepthM)),
    windGustMs: Math.max(...hazards.map((hazard) => hazard.windGustMs)),
    heatC,
    snowCmH: Math.max(...hazards.map((hazard) => hazard.snowCmH)),
    iceSeverity: Math.max(...hazards.map((hazard) => hazard.iceSeverity)),
    coldStress: Math.max(...hazards.map((hazard) => hazard.coldStress)),
    droughtSeverity: Math.max(...hazards.map((hazard) => hazard.droughtSeverity)),
    wildfireIntensity: Math.max(...hazards.map((hazard) => hazard.wildfireIntensity)),
    smokeSeverity: Math.max(...hazards.map((hazard) => hazard.smokeSeverity)),
    groundMotionG: Math.max(...hazards.map((hazard) => hazard.groundMotionG)),
    cyberDisruption: Math.max(...hazards.map((hazard) => hazard.cyberDisruption)),
    climateTemperatureDeltaC: climate.temperatureDeltaC,
    climatePrecipitationMultiplier: climate.precipitationMultiplier,
    climateSeaLevelDeltaM: climate.seaLevelDeltaM,
    severity,
    peakSeverity: severity,
    spatialEvidence: hazards.some((hazard) => hazard.spatialEvidence === 'unsupported')
      ? 'unsupported'
      : 'synthetic',
    evidenceNote: hazards.find((hazard) => hazard.evidenceNote)?.evidenceNote,
    unsupportedDimensions: [...new Set(hazards.flatMap((hazard) => hazard.unsupportedDimensions ?? []))],
  }
}

const serviceHazardWeights: Record<ServiceId, Partial<Record<HazardDimension, number>>> = {
  power: { flood: 0.78, wind: 0.82, heat: 0.25, cold: 0.2, snowIce: 0.32, fire: 0.58, groundMotion: 0.82, cyber: 0.88 },
  water: { rain: 0.15, flood: 0.58, heat: 0.18, drought: 0.76, fire: 0.22, groundMotion: 0.72, cyber: 0.7 },
  drainage: { rain: 0.42, flood: 0.9, snowIce: 0.2, groundMotion: 0.58, cyber: 0.68 },
  gas: { flood: 0.28, cold: 0.14, fire: 0.48, groundMotion: 0.9, cyber: 0.58 },
  telecom: { flood: 0.45, wind: 0.52, heat: 0.2, fire: 0.48, smoke: 0.12, groundMotion: 0.64, cyber: 1 },
  mobility: { rain: 0.22, flood: 0.96, wind: 0.52, snowIce: 0.94, fire: 0.84, smoke: 0.42, groundMotion: 0.88, cyber: 0.24 },
  facilities: { flood: 0.62, heat: 0.56, cold: 0.52, snowIce: 0.22, fire: 0.58, smoke: 0.4, groundMotion: 0.78, cyber: 0.68 },
  supply: { rain: 0.12, flood: 0.5, wind: 0.34, heat: 0.18, cold: 0.25, snowIce: 0.7, fire: 0.58, smoke: 0.2, groundMotion: 0.62, cyber: 0.42 },
}

function normalizedHazardDimensions(
  hazard: HazardState,
  retainUnsupportedDiagnostics = false,
): Record<HazardDimension, number> {
  const unsupported = retainUnsupportedDiagnostics
    ? new Set<HazardDimension>()
    : new Set(hazard.unsupportedDimensions ?? [])
  const supportedValue = (dimension: HazardDimension, value: number) =>
    unsupported.has(dimension) ? 0 : value
  return {
    rain: supportedValue('rain', clamp(hazard.rainMmH / 95)),
    flood: supportedValue('flood', clamp(hazard.floodDepthM / 1.5)),
    wind: supportedValue('wind', clamp((hazard.windGustMs - 15) / 25)),
    heat: supportedValue('heat', clamp((hazard.heatC - 28) / 12)),
    cold: supportedValue('cold', hazard.coldStress),
    snowIce: supportedValue(
      'snowIce',
      clamp(hazard.snowCmH / 4) * 0.55 + hazard.iceSeverity * 0.45,
    ),
    drought: supportedValue('drought', hazard.droughtSeverity),
    fire: supportedValue('fire', hazard.wildfireIntensity),
    smoke: supportedValue('smoke', hazard.smokeSeverity),
    groundMotion: supportedValue('groundMotion', clamp(hazard.groundMotionG / 0.32)),
    cyber: supportedValue('cyber', hazard.cyberDisruption),
  }
}

function supportedHazardValue(
  hazard: HazardState,
  dimension: HazardDimension,
  value: number,
): number {
  return hazard.unsupportedDimensions?.includes(dimension) ? 0 : value
}

const hazardCause: Record<HazardDimension, string> = {
  rain: 'Extreme rainfall overloads exposed local assets',
  flood: 'Inundation constrains exposed assets and access',
  wind: 'Severe wind damages exposed above-ground assets',
  heat: 'Sustained heat reduces capacity and increases cooling load',
  cold: 'Cold stress and heating demand constrain capacity',
  snowIce: 'Snow and ice reduce access and outdoor operations',
  drought: 'Drought constrains available water and environmental capacity',
  fire: 'Wildfire exposure damages assets and blocks access',
  smoke: 'Smoke reduces safe operating and travel capacity',
  groundMotion: 'Ground motion damages local assets and connections',
  cyber: 'Digital control and information systems are disrupted',
}

const hazardDimensionLabels: Record<HazardDimension, string> = {
  rain: 'Extreme rainfall',
  flood: 'Inundation stress',
  wind: 'Wind gusts',
  heat: 'Heat stress',
  cold: 'Cold stress',
  snowIce: 'Snow and ice',
  drought: 'Drought',
  fire: 'Wildfire',
  smoke: 'Smoke',
  groundMotion: 'Ground motion',
  cyber: 'Cyber disruption',
}

function hazardDimensionValue(
  hazard: HazardState,
  dimension: HazardDimension,
): { value: number; unit: string } {
  switch (dimension) {
    case 'rain':
      return { value: hazard.rainMmH, unit: 'mm/h' }
    case 'flood':
      return { value: clamp(hazard.floodDepthM / 1.5), unit: 'stress fraction' }
    case 'wind':
      return { value: hazard.windGustMs, unit: 'm/s' }
    case 'heat':
      return { value: hazard.heatC, unit: '°C' }
    case 'cold':
      return { value: hazard.coldStress, unit: 'index' }
    case 'snowIce':
      return {
        value: clamp(hazard.snowCmH / 4) * 0.55 + hazard.iceSeverity * 0.45,
        unit: 'combined index',
      }
    case 'drought':
      return { value: hazard.droughtSeverity, unit: 'index' }
    case 'fire':
      return { value: hazard.wildfireIntensity, unit: 'index' }
    case 'smoke':
      return { value: hazard.smokeSeverity, unit: 'index' }
    case 'groundMotion':
      return { value: hazard.groundMotionG, unit: 'g' }
    case 'cyber':
      return { value: hazard.cyberDisruption, unit: 'index' }
  }
}

function buildHazardExplanation(
  city: MunicipalityDefinition,
  hour: number,
  scenario: ScenarioConfig,
  hazard: HazardState,
): ExplainedHazardState['explanation'] {
  const noEventScenario = { ...scenario, intensity: 0 }
  const noEvent = hazardForMunicipality(city, hour, noEventScenario)
  const referenceClimate = hazardForMunicipality(city, hour, {
    ...scenario,
    climate: { path: 'reference', horizon: 'current' },
  })
  const prepared = hazardForMunicipality(city, hour, {
    ...scenario,
    preparedness: 1,
    responseDelayHours: 0,
  })
  // Explanations retain the internal diagnostic dimensions so their additive
  // ledger still closes against the displayed diagnostic severity. Direct
  // service pressure uses the default evidence-gated normalization below.
  const normalized = normalizedHazardDimensions(hazard, true)
  const baselineNormalized = normalizedHazardDimensions(noEvent, true)
  const scores = Object.fromEntries(
    (Object.keys(normalized) as HazardDimension[]).map((dimension) => [
      dimension,
      Math.max(0, normalized[dimension] - baselineNormalized[dimension]),
    ]),
  ) as Record<HazardDimension, number>
  const scoreTotal = Object.values(scores).reduce((sum, score) => sum + score, 0)
  const eventSeverity = hazard.severity - noEvent.severity
  const dimensionContributions = (Object.keys(normalized) as HazardDimension[]).map(
    (dimension): CauseContribution => {
      const raw = hazardDimensionValue(hazard, dimension)
      const effect = scoreTotal > 1e-12 ? eventSeverity * (scores[dimension] / scoreTotal) : 0
      return {
        id: `hazard:${dimension}`,
        kind: 'hazard',
        label: hazardDimensionLabels[dimension],
        target: 'hazard-severity',
        value: raw.value,
        unit: raw.unit,
        normalizedValue: normalized[dimension],
        effect,
        effectUnit: 'severity fraction',
        direction: effectDirection(effect),
        method: 'proportional-attribution',
        confidence: 'scenario',
        driverId: `hazard.${dimension}`,
        description:
          scores[dimension] > 0
            ? `${hazardCause[dimension]}; the displayed share is a transparent proportional attribution of the modeled severity increment.`
            : 'This dimension adds no event-related severity at the selected time.',
      }
    },
  )
  const contributions: CauseContribution[] = [
    {
      id: 'hazard:seasonal-baseline',
      kind: 'baseline',
      label: 'Seasonal background conditions',
      target: 'hazard-severity',
      value: noEvent.severity,
      unit: 'severity fraction',
      normalizedValue: noEvent.severity,
      effect: noEvent.severity,
      effectUnit: 'severity fraction',
      direction: effectDirection(noEvent.severity),
      method: 'exact-stage-delta',
      confidence: 'scenario',
      driverId: 'scenario.season',
      description: 'Modeled severity that remains when event intensity is set to zero.',
    },
    ...dimensionContributions,
  ]
  const dominant = dimensionContributions.reduce<CauseContribution | null>(
    (selected, contribution) =>
      !selected || Math.abs(contribution.effect) > Math.abs(selected.effect)
        ? contribution
        : selected,
    null,
  )
  const dominantDimension =
    dominant && Math.abs(dominant.effect) > 1e-12
      ? (dominant.id.replace('hazard:', '') as HazardDimension)
      : null
  const climate = climateModifiers(scenario)
  const drivers: DriverMetadata[] = [
    {
      id: 'scenario.intensity',
      label: 'Event intensity',
      value: scenario.intensity,
      unit: 'fraction',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'intensity',
      description: 'Scales the initiating hazard forcing.',
    },
    {
      id: 'scenario.durationHours',
      label: 'Event duration',
      value: scenario.durationHours,
      unit: 'hours',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'durationHours',
      description: 'Controls how long the initiating forcing remains active.',
    },
    {
      id: 'scenario.startHour',
      label: 'Event start',
      value: scenario.startHour,
      unit: 'T+ hours',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'startHour',
      description: 'Places the initiating event on the 72-hour clock.',
    },
    {
      id: 'scenario.preparedness',
      label: 'Preparedness',
      value: scenario.preparedness,
      unit: 'fraction',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'preparedness',
      description: 'Reduces cyber compromise and later service damage in the model.',
    },
    {
      id: 'scenario.responseDelayHours',
      label: 'Response delay',
      value: scenario.responseDelayHours,
      unit: 'hours',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'responseDelayHours',
      description: 'Delays cyber containment and service restoration.',
    },
    {
      id: 'scenario.repairCapacityMultiplier',
      label: 'Response and repair capacity',
      value: scenario.repairCapacityMultiplier ?? 1,
      unit: '×',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'repairCapacityMultiplier',
      description: 'Accelerates cyber containment and downstream service restoration.',
    },
    {
      id: 'scenario.season',
      label: 'Season',
      value: scenario.season,
      unit: '',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'season',
      description: 'Sets the seasonal temperature background and service demand profile.',
    },
    {
      id: 'climate.path',
      label: 'KNMI climate path',
      value: scenario.climate.path,
      unit: '',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'climate.path',
      description: 'Selects the transparent climate-sensitivity transform.',
    },
    {
      id: 'climate.horizon',
      label: 'Climate horizon',
      value: scenario.climate.horizon,
      unit: 'year',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'climate.horizon',
      description: 'Scales the selected climate path between current conditions and its horizon.',
    },
    {
      id: 'climate.temperatureDeltaC',
      label: 'Applied temperature delta',
      value: climate.temperatureDeltaC,
      unit: '°C',
      role: 'derived-state',
      source: 'derived-model-state',
      editable: false,
      description: 'Resolved temperature delta after path, horizon, and overrides.',
    },
    {
      id: 'climate.precipitationMultiplier',
      label: 'Applied precipitation multiplier',
      value: climate.precipitationMultiplier,
      unit: '×',
      role: 'derived-state',
      source: 'derived-model-state',
      editable: false,
      description: 'Resolved extreme-precipitation multiplier.',
    },
    {
      id: 'climate.seaLevelDeltaM',
      label: 'Applied sea-level delta',
      value: climate.seaLevelDeltaM,
      unit: 'm',
      role: 'derived-state',
      source: 'derived-model-state',
      editable: false,
      description: 'Resolved sea-level delta used by coastal flooding.',
    },
  ]
  if (city.density !== null && Number.isFinite(city.density)) {
    drivers.push({
      id: 'municipality.populationDensity',
      label: 'Population density',
      value: city.density,
      unit: 'people/km²',
      role: 'observed-context',
      source: 'municipality-input',
      editable: false,
      description: 'Municipal context used as an urbanization proxy in selected hazard functions.',
    })
  }
  const counterfactuals: CounterfactualResult[] = [
    {
      id: 'hazard:no-event',
      label: 'No initiating event',
      question: 'What would severity be if event intensity were zero?',
      observedValue: hazard.severity,
      counterfactualValue: noEvent.severity,
      delta: noEvent.severity - hazard.severity,
      unit: 'severity fraction',
      changedDriverIds: ['scenario.intensity'],
      method: 'exact-model-rerun',
      confidence: 'scenario',
    },
    {
      id: 'hazard:reference-climate',
      label: 'Reference climate',
      question: 'What would severity be under the 1991–2020 reference transform?',
      observedValue: hazard.severity,
      counterfactualValue: referenceClimate.severity,
      delta: referenceClimate.severity - hazard.severity,
      unit: 'severity fraction',
      changedDriverIds: ['climate.path', 'climate.horizon'],
      method: 'exact-model-rerun',
      confidence: 'scenario',
    },
    {
      id: 'hazard:maximum-preparedness',
      label: 'Immediate, maximum preparedness',
      question: 'What would severity be with maximum preparedness and no response delay?',
      observedValue: hazard.severity,
      counterfactualValue: prepared.severity,
      delta: prepared.severity - hazard.severity,
      unit: 'severity fraction',
      changedDriverIds: ['scenario.preparedness', 'scenario.responseDelayHours'],
      method: 'exact-model-rerun',
      confidence: 'scenario',
    },
  ]
  return {
    summary:
      hazard.spatialEvidence === 'unsupported'
        ? `${hazard.evidenceNote ?? 'Local hazard forcing is unsupported by the currently loaded spatial evidence.'}${
            dominantDimension === null
              ? ' No event-related hazard forcing is active at this municipality and time; previously accumulated service damage may still be recovering.'
              : hazard.unsupportedDimensions?.includes(dominantDimension)
                ? ''
                : ` Other displayed dimensions remain modeled. ${hazardDimensionLabels[dominantDimension]} is the largest modeled contributor to current hazard severity.`
          }`
        : hazard.unsupportedDimensions?.length
          ? `${hazard.evidenceNote ?? 'Part of the local hazard forcing is spatially unresolved'} Other displayed dimensions remain modeled.`
        : dominantDimension === null
        ? 'No event-related hazard forcing is active at this municipality and time; previously accumulated service damage may still be recovering.'
        : `${hazardDimensionLabels[dominantDimension]} is the largest modeled contributor to current hazard severity.`,
    dominantDimension,
    contributions,
    drivers,
    counterfactuals,
    attributionNote:
      hazard.spatialEvidence === 'unsupported'
        ? 'The numerical scenario field is retained only for transparent deterministic internals and must not be read as a local prediction or an all-clear. The direct pathway and every downstream impact remain incomplete until reviewed spatial evidence is ingested.'
        : hazard.unsupportedDimensions?.length
          ? `Dimensions marked unresolved (${hazard.unsupportedDimensions.join(', ')}) are numerically neutral in the current engine and must not be interpreted as absent. Other counterfactuals remain deterministic model reruns.`
          : 'The no-event and scenario counterfactuals are exact deterministic reruns. Dimension shares proportionally allocate the modeled severity increment for explanation; they are not empirical causal estimates.',
  }
}

function hazardPressureForService(hazard: HazardState, service: ServiceId) {
  const dimensions = normalizedHazardDimensions(hazard)
  const weighted = Object.entries(serviceHazardWeights[service]).map(([dimension, weight]) => ({
    dimension: dimension as HazardDimension,
    loss: clamp(dimensions[dimension as HazardDimension] * (weight ?? 0)),
  }))
  const pressure = clamp(1 - weighted.reduce((remaining, item) => remaining * (1 - item.loss), 1))
  const dominant = weighted.reduce(
    (highest, item) => (item.loss > highest.loss ? item : highest),
    { dimension: 'rain' as HazardDimension, loss: 0 },
  )
  return {
    pressure,
    weighted,
    dominantDimension: dominant.dimension,
    cause: dominant.loss > 0.02 ? hazardCause[dominant.dimension] : 'No material direct hazard exposure',
  }
}

function seasonalDemandMultiplier(
  service: ServiceId,
  season: Season,
  temperatureC: number,
): number {
  const baseBySeason: Record<ServiceId, Record<Season, number>> = {
    power: { winter: 1.16, spring: 0.92, summer: 1, autumn: 0.96 },
    water: { winter: 0.9, spring: 0.98, summer: 1.18, autumn: 0.95 },
    drainage: { winter: 1.12, spring: 1, summer: 0.92, autumn: 1.08 },
    gas: { winter: 1.7, spring: 0.85, summer: 0.38, autumn: 1.05 },
    telecom: { winter: 1, spring: 0.98, summer: 0.98, autumn: 1 },
    mobility: { winter: 0.96, spring: 1.02, summer: 1.05, autumn: 1 },
    facilities: { winter: 1.08, spring: 0.96, summer: 1.05, autumn: 1 },
    supply: { winter: 1.04, spring: 0.98, summer: 1.04, autumn: 1 },
  }
  const heatingDegree = Math.max(0, 18 - temperatureC)
  const coolingDegree = Math.max(0, temperatureC - 22)
  const weatherFactor =
    service === 'power'
      ? 1 + heatingDegree * 0.012 + coolingDegree * 0.024
      : service === 'gas'
        ? 1 + heatingDegree * 0.045
        : service === 'water'
          ? 1 + Math.max(0, temperatureC - 25) * 0.018
          : service === 'facilities'
            ? 1 + heatingDegree * 0.008 + coolingDegree * 0.014
            : 1
  return baseBySeason[service][season] * weatherFactor
}

function dayTypeDemandMultiplier(
  service: ServiceId,
  dayType: NonNullable<ScenarioConfig['dayType']>,
): number {
  if (dayType === 'weekday') return 1
  const weekend: Record<ServiceId, number> = {
    power: 1.01,
    water: 1.03,
    drainage: 1,
    gas: 1.02,
    telecom: 1.02,
    mobility: 0.86,
    facilities: 0.96,
    supply: 1.03,
  }
  const holiday: Record<ServiceId, number> = {
    power: 1.03,
    water: 1.05,
    drainage: 1,
    gas: 1.04,
    telecom: 1.04,
    mobility: 0.78,
    facilities: 0.9,
    supply: 1.08,
  }
  return dayType === 'weekend' ? weekend[service] : holiday[service]
}

function earliestSafeRepairHour(scenario: ScenarioConfig): number {
  const floodForcing =
    scenario.disaster === 'river-flood' ||
    scenario.disaster === 'coastal-flood' ||
    (scenario.disaster === 'compound' &&
      (scenario.components?.includes('river-flood') || scenario.components?.includes('coastal-flood')))
  // Generic restoration must not rebuild most flood damage while the same
  // sustained inundation is still at its modeled peak. Other hazards retain
  // the earlier response-window assumption until sector calibration exists.
  const delay = floodForcing
    ? scenario.durationHours * 0.9
    : Math.min(18, scenario.durationHours * 0.58)
  return scenario.startHour + delay
}

// Standing-water amplitude above this shallow-access screening threshold pauses
// generic restoration. It is an operational guard, not a surveyed water depth
// or a statement that every asset below the threshold is safe.
const REPAIR_BLOCKING_FLOOD_DEPTH_M = 0.05

function createDirectService(
  city: MunicipalityDefinition,
  service: ServiceId,
  hour: number,
  hazard: HazardState,
  currentHazard: HazardState,
  scenario: ScenarioConfig,
  powerAvailability = 1,
  mobilityAvailability = 1,
  intervention: SimulationOptions['intervention'] = 'baseline',
  demandTemperatureC = hazard.heatC,
  includeExplanation = true,
): ExplainedServiceState {
  const elapsedSinceStart = Math.max(0, hour - scenario.startHour)
  const variability = seededUnit(city.seed ^ scenario.seed, hashString(service) % 997)
  const baselineResilience = clamp(0.92 + variability * 0.075 + scenario.preparedness * 0.018)
  const hazardPressure = hazardPressureForService(hazard, service)
  const directLoss =
    hazardPressure.pressure *
    (0.72 + variability * 0.42) *
    (1 - scenario.preparedness * 0.42)
  const earliestSafeRepair = earliestSafeRepairHour(scenario)
  const repairStart = Math.max(
    scenario.startHour + scenario.responseDelayHours,
    earliestSafeRepair,
  ) + variability * 7
  const repairCapacityMultiplier = scenario.repairCapacityMultiplier ?? 1
  const repairEnd =
    repairStart +
    (24 + (1 - scenario.preparedness) * 42 + variability * 20) /
      repairCapacityMultiplier
  const repairAccessFloodDepth = supportedHazardValue(
    currentHazard,
    'flood',
    currentHazard.floodDepthM,
  )
  const repairAccessBlocked = repairAccessFloodDepth > REPAIR_BLOCKING_FLOOD_DEPTH_M
  const recovery = repairAccessBlocked ? 0 : recoveryCurve(hour, repairStart, repairEnd)
  const availabilityAtPeakDamage = clamp(baselineResilience - directLoss)
  const availabilityAfterRecovery = clamp(baselineResilience - directLoss * (1 - recovery))
  const backupMultiplier = scenario.backupMultiplier ?? 1
  const dependencyRules: Array<{
    upstreamService: ServiceId
    upstreamAvailability: number
    multiplier: number
    fullUpstreamMultiplier: number
    backupActive: boolean
    backupWindowHours?: number
    backupRemainingHours?: number
    description: string
  }> = []
  if (service === 'water') {
    const backupWindow = (4 + variability * 9 + scenario.preparedness * 9) * backupMultiplier
    const backupActive = elapsedSinceStart <= backupWindow
    dependencyRules.push({
      upstreamService: 'power',
      upstreamAvailability: powerAvailability,
      multiplier: backupActive ? 1 : 0.55 + powerAvailability * 0.45,
      fullUpstreamMultiplier: 1,
      backupActive,
      backupWindowHours: backupWindow,
      backupRemainingHours: Math.max(0, backupWindow - elapsedSinceStart),
      description: backupActive
        ? 'Pumping is inside its modeled backup-power window.'
        : 'Pumping capacity depends on upstream electricity after backup endurance is exhausted.',
    })
  }
  if (service === 'drainage') {
    dependencyRules.push({
      upstreamService: 'power',
      upstreamAvailability: powerAvailability,
      multiplier: 0.48 + powerAvailability * 0.52,
      fullUpstreamMultiplier: 1,
      backupActive: false,
      description: 'Pumps and controls depend continuously on upstream electricity.',
    })
  }
  if (service === 'telecom') {
    const batteryWindow =
      (2 + variability * 7 + scenario.preparedness * 12) * backupMultiplier
    const backupActive = elapsedSinceStart <= batteryWindow
    dependencyRules.push({
      upstreamService: 'power',
      upstreamAvailability: powerAvailability,
      multiplier: backupActive ? 1 : 0.32 + powerAvailability * 0.68,
      fullUpstreamMultiplier: 1,
      backupActive,
      backupWindowHours: batteryWindow,
      backupRemainingHours: Math.max(0, batteryWindow - elapsedSinceStart),
      description: backupActive
        ? 'Telecom sites are inside their modeled battery window.'
        : 'Telecom site availability depends on upstream power after batteries deplete.',
    })
  }
  if (service === 'gas') {
    dependencyRules.push({
      upstreamService: 'power',
      upstreamAvailability: powerAvailability,
      multiplier: 0.77 + powerAvailability * 0.23,
      fullUpstreamMultiplier: 1,
      backupActive: false,
      description: 'Gas regulation and control retain partial passive capacity but depend on power.',
    })
  }
  if (service === 'facilities') {
    const backupWindow =
      (6 + variability * 15 + scenario.preparedness * 18) * backupMultiplier
    const backupActive = elapsedSinceStart <= backupWindow
    dependencyRules.push({
      upstreamService: 'power',
      upstreamAvailability: powerAvailability,
      multiplier: backupActive ? 0.97 : 0.35 + powerAvailability * 0.65,
      fullUpstreamMultiplier: backupActive ? 0.97 : 1,
      backupActive,
      backupWindowHours: backupWindow,
      backupRemainingHours: Math.max(0, backupWindow - elapsedSinceStart),
      description: backupActive
        ? 'Critical facilities remain on backup generation with a small operating penalty.'
        : 'Critical-facility operation depends on upstream power after generator endurance.',
    })
  }
  if (service === 'supply') {
    dependencyRules.push({
      upstreamService: 'mobility',
      upstreamAvailability: mobilityAvailability,
      multiplier: 0.35 + mobilityAvailability * 0.65,
      fullUpstreamMultiplier: 1,
      backupActive: false,
      description: 'Emergency supply delivery depends on usable transport access.',
    })
  }

  const applyDependencies = (
    startingAvailability: number,
    useFullUpstream = false,
  ): { availability: number; effects: ServiceDependencyEffect[] } => {
    let availability = startingAvailability
    const effects = dependencyRules.map((rule): ServiceDependencyEffect => {
      const before = availability
      const multiplier = useFullUpstream ? rule.fullUpstreamMultiplier : rule.multiplier
      availability = clamp(availability * multiplier)
      return {
        upstreamService: rule.upstreamService,
        upstreamAvailability: useFullUpstream ? 1 : rule.upstreamAvailability,
        multiplier,
        availabilityBefore: before,
        availabilityAfter: availability,
        effect: availability - before,
        backupActive: rule.backupActive,
        backupWindowHours: rule.backupWindowHours,
        backupRemainingHours: rule.backupRemainingHours,
        description: rule.description,
      }
    })
    return { availability, effects }
  }

  const dependencyResult = applyDependencies(availabilityAfterRecovery)
  let availability = dependencyResult.availability
  const availabilityWithoutIntervention = availability
  let interventionBoost = 0
  let interventionEffect = 0
  const generatorDispatchStart =
    scenario.startHour + scenario.responseDelayHours + 1
  const mutualAidDispatchStart =
    scenario.startHour + scenario.responseDelayHours + 10

  if (intervention === 'generator-priority' && ['water', 'telecom', 'facilities'].includes(service)) {
    const before = availability
    interventionBoost =
      recoveryCurve(hour, generatorDispatchStart, generatorDispatchStart + 5) * 0.12
    availability = clamp(availability + interventionBoost)
    interventionEffect = availability - before
  }
  if (intervention === 'mutual-aid' && ['mobility', 'supply'].includes(service)) {
    const before = availability
    interventionBoost =
      recoveryCurve(hour, mutualAidDispatchStart, mutualAidDispatchStart + 7) * 0.1
    availability = clamp(availability + interventionBoost)
    interventionEffect = availability - before
  }

  const localClockHour = (scenario.startClockHour ?? 0) + hour
  const dailyDemand =
    0.92 + Math.sin((localClockHour / 24) * Math.PI * 2 - 1.1) * 0.08
  const seasonalDemand = seasonalDemandMultiplier(
    service,
    scenario.season,
    demandTemperatureC,
  )
  const dayTypeDemand = dayTypeDemandMultiplier(service, scenario.dayType ?? 'weekday')
  const householdNeedMultiplier =
    service === 'supply'
      ? 1 + (0.5 - (scenario.householdPreparedness ?? 0.5)) * 0.36
      : 1
  const demandMultiplier =
    dailyDemand *
    seasonalDemand *
    dayTypeDemand *
    (scenario.demandMultiplier ?? 1) *
    householdNeedMultiplier
  const unadjustedDemand = Math.max(
    4,
    ((city.population ?? 35_000) / 1_000) * serviceDemandFactor[service],
  )
  const demand = Math.max(
    4,
    ((city.population ?? 35_000) / 1_000) *
      serviceDemandFactor[service] *
      demandMultiplier,
  )
  const delivered = demand * availability
  const householdReserveMultiplier =
    service === 'supply' ? 0.75 + (scenario.householdPreparedness ?? 0.5) * 0.5 : 1
  const initialReserve =
    (8 + variability * 18 + scenario.preparedness * 14) *
    backupMultiplier *
    householdReserveMultiplier
  const reserveHours = Math.max(
    0,
    initialReserve * availability -
      Math.max(0, elapsedSinceStart - initialReserve * 0.5) * 0.08,
  )
  const status = statusForAvailability(availability, recovery > 0.12 && recovery < 0.96)
  const cause =
    availability > 0.88
      ? 'Capacity and backup remain sufficient'
      : service === 'water' && powerAvailability < 0.65
        ? 'Pumping capacity is constrained by electricity supply'
        : service === 'telecom' && powerAvailability < 0.65
          ? 'Site backup is depleting after upstream power loss'
          : service === 'supply' && mobilityAvailability < 0.65
            ? 'Inbound routes are constrained by transport access'
            : hazardPressure.cause

  if (!includeExplanation) {
    return {
      availability,
      demand,
      delivered,
      reserveHours,
      status,
      bottleneckLabel: availability < 0.7 ? `${city.name} ${service} gateway` : 'No active bottleneck',
      cause,
      confidence: 'scenario',
      explanation: {
        summary: cause,
        baselineResilience,
        directHazardPressure: hazardPressure.pressure,
        recoveryProgress: recovery,
        availabilityBeforeNetwork: availability,
        observedAvailability: availability,
        demandMultiplier,
        contributions: [],
        dependencies: [],
        dependencyChain: { nodes: [], edges: [] },
        drivers: [],
        counterfactuals: [],
        attributionNote:
          'Compact live frame; request this municipality in explanationMunicipalityIds for the complete causal trace.',
      },
    }
  }

  const contributions: CauseContribution[] = [
    {
      id: `${service}:baseline-resilience`,
      kind: 'resilience',
      label: 'Baseline asset resilience',
      target: 'service-availability',
      value: baselineResilience,
      unit: 'availability fraction',
      normalizedValue: baselineResilience,
      effect: baselineResilience - 1,
      effectUnit: 'availability fraction',
      direction: effectDirection(baselineResilience - 1),
      method: 'exact-stage-delta',
      confidence: 'scenario',
      driverId: 'scenario.preparedness',
      description: 'Deterministic municipal baseline before event damage.',
    },
  ]
  const hazardEffect = availabilityAtPeakDamage - baselineResilience
  const weightedTotal = hazardPressure.weighted.reduce((sum, item) => sum + item.loss, 0)
  for (const item of hazardPressure.weighted) {
    const effect = weightedTotal > 1e-12 ? hazardEffect * (item.loss / weightedTotal) : 0
    contributions.push({
      id: `${service}:hazard:${item.dimension}`,
      kind: 'hazard',
      label: `${hazardDimensionLabels[item.dimension]} exposure`,
      target: 'service-availability',
      value: hazardDimensionValue(hazard, item.dimension).value,
      unit: hazardDimensionValue(hazard, item.dimension).unit,
      normalizedValue: item.loss,
      effect,
      effectUnit: 'availability fraction',
      direction: effectDirection(effect),
      method: 'proportional-attribution',
      confidence: 'scenario',
      driverId: `hazard.${item.dimension}`,
      description: `${hazardCause[item.dimension]}; effect shares proportionally allocate the exact combined direct-damage stage delta.`,
    })
  }
  contributions.push({
    id: `${service}:recovery`,
    kind: 'recovery',
    label: 'Organized restoration',
    target: 'service-availability',
    value: recovery,
    unit: 'progress fraction',
    normalizedValue: recovery,
    effect: availabilityAfterRecovery - availabilityAtPeakDamage,
    effectUnit: 'availability fraction',
    direction: effectDirection(availabilityAfterRecovery - availabilityAtPeakDamage),
    method: 'exact-stage-delta',
    confidence: 'scenario',
    driverId: 'scenario.repairCapacityMultiplier',
    description: repairAccessBlocked
      ? 'Standing modeled floodwater pauses generic restoration because asset access is not assumed safe.'
      : 'Recovered share of modeled direct damage after the repair start time and after the standing-water access guard clears.',
  })
  for (const dependency of dependencyResult.effects) {
    contributions.push({
      id: `${service}:dependency:${dependency.upstreamService}`,
      kind: 'dependency',
      label: `${dependency.upstreamService} dependency`,
      target: 'service-availability',
      value: dependency.upstreamAvailability,
      unit: 'upstream availability',
      normalizedValue: dependency.multiplier,
      effect: dependency.effect,
      effectUnit: 'availability fraction',
      direction: effectDirection(dependency.effect),
      method: 'exact-stage-delta',
      confidence: 'scenario',
      driverId: `service.${dependency.upstreamService}.availability`,
      description: dependency.description,
    })
  }
  contributions.push({
    id: `${service}:intervention`,
    kind: 'intervention',
    label: intervention === 'baseline' ? 'No additional intervention' : intervention,
    target: 'service-availability',
    value: interventionEffect,
    unit: 'availability fraction',
    normalizedValue: clamp(Math.abs(interventionEffect) / 0.12),
    effect: interventionEffect,
    effectUnit: 'availability fraction',
    direction: effectDirection(interventionEffect),
    method: 'exact-stage-delta',
    confidence: 'scenario',
    driverId: 'intervention',
    description:
      'Exact bounded availability change from a response-delay-gated dispatch ramp. This is a scenario assumption, not evidence that crews, generators, fuel or access are available.',
  })
  contributions.push({
    id: `${service}:operations-demand`,
    kind: 'demand',
    label: 'Time, season and operations demand',
    target: 'service-demand',
    value: demandMultiplier,
    unit: '× baseline demand',
    effect: demand - unadjustedDemand,
    effectUnit: 'service units/hour',
    direction: effectDirection(demand - unadjustedDemand),
    method: 'exact-stage-delta',
    confidence: 'scenario',
    driverId: 'scenario.demandMultiplier',
    description: 'Combined diurnal, seasonal, day-type, operations and household-need demand effect.',
  })
  contributions.push({
    id: `${service}:network-transfer`,
    kind: 'network',
    label: 'Intermunicipal network transfer',
    target: 'service-availability',
    value: 0,
    unit: 'service units/hour',
    effect: 0,
    effectUnit: 'availability fraction',
    direction: 'neutral',
    method: 'exact-stage-delta',
    confidence: 'scenario',
    driverId: 'scenario.networkCapacityMultiplier',
    description: 'Updated after conservative network balancing.',
  })

  const applyIntervention = (input: number): number => clamp(input + interventionBoost)
  const noHazardAvailability = applyIntervention(
    applyDependencies(baselineResilience).availability,
  )
  const fullUpstreamAvailability = applyIntervention(
    applyDependencies(availabilityAfterRecovery, true).availability,
  )
  const noRecoveryAvailability = applyIntervention(
    applyDependencies(availabilityAtPeakDamage).availability,
  )
  const counterfactuals: CounterfactualResult[] = [
    {
      id: `${service}:without-direct-hazard`,
      label: 'No direct hazard damage',
      question: 'What would local availability be without direct event damage?',
      observedValue: availability,
      counterfactualValue: noHazardAvailability,
      delta: noHazardAvailability - availability,
      unit: 'availability fraction',
      changedDriverIds: hazardPressure.weighted.map((item) => `hazard.${item.dimension}`),
      method: 'exact-stage-substitution',
      confidence: 'scenario',
    },
    {
      id: `${service}:full-upstream`,
      label: 'Upstream service fully available',
      question: 'What would local availability be if immediate upstream services were fully available?',
      observedValue: availability,
      counterfactualValue: fullUpstreamAvailability,
      delta: fullUpstreamAvailability - availability,
      unit: 'availability fraction',
      changedDriverIds: dependencyRules.map(
        (dependency) => `service.${dependency.upstreamService}.availability`,
      ),
      method: 'exact-stage-substitution',
      confidence: 'scenario',
    },
    {
      id: `${service}:without-recovery`,
      label: 'No restoration progress',
      question: 'What would availability be if organized restoration had not progressed?',
      observedValue: availability,
      counterfactualValue: noRecoveryAvailability,
      delta: noRecoveryAvailability - availability,
      unit: 'availability fraction',
      changedDriverIds: ['scenario.repairCapacityMultiplier'],
      method: 'exact-stage-substitution',
      confidence: 'scenario',
    },
    {
      id: `${service}:without-intervention`,
      label: 'No selected intervention',
      question: 'What would availability be without the selected intervention?',
      observedValue: availability,
      counterfactualValue: availabilityWithoutIntervention,
      delta: availabilityWithoutIntervention - availability,
      unit: 'availability fraction',
      changedDriverIds: ['intervention'],
      method: 'exact-stage-substitution',
      confidence: 'scenario',
    },
  ]
  const drivers: DriverMetadata[] = [
    {
      id: 'intervention',
      label: 'Response intervention',
      value: intervention,
      unit: '',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      description:
        'A bounded scenario sensitivity that ramps only after response delay; it does not represent an inventoried crew or asset.',
    },
    {
      id: `service.${service}.baselineResilience`,
      label: 'Baseline resilience',
      value: baselineResilience,
      unit: 'availability fraction',
      role: 'derived-state',
      source: 'derived-model-state',
      editable: false,
      description: 'Deterministic local resilience prior derived from municipality and scenario seed.',
    },
    {
      id: `service.${service}.directHazardPressure`,
      label: 'Peak direct hazard pressure',
      value: hazardPressure.pressure,
      unit: 'pressure fraction',
      role: 'derived-state',
      source: 'derived-model-state',
      editable: false,
      description:
        'Service-specific pressure from peak hazard dimensions observed through the selected frame; it can remain consequential after current forcing subsides.',
    },
    {
      id: `service.${service}.recoveryProgress`,
      label: 'Restoration progress',
      value: recovery,
      unit: 'fraction',
      role: 'derived-state',
      source: 'derived-model-state',
      editable: false,
      description: 'Smooth scenario restoration progress after the modeled repair start.',
    },
    {
      id: `service.${service}.repairAccessFloodDepth`,
      label: 'Standing-water repair-access guard',
      value: repairAccessFloodDepth,
      unit: 'depth-proxy units',
      role: 'derived-state',
      source: 'derived-model-state',
      editable: false,
      description: currentHazard.unsupportedDimensions?.includes('flood')
        ? 'The displayed flood value is unsupported and therefore excluded from the repair-access calculation; actual field access remains Unknown.'
        : `Generic restoration is paused above ${REPAIR_BLOCKING_FLOOD_DEPTH_M.toFixed(2)} depth-proxy units; this is a screening rule, not a field access assessment.`,
    },
    {
      id: 'scenario.preparedness',
      label: 'Infrastructure preparedness',
      value: scenario.preparedness,
      unit: 'fraction',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'preparedness',
      description: 'Reduces modeled physical fragility and increases baseline backup endurance.',
    },
    {
      id: 'scenario.responseDelayHours',
      label: 'Response delay',
      value: scenario.responseDelayHours,
      unit: 'hours',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'responseDelayHours',
      description: 'Delays the beginning of organized restoration.',
    },
    {
      id: 'scenario.repairCapacityMultiplier',
      label: 'Repair capacity',
      value: repairCapacityMultiplier,
      unit: '×',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'repairCapacityMultiplier',
      description: 'Scales repair speed after restoration begins.',
    },
    {
      id: 'scenario.backupMultiplier',
      label: 'Backup endurance',
      value: backupMultiplier,
      unit: '×',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'backupMultiplier',
      description: 'Scales backup windows and modeled reserve duration.',
    },
    {
      id: 'scenario.demandMultiplier',
      label: 'Operations demand',
      value: scenario.demandMultiplier ?? 1,
      unit: '×',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'demandMultiplier',
      description: 'Scales every service demand after diurnal and seasonal effects.',
    },
    {
      id: 'scenario.startClockHour',
      label: 'Local start time',
      value: scenario.startClockHour ?? 0,
      unit: 'hour of day',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'startClockHour',
      description: 'Offsets the diurnal demand curve at T+00.',
    },
    {
      id: 'scenario.dayType',
      label: 'Day type',
      value: scenario.dayType ?? 'weekday',
      unit: '',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'dayType',
      description: 'Changes mobility and household-oriented demand patterns.',
    },
    {
      id: 'scenario.householdPreparedness',
      label: 'Household preparedness',
      value: scenario.householdPreparedness ?? 0.5,
      unit: 'fraction',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'householdPreparedness',
      description: 'Changes household supply need and reserves without changing physical asset fragility.',
    },
  ]
  const interventionApplies =
    (intervention === 'generator-priority' &&
      ['water', 'telecom', 'facilities'].includes(service)) ||
    (intervention === 'mutual-aid' && ['mobility', 'supply'].includes(service))
  if (interventionApplies) {
    const dispatchStart =
      intervention === 'generator-priority'
        ? generatorDispatchStart
        : mutualAidDispatchStart
    drivers.push({
      id: `service.${service}.interventionDispatchStart`,
      label: 'Modeled intervention dispatch start',
      value: dispatchStart,
      unit: 'T+ hours',
      role: 'derived-state',
      source: 'derived-model-state',
      editable: false,
      description: `Response-delay-gated start of the ${intervention === 'generator-priority' ? '5-hour generator-priority' : '7-hour mutual-aid'} ramp.`,
    })
  }

  return {
    availability,
    demand,
    delivered,
    reserveHours,
    status,
    bottleneckLabel: availability < 0.7 ? `${city.name} ${service} gateway` : 'No active bottleneck',
    cause,
    confidence: 'scenario',
    explanation: {
      summary: cause,
      baselineResilience,
      directHazardPressure: hazardPressure.pressure,
      recoveryProgress: recovery,
      availabilityBeforeNetwork: availability,
      observedAvailability: availability,
      demandMultiplier,
      contributions,
      dependencies: dependencyResult.effects,
      dependencyChain: { nodes: [], edges: [] },
      drivers,
      counterfactuals,
      attributionNote:
        'Availability effects are deterministic model-stage deltas. Intermunicipal service flows use the supplied connectivity graph as logical transfer proxies; an NWB road graph is not evidence of physical utility topology.',
    },
  }
}

interface RouteTransfer {
  amount: number
  direction: -1 | 1
}

function serviceForLayer(layer: LayerId): ServiceId {
  return layer === 'overview' || layer === 'hazard' || layer === 'population' ? 'supply' : layer
}

function routeSupportsService(route: RouteDefinition, service: ServiceId): boolean {
  if (route.affectsSimulation === false) return false
  if (route.supportedServices !== undefined) return route.supportedServices.includes(service)
  // NWB proves road connectivity only. It may support road mobility and an
  // explicitly modelled logistics transfer, but never stands in for power,
  // gas, water, drainage, telecom or facility topology.
  if (route.source === 'NWB') return service === 'mobility' || service === 'supply'
  return true
}

function activeRouteRestriction(
  route: RouteDefinition,
  scenario: ScenarioConfig,
  service: ServiceId,
) {
  const referenceDate = scenario.referenceDate
  if (!referenceDate) return undefined
  return route.operationalRestrictions?.find(
    (restriction) =>
      restriction.affectedServices.includes(service) &&
      restriction.validFrom <= referenceDate &&
      referenceDate <= restriction.validThrough,
  )
}

export function orientRouteCoordinates(
  coordinates: readonly Coordinates[],
  flowDirection: -1 | 0 | 1,
): Coordinates[] {
  return flowDirection === -1 ? [...coordinates].reverse() : [...coordinates]
}

function routeCondition(
  route: RouteDefinition,
  snapshots: Map<string, MunicipalitySnapshot>,
  hour: number,
  scenario: ScenarioConfig,
): { health: number; recoveryProgress: number } {
  const from = snapshots.get(route.from)?.hazard
  const to = snapshots.get(route.to)?.hazard
  if (!from || !to) return { health: 1, recoveryProgress: 0 }
  const average = (valueFrom: number, valueTo: number) => (valueFrom + valueTo) / 2
  const supportedAverage = (
    dimension: HazardDimension,
    valueFrom: number,
    valueTo: number,
  ) => average(
    supportedHazardValue(from, dimension, valueFrom),
    supportedHazardValue(to, dimension, valueTo),
  )
  const pressures = [
    clamp(supportedAverage('flood', from.floodDepthM, to.floodDepthM) / 1.1) * 0.78,
    clamp((supportedAverage('wind', from.windGustMs, to.windGustMs) - 16) / 25) * 0.38,
    clamp(supportedAverage('snowIce', from.snowCmH, to.snowCmH) / 4) * 0.58,
    supportedAverage('snowIce', from.iceSeverity, to.iceSeverity) * 0.72,
    supportedAverage('fire', from.wildfireIntensity, to.wildfireIntensity) * 0.68,
    supportedAverage('smoke', from.smokeSeverity, to.smokeSeverity) * 0.25,
    clamp(supportedAverage('groundMotion', from.groundMotionG, to.groundMotionG) / 0.3) * 0.72,
    supportedAverage('cyber', from.cyberDisruption, to.cyberDisruption) * 0.08,
    average(
      from.unsupportedDimensions?.length ? 0 : from.peakSeverity,
      to.unsupportedDimensions?.length ? 0 : to.peakSeverity,
    ) * 0.24,
  ]
  const pressure = clamp(1 - pressures.reduce((remaining, loss) => remaining * (1 - clamp(loss)), 1))
  const localFailure = seededUnit(hashString(route.id) ^ scenario.seed, 9)
  const damaged = pressure * (0.58 + localFailure * 0.38) * (1 - scenario.preparedness * 0.44)
  const repairStart = Math.max(
    scenario.startHour + scenario.responseDelayHours,
    earliestSafeRepairHour(scenario),
  ) + localFailure * 8
  const standingFloodDepth = supportedAverage('flood', from.floodDepthM, to.floodDepthM)
  const repair = standingFloodDepth > REPAIR_BLOCKING_FLOOD_DEPTH_M
    ? 0
    : recoveryCurve(
        hour,
        repairStart,
        repairStart +
          (25 + (1 - scenario.preparedness) * 46 + localFailure * 20) /
            (scenario.repairCapacityMultiplier ?? 1),
      )
  return {
    health: clamp(1 - damaged + repair * damaged),
    recoveryProgress: repair,
  }
}

function routeSnapshots(
  routes: RouteDefinition[],
  citySnapshots: Map<string, MunicipalitySnapshot>,
  hour: number,
  scenario: ScenarioConfig,
  service: ServiceId,
  transfers: Map<string, RouteTransfer> = new Map(),
): RouteSnapshot[] {
  return routes.filter((route) => routeSupportsService(route, service)).map((route) => {
    const { health, recoveryProgress } = routeCondition(route, citySnapshots, hour, scenario)
    const activeRestriction = activeRouteRestriction(route, scenario, service)
    const closesRoute =
      activeRestriction?.state === 'closed' && activeRestriction.simulationEffect === 'close-route'
    const restrictedHealth = closesRoute ? 0 : health
    const from = citySnapshots.get(route.from)
    const to = citySnapshots.get(route.to)
    const fromService = from?.services[service]
    const toService = to?.services[service]
    const effectiveCapacity = Math.max(
      0,
      route.nominalCapacity * restrictedHealth * (scenario.networkCapacityMultiplier ?? 1),
    )
    const transfer = transfers.get(route.id)
    const flow = Math.min(effectiveCapacity, Math.max(0, transfer?.amount ?? 0))
    const flowDirection = transfer?.direction ?? 0
    const utilization = effectiveCapacity <= 0 ? 1 : clamp(flow / effectiveCapacity)
    const pressure = Math.abs((fromService?.availability ?? 1) - (toService?.availability ?? 1))
    const bottleneck = restrictedHealth < 0.68 || (pressure > 0.05 && utilization > 0.78)
    const status = closesRoute
      ? 'failed'
      : statusForAvailability(
          restrictedHealth,
          recoveryProgress > 0.12 && recoveryProgress < 0.96,
        )
    return {
      ...route,
      transferSemantics: 'logical-proxy',
      activeRestriction,
      flowCoordinates: orientRouteCoordinates(route.coordinates, flowDirection),
      effectiveCapacity,
      utilization,
      health: restrictedHealth,
      flow,
      flowDirection,
      status,
      bottleneck,
      color: bottleneck ? '#ff6577' : statusColors[status],
    }
  })
}

function balanceNetwork(
  citySnapshots: Map<string, MunicipalitySnapshot>,
  routes: RouteDefinition[],
  hour: number,
  service: ServiceId,
  scenario: ScenarioConfig,
  explanationMunicipalityIds?: ReadonlySet<string>,
): Map<string, RouteTransfer> {
  const projectedRoutes = routeSnapshots(routes, citySnapshots, hour, scenario, service)
  const proposals: Array<{
    route: RouteSnapshot
    donor: MunicipalitySnapshot
    receiver: MunicipalitySnapshot
    amount: number
    direction: -1 | 1
  }> = []

  for (const route of projectedRoutes) {
    const from = citySnapshots.get(route.from)
    const to = citySnapshots.get(route.to)
    if (!from || !to) continue
    const fromState = from.services[service]
    const toState = to.services[service]
    const gap = fromState.availability - toState.availability
    if (Math.abs(gap) <= 0.005 || route.effectiveCapacity <= 0) continue
    const donor = gap > 0 ? from : to
    const receiver = gap > 0 ? to : from
    const donorState = donor.services[service]
    const receiverState = receiver.services[service]
    const equalizingTransfer =
      Math.abs(gap) /
      (1 / Math.max(0.01, donorState.demand) + 1 / Math.max(0.01, receiverState.demand))
    const amount = Math.min(
      route.effectiveCapacity,
      equalizingTransfer,
      donorState.delivered,
      Math.max(0, receiverState.demand - receiverState.delivered),
    )
    if (amount <= 1e-9) continue
    proposals.push({
      route,
      donor,
      receiver,
      amount,
      direction: donor.id === route.from ? 1 : -1,
    })
  }

  const proposedOut = new Map<string, number>()
  const proposedIn = new Map<string, number>()
  for (const proposal of proposals) {
    proposedOut.set(
      proposal.donor.id,
      (proposedOut.get(proposal.donor.id) ?? 0) + proposal.amount,
    )
    proposedIn.set(
      proposal.receiver.id,
      (proposedIn.get(proposal.receiver.id) ?? 0) + proposal.amount,
    )
  }

  const transfers = new Map<string, RouteTransfer>()
  const netTransfer = new Map<string, number>()
  for (const proposal of proposals) {
    const donorState = proposal.donor.services[service]
    const receiverState = proposal.receiver.services[service]
    const donorScale = Math.min(
      1,
      donorState.delivered / Math.max(1e-9, proposedOut.get(proposal.donor.id) ?? 0),
    )
    const receiverScale = Math.min(
      1,
      (receiverState.demand - receiverState.delivered) /
        Math.max(1e-9, proposedIn.get(proposal.receiver.id) ?? 0),
    )
    const amount = proposal.amount * Math.max(0, Math.min(donorScale, receiverScale))
    if (amount <= 1e-9) continue
    donorState.delivered -= amount
    receiverState.delivered += amount
    netTransfer.set(proposal.donor.id, (netTransfer.get(proposal.donor.id) ?? 0) - amount)
    netTransfer.set(proposal.receiver.id, (netTransfer.get(proposal.receiver.id) ?? 0) + amount)
    transfers.set(proposal.route.id, { amount, direction: proposal.direction })
  }

  for (const city of citySnapshots.values()) {
    const state = city.services[service]
    const availabilityBeforeNetwork = state.availability
    state.availability = clamp(state.delivered / Math.max(0.01, state.demand))
    state.status = statusForAvailability(state.availability, state.status === 'recovering')
    const net = netTransfer.get(city.id) ?? 0
    if (net > 0.05) {
      state.cause = `${state.cause}; neighboring gateways transfer ${Math.round(net)} u/h inward`
    }
    if (state.availability >= 0.7) state.bottleneckLabel = 'No active bottleneck'
    if (explanationMunicipalityIds && !explanationMunicipalityIds.has(city.id)) continue
    const networkEffect = state.availability - availabilityBeforeNetwork
    const contribution = state.explanation.contributions.find(
      (item) => item.id === `${service}:network-transfer`,
    )
    if (contribution) {
      contribution.value = net
      contribution.effect = networkEffect
      contribution.direction = effectDirection(networkEffect)
      contribution.description =
        net > 0.05
          ? 'Conservative network balancing transfers service inward over a logical corridor proxy; it does not assert a physical utility connection.'
          : net < -0.05
            ? 'Conservative network balancing transfers surplus service outward over a logical corridor proxy; it does not assert a physical utility connection.'
            : 'No material intermunicipal logical transfer is active.'
    }
    state.explanation.availabilityBeforeNetwork = availabilityBeforeNetwork
    state.explanation.observedAvailability = state.availability
    for (const counterfactual of state.explanation.counterfactuals) {
      counterfactual.counterfactualValue = clamp(
        counterfactual.counterfactualValue + networkEffect,
      )
      counterfactual.observedValue = state.availability
      counterfactual.delta = counterfactual.counterfactualValue - state.availability
    }
    state.explanation.counterfactuals.push({
      id: `${service}:isolated-network`,
      label: 'No intermunicipal transfer',
      question: 'What would availability be if this municipality were isolated from the network?',
      observedValue: state.availability,
      counterfactualValue: availabilityBeforeNetwork,
      delta: availabilityBeforeNetwork - state.availability,
      unit: 'availability fraction',
      changedDriverIds: ['scenario.networkCapacityMultiplier'],
      method: 'exact-stage-substitution',
      confidence: 'scenario',
    })
    state.explanation.drivers.push({
      id: 'scenario.networkCapacityMultiplier',
      label: 'Network capacity',
      value: scenario.networkCapacityMultiplier ?? 1,
      unit: '×',
      role: 'scenario-control',
      source: 'scenario-input',
      editable: true,
      scenarioField: 'networkCapacityMultiplier',
      description:
        'Scales logical intermunicipal transfer capacity on the supplied connectivity graph; it does not turn road geometry into physical utility topology.',
    })
    state.explanation.drivers.push({
      id: `service.${service}.netTransfer`,
      label: 'Net network transfer',
      value: net,
      unit: 'service units/hour',
      role: 'derived-state',
      source: 'derived-model-state',
      editable: false,
      description: 'Positive values are net imports; negative values are net exports.',
    })
    state.explanation.summary =
      Math.abs(networkEffect) > 0.002
        ? `${state.cause}; network transfers change availability by ${(networkEffect * 100).toFixed(1)} percentage points.`
        : state.cause
  }

  return transfers
}

function normalizeSimulationStep(step: number): number {
  if (!Number.isFinite(step)) throw new RangeError('Simulation step must be finite')
  return Math.max(0, Math.min(TIMELINE_STEPS - 1, Math.round(step)))
}

function frameHour(step: number): number {
  return (normalizeSimulationStep(step) * MINUTES_PER_STEP) / 60
}

interface ScenarioHistoryAccumulator {
  completedQuarterHours: number
  peakHazard: HazardState
  baselinePeakHazard: HazardState
  deprivedPersonHours: number
}

/**
 * Numerical counterpart of the availability stages in `createDirectService`.
 * It deliberately omits demand, reserves, explanations and network transfers
 * so cumulative service shortfall can be integrated without constructing
 * hundreds of thousands of transient explanation objects.
 */
function localServiceAvailabilityForHistory(
  city: MunicipalityDefinition,
  service: ServiceId,
  hour: number,
  hazard: HazardState,
  currentHazard: HazardState,
  scenario: ScenarioConfig,
  powerAvailability = 1,
  mobilityAvailability = 1,
  intervention: SimulationOptions['intervention'] = 'baseline',
): number {
  const elapsedSinceStart = Math.max(0, hour - scenario.startHour)
  const variability = seededUnit(city.seed ^ scenario.seed, hashString(service) % 997)
  const baselineResilience = clamp(
    0.92 + variability * 0.075 + scenario.preparedness * 0.018,
  )
  const hazardPressure = hazardPressureForService(hazard, service).pressure
  const directLoss =
    hazardPressure *
    (0.72 + variability * 0.42) *
    (1 - scenario.preparedness * 0.42)
  const earliestSafeRepair = earliestSafeRepairHour(scenario)
  const repairStart = Math.max(
    scenario.startHour + scenario.responseDelayHours,
    earliestSafeRepair,
  ) + variability * 7
  const repairEnd =
    repairStart +
    (24 + (1 - scenario.preparedness) * 42 + variability * 20) /
      (scenario.repairCapacityMultiplier ?? 1)
  const recovery =
    supportedHazardValue(currentHazard, 'flood', currentHazard.floodDepthM) >
    REPAIR_BLOCKING_FLOOD_DEPTH_M
    ? 0
    : recoveryCurve(hour, repairStart, repairEnd)
  let availability = clamp(baselineResilience - directLoss * (1 - recovery))
  const backupMultiplier = scenario.backupMultiplier ?? 1

  if (service === 'water') {
    const backupWindow =
      (4 + variability * 9 + scenario.preparedness * 9) * backupMultiplier
    availability *=
      elapsedSinceStart <= backupWindow ? 1 : 0.55 + powerAvailability * 0.45
  }
  if (service === 'drainage') availability *= 0.48 + powerAvailability * 0.52
  if (service === 'telecom') {
    const batteryWindow =
      (2 + variability * 7 + scenario.preparedness * 12) * backupMultiplier
    availability *=
      elapsedSinceStart <= batteryWindow ? 1 : 0.32 + powerAvailability * 0.68
  }
  if (service === 'gas') availability *= 0.77 + powerAvailability * 0.23
  if (service === 'facilities') {
    const backupWindow =
      (6 + variability * 15 + scenario.preparedness * 18) * backupMultiplier
    availability *=
      elapsedSinceStart <= backupWindow ? 0.97 : 0.35 + powerAvailability * 0.65
  }
  if (service === 'supply') availability *= 0.35 + mobilityAvailability * 0.65

  if (
    intervention === 'generator-priority' &&
    ['water', 'telecom', 'facilities'].includes(service)
  ) {
    const dispatchStart = scenario.startHour + scenario.responseDelayHours + 1
    availability = clamp(
      availability +
        recoveryCurve(hour, dispatchStart, dispatchStart + 5) * 0.12,
    )
  }
  if (intervention === 'mutual-aid' && ['mobility', 'supply'].includes(service)) {
    const dispatchStart = scenario.startHour + scenario.responseDelayHours + 10
    availability = clamp(
      availability +
        recoveryCurve(hour, dispatchStart, dispatchStart + 7) * 0.1,
    )
  }
  return clamp(availability)
}

function localSystemPressureForHistory(
  city: MunicipalityDefinition,
  hour: number,
  peakHazard: HazardState,
  currentHazard: HazardState,
  scenario: ScenarioConfig,
  intervention: SimulationOptions['intervention'],
): number {
  const power = localServiceAvailabilityForHistory(
    city,
    'power',
    hour,
    peakHazard,
    currentHazard,
    scenario,
    1,
    1,
    intervention,
  )
  const mobility = localServiceAvailabilityForHistory(
    city,
    'mobility',
    hour,
    peakHazard,
    currentHazard,
    scenario,
    power,
    1,
    intervention,
  )
  return serviceIds.reduce((pressure, service) => {
    const availability =
      service === 'power'
        ? power
        : service === 'mobility'
          ? mobility
          : localServiceAvailabilityForHistory(
              city,
              service,
              hour,
              peakHazard,
              currentHazard,
              scenario,
              power,
              mobility,
              intervention,
            )
    return pressure + (1 - availability) * systemServiceWeights[service]
  }, 0)
}

function advanceScenarioHistory(
  city: MunicipalityDefinition,
  hour: number,
  scenario: ScenarioConfig,
  intervention: SimulationOptions['intervention'],
  previous?: ScenarioHistoryAccumulator,
): ScenarioHistoryAccumulator {
  const population = Math.max(0, city.population ?? 35_000)
  const completedQuarterHours = Math.floor(hour * 4)
  const canAdvance = previous && previous.completedQuarterHours <= completedQuarterHours
  const noEventScenario = { ...scenario, intensity: 0 }
  let peakHazard = canAdvance
    ? previous.peakHazard
    : hazardForMunicipality(city, 0, scenario)
  let baselinePeakHazard = canAdvance
    ? previous.baselinePeakHazard
    : hazardForMunicipality(city, 0, noEventScenario)
  let deprivedPersonHours = canAdvance ? previous.deprivedPersonHours : 0
  const firstQuarterHour = canAdvance ? previous.completedQuarterHours + 1 : 1
  for (let index = firstQuarterHour; index <= completedQuarterHours; index += 1) {
    const hazard = hazardForMunicipality(city, index / 4, scenario)
    const baselineHazard = hazardForMunicipality(city, index / 4, noEventScenario)
    peakHazard = {
      ...hazard,
      rainMmH: Math.max(peakHazard.rainMmH, hazard.rainMmH),
      floodDepthM: Math.max(peakHazard.floodDepthM, hazard.floodDepthM),
      windGustMs: Math.max(peakHazard.windGustMs, hazard.windGustMs),
      heatC: Math.max(peakHazard.heatC, hazard.heatC),
      snowCmH: Math.max(peakHazard.snowCmH, hazard.snowCmH),
      iceSeverity: Math.max(peakHazard.iceSeverity, hazard.iceSeverity),
      coldStress: Math.max(peakHazard.coldStress, hazard.coldStress),
      droughtSeverity: Math.max(peakHazard.droughtSeverity, hazard.droughtSeverity),
      wildfireIntensity: Math.max(peakHazard.wildfireIntensity, hazard.wildfireIntensity),
      smokeSeverity: Math.max(peakHazard.smokeSeverity, hazard.smokeSeverity),
      groundMotionG: Math.max(peakHazard.groundMotionG, hazard.groundMotionG),
      cyberDisruption: Math.max(peakHazard.cyberDisruption, hazard.cyberDisruption),
      severity: Math.max(peakHazard.severity, hazard.severity),
      peakSeverity: Math.max(peakHazard.peakSeverity, hazard.severity),
    }
    baselinePeakHazard = {
      ...baselineHazard,
      rainMmH: Math.max(baselinePeakHazard.rainMmH, baselineHazard.rainMmH),
      floodDepthM: Math.max(baselinePeakHazard.floodDepthM, baselineHazard.floodDepthM),
      windGustMs: Math.max(baselinePeakHazard.windGustMs, baselineHazard.windGustMs),
      heatC: Math.max(baselinePeakHazard.heatC, baselineHazard.heatC),
      snowCmH: Math.max(baselinePeakHazard.snowCmH, baselineHazard.snowCmH),
      iceSeverity: Math.max(baselinePeakHazard.iceSeverity, baselineHazard.iceSeverity),
      coldStress: Math.max(baselinePeakHazard.coldStress, baselineHazard.coldStress),
      droughtSeverity: Math.max(baselinePeakHazard.droughtSeverity, baselineHazard.droughtSeverity),
      wildfireIntensity: Math.max(baselinePeakHazard.wildfireIntensity, baselineHazard.wildfireIntensity),
      smokeSeverity: Math.max(baselinePeakHazard.smokeSeverity, baselineHazard.smokeSeverity),
      groundMotionG: Math.max(baselinePeakHazard.groundMotionG, baselineHazard.groundMotionG),
      cyberDisruption: Math.max(baselinePeakHazard.cyberDisruption, baselineHazard.cyberDisruption),
      severity: Math.max(baselinePeakHazard.severity, baselineHazard.severity),
      peakSeverity: Math.max(baselinePeakHazard.peakSeverity, baselineHazard.severity),
    }
    const scenarioPressure = localSystemPressureForHistory(
      city,
      index / 4,
      peakHazard,
      hazard,
      scenario,
      intervention,
    )
    const noEventPressure = localSystemPressureForHistory(
      city,
      index / 4,
      baselinePeakHazard,
      baselineHazard,
      noEventScenario,
      intervention,
    )
    // This indicator is event-attributable burden. A municipality's synthetic
    // baseline resilience prior must not create disaster deprivation on its own.
    deprivedPersonHours += population * Math.max(0, scenarioPressure - noEventPressure) * 0.25
  }
  return { completedQuarterHours, peakHazard, baselinePeakHazard, deprivedPersonHours }
}

function scenarioHistory(
  city: MunicipalityDefinition,
  hour: number,
  scenario: ScenarioConfig,
  intervention: SimulationOptions['intervention'],
): ScenarioHistoryAccumulator {
  return advanceScenarioHistory(city, hour, scenario, intervention)
}

function buildServiceDependencyChain(
  municipality: MunicipalitySnapshot,
  targetService: ServiceId,
): DependencyChain {
  const nodes = new Map<DependencyChain['nodes'][number]['id'], DependencyChain['nodes'][number]>()
  const edges = new Map<string, DependencyChain['edges'][number]>()
  const visiting = new Set<ServiceId>()

  const visit = (service: ServiceId) => {
    if (visiting.has(service)) return
    visiting.add(service)
    const state = municipality.services[service]
    const serviceNodeId = `service:${service}` as const
    nodes.set(serviceNodeId, {
      id: serviceNodeId,
      kind: 'service',
      label: service,
      value: state.availability,
      unit: 'availability fraction',
    })
    for (const contribution of state.explanation.contributions) {
      if (contribution.kind !== 'hazard' || !contribution.driverId?.startsWith('hazard.')) {
        continue
      }
      const dimension = contribution.driverId.replace('hazard.', '') as HazardDimension
      const hazardNodeId = `hazard:${dimension}` as const
      nodes.set(hazardNodeId, {
        id: hazardNodeId,
        kind: 'hazard',
        label: hazardDimensionLabels[dimension],
        value: contribution.normalizedValue ?? 0,
        unit: 'normalized exposure',
      })
      const edgeId = `${hazardNodeId}->${serviceNodeId}`
      edges.set(edgeId, {
        id: edgeId,
        from: hazardNodeId,
        to: serviceNodeId,
        mechanism: 'direct-exposure',
        multiplier: clamp(1 - (contribution.normalizedValue ?? 0)),
        effect: contribution.effect,
        active: Math.abs(contribution.effect) > 1e-12,
        description: contribution.description,
      })
    }
    for (const dependency of state.explanation.dependencies) {
      visit(dependency.upstreamService)
      const upstreamNodeId = `service:${dependency.upstreamService}` as const
      const edgeId = `${upstreamNodeId}->${serviceNodeId}`
      edges.set(edgeId, {
        id: edgeId,
        from: upstreamNodeId,
        to: serviceNodeId,
        mechanism: 'operational-dependency',
        multiplier: dependency.multiplier,
        effect: dependency.effect,
        active: Math.abs(dependency.effect) > 1e-12,
        backupActive: dependency.backupActive,
        backupRemainingHours: dependency.backupRemainingHours,
        description: dependency.description,
      })
    }
  }

  visit(targetService)
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

function buildMunicipalityExplanation(
  municipality: MunicipalitySnapshot,
  scenario: ScenarioConfig,
  baseAffectedPopulation: number,
): MunicipalityExplanation {
  const contributions = serviceIds.map((service): CauseContribution => {
    const state = municipality.services[service]
    const effect = systemServiceWeights[service] * (1 - state.availability)
    return {
      id: `municipality:${municipality.id}:service:${service}`,
      kind: 'dependency',
      label: `${service} service pressure`,
      target: 'system-pressure',
      value: state.availability,
      unit: 'availability fraction',
      normalizedValue: 1 - state.availability,
      effect,
      effectUnit: 'system-pressure fraction',
      direction: effectDirection(effect),
      method: 'exact-stage-delta',
      confidence: 'scenario',
      driverId: `service.${service}.availability`,
      description:
        systemServiceWeights[service] > 0
          ? `Exact ${Math.round(systemServiceWeights[service] * 100)}% weighted contribution to municipality system pressure.`
          : 'Tracked service with zero weight in the current headline system-pressure index.',
    }
  })
  const householdEffect = municipality.affectedPopulation - baseAffectedPopulation
  contributions.push({
    id: `municipality:${municipality.id}:household-preparedness`,
    kind: 'vulnerability',
    label: 'Household preparedness',
    target: 'affected-population',
    value: scenario.householdPreparedness ?? 0.5,
    unit: 'preparedness fraction',
    normalizedValue: scenario.householdPreparedness ?? 0.5,
    effect: householdEffect,
    effectUnit: 'people-equivalent',
    direction: effectDirection(householdEffect),
    method: 'exact-stage-delta',
    confidence: 'scenario',
    driverId: 'scenario.householdPreparedness',
    description:
      'Changes the modeled people-equivalent under service pressure and emergency-supply need; it does not identify people or alter physical service fragility.',
  })
  const pressureCounterfactuals: CounterfactualResult[] = serviceIds.map((service) => {
    const effect = systemServiceWeights[service] *
      (1 - municipality.services[service].availability)
    return {
      id: `municipality:${municipality.id}:restore:${service}`,
      label: `Restore ${service}`,
      question: `What would system pressure be if ${service} availability were fully restored?`,
      observedValue: municipality.systemPressure,
      counterfactualValue: clamp(municipality.systemPressure - effect),
      delta: -effect,
      unit: 'system-pressure fraction',
      changedDriverIds: [`service.${service}.availability`],
      method: 'exact-stage-substitution',
      confidence: 'scenario',
    }
  })
  const fullyPreparedAffected = Math.min(
    municipality.population,
    Math.round(baseAffectedPopulation * (1 + (0.5 - 1) * 0.24)),
  )
  pressureCounterfactuals.push({
    id: `municipality:${municipality.id}:household-preparedness`,
    label: 'Maximum household preparedness',
    question: 'How would the modeled people-equivalent under service pressure change at maximum household preparedness?',
    observedValue: municipality.affectedPopulation,
    counterfactualValue: fullyPreparedAffected,
    delta: fullyPreparedAffected - municipality.affectedPopulation,
    unit: 'people-equivalent',
    changedDriverIds: ['scenario.householdPreparedness'],
    method: 'exact-stage-substitution',
    confidence: 'scenario',
  })
  return {
    summary: `${municipality.limitingService} is the lowest-availability service; exact weighted service losses produce ${(municipality.systemPressure * 100).toFixed(1)}% system pressure.`,
    contributions,
    drivers: [
      {
        id: `municipality.${municipality.id}.population`,
        label: 'Population',
        value: municipality.population,
        unit: 'people',
        role: 'observed-context',
        source: 'municipality-input',
        editable: false,
        description: 'Population exposed to modeled service deprivation.',
      },
      {
        id: `municipality.${municipality.id}.limitingService`,
        label: 'Limiting service',
        value: municipality.limitingService,
        unit: '',
        role: 'derived-state',
        source: 'derived-model-state',
        editable: false,
        description: 'Service with the lowest modeled availability at this frame.',
      },
      {
        id: 'scenario.householdPreparedness',
        label: 'Household preparedness',
        value: scenario.householdPreparedness ?? 0.5,
        unit: 'fraction',
        role: 'scenario-control',
        source: 'scenario-input',
        editable: true,
        scenarioField: 'householdPreparedness',
        description: 'Human-readiness assumption applied after physical system pressure.',
      },
      {
        id: `municipality.${municipality.id}.deprivedPersonHours`,
        label: 'Cumulative local pre-network deprivation',
        value: municipality.deprivedPersonHours,
        unit: 'person-hours',
        role: 'derived-state',
        source: 'derived-model-state',
        editable: false,
        description:
          'Quarter-hour integral of event-attributable weighted service shortfall above the matched no-event baseline, before intermunicipal transfers and adjusted for household preparedness.',
      },
    ],
    counterfactuals: pressureCounterfactuals,
    attributionNote:
      'System-pressure weights are transparent model assumptions summing to 1 across all eight services. Cumulative deprived person-hours integrate only shortfall above a matched no-event baseline and exclude intermunicipal transfers.',
  }
}

function simulateFrameInternal(
  municipalities: MunicipalityDefinition[],
  step: number,
  options: SimulationOptions,
  network = buildNationalNetwork(municipalities),
  rollingHistory?: Map<string, ScenarioHistoryAccumulator>,
): SimulationFrame {
  const normalizedStep = normalizeSimulationStep(step)
  const hour = frameHour(normalizedStep)
  const scenario = resolveScenario(options.scenario)
  const explanationMunicipalityIds = options.explanationMunicipalityIds === undefined
    ? undefined
    : new Set(options.explanationMunicipalityIds)
  const includeExplanation = (municipalityId: string) =>
    explanationMunicipalityIds === undefined || explanationMunicipalityIds.has(municipalityId)
  const citySnapshots = new Map<string, MunicipalitySnapshot>()
  const historyByCity = new Map<
    string,
    { peakHazard: HazardState; deprivedPersonHours: number; demandTemperatureC: number }
  >()

  for (const city of municipalities) {
    const population = Math.max(0, city.population ?? 35_000)
    const history = rollingHistory
      ? advanceScenarioHistory(
          city,
          hour,
          scenario,
          options.intervention,
          rollingHistory.get(city.code),
        )
      : scenarioHistory(city, hour, scenario, options.intervention)
    rollingHistory?.set(city.code, history)
    const rawHazard = {
      ...hazardForMunicipality(city, hour, scenario),
      peakSeverity: history.peakHazard.peakSeverity,
    }
    const baselineCurrentHazard = hazardForMunicipality(city, hour, {
      ...scenario,
      intensity: 0,
    })
    const demandTemperatureC = rawHazard.unsupportedDimensions?.some(
      (dimension) => dimension === 'heat' || dimension === 'cold',
    )
      ? baselineCurrentHazard.heatC
      : rawHazard.heatC
    const hazard: ExplainedHazardState = {
      ...rawHazard,
      explanation: includeExplanation(city.code)
        ? buildHazardExplanation(city, hour, scenario, rawHazard)
        : {
            summary: 'Compact live frame; select this municipality for the complete hazard trace.',
            dominantDimension: null,
            contributions: [],
            drivers: [],
            counterfactuals: [],
            attributionNote:
              'Numerical hazard state is complete; causal detail is materialized on selection.',
          },
    }
    historyByCity.set(city.code, { ...history, demandTemperatureC })
    const power = createDirectService(
      city,
      'power',
      hour,
      history.peakHazard,
      hazard,
      scenario,
      1,
      1,
      options.intervention,
      demandTemperatureC,
      includeExplanation(city.code),
    )
    const mobility = createDirectService(
      city,
      'mobility',
      hour,
      history.peakHazard,
      hazard,
      scenario,
      power.availability,
      1,
      options.intervention,
      demandTemperatureC,
      includeExplanation(city.code),
    )
    const services = {
      power,
      water: createDirectService(city, 'water', hour, history.peakHazard, hazard, scenario, power.availability, mobility.availability, options.intervention, demandTemperatureC, includeExplanation(city.code)),
      drainage: createDirectService(city, 'drainage', hour, history.peakHazard, hazard, scenario, power.availability, mobility.availability, options.intervention, demandTemperatureC, includeExplanation(city.code)),
      gas: createDirectService(city, 'gas', hour, history.peakHazard, hazard, scenario, power.availability, mobility.availability, options.intervention, demandTemperatureC, includeExplanation(city.code)),
      telecom: createDirectService(city, 'telecom', hour, history.peakHazard, hazard, scenario, power.availability, mobility.availability, options.intervention, demandTemperatureC, includeExplanation(city.code)),
      mobility,
      facilities: createDirectService(city, 'facilities', hour, history.peakHazard, hazard, scenario, power.availability, mobility.availability, options.intervention, demandTemperatureC, includeExplanation(city.code)),
      supply: createDirectService(city, 'supply', hour, history.peakHazard, hazard, scenario, power.availability, mobility.availability, options.intervention, demandTemperatureC, includeExplanation(city.code)),
    }
    citySnapshots.set(city.code, {
      id: city.code,
      name: city.name,
      coordinates: city.coordinates,
      population,
      hazard,
      services,
      systemPressure: 0,
      affectedPopulation: 0,
      deprivedPersonHours: 0,
      limitingService: 'supply',
      status: 'operational',
      explanation: {
        summary: 'Municipality aggregation is finalized after network balancing.',
        contributions: [],
        drivers: [],
        counterfactuals: [],
      },
    })
  }

  // Balance upstream services first, then recompute downstream dependencies from
  // those balanced values. This makes imported power improve pumping, telecom and
  // facilities, and imported mobility improve emergency-supply delivery.
  const transfersByService = new Map<ServiceId, Map<string, RouteTransfer>>()
  transfersByService.set('power', balanceNetwork(citySnapshots, network, hour, 'power', scenario, explanationMunicipalityIds))

  for (const city of municipalities) {
    const snapshot = citySnapshots.get(city.code)!
    snapshot.services.mobility = createDirectService(
      city,
      'mobility',
      hour,
      historyByCity.get(city.code)!.peakHazard,
      snapshot.hazard,
      scenario,
      snapshot.services.power.availability,
      1,
      options.intervention,
      historyByCity.get(city.code)!.demandTemperatureC,
      includeExplanation(city.code),
    )
  }
  transfersByService.set(
    'mobility',
    balanceNetwork(citySnapshots, network, hour, 'mobility', scenario, explanationMunicipalityIds),
  )

  for (const city of municipalities) {
    const snapshot = citySnapshots.get(city.code)!
    const powerAvailability = snapshot.services.power.availability
    const mobilityAvailability = snapshot.services.mobility.availability
    for (const service of serviceIds) {
      if (service === 'power' || service === 'mobility') continue
      snapshot.services[service] = createDirectService(
        city,
        service,
        hour,
        historyByCity.get(city.code)!.peakHazard,
        snapshot.hazard,
        scenario,
        powerAvailability,
        mobilityAvailability,
        options.intervention,
        historyByCity.get(city.code)!.demandTemperatureC,
        includeExplanation(city.code),
      )
    }
  }
  for (const service of serviceIds) {
    if (service === 'power' || service === 'mobility') continue
    transfersByService.set(
      service,
      balanceNetwork(citySnapshots, network, hour, service, scenario, explanationMunicipalityIds),
    )
  }

  for (const city of citySnapshots.values()) {
    const limitingService = serviceIds.reduce((lowest, service) =>
      city.services[service].availability < city.services[lowest].availability ? service : lowest,
    )
    const weightedAvailability = serviceIds.reduce(
      (sum, service) =>
        sum + city.services[service].availability * systemServiceWeights[service],
      0,
    )
    city.limitingService = limitingService
    city.systemPressure = 1 - weightedAvailability
    const baseAffectedPopulation = Math.round(
      city.population * clamp((0.86 - weightedAvailability) / 0.72),
    )
    const householdImpactMultiplier =
      1 + (0.5 - (scenario.householdPreparedness ?? 0.5)) * 0.24
    city.affectedPopulation = Math.min(
      city.population,
      Math.max(0, Math.round(baseAffectedPopulation * householdImpactMultiplier)),
    )
    city.deprivedPersonHours =
      (historyByCity.get(city.id)?.deprivedPersonHours ?? 0) * householdImpactMultiplier
    const hasActiveServiceRecovery = serviceIds.some(
      (service) => city.services[service].status === 'recovering',
    )
    city.status = statusForAvailability(weightedAvailability, hasActiveServiceRecovery)
    if (includeExplanation(city.id)) {
      for (const service of serviceIds) {
        city.services[service].explanation.dependencyChain = buildServiceDependencyChain(
          city,
          service,
        )
      }
      city.explanation = buildMunicipalityExplanation(city, scenario, baseAffectedPopulation)
    } else {
      city.explanation = {
        summary: 'Compact live frame; select this municipality for the complete system trace.',
        contributions: [],
        drivers: [],
        counterfactuals: [],
        attributionNote:
          'Numerical municipality state is complete; causal detail is materialized on selection.',
      }
    }
  }

  const materializedRouteServices = options.materializedRouteServices === undefined
    ? undefined
    : new Set(options.materializedRouteServices)
  const routesByService = Object.fromEntries(
    serviceIds.map((service) => [service, [] as RouteSnapshot[]]),
  ) as Record<ServiceId, RouteSnapshot[]>
  const activeBottleneckIds = new Set<string>()
  for (const service of serviceIds) {
    const snapshots = routeSnapshots(
      network,
      citySnapshots,
      hour,
      scenario,
      service,
      transfersByService.get(service),
    )
    for (const route of snapshots) {
      if (route.bottleneck) activeBottleneckIds.add(route.id)
    }
    if (materializedRouteServices === undefined || materializedRouteServices.has(service)) {
      routesByService[service] = snapshots
    }
  }
  const displayedService = serviceForLayer(options.selectedLayer)
  const routes = routesByService[displayedService]
  const cities = [...citySnapshots.values()]
  const population = cities.reduce((sum, city) => sum + city.population, 0)
  const affectedPopulation = cities.reduce((sum, city) => sum + city.affectedPopulation, 0)
  const averageAvailability =
    cities.reduce((sum, city) => sum + (1 - city.systemPressure) * city.population, 0) /
    Math.max(1, population)

  return {
    step: normalizedStep,
    minute: Math.round(hour * 60),
    hour,
    scenario,
    municipalities: cities,
    routes,
    routesByService,
    unsupportedHazardMunicipalities: cities
      .filter((city) => city.hazard.spatialEvidence === 'unsupported')
      .map((city) => city.id),
    national: {
      population,
      affectedPopulation,
      averageAvailability,
      criticalMunicipalities: cities.filter((city) => city.status === 'critical' || city.status === 'failed').length,
      activeBottlenecks: activeBottleneckIds.size,
      deprivedPersonHours: cities.reduce((sum, city) => sum + city.deprivedPersonHours, 0),
    },
  }
}

export function simulateFrame(
  municipalities: MunicipalityDefinition[],
  step: number,
  options: SimulationOptions,
  network = buildNationalNetwork(municipalities),
): SimulationFrame {
  return simulateFrameInternal(municipalities, step, options, network)
}

/**
 * Persistent frame engine for interactive clocks. Ascending requests reuse the
 * cumulative quarter-hour hazard/deprivation history; scenario changes or
 * backwards scrubs reset that cache without changing deterministic results.
 */
export function createSimulationSession(
  municipalities: MunicipalityDefinition[],
  network = buildNationalNetwork(municipalities),
) {
  let rollingHistory = new Map<string, ScenarioHistoryAccumulator>()
  let historyKey: string | undefined
  let previousStep = -1

  return {
    simulate(step: number, options: SimulationOptions): SimulationFrame {
      const normalizedStep = normalizeSimulationStep(step)
      const nextHistoryKey = JSON.stringify({
        intervention: options.intervention ?? 'baseline',
        scenario: resolveScenario(options.scenario),
      })
      if (historyKey !== nextHistoryKey || normalizedStep < previousStep) {
        rollingHistory = new Map<string, ScenarioHistoryAccumulator>()
      }
      historyKey = nextHistoryKey
      previousStep = normalizedStep
      return simulateFrameInternal(municipalities, normalizedStep, options, network, rollingHistory)
    },
    reset() {
      rollingHistory = new Map<string, ScenarioHistoryAccumulator>()
      historyKey = undefined
      previousStep = -1
    },
  }
}

/**
 * Simulates an ascending set of frames while reusing cumulative per-city
 * hazard history. This avoids recomputing every preceding quarter hour for
 * every chart sample. Returned steps are normalized, deduplicated and sorted.
 */
export function simulateFrames(
  municipalities: MunicipalityDefinition[],
  steps: readonly number[],
  options: SimulationOptions,
  network = buildNationalNetwork(municipalities),
): SimulationFrame[] {
  const normalizedSteps = [...new Set(steps.map(normalizeSimulationStep))].sort(
    (left, right) => left - right,
  )
  const rollingHistory = new Map<string, ScenarioHistoryAccumulator>()
  return normalizedSteps.map((step) =>
    simulateFrameInternal(municipalities, step, options, network, rollingHistory),
  )
}

const districtTemplates = [
  { id: 'centrum', name: 'Centrum', offset: [0, 0] as const, population: 0.22, priority: 1 as const },
  { id: 'noord', name: 'Noord', offset: [0, 0.72] as const, population: 0.17, priority: 2 as const },
  { id: 'oost', name: 'Oost', offset: [0.82, 0.12] as const, population: 0.16, priority: 2 as const },
  { id: 'zuid', name: 'Zuid', offset: [0.08, -0.78] as const, population: 0.16, priority: 3 as const },
  { id: 'west', name: 'West', offset: [-0.86, -0.06] as const, population: 0.16, priority: 2 as const },
  { id: 'rand', name: 'Buitengebied', offset: [-0.55, 0.62] as const, population: 0.13, priority: 3 as const },
]

interface LocalContextEffect {
  demandMultiplier: number
  activityDemandWeight: number
  vulnerabilityPressure: number
  contextCoverage: number
  contributions: CauseContribution[]
  drivers: DriverMetadata[]
}

function finiteNonNegative(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined
}

function localContextEffect(
  regionId: string,
  service: ServiceId,
  context: LocalRegionContext | undefined,
): LocalContextEffect {
  const ratio = (value: number | null | undefined) => {
    const finite = finiteNonNegative(value)
    return finite === undefined ? undefined : clamp(finite)
  }
  const age65Share = ratio(context?.age65Share)
  const onePersonShare = ratio(context?.onePersonHouseholdShare)
  const multiFamilyShare = ratio(context?.multiFamilyHomeShare)
  const socialAssistanceShare = ratio(context?.socialAssistanceShare)
  const carsPerHousehold = finiteNonNegative(context?.carsPerHousehold)
  const density = finiteNonNegative(context?.populationDensityPerKm2)
  const doctorDistance = finiteNonNegative(context?.distanceToDoctorKm)
  const supermarketDistance = finiteNonNegative(context?.distanceToSupermarketKm)
  const landArea = finiteNonNegative(context?.landAreaHa)
  const waterArea = finiteNonNegative(context?.waterAreaHa)
  const businesses = finiteNonNegative(context?.businesses)
  const nonResidentialBuildings = finiteNonNegative(context?.nonResidentialBuildings)
  const waterShare =
    landArea !== undefined && waterArea !== undefined && landArea + waterArea > 0
      ? waterArea / (landArea + waterArea)
      : undefined
  const coefficients: Record<
    string,
    { label: string; values: Partial<Record<ServiceId, number>>; description: string }
  > = {
    age65Share: {
      label: 'Residents aged 65+',
      values: { power: 0.08, water: 0.08, telecom: 0.06, facilities: 0.32, supply: 0.24 },
      description: 'Raises modeled continuity and assistance needs, especially for facilities and supplies.',
    },
    onePersonShare: {
      label: 'One-person households',
      values: { power: 0.04, telecom: 0.08, facilities: 0.12, supply: 0.22 },
      description: 'Raises modeled outreach and last-mile assistance needs.',
    },
    multiFamilyShare: {
      label: 'Multi-family homes',
      values: { power: 0.06, water: 0.04, drainage: 0.12, telecom: 0.04 },
      description: 'Acts as a transparent proxy for shared building systems and concentrated demand.',
    },
    socialAssistanceShare: {
      label: 'Social-assistance recipients',
      values: { telecom: 0.08, mobility: 0.12, facilities: 0.24, supply: 0.22 },
      description: 'Raises modeled assisted-mobility, facility and emergency-supply need.',
    },
    lowCarAccess: {
      label: 'Limited household car access',
      values: { mobility: 0.28, facilities: 0.1, supply: 0.24 },
      description: 'Raises dependence on public or assisted transport and local supply delivery.',
    },
    density: {
      label: 'Population density',
      values: { power: 0.06, drainage: 0.18, telecom: 0.08, mobility: 0.08 },
      description: 'Acts as a transparent proxy for concentrated loads and impervious urban area.',
    },
    doctorDistance: {
      label: 'Distance to general practitioner',
      values: { mobility: 0.16, facilities: 0.24 },
      description: 'Raises modeled health-access and assisted-transport need.',
    },
    supermarketDistance: {
      label: 'Distance to supermarket',
      values: { mobility: 0.1, supply: 0.24 },
      description: 'Raises modeled last-mile food and essential-supply need.',
    },
    waterShare: {
      label: 'Surface-water share',
      values: { drainage: 0.12, mobility: 0.05 },
      description: 'Acts as a coarse local exposure/context modifier, not a flood-depth estimate.',
    },
  }
  const signals: Array<{
    id: string
    rawValue: number | undefined
    unit: string
    normalized: number | undefined
  }> = [
    {
      id: 'age65Share',
      rawValue: age65Share,
      unit: 'share',
      normalized: age65Share === undefined ? undefined : clamp((age65Share - 0.12) / 0.28),
    },
    {
      id: 'onePersonShare',
      rawValue: onePersonShare,
      unit: 'share',
      normalized:
        onePersonShare === undefined ? undefined : clamp((onePersonShare - 0.2) / 0.5),
    },
    {
      id: 'multiFamilyShare',
      rawValue: multiFamilyShare,
      unit: 'share',
      normalized: multiFamilyShare,
    },
    {
      id: 'socialAssistanceShare',
      rawValue: socialAssistanceShare,
      unit: 'share',
      normalized:
        socialAssistanceShare === undefined ? undefined : clamp(socialAssistanceShare / 0.16),
    },
    {
      id: 'lowCarAccess',
      rawValue: carsPerHousehold,
      unit: 'cars/household',
      normalized:
        carsPerHousehold === undefined ? undefined : clamp((1.2 - carsPerHousehold) / 1.2),
    },
    {
      id: 'density',
      rawValue: density,
      unit: 'people/km²',
      normalized: density === undefined ? undefined : clamp(density / 5_000),
    },
    {
      id: 'doctorDistance',
      rawValue: doctorDistance,
      unit: 'km',
      normalized: doctorDistance === undefined ? undefined : clamp(doctorDistance / 5),
    },
    {
      id: 'supermarketDistance',
      rawValue: supermarketDistance,
      unit: 'km',
      normalized:
        supermarketDistance === undefined ? undefined : clamp(supermarketDistance / 5),
    },
    {
      id: 'waterShare',
      rawValue: waterShare,
      unit: 'share',
      normalized: waterShare === undefined ? undefined : clamp(waterShare / 0.35),
    },
  ]
  let demandMultiplier = 1
  let totalAdjustment = 0
  const availableSignals = signals.filter(
    (signal): signal is typeof signal & { rawValue: number; normalized: number } =>
      signal.rawValue !== undefined && signal.normalized !== undefined,
  )
  const contributions: CauseContribution[] = availableSignals.map((signal) => {
    const coefficient = coefficients[signal.id].values[service] ?? 0
    const before = demandMultiplier
    demandMultiplier = clamp(demandMultiplier + signal.normalized * coefficient, 0.7, 1.8)
    const effect = demandMultiplier - before
    totalAdjustment += Math.max(0, effect)
    return {
      id: `${regionId}:${service}:context:${signal.id}`,
      kind: 'vulnerability',
      label: coefficients[signal.id].label,
      target: 'service-demand',
      value: signal.rawValue,
      unit: signal.unit,
      normalizedValue: signal.normalized,
      effect,
      effectUnit: 'demand multiplier',
      direction: effectDirection(effect),
      method: 'exact-stage-delta',
      confidence: 'scenario',
      driverId: `context.${signal.id}`,
      description: `${coefficients[signal.id].description} This is an aggregate-area model assumption, not an individual-level inference.`,
    }
  })
  const drivers: DriverMetadata[] = availableSignals.map((signal) => ({
    id: `context.${signal.id}`,
    label: coefficients[signal.id].label,
    value: signal.rawValue,
    unit: signal.unit,
    role: 'observed-context',
    source: 'regional-input',
    editable: false,
    description: coefficients[signal.id].description,
  }))
  const activityCoefficients: Record<ServiceId, { business: number; building: number }> = {
    power: { business: 8, building: 3 },
    water: { business: 2, building: 1 },
    drainage: { business: 2, building: 2 },
    gas: { business: 3, building: 2 },
    telecom: { business: 6, building: 2 },
    mobility: { business: 12, building: 4 },
    facilities: { business: 1, building: 1 },
    supply: { business: 4, building: 2 },
  }
  const activityCoefficient = activityCoefficients[service]
  const activityDemandWeight =
    (businesses ?? 0) * activityCoefficient.business +
    (nonResidentialBuildings ?? 0) * activityCoefficient.building
  if (businesses !== undefined) {
    contributions.push({
      id: `${regionId}:${service}:context:businesses`,
      kind: 'demand',
      label: 'Registered establishments',
      target: 'service-demand',
      value: businesses,
      unit: 'businesses',
      normalizedValue: clamp(businesses / 250),
      effect: businesses * activityCoefficient.business,
      effectUnit: 'allocation-weight units',
      direction: businesses > 0 ? 'increases' : 'neutral',
      method: 'exact-stage-delta',
      confidence: 'scenario',
      driverId: 'context.businesses',
      description:
        'Adds an aggregate, service-specific non-residential allocation weight; it is not measured load, employment or operator capacity.',
    })
    drivers.push({
      id: 'context.businesses',
      label: 'Registered establishments',
      value: businesses,
      unit: 'businesses',
      role: 'observed-context',
      source: 'regional-input',
      editable: false,
      description: 'CBS aggregate used only to distribute municipal service demand across local areas.',
    })
  }
  if (nonResidentialBuildings !== undefined) {
    contributions.push({
      id: `${regionId}:${service}:context:nonResidentialBuildings`,
      kind: 'demand',
      label: 'Non-residential buildings',
      target: 'service-demand',
      value: nonResidentialBuildings,
      unit: 'buildings',
      normalizedValue: clamp(nonResidentialBuildings / 500),
      effect: nonResidentialBuildings * activityCoefficient.building,
      effectUnit: 'allocation-weight units',
      direction: nonResidentialBuildings > 0 ? 'increases' : 'neutral',
      method: 'exact-stage-delta',
      confidence: 'scenario',
      driverId: 'context.nonResidentialBuildings',
      description:
        'Adds a separate aggregate activity weight while preserving an official zero resident count; no occupancy or criticality is inferred.',
    })
    drivers.push({
      id: 'context.nonResidentialBuildings',
      label: 'Non-residential buildings',
      value: nonResidentialBuildings,
      unit: 'buildings',
      role: 'observed-context',
      source: 'regional-input',
      editable: false,
      description: 'CBS building stock used only as a transparent local demand-allocation proxy.',
    })
  }
  return {
    demandMultiplier,
    activityDemandWeight,
    vulnerabilityPressure: clamp(totalAdjustment / 0.8),
    contextCoverage:
      (availableSignals.length + Number(businesses !== undefined) + Number(nonResidentialBuildings !== undefined)) /
      (signals.length + 2),
    contributions,
    drivers,
  }
}

export function simulateCityDetail(
  city: MunicipalityDefinition,
  frame: SimulationFrame,
  layer: LayerId,
  regionDefinitions: LocalRegionDefinition[] = [],
): CityDetailFrame {
  const municipality = frame.municipalities.find((candidate) => candidate.id === city.code)
  if (!municipality) throw new Error(`Missing municipality snapshot for ${city.code}`)
  const service: ServiceId =
    layer === 'overview' || layer === 'hazard' || layer === 'population' ? municipality.limitingService : layer
  const cityState = municipality.services[service]
  const radiusKm = 2.4 + city.areaScale * 3.2
  const latScale = radiusKm / 111.32
  const lonScale = radiusKm / (111.32 * Math.cos((city.coordinates[1] * Math.PI) / 180))
  const suppliedRegions = regionDefinitions.filter(
    (definition) => definition.municipalityId === city.code,
  )
  const knownPopulations = suppliedRegions
    .map((definition) => definition.population)
    .filter(
      (population): population is number =>
        population !== null && Number.isFinite(population) && population > 0,
    )
  const missingPopulationWeight = knownPopulations.length
    ? knownPopulations.reduce((sum, population) => sum + population, 0) / knownPopulations.length
    : 1
  const rawRegions = suppliedRegions.length
    ? suppliedRegions.map((definition) => ({
        id: definition.id,
        name: definition.name,
        coordinates: definition.coordinates ?? geometryCentroid(definition.geometry),
        populationWeight:
          typeof definition.population === 'number' &&
          Number.isFinite(definition.population) &&
          definition.population >= 0
            ? definition.population
            : missingPopulationWeight,
        priority: definition.priority ?? (definition.isHub ? 1 : 2),
        isHub: definition.isHub ?? false,
        geometry: definition.geometry,
        sourceType: definition.sourceType ?? ('official' as const),
        context: definition.context,
      }))
    : districtTemplates.map((template, index) => ({
        id: `${city.code}-${template.id}`,
        name: template.name,
        coordinates: [
          city.coordinates[0] + template.offset[0] * lonScale,
          city.coordinates[1] + template.offset[1] * latScale,
        ] as Coordinates,
        populationWeight: template.population,
        priority: template.priority,
        isHub: index === 0,
        geometry: undefined,
        sourceType: 'fallback' as const,
        context: undefined,
      }))
  const explicitHubIndex = rawRegions.findIndex((region) => region.isHub)
  const priorityHubIndex = rawRegions.findIndex((region) => region.priority === 1)
  const hubIndex = explicitHubIndex >= 0
    ? explicitHubIndex
    : suppliedRegions.length
      ? -1
      : priorityHubIndex >= 0
        ? priorityHubIndex
        : 0
  const regions = hubIndex > 0
    ? [rawRegions[hubIndex], ...rawRegions.slice(0, hubIndex), ...rawRegions.slice(hubIndex + 1)]
    : rawRegions
  if (hubIndex >= 0) {
    regions[0].isHub = true
    regions[0].priority = 1
  }

  const populationWeightTotal = regions.reduce(
    (sum, region) => sum + Math.max(0, region.populationWeight),
    0,
  )
  const populationTargets = regions.map(
    (region) =>
      (municipality.population * Math.max(0, region.populationWeight)) /
      Math.max(1e-9, populationWeightTotal),
  )
  const allocatedPopulations = populationTargets.map((target) => Math.floor(target))
  let populationRemaining =
    municipality.population - allocatedPopulations.reduce((sum, population) => sum + population, 0)
  const populationRemainders = populationTargets
    .map((target, index) => ({ index, remainder: target - Math.floor(target) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (const entry of populationRemainders) {
    if (populationRemaining <= 0) break
    allocatedPopulations[entry.index] += 1
    populationRemaining -= 1
  }

  const contextEffects = regions.map((region) =>
    localContextEffect(region.id, service, region.context),
  )
  const demandWeights = regions.map(
    (_, index) =>
      allocatedPopulations[index] * contextEffects[index].demandMultiplier +
      contextEffects[index].activityDemandWeight,
  )
  const demandWeightTotal = demandWeights.reduce((sum, value) => sum + value, 0)
  const regionalDemandTargets = regions.map((_, index) =>
    demandWeightTotal > 0 ? cityState.demand * (demandWeights[index] / demandWeightTotal) : 0,
  )

  const districts: DistrictSnapshot[] = regions.map((region, index) => {
    const hazardSeed = seededUnit(city.seed ^ frame.scenario.seed, hashString(region.id))
    const serviceSeed = seededUnit(city.seed ^ frame.scenario.seed, hashString(region.id + service))
    const baseLocalDamage = municipality.hazard.peakSeverity * (0.08 + serviceSeed * 0.2)
    const contextEffect = contextEffects[index]
    const localDamage = baseLocalDamage * (1 + contextEffect.vulnerabilityPressure * 0.35)
    const priorityBonus = region.priority === 1 ? 0.08 : region.priority === 2 ? 0.03 : -0.02
    const availabilityAfterBaseDamage = clamp(cityState.availability - baseLocalDamage)
    const availabilityAfterContextDamage = clamp(cityState.availability - localDamage)
    const availability = clamp(availabilityAfterContextDamage + priorityBonus)
    const population = allocatedPopulations[index]
    const demand = regionalDemandTargets[index]
    const hazardSeverity = clamp(
      municipality.hazard.severity * (0.82 + hazardSeed * 0.36),
    )
    const priorityMultiplier = region.priority === 1 ? 1.18 : region.priority === 2 ? 1.04 : 0.9
    const contributions: CauseContribution[] = [
      ...contextEffect.contributions,
      {
        id: `${region.id}:${service}:context-damage`,
        kind: 'vulnerability',
        label: 'Aggregate-context exposure amplification',
        target: 'service-availability',
        value: contextEffect.vulnerabilityPressure,
        unit: 'vulnerability index',
        normalizedValue: contextEffect.vulnerabilityPressure,
        effect: availabilityAfterContextDamage - availabilityAfterBaseDamage,
        effectUnit: 'availability fraction',
        direction: effectDirection(availabilityAfterContextDamage - availabilityAfterBaseDamage),
        method: 'exact-stage-delta',
        confidence: 'scenario',
        driverId: 'context.aggregateVulnerability',
        description:
          'Aggregate regional context modestly scales modeled local branch exposure; it is not an individual risk score.',
      },
      {
        id: `${region.id}:${service}:priority`,
        kind: 'priority',
        label: `Priority ${region.priority} allocation`,
        target: 'local-allocation',
        value: priorityMultiplier,
        unit: '× allocation weight',
        normalizedValue: clamp(priorityMultiplier / 1.18),
        effect: availability - availabilityAfterContextDamage,
        effectUnit: 'pre-allocation availability fraction',
        direction: effectDirection(availability - availabilityAfterContextDamage),
        method: 'exact-stage-delta',
        confidence: 'scenario',
        driverId: 'context.priority',
        description: 'Operational priority changes the local allocation weight and branch allowance.',
      },
    ]
    const explanation: LocalAllocationExplanation = {
      service,
      populationShare: population / Math.max(1, municipality.population),
      demandMultiplier: contextEffect.demandMultiplier,
      activityDemandWeight: contextEffect.activityDemandWeight,
      demandShare: demand / Math.max(0.01, cityState.demand),
      vulnerabilityPressure: contextEffect.vulnerabilityPressure,
      priorityMultiplier,
      allocationWeight:
        demand *
        Math.max(0.06, availability) *
        priorityMultiplier *
        (1 + contextEffect.vulnerabilityPressure * 0.18),
      contextCoverage: contextEffect.contextCoverage,
      contributions,
      drivers: contextEffect.drivers,
      summary:
        contextEffect.contextCoverage > 0
          ? `${Math.round(contextEffect.contextCoverage * 100)}% of supported regional context fields are available; resident demand is weighted ${contextEffect.demandMultiplier.toFixed(2)}× and non-residential activity adds ${Math.round(contextEffect.activityDemandWeight)} separate allocation-weight units before municipality-total reconciliation.`
          : 'No regional vulnerability context is available; allocation uses population, branch exposure and operational priority only.',
    }
    return {
      id: region.id,
      municipalityId: city.code,
      name: region.name,
      coordinates: region.coordinates,
      population,
      availability,
      demand,
      delivered: demand * availability,
      hazardSeverity,
      affectedPopulation: 0,
      reserveHours: Math.max(0, cityState.reserveHours * (0.72 + serviceSeed * 0.52)),
      status: statusForAvailability(availability, cityState.status === 'recovering'),
      cause:
        availability < cityState.availability - 0.04
          ? `Local ${service} branch is exposed; upstream gateway is also constrained`
          : cityState.cause,
      isHub: region.isHub,
      priority: region.priority,
      geometry: region.geometry,
      sourceType: region.sourceType,
      explanation,
    }
  })

  const affectedWeights = districts.map(
    (district) =>
      district.population *
      (0.72 + district.hazardSeverity * 0.56) *
      (1 + district.explanation.vulnerabilityPressure * 0.4),
  )
  const affectedWeightTotal = affectedWeights.reduce((sum, value) => sum + value, 0)
  const affectedAllocation = districts.map((district, index) => {
    const target =
      (municipality.affectedPopulation * affectedWeights[index]) /
      Math.max(1, affectedWeightTotal)
    return Math.min(district.population, Math.floor(target))
  })
  let affectedRemaining =
    municipality.affectedPopulation - affectedAllocation.reduce((sum, value) => sum + value, 0)
  const affectedOrder = districts
    .map((district, index) => ({
      index,
      remainder:
        (municipality.affectedPopulation * affectedWeights[index]) /
          Math.max(1, affectedWeightTotal) -
        affectedAllocation[index],
      capacity: district.population - affectedAllocation[index],
    }))
    .sort((left, right) => right.remainder - left.remainder)
  while (affectedRemaining > 0) {
    let changed = false
    for (const entry of affectedOrder) {
      if (entry.capacity <= 0 || affectedRemaining <= 0) continue
      affectedAllocation[entry.index] += 1
      entry.capacity -= 1
      affectedRemaining -= 1
      changed = true
    }
    if (!changed) break
  }
  districts.forEach((district, index) => {
    district.affectedPopulation = affectedAllocation[index]
  })

  // The national gateway delivery is the city's hard upstream budget. Local
  // priorities and damage determine its distribution, while zooming into a city
  // cannot create or destroy supply relative to the national frame.
  const localDemand = districts.reduce((sum, district) => sum + district.demand, 0)
  const inboundSupply = Math.min(cityState.delivered, localDemand)
  let supplyRemaining = Math.min(inboundSupply, localDemand)
  let eligible = districts.map((_, index) => index)
  const allocation = districts.map(() => 0)

  while (supplyRemaining > 1e-9 && eligible.length) {
    const weightSum = eligible.reduce((sum, index) => {
      const district = districts[index]
      const priorityWeight = district.priority === 1 ? 1.18 : district.priority === 2 ? 1.04 : 0.9
      const vulnerabilityWeight = 1 + district.explanation.vulnerabilityPressure * 0.18
      return (
        sum +
        district.demand *
          Math.max(0.06, district.availability) *
          priorityWeight *
          vulnerabilityWeight
      )
    }, 0)
    let allocatedThisPass = 0
    const stillEligible: number[] = []

    for (const index of eligible) {
      const district = districts[index]
      const priorityWeight = district.priority === 1 ? 1.18 : district.priority === 2 ? 1.04 : 0.9
      const vulnerabilityWeight = 1 + district.explanation.vulnerabilityPressure * 0.18
      const weight =
        district.demand *
        Math.max(0.06, district.availability) *
        priorityWeight *
        vulnerabilityWeight
      const share = weightSum > 0 ? (supplyRemaining * weight) / weightSum : supplyRemaining / eligible.length
      const headroom = district.demand - allocation[index]
      const granted = Math.min(headroom, share)
      allocation[index] += granted
      allocatedThisPass += granted
      if (headroom - granted > 1e-9) stillEligible.push(index)
    }

    supplyRemaining -= allocatedThisPass
    if (allocatedThisPass <= 1e-9) break
    eligible = stillEligible
  }

  districts.forEach((district, index) => {
    district.delivered = allocation[index]
    // An official zero-population area has no population-derived demand in this
    // model. Keep its modeled branch state; 0/0 is not a service failure.
    district.availability = district.demand <= 1e-9
      ? district.availability
      : clamp(district.delivered / district.demand)
    district.status = statusForAvailability(
      district.availability,
      cityState.status === 'recovering',
    )
    district.explanation.allocationWeight =
      district.demand *
      Math.max(0.06, district.availability) *
      district.explanation.priorityMultiplier *
      (1 + district.explanation.vulnerabilityPressure * 0.18)
    district.explanation.summary = `${district.explanation.summary} Final delivery is ${(district.availability * 100).toFixed(1)}% of modeled local ${service} demand.`
  })

  const allocationAnchor = districts[0]
  // Official CBS areas do not establish a physical local network. Only the
  // geometry-free fallback emits an explicitly synthetic star graph.
  const links = (suppliedRegions.length ? [] : districts.slice(1)).map((district, index) => {
    const nominalCapacity = district.demand * (0.9 + seededUnit(city.seed, index + 44) * 0.35)
    const capacity = Math.max(district.delivered, nominalCapacity)
    const utilization = clamp(district.delivered / Math.max(0.01, capacity))
    return {
      id: `${allocationAnchor.id}--${district.id}`,
      from: allocationAnchor.id,
      to: district.id,
      coordinates: [allocationAnchor.coordinates, district.coordinates] as RouteDefinition['coordinates'],
      capacity,
      utilization,
      status: district.status,
      bottleneck: utilization > 0.88 || district.availability < 0.5,
    }
  })
  const localDelivered = districts.reduce((sum, district) => sum + district.delivered, 0)

  return {
    municipality,
    districts,
    links,
    inboundSupply,
    localDemand,
    reconciliationError: Math.abs(inboundSupply - localDelivered),
  }
}

export function formatSimulationTime(step: number): string {
  const minutes = normalizeSimulationStep(step) * MINUTES_PER_STEP
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `T+${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

export function validateStep(step: number) {
  return Number.isInteger(step) && step >= 0 && step < TIMELINE_STEPS
}

export { MAX_HOURS, TIMELINE_STEPS, MINUTES_PER_STEP, statusColors }
