export const TIMELINE_STEPS = 289
export const MINUTES_PER_STEP = 15
export const MAX_HOURS = 72
/** Scenario forcing may begin inside the operational window and continue beyond it. */
export const MAX_SCENARIO_DURATION_HOURS = 24 * 14

export const layerIds = [
  'overview',
  'hazard',
  'power',
  'water',
  'drainage',
  'gas',
  'telecom',
  'mobility',
  'facilities',
  'population',
  'supply',
] as const

export type LayerId = (typeof layerIds)[number]
export type ServiceId = Exclude<LayerId, 'overview' | 'hazard' | 'population'>
export type Coordinates = [longitude: number, latitude: number]

export const hazardDimensionIds = [
  'rain',
  'flood',
  'wind',
  'heat',
  'cold',
  'snowIce',
  'drought',
  'fire',
  'smoke',
  'groundMotion',
  'cyber',
] as const

export type HazardDimension = (typeof hazardDimensionIds)[number]
export type ExplanationConfidence = 'high' | 'medium' | 'scenario'
export type ExplanationTarget =
  | 'hazard-severity'
  | 'service-availability'
  | 'service-demand'
  | 'system-pressure'
  | 'affected-population'
  | 'local-allocation'
export type ContributionKind =
  | 'baseline'
  | 'hazard'
  | 'climate'
  | 'dependency'
  | 'recovery'
  | 'resilience'
  | 'intervention'
  | 'network'
  | 'demand'
  | 'vulnerability'
  | 'priority'
  | 'geography'

/**
 * A signed, inspectable term in a model result. `effect` always means
 * `targetAfter - targetBefore`; its unit is named by `effectUnit`.
 */
export interface CauseContribution {
  id: string
  kind: ContributionKind
  label: string
  target: ExplanationTarget
  /** The raw model input or intermediate value behind this contribution. */
  value: number
  unit: string
  /** A bounded 0..1 representation where the model defines one. */
  normalizedValue?: number
  /** Signed target delta applied by this term. */
  effect: number
  effectUnit: string
  direction: 'increases' | 'decreases' | 'neutral'
  method:
    | 'exact-stage-delta'
    | 'exact-one-at-a-time-counterfactual'
    | 'proportional-attribution'
    | 'input-observation'
  confidence: ExplanationConfidence
  driverId?: string
  description: string
}

export interface DriverMetadata {
  id: string
  label: string
  value: number | string
  unit: string
  role: 'scenario-control' | 'observed-context' | 'derived-state' | 'model-parameter'
  source: 'scenario-input' | 'municipality-input' | 'regional-input' | 'derived-model-state'
  editable: boolean
  scenarioField?: keyof ScenarioConfig | `climate.${keyof ClimateSettings}`
  description: string
}

export interface CounterfactualResult {
  id: string
  label: string
  question: string
  observedValue: number
  counterfactualValue: number
  /** `counterfactualValue - observedValue`. */
  delta: number
  unit: string
  changedDriverIds: string[]
  method: 'exact-model-rerun' | 'exact-stage-substitution'
  confidence: ExplanationConfidence
}

export type CausalNodeId =
  | `hazard:${HazardDimension}`
  | `service:${ServiceId}`
  | `context:${string}`

export interface DependencyNode {
  id: CausalNodeId
  kind: 'hazard' | 'service' | 'context'
  label: string
  value: number
  unit: string
}

export interface DependencyEdge {
  id: string
  from: CausalNodeId
  to: CausalNodeId
  mechanism: 'direct-exposure' | 'operational-dependency'
  /** Dependency multiplier applied to downstream availability, 0..1. */
  multiplier: number
  /** Signed downstream availability delta caused by this edge. */
  effect: number
  active: boolean
  backupActive?: boolean
  backupRemainingHours?: number
  description: string
}

export interface DependencyChain {
  nodes: DependencyNode[]
  edges: DependencyEdge[]
}

export interface HazardExplanation {
  summary: string
  dominantDimension: HazardDimension | null
  contributions: CauseContribution[]
  drivers: DriverMetadata[]
  counterfactuals: CounterfactualResult[]
  /** Documents why dimension effects add to severity but are not empirical attribution. */
  attributionNote: string
}

export interface ServiceDependencyEffect {
  upstreamService: ServiceId
  upstreamAvailability: number
  multiplier: number
  availabilityBefore: number
  availabilityAfter: number
  effect: number
  backupActive: boolean
  backupWindowHours?: number
  backupRemainingHours?: number
  description: string
}

