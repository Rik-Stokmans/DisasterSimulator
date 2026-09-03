import type { Feature, FeatureCollection, LineString, MultiLineString, Point, Polygon, MultiPolygon } from 'geojson'
import type {
  Coordinates,
  LocalRegionDefinition,
  RouteDefinition,
  RouteOperationalRestriction,
} from '@disaster/sim-core'

export interface RegionalStatistics {
  population: number | null
  men: number | null
  women: number | null
  age0To14: number | null
  age15To24: number | null
  age25To44: number | null
  age45To64: number | null
  age65Plus: number | null
  households: number | null
  onePersonHouseholds: number | null
  householdsWithoutChildren: number | null
  householdsWithChildren: number | null
  averageHouseholdSize: number | null
  populationDensity: number | null
  homes: number | null
  nonResidentialBuildings: number | null
  averageHomeValueThousands: number | null
  singleFamilyHomePct: number | null
  multiFamilyHomePct: number | null
  ownerOccupiedPct: number | null
  rentalPct: number | null
  socialRentalPct: number | null
  districtHeatingPct: number | null
  publicChargingPoints: number | null
  socialAssistanceRecipients: number | null
  disabilityBenefitRecipients: number | null
  oldAgePensionRecipients: number | null
  businesses: number | null
  cars: number | null
  carsPerHousehold: number | null
  distanceToDoctorKm: number | null
  distanceToSupermarketKm: number | null
  landAreaHa: number | null
  waterAreaHa: number | null
  urbanityClass: number | null
  addressDensity: number | null
}

export interface NeighborhoodProperties {
  id: string
  name: string
  kind: 'buurt'
  municipalityCode: string
  districtCode: string
  districtName: string | null
  center: Coordinates | null
  statistics: RegionalStatistics
}

export interface PlaceProperties {
  id: string
  name: string
  kind: 'woonplaats'
  municipalityCode: string
  province: string
  status: string
  center: Coordinates | null
}

export interface SettlementProperties {
  id: string
  name: string
  settlementType: 'woonkern' | 'deelkern' | 'gehucht' | 'buurtschap'
  population: number | null
  builtUp: boolean
  bagPlace: boolean
  municipalityCode: string
  municipalityName: string
  sourceDate: string
  sourceCollection: string
  assignmentMethod: string
}

export interface MunicipalityRegionBundle {
  municipalityCode: string
  municipalityName: string
  edition: number
  source: Record<string, string | number>
  neighborhoods: FeatureCollection<Polygon | MultiPolygon, NeighborhoodProperties>
  places: FeatureCollection<Polygon | MultiPolygon, PlaceProperties>
  settlements: FeatureCollection<Polygon | MultiPolygon, SettlementProperties>
  operationalBoundary?: FeatureCollection<Polygon | MultiPolygon, {
    code: string
    name: string
    edition: number
    evidenceClass: 'official-context'
    sourceCollection: string
  }>
}

export interface TransportData {
  roads: FeatureCollection<LineString | MultiLineString>
  rail: FeatureCollection<LineString | MultiLineString>
  stations: FeatureCollection<Point>
  routes: RouteDefinition[]
  source: Record<string, string>
}

interface PublicRouteRestrictionDataset {
  source: Record<string, string>
  restrictions: Array<{
    match: {
      from: string
      to: string
      name?: string
      sourceFeatureIdsAny?: string[]
    }
    restriction: RouteOperationalRestriction
  }>
}

export function mergePublicRouteRestrictions(
  routes: RouteDefinition[],
  dataset: PublicRouteRestrictionDataset,
): RouteDefinition[] {
  return routes.map((route) => {
    const additions = dataset.restrictions
      .filter(({ match }) => {
        const endpointsMatch =
          (route.from === match.from && route.to === match.to) ||
          (route.from === match.to && route.to === match.from)
        if (!endpointsMatch || (match.name && route.name !== match.name)) return false
        if (!match.sourceFeatureIdsAny?.length) return true
        return match.sourceFeatureIdsAny.some((id) => route.sourceFeatureIds?.includes(id))
      })
      .map(({ restriction }) => restriction)
    if (!additions.length) return route
    return {
      ...route,
      operationalRestrictions: [
        ...(route.operationalRestrictions ?? []),
        ...additions.filter(
          (addition) => !route.operationalRestrictions?.some((item) => item.id === addition.id),
        ),
      ],
    }
  })
}

export interface TransitRouteData {
  bus: FeatureCollection<LineString>
  urbanRail: FeatureCollection<LineString>
  railServices: FeatureCollection<LineString>
  ferries: FeatureCollection<LineString>
}

export type PublicWaterAssetType =
  | 'surface-water-pump'
  | 'weir'
  | 'sluice'
  | 'sewer-pump'
  | 'wastewater-treatment'

export interface PublicWaterAssetProperties {
  assetType: PublicWaterAssetType
  name: string | null
  code: string | null
  manager: string | null
  status: string | null
  function: string | null
  capacity: number | null
  registeredAt: string | null
  sourceId: 'imwa-water-control' | 'damo-wastewater'
  sourceCollection: string
  municipalityCode: string | null
  municipalityName: string | null
  municipalityAssignment:
    | 'CBS 2025 non-generalized polygon containment'
    | 'ambiguous shared municipality boundary'
    | 'outside CBS 2025 municipality polygons'
}

/**
 * A register object explicitly marked as no longer present is useful source
 * history, but must not be drawn in the default infrastructure inventory as if
 * it still exists. Other register states remain context only: in particular,
 * `gerealiseerd` does not establish live operation or availability.
 */
export function isExplicitlyWithdrawnPublicWaterAsset(
  feature: Feature<Point, PublicWaterAssetProperties>,
): boolean {
  return feature.properties.status?.trim().toLocaleLowerCase('nl-NL') === 'niet meer aanwezig'
}

export type PublicWaterAssetCollection = FeatureCollection<Point, PublicWaterAssetProperties> & {
  evidenceClass: 'official-context'
  affectsSimulation: false
  counts: Record<PublicWaterAssetType, number>
  municipalityAssignment: {
    method: 'point-in-polygon against CBS 2025 non-generalized municipality geometry'
    boundaryEdition: 2025
    boundaryInstant: string
    boundarySource: string
    boundaryLicense: 'CC BY 4.0'
    assignedToMunicipalityPolygon: number
    outsideMunicipalityPolygon: number
    ambiguousSharedBoundary: number
    municipalitiesRepresented: number
    noDataRule: string
  }
  source: {
    retrievedAt: string
    coverage: 'partial'
    coverageNote: string
    services: Array<{
      id: string
      publisher: string
      url: string
      license: string
      licenseUrl: string
      collections: string[]
    }>
  }
}

export interface PublicFacilityProperties {
  facilityType: 'public-order-and-safety' | 'public-administration'
  locality: string | null
  postcode: string | null
  street: string | null
  houseNumber: string | null
  registryIdentifier: string | null
  registeredAt: string | null
  sourceCollection: 'public_order_and_safety' | 'public_administration_office'
}

export type PublicFacilityCollection = FeatureCollection<Point, PublicFacilityProperties> & {
  evidenceClass: 'official-context'
  affectsSimulation: false
  counts: Record<PublicFacilityProperties['facilityType'], number>
  source: {
    id: string
    publisher: string
    url: string
    license: string
    licenseUrl: string
    retrievedAt: string
    coverage: 'partial'
    coverageNote: string
  }
}

export interface PublicAcuteCareProperties {
  facilityType: 'emergency-department'
  name: string
  locality: string
  address: string
  postcode: string
  municipalityCode: string
  municipalityName: string
  emergencyOpen247: boolean
  acuteObstetrics: boolean
  treatmentRoomsReported: number
  emergencyVisits2025Reported: number
  offeringDescription: string
  openingDescription: string
  sourceRow: number
  geocoderRecordId: string
  geocoderMatchMethod: string
}

export type PublicAcuteCareCollection = FeatureCollection<Point, PublicAcuteCareProperties> & {
  evidenceClass: 'official-context'
  affectsSimulation: false
  counts: {
    emergencyDepartments: 79
    open247: 76
    limitedHours: 3
    acuteObstetrics: 71
  }
  source: {
    id: string
    publisher: string
    title: string
    url: string
    downloadUrl: string
    doi: string
    version: string
    publicationDate: string
    retrievedAt: string
    license: 'CC0 1.0'
    licenseUrl: string
    inputSha256: string
    coverage: 'national-questionnaire'
    coverageNote: string
  }
  geocoding: {
    publisher: string
    url: string
    retrievedAt: string
    matchMethod: string
    license: string
  }
}

export type PublicEducationType =
  | 'special education'
  | 'primary education'
  | 'secondary education'
  | 'vocational or adult education'
  | 'higher education'
  | 'other registered education'

export interface PublicEducationLocationProperties {
  facilityType: 'education-location'
  educationType: PublicEducationType
  name: string
  additionalNames: string
  locationCode: string
  bagId: string | null
  address: string | null
  locality: string | null
  postcode: string | null
  municipalityCode: string | null
  municipalityName: string | null
  municipalityAssignment:
    | 'CBS 2025 generalized polygon containment'
    | 'outside generalized municipality polygon'
  legalFrameworks: string
  activeUseCount: number
  recognizedBranchCount: number
}

