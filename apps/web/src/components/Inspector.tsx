import { useMemo, type CSSProperties } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Building2,
  CheckCircle2,
  Clock3,
  Flame,
  Gauge,
  Info,
  MapPin,
  Network,
  Route,
  Users,
} from 'lucide-react'
import { distanceKm, formatSimulationTime } from '@disaster/sim-core'
import type {
  CityDetailFrame,
  DistrictSnapshot,
  LayerId,
  MunicipalitySnapshot,
  SimulationFrame,
} from '@disaster/sim-core'
import { layerById } from '../config'
import type {
  MunicipalityRegionBundle,
  PublicAcuteCareCollection,
  PublicEducationLocationCollection,
  PublicAntennaSiteCollection,
  PublicAirQualityCollection,
  PublicSeismicEventCollection,
  PublicFacilityCollection,
  PublicRadarContext,
  PublicPrecipitationProbabilityContext,
  PublicRoadSituationCollection,
  PublicWeatherObservationCollection,
  PublicWeatherWarningCollection,
  PublicServiceAreaContext,
  PublicWaterAssetCollection,
  PublicWaterForecastCollection,
  PublicWaterObservationCollection,
  PublicCapacityContextCollection,
  PublicGtsFlowContext,
  RegionalStatistics,
} from '../data'
import {
  isExplicitlyWithdrawnPublicWaterAsset,
  nearestPrecipitationProbabilityCheckpoint,
  nearestWaterForecastCheckpoint,
} from '../data'
import { compactNumber, numberFormat, percent } from '../utils'
import { CausalExplanation } from './CausalExplanation'

const capacityNumberFormat = new Intl.NumberFormat('en-NL', { maximumFractionDigits: 2 })

interface InspectorProps {
  frame: SimulationFrame
  selected: MunicipalitySnapshot
  cityDetail: CityDetailFrame | null
  selectedDistrict: DistrictSnapshot | null
  regionBundle: MunicipalityRegionBundle | null
  safetyRegionName: string | null
  publicWaterAssets: PublicWaterAssetCollection | null
  publicFacilities: PublicFacilityCollection | null
  publicAcuteCare: PublicAcuteCareCollection | null
  publicEducationLocations: PublicEducationLocationCollection | null
  publicAntennaSites: PublicAntennaSiteCollection | null
  publicRadarContext: PublicRadarContext | null
  publicPrecipitationProbabilityContext: PublicPrecipitationProbabilityContext | null
  publicWeatherObservations: PublicWeatherObservationCollection | null
  publicWeatherWarnings: PublicWeatherWarningCollection | null
  publicAirQuality: PublicAirQualityCollection | null
  publicSeismicEvents: PublicSeismicEventCollection | null
  publicWaterObservations: PublicWaterObservationCollection | null
  publicWaterForecasts: PublicWaterForecastCollection | null
  publicCapacityContext: PublicCapacityContextCollection | null
  publicGtsFlowContext: PublicGtsFlowContext | null
  publicRoadSituations: PublicRoadSituationCollection | null
  publicServiceArea: PublicServiceAreaContext | null
  activeLayer: LayerId
  viewMode: 'national' | 'city'
  mobileOpen?: boolean
  onOpenCity: () => void
  onCloseDistrict: () => void
}

function serviceForLayer(selected: MunicipalitySnapshot, layer: LayerId) {
  if (layer === 'overview' || layer === 'hazard' || layer === 'population') {
    return selected.services[selected.limitingService]
  }
  return selected.services[layer]
}

function hazardHeadline(selected: MunicipalitySnapshot) {
  const hazard = selected.hazard
  if (hazard.spatialEvidence === 'unsupported') return 'Local result unavailable'
  if (hazard.disaster === 'cyberattack') return `${percent(hazard.cyberDisruption)} digital disruption`
  if (hazard.disaster === 'heatwave') return `${hazard.heatC.toFixed(1)} °C air temperature`
  if (hazard.disaster === 'winter-storm') return `${hazard.snowCmH.toFixed(1)} cm/h snow`
  if (hazard.disaster === 'earthquake') return `${hazard.groundMotionG.toFixed(3)} g scenario proxy`
  if (hazard.disaster === 'wildfire') return `${percent(hazard.wildfireIntensity)} fire intensity`
  if (hazard.disaster === 'river-flood' || hazard.disaster === 'coastal-flood') {
    return `${percent(Math.min(1, hazard.floodDepthM / 1.5))} inundation stress`
  }
  return `${Math.round(hazard.rainMmH)} mm/h rain`
}