export interface ServiceExplanation {
  summary: string
  baselineResilience: number
  directHazardPressure: number
  recoveryProgress: number
  availabilityBeforeNetwork: number
  observedAvailability: number
  demandMultiplier: number
  contributions: CauseContribution[]
  dependencies: ServiceDependencyEffect[]
  dependencyChain: DependencyChain
  drivers: DriverMetadata[]
  counterfactuals: CounterfactualResult[]
  attributionNote?: string
}

export interface MunicipalityExplanation {
  summary: string
  contributions: CauseContribution[]
  drivers: DriverMetadata[]
  counterfactuals: CounterfactualResult[]
  attributionNote?: string
}

export const scenarioPresetIds = [
  'severe-storm',
  'pluvial-flood',
  'river-flood',
  'coastal-flood',
  'heatwave',
  'winter-storm',
  'cyberattack',
  'earthquake',
  'wildfire',
  'compound',
] as const

export type ScenarioPresetId = (typeof scenarioPresetIds)[number]
export type DisasterType = Exclude<ScenarioPresetId, 'compound'> | 'compound'
export type Season = 'winter' | 'spring' | 'summer' | 'autumn'
export type DayType = 'weekday' | 'weekend' | 'holiday'
export type KNMIClimatePath = 'reference' | 'Ld' | 'Ln' | 'Md' | 'Mn' | 'Hd' | 'Hn'
export type ClimateHorizon = 'current' | 2033 | 2050 | 2100 | 2150

export interface ClimateSettings {
  /** KNMI'23 path, or `reference` for the 1991-2020 climate. */
  path: KNMIClimatePath
  horizon: ClimateHorizon
  /**
   * Optional transparent overrides for sensitivity analysis. They replace the
   * built-in KNMI-inspired transform and remain model assumptions.
   */
  temperatureDeltaC?: number
  precipitationMultiplier?: number
  seaLevelDeltaM?: number
}

export interface ScenarioConfig {
  id: string
  name: string
  disaster: DisasterType
  /** Components used by compound scenarios; ignored for single-hazard presets. */
  components?: Exclude<DisasterType, 'compound'>[]
  season: Season
  climate: ClimateSettings
  /** Dimensionless scenario forcing, bounded to 0..1 by the engine. */
  intensity: number
  /** Visible forcing duration in hours. */
  durationHours: number
  /** Hour at which the initiating event begins on the 72-hour clock. */
  startHour: number
  /** Preparedness and response readiness, bounded to 0..1. */
  preparedness: number
  /** Delay before organized restoration begins. */
  responseDelayHours: number
  /** Stable scenario seed. No runtime random draws are used. */
  seed: number
  /** Optional explicit cyber targets or geographic focus. */
  targetMunicipalityIds?: string[]
  epicenter?: Coordinates
  /** Operations context; omitted fields retain the original engine baseline. */
  dayType?: DayType
  /** Local clock time corresponding to T+00, bounded to 0..23. */
  startClockHour?: number
  /**
   * Optional ISO calendar date (YYYY-MM-DD) for validity-aware public records.
   * When omitted, the run is a calendar-unbound exercise and current/planned
   * observations must not silently affect it.
   */
  referenceDate?: string
  /** Scenario-wide multiplier on service demand, bounded to 0.25..2.5. */
  demandMultiplier?: number
  /** Multiplier on modeled backup endurance and reserves, bounded to 0.25..3. */
  backupMultiplier?: number
  /** Multiplier on intermunicipal route capacity, bounded to 0..3. */
  networkCapacityMultiplier?: number
  /** Multiplier on restoration rate, bounded to 0.25..3. */
  repairCapacityMultiplier?: number
  /** Household readiness, 0..1; changes human need and supply, not asset fragility. */
  householdPreparedness?: number
}
export type OperationalStatus =
  | 'operational'
  | 'strained'
  | 'degraded'
  | 'critical'
  | 'failed'
  | 'recovering'

export interface MunicipalityProperties {
  code: string
  name: string
  center?: Coordinates | null
  population: number | null
  density: number | null
  age65Pct: number | null
  onePersonHouseholds: number | null
  boundaryEdition: number
  statisticsEdition: number
}

export interface MunicipalityDefinition extends MunicipalityProperties {
  coordinates: Coordinates
  areaScale: number
  seed: number
}

export interface MunicipalityCollection {
  type: 'FeatureCollection'
  name?: string
  source?: Record<string, unknown>
  features: Array<{
    type: 'Feature'
    id?: string
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
    properties: MunicipalityProperties
  }>
}