export type PublicEducationLocationCollection = FeatureCollection<Point, PublicEducationLocationProperties> & {
  evidenceClass: 'official-context'
  affectsSimulation: false
  effectiveDate: string
  counts: {
    activeLocationsAtSource: number
    mapScopeLocations: number
    excludedOutsideEuropeanNetherlands: number
    linkedToCurrentRecognition: number
    registeredUseOnly: number
    assignedToMunicipalityPolygon: number
    outsideMunicipalityPolygon: number
    municipalitiesRepresented: number
    byLegalFramework: Record<'WEC' | 'WPO' | 'WVO' | 'WEB' | 'WHW', number>
  }
  source: {
    id: string
    publisher: string
    title: string
    url: string
    apiUrl: string
    snapshotDate: string
    retrievedAt: string
    refreshCadence: string
    license: string
    licenseId: 'cc-by'
    licenseUrl: string
    coverage: string
    coverageNote: string
    resources: Array<{
      name: string
      url: string
      lastModified: string
      bytes: number
      sha256: string
    }>
  }
  processing: {
    temporalSelection: string
    mapScopeBounds: [number, number, number, number]
    municipalityAssignment: string
  }
}

export type PublicAntennaCategory =
  | 'mobile communication'
  | 'fixed link'
  | 'broadcast'
  | 'other mobile'
  | 'radio amateur'
  | 'other registered antenna'

export interface PublicAntennaSiteProperties {
  facilityType: 'antenna-installation'
  sourceSiteId: string
  primaryCategory: PublicAntennaCategory
  antennaCount: number
  technologySummary: string | null
  has2g: boolean
  has3g: boolean
  has4g: boolean
  has5g: boolean
  mobileCommunication: boolean
  broadcast: boolean
  otherMobile: boolean
  fixedLink: boolean
  radioAmateur: boolean
  smallCellIndicator: string | null
  postcode: string | null
  registeredMunicipalityName: string | null
  municipalityCode: string | null
  municipalityName: string | null
  municipalityAssignment:
    | 'CBS 2025 generalized polygon containment'
    | 'outside generalized municipality polygon'
}

export type PublicAntennaSiteCollection = FeatureCollection<Point, PublicAntennaSiteProperties> & {
  evidenceClass: 'official-context'
  affectsSimulation: false
  counts: {
    sourceRecords: number
    duplicateSourceRecordsRemoved: number
    antennaInstallations: number
    antennasRepresented: number
    mobileCommunicationSites: number
    fixedLinkSites: number
    broadcastSites: number
    otherMobileSites: number
    radioAmateurSites: number
    has2gSites: number
    has3gSites: number
    has4gSites: number
    has5gSites: number
    assignedToMunicipalityPolygon: number
    outsideMunicipalityPolygon: number
    municipalitiesRepresented: number
    byPrimaryCategory: Record<PublicAntennaCategory, number>
  }
  source: {
    id: 'rdi-antenneregister-antenna-installations'
    publisher: string
    title: string
    url: string
    officialPage: string
    rulesPage: string
    serviceUrl: string
    collection: 'ms:Antennes'
    retrievedAt: string
    serviceTime: string | null
    refreshCadence: string
    license: string
    licenseUrl: string
    coverage: string
    coverageNote: string
    rawPages: number
    rawSha256: string
    capabilitiesSha256: string
  }
  processing: {
    sourceCrs: 'EPSG:28992'
    outputCrs: 'EPSG:4326'
    transformation: string
    deduplication: string
    municipalityAssignment: string
  }
}

export type PublicUtilityAssetClass =
  | 'high-voltage-underground'
  | 'high-voltage-overhead'
  | 'high-voltage-station'
  | 'medium-voltage-cable'
  | 'medium-voltage-station'
  | 'low-voltage-cable'
  | 'low-voltage-station'
  | 'gas-pipe'
  | 'gas-replacement-pipe'

export type PublicUtilitySourceId = 'liander-open-data' | 'stedin-open-data'

export interface PublicUtilityProperties {
  utility: 'power' | 'gas'
  assetClass: PublicUtilityAssetClass
  sourceId: PublicUtilitySourceId
  publisher: string
  sourceObjectId: number | string
  sourceLayer: string
  name: string | null
  function: string | null
  voltageKv: number | null
  installedAt: string | null
}

export interface UtilityViewportBounds {
  west: number
  south: number
  east: number
  north: number
}

export type PublicUtilityCollection = FeatureCollection<
  LineString | MultiLineString | Point,
  PublicUtilityProperties
> & {
  evidenceClass: 'official-context'
  affectsSimulation: false
  loadedFeatureCount: number
  availableFeatureCount: number
  truncated: boolean
  fetchedAt: string
  query: {
    kind: 'power-backbone' | 'power-detail' | 'gas-detail'
    bounds: UtilityViewportBounds | null
    zoom: number | null
    minimumZoom: number | null
  }
  failures: Array<{
    sourceId: PublicUtilitySourceId
    publisher: string
    sourceLayer: string
    message: string
  }>
  sources: Array<{
    id: PublicUtilitySourceId
    publisher: string
    url: string
    license: string
    licenseUrl: string | null
    coverage: 'partial'
    coverageNote: string
    updateCadence: string
  }>
}

export interface PublicCapacitySampleProperties {
  municipalityCode: string
  municipalityName: string
  samplePostcode: string
  sampleLocationCode: string | null
  sampleStatus: 'sampled' | 'no-published-match'
  serviceAreaId: string | null
  serviceAreaName: string | null
  regionalGridOperator: string | null
  existingWithdrawalMw: number | null
  requiredWithdrawalMw: number | null
  queueWithdrawalMw: number | null
  uniqueRequestsWithdrawal: number | null
  existingInjectionMw: number | null
  requiredInjectionMw: number | null
  queueInjectionMw: number | null
  uniqueRequestsInjection: number | null
  tennetWithdrawalClass: number | null
  tennetInjectionClass: number | null
  projectCount: number | null
  earliestProjectYear: number | null
}

export type PublicCapacityContextCollection = FeatureCollection<
  Point,
  PublicCapacitySampleProperties
> & {
  evidenceClass: 'official-context'
  affectsSimulation: false
  retrievedAt: string
  counts: {
    municipalities: number
    sampledMunicipalities: number
    noPublishedMatch: number
    uniqueServiceAreas: number
    regionalGridOperators: Record<string, number>
  }
  source: {
    id: 'nbnl-capacity-map-municipality-samples'
    publisher: string
    title: string
    mapUrl: string
    designUrl: string
    apiFindUrl: string
    apiGetUrl: string
    retrievedAt: string
    accessMethod: string
    license: string
    updateCadence: string
    coverage: string
    caveat: string
  }
  sampling: {
    postcodeSource: string
    lookup: string
    noDataRule: string
    geometrySemantics: string
  }
}

export type PublicServiceAreaDiscipline =
  | 'power'
  | 'gas'
  | 'water'
  | 'drainage'
  | 'telecom'

export interface PublicServiceAreaProvider {
  code: string | null
  name: string
  legalName: string | null
  website: string | null
  lastUpdated: string | null
}

export interface PublicServiceAreaContext {
  discipline: PublicServiceAreaDiscipline
  providers: PublicServiceAreaProvider[]
  queriedAt: string
  evidenceClass: 'official-context'
  affectsSimulation: false
  source: {
    id: 'mijnaansluiting-netbeheergebieden'
    publisher: 'Stichting Mijn Aansluiting'
    url: string
    license: 'Public Domain'
    coverage: 'provider-supplied'
    coverageNote: string
    updateCadence: string
  }
}

export interface PublicGtsFlowRecord {
  id: string
  pointKey: string
  pointLabel: string
  tsoItemIdentifier: string | null
  direction: string
  pointType: string | null
  valueKwhPerHour: number
  flowStatus: string
  periodFrom: string
  periodTo: string
  lastUpdatedAt: string | null
  remarks: string | null
}

export interface PublicGtsFlowContext {
  evidenceClass: 'observed-context'
  affectsSimulation: false
  observationTime: string
  observationPeriod: { from: string; to: string }
  freshness: {
    ageMinutesAtRetrieval: number
    statusAtRetrieval: 'fresh' | 'delayed' | 'stale'
  }
  operator: {
    key: 'NL-TSO-0001'
    label: 'GTS'
    tsoEicCode: string | null
  }
  records: PublicGtsFlowRecord[]
  counts: {
    apiRows: number
    recordsAtObservationHour: number
    numericDirectionalRecords: number
    missingOrNaAtObservationHour: number
    zeroDirectionalRecords: number
    uniquePointKeys: number
    byFlowStatus: Record<string, number>
  }
  source: {
    id: 'entsog-gts-hourly-physical-flow'
    publisher: string
    apiUrl: string
    apiManualUrl: string
    termsUrl: string
    disclaimerUrl: string
    gtsExplanationUrl: string
    retrievedAt: string
    extractionDate: string
    rawBytes: number
    rawSha256: string
    updateCadence: string
    terms: string
    attribution: string
    coverage: string
    geometrySemantics: string
    noDataRule: string
    role: string
    caveat: string
  }
}

export interface PublicRoadSituationProperties {
  situationId: string
  recordId: string
  recordClass: string
  eventType: string
  severity: 'highest' | 'high' | 'medium' | 'low' | 'lowest' | 'none' | 'unknown' | string
  probability: string | null
  source: string | null
  startTime: string | null
  endTime: string | null
  versionTime: string | null
  validityStatus: string | null
  informationStatus: 'real'
  confidentiality: 'noRestriction'
}