export function Inspector({
  frame,
  selected,
  cityDetail,
  selectedDistrict,
  regionBundle,
  safetyRegionName,
  publicWaterAssets,
  publicFacilities,
  publicAcuteCare,
  publicEducationLocations,
  publicAntennaSites,
  publicRadarContext,
  publicPrecipitationProbabilityContext,
  publicWeatherObservations,
  publicWeatherWarnings,
  publicAirQuality,
  publicSeismicEvents,
  publicWaterObservations,
  publicWaterForecasts,
  publicCapacityContext,
  publicGtsFlowContext,
  publicRoadSituations,
  publicServiceArea,
  activeLayer,
  viewMode,
  mobileOpen = false,
  onOpenCity,
  onCloseDistrict,
}: InspectorProps) {
  const definition = layerById[activeLayer]
  const service = serviceForLayer(selected, activeLayer)
  const heroValue = selectedDistrict
    ? activeLayer === 'hazard'
      ? selectedDistrict.hazardSeverity
      : activeLayer === 'population'
        ? selectedDistrict.affectedPopulation / Math.max(1, selectedDistrict.population)
        : selectedDistrict.availability
    : activeLayer === 'hazard'
      ? selected.hazard.severity
      : activeLayer === 'population'
        ? selected.affectedPopulation / Math.max(1, selected.population)
        : activeLayer === 'overview'
          ? service.availability
          : service.availability
  const unsupportedHazard =
    activeLayer === 'hazard' && selected.hazard.spatialEvidence === 'unsupported'
  const partiallySupportedWildfire =
    selected.hazard.disaster === 'wildfire' &&
    selected.hazard.unsupportedDimensions?.includes('fire')
  const affectedPopulation = selectedDistrict?.affectedPopulation ?? selected.affectedPopulation
  const inspectedPopulation = selectedDistrict?.population ?? selected.population
  const metricHeadline =
    unsupportedHazard
      ? 'Local result unavailable'
      : activeLayer === 'hazard'
      ? selectedDistrict
        ? `${Math.round(selectedDistrict.hazardSeverity * 100)}% local severity`
        : hazardHeadline(selected)
      : activeLayer === 'population'
        ? `${compactNumber.format(affectedPopulation)} under pressure`
        : selectedDistrict?.status ?? service.status
  const displayedEvidenceClass = activeLayer === 'hazard'
    ? selected.hazard.spatialEvidence ?? 'synthetic'
      : service.confidence
  const precipitationProbabilityCheckpoint = publicPrecipitationProbabilityContext
    ? nearestPrecipitationProbabilityCheckpoint(publicPrecipitationProbabilityContext, frame.hour)
    : null
  const networkLayer =
    activeLayer === 'overview' || activeLayer === 'hazard' || activeLayer === 'population'
      ? selected.limitingService
      : activeLayer
  const officialNeighborhood = selectedDistrict
    ? regionBundle?.neighborhoods.features.find((feature) => String(feature.id) === selectedDistrict.id)
    : undefined
  const officialStats = officialNeighborhood?.properties.statistics
  const statistic = (key: keyof RegionalStatistics, suffix = '') => {
    const value = officialStats?.[key]
    return typeof value === 'number' ? `${numberFormat.format(value)}${suffix}` : 'Unknown'
  }
  const selectedEducationLocations = useMemo(
    () => publicEducationLocations?.features.filter(
      (feature) => feature.properties.municipalityCode === selected.id,
    ).length ?? 0,
    [publicEducationLocations, selected.id],
  )
  const selectedAntennaSites = useMemo(
    () => publicAntennaSites?.features.filter(
      (feature) => feature.properties.municipalityCode === selected.id,
    ).length ?? 0,
    [publicAntennaSites, selected.id],
  )
  const selectedAirQualityStations = useMemo(
    () => publicAirQuality?.features.filter(
      (feature) => feature.properties.municipalityCode === selected.id,
    ).length ?? 0,
    [publicAirQuality, selected.id],
  )
  const selectedSeismicEvents = useMemo(
    () => publicSeismicEvents?.features.filter(
      (feature) => feature.properties.municipalityCode === selected.id,
    ).length ?? 0,
    [publicSeismicEvents, selected.id],
  )
  const selectedWaterObservations = useMemo(() => {
    const observations = publicWaterObservations?.features.filter(
      (feature) => feature.properties.municipalityCode === selected.id,
    ) ?? []
    return {
      waterLevels: observations.filter(
        (feature) => feature.properties.observationType === 'water-level',
      ).length,
      discharges: observations.filter(
        (feature) => feature.properties.observationType === 'discharge',
      ).length,
    }
  }, [publicWaterObservations, selected.id])
  const waterForecastCheckpoint = nearestWaterForecastCheckpoint(frame.step / 4)
  const selectedWaterForecasts = useMemo(() => {
    const checkpointFeatures = publicWaterForecasts?.features.filter(
      (feature) => feature.properties.requestedLeadEndHours === waterForecastCheckpoint,
    ) ?? []
    const selectedFeatures = checkpointFeatures.filter(
      (feature) => feature.properties.municipalityCode === selected.id,
    )
    const snapshots = publicWaterForecasts?.snapshots.filter(
      (snapshot) => snapshot.requestedLeadEndHours === waterForecastCheckpoint,
    ) ?? []
    const validTimes = checkpointFeatures
      .map((feature) => feature.properties.validAt)
      .sort()
    return {
      waterLevels: selectedFeatures.filter(
        (feature) => feature.properties.forecastType === 'water-level',
      ).length,
      discharges: selectedFeatures.filter(
        (feature) => feature.properties.forecastType === 'discharge',
      ).length,
      nationalWaterLevels: snapshots.find(
        (snapshot) => snapshot.forecastType === 'water-level',
      )?.returnedFeatures ?? 0,
      nationalDischarges: snapshots.find(
        (snapshot) => snapshot.forecastType === 'discharge',
      )?.returnedFeatures ?? 0,
      noDataTypes: snapshots
        .filter((snapshot) => snapshot.noData)
        .map((snapshot) => snapshot.forecastType),
      validTimeRange: validTimes.length
        ? { earliest: validTimes[0], latest: validTimes.at(-1)! }
        : null,
    }
  }, [publicWaterForecasts, selected.id, waterForecastCheckpoint])
  const selectedCapacitySample = useMemo(
    () => publicCapacityContext?.features.find(
      (feature) => feature.properties.municipalityCode === selected.id,
    ) ?? null,
    [publicCapacityContext, selected.id],
  )
  const selectedWarningProvince = useMemo(
    () => publicWeatherWarnings?.features.find(
      (feature) => feature.properties.municipalityCodes.includes(selected.id),
    ) ?? null,
    [publicWeatherWarnings, selected.id],
  )
  const nearestWeatherObservation = useMemo(() => {
    if (!publicWeatherObservations?.features.length) return null
    return publicWeatherObservations.features
      .map((feature) => ({
        feature,
        distanceKm: distanceKm(selected.coordinates, [
          feature.geometry.coordinates[0],
          feature.geometry.coordinates[1],
        ]),
      }))
      .sort((left, right) => left.distanceKm - right.distanceKm)[0] ?? null
  }, [publicWeatherObservations, selected.coordinates])
  const selectedWarningPeriods = selectedWarningProvince
    ? publicWeatherWarnings?.warnings.filter(
        (warning) => warning.locationCode === selectedWarningProvince.properties.knmiLocationCode,
      ) ?? []
    : []
  const capacityMw = (value: number | null) =>
    typeof value === 'number' ? `${capacityNumberFormat.format(value)} MW` : 'Unknown'
  const waterAssetRegisterCounts = useMemo(() => {
    const withdrawn = publicWaterAssets?.features.filter(
      isExplicitlyWithdrawnPublicWaterAsset,
    ).length ?? 0
    return {
      displayed: Math.max(0, (publicWaterAssets?.features.length ?? 0) - withdrawn),
      withdrawn,
    }
  }, [publicWaterAssets])
  const selectedWaterAssetRegisterCounts = useMemo(() => {
    const assigned = publicWaterAssets?.features.filter(
      (feature) => feature.properties.municipalityCode === selected.id,
    ) ?? []
    const withdrawn = assigned.filter(isExplicitlyWithdrawnPublicWaterAsset).length
    return {
      displayed: Math.max(0, assigned.length - withdrawn),
      withdrawn,
    }
  }, [publicWaterAssets, selected.id])
  const selectedWaterAssetAssignmentText = selectedWaterAssetRegisterCounts.displayed > 0
    ? `${numberFormat.format(selectedWaterAssetRegisterCounts.displayed)} objects are assigned to ${selected.name} by full-resolution CBS 2025 polygon containment${selectedWaterAssetRegisterCounts.withdrawn ? `; ${numberFormat.format(selectedWaterAssetRegisterCounts.withdrawn)} assigned withdrawn ${selectedWaterAssetRegisterCounts.withdrawn === 1 ? 'record is' : 'records are'} excluded` : ''}.`
    : `No object from this partial snapshot is assigned to ${selected.name}; that no-match is a coverage result, never proof that no water asset or dependency exists.`
  const groundwaterRegistrationContext =
    activeLayer === 'water' ||
    activeLayer === 'drainage' ||
    (activeLayer === 'hazard' &&
      (['pluvial-flood', 'river-flood', 'coastal-flood', 'heatwave', 'wildfire'].includes(
        frame.scenario.disaster,
      ) ||
        (frame.scenario.disaster === 'compound' &&
          frame.scenario.components?.some((component) =>
            ['pluvial-flood', 'river-flood', 'coastal-flood', 'heatwave', 'wildfire'].includes(
              component,
            )))))
  const scenarioReferenceDate = frame.scenario.referenceDate
  const dordrechtN3RestrictionActive = Boolean(
    scenarioReferenceDate &&
    '2026-07-17' <= scenarioReferenceDate &&
    scenarioReferenceDate <= '2027-04-21',
  )
  const dordrechtN3ValidityMessage = !scenarioReferenceDate
    ? 'This exercise has no reference date, so the notice is visible context but is not silently applied. Set an optional Reference date under Advanced assumptions to bind valid-time records.'
    : dordrechtN3RestrictionActive
      ? `The run is aligned to ${scenarioReferenceDate}; the matching N3 mobility and road-logistics edge is closed at zero scenario capacity.`
      : `The run is aligned to ${scenarioReferenceDate}, outside the published closure interval; this record is not applied and does not itself prove the bridge open.`
  const gorinchemA27RestrictionActive = Boolean(
    scenarioReferenceDate &&
    '2026-07-18' <= scenarioReferenceDate &&
    scenarioReferenceDate <= '2026-09-03',
  )
  const gorinchemA27ValidityMessage = !scenarioReferenceDate
    ? 'This exercise has no reference date, so the current-status notice is visible context but is not silently applied. Set an optional Reference date under Advanced assumptions to align valid-time evidence.'
    : gorinchemA27RestrictionActive
      ? `The run is aligned to ${scenarioReferenceDate}, inside the interval verified through retrieval on 3 September 2026. The class restriction is attached as official context but does not reduce generalized route capacity because no public vehicle mix or throughput loss was published.`
      : `The run is aligned to ${scenarioReferenceDate}, outside the evidence interval ending on retrieval day; the record is not extrapolated and does not prove unrestricted passage.`
  const krimpenAlgerabrugRestrictionActive = Boolean(
    scenarioReferenceDate &&
    '2026-08-10' <= scenarioReferenceDate &&
    scenarioReferenceDate <= '2026-09-07',
  )
  const krimpenAlgerabrugValidityMessage = !scenarioReferenceDate
    ? 'This exercise has no reference date, so the official maintenance notice is visible context but is not silently applied. Set an optional Reference date under Advanced assumptions to align valid-time evidence.'
    : krimpenAlgerabrugRestrictionActive
      ? `The run is aligned to ${scenarioReferenceDate}, inside the published maintenance interval. The role-specific restriction is attached as official context but does not reduce generalized route capacity because no public vehicle mix or alternative throughput was published.`
      : `The run is aligned to ${scenarioReferenceDate}, outside the published interval; the record is not applied and does not prove unrestricted passage.`
  const spanjaardsbrugRestrictionActive = Boolean(
    scenarioReferenceDate &&
    '2026-08-17' <= scenarioReferenceDate &&
    scenarioReferenceDate <= '2026-09-11',
  )
  const spanjaardsbrugValidityMessage = !scenarioReferenceDate
    ? 'This exercise has no reference date, so the municipal notice is visible context but is not silently treated as current. Set an optional Reference date under Advanced assumptions to align valid-time evidence.'
    : spanjaardsbrugRestrictionActive
      ? `The run is aligned to ${scenarioReferenceDate}, inside the published closure interval. The role-specific record is attached as official context, but the local route remains excluded from causal transfers because no defensible traffic mix, direction geometry or detour throughput is available.`
      : `The run is aligned to ${scenarioReferenceDate}, outside the published interval; the record is not active and does not prove unrestricted passage.`
  const kelperbrugRestrictionActive = Boolean(
    scenarioReferenceDate &&
    '2026-06-09' <= scenarioReferenceDate &&
    scenarioReferenceDate <= '2026-09-03',
  )
  const kelperbrugValidityMessage = !scenarioReferenceDate
    ? 'This exercise has no reference date, so the latest-known restriction is visible context but is not silently applied. Set an optional Reference date under Advanced assumptions to align valid-time evidence.'
    : kelperbrugRestrictionActive
      ? `The run is aligned to ${scenarioReferenceDate}, inside the evidence interval verified through retrieval on 3 September 2026. The vehicle-class restriction is attached as official context but does not reduce the generalized route capacity because no public vehicle mix or throughput loss was published.`
      : `The run is aligned to ${scenarioReferenceDate}, outside the evidence interval ending on retrieval day; the record is not extrapolated and does not prove unrestricted passage.`
  const rijndijkRestrictionActive = Boolean(
    scenarioReferenceDate &&
    '2026-08-24' <= scenarioReferenceDate &&
    scenarioReferenceDate <= '2026-10-02',
  )
  const rijndijkValidityMessage = !scenarioReferenceDate
    ? 'This exercise has no reference date, so the municipal closure is visible context but is not silently treated as current. Set an optional Reference date under Advanced assumptions to align valid-time evidence.'
    : rijndijkRestrictionActive
      ? `The run is aligned to ${scenarioReferenceDate}, inside the published closure interval. The exact internal segment is shown as gray context, but it remains excluded from causal transfers because the public notice does not provide modal exceptions, emergency priority, queue or detour throughput.`
      : `The run is aligned to ${scenarioReferenceDate}, outside the published interval; the record is not active and does not prove unrestricted passage.`
  const lisserwegValidityMessage = !scenarioReferenceDate
    ? 'This exercise has no reference date, so the road-work lifecycle is visible context but is not silently treated as current. Set an optional Reference date under Advanced assumptions to align valid-time evidence.'
    : scenarioReferenceDate >= '2026-09-03' && scenarioReferenceDate <= '2026-09-05'
      ? `The run is aligned to ${scenarioReferenceDate}, inside the audit's verified closure window: the A44 main carriageway is open, while the Lisserweg underpass and Lisserweg–Kaagweg connection remain closed.`
      : scenarioReferenceDate === '2026-09-06'
        ? `The run is aligned to ${scenarioReferenceDate}, the published planned reopening day. No exact opening time or completion confirmation is available, so underpass state remains Unknown rather than being switched to open.`
        : `The run is aligned to ${scenarioReferenceDate}, outside the narrowly verified closure window; the notice does not prove the underpass or the separately scheduled Hoofdvaart works open or closed.`
  const linneFootCycleClosureActive = Boolean(
    scenarioReferenceDate &&
    '2026-08-28' <= scenarioReferenceDate &&
    scenarioReferenceDate <= '2026-09-04',
  )
  const linneValidityMessage = !scenarioReferenceDate
    ? 'This exercise has no reference date, so the official active-mode closure is visible context but is not silently treated as current. Set an optional Reference date under Advanced assumptions to align valid-time evidence.'
    : linneFootCycleClosureActive
      ? `The run is aligned to ${scenarioReferenceDate}, inside the published closure interval. This applies to the Stuw Linne pedestrian/cycle crossing only and cannot numerically close or reduce an A-road logistics edge.`
      : `The run is aligned to ${scenarioReferenceDate}, outside the published interval; the notice is not active and does not prove unrestricted crossing.`

  return (
    <aside id="selected-location-details" className={`inspector panel${mobileOpen ? ' mobile-open' : ''}`} aria-label="Selected location details">
      <div className="inspector-header">
        <div>
          <span className="eyebrow">{viewMode === 'city' ? 'Municipal simulation' : 'National gateway'}</span>
          <h2>{selectedDistrict?.name ?? selected.name}</h2>
          <p><MapPin size={13} /> {selectedDistrict ? `${selected.name} · CBS buurt${officialNeighborhood?.properties.districtName ? ` · ${officialNeighborhood.properties.districtName}` : ''}` : `${selected.id} · municipality`}{safetyRegionName ? ` · VR ${safetyRegionName}` : ''}</p>
        </div>
        {selectedDistrict && (
          <button type="button" className="text-button" onClick={onCloseDistrict}>Municipality</button>
        )}
      </div>

      <div className="status-hero" style={{ '--status-color': definition.color } as CSSProperties}>
        <div className="availability-ring" style={{ '--availability': `${heroValue * 360}deg` } as CSSProperties}>
          <div>
            <strong>{unsupportedHazard ? '?' : Math.round(heroValue * 100)}</strong><span>{unsupportedHazard ? '' : '%'}</span>
          </div>
        </div>
        <div className="status-hero-copy">
          <span>{definition.metric}</span>
          <strong>{metricHeadline}</strong>
          <small>{definition.sourceType} · evidence class {displayedEvidenceClass}</small>
        </div>
      </div>

      {viewMode === 'national' && (
        <button type="button" className="open-city-button" onClick={onOpenCity}>
          Open detailed {selected.name} simulation <ArrowRight size={16} />
        </button>
      )}

      {activeLayer === 'hazard' ? (
        <div className="mini-grid">
          {unsupportedHazard && !partiallySupportedWildfire ? (
            <>
              <div><AlertTriangle size={15} /><span>Local hazard</span><strong>Unknown</strong></div>
              <div><MapPin size={15} /><span>Spatial evidence</span><strong>Unsupported</strong></div>
              <div><Clock3 size={15} /><span>Scenario clock</span><strong>{formatSimulationTime(frame.step)}</strong></div>
            </>
          ) : selected.hazard.disaster === 'cyberattack' ? (
            <>
              <div><Network size={15} /><span>Digital disruption</span><strong>{percent(selected.hazard.cyberDisruption)}</strong></div>
              <div><Clock3 size={15} /><span>Response delay</span><strong>{frame.scenario.responseDelayHours} h</strong></div>
              <div><Gauge size={15} /><span>Preparedness</span><strong>{percent(frame.scenario.preparedness)}</strong></div>
            </>
          ) : selected.hazard.disaster === 'heatwave' || selected.hazard.disaster === 'wildfire' ? (
            <>
              <div><Gauge size={15} /><span>Temperature</span><strong>{selected.hazard.heatC.toFixed(1)} °C</strong></div>
              <div><AlertTriangle size={15} /><span>Drought stress</span><strong>{percent(selected.hazard.droughtSeverity)}</strong></div>
              <div><Route size={15} /><span>{selected.hazard.disaster === 'wildfire' ? 'Smoke' : 'Heat stress'}</span><strong>{percent(selected.hazard.disaster === 'wildfire' ? selected.hazard.smokeSeverity : selected.hazard.severity)}</strong></div>
              {selected.hazard.disaster === 'wildfire' && (
                <div><Flame size={15} /><span>Direct flame</span><strong>{selected.hazard.unsupportedDimensions?.includes('fire') ? 'Unknown' : percent(selected.hazard.wildfireIntensity)}</strong></div>
              )}
            </>
          ) : selected.hazard.disaster === 'winter-storm' ? (
            <>
              <div><Gauge size={15} /><span>Temperature</span><strong>{selected.hazard.heatC.toFixed(1)} °C</strong></div>
              <div><AlertTriangle size={15} /><span>Snow</span><strong>{selected.hazard.snowCmH.toFixed(1)} cm/h</strong></div>
              <div><Route size={15} /><span>Ice severity</span><strong>{percent(selected.hazard.iceSeverity)}</strong></div>
            </>
          ) : (
            <>
              <div><Gauge size={15} /><span>Rainfall</span><strong>{Math.round(selected.hazard.rainMmH)} mm/h</strong></div>
              <div><AlertTriangle size={15} /><span>Flood stress</span><strong>{unsupportedHazard ? 'Unknown' : percent(Math.min(1, selected.hazard.floodDepthM / 1.5))}</strong></div>
              <div><Route size={15} /><span>Wind gust</span><strong>{Math.round(selected.hazard.windGustMs)} m/s</strong></div>
            </>
          )}
          <div><MapPin size={15} /><span>Local severity</span><strong>{unsupportedHazard ? 'Unknown' : percent(heroValue)}</strong></div>
        </div>
      ) : activeLayer === 'population' ? (
        <div className="mini-grid">
          <div><Users size={15} /><span>Population</span><strong>{compactNumber.format(inspectedPopulation)}</strong></div>
          <div><AlertTriangle size={15} /><span>Under pressure</span><strong>{compactNumber.format(affectedPopulation)}</strong></div>
          <div><Gauge size={15} /><span>Impact share</span><strong>{percent(heroValue)}</strong></div>
          <div><Building2 size={15} /><span>Limiting service</span><strong>{selected.limitingService}</strong></div>
        </div>
      ) : (
        <div className="mini-grid">
          <div><Users size={15} /><span>Population</span><strong>{compactNumber.format(inspectedPopulation)}</strong></div>
          <div><Gauge size={15} /><span>Demand</span><strong>{Math.round(selectedDistrict?.demand ?? service.demand)} u/h</strong></div>
          <div><Boxes size={15} /><span>Delivered</span><strong>{Math.round(selectedDistrict?.delivered ?? service.delivered)} u/h</strong></div>
          <div><Clock3 size={15} /><span>Reserve</span><strong>{(selectedDistrict?.reserveHours ?? service.reserveHours).toFixed(1)} h</strong></div>
        </div>
      )}

      <CausalExplanation
        selected={selected}
        selectedDistrict={selectedDistrict}
        activeLayer={activeLayer}
      />

      {cityDetail && viewMode === 'city' && (
        <section className="inspector-section">
          <div className="section-heading"><Boxes size={15} /><h3>{layerById[networkLayer].compactLabel} network flow</h3></div>
          <div className="flow-row"><span>National gateway</span><strong>{Math.round(cityDetail.inboundSupply)} u/h</strong></div>
          <div className="flow-rail"><i style={{ width: `${Math.min(100, (cityDetail.inboundSupply / Math.max(1, cityDetail.localDemand)) * 100)}%` }} /></div>
          <div className="flow-row subtle"><span>Local demand</span><strong>{Math.round(cityDetail.localDemand)} u/h</strong></div>
          <p className="explain-copy">Municipal gateway allocation reconciles exactly to the national frame. Select a buurt to inspect its local demand, reserve and upstream constraint.</p>
        </section>
      )}

      {officialStats && selectedDistrict && (
        <section className="inspector-section">
          <div className="section-heading"><Users size={15} /><h3>Official buurt context · 2025</h3></div>
          <div className="official-stat-grid">
            <div><span>Residents</span><strong>{statistic('population')}</strong></div>
            <div><span>Density</span><strong>{statistic('populationDensity', '/km²')}</strong></div>
            <div><span>Age 65+</span><strong>{statistic('age65Plus')}</strong></div>
            <div><span>Households</span><strong>{statistic('households')}</strong></div>
            <div><span>Businesses</span><strong>{statistic('businesses')}</strong></div>
            <div><span>Non-residential buildings</span><strong>{statistic('nonResidentialBuildings')}</strong></div>
            <div><span>Apartments</span><strong>{statistic('multiFamilyHomePct', '%')}</strong></div>
            <div><span>Social rent</span><strong>{statistic('socialRentalPct', '%')}</strong></div>
            <div><span>Cars</span><strong>{statistic('cars')}</strong></div>
            <div><span>Doctor distance</span><strong>{statistic('distanceToDoctorKm', ' km')}</strong></div>
          </div>
          <p className="explain-copy">This buurt carries 36 CBS fields in the regional data bundle; operational impacts remain simulated.</p>
        </section>
      )}

      <section className="inspector-section">
        <div className="section-heading"><Info size={15} /><h3>Current evidence</h3></div>
        <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official geography</strong><span>CBS 2025 municipality/buurt and BAG woonplaats boundaries</span></div></div>
        {viewMode === 'city' && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official street-scale object geography · BGT</strong><span>PDOK Basisregistratie Grootschalige Topografie background tiles from zoom 17 · detailed buildings, roads, water, bridges and terrain · daily, CC0 1.0. This is reference geometry, not building occupancy, route passability, asset condition, hazard exposure, operational capacity or a T+72 forecast, and it does not affect the simulation.</span></div></div>
        )}
        {viewMode === 'city' && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official building register · BAG</strong><span>Kadaster LV-BAG/PDOK in-use and renovation building polygons from zoom 17 on Hazard, Population and Facilities · daily · Public Domain Mark 1.0. Registered status, year and use-purpose attributes are reference context—not occupants, construction fragility, accessibility, refuge suitability, generator capacity, live use or a T+72 state—and do not affect the simulation.</span></div></div>
        )}
        {regionBundle?.operationalBoundary && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Audited full-resolution boundary</strong><span>CBS 2025 non-generalized municipality and buurt geometry · preserves Baarle-Nassau's 9 components and 22 Belgian enclave holes</span></div></div>
        )}
        {safetyRegionName && <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official response geography</strong><span>Safety region {safetyRegionName} · CBS/PDOK 2025</span></div></div>}
        <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official transport</strong><span>RWS NWB roads and ProRail traces/stations</span></div></div>
        {(unsupportedHazard || selected.hazard.unsupportedDimensions?.length) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Known pathway, missing local scenario layer</strong><span>{selected.hazard.evidenceNote}</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && publicWaterAssets && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official water assets</strong><span>{selectedWaterAssetAssignmentText} Nationally, {numberFormat.format(waterAssetRegisterCounts.displayed)} IMWA/DAMO register objects not explicitly withdrawn are shown by default; {numberFormat.format(waterAssetRegisterCounts.withdrawn)} records marked “niet meer aanwezig” remain in the source snapshot but are excluded from the map · register context, not physical connectivity or live status; outside or boundary-ambiguous records remain unassigned, never absent; “gerealiseerd” never proves operation</span></div></div>
        )}
        {(activeLayer === 'water' ||
          (activeLayer === 'hazard' &&
            (frame.scenario.disaster === 'river-flood' || frame.scenario.disaster === 'coastal-flood'))) &&
          publicWaterObservations && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Observed water levels and discharge · RWS Waterinfo</strong><span>{numberFormat.format(publicWaterObservations.counts.waterLevelObservations)} latest water-level and {numberFormat.format(publicWaterObservations.counts.dischargeObservations)} latest discharge station observations; {numberFormat.format(publicWaterObservations.counts.freshness.fresh)} were at most 90 minutes old, {numberFormat.format(publicWaterObservations.counts.freshness.delayed)} delayed and {numberFormat.format(publicWaterObservations.counts.freshness.stale)} stale at the {new Date(publicWaterObservations.retrievedAt).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })} deployment retrieval, with {numberFormat.format(publicWaterObservations.counts.possiblyFaultyObservations)} publisher-flagged possibly faulty. {selected.name} has {numberFormat.format(selectedWaterObservations.waterLevels)} level and {numberFormat.format(selectedWaterObservations.discharges)} discharge observations assigned by CBS polygon. LMW measurements are generally produced every 10 minutes and the API response is cached for five minutes · CC0 unless an individual component states otherwise; Waterinfo is not a mission-critical service. Values are local station context—not a continuous hydraulic surface, threshold outside the labelled location, breach, inundation depth, scenario-aligned forecast or operating instruction—and do not affect the simulation. No municipal station means no data, never zero or safe.</span></div></div>
        )}
        {(activeLayer === 'water' ||
          (activeLayer === 'hazard' &&
            (frame.scenario.disaster === 'river-flood' || frame.scenario.disaster === 'coastal-flood'))) &&
          publicWaterForecasts && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Issued water-level and discharge guidance · RWS Waterinfo</strong><span>At {formatSimulationTime(frame.step)}, the nearest cached rolling context is the requested +{waterForecastCheckpoint}h checkpoint: {numberFormat.format(selectedWaterForecasts.nationalWaterLevels)} water-level and {numberFormat.format(selectedWaterForecasts.nationalDischarges)} discharge point forecasts nationally. Across all cached checkpoints, strict CBS polygon containment represents {numberFormat.format(publicWaterForecasts.counts.municipalitiesRepresented)} municipalities; {selected.name} has {numberFormat.format(selectedWaterForecasts.waterLevels)} level and {numberFormat.format(selectedWaterForecasts.discharges)} discharge points at this checkpoint. {selectedWaterForecasts.validTimeRange ? <>Point valid times span {new Date(selectedWaterForecasts.validTimeRange.earliest).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })} to {new Date(selectedWaterForecasts.validTimeRange.latest).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })}.</> : <>The selected checkpoint contains no returned point valid times.</>} {selectedWaterForecasts.noDataTypes.length === 2 ? <>The source returned no point coverage at this +{waterForecastCheckpoint}h horizon; this is NoData/Unknown, never zero water, zero discharge or safe.</> : selectedWaterForecasts.noDataTypes.length === 1 ? <>The source returned no {selectedWaterForecasts.noDataTypes[0] === 'water-level' ? 'water-level' : 'discharge'} point coverage at this +{waterForecastCheckpoint}h horizon; that quantity is NoData/Unknown, never zero or safe.</> : null} Retrieved {new Date(publicWaterForecasts.retrievedAt).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })} · official forecast · CC0 1.0 as catalogued; verify component-specific exceptions. The rolling endpoint exposes requested windows and per-value valid times but no single model-cycle issue time, so issue time remains Unknown and this deployment snapshot is not assumed to align with exercise T+0. Point guidance is not a continuous hydraulic or inundation surface, defence state, municipal prediction or operating instruction; it does not affect the simulation. Missing local coverage is NoData, never zero or safe.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official wastewater geometry</strong><span>DAMO and complementary GWSW pipe WMS layers at city scale · overlapping, variable water-board coverage; not hydraulic connectivity, capacity or live flow</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official water-management areas</strong><span>HWH/PDOK IMWA drainage/supply and level-area WMS · CC BY-SA 4.0, provider-supplied register context; no inferred capacity, flow direction, pump state or service availability</span></div></div>
        )}
        {groundwaterRegistrationContext && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official BRO groundwater-monitoring registrations</strong><span>TNO/Basisregistratie Ondergrond `gm_gmw` monitoring-well and `gm_gld` groundwater-level-investigation characteristics requested live from PDOK at city scale · CC0; the WMS is a legal-register summary, not the full registered contents. A marker does not provide a current level, continuous groundwater surface, exceedance threshold, forecast, event state or causal simulation input. Selected measurement series require the separate BRO GLD REST/Atom service with their own observation time, quality and vertical-reference metadata. Missing geometry is no-data, never proof of dry or safe conditions.</span></div></div>
        )}
        {activeLayer === 'hazard' && (frame.scenario.disaster === 'river-flood' || frame.scenario.disaster === 'coastal-flood') && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official flood-risk and defence context</strong><span>Rijkswaterstaat risk areas from the 2018 report / ROR second cycle 2016–2021 (no planned refresh) plus HWH/PDOK IMWA water defences at city scale · CC0 / CC BY-SA 4.0; these are screening/register layers, not a selected current breach, depth, arrival-time or defence-performance scenario</span></div></div>
        )}
        {activeLayer === 'hazard' && (frame.scenario.disaster === 'river-flood' || frame.scenario.disaster === 'coastal-flood') && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official LIWO candidate breach locations</strong><span>WMCN/LIWO public WMS for primary, regional, regional-water-system and outside-dike scenario entry points · catalogue release 2025.1.6 / dataset 2025_0_1, displayed from city zoom. A marker identifies a place for finding compatible scenarios; it is not an active breach, observed failure, probability, selected flood, depth, arrival time, evacuation order or T+72 forecast and does not affect the simulation. Scenario/model dates, variants, bands, coverage and NoData must be checked after selection; the public service does not state a reuse-licence version.</span></div></div>
        )}
        {activeLayer === 'hazard' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('pluvial-flood'))) && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official cloudburst depth scenario · Rijkswaterstaat</strong><span>National Klimaateffectatlas raster for modeled inundation depth after 70 mm rainfall in two hours · catalogue updated 5 August 2026 · CC0. Legend classes are 0–10, 10–15, 15–20, 20–30 and over 30 cm. This is an official scenario/context layer—not a current observation, forecast, selected incident, local municipal stress test or T+72 prediction—and it does not affect the simulation. Transparent or missing coverage remains Unknown, never dry or safe.</span></div></div>
        )}
        {activeLayer === 'hazard' &&
          (['pluvial-flood', 'river-flood', 'coastal-flood'].includes(frame.scenario.disaster) ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                ['pluvial-flood', 'river-flood', 'coastal-flood'].includes(component)))) && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official terrain elevation · AHN4 DTM</strong><span>Rijkswaterstaat/PDOK 0.5 m ground-elevation raster at city scale · laser acquisition 2020–2022, catalogue updated 23 July 2025 · CC0. The DTM filters buildings, trees, bridges, water and other non-ground objects and uses squared-IDW raster interpolation. It is terrain context—not current water level, water depth, hydraulic connectivity, flow direction, road passability or event state—and it does not affect the simulation. Missing terrain coverage remains Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && ['severe-storm', 'pluvial-flood', 'compound'].includes(frame.scenario.disaster) && publicRadarContext && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Observed KNMI precipitation radar</strong><span>National radar rendering observed {new Date(publicRadarContext.observationTime).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })} · 5-minute cadence, locally cached from the official KNMI WMS · CC BY 4.0; current observational context only, not aligned to the scenario clock, not a T+72 forecast and does not affect simulated hazard</span></div></div>
        )}
        {activeLayer === 'hazard' &&
          ['severe-storm', 'pluvial-flood', 'compound'].includes(frame.scenario.disaster) &&
          publicPrecipitationProbabilityContext &&
          precipitationProbabilityCheckpoint && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Issued KNMI precipitation probability · T+{precipitationProbabilityCheckpoint.leadHours}</strong><span>Map shows the 1 km probability of precipitation intensity exceeding {publicPrecipitationProbabilityContext.thresholdMmH} mm/h, valid {new Date(precipitationProbabilityCheckpoint.validTime).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })}, from reference cycle {new Date(publicPrecipitationProbabilityContext.referenceTime).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })}. The nearest cached T+1/T+3/T+6 checkpoint is displayed for {formatSimulationTime(frame.hour)} · KNMI pilot product · CC BY 4.0. This is an exceedance probability, not deterministic rain; transparent pixels remain NoData unless explicitly encoded as zero, and the overlay does not affect the simulation.</span></div></div>
        )}
        {activeLayer === 'hazard' &&
          ['severe-storm', 'pluvial-flood', 'compound'].includes(frame.scenario.disaster) &&
          publicPrecipitationProbabilityContext &&
          frame.hour > publicPrecipitationProbabilityContext.source.forecastHorizonHours && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>KNMI precipitation-probability coverage ends at T+6</strong><span>No probability raster is displayed at {formatSimulationTime(frame.hour)}. The official seamless product ends at +6 hours and is not extrapolated through T+72; the missing later horizon is NoData/Unknown, not zero rain or an all-clear. HARMONIE selective extraction is a planned short-range adapter through about T+60—not T+72—so the final twelve hours still require another governed source or remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' &&
          frame.scenario.disaster !== 'cyberattack' &&
          frame.scenario.disaster !== 'earthquake' &&
          publicWeatherObservations &&
          nearestWeatherObservation && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Observed KNMI 10-minute weather stations</strong><span>{numberFormat.format(publicWeatherObservations.counts.europeanNetherlandsStations)} European-Netherlands and offshore stations observed {new Date(publicWeatherObservations.observationTime).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })}; {numberFormat.format(publicWeatherObservations.counts.assignedToMunicipalityPolygon)} fall inside a CBS municipality polygon. Nearest to {selected.name}: {nearestWeatherObservation.feature.properties.stationName}, {capacityNumberFormat.format(nearestWeatherObservation.distanceKm)} km away · temperature {nearestWeatherObservation.feature.properties.airTemperatureC === null ? 'not reported' : `${capacityNumberFormat.format(nearestWeatherObservation.feature.properties.airTemperatureC)} °C`} · gust {nearestWeatherObservation.feature.properties.windGustMs === null ? 'not reported' : `${capacityNumberFormat.format(nearestWeatherObservation.feature.properties.windGustMs)} m/s`} · rain in the preceding hour {nearestWeatherObservation.feature.properties.rainfallLastHourMm === null ? 'not reported' : `${capacityNumberFormat.format(nearestWeatherObservation.feature.properties.rainfallLastHourMm)} mm`}. Ten-minute KNMI NetCDF/HDF5 · CC BY 4.0 · {publicWeatherObservations.freshness.statusAtRetrieval} ({numberFormat.format(publicWeatherObservations.freshness.ageMinutesAtRetrieval)} min old when retrieved). A nearest fixed station is not a municipal value or continuous field; missing variables stay NoData, points are not interpolated or aligned to the scenario clock, and observations do not affect the simulation.</span></div></div>
        )}
        {activeLayer === 'hazard' &&
          frame.scenario.disaster !== 'cyberattack' &&
          frame.scenario.disaster !== 'earthquake' &&
          publicWeatherWarnings &&
          selectedWarningProvince && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Issued KNMI 48-hour warning · {selectedWarningProvince.properties.provinceName}</strong><span>{selectedWarningProvince.properties.warningLevel > 0
            ? `${selectedWarningProvince.properties.warningLevelLabel}; ${selectedWarningProvince.properties.phenomena.join(', ') || 'phenomenon not labelled'} across ${selectedWarningPeriods.length} published warning ${selectedWarningPeriods.length === 1 ? 'period' : 'periods'}.`
            : `No warning is issued for this province in the cached product; ${publicWeatherWarnings.counts.provincesWithWarnings} of 12 provinces have an issued warning.`} Product time {new Date(publicWeatherWarnings.source.sourceLastModified ?? publicWeatherWarnings.source.fallbackIssueTime ?? publicWeatherWarnings.source.retrievedAt).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })} · continual KNMI `waarschuwingen_nederland_48h` v1.0 · CC BY 4.0{publicWeatherWarnings.source.retrievalMode === 'official-html-explicit-no-warning-fallback' ? ' · the shared anonymous API quota was unavailable, so this zero-warning snapshot is accepted only because KNMI’s official national page explicitly reported no warnings' : ''}. The province outline summarizes the highest issued code anywhere in the 48-hour product. It is warning context—not gridded weather, local occurrence, impact, an all-clear, or a scenario-clock input—and does not affect the simulation.</span></div></div>
        )}
        {activeLayer === 'hazard' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) &&
          publicAirQuality && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Observed air quality · RIVM Luchtmeetnet</strong><span>{numberFormat.format(publicAirQuality.counts.pm25StationsMapped)} indicative PM2.5 station readings, including {numberFormat.format(selectedAirQualityStations)} assigned by CBS polygon to {selected.name} · latest mapped observation {new Date(publicAirQuality.observationWindow.newestMappedObservation).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })}; hourly measurements, with delivery timing varying by network. No standard reuse licence is stated; the free service says no rights may be derived. These local, revisable observations are not a continuous national surface, population exposure, source attribution, smoke plume, forecast or scenario-clock input and do not affect the simulation. A zero municipal station count means no mapped reporting station in this snapshot, not zero pollution.</span></div></div>
        )}
        {activeLayer === 'hazard' &&
          (frame.scenario.disaster === 'earthquake' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('earthquake'))) &&
          publicSeismicEvents && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Observed seismic-event catalogue · KNMI FDSN</strong><span>{numberFormat.format(publicSeismicEvents.counts.includedSeismicEvents)} earthquake or induced-event source points in the Netherlands bounding box during the {publicSeismicEvents.observationWindow.days}-day deployment window, including {numberFormat.format(selectedSeismicEvents)} assigned by CBS polygon to {selected.name}; {numberFormat.format(publicSeismicEvents.counts.byReviewStatus.reviewed ?? 0)} are reviewed and {numberFormat.format(publicSeismicEvents.counts.byReviewStatus.preliminary ?? 0)} preliminary. Latest included origin {new Date(publicSeismicEvents.observationWindow.newestEvent).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })}; catalogue retrieved {new Date(publicSeismicEvents.retrievedAt).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })} and automatically updated by KNMI when events are published · RDSA default CC BY 4.0 where no dataset-specific terms apply. Controlled explosions, quarry blasts and sonic booms are excluded. Source parameters can be revised and are not ground motion, felt intensity, building damage, probability, forecast or scenario-clock input; they do not affect the simulation. No assigned event means no catalogue point in this window, never zero seismic hazard or proof of safety.</span></div></div>
        )}
        {activeLayer === 'hazard' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official combustible nature areas · IPO Risicokaart</strong><span>Public WMS forest, heath and dune polygons where a nature fire can arise · metadata updated 19 February 2026 · Public Domain; feature-scale accuracy and a guaranteed operational refresh cadence are not stated. The polygons are eligibility/context only—not a current ignition, fuel or moisture state, incident perimeter, spread/smoke forecast, evacuation area or response status—and do not affect the simulation. Missing geometry remains Unknown, never proof that an area cannot burn or is safe.</span></div></div>
        )}
        {(activeLayer === 'supply' ||
          (activeLayer === 'hazard' &&
            (frame.scenario.disaster === 'heatwave' ||
              frame.scenario.disaster === 'wildfire' ||
              (frame.scenario.disaster === 'compound' &&
                frame.scenario.components?.some((component) =>
                  component === 'heatwave' || component === 'wildfire'))))) && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official agricultural parcel context · RVO BRP</strong><span>City-scale PDOK WMS of the 2025 definitive Basisregistratie Gewaspercelen, whose queryable records retain crop category/name/code, year and definitive status. Parcel users draw their crop parcels annually for the 15 May reference date; dataset metadata was revised 15 May 2026 and says Public Domain Mark 1.0, while the current WMS capabilities declare CC0. This is annual declaration/land-use context only—not current crop presence or condition, drought, ignition/fuel state, harvest/yield, food/fodder stock, farm occupancy, passability, damage or T+72 supply—and it does not affect the simulation. Missing/transparent parcels mean no mapped declaration in this edition, never no agriculture, food supply or risk.</span></div></div>
        )}
        {activeLayer === 'hazard' && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official regulated external-safety context · REV</strong><span>Rijkswaterstaat Register Externe Veiligheidsrisico's public WMS with regulated activities and fire, explosion and toxic-cloud attention areas · requested live as map tiles; the WMS does not state a fixed refresh cadence, record timestamp or reuse-licence version. Presence or an attention area is not a current release, damage report, plume footprint, probability or scenario impact and does not alter the simulation.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1982' &&
          (frame.scenario.disaster === 'river-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('river-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Land van Cuijk EDO 36 and Maas system</strong><span>The retained Maas proximity field does not instantiate regional EDO 36, a water-above-assessment-level case or a failure of dike rings 36/36A. It selects no discharge hydrograph, stuwpand/datum, Grave or Sambeek state, defence section, inside/outside-dike footprint, arrival or recession, so it remains a non-operational diagnostic. Four current local Waterinfo levels and “normal” point forecasts through T+24 are observations/guidance for their own valid times—not an inundation surface or a T+72 forecast; T+48 and T+72 local coverage is NoData. The N324 road bridge, Stuw Grave and lock are a shared dependency, while ferry, rail and alternative-route state remain Unknown until authority evidence is aligned to the exercise.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0415' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Landsmeer Waterland pathways</strong><span>The unsupported generic North Sea coast-distance amplitude is suppressed, and the narrow Rhine/Meuse/IJssel zero is not an all-clear. Landsmeer requires distinct primary-defence breach, Markermeer/IJsselmeer buitendijkse, Schermerboezem or regional-kade, peat-polder/peilgebied and cluster-rain/sewer-pump events. None currently supplies a selected defence/control state, connected footprint, arrival, recession or valid-time operation. Until an HHNK/WMCN/LIWO case is selected with units, coverage, uncertainty and NoData, local consequence and recovery remain Unknown rather than zero or safe.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0882' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'earthquake' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Landgraaf water and mining legacy</strong><span>The false generic Rhine/Meuse/IJssel amplitude is suppressed; that is not an all-clear for the Worm, dry valleys, water-conveying roads, mixed sewers, groundwater or the ongoing Rimburg/Rimburgerweg pathway. Likewise, post-coal-mining groundwater rebound, uplift, subsidence and sinkholes are distinct mechanisms and cannot be inferred from the Groningen-centred earthquake preset. Local impacts remain Unknown until versioned cross-border catchment/rainfall and mining-ground evidence supplies a compatible event, footprint, time, units, uncertainty and NoData. German rail, drinking-water and EMRIC mutual-aid interfaces also remain non-causal context until governed operational state is available.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1621' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Lansingerland Rotte and polder system</strong><span>The retained river value is only a non-operational proximity diagnostic, while the generic direct-coast amplitude is suppressed. Neither selects the Rotte, downstream Schilthuis/Nieuwe Maas boundary, a regional kering or kade, Polder Bleiswijk, Eendragtspolder storage, HHSK/Delfland controls, connected footprint, arrival or recession. The national 70 mm/2 h map is dated scenario context and cannot supply the missing local rain/drainage state by itself. Current Eendragtspolder inlet works and Bergboezem Berkel emptying are time-bounded project/action context—not permanent capacity or an incident command. Local consequence remains Unknown until a versioned authority event, controls and valid-time evidence are bound.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0417' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Laren high/low water and heath fire</strong><span>The false direct Rhine/Meuse/IJssel amplitude is suppressed, while a direct-coast zero is only narrow source scope. High Laren infiltration and runoff, low Laren sewer surcharge and groundwater, Gooiergracht receiving state, weirs/pumps and Eemmeer backwater require distinct selected events. The recurring five-resident Laren-Natuurgebied rank is not a population or hazard hotspot claim; residents, GNR users, schools and visitors must remain separate. Heath/woodland eligibility and dated August fire/drought notices do not establish an ignition, plume or current phase. Local water and fire consequences, N525/A1/A27 access and Tergooi continuity remain Unknown until source-valid events and operations are bound.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0080' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Leeuwarden Wadden, boezem and polder system</strong><span>The unsupported generic direct-coast amplitude is suppressed, and the narrow Rhine/Meuse/IJssel zero is not an all-clear. A defensible Leeuwarden event must distinguish Wadden boundary and defence state, Frisian boezem, regional kades, polders, storage/pumps, rain, groundwater, sewer and recession. No selected connected footprint currently supports local depth, affected counts or T+72 recovery. Internal road, rail, bus, waterway and Frisius MC access and managed-water/utility state also remain Unknown. Official registers and point observations stay non-causal until their geometry, valid time, units, topology and operating state are governed together.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0546' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Leiden Oude Rijn and boezem system</strong><span>The unsupported major-river and inland direct-coast amplitudes are suppressed; neither is an all-clear. A defensible Leiden event must distinguish Oude Rijn and Rijnland boezem levels, primary or regional defence failure, dense-city rain and sewer loading, street-connected AHN/BGT flow, pumps, receiving-water controls, arrival and recession. Rijnland's dated KWA-light and dike actions are valid-time operating context, not timeless scenario capacity. LUMC, Alrijne, tunnels and the A4/A44/N434 corridor require separate live access, acceptance and action/resource state. Until those sources are governed together, local consequence and T+72 recovery remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0547' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Leiderdorp Rijnland pathways</strong><span>The generic river and direct-coast amplitudes are suppressed because they select none of Leiderdorp's distinct primary-defence, regional-defence or Rijnland polder/boezem cases; suppression is not an all-clear. Pluvial modelling must include rain, AHN/BGT street and tunnel flow—especially Oude Spoorbaan—sewers, groundwater, receiving levels, pumps, sluices, power and control state. Alrijne's regional 24/7 acute-care role does not establish live patients, staff, acceptance, backup or ambulance access. Local consequence and first-72-hour recovery remain Unknown until a versioned connected event and valid-time action/resource ledger are bound.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1916' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Leidschendam-Voorburg Vliet and polder system</strong><span>The unsupported major-river and direct-coast amplitudes are suppressed; neither is an all-clear for the Vliet, Delfland/Rijnland boezems, regional defences, polders, groundwater, sewers or urban rain pathways. A selected event must supply boundary and defence state, connected terrain footprint, pumps/controls, arrival and recession. Vlietland nature-fire eligibility is not an ignition or smoke plume. N14 tunnels, Vliet crossings, transit and HMC Westeinde access remain Unknown without valid-time operating evidence. The municipality's official current count of zero emergency support points is preserved as a real administrative zero, but future activation, staff, stocks and T+72 actions remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0995' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Lelystad lake, polder and Hollandse Hout</strong><span>The unsupported generic major-river amplitude is suppressed; direct coastal zero is only North Sea source scope and not an IJsselmeer/Markermeer, primary-defence, buitendijkse or Flevoland polder all-clear. A selected case must govern dike/Knardijk/sluice state, Lage and Hoge Vaart levels, gemaal Wortman, seepage, street storage and connected arrival/recession. Hollandse Hout and reed/nature context establish eligibility, not an ignition, plume, visitor exposure or suppression state. A6/N307/Houtribdijk mode restrictions, rail and cross-boundary Harderwijk/Almere acute care remain Unknown until valid-time lifecycle and operating evidence are bound; planned restrictions and airport phases never become current state.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1640' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Leudal Maas, streams and groundwater</strong><span>The retained river value is only a non-operational proximity diagnostic; it does not select a Maas hydrograph/datum, Buggenum or Neer reach, defence/breach state, Buggenummerbroek groundwater/kwel/rain pathway, connected footprint, arrival or recession. One Neer Waterinfo observation and local forecasts through T+24 cannot calibrate inundation or fill T+48/T+72 NoData. Pluvial modelling must separately govern the Leudal, Tungelroysebeek, Roggelsebeek, Neerpeelbeek and Neerbeek catchments, sewers, soil/groundwater, controls and receiving Maas level. Wooded Natura 2000 context is not an ignition or all-clear. Utilities, cross-boundary acute care and first-72-hour actions remain Unknown without valid-time authority state.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0327' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Leusden dike-ring, catchment and heath</strong><span>The retained river value is only a non-operational proximity diagnostic for a plausible dike-ring-45/Grebbedijk threat; it selects no authority scenario, breach/overtopping, water boundary, connected footprint, arrival or recession. Pluvial and groundwater response must distinguish Valleikanaal and brook catchments, Achterveld rain, Leusden-Zuid sewer/groundwater, seepage, storage and controlled water assets. Utrechtse Heuvelrug, Den Treek and Leusderheide eligibility is not an ignition, flame/smoke footprint, access or evacuation state. A28/N226/N227, buses, rural villages and external Meander acute care remain Unknown until valid-time operations are governed. Exact T+24–T+72 plateaus cannot imply recovery without accountable actions and resources.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1705' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Lingewaard river branches, Linge and Pannerling</strong><span>The retained river value is only a non-operational proximity diagnostic; it selects no governed Waal, Pannerdensch Kanaal or Nederrijn hydrograph, defence reach/failure, outer-dike footprint, arrival or recession. Pluvial and drought response must separately govern seepage, groundwater, urban and rural drainage, Linge intake and current weir/pump state. The 19 August fixed-pump stop and temporary Pannerling pumps were superseded when the fixed pump restarted and the temporary pumps were removed; the continuing regional water shortage is a separate state. Local Waterinfo forecasts stop at T+24, so T+48 and T+72 remain NoData. Gelderse Poort nature context is eligibility, not an ignition or plume, and utilities, external acute care and recovery actions remain Unknown without validity-aligned authority evidence.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0553' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Lisse trajectory 14, Ringvaart and polder system</strong><span>The unsupported coastal and named-major-river amplitudes are suppressed; neither is an all-clear for dike trajectory 14, Ringvaart/boezem, regional kades, polders, groundwater, sewers or urban rain. A decision-facing flood result requires an expert-selected LIWO/Rijnland case with boundary and datum, defence/control state, connected footprint, depth/velocity, timing, uncertainty and NoData. Pluvial modelling must bind the governed Lisse stress-test geography, rainfall, terrain, paving, soil/groundwater, sewer and polder catchments, pumps and receiving boezem level. Twenty-five public water objects do not establish connectivity, comparable capacity or present operation. First-72-hour impacts, service state and recovery remain Unknown until those inputs and confirmed actions are validity-aligned.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0262' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Lochem IJssel, rain and Het Groote Veld</strong><span>The retained river value is only a non-operational proximity diagnostic; it selects no IJssel gauge/hydrograph, defence state, breach or governed LIWO/KEA footprint. Official local evidence places meaningful exposure mainly on the western IJssel side around Eefde and Epse, while the generic ranking puts those areas near the bottom. Duration-specific WRIJ rain, building, road-passability, Berkel/brook and groundwater layers remain typed context until their version, licence, units and NoData contract are bound. A controlled Het Groote Veld ignition ranks its containing neighbourhood thirtieth, so fire/smoke distribution is also unsupported. T+48/T+72 Waterinfo forecasts, village access, external acute care, support points and all restoration actions remain Unknown rather than safe or available.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0809' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Loon op Zand dunes, Maas case and visitors</strong><span>The retained river value is only a non-operational diagnostic; official regional evidence limits the cited deep-water pathway to north-west Loon op Zand after a selected Maas-dike breach, while no hydrograph, defence failure, connected footprint, arrival or recession is bound. Kaatsheuvel pluvial response must separately govern high-to-low terrain, limited infiltration, Donge receiving water and combined-sewer overflow. A controlled ignition inside Oost-Loon and mapped heath produces direct fire and smoke but ranks its source neighbourhood last, so the shared spatial seed cannot represent the Loonse en Drunense Duinen. Efteling, accommodation and nature visitors require dated concurrent occupancy and egress demand; annual residents are not a substitute. N261, ETZ care and every first-72-hour action remain Unknown without operational evidence.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0331' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Lopik Lekdijk and reversible polder system</strong><span>The retained river value is only a non-operational diagnostic for a locally plausible Lek event; it selects no hydrograph/datum, defence reach and state, breach/overtopping pathway, connected footprint, arrival or recession. Dike-project lifecycle is reach-specific: completed Salmsteke work covers two kilometres, Jaarsveld–Klaphek preparation is delayed, and Salmsteke–Schoonhoven remains in plan development—none proves failure or certifies the whole line safe. Pluvial response must govern peat subsidence, groundwater, sewer and polder catchments, receiving levels, maalstop and pump operation. De Koekoek can drain much of the Lopikerwaard or reverse into the KWA drought-supply route; public design capacity and emergency-power capability do not establish its live mode. Rural/dike access, external care and T+72 actions remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0263' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Maasdriel river compartments and care routes</strong><span>The retained river value is only a non-operational diagnostic; it selects no governed Waal, Maas or Afgedamde Maas boundary, Bommelerwaard/Alem/Heerewaarden compartment, trajectory 38-1/38-2/39-1/40-1/40-2 state, breach, connected footprint, arrival or recession. The common neighbourhood seed cannot place Hedel, Alem and Heerewaarden from hydraulic evidence. Rain/sewer overload, bidirectional polder control, wastewater and drinking-water quantity/quality must remain separate mechanisms; 244 partial water objects do not provide topology or live operation. A2 river bridges, N322, dike roads, rail, evacuation and external Jeroen Bosch/Rivierenland care require time-valid state. Maasdriel officially has no emergency support point yet, and Kerkdriel town hall is a contact fallback—not a shelter. T+72 Waterinfo, capacity, supplies and recovery actions remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0168' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Losser Dinkel and cross-border dependencies</strong><span>The unsupported named-major-river amplitude is suppressed because Losser has no local Rhine, Meuse or IJssel pathway; that narrow zero is not an all-clear for the distinct cross-border Dinkel/Glanerbeek system. A selected case must bind sustained Dutch/German rainfall, an upstream gauge/hydrograph, local depth/threshold surface, controls, arrival and recession. The official Overijssel 70 mm/two-hour layer remains scenario context rather than current rain or drainage state. A controlled ignition inside Beuningen forest ranks its source neighbourhood only sixth, so the common seed cannot represent local fire spread. German upstream water, N731/A1 continuity, care and mutual aid are absent from the closed Dutch graph. Empty public feeds, external facilities and T+72 actions remain Unknown/NoData rather than safe or available.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1641' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'wildfire' ||
            frame.scenario.disaster === 'compound') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Maasgouw Maas, canals and source water</strong><span>The retained river value is only a non-operational diagnostic; it selects no Maas/canal hydrograph or datum, Thorn–Wessem/Heel/Ohé–Stevensweert/Claus defence reach and state, breach/overtopping/seepage path, connected footprint, arrival or recession. Project evidence remains reach-specific: Thorn–Wessem is below norm, Heel work is completed for its reach, and later Maas2050 programming proves neither failure nor municipality-wide safety. Four normal Waterinfo observations are point states only; local forecasts stop at T+24 and T+48/T+72 remain NoData. Lange Vlieter, groundwater, WML intake controls, RWZI Panheel and the Claus/Linne energy node are context, not live water or energy topology/capacity. First-72-hour evacuation, care, utilities and resupply require confirmed actions and resources.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0654' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario scope exclusion · Borsele nuclear/industrial incidents</strong><span>This version has no KCB Borssele/Doel radiological source term, Sloe industrial release, plume, dose, iodine/shelter/evacuation decision or authority-issued protective-action model. REV locations remain context only. The generic cyber scenario models service disruption and must not be interpreted as reactor/vital-control failure or a release.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0213' &&
          (frame.scenario.disaster === 'river-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('river-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario workflow gap · Brummen Cortenoever/RWZI</strong><span>This version does not implement a current authority-confirmed +8.0 m NAP forecast threshold, the historic 72/48/24-hour warning–preparation–evacuation workflow, Cortenoever protected/unprotected footprint, RWZI ring-dike state, road isolation or sludge-storage dependency. The published local playbook is from 2017/2018 and requires revalidation. Generic controls never mean Brummen, VNOG, Rijkswaterstaat, Vallei en Veluwe or a utility has issued or completed an action.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0899' &&
          frame.scenario.disaster === 'earthquake' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario scope gap · Brunssum seismic/mining pathways</strong><span>The selected preset is a synthetic Groningen-centred earthquake and does not model a Zuid-Limburg event, Feldbiss differential ground rise, mine-water recovery, shafts, shallow workings, mine gas or local building vulnerability. IPO seismic zones and SodM’s former-coal-mining assessment are screening/documentary context only—not observed shaking, a forecast, probability, ground state or damage report.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0313' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario scope gap · Bunschoten Eem/Eemmeer water</strong><span>The generic river preset is a Rhine/Meuse/IJssel screen and the coastal preset is a North Sea screen; neither is a selected Eem inflow, Eemmeer/Randmeren storm-setup, primary or regional defence failure, overtopping, polder surcharge or pump-state scenario. Zero direct coastal water and suppressed major-river water are not an all-clear. A versioned, water-manager-selected connected footprint is required before local depth, arrival or recession can be shown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0214' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Buren water events</strong><span>Buren’s public 2021 sewer/surface model distinguishes T10, T100 and T1000 design storms and reports 126 measured-floor ingress buildings at T100, with 384 possible-water buildings lacking floor measurements and 14,230 buildings with unmeasured floors. This version does not sample that model, and its river proxy selects no connected defence/breach, water level, depth, arrival or recession footprint. These are modeled design-event classes—not current inundation or a forecast—and unresolved gray/white classes remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0502' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' ||
                component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Capelle flood pathways</strong><span>The displayed local field selects no Hollandsche IJsselkering state, defence or breach segment, water level/probability, hydraulically connected footprint, arrival or dewatering curve. Capelle’s public climate atlas currently exposes 3,063 affected-building polygons and 298 road segments classified impassable under its source scenario, but this version does not sample them and the service leaves licence, refresh cadence, scenario definition and some units incomplete. The atlas is modeled context—not a current closure, observation or T+72 forecast—and missing metadata or coverage remains Unknown.</span></div></div>
        )}
        {activeLayer === 'drainage' && selected.id === 'GM0502' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Kralingseveer wastewater system</strong><span>HHSK identifies Kralingseveer as its largest treatment plant, serving parts of Rotterdam, Capelle and Lansingerland—about 360,000 people and roughly 100,000 m³/day—and says it generates the electricity needed for wastewater treatment itself, including biogas. Those are published programme figures, not live flow or spare capacity. This version does not model its catchment, authorized aggregate capacity, self-supply/backup, current state or restoration, so generic municipal drainage and power dependencies must not be read as Kralingseveer performance.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0383' &&
          (frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Castricum dune defence</strong><span>Castricum’s dunes are a managed natural defence; a coastal location does not itself select a present failure. This preset has no named North Sea boundary condition, dune section/state, breach or overtopping mechanism, connected full-resolution footprint, depth unit, arrival, duration, recession or probability class. The retained coast-distance amplitude is a diagnostic—not an observed breach, warning, forecast or evacuation basis—and requires an expert-selected, versioned LIWO/HHNK event.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1706' &&
          (frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'pluvial-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'river-flood' || component === 'pluvial-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario scope gap · Cranendonck water pathways</strong><span>The adopted Brabant-Zuidoost profile places this high-lying region outside direct sea and large-river influence, so the generic Rhine/Meuse/IJssel amplitude is disabled for Cranendonck. That scoped zero is not an all-clear: Buulder Aa, Strijper Aa, Sterkselsche Aa, Belgian-fed brooks, groundwater, extreme rain, sewer/RWZI controls, Grootschoterweg access and indirect supply remain unresolved. The municipality’s 2019 stress-test maps are dated planning evidence—not a current observation, forecast or T+72 footprint—and require a versioned licensed hydraulic layer before local depth, arrival or recession can be shown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0216' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Culemborg Lek and rainwater</strong><span>Culemborg has real Lek, seepage, primary-defence and outer-dike exposure, but this run selects no water level, defence segment/state, breach or overflow, probability, connected footprint, arrival, duration or dewatering curve. Its adopted 2024 programme identifies P1 pluvial sites in Voorkoop, Componistenbuurt, Binnenstad and Pavijen; the public 90 mm/hour tiles are older rendered planning context without raw values, source resolution, licence, scenario edition or fixed cadence. Neither source is a current observation or arbitrary T+72 forecast, and missing metadata or coverage remains Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0148' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dalfsen Vecht/IJssel water</strong><span>Dalfsen has real Vecht, western IJssel/backwater, outside-dike and defence-dependent pathways, but this run selects no river boundary, defence/breach/overtopping state, connected footprint, terrain, depth unit, arrival, duration or recession. The retained scalar is a non-operational diagnostic—not current flooding, a warning or a T+72 forecast—and requires an expert-selected, versioned LIWO/WDODelta event. Missing event coverage remains Unknown, never dry or safe.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0310' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · De Bilt water pathways</strong><span>Province Utrecht’s source layers distinguish rain, heat, drought and flood patterns across De Bilt, Maartensdijk, Westbroek and the HDSR/AGV coverage boundary; sampled cells are diagnostics rather than neighbourhood means, and blank/255/out-of-waterboard cells remain NoData. This run samples none of those layers and selects no Lek or regional-water level, defence/breach state, connected footprint, arrival, duration or recession. Its retained river scalar is a non-operational diagnostic—not current flooding, a forecast or a T+72 footprint—and requires an expert-selected, versioned water-manager event.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0310' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · De Bilt Heuvelrug fire</strong><span>A controlled source inside Ridderoordsche Bossen and BU03100603 ranks its own neighbourhood only fourteenth of 24 under the shared seed. The VRU profile establishes broad Utrechtse Heuvelrug nature-fire and care/evacuation relevance, not this incident or its spread. Until a named source/perimeter, eligible fuel and moisture, event-valid weather, access, extinguishing water and suppression state are selected, local flame, smoke and evacuation effects remain Unknown rather than forecast.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1891' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dantumadiel water systems</strong><span>The Rhine/Meuse/IJssel preset’s scoped zero does not cover Dantumadiel’s sea/IJsselmeer, boezem, polder, prolonged-rain or rural pressure-sewer pathways. Conversely, the coastal distance scalar selects no water level, mainland dike segment/state, breach/overflow, connected footprint, probability, arrival, duration, recession or dewatering curve. Friese Klimaatatlas tiles are planning display context without an established raw numeric, licence, resolution, NoData or refresh contract for causal use. Local water impact is therefore Unknown pending an expert-selected, versioned Wetterskip/LIWO event—not current flooding, a forecast or proof of safety.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1940' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · De Fryske Marren water systems</strong><span>The retained major-river scalar selects no IJssel–IJsselmeer boundary condition, primary-defence state, Friese-boezem or polder pathway, connected footprint, depth unit, arrival, duration or recession. Conversely, zero direct North Sea water tests only that narrow source while the wind/system exercise can still create downstream pressure; it says nothing about IJsselmeer setup, Lemmer, regional water or drainage. The 1,191 intersecting public HWH objects and valid-time Waterinfo points are asset and observation context—not connectivity, operation or a T+72 forecast. Local water impact remains Unknown pending an authority-selected, versioned Wetterskip/WMCN/LIWO event.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1940' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · De Fryske Marren Gaasterlân fire</strong><span>A controlled source in Oudemirdum ranks its containing neighbourhood only fortieth of 70 despite the official Gaasterlân–Rysterbosk nature-fire context. The source coordinate and planning designation do not prove ignition, fuel condition or spread. Until a named source/perimeter, eligible woodland and fuel moisture, event-valid wind, access, extinguishing water and suppression state govern allocation, local flame, smoke and evacuation effects remain unsupported exercise outputs rather than observations or forecasts.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1690' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · De Wolden water pathways</strong><span>The retained major-river scalar selects no connected Meppelerdiep, Reest or Wold Aa pathway, boundary level, defence/control state, footprint, depth unit, arrival, duration or recession. Municipal evidence instead identifies rain-water overload near Julianaweg De Wijk, west Zuidwolde, Koekange, Ruinen and Groene Hart/Oosterweg; this version samples none of those surfaces. The scalar is a non-operational diagnostic—not current flooding, a warning or a T+72 forecast—and any narrow direct-coastal zero says nothing about local brooks, canals, drainage, access or indirect service effects. Missing event coverage remains Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1690' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · De Wolden Boswachterij Ruinen fire</strong><span>A controlled source inside official Boswachterij Ruinen and Verspreide huizen Echten ranks its containing neighbourhood third while Oosteinde-Buiten about 6.553 km away ranks first. Forest geometry proves eligible context, not ignition or spread. Until a named source/perimeter, fuel and moisture, event-valid wind, access, extinguishing water and suppression state govern allocation, local flame, smoke and evacuation effects remain unsupported exercise outputs rather than observations or forecasts.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0736' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · De Ronde Venen hydraulic events</strong><span>The precise river and coast-distance fields select no Lek/Rijn or regional-water boundary, dike segment/state, breach/overflow, polder/boezem pathway, probability, connected footprint, arrival, duration, recession or dewatering path. Vinkeveen’s June 2026 rain event confirms a local pathway but is a past observation—not a future forecast—and the shared seed still ranks Vinkeveen Plassengebied twentieth. Direct local exposure remains Unknown until an AGV/WMCN-approved, versioned LIWO/LDO event is selected; missing HWH geometry never means no asset, flood pathway or risk.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0736' &&
          (frame.scenario.disaster === 'heatwave' ||
            frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'heatwave' || component === 'wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · De Ronde Venen local priorities</strong><span>The common allocator places Mijdrecht Dorp last despite Centrum Mijdrecht’s official heat priority and can leave a diagnostic source in Vinkeveen Plassengebied twentieth. Planning priority and a synthetic coordinate are context, not a present heat emergency or ignition. Apparent temperature, shade, vulnerability, eligible fuel/moisture, named perimeter, event-valid wind, access and suppression are unselected, so local heat or fire priority remains unsupported rather than forecast.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0503' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Delft rain and flood sources</strong><span>The Rhine/Meuse/IJssel field is disabled for Delft because no connected direct pathway is selected; that narrow zero is not an all-clear for coastal, boezem-dyke, polder, Schie, pluvial, drainage, access or indirect regional effects. The retained coastal scalar selects no boundary level, defence segment/state, breach/overtopping path, connected footprint, probability, arrival, duration or recession. Delft and Province Zuid-Holland publish urban-rain/model-coverage context, but this version samples neither it nor Delfland catchments. Local depth and impact remain Unknown pending an authority-selected, versioned scenario—not current flooding or a T+72 forecast.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0503' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Delft Abtswoudse Bos fire</strong><span>A controlled Abtswoude source ranks its containing neighbourhood only twenty-third of 91 despite direct flame and official Abtswoudse Bos interface context. The coordinate and forest register do not prove ignition, fuel condition or spread. Until a named source/perimeter, eligible forest and fuel moisture, event-valid wind, rail/road access, extinguishing water and suppression state govern allocation, local flame, smoke and evacuation effects remain unsupported exercise outputs rather than observations or forecasts.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0400' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Den Helder coast and water systems</strong><span>The retained coastal scalar selects no North Sea/Wadden Sea level, tide or surge, named HHNK defence segment/state, breach/overtopping, connected footprint, probability, arrival, duration, recession or dewatering path. The Rhine/Meuse/IJssel field is narrowly zero and says nothing about Marsdiep, Koegraspolder, regional water, salinity, rain, sewer or indirect access effects. HHNK legal geometry, climate-atlas scenarios and valid-time Waterinfo points are context—not a selected incident or T+72 forecast. Local impact remains Unknown pending an authority-approved versioned event.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0400' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Den Helder Donkere Duinen fire</strong><span>A controlled source in Donkere Duinen leaves its containing neighbourhood thirty-third of 65 because the common allocator ignores source containment. Dune/forest context does not prove ignition, fuel or spread. Until a named perimeter, eligible fuel and moisture, event-valid wind, access, extinguishing water and suppression state govern allocation, local flame, smoke and evacuation effects remain unsupported exercise outputs rather than observations or forecasts.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0762' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Deurne local water pathways</strong><span>The direct Rhine/Meuse/IJssel amplitude is suppressed because the adopted Brabant-Zuidoost profile places this high-lying region outside direct large-river influence. That narrow correction is not an all-clear: extreme rain, high groundwater, the Aa and smaller waterways, sewers, pumps, wastewater and indirect access remain unresolved. The public national 70 mm/two-hour surface is official scenario context—not an observation or forecast—and is not yet sampled. Local depth, duration and T+72 recession remain Unknown pending a selected authority-reviewed event.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0762' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Deurne peat fire</strong><span>A controlled source inside mapped swampy deciduous forest in the Deurnsche Peel leaves its containing neighbourhood twenty-fifth of 29 because the common allocator ignores source containment. Official plans describe residual peat, difficult heavy-vehicle access, scarce extinguishing water, delayed response and months-long smoke after the 2020 fire, but those past and planning facts are not a current ignition or forecast. Until peat/fuel, moisture, perimeter, wind, access, water and suppression govern the exercise, flame, smoke and persistence through T+72 remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0150' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Deventer IJssel and rain</strong><span>Deventer has real IJssel exposure and municipal access rules at 4.50, 6.10 and 6.30 m NAP, but the current scalar selects no datum-aligned gauge hydrograph, defence state, breach/overtopping, connected footprint, depth, arrival or recession. Those thresholds are decision context for named roads and a ferry—not generic inundation values. Official provincial and municipal extreme-rain surfaces are also not sampled. Local impact stays Unknown until a versioned authority-selected event is bound to the exercise clock; a current Waterinfo observation is not T+72.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0150' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Deventer Lettele fire</strong><span>A controlled source inside Buitengebied Lettele en Okkenbroek leaves its containing neighbourhood twenty-fifth of 69 while Handelspark De Weteringen ranks first. The coordinate is an exercise input, not proof of ignition or eligible fuel. Until a named perimeter, land cover, fuel and moisture, event-valid wind, access, extinguishing water and suppression govern allocation, local flame and smoke remain unsupported rather than observed or forecast.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1980' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dijk en Waard polder and coast</strong><span>The retained coast-distance value selects no North Sea or IJsselmeer/Markermeer boundary, named HHNK defence state, breach/overtopping, canal or polder connection, depth, arrival or recession. The Rhine/Meuse/IJssel zero is narrowly scoped and not an all-clear. Municipal evidence describes compartmentalized drainage plus Zandhorst, Huygendijk and road-rain pathways, but this version samples none of them. Local impact and T+72 recovery remain Unknown until an authority-selected versioned event and resource assumptions are supplied.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1980' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dijk en Waard Bomenbuurt fire</strong><span>A controlled source inside current TOP10NL deciduous forest in Bomenbuurt leaves the source neighbourhood fiftieth of 69 while Zuidwijk ranks first. Land-cover geometry is fuel-eligibility context—not a current ignition or spread forecast. Until a named perimeter, fuel/moisture, event-valid wind, access, extinguishing water and suppression govern allocation, local flame and smoke remain unsupported exercise output.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0384' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Diemen IJmeer, canal and rain</strong><span>The coastal and river screens select no IJmeer/Markermeer or Amsterdam-Rijnkanaal boundary, named AGV defence or gate state, breach/overflow, polder/boezem connection, probability, footprint, arrival or dewatering. Official 90 mm rain and road-passability context is not yet sampled and its reuse contract requires resolution. Local water impact and T+72 service consequences remain Unknown pending an authority-selected versioned event; modeled context and current observations are not forecasts.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0384' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Diemen Gemeenschapspolder fire</strong><span>A controlled source in Diemerbos/Gemeenschapspolder leaves its own neighbourhood seventeenth of 37 while zero-resident Diemer Vijfhoek ranks first. Staatsbosbeheer land-manager context does not establish a current ignition, fuel state or spread. Until a named perimeter, eligible fuel/moisture, event-valid wind, access, extinguishing water and suppression govern allocation, local flame and smoke remain unsupported exercise output.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0221' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Doesburg IJssel and rain</strong><span>The retained IJssel proximity value selects no hydrograph, datum, dike-ring-48 defence state, breach/overtopping, connected footprint, depth, arrival or recession, so it is a diagnostic rather than a local metre claim or T+72 forecast. Public WRIJ T100/T1000 layers place severe road/building classes differently from the shared model ranking, but this version does not sample them and their scenario, units, licence and NoData must be pinned before causal use. Local impact and recovery remain Unknown pending an expert-selected versioned event.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0221' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Doesburg Beinum fire</strong><span>A controlled source inside current TOP10NL deciduous forest in Beinum I leaves its source neighbourhood eighth of eleven because the common allocator ignores source containment. Static woodland is eligibility context, not a current ignition or fuel state, and Doesburg’s dense historic-centre building-fire mechanism is a separate hazard. Until a named perimeter, fuel/moisture, valid-time wind, access, extinguishing water and suppression govern allocation, local flame, smoke and evacuation effects remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1774' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dinkelland Dinkel and rain</strong><span>The direct Rhine/Meuse/IJssel value is zero, but that narrow result does not cover the cross-border Dinkel, Regge/Dinkel regional water, brook valleys, culverts, rural sewer or German inflow and is not an all-clear. Dinkelland’s 70 mm/one-hour planning test and Overijssel’s 70 mm/two-hour raster are distinct official scenarios; neither is sampled. Local depth, access and recession remain Unknown until a water-manager-selected hydrograph/rainfall and connected footprint retain units, validity, licence, coverage and NoData.</span></div></div>
        )}
        {activeLayer === 'population' && selected.id === 'GM1774' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Metric scope · Dinkelland network pressure</strong><span>The named-river exercise has zero local direct hazard and zero local pre-network deprived person-hours within its narrow scope. NWB roads are now limited to Mobility and road logistics/Supply, removing the former unsupported non-road transfer pressure; any remaining post-network count is a separate logical scope, not an observed outage. A zero result still says nothing about the unmodelled cross-border Dinkel or other local water pathways.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0222' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Doetinchem Oude IJssel and rain</strong><span>The retained Oude IJssel/IJssel proximity value selects no boundary hydrograph, gauge datum, Grutbroek or other defence state, breach/overtopping, connected footprint, depth, arrival, recession or dewatering, so it is a diagnostic rather than a local metre claim or T+72 forecast. WRIJ publishes distinct 70 mm/one-hour, 90 mm/one-hour, 160 mm/two-hour and 120 mm/48-hour depth and road-passability products, but this version samples none of them. Local impact and recovery remain Unknown pending an authority-selected versioned event with units, licence, coverage and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0222' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Doetinchem Slangenburg fire</strong><span>A controlled source inside official mixed forest in Buitengebied - Slangenburg leaves its source neighbourhood twenty-eighth of 84 while De Huet leads because the shared allocator ignores source containment. Forest geometry proves only fuel eligibility—not a current ignition, fuel condition or spread. Until a named source/perimeter, fuel and moisture, event-valid wind, access, extinguishing water and suppression govern allocation, local flame remains Unknown and remote smoke must stay a separate mechanism.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0505' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dordrecht dike ring, tide and rain</strong><span>The retained major-river value selects no dike-ring-22 or outer-dike LIWO/WSHD case, defence or breach/overtopping state, river/sea/tide boundary, datum, connected footprint, probability, arrival or recession, so its precise T+72 magnitude is a non-operational diagnostic—not current flooding or a forecast. The direct coastal zero narrowly excludes Dordrecht’s sea/storm-driven tidal and combined pathways and is not an all-clear. Provincial 100 mm/two-hour rain context is not yet sampled. Local impact and recovery remain Unknown until an authority-selected versioned event retains units, licence, coverage and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0505' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dordtse Biesbosch fire</strong><span>A controlled source inside mapped broadleaf forest in Dordtse Biesbosch leaves its containing neighbourhood 130th of 132 because the shared allocator ignores source containment. The source land-cover record is aged context and proves neither a current ignition nor fuel condition. Until a named source/perimeter, fuel and moisture, event-valid wind, access, extinguishing water and suppression govern allocation, local flame and smoke remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0766' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dongen rain and river systems</strong><span>The retained river-proximity value selects no Donge/Wilhelminakanaal or major-river boundary, defence state, breach/overtopping, connected footprint, probability, arrival or recession, so it is a non-operational diagnostic rather than a T+72 forecast. Dongen’s distinct 70/90 mm per hour and 160 mm/two-hour tests place several named urban hotspots only ninth through seventeenth in the shared model order; their native surfaces are not sampled. Local depth, access and recovery remain Unknown pending an authority-selected versioned event with units, licence, coverage and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0766' &&
          (frame.scenario.disaster === 'heatwave' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('heatwave'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dongen heat and drought</strong><span>The shared hash can rank rural Buitengebied Oost first while published thermal context identifies Tichelrijt and Wildert as strong heat islands. That dated surface is susceptibility context, not current air temperature or a T+72 forecast. Local apparent temperature, warm nights, shade, paving, vegetation, groundwater and vulnerable-population exposure remain Unknown until a versioned surface is joined to valid-time KNMI forcing.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1719' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood' ||
                component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Drimmelen Amer and rain</strong><span>The retained Amer/Benedenrivieren proximity value selects no boundary hydrograph, datum, defence or breach/overtopping state, connected footprint, probability, arrival or recession, so its persistent T+72 water is a non-operational diagnostic—not current flooding or a forecast. Available official hydraulic planning layers have partial coverage and are not sampled. Local depth, coastal/tidal combination, drainage and recovery remain Unknown until a municipality-wide authority-selected event retains version, units, licence, coverage and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1719' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Drimmelen Rupsenhoek fire</strong><span>A controlled source inside official Rupsenhoek/Sluishoek woodland and Verspreide huizen Biesbosch does not lead its containing neighbourhood because the shared allocator ignores source containment. Woodland geometry is long-validity context, not a current ignition or fuel state. Until a named source/perimeter, fuel and moisture, valid-time wind, Biesbosch access, extinguishing water and suppression govern allocation, local flame and smoke remain Unknown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0225' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Druten Waal and rain</strong><span>The retained Waal-proximity value selects no boundary hydrograph or datum, Zuidelijke Waaldijk state, breach/overtopping, connected footprint, probability, arrival, recession or dewatering, so its precise T+72 magnitude is a non-operational diagnostic—not current flooding or a forecast. Rivierenland’s public 60 mm/one-hour depth and flow-path scenario is not sampled, and its own guidance requires local evidence for measures. Local depth, hotspots, access and recovery remain Unknown until an authority-selected versioned event preserves units, coverage, licence and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0225' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Druten Horssen fire</strong><span>A controlled source inside official Horssen woodland leaves Verspreide huizen Horssen seventeenth of 26 because the shared allocator ignores source containment. Land cover establishes possible fuel eligibility only. Until a named source/perimeter, fuel and moisture, valid-time wind, access, extinguishing water and suppression state govern allocation, local flame remains Unknown and remote smoke stays separate.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0303' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dronten polder and rain</strong><span>The retained river value selects no IJssel–Ketelmeer–Reevediep level, defence state, connected polder footprint, arrival, recession or dewatering path, so it is a non-operational diagnostic rather than a T+72 forecast. Dronten’s official 63.4 mm/hour stress-test footprint and its sewer, pump and receiving-water dependencies are not sampled. Local depth, drainage and recovery remain Unknown until a versioned authority event with units, coverage, licence and NoData is bound to the exercise.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0303' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Dronten Roggebotzand fire</strong><span>A controlled source inside mapped Roggebotzand forest leaves its containing neighbourhood twelfth of 42 because the shared allocator ignores source containment. Forest geometry proves neither ignition nor current fuel condition. Local flame remains Unknown until a named source/perimeter, fuel and moisture, valid-time wind, access, extinguishing water and suppression state govern allocation.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0498' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Drechterland Markermeer and rain</strong><span>The generic water screens select no Markermeer level or wind setup, polder-defence state, connected footprint, probability, arrival, recession or pumping condition; retained values are non-operational diagnostics, not current flooding or forecasts. Published Hoogkarspel/Venhuizen, Lakenmanweg pump and N307-underpass mechanisms are not sampled. Local depth, hotspots and T+72 recovery remain Unknown until HHNK/Rijkswaterstaat-approved versioned events preserve units, coverage, licence and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0498' &&
          (frame.scenario.disaster === 'heatwave' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('heatwave'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Drechterland heat and drought</strong><span>The shared ranking ignores published Zuiderkogge, Schellinkhout and Markermeerdijk susceptibility context and does not separate air temperature, surface heat, drought, groundwater, salinity or vulnerable population. Dated context is not current conditions. Local exposure remains Unknown until versioned mechanism-specific surfaces are joined to event-valid KNMI forcing.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0498' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Drechterland Oosterleek fire</strong><span>A controlled source inside Oosterleek leaves the containing neighbourhood eleventh of 27 because the shared allocator ignores source containment. Local flame remains Unknown until a named ignition/perimeter, eligible fuel, moisture, valid-time wind, access, extinguishing water and suppression state govern allocation; land-cover context alone is not an incident.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0385' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Edam-Volendam Markermeer and rain</strong><span>The retained coastal value selects no Markermeer level or wind setup, Slobbeland or polder-defence state, connected footprint, probability, arrival, recession or pumping condition, so it is a non-operational diagnostic—not current flooding or a T+72 forecast. Published Volendam and Rokersgracht sewer, pump and receiving-water mechanisms are not sampled. Local depth, access and recovery remain Unknown until authority-selected versioned events preserve units, coverage, licence and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0385' &&
          (frame.scenario.disaster === 'heatwave' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('heatwave'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Edam-Volendam heat and subsidence</strong><span>The common ranking does not model Broeckgouw, Zeestraat, bridge and subsidence context or distinguish air temperature, surface heat, drought, groundwater and vulnerable population. Dated susceptibility context is not a live condition. Local exposure remains Unknown until versioned mechanism-specific surfaces are joined to event-valid KNMI forcing.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0385' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Edam-Volendam Warder fire</strong><span>A controlled source inside mapped Warder vegetation leaves its containing neighbourhood fourteenth of 29 because the shared allocator ignores source containment. Land cover proves neither ignition nor current fuel condition. Local flame remains Unknown until a named source/perimeter, fuel and moisture, valid-time wind, access, extinguishing water and suppression govern allocation.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0226' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Duiven Rhine system and rain</strong><span>The retained Rhine/Pannerdensch Kanaal/IJssel value selects no hydrograph, datum, dike or breach/overtopping state, Gemaal de Liemers operation, connected footprint, arrival, recession or dewatering, so it is a non-operational diagnostic rather than a T+72 forecast. WRIJ T100/T1000 duration-specific depth and road-passability surfaces are not sampled. Local impact and recovery remain Unknown pending an authority-selected versioned event.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0226' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Duiven Loo fire</strong><span>A controlled source inside mapped vegetation near Loo leaves its containing neighbourhood eleventh of 14 because the shared allocator ignores source containment. Land cover proves neither ignition nor current fuel condition. Local flame remains Unknown until a named source/perimeter, fuel and moisture, valid-time wind, access, extinguishing water and suppression govern allocation.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1711' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Echt-Susteren Maas and brooks</strong><span>The retained value selects no Maas, Geleenbeek or Rode Beek hydrograph, datum, defence or breach/overtopping state, connected footprint, probability, arrival, recession, pumping or dewatering, so it is a non-operational diagnostic—not current flooding or a T+72 forecast. Local depth, access and recovery remain Unknown until an authority-selected versioned event preserves units, coverage, licence and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1711' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Echt-Susteren woodland fire</strong><span>A controlled source inside mapped local woodland leaves its containing neighbourhood twelfth of 58 because the shared allocator ignores source containment. Woodland geometry proves neither ignition nor current fuel condition. Local flame remains Unknown until a named source/perimeter, fuel and moisture, valid-time wind, cross-border access, extinguishing water and suppression govern allocation.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0317' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eemnes Eemmeer and rain</strong><span>The retained river value selects no Eem/Eemmeer/Randmeren boundary, Eempolder defence state, connected footprint, probability, arrival, recession or pump state, so it is a non-operational diagnostic rather than a T+72 forecast. Province Utrecht’s published 74 mm/hour depth surface has strong local variation and NoData cells but is not sampled. Local depth, access and recovery remain Unknown until an authority-selected versioned event preserves duration, units, coverage, licence and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0317' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eemnes Heidehoek fire</strong><span>A controlled source inside Heidehoek leaves its containing neighbourhood sixth of nine because the shared allocator ignores source containment. The available nature-fire layer returns no local match, which remains Unknown rather than safe. Direct flame requires a named source/perimeter, eligible fuel, moisture, valid-time wind, access, extinguishing water and suppression state.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1979' &&
          (frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eemsdelta Ems-Dollard coast</strong><span>The retained coastal value selects no storm tide, gauge/datum, Eemshaven–Delfzijl or Dollarddijk defence segment, breach/overtopping, coupure or pump state, connected footprint, arrival or recession. It is a non-operational diagnostic—not current flooding or a T+72 forecast. Local impact and restoration remain Unknown until the water authorities select a versioned hydraulic exercise.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1979' &&
          (frame.scenario.disaster === 'earthquake' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('earthquake'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eemsdelta earthquake</strong><span>The synthetic ground-motion value selects no KNMI event ID, origin revision, RRSM or governed ground-motion field, local site response, building and NCG strengthening state, or lifeline fragility. Historical catalogue points are observations—not a future event or damage forecast. Exact local PGA, affected population and first-72-hour recovery remain Unknown until those contracts are supplied.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1979' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eemsdelta Woldendorp fire</strong><span>A controlled source inside official Woldendorp forest leaves its containing neighbourhood seventieth of 92 because the shared allocator ignores source containment. Forest geometry is eligibility context, not ignition or current fuel state. Local flame requires a named perimeter, moisture, valid-time wind, access, extinguishing water and suppression.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0228' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Ede river and rain</strong><span>The persistent river value selects no connected Ede hydraulic event, hydrograph/datum, defence state, depth/velocity footprint, arrival, recession or dewatering and is therefore a non-operational diagnostic rather than a T+72 forecast. Available pluvial and water-system context is not sampled. Local magnitude, exposure, access and recovery remain Unknown until a versioned authority event preserves units, coverage, licence and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0228' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Ede Reemst fire</strong><span>A controlled source inside mapped Reemst heathland leaves its containing neighbourhood thirty-ninth of 71 because the shared allocator ignores source containment. Heathland geometry proves neither ignition nor current fuel condition. Local flame requires a named source/perimeter, fuel and moisture, valid-time wind, barriers, access, extinguishing water and suppression.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0228' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Exposure-model gap · Ede transient population</strong><span>CBS resident totals exclude incident-time Veluwe visitors, recreation guests, events, military populations, responders and their locations. Those cohorts and uncertainty are not silently added, so affected-person and evacuation figures remain incomplete until time-stamped occupancy evidence is supplied.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0230' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Elburg Randmeren and rain</strong><span>The false generic Rhine/Meuse/IJssel amplitude is suppressed because no Drontermeer/Randmeren/IJssel boundary, defence or Havensluis state, connected footprint, depth, arrival, duration, recession or dewatering is selected. Rijkswaterstaat reports that older PROMOVERA estimates may be about 0.75 m too high at Elburg. That correction is not an all-clear: urban rain, regional water, defences, access and indirect service pathways remain Unknown pending a versioned authority-selected event.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0230' &&
          (frame.scenario.disaster === 'heatwave' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('heatwave'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Elburg heat and groundwater</strong><span>The shared ranking does not sample the updated regional perceived-temperature, warm-night, groundwater, rain and water-supply surfaces or distinguish air temperature, surface heat, drought and vulnerable people. Those planning layers are context, not current conditions. Local exposure remains Unknown until versioned mechanism-specific surfaces are joined to event-valid forcing.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0230' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <>
            <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Elburg mixed-forest fire</strong><span>A controlled source inside official mixed forest and Buitengebied ’t Harde Zuid leaves its containing neighbourhood last of 22 while Broeklanden ranks first because the shared allocator ignores source containment. Combustible-area geometry is not ignition or current fuel state. Local flame requires a named source/perimeter, moisture, valid-time wind, access, extinguishing water and suppression.</span></div></div>
            <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario-scope gap · Elburg historic-centre fire</strong><span>The regional profile’s dense historic-centre fire pathway is a built-environment incident and is outside this nature-fire preset. Heritage buildings and regional exercises do not establish a current ignition, occupancy, affected zone or protective action; it must not be silently mapped to wildfire.</span></div></div>
          </>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0388' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Enkhuizen lake, polder and rain</strong><span>The retained river/coastal value selects no IJsselmeer/Markermeer boundary level or datum, wind setup, primary or regional defence, Sassluis/pump control, connected footprint, depth, arrival, recession or dewatering. It is a non-operational diagnostic—not current flooding or a T+72 forecast. The municipality’s 70 mm in one hour stress test is distinct from the national 70 mm in two hours layer and is not sampled. Local impact, access and recovery remain Unknown until an authority-selected versioned event preserves mechanism, units, coverage, licence and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0388' &&
          (frame.scenario.disaster === 'heatwave' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('heatwave'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Enkhuizen heat exposure</strong><span>The shared ranking does not represent the historic centre, older residents, schools or southern industry, nor distinguish apparent temperature, warm nights, surface heat, drought, shade and vulnerable people. Local exposure remains Unknown until versioned mechanism-specific surfaces are joined to event-valid forcing.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0388' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Enkhuizen Enkhuizerzand fire</strong><span>A controlled source inside official broadleaf woodland and Enkhuizerzand leaves its containing neighbourhood sixth of 19 while Ketenwaal about 5.5 km away ranks first because the shared allocator ignores source containment. Land cover is eligibility context, not ignition or current fuel. Local flame requires a named source/perimeter, moisture, valid-time wind, barriers, access, extinguishing water and suppression.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0232' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Epe IJssel and rain</strong><span>The false unselected 3.14 m-class Rhine/Meuse/IJssel amplitude is suppressed. That is not an all-clear: IJssel water and defence state, dike seepage, groundwater, brooks, culverts, pumps and eastern low-area pathways remain unresolved. Epe’s 74 mm in one hour stress test is distinct from the national 70 mm in two hours layer and is not sampled. Local impact, access and recovery remain Unknown until a versioned authority-selected event preserves footprint, time, units, controls, coverage and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0232' &&
          (frame.scenario.disaster === 'heatwave' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('heatwave'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Epe heat, drought and water</strong><span>The shared ranking does not represent older residents, non-heat-adapted homes, Veluwe forest and soils, shade, groundwater or distinct water availability. Current restrictions are timestamped observations, not this exercise’s T+72 forcing or proof of drinking-water capacity. Local exposure remains Unknown until versioned surfaces and valid-time forcing are bound.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0232' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Epe Gortel forest fire</strong><span>A controlled source inside official mixed forest near Gortel and Buitengebied Vaassen leaves its containing neighbourhood twenty-third of 29 while urban Heggerenk ranks first because the shared allocator ignores source containment. Forest geometry is eligibility context, not ignition or current fuel. Local flame requires a named source/perimeter, moisture, valid-time wind, holiday-park and visitor exposure, escape routes, extinguishing water and suppression.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0114' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Emmen peat, brooks and rain</strong><span>Direct Rhine/Meuse/IJssel and sea water are zero only within those narrow source scopes—not an all-clear. Schoonebeekerdiep, canals, brooks, peat/groundwater, Buffer Zuid, German boundary water, sewer and drainage controls remain unresolved. The model does not sample 14.5 km of new watercourses, weirs and culverts, and empty national HWH coverage does not mean zero assets. Local impact and recovery remain Unknown pending a selected, versioned event with units, controls, coverage and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0114' &&
          (frame.scenario.disaster === 'heatwave' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('heatwave'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Emmen peat, heat and groundwater</strong><span>The shared ranking does not represent peat oxidation, groundwater extraction, subsidence, Bargerveen water retention, shade, warm nights, buildings or older and care populations. Planning layers and current gauges are not T+72 forcing. Local heat, drought and drinking-water effects remain Unknown until versioned surfaces, valid-time weather and governed operator evidence are bound.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0114' &&
          (frame.scenario.disaster === 'earthquake' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('earthquake'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Emmen earthquake</strong><span>The synthetic 0.071 g-class peak selects no KNMI event ID/revision, source model, ground-motion field, site response, exposed buildings or lifeline fragility. Historical Roswinkel and other induced events are observations—not this future exercise or a damage forecast—and no recent local catalogue point does not mean zero risk.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0114' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Emmen Bargerveen fire</strong><span>A controlled source inside official Bargerveen/Weiteveen heath leaves its containing neighbourhood twenty-fourth of 83 while Hoofdkanaal about 18 km away ranks first because the shared allocator ignores source containment. Heath geometry is eligibility context, not ignition or current fuel. Local flame requires a named source/perimeter, moisture, valid-time wind, access, extinguishing water and suppression.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0114' &&
          (frame.scenario.disaster === 'earthquake' || frame.scenario.disaster === 'cyberattack') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario-scope gap · Emmen industry and mining</strong><span>Public REV and SodM context identifies Seveso, industrial, mining, gas-storage and water-injection pathways, but this version has no selected toxic-release, industrial-fire/explosion, pipeline or mining-water scenario. Facility presence and monitoring conditions are not incidents, source terms, affected zones or actions and must not be silently mapped to earthquake or cyberattack.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0770' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eersel rivers and rain</strong><span>Brabant-Zuidoost’s profile says the high region has no direct sea or major-river flood danger, so the false Rhine/Meuse/IJssel amplitude is suppressed. That is not an all-clear: local streams, regional water and blocked southern drainage remain unresolved. Published Eersel-kom/Lindeakkers and Eersel-Zuid cloudburst bottlenecks are not sampled. Local impact, access and recovery remain Unknown until an authority-selected event preserves footprint, duration, units, controls, coverage and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0770' &&
          (frame.scenario.disaster === 'heatwave' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('heatwave'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eersel heat and groundwater</strong><span>The shared ranking does not represent published urban-core heat or distinct Vessem, Knegsel and Wintelre groundwater patterns, nor distinguish air temperature, surface heat, drought and vulnerable people. Local exposure remains Unknown until versioned mechanism-specific surfaces are joined to event-valid forcing.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0770' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eersel Oeienbos fire</strong><span>A controlled source inside official Oeienbos and Knegsel-Oeyenbos leaves its containing neighbourhood last of 24 because the shared allocator ignores source containment. Combustible-area geometry is not ignition or current fuel state. Local flame requires a named source/perimeter, fuel and moisture, valid-time wind, access, extinguishing water and suppression.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1903' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eijsden-Margraten Maas and Noor</strong><span>The retained Maas value selects no Belgian/French upstream hydrograph, datum, saturated-soil state, defence condition, connected footprint, arrival, recession or dewatering, so it is a non-operational diagnostic—not current flooding or a T+72 forecast. Six Noor catchments and plateau-to-valley runoff are also unsampled. Local impact and recovery remain Unknown until an authority-selected cross-border event preserves units, coverage, licence, controls and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1903' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eijsden-Margraten Savelsbos fire</strong><span>A controlled BRT forest source inside BU19030409 leaves its containing neighbourhood twelfth of 34 because the shared allocator ignores source containment. Savelsbos/forest geometry is eligibility context, not ignition or current fuel. Local flame requires a named perimeter, moisture, valid-time wind, hollow-road access, extinguishing water and suppression.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM1903' &&
          (frame.scenario.disaster === 'earthquake' || frame.scenario.disaster === 'cyberattack') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario scope gap · Eijsden-Margraten underground and industrial hazards</strong><span>Provincial underground-work stability labels and REV records for Seveso and other hazardous activities are static context, not a current collapse, release, source term, plume, affected zone or protective action. This version has no quarry-instability or industrial-release preset. A future exercise requires an authority-approved event, governed consequence model and privacy/security-safe response evidence; these pathways must not be silently mapped to earthquake or cyberattack.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0772' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            frame.scenario.disaster === 'coastal-flood' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.some((component) =>
              component === 'pluvial-flood' || component === 'river-flood' || component === 'coastal-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eindhoven rivers and drainage</strong><span>Brabant-Zuidoost’s profile says the high region has no direct sea or large-river flood danger, so the false Rhine/Meuse/IJssel amplitude is suppressed. That is not an all-clear: Dommel, Tongelreep, Gender, smaller streams, groundwater, pluvial and indirectly blocked drainage remain unresolved. Published municipal runoff, sewer and watercourse geometry is not sampled and does not establish capacity or state. Local impact and recovery remain Unknown until an authority-selected event preserves footprint, time, units, controls, coverage and NoData.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0772' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Eindhoven Gennep fire</strong><span>A controlled source inside official Gennep broadleaf forest leaves Gennep 112th of 116 while Wielewaal about 5.16 km away ranks first because the shared allocator ignores source containment. Forest geometry is eligibility context, not ignition or current fuel. Local flame requires a named source/perimeter, moisture, valid-time wind, visitors, access, extinguishing water and suppression.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0772' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario-scope gap · Eindhoven airport, Brainport and complex incidents</strong><span>Eindhoven Airport, Brainport industry, hazardous materials, high-rise buildings and major events are material regional contexts but are not selectable source-term, aviation, industrial-release or mass-casualty scenarios in this version. Registers and facility presence are not incidents, affected zones or protective actions. A future exercise needs an authority-approved event and privacy/security-safe consequence, occupancy and response evidence.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0109' &&
          (frame.scenario.disaster === 'pluvial-flood' ||
            frame.scenario.disaster === 'river-flood' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.some((component) =>
                component === 'pluvial-flood' || component === 'river-flood'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario scope gap · Coevorden water pathways</strong><span>The direct Rhine/Meuse/IJssel field is disabled for Coevorden, but that scoped zero is not an all-clear. Local brooks and canals, Stadsgracht, three-waterboard drainage, sewer overload, low roads, N34 access and indirect supply remain unresolved because no connected hydraulic event, control state, depth unit, arrival, duration or recession is selected. The generic logical network can still create affected-population pressure while cumulative event-attributable person-hours excludes intermunicipal transfers; neither figure is an observed outage. A versioned authority-selected event is required before local water impact can be shown.</span></div></div>
        )}
        {activeLayer === 'hazard' && selected.id === 'GM0109' &&
          (frame.scenario.disaster === 'wildfire' ||
            (frame.scenario.disaster === 'compound' &&
              frame.scenario.components?.includes('wildfire'))) && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario evidence gap · Coevorden Gees forest fire</strong><span>A controlled source inside official Boswachterij Gees/Hooge Loo forest and BU01093039 ranks its own neighbourhood fortieth of 68 while Lootuinen, nearly 12 km away, ranks first. Forest geometry proves combustible-area eligibility, not a live incident. Until a named source/perimeter, fuel and moisture, event-valid wind, access, extinguishing water and suppression state govern allocation, direct flame and smoke remain unsupported exercise outputs rather than forecasts.</span></div></div>
        )}
        {activeLayer === 'water' && selected.id === 'GM0383' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · PWN Castricum dune infiltration</strong><span>PWN describes pretreatment at Andijk, a 52 km transfer to the Castricum/Heemskerk dunes, roughly three weeks of infiltration and a coastal calamity reserve. This is process and resilience context, not a live reserve volume, pressure, quality, pump, backup or restoration state. The current generic water graph does not represent that chain and must not be read as PWN performance.</span></div></div>
        )}
        {activeLayer === 'drainage' && selected.id === 'GM1706' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · RWZI Soerendonk</strong><span>Waterschap De Dommel says RWZI Soerendonk serves Budel, Budel-Schoot, Budel-Dorplein, Gastel, Maarheeze and Soerendonk, with a published design of 38,000 population equivalents and 1,830 m³/hour; Maarheeze reaches it by gravity while the other cores are pumped. These are design and process facts—not live inflow, usable spare capacity, pump/control state, backup power or restoration. The current generic drainage graph does not model this catchment or its discharge to the Buulder Aa and must not be read as current RWZI performance.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0310' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · RWZI De Bilt and Biltse Grift</strong><span>HDSR says RWZI De Bilt treats wastewater from seven named cores and discharges to the Biltse Grift; documented 2023 treatment/control failure and 2024 rain-overflow consequences establish real pathways, not a probability that they recur. The 74 intersecting HWH objects and three-waterboard context do not provide catchment connectivity, compatible flow units, current controls, usable capacity, backup power or restoration. This generic municipal graph must not be read as present wastewater, drinking-water or surface-water performance.</span></div></div>
        )}
        {activeLayer === 'drainage' && selected.id === 'GM1891' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Dantumadiel pressure sewer and water chain</strong><span>Municipal guidance identifies heavy-rain overload of rural pressure sewers and pumps, while public context includes RWZI Damwoude, sewer and surface-water pumps, a sluice and weirs. Those registers locate objects but do not establish connected catchments, flow direction, unit-compatible available capacity, present state, backup or recovery. Missing operational evidence stays Unknown; the generic drainage value is a synthetic exercise index, not Wetterskip performance.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM1940' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · De Fryske Marren managed-water chain</strong><span>The 1,191 intersecting public HWH records include 129 surface-water pumps, 29 sewer pumps, three treatment plants, 17 sluices and 1,013 weirs. They establish object and mechanism context across fragmented level areas, not catchment connectivity, flow direction, compatible capacity, current controls, usable reserve, backup power or restoration. Waterinfo observations retain valid time and can contain a true measured zero, but one observation cannot be extended through T+72. The generic water and drainage values are synthetic exercise indices, not current Wetterskip, wastewater or drinking-water performance.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM1690' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · De Wolden sewer and managed water</strong><span>The municipal sewer plan identifies 49 pumping stations, 1,042 rural pump units, 253 km of pressure sewer and treatment dependencies outside the municipality; 265 public HWH objects provide partial register context. Those facts do not establish connected catchments, compatible flow/storage units, current inlet, pipe, pump, receiving-level or control state, backup power or restoration. An empty local RWZI result is incomplete coverage—not no wastewater dependency—and generic water/drainage values are synthetic exercise indices, not operator performance.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0736' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · De Ronde Venen AGV asset coverage</strong><span>The national HWH snapshot intersects zero objects, while AGV identifies Gemaal De Ruiter, Gemaal Demmerik, Demmerikse sluis, RWZI Ronde Venen and local dike systems. This is a contributor-coverage gap, not zero assets, connectivity or drainage capacity. Until an authorized, versioned AGV legger/topology supplies status, catchments, compatible units, controls, backup and restoration, the generic water and drainage values remain synthetic and operational state remains Unknown.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0503' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Delft polder, boezem and water chain</strong><span>The 168 public HWH points and Delfland register establish pumps, storage, flap-weir, polder, boezem and Schie context; Delft’s observed 2023 emergency pumping response proves a past mechanism, not recurrence or present operation. The points provide neither catchment connectivity, flow direction, compatible capacity, current control/backup nor restoration, and drinking-water quantity/pressure/quality and wastewater treatment remain distinct unmodeled pathways. Generic water and drainage values are synthetic exercise indices, not current Delfland, Evides or wastewater performance.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0400' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Den Helder HHNK and near-shore coverage</strong><span>The national HWH assignment returns zero local objects while HHNK’s legal service names six primary-defence lines and local water-system works. Waterinfo’s fresh Marsdiep and veersteiger stations lie just outside the generalized land polygon. These are association and contributor-coverage gaps—not no assets, zero level or safety. Legal geometry and observed points establish neither connected catchments, current pump/defence state, usable reserve, backup nor restoration, and a point observation cannot be projected through T+72.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0762' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Deurne managed-water chain</strong><span>The 245 public HWH records locate five sewer pumps, 25 surface-water pumps and 215 weirs. Municipal and Aa en Maas plans add dated sewer, Peel-channel, Soeloop and rewetting mechanisms. They do not establish connected catchments, compatible capacity units, current controls, usable reserve, backup or restoration. No in-boundary treatment feature and no drainage-provider polygon mean incomplete scoped coverage—not no wastewater dependency or service. Generic water and drainage values remain synthetic exercise indices.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0150' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Deventer three-waterboard chain</strong><span>The 123 public HWH objects and official context establish managed-water assets and three water-board responsibilities, including low-IJssel pumping mechanisms. They do not establish catchment connectivity, flow direction, compatible capacity, current pump/weir/sluice state, potable quantity/quality, wastewater treatment, backup or restoration. Public points and legal areas stay non-causal context; missing or partial records remain Unknown and the generic water/drainage scores are not operator performance.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM1980' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Dijk en Waard compartments and pumps</strong><span>The 210 public HWH objects and municipal programme locate pumps, weirs and drainage mechanisms across a compartmentalized polder. They do not establish connected sewer/surface-water catchments, flow direction, compatible capacity, present receiving levels or controls, emergency power, usable reserve or restoration. Plan targets are not observed performance, and register absence remains Unknown. Generic water and drainage values are synthetic exercise indices rather than HHNK, drinking-water or wastewater state.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0384' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Diemen AGV coverage</strong><span>The national HWH assignment returns zero local objects despite AGV’s published defences and monitored urban-water systems. This is a contributor/query coverage result—not no assets, connectivity, capacity or risk. Legal and modeled layers establish neither current gate, pump, sewer, receiving-water or quality state nor backup and restoration. Until an authorized versioned AGV/municipal topology is available, operational state remains Unknown and generic water/drainage values are synthetic indices.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0221' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Doesburg Beinum and water chain</strong><span>Sixteen public HWH objects and the Beinum pond, wadi and weir design establish real asset and pathway context. They do not establish connected catchments, compatible flow/capacity units, current pump or control state, IJssel receiving level, emergency power, potable-water pressure/quality or restoration. The normalized Gemaal Doesburg capacity value has no usable unit. Registers remain non-causal and generic water/drainage values are synthetic exercise indices, not WRIJ, Vitens or wastewater performance.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM1774' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Dinkelland Vechtstromen coverage</strong><span>The deployed national HWH snapshot intersects zero objects, while the public Vechtstromen Legger intersects pumps, hundreds of weirs and more than a thousand culverts and discharge reaches. This proves contributor/query NoData—not absence of a managed-water system. Legger geometry lacks confirmed reuse terms and does not establish connected catchments, live controls, compatible capacity, receiving levels, backup or restoration. Operational state remains Unknown until an authorized versioned topology is supplied.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0222' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Doetinchem WRIJ water chain</strong><span>Fifty-nine public HWH records—five sewer pumps, RWZI Wehl, one surface-water pump and 52 weirs—plus WRIJ’s public service establish real object and wastewater context. They do not establish connected catchments, flow direction, comparable capacity units, present pump/treatment/control state, receiving levels, potable-water pressure or quality, backup or restoration. A registered or “gerealiseerd” object is not observed performance; operational state remains Unknown and generic water/drainage values are synthetic indices.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0109' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Coevorden regional water and drainage</strong><span>The 237 public HWH objects and named Stadsgracht/Kleine Vecht projects establish asset and mechanism context across three waterboards, not connected catchments, flow direction, compatible capacity units, inlet/culvert/control state, receiving levels, backup power or restoration. Current model values are generic synthetic balances; public register presence or absence cannot establish present Vechtstromen, Hunze en Aa’s or Drents Overijsselse Delta performance.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply') && selected.id === 'GM0216' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Culemborg–Houten ferry</strong><span>The operator identifies a 15-tonne vehicle limit and water-level-sensitive current service between Culemborg and Schalkwijk/Houten. No documented machine-readable status API, reuse licence or contractual update cadence was found. The route is absent from the causal graph, so this version cannot establish ferry operation, future scenario-time availability, evacuation throughput or emergency-logistics capacity; a human current-status page must not be replayed as a T+72 forecast.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0148' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Dalfsen Vecht bridge</strong><span>A dated municipal answer says the bridge structure was adequate for its tested high-water level while explicitly leaving reachability unresolved if the deck or approaches are inundated. The current one-node municipality graph cannot split north/south communities, close the crossing or route care, evacuation, supplies and repair crews around it. Without a selected hydraulic footprint and current road-authority decision, structure condition, passability and alternative-route capacity remain Unknown; this gap must not trigger an inferred utility failure.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1891' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Dantumadiel rural roads and rail</strong><span>The graph contains only five N-road boundary proxies. NWB geometry, De Westereen/Feanwâlden stations, scheduled GTFS stops and absence of a matched current NDW record do not establish scenario-time road, culvert, rail or bus operation, passability, accessible vehicles, evacuation capacity or emergency throughput. Unreported routes remain Unknown—not automatically open—and observed status can affect a replay only when its validity time is explicitly aligned.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1940' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · De Fryske Marren crossings and external care</strong><span>Six A6/A7/N-road municipal-border links omit internal bridges, locks, tunnels, local roads, bus operation and the Lemmer–Delfzijl waterway across 51 dispersed cores and extensive lakes and canals. No acute hospital is mapped inside the municipality; straight-line context for Heerenveen or Sneek does not establish ambulance travel, route passability, acceptance, staffing or capacity. Static NWB, ProRail, GTFS and waterway geometry are not incident-time state, while an absent NDW match never proves a crossing open. Scenario-time evacuation, care, supply and repair reachability remain Unknown.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1690' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · De Wolden local continuity</strong><span>Seven verified A28/N-road boundary links omit event-valid local roads, bridges, culverts, bus/rail operation, emergency access and Meppel/Echten treatment or care reachability. NWB geometry and an absent current NDW match do not prove scenario-time passability or capacity. Mobility, supply, evacuation and repair access remain Unknown until validity-aligned authority state is attached; transport geometry must never trigger an automatic utility failure.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0736' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · De Ronde Venen local roads and transit</strong><span>Five A2/N201/N212 municipal-border links omit event-valid local roads, bridges, culverts and rail/transit continuity. Abcoude station, scheduled GTFS stops and an empty current NDW intersection establish neither open nor closed state; the June 2026 flooded-road report cannot be replayed as a future T+72 closure. Scenario-time travel, evacuation, care, supply and repair access remain Unknown until source-valid state, direction and capacity rules are supplied.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0503' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Delft tunnel, crossings and acute care</strong><span>Five A13/N470 border links omit Delft’s rail tunnel, internal streets, bridges and sluices, train/tram/bus operation, Delftse Schie and ambulance routing. Reinier de Graaf’s registered acute-care role and straight-line distance do not establish route passability, vehicle availability, acceptance, staffing or capacity. One valid-time bridge message is an observation, not a future T+72 state. Scenario-time care, evacuation, supply and repair reachability remain Unknown until multimodal authority state is aligned to the exercise clock.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0400' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model scope · Den Helder TESO and Kooybrug</strong><span>The audited GTFS TESO line now provides a Den Helder–Texel mobility/supply-only logical route with feed-valid schedule geometry. Its 60-unit value is a balancing quantity—not passengers, vehicles or trips—and neither GTFS nor the human TESO page guarantees live or future T+72 sailing, priority or capacity. N9/N99/N502 geometry and dated Kooybrug contingency evidence likewise do not establish scenario-time passability, care access, airport/port continuity or emergency throughput; those states remain Unknown until validity-aligned authority data is bound.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0762' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Deurne roads, rail and Peel</strong><span>Five A67/N270/N279 boundary links, Deurne station and scheduled transit stops are static geometry or timetable context. They omit local road access into the Deurnsche Peel, heavy-vehicle limits, rail and bus operation, ambulance routes, evacuation and repair logistics. The N279 connector shares one physical NWB section across two series edges; this must not be summed as two independent corridors. Scenario-time passability and throughput remain Unknown without validity-aligned authority state.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0150' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Deventer crossings and acute care</strong><span>Six A1/N-road boundary links omit internal IJssel bridges, the ferry, local threshold-conditioned roads, rail operation and time-dependent routes to Deventer Ziekenhuis. Static NWB, ProRail and GTFS geometry plus a hospital questionnaire do not establish passability, ambulance travel, acceptance, staffing, beds or emergency throughput. Municipal water-level rules may apply only to their named assets and a current NDW event cannot be replayed as future state. Scenario-time care, evacuation, supply and repair reachability remain Unknown.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1980' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Dijk en Waard internal continuity</strong><span>Ten NWB municipal-border links, Heerhugowaard station and scheduled transit stops provide static geometry or timetable context but omit local bridges, tunnels, polder roads, rail/bus operation, emergency routes and access to external acute care. An absent current incident record does not prove a route open. Scenario-time evacuation, care, supply and repair throughput remain Unknown until validity-aligned authority state is attached.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0384' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Diemen tunnel and transit</strong><span>Five A1/A9/Hartveldseweg boundary links omit Gaasperdammertunnel state, rail, metro and tram operation, local roads, bridge/tunnel restrictions, evacuation and emergency access. Static NWB, ProRail and GTFS context plus an absent NDW match do not prove scenario-time passability or capacity. Mobility, care, supply and repair reachability remain Unknown until validity-aligned authority state is bound to the exercise.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0221' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Doesburg bridge and historic centre</strong><span>Four N317/N338 border links with verified NWB identities omit IJssel bridge approaches, local flooded-road classes, narrow historic-centre access, transit, ambulance routing and repair logistics. Static geometry and an absent current incident do not prove scenario-time passability or throughput. Care, evacuation, supply and response access remain Unknown until a selected hydraulic footprint and validity-aligned road-authority state are bound to the exercise clock.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1774' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Dinkelland cross-border continuity</strong><span>Ten Dutch NWB links omit the German N342/B403 continuation, upstream Dinkel dependency, the short hazardous-goods rail section, narrow Ootmarsum access, external acute care and cross-border mutual aid. Static road/transit geometry and absence of a current NDW record do not prove operation. Scenario-time mobility, evacuation, care, supply and response continuity remain Unknown until country, authority, mode, direction, validity, licence and capacity are bound explicitly.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0222' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Doetinchem continuity and Slingeland</strong><span>Ten A18/N-road border links omit local flooded-road classes, rail and bus operation, emergency routes and time-dependent access to Slingeland Hospital, treatment, support points, supplies and repair crews. Static road/transit geometry, a 24/7 hospital role and the municipality’s current absence of emergency support points prove neither future passability, acceptance, staffing, capacity, generator fuel nor activation. Scenario-time care, evacuation, supply and repair reachability remain Unknown until validity-aligned authority actions and resources are confirmed.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0505' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Official valid-time restriction · N3 Papendrechtsebrug</strong><span>Rijkswaterstaat states that the bridge is closed to all road traffic in both directions from 17 July 2026 through 21 April 2027, with published diversions adding about 30–60 minutes. {dordrechtN3ValidityMessage} Baanhoek emergency access and cyclist/pedestrian ferries are separate mode-limited alternatives whose usable capacity remains Unknown; NDW absence never proves an open road.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0512' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Official vehicle-class restriction · A27 Merwedebrug</strong><span>Rijkswaterstaat states that trucks and touring coaches have been prohibited in both directions since 18 July 2026, while passenger cars, scheduled buses and emergency services remain allowed; published heavy-traffic detours use A15/A16/A59 or A15/A2/A59, with dangerous goods via A2. {gorinchemA27ValidityMessage} Missing NDW records never prove the bridge open, and the notice supplies no expiry.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0542' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Official role-specific restriction · N210 Algerabrug</strong><span>Rijkswaterstaat and Krimpen state that ordinary motor traffic is closed from 10 August 2026 00:00 through 7 September 2026 05:00, while controlled emergency services retain a lane; pedestrians/cyclists use a temporary bridge and increased Stormpolder–Rivium Waterbus service is a separate mitigation. {krimpenAlgerabrugValidityMessage} The exercise date cannot resolve the 05:00 endpoint, so the record remains non-numeric context. Alternative capacity and state after expiry remain Unknown, never guaranteed available or open.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && (selected.id === 'GM0546' || selected.id === 'GM0547') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Official role-specific restriction · Lage Rijndijk / Spanjaardsbrug</strong><span>Gemeente Leiderdorp states that the Lage Rijndijk between Sumatrastraat and Spanjaardsbrug is closed to cars and buses from 17 August through 11 September 2026 for Liander gas-main work. Emergency services, cycles and mopeds can pass; the notice gives a signed detour and direction-specific Baanderij access. {spanjaardsbrugValidityMessage} NWB centreline sections make the crossing visible in gray on Mobility and Supply, but absent live state or capacity remains Unknown rather than open or available.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1640' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Official vehicle-class restriction · N280 Kelperbrug</strong><span>Rijkswaterstaat and Provincie Limburg state that trucks, agricultural vehicles and non-scheduled buses are prohibited on the Kelperbrug from 9 June 2026 because corrosion reduced structural capacity. Scheduled public transport and emergency services are exempt; signed alternatives use N275/N279, N280/N273/A2 and A2/A73 depending on direction. {kelperbrugValidityMessage} The official notice has no end date, so the evidence expires at retrieval rather than becoming a permanent closure. An empty NDW match never proves the bridge open, and alternate-route throughput remains Unknown.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1705' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Official valid-time restriction · Rijndijk Angeren–Doornenburg</strong><span>Gemeente Lingewaard states that the Rijndijk between Zahnstraat/Scherpekamp in Angeren and Krakkedel in Doornenburg is closed from 24 August through 2 October 2026 for the ViA15 work-road crossing. Traffic is diverted via Lodderhoeksestraat/N838, with extra morning congestion anticipated. {rijndijkValidityMessage} NWB sections 389272008 and 391270006 provide the displayed internal centreline. Empty NDW remains Unknown rather than open, and N838 capacity or emergency suitability is not inferred.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0553' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Official lifecycle context · Lisse access and seasonal demand</strong><span>Rijkswaterstaat states that the A44 main carriageway reopened on 4 July 2026 while the Lisserweg underpass and Lisserweg–Kaagweg local connection remained closed pending a planned 6 September reopening. {lisserwegValidityMessage} The N207/N208 junction and Ringvaart/Lisserbrug are distinct bottlenecks omitted by the current logical graph; repeated A44/N208 edges are not independent redundancy, and zero bounded NDW matches never proves passage. Keukenhof's 2026 season had ended by the 3 September audit date, so its reported 1.4 million seasonal visits, 45% bus share and 2,000 seasonal staff are demand context—not current occupancy and never annual residents.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1641' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Official mode-specific restriction · Stuw Linne crossing</strong><span>Rijkswaterstaat closes the Stuw Linne pedestrian/cycle bridge from 28 August through 4 September 2026 and publishes a signed active-mode detour. {linneValidityMessage} The crossing is absent from the current static route graph, so the simulator surfaces the gap rather than attaching it to an unrelated A2/A73 edge. The notice gives no exact reopening time or live confirmation; zero bounded NDW matches never means open, and active-mode evacuation or care accessibility remains Unknown.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1931' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Transport provenance correction · N216 Schoonhoven–Gelkenes ferry</strong><span>NWB sections 600441023 and 600441055 are class VDA, and the operator identifies the Lek crossing as a vehicle ferry for traffic from pedestrians through heavy freight. The graph now keeps one typed ferry corridor instead of a 150-unit regional road. Its published 05:00–00:00 timetable and weekday peak deployment are context only: they do not prove scenario-time sailing, waiting time, emergency priority or throughput. Capacity and operational state remain Unknown, so the route is excluded from causal transfers until validity-aligned operator or authority evidence is available. Static HHSK high-water landing thresholds are triggers for a selected event—not current closures.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM1659' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Laarbeek Aa system and remote control</strong><span>Veiligheidsregio Brabant-Zuidoost excludes direct Rhine, Meuse and sea flooding here; locally relevant pathways are the Aa, Goorloop, Snelleloop, Boerdonkse Aa, rain, groundwater and managed drainage. Aa en Maas also documents remote operation of weirs, pumps, gates and measurements, but its control-system replacement is lifecycle context—not evidence of a cyber incident, live asset state or failure. Public observations and 105 register objects provide neither connected catchments, compatible capacity, settings, backup nor restoration. The major-river screen is suppressed, while local water and control consequences remain Unknown until an authority-selected event and safe reviewed topology are supplied.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0766' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Dongen roads and continuity</strong><span>N629/N632 municipal-border geometry omits local rain-sensitive roads, rail/bus operation, ambulance routes, external acute care, evacuation and repair logistics. Two blank-wegnummer N632 source sections remain identity-uncertain. NWB is now limited to Mobility and road logistics/Supply; static geometry and an absent current incident record do not prove scenario-time passability or throughput.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1719' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Drimmelen dispersed cores and Biesbosch</strong><span>NWB and scheduled transit establish only static routes and timetable context. They omit internal flooded-road classes, Amer crossings, Biesbosch response access, service operation, external acute care, ambulance routing, evacuation and repair logistics. Scenario-time passability, destinations, occupancy and throughput remain Unknown until validity-aligned authority state and actions are bound to the exercise.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0225' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Druten Waal crossings and external care</strong><span>Three NWB border links, scheduled stops and the closest registered SEH in Tiel establish geometry or role only. They omit internal flooded roads, bridge state, ambulance routing/availability, hospital acceptance, seasonal ferry limits, evacuation destinations and repair logistics. Proposed emergency support points and schools are not activated shelters. First-72-hour passability, capacity, staffing, occupancy and supplies remain Unknown until validity-aligned authority actions and resources are recorded.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0303' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Dronten crossings, visitors and external care</strong><span>NWB and GTFS establish static roads and scheduled routes only. They omit event-time bridge/road passability, seasonal visitors, vehicle and crew availability, ambulance routing, external hospital acceptance, refuge activation, repair access and supply priorities. First-72-hour reachability, throughput, destinations, staffing, occupancy and stocks remain Unknown until source-valid operational state and an authority action ledger are bound to the exercise clock.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0498' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Transport provenance correction · Drechterland N307/N506</strong><span>The NWB generator now rejects municipality-border pairings whose primary wegnummer differs and guards against one section supporting distinct parallel corridors for the same pair. This removes N506 sections 285443011/014 from N307 provenance. Remaining capacities are still generalized scenario units—not lanes, vehicles, measured throughput or proof of event-time access—and local roads, transit, ambulance, evacuation, care, supply and repair state remain Unknown.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0385' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Edam-Volendam bridges and continuity</strong><span>NWB roads and scheduled transit are static geometry or timetable context. They omit event-time bridge, harbour, local-road and bus passability, ambulance routing, external hospital acceptance, evacuation destinations, repair access and supply priorities. First-72-hour reachability, throughput, staffing, occupancy and stocks remain Unknown until source-valid operational state and authority actions are bound to the exercise clock.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0226' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Duiven A12, rail and external care</strong><span>NWB and scheduled transit establish static road and timetable context only. They omit event-time A12, rail, bridge and local-road passability, ambulance routing, external hospital acceptance, industrial-site access, evacuation, supply and repair capacity. An absent current incident record never proves a route open; first-72-hour reachability and throughput remain Unknown until validity-aligned authority state and actions are supplied.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1711' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Cross-border model gap · Echt-Susteren continuity</strong><span>The national graph stops at the border and therefore omits German and Belgian roads, rail, utilities, telecom, care, mutual aid and supply dependencies. Dutch NWB geometry cannot establish cross-border passability, service availability, ambulance routing, hospital acceptance or response capacity. First-72-hour continuity remains Unknown until compatible, licensed, validity-aligned adjoining-country topology and authority actions are supplied.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0317' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Eemnes A1 and external care</strong><span>NWB roads and scheduled transit establish static geometry or timetables only. They omit event-time A1 and local-road passability, ambulance routing, external hospital acceptance, evacuation, repair access and supply throughput. No current incident record does not prove a route open. First-72-hour travel, capacity, staffing, occupancy and stocks remain Unknown until authority state and actions are validity-aligned.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1979' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Eemsdelta settlements, port and care</strong><span>Static road, rail and timetable context does not establish event-time dike-road, local-road, rail, harbour or shipping operation across dispersed settlements, ambulance routing, external hospital acceptance, port workforce movement, evacuation, supply or repair capacity. First-72-hour passability, destinations, staffing, occupancy and throughput remain Unknown until validity-aligned authority actions and resources are recorded.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0228' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Ede Veluwe and first-72-hour continuity</strong><span>Static NWB and scheduled transit omit event-time local and forest-road passability, rail operation, recreation and event occupancy, military and responder movement, ambulance routing, hospital acceptance, evacuation, supply and repair throughput. Ede’s support-point locations remain under investigation. Reachability, capacity, staffing, stocks and completed actions remain Unknown until an auditable authority and resource ledger is bound to the exercise clock.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0230' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Elburg regional continuity</strong><span>NWB, ProRail and scheduled transit establish static A28/N309, Drontermeer crossing, rail and timetable context only. They omit event-time bridge and road passability, train operation, vehicles, ambulance routing to external acute care, hospital acceptance, evacuation, supply and repair throughput. Zero matched NDW records does not prove routes open. First-72-hour resources and completed actions remain Unknown until validity-aligned authority state and an action ledger are supplied.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0388' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Enkhuizen regional continuity</strong><span>NWB, ProRail and scheduled transit establish static Houtribdijk/naviduct, local-road, rail and timetable context only. They omit event-time direction and mode restrictions, passability, train operation, vehicles, ambulance routing and hospital acceptance in Hoorn or Lelystad, evacuation, supply and repair throughput. First-72-hour resources and completed actions remain Unknown until validity-aligned authority state and an action ledger are supplied.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0232' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Epe forest, settlements and external care</strong><span>Six NWB boundary links and scheduled transit establish static major-road and timetable context only. They omit local forest tracks, culverts, holiday-park egress, bus operation, ambulance routes to external hospitals, hospital acceptance, evacuation, response-water access, supply and repair throughput. No matched current incident record does not prove passability. First-72-hour resources, failed actions and restoration remain Unknown until validity-aligned authority state and an action ledger are supplied.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0114' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Cross-border model gap · Emmen A37–B402 continuity</strong><span>The Dutch graph stops where A37 continues as Germany’s B402 toward A31 and also omits transboundary Schoonebeekerdiep coordination. Static Dutch geometry and schedules do not establish border passability, freight, mutual aid, hospital acceptance, evacuation, supply or repair throughput. Across 37 settlements, first-72-hour crews, fuel, spares, household preparedness and completed or failed actions remain Unknown until a shared validity-aligned authority/resource ledger is bound to the exercise.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply') && selected.id === 'GM0388' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Transport provenance correction · Enkhuizen Houtribdijk</strong><span>N307, Markermeerdijk and Markerwaarddijk were three names for main, parallel and road-body source sections on one Enkhuizen–Lelystad crossing—not three independent routes. They now share one NWB-road-307 physical corridor and one 150-unit ceiling, with all eight section IDs and HR/PAR/RB classes retained as provenance. That ceiling remains a generalized scenario unit, not vehicles/hour, measured capacity or proof of event-time access.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0770' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Eersel A67 and external care</strong><span>NWB roads and scheduled transit establish static geometry or timetables only. They omit event-time A67/N397 and local-road passability, vehicles, ambulance routing, external Veldhoven hospital acceptance, evacuation, supply and repair throughput. First-72-hour travel, staffing, occupancy, stocks and completed actions remain Unknown until validity-aligned authority state and a resource/action ledger are bound to the exercise.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM1903' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Eijsden-Margraten cross-border continuity</strong><span>The Dutch graph omits Belgian A2/E25 and regional-road continuations, the Eijsden–Visé railway, cross-border transit, hydraulic coordination and crisis dependencies. Static Dutch or Belgian geometry and timetables do not prove event-time passability or service. Ambulance routing, hospital acceptance, evacuation, mutual aid, supply, repair capacity and completed actions remain Unknown until a shared NL-BE authority/resource ledger is validity-aligned to the exercise.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0772' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Eindhoven regional continuity</strong><span>NWB, ProRail and scheduled transit establish static roads, rail and timetables only. They omit event-time A2/N2/A67/local-road passability, airport and rail operation, vehicles, ambulance routing, hospital acceptance, evacuation, support-point activation, supply and repair throughput. First-72-hour staffing, occupancy, stocks, resources and completed actions remain Unknown until validity-aligned authority state and an action ledger are bound to the exercise.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply') && selected.id === 'GM0772' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Transport provenance correction · Eindhoven A2 ramp</strong><span>NWB sections 325158020 and 326158032 identify A2/RW2 access-ramp class OPR. They are now retained as provenance on the existing A2 Eindhoven–Valkenswaard corridor instead of appearing as a third route named 002 with an independent 150-unit ceiling. A2 and N2 remain distinct where NWB supports main and parallel carriageways. Every ceiling is still a generalized scenario unit—not vehicles/hour, measured capacity or proof of event-time access.</span></div></div>
        )}
        {activeLayer === 'facilities' && selected.id === 'GM0226' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Unmodeled hazard scope · Duiven InnoFase and industry</strong><span>Public planning and establishment context identifies industrial and hazardous-substance pathways around InnoFase, but the current preset set has no industrial-release, fire-plume or cascading site-event model. Facility presence is not a current incident, source term, affected zone or protective action. A future exercise requires an authority-approved event, site-specific consequence model and privacy/security-safe response evidence; it must not be silently mapped to wildfire or cyberattack.</span></div></div>
        )}
        {activeLayer === 'facilities' && selected.id === 'GM1979' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Unmodeled hazard scope · Eemsdelta Oosterhorn industry</strong><span>Public planning and REV context identify Seveso and other industrial fire, explosion and toxic-release pathways around Oosterhorn and the port, but this version has no industrial source-term, plume or cascading site-event model. Facility presence and attention areas are not a current incident or protective action. A future exercise requires an authority-approved event, site consequence model and privacy/security-safe response evidence; it must not be silently mapped to wildfire or cyberattack.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0109' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · Coevorden cross-border logistics</strong><span>Ten verified Dutch A/N-road logical links omit local roads, event-valid N34 passability and German, rail and waterway continuity around Europark/Euroterminal. NWB, ProRail and GTFS establish geometry or schedule context; an absent current NDW match does not prove a route open. Scenario-time travel, freight, evacuation, care and repair access remain Unknown until source-valid state, mode, direction and capacity rules are supplied.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0216' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Culemborg road-derived lifelines</strong><span>NWB proves road geometry only, so A2, N320 and N833 are now restricted to Mobility and explicitly assumed road logistics/Supply. They no longer carry power, water, drainage, gas, telecom or facility transfers and establish no Liander, Vitens or water-board topology. Those non-road values remain municipality-level synthetic indices and must not be read as physical utility flow, outage isolation or operator restoration.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0148' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Dalfsen road-derived lifelines</strong><span>NWB proves road geometry only, so the eleven links are now restricted to Mobility and explicitly assumed road logistics/Supply. Public water objects and provider territories establish neither physical Enexis, Vitens, wastewater, gas nor telecom topology. Non-road values remain municipality-level synthetic indices, not operator assets or live flows.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0310' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · De Bilt road-derived lifelines</strong><span>NWB establishes A27/A28/N-road geometry only; the nine links are now restricted to Mobility and explicitly assumed road logistics/Supply. Provider territories and public registers do not establish physical Stedin, Vitens, wastewater, gas, telecom or facility topology. Non-road values remain municipality-level synthetic indices, not operator assets or live flows.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM1891' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Dantumadiel road-derived lifelines</strong><span>NWB proves road geometry only; N356/N361/N910 are now restricted to Mobility and explicitly assumed road logistics/Supply. Provider areas and public registers do not establish physical Liander/Stedin/Vitens, wastewater, telecom or facility topology. Non-road values remain municipality-level synthetic indices and must not be read as operator routes or flows.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM1940' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · De Fryske Marren road-derived lifelines</strong><span>NWB proves transport geometry only; the six links are now restricted to Mobility and explicitly assumed road logistics/Supply. Public water objects, provider territories and facility points establish no physical Liander, Vitens, wastewater, gas, telecom or facility topology. Non-road values remain municipality-level synthetic indices and must not be read as operator assets, live flows or outage predictions.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM1690' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · De Wolden road-derived lifelines</strong><span>NWB proves transport geometry only; the seven A28/N-road links are now restricted to Mobility and explicitly assumed road logistics/Supply. Provider areas and public registers establish no physical Enexis, Rendo, WMD, wastewater, gas, telecom or facility topology. Non-road values remain municipality-level synthetic indices, not operator assets, live flows or outage predictions.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0736' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · De Ronde Venen road-derived lifelines</strong><span>NWB proves road geometry only; A2/N201/N212 are now restricted to Mobility and explicitly assumed road logistics/Supply. Provider territories and public registers establish no physical Stedin, drinking-water, wastewater, gas, telecom or facility topology. Non-road values remain municipality-level synthetic indices and must not be read as operator routes, live flows or outage predictions.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0503' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Delft road-derived lifelines</strong><span>NWB proves transport geometry only; A13/N470 are now restricted to Mobility and explicitly assumed road logistics/Supply. Provider territories and public registers establish no physical Stedin, Evides, wastewater, gas, telecom or facility topology. Non-road values remain municipality-level synthetic indices and must not be read as operator routes, live flows or outage predictions.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0400' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Den Helder road-derived lifelines</strong><span>The N9, N99 and N502 links are now restricted to Mobility and explicitly assumed road logistics/Supply; TESO is explicitly restricted to Mobility and Supply. They are not physical Liander, PWN, HHNK, wastewater, gas, telecom or facility topology. Current non-mobility values remain municipality-level synthetic indices and must not be read as operator routes, live flows or outage predictions.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0762' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Deurne road-derived lifelines</strong><span>The A67/N270/N279 links prove road geometry only and are now restricted to Mobility and explicitly assumed road logistics/Supply. Public provider areas and registers establish no physical electricity, gas, potable-water, wastewater, telecom or facility topology. Non-road values remain municipality-level synthetic indices rather than operator assets, live flows or outage forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0150' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Deventer road-derived lifelines</strong><span>The six A1/N-road links prove transport geometry only and are now restricted to Mobility and explicitly assumed road logistics/Supply. Enexis/Vitens provider context and public registers establish no physical utility topology. Non-road values remain municipality-level synthetic indices and must not be read as operator flows, outages or a T+72 prediction.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM1980' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Dijk en Waard road-derived lifelines</strong><span>The ten NWB links establish road corridors only and are now restricted to Mobility and explicitly assumed road logistics/Supply. Provider territories and public registers establish no physical Liander, PWN, HHNK, wastewater, gas, telecom or facility topology. Non-road values remain municipality-level synthetic indices and must not be read as operator assets, live flows or a T+72 prediction.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0384' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Diemen road-derived lifelines</strong><span>The five A1/A9/Hartveldseweg links are now restricted to Mobility and explicitly assumed road logistics/Supply. Roads establish no physical Liander, drinking-water, AGV, wastewater, gas, telecom or facility topology. Provider polygons and public registers remain context only; non-road values are municipality-level synthetic indices and must not be read as operator routes, live flows, outages or a T+72 prediction.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0221' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Doesburg road-derived lifelines</strong><span>The four N317/N338 links are now restricted to Mobility and explicitly assumed road logistics/Supply. NWB validates roads only; provider areas and public registers establish no physical Liander, Vitens, wastewater, gas, telecom or facility topology. Non-road values remain municipality-level synthetic indices and must not be read as operator routes, outages or T+72 predictions.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM1774' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Dinkelland road-derived lifelines</strong><span>The ten Dutch road links are now restricted to Mobility and explicitly assumed road logistics/Supply. NWB proves transport geometry only; provider areas and public registers establish no physical power, water, wastewater, gas, telecom or facility topology. Cross-border dependencies are absent. Non-road values remain municipality-level synthetic indices, not operator assets, live flows or T+72 forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0222' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Doetinchem road-derived lifelines</strong><span>The ten A18/N-road links are now restricted to Mobility and explicitly assumed road logistics/Supply. NWB validates transport geometry only; Liander stations, provider areas and public registers establish no physical electricity, water, wastewater, gas, telecom or facility topology. Non-road values remain municipality-level synthetic indices, not operator assets, live flows, outages or T+72 forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0505' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Dordrecht physical lifelines</strong><span>NWB A16/N3/N217 edges are now restricted to Mobility and explicitly assumed road logistics/Supply; the N3 closure can affect only those services when a reference date overlaps it. Stedin, Evides, WSHD, antenna, facility and planning records establish context but not physical topology, switching, pressure, quality, backhaul, backup or restoration. Non-road values remain municipality-level synthetic indices, not operator routes, outages or T+72 forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0766' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Dongen physical lifelines</strong><span>NWB roads are now restricted to Mobility and explicitly assumed road logistics/Supply. Enexis, Brabant Water, Brabantse Delta, provider territories and public registers establish responsibility or object context—not physical power, water, wastewater, gas, telecom or facility topology, live capacity, state, backup or restoration. Non-road values remain municipality-level synthetic indices, never operator flows or outage forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM1719' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Drimmelen physical lifelines</strong><span>The five NWB roads are now restricted to Mobility and explicitly assumed road logistics/Supply. Enexis, Brabant Water, Brabantse Delta, provider territories and public registers establish context—not physical utility or facility topology, compatible capacity, switching, pressure, backhaul, backup or restoration. Non-road values remain municipality-level synthetic indices, not operator assets, live flows or T+72 forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0225' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Druten physical lifelines</strong><span>NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Liander, Vitens, Rivierenland, provider territories, antenna and facility registers establish responsibility or object context—not connected power, drinking-water, wastewater, gas, telecom or care topology, compatible capacity, live state, backup or restoration. Non-road values remain municipality-level synthetic indices, never operator flows or outage forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0303' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Dronten physical lifelines</strong><span>NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Liander, Vitens, Zuiderzeeland, provider territories and public registers establish context—not connected utility or care topology, compatible capacity, switching, pressure, backhaul, backup or restoration. Exact non-road percentages remain municipality-level synthetic indices and must not be interpreted as operator assets, live flows, outages or T+72 forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0498' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Drechterland physical lifelines</strong><span>NWB roads—including corrected N307/N506 provenance—are restricted to Mobility and explicitly assumed road logistics/Supply. Liander, PWN, HHNK, provider territories, antenna and facility registers establish context—not connected utility/facility topology, compatible capacity, switching, pressure, quality, backhaul, backup or restoration. Non-road values remain municipality-level synthetic indices, not operator assets or outage forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0385' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Edam-Volendam physical lifelines</strong><span>NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Liander, PWN, HHNK, provider territories, antenna and facility registers establish context—not connected power, drinking-water, wastewater, gas, telecom or care topology, compatible capacity, switching, pressure, quality, backhaul, backup or restoration. Exact service values remain municipality-level synthetic indices, not operator flows or outage forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0226' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Duiven physical lifelines</strong><span>NWB A12 and other road links are restricted to Mobility and explicitly assumed road logistics/Supply. Liander, Vitens, WRIJ, provider territories, antenna, facility and industrial registers establish context—not connected utility or care topology, compatible capacity, switching, pressure, quality, backhaul, backup or restoration. Exact non-road values remain synthetic indices and must not be read as live operator performance.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM1711' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Echt-Susteren physical lifelines</strong><span>Dutch NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Enexis, WML, Limburg water, provider territories and public registers establish responsibility or object context—not connected power, water, wastewater, gas, telecom or facility topology, live capacity, state, backup or restoration. German and Belgian dependencies are absent, so exact non-road values remain synthetic indices rather than operator forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0317' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Eemnes physical lifelines</strong><span>NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Stedin, Vitens, Vallei en Veluwe, provider territories and public registers establish context—not connected power, drinking-water, wastewater, gas, telecom or care topology, compatible capacity, switching, pressure, quality, backup or restoration. Exact non-road values remain municipality-level synthetic indices rather than operator forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM1979' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Eemsdelta physical lifelines</strong><span>Road and rail context does not establish physical Enexis, drinking-water, wastewater, gas, telecom, port, industrial or care topology. Provider areas, water objects, antennas and facilities supply responsibility or object context only—not compatible capacity, switching, pressure, quality, backhaul, backup or restoration. Exact first-72-hour service values remain synthetic indices, not operator flows or outage forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0228' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Ede physical lifelines</strong><span>NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Liander, Vitens, Vallei en Veluwe, provider territories, antenna and facility registers establish context—not connected power, water, wastewater, gas, telecom or care topology, compatible capacity, switching, pressure, quality, backhaul, backup or restoration. Exact service and recovery values remain synthetic indices rather than operator forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0230' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Elburg physical lifelines</strong><span>NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Liander, Vitens, water-board, provider territory, capacity-sample, antenna, education and facility records establish context—not connected power, water, wastewater, gas, telecom or care topology, compatible capacity, switching, pressure, quality, backhaul, backup, crews or restoration. Exact first-72-hour values remain synthetic indices, not operator forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0388' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Enkhuizen physical lifelines</strong><span>The audited Houtribdijk corridor affects only Mobility and explicitly assumed road logistics/Supply. Liander, PWN, water-board, provider territory, capacity-sample, antenna, education and facility records establish context—not connected power, water, wastewater, gas, telecom or care topology, compatible capacity, switching, pressure, quality, backhaul, priority users, backup, crews or restoration. Exact first-72-hour values remain synthetic indices, not operator forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0232' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Epe physical lifelines</strong><span>NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Liander, Vitens, water-board, provider territory, one planning sample, 143 water objects, antenna, education and facility records establish context—not connected power, water, wastewater, gas, telecom or care topology, compatible capacity, switching, pressure, quality, backhaul, backup, priority users, crews or restoration. Exact first-72-hour values remain synthetic indices, not operator forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0114' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Emmen physical lifelines</strong><span>Dutch NWB roads affect only Mobility and explicitly assumed road logistics/Supply. Enexis, WMD, water-board, provider territory, one planning sample, antenna, education and facility records establish context—not connected power, water, wastewater, gas, telecom or care topology, compatible capacity, switching, pressure, quality, backhaul, backup, priority users, crews or restoration. German dependencies are absent; exact first-72-hour values remain synthetic indices, not operator forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0770' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Eersel physical lifelines</strong><span>NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Enexis, Brabant Water, provider territories, water objects, antennas and facilities establish responsibility or register context—not connected power, water, wastewater, gas, telecom or care topology, compatible capacity, switching, pressure, quality, backhaul, backup or restoration. Exact first-72-hour values remain synthetic indices, not operator forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM1903' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Eijsden-Margraten physical lifelines</strong><span>Dutch NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Enexis, WML, Limburg water, provider territories, water objects, antennas, facilities and one capacity-map postcode establish context—not connected utility/care topology, live capacity, state, backup or restoration. Belgian physical and operational dependencies are absent, so exact non-road values remain synthetic indices rather than operator forecasts.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0772' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model boundary · Eindhoven physical lifelines</strong><span>NWB roads are restricted to Mobility and explicitly assumed road logistics/Supply. Enexis, Brabant Water, municipal sewer geometry, provider territories, one capacity sample, antennas and facilities establish context—not connected power, water, wastewater, gas, telecom or care topology, compatible capacity, switching, pressure, quality, backhaul, backup, priority users, crews or restoration. Exact first-72-hour values remain synthetic indices, not operator forecasts.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0505' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Dordrecht water chain</strong><span>The 128 intersecting HWH objects—including RWZI Dordrecht, pumps and weirs—are legal/register context, not connected catchments, flow direction, compatible capacity, present operation, backup or restoration. Evides source and emergency-power guidance does not establish municipal pressure, quality, building booster-pump performance or T+72 availability. Drinking-water quantity/pressure/quality, wastewater and surface-water control remain separate Unknown operational states.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0766' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Dongen water chain</strong><span>Weekly HWH and daily Brabantse Delta object registers improve asset context but do not establish sewer or catchment connectivity, flow direction, compatible capacity, current controls, blockage, emergency power, drinking-water pressure/quality or restoration. Missing objects remain NoData, not absence; exact service percentages remain synthetic until municipality-authorized GWSW and security-reviewed operator topology/state are supplied.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM1719' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Drimmelen water chain</strong><span>HWH IMWA/DAMO and Brabantse Delta registers locate water-system objects but do not establish complete catchments, connectivity, flow direction, compatible capacity, current controls, usable reserve, emergency power or restoration. Partial coverage and empty queries remain Unknown. Drinking water, wastewater and managed surface water must not be collapsed into one observed availability claim.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0225' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Druten water chain</strong><span>Intersecting HWH records—including RWZI Druten, sewer and surface-water pumps and weirs—are register context, not connected catchments, flow direction, compatible capacity, current controls, blockage, emergency power or restoration. Liander/Vitens/WSRL responsibilities do not establish drinking-water pressure or quality. Missing coverage remains Unknown; exact T+72 water and drainage percentages remain synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0303' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Dronten polder drainage chain</strong><span>Zuiderzeeland and HWH register objects improve asset context but do not establish sewer/polder catchments, flow direction, compatible pump capacity, receiving level, current control state, blockage, emergency power or dewatering completion. Drinking water, wastewater and managed surface water remain separate Unknown operational states; precise recovery requires event-time operator state and actions.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0498' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Drechterland polder and water chain</strong><span>HHNK/HWH pumps, weirs, wastewater and level-area records establish object and responsibility context only. They do not supply complete catchments, flow direction, compatible capacity, Markermeer receiving level, current controls, emergency power, drinking-water pressure/quality or restoration. Contributor/query gaps remain NoData, not absence; exact T+72 availability stays synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0385' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Edam-Volendam water and continuity</strong><span>HHNK/HWH pumps, weirs, wastewater and level-area records plus PWN responsibility establish object and mechanism context only. They do not supply connected catchments, flow direction, compatible capacity, Markermeer receiving level, sewer blockage, current controls, emergency power, drinking-water pressure/quality or restoration. Missing coverage remains Unknown; exact first-72-hour availability is synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0226' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Duiven water and dewatering chain</strong><span>WRIJ/HWH records, Gemaal de Liemers and Vitens responsibility establish assets and mechanisms, not connected catchments, flow direction, compatible capacity, current river level, pump/control state, emergency power, drinking-water pressure/quality or restoration. T100/T1000 maps are scenario surfaces rather than live operation. Missing evidence remains Unknown; exact first-72-hour percentages are synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM1711' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Echt-Susteren water chain</strong><span>Limburg/HWH water objects and WML responsibility establish static context, not connected Maas, Geleenbeek, Rode Beek, sewer, wastewater and drinking-water topology, compatible capacity, current controls, receiving levels, quality, backup or restoration. Cross-border catchments and operators are absent. Missing coverage remains Unknown; exact T+72 availability is a synthetic index rather than live service state.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0317' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Eemnes managed-water chain</strong><span>Public pumps, weirs, level areas and provider territories establish asset and responsibility context only. They do not establish connected Eempolder catchments, flow direction, compatible capacity, Eemmeer receiving level, current controls, emergency power, sewer state, drinking-water pressure/quality or restoration. Partial coverage and empty results remain Unknown; exact first-72-hour percentages are synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM1979' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Eemsdelta coastal water chain</strong><span>Water-board objects, defences and provider areas establish static context, not connected Ems-Dollard, polder, sewer, wastewater and drinking-water topology, compatible capacity, dike-door or pump controls, receiving levels, quality, backup or restoration. Missing and security-sensitive coverage remains Unknown; exact coastal T+72 water and drainage percentages are synthetic indices.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0228' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Ede water and drainage chain</strong><span>Vallei en Veluwe/HWH objects and Vitens responsibility establish assets or service areas, not connected terrain, catchments, flow direction, compatible capacity, current pump and sewer controls, receiving levels, emergency power, drinking-water pressure/quality or restoration. Missing coverage remains Unknown; exact first-72-hour availability and recovery are synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0230' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Elburg Randmeren water chain</strong><span>The 57 intersecting public records—Elburg RWZI, two sewer pumps, three surface-water pumps, two sluices and 49 weirs—plus Havensluis and the ’t Harde–Oostendorp project establish objects and mechanisms only. They do not supply connected catchments, flow direction, compatible capacity, receiving levels, current control state, blockage, emergency power, drinking-water pressure/quality or restoration. Missing topology remains Unknown; exact T+72 water and drainage percentages are synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0388' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Enkhuizen water and pump chain</strong><span>The municipal inventory reports 6,990 gullies, 13 main pumps, 94 pressure pumps and separate storm, foul, combined, drainage and pressure networks; the partial national snapshot contains only two sewer pumps plus surface-water assets and Sassluis. Neither supplies a complete connected catchment, flow direction, compatible capacity, receiving level, current controls, blockage, emergency power, drinking-water pressure/quality or restoration. Missing coverage remains Unknown; exact T+72 percentages are synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0232' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Epe brooks and water chain</strong><span>The 143 intersecting HWH records and named brooks, culverts, ponds and pumps establish object and mechanism context only. They do not supply complete catchments, flow direction, compatible capacity, IJssel/Grift receiving levels, current controls, blockage, emergency power, sewer state, drinking-water pressure/quality or restoration. Empty provider and local-observation matches remain Unknown; exact T+72 water and drainage percentages are synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0114' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Emmen peat and water chain</strong><span>The national HWH subset intersects zero local assets, while Vechtstromen’s separate public register returns RWZI Emmen plus 54 main-watercourse and 137 pipeline bounding-box records. Neither result proves absence, complete coverage, connectivity, flow direction, compatible capacity, peat/groundwater state, current controls, emergency power, drinking-water pressure/quality or restoration. Licence and cadence for the separate register also remain unresolved; exact T+72 percentages are synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0770' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Eersel pressure-sewer and water chain</strong><span>The municipal plan describes 483 pump units and 107.2 km of pressure sewer, while the partial HWH snapshot intersects only six sewer pumps, one surface-water pump and 70 weirs. Neither source supplies connected catchments, flow direction, compatible capacity, tested operation, receiving levels, emergency power, drinking-water pressure/quality or restoration. Missing coverage remains Unknown; exact T+72 percentages are synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM1903' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Eijsden-Margraten cross-border water chain</strong><span>The public snapshot contains no in-boundary HWH asset and the reference point returns no drainage-provider polygon. WML, Limburg water, Maas/Noor plans and Dutch/Belgian registers do not establish connected catchments, upstream controls, flow direction, compatible capacity, current pump/sewer state, emergency power, drinking-water pressure/quality or restoration. No match remains Unknown; exact first-72-hour percentages are synthetic.</span></div></div>
        )}
        {(activeLayer === 'water' || activeLayer === 'drainage') && selected.id === 'GM0772' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Service-model gap · Eindhoven sewer and Dommel chain</strong><span>Municipal sewer/runoff/watercourse geometry can improve display context, but diameter zero and empty national HWH/provider subsets remain Unknown rather than absent. Public sources do not establish connected Dommel/Tongelreep/Gender catchments, compatible capacity, current controls, receiving levels, emergency power, drinking-water pressure/quality or restoration. Exact T+72 water and drainage percentages remain synthetic until governed municipality/De Dommel topology and state are supplied.</span></div></div>
        )}
        {activeLayer === 'facilities' && selected.id === 'GM0505' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>First-72-hour action gap · Dordrecht evacuation and refuge</strong><span>Municipal +1.80 and +2.10 m NAP rules, a roughly 48-hour horizontal-evacuation constraint and on-island refuge planning are conditional authority context—not automatic completed actions. Reception sites, crossings, occupants, transport, water, food, medicine, hospital acceptance, staff and backup fuel remain Unknown until an action ledger records authority, trigger, status, issue/valid/expiry time, resources, dependencies and confidence.</span></div></div>
        )}
        {activeLayer === 'facilities' && selected.id === 'GM0503' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Unmodeled hazard scope · Delft RID and technology incidents</strong><span>The current VRH/ANVS planning context includes the TU Delft Reactor Institute and radiological, industrial, nano, biological and defence-technology concerns, but the ten-preset simulator has no radiological or industrial-release model. Register or facility presence does not establish a current incident, source term, affected zone or protective action. Any future exercise requires an authority-approved event and privacy/security-safe response evidence; these hazards must not be silently mapped to wildfire, cyberattack or earthquake.</span></div></div>
        )}
        {(['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as LayerId[]).includes(activeLayer) && selected.id === 'GM0109' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Network-model gap · Coevorden road-derived lifelines</strong><span>The ten NWB links are now restricted to Mobility and explicitly assumed road logistics/Supply. Their IDs and road numbers validate transport geometry only; public provider areas and registers establish no physical Enexis, Rendo, WMD, wastewater, gas, telecom or facility topology. Non-road values remain municipality-level synthetic indices, not operator assets or observed flows.</span></div></div>
        )}
        {activeLayer === 'facilities' && selected.id === 'GM0310' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario-scope gap · Utrecht Science Park Bilthoven</strong><span>The VRU 2023 risk profile identifies USPB as a dated biological/limited-hazardous-substance planning focus with site emergency arrangements. It does not establish a current incident, workforce, inventory, affected zone or protective action, and this simulator has no biological-release preset. REV, KVK and facility points remain non-causal context; any exercise requires a named authority-approved event and privacy/security-safe response evidence.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply' || activeLayer === 'facilities') && selected.id === 'GM0383' && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Access-model gap · De Woude and Akersloot ferries</strong><span>The municipality publishes daily/seasonal service windows, maintenance pauses and SMS outage notices for both ferries, and records specific emergency-service cooperation for island De Woude. No stable machine-readable live-status API or blanket reuse licence was found. The current graph omits these conditional paths, so it cannot establish ferry operation, island access, emergency travel, logistics throughput or a future scenario-time closure.</span></div></div>
        )}
        {publicServiceArea && (
          <div className={`evidence-row${publicServiceArea.providers.length ? '' : ' assumed'}`}>
            {publicServiceArea.providers.length ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
            <div>
              <strong>Public provider territory</strong>
              <span>
                {publicServiceArea.providers.length
                  ? `${publicServiceArea.providers.map((provider) => provider.name).join(', ')} at the municipal reference point`
                  : 'No provider polygon returned at the municipal reference point; this source can be incomplete'}
                {' · '}Stichting Mijn Aansluiting public-domain WMS/WFS · responsibility context only, not physical topology, capacity, coverage quality or live state
              </span>
            </div>
          </div>
        )}
        {activeLayer === 'gas' && publicGtsFlowContext && (
          <div className="evidence-row">
            <CheckCircle2 size={15} />
            <div>
              <strong>Observed GTS transmission flows · ENTSOG</strong>
              <span>
                {numberFormat.format(publicGtsFlowContext.counts.numericDirectionalRecords)} public directional records across {numberFormat.format(publicGtsFlowContext.counts.uniquePointKeys)} point keys for {new Date(publicGtsFlowContext.observationPeriod.from).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })}–{new Date(publicGtsFlowContext.observationPeriod.to).toLocaleTimeString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' })}; {numberFormat.format(publicGtsFlowContext.counts.zeroDirectionalRecords)} reported numeric zero and {numberFormat.format(publicGtsFlowContext.counts.missingOrNaAtObservationHour)} missing/N/A. Largest published directions: {publicGtsFlowContext.records.slice(0, 3).map((record) => `${record.pointLabel} ${record.direction} ${numberFormat.format(record.valueKwhPerHour)} kWh/h`).join(' · ')}. All {numberFormat.format(publicGtsFlowContext.counts.byFlowStatus.Provisional ?? 0)} records are labelled provisional; snapshot was {publicGtsFlowContext.freshness.statusAtRetrieval} ({numberFormat.format(publicGtsFlowContext.freshness.ageMinutesAtRetrieval)} min old at retrieval). Source: ENTSOG Transparency Platform / GTS, extracted {new Date(`${publicGtsFlowContext.source.extractionDate}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium' })}; reuse is governed by ENTSOG terms and no standard open-data licence is claimed. Directions, virtual and aggregated points are non-additive. No point geometry is drawn because the public map coordinates have no documented WGS84 contract. This is observed national transmission context—not municipal distribution pressure, customer supply, outage state, emergency capacity or a T+72 forecast—and it does not affect the simulation.
              </span>
            </div>
          </div>
        )}
        {activeLayer === 'facilities' && publicFacilities && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official governmental-service locations</strong><span>{numberFormat.format(publicFacilities.features.length)} KVK/PDOK public-order, safety and administration register points · coarse context, not emergency role, capacity or live status</span></div></div>
        )}
        {activeLayer === 'facilities' && publicAcuteCare && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official acute-care roles · RIVM 2026</strong><span>{numberFormat.format(publicAcuteCare.counts.emergencyDepartments)} SEH locations: {numberFormat.format(publicAcuteCare.counts.open247)} reported 24/7 and {numberFormat.format(publicAcuteCare.counts.acuteObstetrics)} reported acute obstetrics · questionnaire v{publicAcuteCare.source.version}, published {new Date(`${publicAcuteCare.source.publicationDate}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium' })} · CC0; reported rooms and 2025 visits are dated context, not live occupancy, staffing, diversion, generator endurance or incident capacity</span></div></div>
        )}
        {activeLayer === 'facilities' && publicEducationLocations && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official active education locations · DUO RIO</strong><span>{numberFormat.format(publicEducationLocations.counts.mapScopeLocations)} current location-use records in European Netherlands, including {numberFormat.format(selectedEducationLocations)} assigned to {selected.name}; {numberFormat.format(publicEducationLocations.counts.linkedToCurrentRecognition)} link to a current statutory school/branch recognition and {numberFormat.format(publicEducationLocations.counts.registeredUseOnly)} retain only their registered-use status · snapshot {new Date(`${publicEducationLocations.source.snapshotDate}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium' })}, daily publication · Creative Commons Attribution (publisher version unspecified); a registered address does not establish current attendance, shelter designation, accessibility, capacity, staffing, supplies, generator endurance or live operating status</span></div></div>
        )}
        {activeLayer === 'telecom' && publicAntennaSites && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official antenna installations · RDI Antenneregister</strong><span>{numberFormat.format(publicAntennaSites.counts.antennaInstallations)} public installation sites representing {numberFormat.format(publicAntennaSites.counts.antennasRepresented)} registered antennas, including {numberFormat.format(selectedAntennaSites)} sites assigned to {selected.name}; {numberFormat.format(publicAntennaSites.counts.mobileCommunicationSites)} mobile-communication and {numberFormat.format(publicAntennaSites.counts.fixedLinkSites)} fixed-link sites · deployment snapshot {new Date(publicAntennaSites.source.retrievedAt).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })}; statutory public WFS, reuse licence/version not stated by the service. A registered installation does not establish radio coverage, operator ownership, backhaul, capacity, traffic, power/backup, damage, congestion, availability or restoration.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply') && publicRoadSituations && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Observed NDW road situations</strong><span>{numberFormat.format(publicRoadSituations.features.length)} real, unrestricted DATEX II records intersecting the feed publication time through T+72 · snapshot published {new Date(publicRoadSituations.source.publicationTime).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'medium', timeStyle: 'short' })} · supplier validation varies; display context only and not yet coupled to scenario routes</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply') && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official hazardous-goods route context · REV Basisnet</strong><span>Rijkswaterstaat REV public WMS location layer for Basisnet road, rail and water activities · live tile request, but no fixed cadence, record timestamp or reuse-licence version is stated by the WMS; this is regulated-route context, not a current shipment, incident, restriction, closure or route-capacity input.</span></div></div>
        )}
        {(activeLayer === 'mobility' || activeLayer === 'supply') && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official inland-waterway geometry · RWS FIS-VNDS</strong><span>Live ArcGIS MapServer rendering of the Rijkswaterstaat fairway-line register plus city-scale bridge and lock points · fairway catalogue updated 15 April 2026 · CC0. This is static identity, route and infrastructure context only—not current navigability, water depth, restriction, bridge/lock operation, vessel capacity, throughput, incident state or T+72 availability—and it does not affect the simulation. The separate “vaarwegstatus” codes classify route roles such as main or alternative route; they are not open/closed status. Missing geometry or notices remain Unknown.</span></div></div>
        )}
        {activeLayer === 'power' && publicCapacityContext && selectedCapacitySample && (
          <div className={`evidence-row${selectedCapacitySample.properties.sampleStatus === 'sampled' ? '' : ' assumed'}`}>
            {selectedCapacitySample.properties.sampleStatus === 'sampled'
              ? <CheckCircle2 size={15} />
              : <AlertTriangle size={15} />}
            <div>
              <strong>Official electricity-capacity sample · Netbeheer Nederland</strong>
              <span>
                {selectedCapacitySample.properties.sampleStatus === 'sampled'
                  ? `${selectedCapacitySample.properties.regionalGridOperator ?? 'Operator Unknown'} · service area ${selectedCapacitySample.properties.serviceAreaName ?? 'Unknown'} · withdrawal: ${capacityMw(selectedCapacitySample.properties.existingWithdrawalMw)} present, ${capacityMw(selectedCapacitySample.properties.requiredWithdrawalMw)} required, ${capacityMw(selectedCapacitySample.properties.queueWithdrawalMw)} queued across ${selectedCapacitySample.properties.uniqueRequestsWithdrawal ?? 'Unknown'} requests · sampled at public postcode ${selectedCapacitySample.properties.samplePostcode}`
                  : `No published service-area match at sampled public postcode ${selectedCapacitySample.properties.samplePostcode}; this remains Unknown, not zero capacity or normal service`}
                {' · '}{numberFormat.format(publicCapacityContext.counts.sampledMunicipalities)} of {numberFormat.format(publicCapacityContext.counts.municipalities)} municipalities sampled; one point is not complete municipal coverage
                {' · '}marker colour uses the returned TenneT withdrawal constraint class (sufficient, limited, under investigation or shortage) and halo size uses sampled queue MW
                {' · '}capacity/projects at least quarterly, queues monthly; exact dataset licence identifier not stated beyond the publisher’s open-data declaration
                {' · '}planning context for large-user transport requests only—not outage telemetry, physical topology, present load, switching, emergency reserve, damage, restoration or a T+72 forecast
              </span>
            </div>
          </div>
        )}
        {activeLayer === 'power' && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official Liander + Stedin electricity geometry</strong><span>Liander CC BY 4.0 high-voltage backbone plus scale-aware Liander and Stedin distribution queries · Stedin service metadata states July 2026 data and annual publication, while its public service describes free reuse without naming a standard licence · visible only in the operators’ partial service areas; an empty local result is no-data, never no asset · geometry is not connected operational topology, switching, load, spare capacity, outage or restoration state and does not affect the simulation</span></div></div>
        )}
        {activeLayer === 'power' && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official national overhead high-voltage lines · RIVM</strong><span>12,348 public WFS line records rendered through RIVM's national WMS, including published voltage/class styling · the source explicitly represents the November 2023 situation; catalogue issue date 20 August 2024 and metadata refresh 19 August 2026 do not make the line state current · Public Domain Mark 1.0 · overhead lines only and non-causal; no underground coverage, connected bus topology, ownership, switching, load, outage, damage, capacity, protection or restoration inference</span></div></div>
        )}
        {activeLayer === 'power' && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official Zuid-Holland 2025 electricity-station atlas</strong><span>Provincie Zuid-Holland WMS point layers for published Liander and Stedin station locations · dataset edition 2025, published 24 June 2026 and metadata updated 13 August 2026 · Public Domain Mark 1.0 · Zuid-Holland only and non-causal; a point does not establish connected topology, voltage, load, switching, outage, damage, capacity, backup or restoration state, while empty space outside the province is out of scope rather than “no station”</span></div></div>
        )}
        {activeLayer === 'gas' && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official Liander gas + Stedin replacement context</strong><span>Liander CC BY 4.0 visible-extent pipe geometry and Stedin’s July 2026 public gas-replacement programme at street scale · Stedin states free reuse but no standard licence identifier; its layer is not a complete gas network · partial operator-area context only, with no pressure, flow, valve, capacity, outage or restoration inference and no effect on the simulation</span></div></div>
        )}
        {(activeLayer === 'power' || activeLayer === 'gas') && (
          <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Operational feed gap · Energieonderbrekingen.nl</strong><span>The joint Enexis/Liander/Stedin API schema can provide timestamped electricity and gas disruptions, planned/actual/expected periods, status, cause, estimated affected households and public location geometry. Its GET feed requires approved OAuth client credentials with `read:disruptions`; this deployment has no operator credential and imports no current outage. Missing access is Unknown—not “no outage”—and a current record may affect only a scenario with an explicitly aligned reference time and validity window, never an arbitrary T+72 exercise.</span></div></div>
        )}
        {activeLayer === 'gas' && (
          <div className="evidence-row"><CheckCircle2 size={15} /><div><strong>Official hazardous-substance pipeline context · REV</strong><span>Rijkswaterstaat REV public WMS pipeline-reference layer provides national external-safety context beyond the Liander distribution area · no fixed cadence, feature timestamp or reuse-licence version is stated by the WMS; it does not establish network connectivity, substance at a moment, pressure, flow, valve state, capacity, damage or availability.</span></div></div>
        )}
        <div className="evidence-row assumed"><AlertTriangle size={15} /><div><strong>Scenario operations</strong><span>Failures, service capacity and response are model assumptions</span></div></div>
      </section>

      <div className="inspector-footer">
        <span>{percent(1 - selected.systemPressure)} weighted essential-service availability</span>
        <span>{selected.limitingService} is the limiting service</span>
      </div>
    </aside>
  )
}