export interface RouteDefinition {
  id: string
  /** Publisher route label after physical-corridor normalization. */
  name?: string
  source?: string
  sourceUrl?: string
  geometrySource?: string
  statusSourceUrl?: string
  /** Explains why static register geometry is not a live/scenario operating state. */
  statusSemantics?: string
  /** Publisher limits retained as physical context; never interpreted as route throughput. */
  operatorPhysicalLimits?: {
    loadCapacityTonnes: number
    maxVehicleWeightTonnes: number
    sourceUrl: string
    retrievedAt: string
    simulationEffect: 'context-only'
    note: string
  }
  /** Human-readable operating observation without enough valid-time metadata for simulation. */
  observedOperationalStatus?: {
    state: 'reported-temporarily-out-of-service'
    reason: string
    publisher: string
    sourceUrl: string
    retrievedAt: string
    issueTime: null
    validThrough: null
    machineReadable: false
    simulationEffect: 'context-only'
    temporalSemantics: string
  }
  /** Published recurring hours retained for traceability until the scenario has a local start time. */
  publishedScheduleContext?: {
    timeZone: 'Europe/Amsterdam'
    sourceUrl: string
    retrievedAt: string
    simulationEffect: 'context-only'
    periods: Array<{
      dateRange: string
      mondayToFriday: string
      saturday: string
      sundayAndHolidays: string
    }>
    note: string
  }
  audit?: string | string[]
  from: string
  to: string
  /** Complete path geometry from `from` to `to`, including intermediate points. */
  coordinates: Coordinates[]
  nominalCapacity: number
  mode: 'trunk' | 'regional' | 'local' | 'ferry'
  distanceKm: number
  /** Signed or European route identifiers represented by this physical crossing. */
  aliases?: string[]
  /** Traceable publisher feature identifiers contributing to this logical crossing. */
  sourceFeatureIds?: string[]
  /** Signed road labels retained from contributing NWB sections (for example A2). */
  sourceSignedRoadNumbers?: string[]
  /** Administrative road identities retained from NWB (for example RW2). */
  sourceAdministrativeRoadNumbers?: string[]
  /** NWB road-part classes retained as provenance (for example HR or OPR). */
  sourceRoadPartClasses?: string[]
  /** Non-capacity identity used to prevent route co-designations becoming additive edges. */
  physicalCorridorId?: string
  /** Ambiguous means NWB road number alone cannot distinguish signed A/N designations. */
  corridorIdentityStatus?: 'resolved' | 'ambiguous'
  /** Omitted for legacy logical corridors; otherwise limits this edge to named services. */
  supportedServices?: ServiceId[]
  /** False keeps verified topology visible as context while excluding it from causal transfers. */
  affectsSimulation?: boolean
  /** Unknown means no defensible scenario capacity is available; such routes must be non-causal. */
  capacitySemantics?: 'scenario-units' | 'unknown'
  /** Public, time-bounded operating restrictions; applied only to a calendar-bound run. */
  operationalRestrictions?: RouteOperationalRestriction[]
  /** Audit proof when one physical section participates in consecutive graph edges, never parallel capacity. */
  sharedSectionProvenance?: {
    sourceFeatureId: string
    relation: 'series-corridor'
    routes: string[]
    audit: string
    note: string
  }
}

export interface RouteOperationalRestriction {
  id: string
  state: 'closed' | 'vehicle-class-restricted'
  /** Full closures may alter the logical edge; uncalibrated class limits remain context-only. */
  simulationEffect: 'close-route' | 'context-only'
  /** Inclusive ISO dates. */
  validFrom: string
  validThrough: string
  affectedServices: ServiceId[]
  scope: string
  publisher: string
  sourceUrl: string
  retrievedAt: string
  evidenceClass: 'official-observation' | 'official-plan'
  affectedVehicleClasses?: string[]
  unaffectedVehicleClasses?: string[]
  detours?: string[]
  note?: string
}

export interface RouteSnapshot extends RouteDefinition {
  /** Modeled balancing path, never a claim of physical utility topology. */
  transferSemantics: 'logical-proxy'
  /** Restriction used for this frame, if the scenario reference date overlaps it. */
  activeRestriction?: RouteOperationalRestriction
  /** Complete path oriented in the actual direction of flow. */
  flowCoordinates: Coordinates[]
  effectiveCapacity: number
  utilization: number
  health: number
  flow: number
  flowDirection: -1 | 0 | 1
  status: OperationalStatus
  bottleneck: boolean
  color: string
}