export type PublicRoadSituationCollection = FeatureCollection<
  Point | LineString,
  PublicRoadSituationProperties
> & {
  evidenceClass: 'observed-context'
  affectsSimulation: false
  source: {
    id: 'ndw-datex3-current-situations'
    publisher: 'Nationaal Dataportaal Wegverkeer (NDW)'
    url: string
    documentation: string
    license: string
    licenseUrl: string
    publicationTime: string
    sourceLastModified: string | null
    retrievedAt: string
    validityWindowHours: 72
    deliveryMode?:
      | 'live-server-proxy'
      | 'live-server-proxy-stale'
      | 'deployment-snapshot-fallback'
      | 'deployment-snapshot'
    refreshIntervalSeconds?: number
    liveRefreshError?: string
    coverage: string
    caveat: string
  }
  processing: {
    totalSituations: number
    confidentialSituationsExcluded: number
    recordsOutside72HoursExcluded: number
    recordsWithoutUsableGeometryExcluded: number
  }
}

/**
 * Client-safe traffic-camera inventory contract.
 *
 * A record proves only that an authority has declared a camera/location. It
 * does not prove that media is available or that the device is online. Direct
 * vendor stream URLs and credentials are deliberately excluded from the
 * browser payload; an approved deployment can expose short-lived media through
 * an allow-listed same-origin proxy path after a privacy/licence review.
 */
export interface PublicTrafficCameraProperties {
  cameraId: string
  name: string
  authority: string
  roadName: string | null
  bearingDegrees: number | null
  inventoryObservedAt: string | null
  operationalState: 'online' | 'offline' | 'unknown'
  mediaAvailability: 'live' | 'snapshot' | 'restricted' | 'none' | 'unknown'
  mediaObservedAt: string | null
  mediaValidThrough: string | null
  mediaProxyPath: string | null
  publicInformationUrl: string | null
  privacyReview: 'approved' | 'required' | 'not-applicable'
  licence: string | null
  evidenceClass: 'official-context' | 'observed-context' | 'unknown'
  affectsSimulation: false
}

export type PublicTrafficCameraCollection = FeatureCollection<
  Point,
  PublicTrafficCameraProperties
> & {
  evidenceClass: 'official-context' | 'unknown'
  affectsSimulation: false
  feedState: 'not-configured' | 'configured' | 'partial' | 'unavailable'
  adapterVersion: 1
  source: {
    id: 'traffic-camera-adapter-contract'
    publisher: string | null
    inventoryUrl: string | null
    mediaPolicyUrl: string
    ndwViewerUrl: string
    retrievedAt: string | null
    coverage: string
    caveat: string
  }
  contract: {
    directExternalMediaUrlsInClient: false
    separatesInventoryFromOperationalState: true
    separatesOperationalStateFromMediaAvailability: true
    requiresObservedAndExpiryTimes: true
    simulationEffect: 'none-until-reviewed-observation-adapter'
  }
}

export interface PublicRadarContext {
  evidenceClass: 'observed-context'
  affectsSimulation: false
  observationTime: string
  retrievedAt: string
  bounds: { west: number; south: number; east: number; north: number }
  imageRequest: {
    crs: 'EPSG:3857'
    bbox: [number, number, number, number]
    width: 1024
    height: 1024
  }
  image: {
    path: string
    width: number
    height: number
    bytes: number
    sha256: string
    layer: 'precipitation'
    style: string
  }
  source: {
    id: 'knmi-radar-reflectivity-composites-2.0'
    publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)'
    url: string
    serviceUrl: string
    license: 'CC BY 4.0'
    licenseUrl: string
    updateCadence: '5 minutes'
    temporalCoverage: string
    coverage: string
    caveat: string
  }
}

export interface PublicPrecipitationProbabilityContext {
  evidenceClass: 'official-forecast'
  affectsSimulation: false
  referenceTime: string
  retrievedAt: string
  thresholdMmH: 3
  probabilityMeaning: string
  bounds: { west: number; south: number; east: number; north: number }
  imageRequest: {
    crs: 'EPSG:3857'
    bbox: [number, number, number, number]
    width: 1024
    height: 1024
  }
  checkpoints: Array<{
    leadHours: 1 | 3 | 6
    validTime: string
    path: string
    width: 1024
    height: 1024
    bytes: number
    sha256: string
  }>
  source: {
    id: 'seamless_precipitation_ensemble_forecast_probabilities-1.0'
    publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)'
    url: string
    serviceUrl: string
    license: 'CC BY 4.0'
    licenseUrl: string
    productStatus: 'pilot'
    updateCadence: '5 minutes'
    forecastHorizonHours: 6
    gridResolutionKm: 1
    thresholdOptionsMmH: number[]
    timeDimension: string
    referenceTimeDimension: string
    style: string
    coverage: string
    noDataSemantics: string
    caveat: string
  }
}

export function nearestPrecipitationProbabilityCheckpoint(
  context: PublicPrecipitationProbabilityContext,
  hour: number,
) {
  if (hour <= 0 || hour > context.source.forecastHorizonHours) return null
  return [...context.checkpoints].sort(
    (left, right) =>
      Math.abs(left.leadHours - hour) - Math.abs(right.leadHours - hour) ||
      left.leadHours - right.leadHours,
  )[0] ?? null
}

export interface PublicWeatherObservationProperties {
  stationId: string
  wsiId: string
  stationName: string
  observationTime: string
  stationHeightM: number | null
  airTemperatureC: number | null
  relativeHumidityPct: number | null
  windDirectionDeg: number | null
  windSpeedMs: number | null
  windGustMs: number | null
  rainfallLastHourMm: number | null
  precipitationIntensityMmH: number | null
  visibilityM: number | null
  seaLevelPressureHpa: number | null
  windLabel: string
  rainLabel: string
  temperatureLabel: string
  municipalityCode: string | null
  municipalityName: string | null
  municipalityAssignment:
    | 'CBS 2025 generalized polygon containment'
    | 'outside generalized municipality polygon'
}

export type PublicWeatherObservationCollection = FeatureCollection<
  Point,
  PublicWeatherObservationProperties
> & {
  evidenceClass: 'observed-context'
  affectsSimulation: false
  observationTime: string
  freshness: {
    ageMinutesAtRetrieval: number
    statusAtRetrieval: 'fresh' | 'delayed' | 'stale'
  }
  coverageNote: string
  source: {
    id: '10-minute-in-situ-meteorological-observations-1.0'
    publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)'
    datasetPage: string
    apiUrl: string
    platformNewsUrl: string
    license: 'CC BY 4.0'
    updateCadence: '10 minutes'
    sourceFile: string
    sourceCreated: string
    sourceLastModified: string
    sourceBytes: number
    sourceSha256: string
    retrievedAt: string
    intervalSemantics: string
    role: string
    caveat: string
  }
  counts: {
    sourceStationRecords: number
    europeanNetherlandsStations: number
    excludedCaribbeanStations: number
    assignedToMunicipalityPolygon: number
    outsideMunicipalityPolygon: number
    availableByVariable: Record<string, number>
  }
}

export interface PublicWeatherWarningProperties {
  provinceCode: string
  provinceName: string
  boundaryEdition: 2025
  knmiLocationCode: string
  warningLevel: 0 | 1 | 2 | 3
  warningLevelLabel: 'No warning' | 'Code yellow' | 'Code orange' | 'Code red'
  warningPeriodCount: number
  phenomena: string[]
  municipalityCodes: string[]
}

export interface PublicWeatherWarningPeriod {
  locationCode: string
  phenomenonId: string
  phenomenonLabel: string
  level: 1 | 2 | 3
  levelLabel: 'Code yellow' | 'Code orange' | 'Code red'
  validFrom: string
  validThrough: string
  slotCount: number
  texts: string[]
}

export type PublicWeatherWarningCollection = FeatureCollection<
  Polygon | MultiPolygon,
  PublicWeatherWarningProperties
> & {
  evidenceClass: 'official-context'
  affectsSimulation: false
  coverage: 'twelve-provinces'
  coverageNote: string
  source: {
    id: 'waarschuwingen_nederland_48h-1.0'
    publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)'
    datasetPage: string
    apiUrl: string
    warningPage: string
    license: 'CC BY 4.0'
    updateFrequency: 'continual'
    horizonHours: 48
    sourceFile: string | null
    sourceLastModified: string | null
    fallbackIssueTime: string | null
    retrievalMode: 'open-data-api' | 'official-html-explicit-no-warning-fallback'
    retrievedAt: string
    timeZone: 'Europe/Amsterdam'
    role: string
  }
  warningWindow: {
    start: string
    end: string
    hourlyTimeslices: number
  }
  counts: {
    provinces: 12
    warningPeriods: number
    provincesWithWarnings: number
    byLevel: { yellow: number; orange: number; red: number }
  }
  warnings: PublicWeatherWarningPeriod[]
}

export interface PublicAirQualityProperties {
  stationNumber: string
  name: string
  locality: string | null
  networkId: string | null
  pm25UgM3: number
  pm10UgM3: number | null
  no2UgM3: number | null
  o3UgM3: number | null
  so2UgM3: number | null
  observedAt: string
  intervalStart: string
  intervalEnd: string
  municipalityCode: string | null
  municipalityName: string | null
  municipalityAssignment:
    | 'CBS 2025 generalized polygon containment'
    | 'outside generalized municipality polygon'
}