export interface HazardState {
  disaster: DisasterType
  components: Exclude<DisasterType, 'compound'>[]
  rainMmH: number
  /**
   * Legacy depth-like model amplitude. It is not a surveyed or hydraulic-model
   * water depth; user-facing consumers should present normalized flood stress.
   */
  floodDepthM: number
  windGustMs: number
  /** Air temperature; retained as `heatC` for backwards-compatible consumers. */
  heatC: number
  snowCmH: number
  iceSeverity: number
  coldStress: number
  droughtSeverity: number
  wildfireIntensity: number
  smokeSeverity: number
  groundMotionG: number
  cyberDisruption: number
  climateTemperatureDeltaC: number
  climatePrecipitationMultiplier: number
  climateSeaLevelDeltaM: number
  severity: number
  peakSeverity: number
  /** Spatial support behind the local hazard amplitude; optional for legacy fixtures. */
  spatialEvidence?: 'official-scenario' | 'derived-screening' | 'synthetic' | 'unsupported'
  /** Specific normalized dimensions that are known to be spatially unresolved. */
  unsupportedDimensions?: HazardDimension[]
  /** Human-readable limitation when a numerical result cannot be defended as local evidence. */
  evidenceNote?: string
}

export interface ExplainedHazardState extends HazardState {
  explanation: HazardExplanation
}

export interface ServiceState {
  availability: number
  demand: number
  delivered: number
  reserveHours: number
  status: OperationalStatus
  bottleneckLabel: string
  cause: string
  confidence: 'high' | 'medium' | 'scenario'
}

export interface ExplainedServiceState extends ServiceState {
  explanation: ServiceExplanation
}

export interface MunicipalitySnapshot {
  id: string
  name: string
  coordinates: Coordinates
  population: number
  hazard: ExplainedHazardState
  services: Record<ServiceId, ExplainedServiceState>
  systemPressure: number
  /** Model-equivalent population under service pressure; not an observed headcount. */
  affectedPopulation: number
  /**
   * Quarter-hour integral of weighted local essential-service shortfall,
   * before intermunicipal transfers and adjusted for household preparedness.
   */
  deprivedPersonHours: number
  limitingService: ServiceId
  status: OperationalStatus
  explanation: MunicipalityExplanation
}

export interface SimulationFrame {
  step: number
  minute: number
  hour: number
  scenario: ScenarioConfig
  municipalities: MunicipalitySnapshot[]
  /** Legacy projection for the currently selected visual service. */
  routes: RouteSnapshot[]
  /** Canonical route state for every service, independent from map selection. */
  routesByService: Record<ServiceId, RouteSnapshot[]>
  /** Municipalities whose selected hazard has a known but not-yet-ingested pathway. */
  unsupportedHazardMunicipalities?: string[]
  national: {
    population: number
    affectedPopulation: number
    averageAvailability: number
    criticalMunicipalities: number
    activeBottlenecks: number
    /** Sum of municipal local-service deprivation proxies. */
    deprivedPersonHours: number
  }
}

export interface DistrictSnapshot {
  id: string
  municipalityId: string
  name: string
  coordinates: Coordinates
  population: number
  availability: number
  demand: number
  delivered: number
  hazardSeverity: number
  affectedPopulation: number
  reserveHours: number
  status: OperationalStatus
  cause: string
  isHub: boolean
  priority: 1 | 2 | 3
  geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon
  sourceType?: 'official' | 'derived' | 'fallback'
  explanation: LocalAllocationExplanation
}

export interface LocalRegionContext {
  /** Fraction of residents aged 65+, bounded to 0..1 by the engine. */
  age65Share?: number | null
  /** Fraction of households occupied by one person, bounded to 0..1. */
  onePersonHouseholdShare?: number | null
  /** Fraction of homes in multi-family buildings, bounded to 0..1. */
  multiFamilyHomeShare?: number | null
  /** Recipients as a fraction of residents, bounded to 0..1. */
  socialAssistanceShare?: number | null
  /** Registered passenger cars per household. */
  carsPerHousehold?: number | null
  populationDensityPerKm2?: number | null
  distanceToDoctorKm?: number | null
  distanceToSupermarketKm?: number | null
  landAreaHa?: number | null
  waterAreaHa?: number | null
  /** Aggregate establishments; used only as a local demand-allocation proxy. */
  businesses?: number | null
  /** Aggregate non-residential building stock; not floor area or occupancy. */
  nonResidentialBuildings?: number | null
}