export type PublicAirQualityCollection = FeatureCollection<Point, PublicAirQualityProperties> & {
  evidenceClass: 'observed-context'
  affectsSimulation: false
  observationWindow: {
    requestedStart: string
    requestedEnd: string
    oldestMappedObservation: string
    newestMappedObservation: string
    hours: 6
  }
  counts: {
    activeMetadataLocations: number
    pm25StationsReturned: number
    pm25StationsMapped: number
    stationsMissingActiveMetadata: number
    assignedToMunicipalityPolygon: number
    outsideMunicipalityPolygon: number
    municipalitiesRepresented: number
    measurementsFetched: Record<'PM25' | 'PM10' | 'NO2' | 'O3' | 'SO2', number>
  }
  source: {
    id: 'rivm-luchtmeetnet-indicative-pm25'
    publisher: string
    title: string
    url: string
    apiUrl: string
    officialDataPage: string
    metadataUrl: string
    readmeUrl: string
    retrievedAt: string
    responseTime: string | null
    updateCadence: string
    validationStatus: string
    license: string
    coverage: string
    caveat: string
    metadataExport: string
    metadataSha256: string
    measurementResponses: Record<
      'PM25' | 'PM10' | 'NO2' | 'O3' | 'SO2',
      { pages: number; records: number; sha256: string }
    >
  }
  processing: {
    selection: string
    coPollutants: string
    rawValues: string
    municipalityAssignment: string
  }
}

export interface PublicSeismicEventProperties {
  eventId: string
  observedAt: string
  publishedTime: string
  magnitude: number
  magnitudeType: string | null
  depthKm: number
  eventType: 'earthquake' | 'induced or triggered event'
  location: string
  reviewStatus: string
  evaluationMode: string
  contributor: string
  municipalityCode: string | null
  municipalityName: string | null
  municipalityAssignment:
    | 'CBS 2025 generalized polygon containment'
    | 'outside generalized municipality polygon'
}

export type PublicSeismicEventCollection = FeatureCollection<
  Point,
  PublicSeismicEventProperties
> & {
  evidenceClass: 'observed-context'
  affectsSimulation: false
  retrievedAt: string
  observationWindow: {
    requestedStart: string
    requestedEnd: string
    oldestEvent: string
    newestEvent: string
    days: 365
  }
  bounds: { west: number; south: number; east: number; north: number }
  counts: {
    sourceEvents: number
    includedSeismicEvents: number
    excludedNonSeismicEvents: number
    excludedByType: Record<string, number>
    byEventType: Record<'earthquake' | 'induced or triggered event', number>
    byReviewStatus: Record<string, number>
    assignedToMunicipalityPolygon: number
    outsideMunicipalityPolygon: number
    municipalitiesRepresented: number
  }
  source: {
    id: 'knmi-fdsn-seismic-events'
    publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)'
    title: string
    portalUrl: string
    serviceUrl: string
    queryUrl: string
    responseTime: string | null
    retrievedAt: string
    updateCadence: string
    license: string
    coverage: string
    caveat: string
    responseBytes: number
    responseSha256: string
  }
  processing: {
    includedEventTypes: Array<'earthquake' | 'induced or triggered event'>
    excludedEventTypes: string
    timeSemantics: string
    municipalityAssignment: string
    noDataRule: string
  }
}

export interface PublicWaterObservationProperties {
  observationType: 'water-level' | 'discharge'
  endpointParameter: 'waterhoogte' | 'waterafvoer'
  locationCode: string
  name: string
  latestValue: number
  observedAt: string
  ageMinutesAtRetrieval: number
  freshness: 'fresh' | 'delayed' | 'stale'
  possiblyFaulty: boolean
  unitCode: 'cm' | 'm3/s'
  verticalDatum: string | null
  sourceParameterId: string
  measurementClass: string
  measurementColor: string | null
  featured: boolean
  markerType: string | null
  municipalityCode: string | null
  municipalityName: string | null
  municipalityAssignment:
    | 'CBS 2025 generalized polygon containment'
    | 'outside generalized municipality polygon'
}

export type PublicWaterObservationCollection = FeatureCollection<
  Point,
  PublicWaterObservationProperties
> & {
  evidenceClass: 'observed-context'
  affectsSimulation: false
  retrievedAt: string
  observationRange: { oldest: string; newest: string }
  counts: {
    observations: number
    waterLevelObservations: number
    dischargeObservations: number
    sourceLocations: { waterhoogte: number; waterafvoer: number }
    freshness: Record<'fresh' | 'delayed' | 'stale', number>
    possiblyFaultyObservations: number
    duplicateObservationIdentities: number
    assignedToMunicipalityPolygon: number
    outsideMunicipalityPolygon: number
    municipalitiesRepresented: number
  }
  source: {
    id: 'rws-waterinfo-latest-water-level-discharge'
    publisher: 'Rijkswaterstaat'
    title: string
    url: string
    officialDataPage: string
    useAndLicensePage: string
    measurementNetworkPage: string
    retrievedAt: string
    updateCadence: string
    apiCache: string
    license: string
    licenseUrl: string
    serviceLevel: string
    coverage: string
    caveat: string
    responses: Record<
      'waterhoogte' | 'waterafvoer',
      {
        url: string
        responseTime: string | null
        cacheControl: string | null
        sourceLocations: number
        bytes: number
        sha256: string
      }
    >
  }
  processing: {
    sourceCrs: 'EPSG:25831'
    outputCrs: 'EPSG:4326'
    transformation: string
    duplicateIdentityRule: string
    freshness: string
    municipalityAssignment: string
    noDataRule: string
  }
}

export const WATER_FORECAST_CHECKPOINT_HOURS = [1, 6, 12, 24, 48, 72] as const

/** Selects the closest cached Waterinfo checkpoint to the exercise hour. */
export function nearestWaterForecastCheckpoint(simulationHour: number): number {
  return WATER_FORECAST_CHECKPOINT_HOURS.reduce((closest, candidate) =>
    Math.abs(candidate - simulationHour) < Math.abs(closest - simulationHour)
      ? candidate
      : closest,
  )
}

export interface PublicWaterForecastProperties {
  snapshotId: string
  forecastType: 'water-level' | 'discharge'
  mapType: 'waterhoogte' | 'waterafvoer'
  requestedLeadStartHours: number
  requestedLeadEndHours: number
  locationCode: string
  name: string
  value: number
  validAt: string
  possiblyFaulty: boolean
  unitCode: 'cm' | 'm3/s'
  verticalDatum: string | null
  sourceParameterId: string
  forecastParameterId: string | null
  measurementClass: string
  measurementColor: string | null
  featured: boolean
  markerType: string | null
  municipalityCode: string | null
  municipalityName: string | null
  municipalityAssignment:
    | 'CBS 2025 generalized polygon containment'
    | 'outside generalized municipality polygon'
}

export interface PublicWaterForecastSnapshot {
  id: string
  forecastType: 'water-level' | 'discharge'
  mapType: 'waterhoogte' | 'waterafvoer'
  requestedLeadStartHours: number
  requestedLeadEndHours: number
  returnedFeatures: number
  sourceMeasurements: number
  assignedToMunicipalityPolygon: number
  outsideMunicipalityPolygon: number
  validTimeRange: { earliest: string; latest: string } | null
  noData: boolean
}

export type PublicWaterForecastCollection = FeatureCollection<
  Point,
  PublicWaterForecastProperties
> & {
  evidenceClass: 'official-forecast'
  affectsSimulation: false
  retrievedAt: string
  issueTime: null
  issueTimeStatus: string
  counts: {
    forecasts: number
    waterLevelForecasts: number
    dischargeForecasts: number
    municipalitiesRepresented: number
  }
  validTimeRange: { earliest: string; latest: string } | null
  snapshots: PublicWaterForecastSnapshot[]
  source: {
    id: 'rws-waterinfo-rolling-water-level-discharge-forecasts'
    publisher: 'Rijkswaterstaat'
    title: string
    url: string
    apiUrl: string
    officialCatalogue: string
    officialWaterPage: string
    useAndLicensePage: string
    retrievedAt: string
    license: string
    licenseUrl: string
    coverage: string
    serviceContract: string
    caveat: string
    responses: Record<string, {
      url: string
      responseTime: string | null
      cacheControl: string | null
      forecastParameterKeys: string[]
      sourceFeatureCount: number
      bytes: number
      sha256: string
    }>
  }
  processing: {
    sourceCrs: 'EPSG:25831'
    outputCrs: 'EPSG:4326'
    transformation: string
    checkpointWindows: Array<{ startHours: number; endHours: number }>
    municipalityAssignment: string
    noDataRule: string
  }
}

export type TransitRouteKind = keyof TransitRouteData

export interface SafetyRegionProperties {
  code: string
  name: string
  center: Coordinates
  municipalityCodes: string[]
  edition: 2025
  source: 'CBS/PDOK'
}

export type SafetyRegionCollection = FeatureCollection<
  Polygon | MultiPolygon,
  SafetyRegionProperties
> & {
  source: Record<string, string | number>
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}${path}`, { signal })
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  return response.json() as Promise<T>
}

async function fetchGzipJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}${path}`, { signal })
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  // Gatekeeper/Caddy serves `.gz` with Content-Encoding and Fetch transparently
  // decodes that body. Vite's development server serves the raw gzip file, so
  // only the latter needs an explicit browser decompression stream.
  if (response.headers.get('content-encoding')?.includes('gzip')) {
    return response.json() as Promise<T>
  }
  if (!response.body || typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress the public context dataset')
  }
  const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'))
  return new Response(decompressed).json() as Promise<T>
}

export async function loadTransportData(signal?: AbortSignal): Promise<TransportData> {
  const [roads, rail, stations, network, restrictions] = await Promise.all([
    fetchJson<TransportData['roads']>('data/transport-roads.geojson', signal),
    fetchJson<TransportData['rail']>('data/transport-rail.geojson', signal),
    fetchJson<TransportData['stations']>('data/transport-stations.geojson', signal),
    fetchJson<{ source: Record<string, string>; routes: RouteDefinition[] }>(
      'data/transport-network.json',
      signal,
    ),
    fetchJson<PublicRouteRestrictionDataset>(
      'data/public-context/transport-restrictions.json',
      signal,
    ),
  ])
  return {
    roads,
    rail,
    stations,
    routes: mergePublicRouteRestrictions(network.routes, restrictions),
    source: network.source,
  }
}

export async function loadTransitRouteData(signal?: AbortSignal): Promise<TransitRouteData> {
  const [bus, urbanRail, railServices, ferries] = await Promise.all(
    (['bus', 'urbanRail', 'railServices', 'ferries'] as const).map((kind) =>
      loadTransitRoutePart(kind, signal),
    ),
  )
  return { bus, urbanRail, railServices, ferries }
}

const transitRoutePath: Record<TransitRouteKind, string> = {
  bus: 'data/transit/transit-routes-bus.geojson',
  urbanRail: 'data/transit/transit-routes-urban-rail.geojson',
  railServices: 'data/transit/transit-routes-rail.geojson',
  ferries: 'data/transit/transit-routes-ferry.geojson',
}

const transitRouteRequests = new Map<
  TransitRouteKind,
  Promise<FeatureCollection<LineString>>
>()

/**
 * Loads one scheduled-transit mode and reuses the in-flight/completed request.
 * This lets the map defer the 8.8 MB bus geometry until a city-scale mobility
 * view can actually render it instead of paying that cost on every cold visit.
 */
export function loadTransitRoutePart(
  kind: TransitRouteKind,
  signal?: AbortSignal,
): Promise<FeatureCollection<LineString>> {
  const cached = transitRouteRequests.get(kind)
  if (cached) return cached
  const request = fetchJson<FeatureCollection<LineString>>(transitRoutePath[kind], signal)
    .catch((error) => {
      transitRouteRequests.delete(kind)
      throw error
    })
  transitRouteRequests.set(kind, request)
  return request
}

export async function loadSafetyRegions(signal?: AbortSignal): Promise<SafetyRegionCollection> {
  return fetchJson<SafetyRegionCollection>('data/safety-regions.geojson', signal)
}

let publicWaterAssetsRequest: Promise<PublicWaterAssetCollection> | null = null

/**
 * Loads the national public water-asset snapshot only when its map is opened.
 * The compressed transfer is roughly 4 MB; the full official-context feature
 * collection stays out of the initial application load and never implies live
 * operational state.
 */
export function loadPublicWaterAssets(
  signal?: AbortSignal,
): Promise<PublicWaterAssetCollection> {
  if (publicWaterAssetsRequest) return publicWaterAssetsRequest
  publicWaterAssetsRequest = fetchGzipJson<PublicWaterAssetCollection>(
    'data/public-context/water-assets.geojson.gz',
    signal,
  ).catch((error) => {
    publicWaterAssetsRequest = null
    throw error
  })
  return publicWaterAssetsRequest
}

let publicFacilitiesRequest: Promise<PublicFacilityCollection> | null = null

/** Loads the coarse KVK/PDOK governmental-service register only on its map. */
export function loadPublicFacilities(
  signal?: AbortSignal,
): Promise<PublicFacilityCollection> {
  if (publicFacilitiesRequest) return publicFacilitiesRequest
  publicFacilitiesRequest = fetchGzipJson<PublicFacilityCollection>(
    'data/public-context/government-service-locations.geojson.gz',
    signal,
  ).catch((error) => {
    publicFacilitiesRequest = null
    throw error
  })
  return publicFacilitiesRequest
}

let publicAcuteCareRequest: Promise<PublicAcuteCareCollection> | null = null

/** Loads the dated RIVM emergency-department questionnaire only on Facilities. */
export function loadPublicAcuteCare(
  signal?: AbortSignal,
): Promise<PublicAcuteCareCollection> {
  if (publicAcuteCareRequest) return publicAcuteCareRequest
  publicAcuteCareRequest = fetchGzipJson<PublicAcuteCareCollection>(
    'data/public-context/rivm-acute-care-locations.geojson.gz',
    signal,
  ).catch((error) => {
    publicAcuteCareRequest = null
    throw error
  })
  return publicAcuteCareRequest
}

let publicEducationLocationsRequest: Promise<PublicEducationLocationCollection> | null = null

/** Loads temporally filtered DUO RIO education-location context only on Facilities. */
export function loadPublicEducationLocations(
  signal?: AbortSignal,
): Promise<PublicEducationLocationCollection> {
  if (publicEducationLocationsRequest) return publicEducationLocationsRequest
  publicEducationLocationsRequest = fetchGzipJson<PublicEducationLocationCollection>(
    'data/public-context/duo-education-locations.geojson.gz',
    signal,
  ).catch((error) => {
    publicEducationLocationsRequest = null
    throw error
  })
  return publicEducationLocationsRequest
}

let publicAntennaSitesRequest: Promise<PublicAntennaSiteCollection> | null = null

/** Loads the statutory RDI antenna-installation register only on Telecom. */
export function loadPublicAntennaSites(
  signal?: AbortSignal,
): Promise<PublicAntennaSiteCollection> {
  if (publicAntennaSitesRequest) return publicAntennaSitesRequest
  publicAntennaSitesRequest = fetchGzipJson<PublicAntennaSiteCollection>(
    'data/public-context/rdi-antenna-sites.geojson.gz',
    signal,
  ).catch((error) => {
    publicAntennaSitesRequest = null
    throw error
  })
  return publicAntennaSitesRequest
}

let publicRoadSituationsRequest: Promise<PublicRoadSituationCollection> | null = null
let publicRoadSituationsCache: {
  collection: PublicRoadSituationCollection
  expiresAt: number
} | null = null

/**
 * Loads the same-origin, server-refreshed NDW DATEX II current picture, with
 * the checked-in deployment snapshot as an explicitly labelled fallback. It
 * is observed time-bounded context, not a forecast and not yet a causal
 * modification of the scenario's generalized NWB routes.
 */