export interface LocalAllocationExplanation {
  service: ServiceId
  populationShare: number
  demandMultiplier: number
  /** Non-residential allocation-weight units, kept separate from residents. */
  activityDemandWeight?: number
  demandShare: number
  vulnerabilityPressure: number
  priorityMultiplier: number
  allocationWeight: number
  contextCoverage: number
  contributions: CauseContribution[]
  drivers: DriverMetadata[]
  summary: string
}

export interface LocalRegionDefinition {
  id: string
  municipalityId: string
  name: string
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  coordinates?: Coordinates
  population: number | null
  priority?: 1 | 2 | 3
  isHub?: boolean
  sourceType?: 'official' | 'derived'
  /** Optional official aggregate context; missing fields have neutral effect. */
  context?: LocalRegionContext
}

export interface CityDetailFrame {
  municipality: MunicipalitySnapshot
  districts: DistrictSnapshot[]
  links: Array<{
    id: string
    from: string
    to: string
    coordinates: Coordinates[]
    capacity: number
    utilization: number
    status: OperationalStatus
    bottleneck: boolean
  }>
  inboundSupply: number
  localDemand: number
  reconciliationError: number
}

export interface SimulationOptions {
  selectedLayer: LayerId
  intervention?: 'baseline' | 'generator-priority' | 'mutual-aid'
  /** Defaults to the severe-storm preset for backwards compatibility. */
  scenario?: ScenarioConfig | ScenarioPresetId
  /**
   * Optional live-view projection. Numerical state remains complete, while
   * causal explanation trees are materialized only for these municipalities.
   * Omit this field to retain the fully explained research/audit frame.
   */
  explanationMunicipalityIds?: readonly string[]
  /**
   * Optional live-view projection for route snapshots. Network balancing and
   * national bottleneck counts still cover every service; only these route
   * arrays are retained on the returned frame. Omit to retain all services.
   */
  materializedRouteServices?: readonly ServiceId[]
}

export const hazardHistoryMetricIds = [
  'rainMmH',
  'floodDepthM',
  'windGustMs',
  'heatC',
  'snowCmH',
  'iceSeverity',
  'coldStress',
  'droughtSeverity',
  'wildfireIntensity',
  'smokeSeverity',
  'groundMotionG',
  'cyberDisruption',
  'climateTemperatureDeltaC',
  'climatePrecipitationMultiplier',
  'climateSeaLevelDeltaM',
  'severity',
  'peakSeverity',
] as const

export type HazardHistoryMetricId = (typeof hazardHistoryMetricIds)[number]
export const serviceHistoryMetricIds = [
  'availability',
  'demand',
  'delivered',
  'reserveHours',
] as const
export type ServiceHistoryMetricId = (typeof serviceHistoryMetricIds)[number]

export interface MunicipalityHistorySnapshot {
  id: string
  name: string
  population: number
  hazard: Record<HazardHistoryMetricId, number>
  services: Record<ServiceId, Record<ServiceHistoryMetricId, number>>
  systemPressure: number
  affectedPopulation: number
  deprivedPersonHours: number
}

export interface SimulationHistoryPoint {
  step: number
  minute: number
  hour: number
  municipalities: MunicipalityHistorySnapshot[]
  national: SimulationFrame['national']
}

export interface SimulationHistory {
  scenario: ScenarioConfig
  startStep: number
  endStep: number
  intervalSteps: number
  networkMode: 'full' | 'isolated'
  /** Clarifies whether `point.national` is truly national or selected-scope aggregate. */
  aggregateScope: 'national-network' | 'selected-municipalities'
  points: SimulationHistoryPoint[]
}

export interface SimulationHistoryOptions {
  startStep?: number
  endStep?: number
  intervalSteps?: number
  /** Output filter only; the full municipality network is still simulated. */
  municipalityIds?: readonly string[]
  network?: RouteDefinition[]
  /**
   * `isolated` simulates only requested municipalities without transfers and is
   * intended for responsive charts. `full` retains national network balancing.
   */
  networkMode?: 'full' | 'isolated'
}

export interface ChartPoint {
  step: number
  minute: number
  hour: number
  value: number
}

export interface ChartSeries {
  id: string
  label: string
  unit: string
  category: 'hazard' | 'service' | 'municipality' | 'national'
  municipalityId?: string
  service?: ServiceId
  metric: string
  points: ChartPoint[]
}