export function loadPublicRoadSituations(
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<PublicRoadSituationCollection> {
  if (
    !forceRefresh &&
    publicRoadSituationsCache &&
    Date.now() < publicRoadSituationsCache.expiresAt
  ) {
    return Promise.resolve(publicRoadSituationsCache.collection)
  }
  if (publicRoadSituationsRequest) return publicRoadSituationsRequest
  const request: Promise<PublicRoadSituationCollection> = fetchJson<PublicRoadSituationCollection>(
    'api/ndw-road-situations',
    signal,
  )
    .catch(async (liveError: unknown) => {
      if (signal?.aborted) throw liveError
      const snapshot = await fetchGzipJson<PublicRoadSituationCollection>(
        'data/public-context/ndw-road-situations.geojson.gz',
        signal,
      )
      const message = liveError instanceof Error ? liveError.message : String(liveError)
      return {
        ...snapshot,
        source: {
          ...snapshot.source,
          deliveryMode: 'deployment-snapshot-fallback' as const,
          liveRefreshError: `Live refresh unavailable (${message}); using the deployment snapshot.`,
        },
      }
    })
    .then((collection) => {
      publicRoadSituationsCache = {
        collection,
        expiresAt: Date.now() + (
          collection.source.deliveryMode === 'live-server-proxy' ? 55_000 : 30_000
        ),
      }
      return collection
    })
    .finally(() => {
      // App.tsx deliberately asks again every minute while the overlay is in
      // use; only deduplicate concurrent requests, not future refreshes.
      publicRoadSituationsRequest = null
    })
  publicRoadSituationsRequest = request
  return request
}

let publicTrafficCamerasRequest: Promise<PublicTrafficCameraCollection> | null = null

/**
 * Loads the client-safe camera registry only when the camera overlay is asked
 * for. The initial fixture intentionally contains no cameras: Rijkswaterstaat
 * does not publish its operational road-camera media for third-party use and
 * NDW describes camera support as under development. A future authorized
 * adapter can replace the fixture without changing the map contract.
 */
export function loadPublicTrafficCameras(
  signal?: AbortSignal,
): Promise<PublicTrafficCameraCollection> {
  if (publicTrafficCamerasRequest) return publicTrafficCamerasRequest
  publicTrafficCamerasRequest = fetchJson<PublicTrafficCameraCollection>(
    'data/public-context/traffic-cameras.geojson',
    signal,
  ).catch((error) => {
    publicTrafficCamerasRequest = null
    throw error
  })
  return publicTrafficCamerasRequest
}

let publicRadarContextRequest: Promise<PublicRadarContext> | null = null

/** Loads metadata for the locally cached KNMI radar image on relevant hazard maps. */
export function loadPublicRadarContext(signal?: AbortSignal): Promise<PublicRadarContext> {
  if (publicRadarContextRequest) return publicRadarContextRequest
  publicRadarContextRequest = fetchJson<PublicRadarContext>(
    'data/public-context/knmi-radar.json',
    signal,
  ).catch((error) => {
    publicRadarContextRequest = null
    throw error
  })
  return publicRadarContextRequest
}

let publicPrecipitationProbabilityContextRequest:
  | Promise<PublicPrecipitationProbabilityContext>
  | null = null

/** Loads deployment-cached KNMI precipitation probabilities through T+6. */
export function loadPublicPrecipitationProbabilityContext(
  signal?: AbortSignal,
): Promise<PublicPrecipitationProbabilityContext> {
  if (publicPrecipitationProbabilityContextRequest) {
    return publicPrecipitationProbabilityContextRequest
  }
  publicPrecipitationProbabilityContextRequest = fetchJson<PublicPrecipitationProbabilityContext>(
    'data/public-context/knmi-precipitation-probability.json',
    signal,
  ).catch((error) => {
    publicPrecipitationProbabilityContextRequest = null
    throw error
  })
  return publicPrecipitationProbabilityContextRequest
}

let publicWeatherObservationsRequest: Promise<PublicWeatherObservationCollection> | null = null

/** Loads sparse, near-real-time KNMI station observations only on relevant Hazard maps. */
export function loadPublicWeatherObservations(
  signal?: AbortSignal,
): Promise<PublicWeatherObservationCollection> {
  if (publicWeatherObservationsRequest) return publicWeatherObservationsRequest
  publicWeatherObservationsRequest = fetchGzipJson<PublicWeatherObservationCollection>(
    'data/public-context/knmi-weather-observations.geojson.gz',
    signal,
  ).catch((error) => {
    publicWeatherObservationsRequest = null
    throw error
  })
  return publicWeatherObservationsRequest
}

let publicWeatherWarningsRequest: Promise<PublicWeatherWarningCollection> | null = null

/** Loads the issued KNMI 48-hour province-warning context only on Hazard. */
export function loadPublicWeatherWarnings(
  signal?: AbortSignal,
): Promise<PublicWeatherWarningCollection> {
  if (publicWeatherWarningsRequest) return publicWeatherWarningsRequest
  publicWeatherWarningsRequest = fetchGzipJson<PublicWeatherWarningCollection>(
    'data/public-context/knmi-weather-warnings.geojson.gz',
    signal,
  ).catch((error) => {
    publicWeatherWarningsRequest = null
    throw error
  })
  return publicWeatherWarningsRequest
}

let publicAirQualityRequest: Promise<PublicAirQualityCollection> | null = null

/**
 * Loads deployment-cached, indicative Luchtmeetnet PM2.5 observations only for
 * wildfire/smoke context. The station points never alter scenario calculations.
 */
export function loadPublicAirQuality(
  signal?: AbortSignal,
): Promise<PublicAirQualityCollection> {
  if (publicAirQualityRequest) return publicAirQualityRequest
  publicAirQualityRequest = fetchGzipJson<PublicAirQualityCollection>(
    'data/public-context/rivm-air-quality-pm25.geojson.gz',
    signal,
  ).catch((error) => {
    publicAirQualityRequest = null
    throw error
  })
  return publicAirQualityRequest
}

let publicSeismicEventsRequest: Promise<PublicSeismicEventCollection> | null = null

/** Loads a deployment-cached KNMI seismic-event catalogue only on earthquake maps. */
export function loadPublicSeismicEvents(
  signal?: AbortSignal,
): Promise<PublicSeismicEventCollection> {
  if (publicSeismicEventsRequest) return publicSeismicEventsRequest
  publicSeismicEventsRequest = fetchGzipJson<PublicSeismicEventCollection>(
    'data/public-context/knmi-seismic-events.geojson.gz',
    signal,
  ).catch((error) => {
    publicSeismicEventsRequest = null
    throw error
  })
  return publicSeismicEventsRequest
}

let publicWaterObservationsRequest: Promise<PublicWaterObservationCollection> | null = null

/** Loads deployment-cached Waterinfo station observations on water/flood maps. */
export function loadPublicWaterObservations(
  signal?: AbortSignal,
): Promise<PublicWaterObservationCollection> {
  if (publicWaterObservationsRequest) return publicWaterObservationsRequest
  publicWaterObservationsRequest = fetchGzipJson<PublicWaterObservationCollection>(
    'data/public-context/rws-waterinfo-observations.geojson.gz',
    signal,
  ).catch((error) => {
    publicWaterObservationsRequest = null
    throw error
  })
  return publicWaterObservationsRequest
}

let publicWaterForecastsRequest: Promise<PublicWaterForecastCollection> | null = null

/** Loads deployment-cached rolling Waterinfo forecasts on water/flood maps. */
export function loadPublicWaterForecasts(
  signal?: AbortSignal,
): Promise<PublicWaterForecastCollection> {
  if (publicWaterForecastsRequest) return publicWaterForecastsRequest
  publicWaterForecastsRequest = fetchGzipJson<PublicWaterForecastCollection>(
    'data/public-context/rws-waterinfo-forecasts.geojson.gz',
    signal,
  ).catch((error) => {
    publicWaterForecastsRequest = null
    throw error
  })
  return publicWaterForecastsRequest
}

let publicCapacityContextRequest: Promise<PublicCapacityContextCollection> | null = null

/** Loads municipality-sampled NBNL capacity/queue planning context only on Power. */
export function loadPublicCapacityContext(
  signal?: AbortSignal,
): Promise<PublicCapacityContextCollection> {
  if (publicCapacityContextRequest) return publicCapacityContextRequest
  publicCapacityContextRequest = fetchGzipJson<PublicCapacityContextCollection>(
    'data/public-context/nbnl-capacity-samples.geojson.gz',
    signal,
  ).catch((error) => {
    publicCapacityContextRequest = null
    throw error
  })
  return publicCapacityContextRequest
}

let publicGtsFlowContextRequest: Promise<PublicGtsFlowContext> | null = null

/** Loads deployment-cached hourly GTS transmission flows only on Gas. */
export function loadPublicGtsFlowContext(
  signal?: AbortSignal,
): Promise<PublicGtsFlowContext> {
  if (publicGtsFlowContextRequest) return publicGtsFlowContextRequest
  publicGtsFlowContextRequest = fetchGzipJson<PublicGtsFlowContext>(
    'data/public-context/entsog-gts-physical-flow.json.gz',
    signal,
  ).catch((error) => {
    publicGtsFlowContextRequest = null
    throw error
  })
  return publicGtsFlowContextRequest
}

const LIANDER_ARCGIS_ROOT =
  'https://services1.arcgis.com/v6W5HAVrpgSg3vts/ArcGIS/rest/services'
const STEDIN_ARCGIS_ROOT =
  'https://services-eu1.arcgis.com/IQto421Ac9MzEmFT/arcgis/rest/services/KM_Gasvervangingsdata/FeatureServer'
const LIANDER_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/'
const LIANDER_COVERAGE_NOTE =
  'Liander service area only; geometry is public register context, not national coverage, live outage state, switching state, capacity, flow, dependency or restoration evidence.'
const STEDIN_COVERAGE_NOTE =
  'Stedin service area only. Electricity geometry omits final connection cables and selected other assets; gas geometry covers the replacement programme rather than the complete gas network. Neither product is live outage, switching, capacity, flow, dependency or restoration evidence.'
const ARCGIS_PAGE_SIZE = 2_000

interface UtilityLayerRequest {
  sourceId: PublicUtilitySourceId
  publisher: string
  service?: 'Elektra' | 'Gas'
  layer: number
  name: string
  utility: PublicUtilityProperties['utility']
  assetClass: PublicUtilityAssetClass
  outFields: string[]
  maximumFeatures: number
}

interface ArcGisCollection extends FeatureCollection<LineString | MultiLineString | Point> {
  error?: { code?: number; message?: string; details?: string[] }
}

function utilityLayerUrl(request: UtilityLayerRequest) {
  if (request.sourceId === 'stedin-open-data') {
    return `${STEDIN_ARCGIS_ROOT}/${request.layer}/query`
  }
  return `${LIANDER_ARCGIS_ROOT}/Liander_Open_Data_${request.service}/FeatureServer/${request.layer}/query`
}

function utilityQueryParameters(
  request: UtilityLayerRequest,
  bounds: UtilityViewportBounds | null,
) {
  const parameters = new URLSearchParams({
    f: 'json',
    where: '1=1',
  })
  if (bounds) {
    parameters.set(
      'geometry',
      `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
    )
    parameters.set('geometryType', 'esriGeometryEnvelope')
    parameters.set('inSR', '4326')
    parameters.set('spatialRel', 'esriSpatialRelIntersects')
  }
  return parameters
}

async function fetchUtilityCount(
  request: UtilityLayerRequest,
  bounds: UtilityViewportBounds | null,
  signal?: AbortSignal,
) {
  const parameters = utilityQueryParameters(request, bounds)
  parameters.set('returnCountOnly', 'true')
  parameters.set('cacheHint', 'true')
  const response = await fetch(`${utilityLayerUrl(request)}?${parameters}`, { signal })
  if (!response.ok) throw new Error(`${request.name} count returned ${response.status}`)
  const payload = await response.json() as {
    count?: number
    error?: { message?: string }
  }
  if (payload.error || !Number.isFinite(payload.count)) {
    throw new Error(payload.error?.message ?? `${request.name} returned no feature count`)
  }
  return Number(payload.count)
}

function normalizedUtilityFeature(
  feature: ArcGisCollection['features'][number],
  request: UtilityLayerRequest,
) {
  const raw = feature.properties ?? {}
  const objectId = raw.OBJECTID ?? feature.id ?? 'unknown'
  const installed = typeof raw.DATUM_AANLEG === 'number' && raw.DATUM_AANLEG > 0
    ? new Date(raw.DATUM_AANLEG).toISOString()
    : null
  const rawVoltage = raw.SPANNINGSNIVEAU ?? raw.SPANNINGSNIVEAUS ?? raw.Voltage
  const parsedVoltage = typeof rawVoltage === 'number'
    ? rawVoltage
    : typeof rawVoltage === 'string'
      ? Number.parseFloat(rawVoltage.replace(',', '.'))
      : Number.NaN
  return {
    ...feature,
    id: `${request.sourceId}:${request.assetClass}:${objectId}`,
    properties: {
      utility: request.utility,
      assetClass: request.assetClass,
      sourceId: request.sourceId,
      publisher: request.publisher,
      sourceObjectId: objectId,
      sourceLayer: request.name,
      name: typeof (raw.NAAM ?? raw.Naam) === 'string' && String(raw.NAAM ?? raw.Naam).trim()
        ? String(raw.NAAM ?? raw.Naam).trim()
        : null,
      function: typeof (raw.FUNCTIE ?? raw.Status) === 'string' && String(raw.FUNCTIE ?? raw.Status).trim()
        ? String(raw.FUNCTIE ?? raw.Status).trim()
        : null,
      voltageKv: Number.isFinite(parsedVoltage) ? parsedVoltage : null,
      installedAt: installed,
    },
  } as Feature<LineString | MultiLineString | Point, PublicUtilityProperties>
}

async function fetchUtilityLayer(
  request: UtilityLayerRequest,
  bounds: UtilityViewportBounds | null,
  signal?: AbortSignal,
) {
  const available = await fetchUtilityCount(request, bounds, signal)
  const requested = Math.min(available, request.maximumFeatures)
  const offsets = Array.from(
    { length: Math.ceil(requested / ARCGIS_PAGE_SIZE) },
    (_, index) => index * ARCGIS_PAGE_SIZE,
  )
  const pages = await Promise.all(offsets.map(async (offset) => {
    const parameters = utilityQueryParameters(request, bounds)
    parameters.set('f', 'geojson')
    parameters.set('outFields', ['OBJECTID', ...request.outFields].join(','))
    parameters.set('returnGeometry', 'true')
    parameters.set('outSR', '4326')
    parameters.set('geometryPrecision', '5')
    parameters.set('maxAllowableOffset', '0.00005')
    parameters.set('orderByFields', 'OBJECTID')
    parameters.set('resultOffset', String(offset))
    parameters.set(
      'resultRecordCount',
      String(Math.min(ARCGIS_PAGE_SIZE, requested - offset)),
    )
    parameters.set('cacheHint', 'true')
    const response = await fetch(`${utilityLayerUrl(request)}?${parameters}`, { signal })
    if (!response.ok) throw new Error(`${request.name} geometry returned ${response.status}`)
    const payload = await response.json() as ArcGisCollection
    if (payload.error || !Array.isArray(payload.features)) {
      throw new Error(payload.error?.message ?? `${request.name} returned invalid GeoJSON`)
    }
    return payload.features.map((feature) => normalizedUtilityFeature(feature, request))
  }))
  return {
    features: pages.flat(),
    available,
    truncated: available > request.maximumFeatures,
  }
}

async function fetchUtilityLayersResilient(
  requests: UtilityLayerRequest[],
  bounds: UtilityViewportBounds | null,
  signal?: AbortSignal,
) {
  const settled = await Promise.allSettled(
    requests.map((request) => fetchUtilityLayer(request, bounds, signal)),
  )
  if (signal?.aborted) throw new DOMException('The request was aborted', 'AbortError')
  const results: Awaited<ReturnType<typeof fetchUtilityLayer>>[] = []
  const failures: PublicUtilityCollection['failures'] = []
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value)
      return
    }
    const request = requests[index]
    failures.push({
      sourceId: request.sourceId,
      publisher: request.publisher,
      sourceLayer: request.name,
      message: outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason),
    })
  })
  if (results.length === 0 && failures.length > 0) {
    throw new Error(failures.map((failure) => failure.message).join('; '))
  }
  return { results, failures }
}

function publicUtilityCollection(
  kind: PublicUtilityCollection['query']['kind'],
  results: Awaited<ReturnType<typeof fetchUtilityLayer>>[],
  bounds: UtilityViewportBounds | null,
  zoom: number | null,
  minimumZoom: number | null,
  sourceIds: PublicUtilitySourceId[],
  failures: PublicUtilityCollection['failures'] = [],
): PublicUtilityCollection {
  const features = results.flatMap((result) => result.features)
  return {
    type: 'FeatureCollection',
    features,
    evidenceClass: 'official-context',
    affectsSimulation: false,
    loadedFeatureCount: features.length,
    availableFeatureCount: results.reduce((sum, result) => sum + result.available, 0),
    truncated: results.some((result) => result.truncated),
    fetchedAt: new Date().toISOString(),
    query: { kind, bounds, zoom, minimumZoom },
    failures,
    sources: sourceIds.map((sourceId) => sourceId === 'liander-open-data'
      ? {
          id: sourceId,
          publisher: 'Liander / Alliander',
          url: 'https://www.liander.nl/over-ons/open-data',
          license: 'CC BY 4.0',
          licenseUrl: LIANDER_LICENSE_URL,
          coverage: 'partial' as const,
          coverageNote: LIANDER_COVERAGE_NOTE,
          updateCadence: 'Queried from the current public service; the publisher states no fixed geometry refresh cadence.',
        }
      : {
          id: sourceId,
          publisher: 'Stedin Netbeheer',
          url: 'https://www.stedin.net/zakelijk/open-data/liggingsdata-kabels-en-leidingen',
          license: 'Free reuse statement; exact standard licence identifier not stated',
          licenseUrl: null,
          coverage: 'partial' as const,
          coverageNote: STEDIN_COVERAGE_NOTE,
          updateCadence: 'Service metadata states July 2026 data and annual publication; individual layer descriptions can state a more frequent internal refresh.',
        }),
  }
}

const powerBackboneRequests: UtilityLayerRequest[] = [
  {
    sourceId: 'liander-open-data', publisher: 'Liander / Alliander',
    service: 'Elektra', layer: 632, name: 'Hoogspanningskabel', utility: 'power',
    assetClass: 'high-voltage-underground', outFields: ['SPANNINGSNIVEAU'], maximumFeatures: 8_000,
  },
  {
    sourceId: 'liander-open-data', publisher: 'Liander / Alliander',
    service: 'Elektra', layer: 638, name: 'Hoogspanningskabel (bovengronds)', utility: 'power',
    assetClass: 'high-voltage-overhead', outFields: ['SPANNINGSNIVEAU'], maximumFeatures: 500,
  },
  {
    sourceId: 'liander-open-data', publisher: 'Liander / Alliander',
    service: 'Elektra', layer: 641, name: 'Hoogspanningsstation', utility: 'power',
    assetClass: 'high-voltage-station', outFields: ['SPANNINGSNIVEAUS', 'NAAM', 'FUNCTIE'], maximumFeatures: 2_000,
  },
]

let publicPowerBackboneRequest: Promise<PublicUtilityCollection> | null = null

/** Loads all published Liander high-voltage cables and stations on first Power-map use. */
export function loadPublicPowerBackbone(signal?: AbortSignal): Promise<PublicUtilityCollection> {
  if (publicPowerBackboneRequest) return publicPowerBackboneRequest
  publicPowerBackboneRequest = fetchUtilityLayersResilient(powerBackboneRequests, null, signal)
    .then(({ results, failures }) => publicUtilityCollection(
      'power-backbone', results, null, null, null, ['liander-open-data'], failures,
    ))
    .catch((error) => {
      publicPowerBackboneRequest = null
      throw error
    })
  return publicPowerBackboneRequest
}

const mediumVoltageRequests: UtilityLayerRequest[] = [
  {
    sourceId: 'liander-open-data', publisher: 'Liander / Alliander',
    service: 'Elektra', layer: 424, name: 'Middenspanningskabel', utility: 'power',
    assetClass: 'medium-voltage-cable', outFields: ['SPANNINGSNIVEAU'], maximumFeatures: 12_000,
  },
  {
    sourceId: 'liander-open-data', publisher: 'Liander / Alliander',
    service: 'Elektra', layer: 642, name: 'Middenspanningsstation', utility: 'power',
    assetClass: 'medium-voltage-station', outFields: ['SPANNINGSNIVEAUS', 'NAAM', 'FUNCTIE'], maximumFeatures: 4_000,
  },
]

const lowVoltageRequests: UtilityLayerRequest[] = [
  {
    sourceId: 'liander-open-data', publisher: 'Liander / Alliander',
    service: 'Elektra', layer: 112, name: 'Laagspanningskabel', utility: 'power',
    assetClass: 'low-voltage-cable', outFields: ['SPANNINGSNIVEAU'], maximumFeatures: 12_000,
  },
  {
    sourceId: 'liander-open-data', publisher: 'Liander / Alliander',
    service: 'Elektra', layer: 643, name: 'Laagspanningsstation', utility: 'power',
    assetClass: 'low-voltage-station', outFields: ['SPANNINGSNIVEAUS', 'NAAM', 'FUNCTIE'], maximumFeatures: 4_000,
  },
]

const stedinMediumVoltageRequests: UtilityLayerRequest[] = [
  {
    sourceId: 'stedin-open-data', publisher: 'Stedin Netbeheer', layer: 4,
    name: 'Hoogspanningsverbinding', utility: 'power', assetClass: 'high-voltage-underground',
    outFields: ['Id', 'Naam'], maximumFeatures: 6_000,
  },
  {
    sourceId: 'stedin-open-data', publisher: 'Stedin Netbeheer', layer: 3,
    name: 'Middenspanningsverbinding', utility: 'power', assetClass: 'medium-voltage-cable',
    outFields: ['Id', 'Naam'], maximumFeatures: 12_000,
  },
]

const stedinLowVoltageRequests: UtilityLayerRequest[] = [{
  sourceId: 'stedin-open-data', publisher: 'Stedin Netbeheer', layer: 2,
  name: 'Laagspanningsverbinding', utility: 'power', assetClass: 'low-voltage-cable',
  outFields: ['Id', 'Naam', 'Voltage'], maximumFeatures: 12_000,
}]

const gasRequests: UtilityLayerRequest[] = [
  {
    sourceId: 'liander-open-data', publisher: 'Liander / Alliander',
    service: 'Gas', layer: 0, name: 'Gasleiding', utility: 'gas', assetClass: 'gas-pipe',
    outFields: ['DATUM_AANLEG'], maximumFeatures: 16_000,
  },
  {
    sourceId: 'stedin-open-data', publisher: 'Stedin Netbeheer', layer: 1,
    name: 'Gasvervangingsdata', utility: 'gas', assetClass: 'gas-replacement-pipe',
    outFields: ['Status'], maximumFeatures: 12_000,
  },
]

/**
 * Queries only the visible street-scale extent. Publisher scale thresholds are
 * respected and dense responses are capped with an explicit truncated flag.
 */
export async function loadPublicUtilityViewport(
  utility: 'power' | 'gas',
  bounds: UtilityViewportBounds,
  zoom: number,
  signal?: AbortSignal,
): Promise<PublicUtilityCollection> {
  const minimumZoom = utility === 'power' ? 13.5 : 13.2
  if (zoom < minimumZoom) {
    return publicUtilityCollection(
      utility === 'power' ? 'power-detail' : 'gas-detail',
      [],
      bounds,
      zoom,
      minimumZoom,
      ['liander-open-data', 'stedin-open-data'],
    )
  }
  const requests = utility === 'gas'
    ? gasRequests
    : zoom >= 16.2
      ? [
          ...mediumVoltageRequests,
          ...lowVoltageRequests,
          ...stedinMediumVoltageRequests,
          ...stedinLowVoltageRequests,
        ]
      : [...mediumVoltageRequests, ...stedinMediumVoltageRequests]
  const { results, failures } = await fetchUtilityLayersResilient(requests, bounds, signal)
  return publicUtilityCollection(
    utility === 'power' ? 'power-detail' : 'gas-detail',
    results,
    bounds,
    zoom,
    minimumZoom,
    ['liander-open-data', 'stedin-open-data'],
    failures,
  )
}

const publicServiceAreaLayers: Record<PublicServiceAreaDiscipline, string> = {
  power: 'netbeheergebieden_elektriciteit',
  gas: 'netbeheergebieden_gas',
  water: 'netbeheergebieden_water',
  drainage: 'netbeheergebieden_riolering',
  telecom: 'netbeheergebieden_media',
}

function webMercatorPoint([longitude, latitude]: Coordinates): [number, number] {
  const x = longitude * 20_037_508.342789244 / 180
  const boundedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude))
  const y = Math.log(Math.tan((90 + boundedLatitude) * Math.PI / 360)) /
    (Math.PI / 180) * 20_037_508.342789244 / 180
  return [x, y]
}

/**
 * Identifies public provider territories at a municipality reference point via
 * WMS GetFeatureInfo. Territory is responsibility context, never topology,
 * connectivity, capacity, coverage quality, telemetry or incident state.
 */
export async function loadPublicServiceAreaContext(
  discipline: PublicServiceAreaDiscipline,
  coordinates: Coordinates,
  signal?: AbortSignal,
): Promise<PublicServiceAreaContext> {
  const layer = publicServiceAreaLayers[discipline]
  const [x, y] = webMercatorPoint(coordinates)
  const halfSpanM = 600
  const parameters = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetFeatureInfo',
    layers: `mijnaansluiting_open:${layer}`,
    query_layers: `mijnaansluiting_open:${layer}`,
    styles: '',
    crs: 'EPSG:3857',
    bbox: `${x - halfSpanM},${y - halfSpanM},${x + halfSpanM},${y + halfSpanM}`,
    width: '101',
    height: '101',
    i: '50',
    j: '50',
    info_format: 'application/json',
    feature_count: '50',
  })
  const endpoint = 'https://public.geodata.mijnaansluiting.nl/geoserver/mijnaansluiting_open/ows'
  const response = await fetch(`${endpoint}?${parameters}`, { signal })
  if (!response.ok) throw new Error(`provider-area lookup returned ${response.status}`)
  const payload = await response.json() as {
    features?: Array<{ properties?: Record<string, unknown> }>
  }
  const providers = (payload.features ?? []).map(({ properties = {} }) => ({
    code: typeof properties.netbeheerderCode === 'string' ? properties.netbeheerderCode : null,
    name: typeof properties.netbeheerderLabel === 'string'
      ? properties.netbeheerderLabel
      : typeof properties.netbeheerderName === 'string'
        ? properties.netbeheerderName
        : 'Unnamed provider',
    legalName: typeof properties.netbeheerderName === 'string' ? properties.netbeheerderName : null,
    website: typeof properties.website === 'string' ? properties.website : null,
    lastUpdated: typeof properties.lastUpdated === 'string' ? properties.lastUpdated : null,
  }))
  const uniqueProviders = [...new Map(providers.map((provider) => [
    `${provider.code ?? ''}:${provider.name}`,
    provider,
  ])).values()]
  return {
    discipline,
    providers: uniqueProviders,
    queriedAt: new Date().toISOString(),
    evidenceClass: 'official-context',
    affectsSimulation: false,
    source: {
      id: 'mijnaansluiting-netbeheergebieden',
      publisher: 'Stichting Mijn Aansluiting',
      url: 'https://wiki.service.mijnaansluiting.nl/wiki/spaces/Wiki/pages/693731329',
      license: 'Public Domain',
      coverage: 'provider-supplied',
      coverageNote:
        'Responsible-provider territory at the municipal reference point; sewer and media coverage can be incomplete or overlapping.',
      updateCadence:
        'Live public WMS/WFS; record update timestamps vary by provider and discipline.',
    },
  }
}

export async function loadRegionBundle(
  municipalityCode: string,
  signal?: AbortSignal,
): Promise<MunicipalityRegionBundle> {
  const [bundle, settlements] = await Promise.all([
    fetchGzipJson<Omit<MunicipalityRegionBundle, 'settlements'>>(
      `data/regions/${municipalityCode}.json.gz`,
      signal,
    ),
    fetchGzipJson<MunicipalityRegionBundle['settlements']>(
      `data/settlements/${municipalityCode}.geojson.gz`,
      signal,
    ),
  ])
  return { ...bundle, settlements }
}

export function bundleToLocalRegions(
  bundle: MunicipalityRegionBundle,
): LocalRegionDefinition[] {
  const share = (part: number | null, total: number | null) =>
    typeof part === 'number' && typeof total === 'number' && total > 0
      ? part / total
      : null
  return bundle.neighborhoods.features.map((feature) => {
    const stats = feature.properties.statistics
    const population = stats.population
    return {
      id: String(feature.id),
      municipalityId: bundle.municipalityCode,
      name: feature.properties.name,
      geometry: feature.geometry,
      coordinates: feature.properties.center ?? undefined,
      population,
      // CBS demographics describe assistance needs, not operator restoration
      // priority or physical utility topology. Unknown operational priority is
      // neutral until an incident policy or sourced asset says otherwise.
      priority: 2,
      isHub: false,
      sourceType: 'official',
      context: {
        age65Share: share(stats.age65Plus, stats.population),
        onePersonHouseholdShare: share(stats.onePersonHouseholds, stats.households),
        multiFamilyHomeShare:
          typeof stats.multiFamilyHomePct === 'number'
            ? stats.multiFamilyHomePct / 100
            : null,
        socialAssistanceShare: share(stats.socialAssistanceRecipients, stats.population),
        carsPerHousehold: stats.carsPerHousehold,
        populationDensityPerKm2: stats.populationDensity,
        distanceToDoctorKm: stats.distanceToDoctorKm,
        distanceToSupermarketKm: stats.distanceToSupermarketKm,
        landAreaHa: stats.landAreaHa,
        waterAreaHa: stats.waterAreaHa,
        businesses: stats.businesses,
        nonResidentialBuildings: stats.nonResidentialBuildings,
      },
    }
  })
}
