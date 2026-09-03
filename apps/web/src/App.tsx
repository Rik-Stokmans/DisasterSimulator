import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import {
  collectionToMunicipalities,
  simulateCityDetail,
  formatSimulationTime,
  TIMELINE_STEPS,
  type LayerId,
  type MunicipalityCollection,
  type ScenarioConfig,
  type Season,
  type ServiceId,
  type SimulationFrame,
} from '@disaster/sim-core'
import { MapView, type ViewCommand } from './components/MapView'
import { LayerRail } from './components/LayerRail'
import { Timeline } from './components/Timeline'
import { TopBar } from './components/TopBar'
import { Inspector } from './components/Inspector'
import { OperationsBrief } from './components/OperationsBrief'
import { ScenarioControls } from './components/ScenarioControls'
import { layerById } from './config'
import { compactNumber, percent } from './utils'
import {
  loadRegionBundle,
  loadSafetyRegions,
  loadPublicWaterAssets,
  loadPublicFacilities,
  loadPublicAcuteCare,
  loadPublicEducationLocations,
  loadPublicAntennaSites,
  loadPublicRoadSituations,
  loadPublicRadarContext,
  loadPublicPrecipitationProbabilityContext,
  loadPublicWeatherObservations,
  loadPublicWeatherWarnings,
  loadPublicAirQuality,
  loadPublicSeismicEvents,
  loadPublicWaterObservations,
  loadPublicWaterForecasts,
  loadPublicCapacityContext,
  loadPublicGtsFlowContext,
  loadPublicServiceAreaContext,
  loadTransportData,
  loadTransitRoutePart,
  bundleToLocalRegions,
  type MunicipalityRegionBundle,
  type SafetyRegionCollection,
  type TransportData,
  type TransitRouteData,
  type PublicWaterAssetCollection,
  type PublicFacilityCollection,
  type PublicAcuteCareCollection,
  type PublicEducationLocationCollection,
  type PublicAntennaSiteCollection,
  type PublicRoadSituationCollection,
  type PublicRadarContext,
  type PublicPrecipitationProbabilityContext,
  type PublicWeatherObservationCollection,
  type PublicWeatherWarningCollection,
  type PublicAirQualityCollection,
  type PublicSeismicEventCollection,
  type PublicWaterObservationCollection,
  type PublicWaterForecastCollection,
  type PublicCapacityContextCollection,
  type PublicGtsFlowContext,
  type PublicServiceAreaContext,
  type PublicServiceAreaDiscipline,
} from './data'
import { createScenario, seasonLabels } from './scenarios'
import { useSimulationHistory } from './useSimulationHistory'
import { useLiveSimulation } from './useLiveSimulation'

const AnalyticsWorkspace = lazy(() => import('./components/AnalyticsWorkspace'))

const DEFAULT_MUNICIPALITY = 'GM0772'

const interventionLabels = {
  baseline: 'Baseline response',
  'generator-priority': 'Protect critical generators',
  'mutual-aid': 'Early municipal mutual aid',
} as const

function projectFrameLayer(frame: SimulationFrame, layer: LayerId): SimulationFrame {
  const service: ServiceId =
    layer === 'overview' || layer === 'hazard' || layer === 'population'
      ? 'supply'
      : layer
  const routes = frame.routesByService[service] ?? []
  return frame.routes === routes
    ? frame
    : { ...frame, routes }
}

function LoadingScreen({ error }: { error?: string }) {
  return (
    <main className="loading-screen">
      <div className="loading-card panel">
        {error ? <AlertTriangle size={28} /> : <LoaderCircle className="spin" size={28} />}
        <div>
          <strong>{error ? 'Could not load the map data' : 'Preparing the Netherlands simulation'}</strong>
          <span>{error ?? 'Loading official municipalities, road topology, rail, stations and scenario state…'}</span>
        </div>
      </div>
    </main>
  )
}

export default function App() {
  const [collection, setCollection] = useState<MunicipalityCollection | null>(null)
  const [transport, setTransport] = useState<TransportData | null>(null)
  const [transit, setTransit] = useState<Partial<TransitRouteData> | null>(null)
  const [safetyRegions, setSafetyRegions] = useState<SafetyRegionCollection | null>(null)
  const [publicWaterAssets, setPublicWaterAssets] = useState<PublicWaterAssetCollection | null>(null)
  const [publicFacilities, setPublicFacilities] = useState<PublicFacilityCollection | null>(null)
  const [publicAcuteCare, setPublicAcuteCare] = useState<PublicAcuteCareCollection | null>(null)
  const [publicEducationLocations, setPublicEducationLocations] = useState<PublicEducationLocationCollection | null>(null)
  const [publicAntennaSites, setPublicAntennaSites] = useState<PublicAntennaSiteCollection | null>(null)
  const [publicRoadSituations, setPublicRoadSituations] = useState<PublicRoadSituationCollection | null>(null)
  const [publicRoadSituationsError, setPublicRoadSituationsError] = useState<string | null>(null)
  const [roadSituationOverlayRequested, setRoadSituationOverlayRequested] = useState(false)
  const [publicRadarContext, setPublicRadarContext] = useState<PublicRadarContext | null>(null)
  const [publicPrecipitationProbabilityContext, setPublicPrecipitationProbabilityContext] =
    useState<PublicPrecipitationProbabilityContext | null>(null)
  const [publicWeatherObservations, setPublicWeatherObservations] = useState<PublicWeatherObservationCollection | null>(null)
  const [publicWeatherWarnings, setPublicWeatherWarnings] = useState<PublicWeatherWarningCollection | null>(null)
  const [publicAirQuality, setPublicAirQuality] = useState<PublicAirQualityCollection | null>(null)
  const [publicSeismicEvents, setPublicSeismicEvents] = useState<PublicSeismicEventCollection | null>(null)
  const [publicWaterObservations, setPublicWaterObservations] = useState<PublicWaterObservationCollection | null>(null)
  const [publicWaterForecasts, setPublicWaterForecasts] = useState<PublicWaterForecastCollection | null>(null)
  const [publicCapacityContext, setPublicCapacityContext] = useState<PublicCapacityContextCollection | null>(null)
  const [publicGtsFlowContext, setPublicGtsFlowContext] = useState<PublicGtsFlowContext | null>(null)
  const [publicServiceArea, setPublicServiceArea] = useState<PublicServiceAreaContext | null>(null)
  const [regionBundle, setRegionBundle] = useState<MunicipalityRegionBundle | null>(null)
  const regionCache = useRef(new Map<string, MunicipalityRegionBundle>())
  const [loadError, setLoadError] = useState<string>()
  const [activeLayer, setActiveLayer] = useState<LayerId>('overview')
  const [scenario, setScenario] = useState<ScenarioConfig>(() => createScenario('severe-storm'))
  const [compareSeason, setCompareSeason] = useState<Season | 'none'>('none')
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)
  const [selectedMunicipalityId, setSelectedMunicipalityId] = useState(DEFAULT_MUNICIPALITY)
  const [selectedDistrictId, setSelectedDistrictId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'national' | 'city'>('national')
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false)
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const [assumptionsOpen, setAssumptionsOpen] = useState(false)
  const [liveMessage, setLiveMessage] = useState('Simulation ready at T+00.')
  const [intervention, setIntervention] = useState<
    'baseline' | 'generator-priority' | 'mutual-aid'
  >('baseline')
  const [viewCommand, setViewCommand] = useState<ViewCommand>({ nonce: 0, mode: 'national' })
  const openAnalytics = useCallback(() => setAnalyticsOpen(true), [])
  const closeAnalytics = useCallback(() => setAnalyticsOpen(false), [])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/netherlands-municipalities.geojson`, {
        signal: controller.signal,
      }).then((response) => {
        if (!response.ok) throw new Error(`Municipality data returned ${response.status}`)
        return response.json() as Promise<MunicipalityCollection>
      }),
      loadTransportData(controller.signal),
      loadSafetyRegions(controller.signal),
    ])
      .then(([data, transportData, safetyRegionData]) => {
        setCollection(data)
        setTransport(transportData)
        setSafetyRegions(safetyRegionData)
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setLoadError(error.message)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (activeLayer !== 'mobility' && activeLayer !== 'supply') return
    let cancelled = false
    const mergeTransit = <K extends keyof TransitRouteData>(
      kind: K,
      value: TransitRouteData[K],
    ) => {
      if (cancelled) return
      setTransit((current) => ({ ...current, [kind]: value }))
    }
    for (const kind of ['urbanRail', 'railServices', 'ferries'] as const) {
      loadTransitRoutePart(kind)
        .then((value) => mergeTransit(kind, value))
        .catch((error: Error) => console.warn(`Could not load GTFS ${kind} geometry`, error))
    }
    // Bus geometry is by far the largest scheduled-transit asset and its map
    // layer starts at city zoom. Keep national Overview and mobility views lean.
    if (viewMode === 'city') {
      loadTransitRoutePart('bus')
        .then((value) => mergeTransit('bus', value))
        .catch((error: Error) => console.warn('Could not load GTFS bus geometry', error))
    }
    return () => {
      cancelled = true
    }
  }, [activeLayer, viewMode])

  useEffect(() => {
    if (
      ((activeLayer !== 'mobility' && activeLayer !== 'supply') &&
        !roadSituationOverlayRequested)
    ) return
    let cancelled = false
    const refresh = (forceRefresh = false) => {
      setPublicRoadSituationsError(null)
      loadPublicRoadSituations(undefined, forceRefresh)
        .then((situations) => {
          if (!cancelled) setPublicRoadSituations(situations)
        })
        .catch((error: Error) => {
          console.warn('Could not load current NDW road context', error)
          if (!cancelled) setPublicRoadSituationsError(error.message)
        })
    }
    refresh()
    const refreshTimer = window.setInterval(() => refresh(true), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(refreshTimer)
    }
  }, [activeLayer, roadSituationOverlayRequested])

  useEffect(() => {
    const precipitationContext =
      activeLayer === 'hazard' &&
      ['severe-storm', 'pluvial-flood', 'compound'].includes(scenario.disaster)
    if (!precipitationContext || publicRadarContext) return
    let cancelled = false
    loadPublicRadarContext()
      .then((context) => {
        if (!cancelled) setPublicRadarContext(context)
      })
      .catch((error: Error) => console.warn('Could not load KNMI radar context metadata', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, scenario.disaster, publicRadarContext])

  useEffect(() => {
    const precipitationContext =
      activeLayer === 'hazard' &&
      ['severe-storm', 'pluvial-flood', 'compound'].includes(scenario.disaster)
    if (!precipitationContext || publicPrecipitationProbabilityContext) return
    let cancelled = false
    loadPublicPrecipitationProbabilityContext()
      .then((context) => {
        if (!cancelled) setPublicPrecipitationProbabilityContext(context)
      })
      .catch((error: Error) =>
        console.warn('Could not load KNMI precipitation-probability forecast context', error),
      )
    return () => {
      cancelled = true
    }
  }, [activeLayer, scenario.disaster, publicPrecipitationProbabilityContext])

  useEffect(() => {
    const weatherObservationContext =
      activeLayer === 'hazard' &&
      scenario.disaster !== 'cyberattack' &&
      scenario.disaster !== 'earthquake'
    if (!weatherObservationContext || publicWeatherObservations) return
    let cancelled = false
    loadPublicWeatherObservations()
      .then((observations) => {
        if (!cancelled) setPublicWeatherObservations(observations)
      })
      .catch((error: Error) => console.warn('Could not load KNMI station observations', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, scenario.disaster, publicWeatherObservations])

  useEffect(() => {
    const weatherWarningContext =
      activeLayer === 'hazard' &&
      scenario.disaster !== 'cyberattack' &&
      scenario.disaster !== 'earthquake'
    if (!weatherWarningContext || publicWeatherWarnings) return
    let cancelled = false
    loadPublicWeatherWarnings()
      .then((warnings) => {
        if (!cancelled) setPublicWeatherWarnings(warnings)
      })
      .catch((error: Error) => console.warn('Could not load KNMI weather-warning context', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, scenario.disaster, publicWeatherWarnings])

  useEffect(() => {
    const smokeContext =
      activeLayer === 'hazard' &&
      (scenario.disaster === 'wildfire' ||
        (scenario.disaster === 'compound' && scenario.components?.includes('wildfire')))
    if (!smokeContext || publicAirQuality) return
    let cancelled = false
    loadPublicAirQuality()
      .then((observations) => {
        if (!cancelled) setPublicAirQuality(observations)
      })
      .catch((error: Error) => console.warn('Could not load RIVM air-quality context', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, scenario.disaster, scenario.components, publicAirQuality])

  useEffect(() => {
    const seismicContext =
      activeLayer === 'hazard' &&
      (scenario.disaster === 'earthquake' ||
        (scenario.disaster === 'compound' && scenario.components?.includes('earthquake')))
    if (!seismicContext || publicSeismicEvents) return
    let cancelled = false
    loadPublicSeismicEvents()
      .then((events) => {
        if (!cancelled) setPublicSeismicEvents(events)
      })
      .catch((error: Error) => console.warn('Could not load KNMI seismic-event context', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, scenario.disaster, scenario.components, publicSeismicEvents])

  useEffect(() => {
    const waterObservationContext =
      activeLayer === 'water' ||
      (activeLayer === 'hazard' &&
        (scenario.disaster === 'river-flood' || scenario.disaster === 'coastal-flood'))
    if (!waterObservationContext || publicWaterObservations) return
    let cancelled = false
    loadPublicWaterObservations()
      .then((observations) => {
        if (!cancelled) setPublicWaterObservations(observations)
      })
      .catch((error: Error) => console.warn('Could not load Rijkswaterstaat Waterinfo context', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, scenario.disaster, publicWaterObservations])

  useEffect(() => {
    const waterForecastContext =
      activeLayer === 'water' ||
      (activeLayer === 'hazard' &&
        (scenario.disaster === 'river-flood' || scenario.disaster === 'coastal-flood'))
    if (!waterForecastContext || publicWaterForecasts) return
    let cancelled = false
    loadPublicWaterForecasts()
      .then((forecasts) => {
        if (!cancelled) setPublicWaterForecasts(forecasts)
      })
      .catch((error: Error) => console.warn('Could not load Rijkswaterstaat Waterinfo forecasts', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, scenario.disaster, publicWaterForecasts])

  useEffect(() => {
    if (activeLayer !== 'power' || publicCapacityContext) return
    let cancelled = false
    loadPublicCapacityContext()
      .then((context) => {
        if (!cancelled) setPublicCapacityContext(context)
      })
      .catch((error: Error) => console.warn('Could not load NBNL capacity context', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, publicCapacityContext])

  useEffect(() => {
    if (activeLayer !== 'gas' || publicGtsFlowContext) return
    let cancelled = false
    loadPublicGtsFlowContext()
      .then((context) => {
        if (!cancelled) setPublicGtsFlowContext(context)
      })
      .catch((error: Error) => console.warn('Could not load ENTSOG GTS flow context', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, publicGtsFlowContext])

  useEffect(() => {
    if (activeLayer !== 'water' && activeLayer !== 'drainage') return
    let cancelled = false
    loadPublicWaterAssets()
      .then((assets) => {
        if (!cancelled) setPublicWaterAssets(assets)
      })
      .catch((error: Error) => console.warn('Could not load public water-asset context', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer])

  useEffect(() => {
    if (activeLayer !== 'facilities') return
    let cancelled = false
    Promise.all([loadPublicFacilities(), loadPublicAcuteCare(), loadPublicEducationLocations()])
      .then(([facilities, acuteCare, educationLocations]) => {
        if (!cancelled) {
          setPublicFacilities(facilities)
          setPublicAcuteCare(acuteCare)
          setPublicEducationLocations(educationLocations)
        }
      })
      .catch((error: Error) => console.warn('Could not load public facility context', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer])

  useEffect(() => {
    if (activeLayer !== 'telecom' || publicAntennaSites) return
    let cancelled = false
    loadPublicAntennaSites()
      .then((sites) => {
        if (!cancelled) setPublicAntennaSites(sites)
      })
      .catch((error: Error) => console.warn('Could not load RDI antenna-register context', error))
    return () => {
      cancelled = true
    }
  }, [activeLayer, publicAntennaSites])

  useEffect(() => {
    const cached = regionCache.current.get(selectedMunicipalityId)
    if (cached) {
      setRegionBundle(cached)
      return
    }
    setRegionBundle(null)
    const controller = new AbortController()
    loadRegionBundle(selectedMunicipalityId, controller.signal)
      .then((bundle) => {
        regionCache.current.set(selectedMunicipalityId, bundle)
        setRegionBundle(bundle)
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') console.warn(`Could not load ${selectedMunicipalityId} regions`, error)
      })
    return () => controller.abort()
  }, [selectedMunicipalityId])

  const municipalities = useMemo(
    () => (collection ? collectionToMunicipalities(collection).sort((a, b) => a.name.localeCompare(b.name, 'nl')) : []),
    [collection],
  )
  const network = transport?.routes ?? []
  const liveSimulation = useLiveSimulation({
    municipalities,
    network,
    step,
    selectedLayer: activeLayer,
    selectedMunicipalityId,
    scenario,
    intervention,
    compareSeason,
  })
  const simulationHistory = useSimulationHistory({
    enabled: analyticsOpen,
    municipalities,
    network,
    municipalityId: selectedMunicipalityId,
    scenario,
    intervention,
    compareSeason,
  })
  const canonicalFrame = liveSimulation.frame
  const frame = useMemo(
    () => canonicalFrame ? projectFrameLayer(canonicalFrame, activeLayer) : null,
    [canonicalFrame, activeLayer],
  )
  const baselineCanonicalFrame = liveSimulation.referenceFrame
  const baselineFrame = useMemo(
    () => baselineCanonicalFrame ? projectFrameLayer(baselineCanonicalFrame, activeLayer) : null,
    [baselineCanonicalFrame, activeLayer],
  )

  useEffect(() => {
    if (!canonicalFrame?.municipalities.length) return
    const selected = canonicalFrame.municipalities.find(
      (municipality) => municipality.id === selectedMunicipalityId,
    )
    if (!selected) return
    const isCheckpoint = [0, 24, 48, 96, 192, 288].includes(step)
    if (playing && step % 4 !== 0 && !isCheckpoint) return
    const prefix = `${formatSimulationTime(canonicalFrame.step)}. ${layerById[activeLayer].label}. ${selected.name}:`
    if (activeLayer === 'hazard') {
      setLiveMessage(selected.hazard.spatialEvidence === 'unsupported'
        ? `${prefix} local result unavailable; spatial evidence unsupported.`
        : `${prefix} ${percent(selected.hazard.severity)} scenario severity.`)
      return
    }
    if (activeLayer === 'population') {
      setLiveMessage(`${prefix} ${compactNumber.format(selected.affectedPopulation)} of ${compactNumber.format(selected.population)} people under pressure.`)
      return
    }
    const service = activeLayer === 'overview'
      ? selected.services[selected.limitingService]
      : selected.services[activeLayer]
    setLiveMessage(`${prefix} ${service.status}, ${percent(service.availability)} available.`)
  }, [canonicalFrame, selectedMunicipalityId, activeLayer, step, playing])

  useEffect(() => {
    if (!municipalities.length) return
    if (!municipalities.some((city) => city.code === selectedMunicipalityId)) {
      setSelectedMunicipalityId(municipalities[0].code)
    }
  }, [municipalities, selectedMunicipalityId])

  useEffect(() => {
    if (!playing) return
    const frameIntervalMs = Math.max(65, 720 / speed)
    const startedAt = performance.now()
    const startingStep = step
    const interval = window.setInterval(() => {
      const elapsedFrames = Math.floor((performance.now() - startedAt) / frameIntervalMs)
      const nextStep = Math.min(TIMELINE_STEPS - 1, startingStep + elapsedFrames)
      setStep((current) => Math.max(current, nextStep))
      if (nextStep >= TIMELINE_STEPS - 1) setPlaying(false)
    }, Math.min(65, frameIntervalMs))
    return () => window.clearInterval(interval)
  }, [playing, speed])

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          'input, select, textarea, button, [contenteditable="true"], .maplibregl-map',
        )
      ) return
      if (event.key === 'ArrowLeft') setStep((current) => Math.max(0, current - 1))
      if (event.key === 'ArrowRight') setStep((current) => Math.min(TIMELINE_STEPS - 1, current + 1))
      if (event.key === ' ') {
        event.preventDefault()
        setPlaying((current) => !current)
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [])

  const localRegions = useMemo(
    () => regionBundle?.municipalityCode === selectedMunicipalityId
      ? bundleToLocalRegions(regionBundle)
      : [],
    [regionBundle, selectedMunicipalityId],
  )
  const cityDefinition = municipalities.find(
    (municipality) => municipality.code === selectedMunicipalityId,
  )
  useEffect(() => {
    const discipline = ({
      power: 'power',
      gas: 'gas',
      water: 'water',
      drainage: 'drainage',
      telecom: 'telecom',
    } as Partial<Record<LayerId, PublicServiceAreaDiscipline>>)[activeLayer]
    if (!discipline || !cityDefinition) {
      setPublicServiceArea(null)
      return
    }
    setPublicServiceArea(null)
    const controller = new AbortController()
    loadPublicServiceAreaContext(discipline, cityDefinition.coordinates, controller.signal)
      .then(setPublicServiceArea)
      .catch((error: Error) => {
        if (error.name !== 'AbortError') console.warn('Could not identify public provider territory', error)
      })
    return () => controller.abort()
  }, [activeLayer, cityDefinition])
  const cityDetail = useMemo(
    () => viewMode === 'city' && cityDefinition && frame
      ? simulateCityDetail(cityDefinition, frame, activeLayer, localRegions)
      : null,
    [viewMode, cityDefinition, frame, activeLayer, localRegions],
  )

  if (loadError || liveSimulation.error) return <LoadingScreen error={loadError ?? liveSimulation.error} />
  if (!collection || !transport || !safetyRegions || !municipalities.length || !frame || !baselineFrame || !frame.municipalities.length) return <LoadingScreen />

  const selectedDefinition =
    municipalities.find((municipality) => municipality.code === selectedMunicipalityId) ?? municipalities[0]
  const selectedSnapshot =
    frame.municipalities.find((municipality) => municipality.id === selectedDefinition.code) ?? frame.municipalities[0]
  const selectedSafetyRegion = safetyRegions.features.find((feature) =>
    feature.properties.municipalityCodes.includes(selectedDefinition.code),
  )
  const selectedDistrict =
    cityDetail?.districts.find((district) => district.id === selectedDistrictId) ?? null
  const comparisonDelta = frame.national.affectedPopulation - baselineFrame.national.affectedPopulation

  const openMunicipality = (id: string) => {
    setSelectedMunicipalityId(id)
    setSelectedDistrictId(null)
    setViewMode('city')
    setViewCommand((current) => ({ nonce: current.nonce + 1, mode: 'city', municipalityId: id }))
  }

  const openNational = () => {
    setViewMode('national')
    setSelectedDistrictId(null)
    setViewCommand((current) => ({ nonce: current.nonce + 1, mode: 'national' }))
  }

  return (
    <main
      className="app-shell"
      data-simulation-pending={liveSimulation.pending ? 'true' : 'false'}
      data-simulation-step={frame.step}
      data-simulation-duration-ms={liveSimulation.durationMs?.toFixed(1)}
      data-simulation-wire-bytes={liveSimulation.wireBytes ?? undefined}
      data-history-duration-ms={simulationHistory.durationMs?.toFixed(1)}
      data-history-cache-hit={simulationHistory.cacheHit ? 'true' : 'false'}
    >
      <MapView
        collection={collection}
        municipalities={municipalities}
        frame={frame}
        cityDetail={cityDetail}
        regionBundle={regionBundle?.municipalityCode === selectedDefinition.code ? regionBundle : null}
        safetyRegions={safetyRegions}
        transport={transport}
        transit={transit}
        publicWaterAssets={publicWaterAssets}
        publicFacilities={publicFacilities}
        publicAcuteCare={publicAcuteCare}
        publicEducationLocations={publicEducationLocations}
        publicAntennaSites={publicAntennaSites}
        publicRoadSituations={publicRoadSituations}
        publicRoadSituationsError={publicRoadSituationsError}
        onRequestRoadSituations={() => setRoadSituationOverlayRequested(true)}
        publicPrecipitationProbabilityContext={publicPrecipitationProbabilityContext}
        publicWeatherObservations={publicWeatherObservations}
        publicWeatherWarnings={publicWeatherWarnings}
        publicAirQuality={publicAirQuality}
        publicSeismicEvents={publicSeismicEvents}
        publicWaterObservations={publicWaterObservations}
        publicWaterForecasts={publicWaterForecasts}
        publicCapacityContext={publicCapacityContext}
        activeLayer={activeLayer}
        selectedMunicipalityId={selectedDefinition.code}
        selectedDistrictId={selectedDistrictId}
        viewMode={viewMode}
        animationsPaused={analyticsOpen || briefOpen || assumptionsOpen}
        viewCommand={viewCommand}
        onSelectMunicipality={setSelectedMunicipalityId}
        onSelectDistrict={(id) => {
          setSelectedDistrictId(id)
          if (id) setMobileInspectorOpen(true)
        }}
        onViewModeChange={(mode, municipalityId) => {
          setViewMode(mode)
          if (municipalityId) setSelectedMunicipalityId(municipalityId)
        }}
      />

      <TopBar
        municipalities={municipalities}
        selectedMunicipalityId={selectedDefinition.code}
        viewMode={viewMode}
        intervention={intervention}
        analyticsOpen={analyticsOpen}
        briefOpen={briefOpen}
        onMunicipalityChange={openMunicipality}
        onNationalView={openNational}
        onInterventionChange={setIntervention}
        onAnalyticsOpen={openAnalytics}
        onBriefOpen={() => setBriefOpen(true)}
      />

      <ScenarioControls
        scenario={scenario}
        municipalities={municipalities}
        selectedMunicipalityId={selectedDefinition.code}
        compareSeason={compareSeason}
        intervention={intervention}
        onChange={(nextScenario) => {
          setScenario(nextScenario)
          if (compareSeason === nextScenario.season) setCompareSeason('none')
        }}
        onCompareSeasonChange={setCompareSeason}
        onAdvancedOpenChange={setAssumptionsOpen}
      />

      <LayerRail activeLayer={activeLayer} onLayerChange={(layer) => {
        setActiveLayer(layer)
        setSelectedDistrictId(null)
      }} />

      <button
        type="button"
        className="mobile-inspector-toggle panel"
        aria-expanded={mobileInspectorOpen}
        aria-controls="selected-location-details"
        onClick={() => {
          setMobileInspectorOpen((current) => {
            setLiveMessage(`${current ? 'Closed' : 'Opened'} details for ${selectedDefinition.name}.`)
            return !current
          })
        }}
      >
        {mobileInspectorOpen ? 'Close details' : `Details · ${selectedDefinition.name}`}
      </button>

      <section className="national-summary panel" aria-label="National simulation summary">
        <div role="group" aria-label="Modeled people under pressure">
          <span className="summary-label-full">Modeled people under pressure</span>
          <span className="summary-label-short" aria-hidden="true">Pressure</span>
          <strong>{compactNumber.format(frame.national.affectedPopulation)}</strong>
          <small>{activeLayer === 'hazard' && frame.unsupportedHazardMunicipalities?.length
            ? `${frame.unsupportedHazardMunicipalities.length} municipal hazard ${frame.unsupportedHazardMunicipalities.length === 1 ? 'result' : 'results'} unsupported`
            : comparisonDelta !== 0
              ? `${comparisonDelta > 0 ? '+' : ''}${compactNumber.format(comparisonDelta)} vs ${compareSeason !== 'none' ? seasonLabels[compareSeason] : 'baseline'}`
              : 'scenario estimate'}</small>
        </div>
        <div role="group" aria-label="Population-weighted essential-service availability">
          <span className="summary-label-full">Essential services</span>
          <span className="summary-label-short" aria-hidden="true">Services</span>
          <strong>{percent(frame.national.averageAvailability)}</strong>
          <small>population weighted</small>
        </div>
        <div role="group" aria-label="Critical municipalities">
          <span className="summary-label-full">Critical municipalities</span>
          <span className="summary-label-short" aria-hidden="true">Critical</span>
          <strong>{frame.national.criticalMunicipalities}</strong>
          <small>of {municipalities.length}</small>
        </div>
        <div role="group" aria-label="Active route bottlenecks">
          <span className="summary-label-full">Route bottlenecks</span>
          <span className="summary-label-short" aria-hidden="true">Routes</span>
          <strong>{frame.national.activeBottlenecks}</strong>
          <small>active on this map</small>
        </div>
      </section>

      <section className="map-legend panel" aria-label={`${layerById[activeLayer].label} legend`}>
        <div className="legend-heading">
          <span>{layerById[activeLayer].metric}</span>
          <strong>{layerById[activeLayer].unit}</strong>
        </div>
        <div className="legend-items">
          {layerById[activeLayer].legend.map((item) => (
            <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>
          ))}
        </div>
      </section>

      <Inspector
        frame={frame}
        selected={selectedSnapshot}
        cityDetail={cityDetail}
        selectedDistrict={selectedDistrict}
        regionBundle={regionBundle?.municipalityCode === selectedDefinition.code ? regionBundle : null}
        safetyRegionName={selectedSafetyRegion?.properties.name ?? null}
        publicWaterAssets={publicWaterAssets}
        publicFacilities={publicFacilities}
        publicAcuteCare={publicAcuteCare}
        publicEducationLocations={publicEducationLocations}
        publicAntennaSites={publicAntennaSites}
        publicRoadSituations={publicRoadSituations}
        publicRadarContext={publicRadarContext}
        publicPrecipitationProbabilityContext={publicPrecipitationProbabilityContext}
        publicWeatherObservations={publicWeatherObservations}
        publicWeatherWarnings={publicWeatherWarnings}
        publicAirQuality={publicAirQuality}
        publicSeismicEvents={publicSeismicEvents}
        publicWaterObservations={publicWaterObservations}
        publicWaterForecasts={publicWaterForecasts}
        publicCapacityContext={publicCapacityContext}
        publicGtsFlowContext={publicGtsFlowContext}
        publicServiceArea={publicServiceArea}
        activeLayer={activeLayer}
        viewMode={viewMode}
        mobileOpen={mobileInspectorOpen}
        onOpenCity={() => openMunicipality(selectedDefinition.code)}
        onCloseDistrict={() => setSelectedDistrictId(null)}
      />

      <Timeline
        scenario={scenario}
        step={step}
        playing={playing}
        speed={speed}
        onStepChange={setStep}
        onPlayingChange={setPlaying}
        onSpeedChange={setSpeed}
      />

      <OperationsBrief
        open={briefOpen}
        frame={frame}
        referenceFrame={baselineFrame}
        activeLayer={activeLayer}
        selectedMunicipalityId={selectedDefinition.code}
        referenceLabel={compareSeason !== 'none' ? seasonLabels[compareSeason] : 'baseline response'}
        onClose={() => setBriefOpen(false)}
        onStepChange={setStep}
        onSelectMunicipality={openMunicipality}
      />

      {analyticsOpen && (
        <Suspense fallback={<div className="analytics-module-loading panel"><LoaderCircle className="spin" size={22} /> Loading analytics…</div>}>
          <AnalyticsWorkspace
            municipalityId={selectedDefinition.code}
            municipalityName={selectedDefinition.name}
            regionBundle={regionBundle?.municipalityCode === selectedDefinition.code ? regionBundle : null}
            selectedNeighborhoodId={selectedDistrictId}
            activeHour={frame.hour}
            history={simulationHistory.history}
            comparisonHistory={simulationHistory.comparisonHistory}
            primaryLabel={compareSeason !== 'none' ? seasonLabels[scenario.season] : interventionLabels[intervention]}
            comparisonLabel={compareSeason !== 'none' ? seasonLabels[compareSeason] : intervention !== 'baseline' ? 'Baseline response' : undefined}
            loading={simulationHistory.loading}
            error={simulationHistory.error}
            onNeighborhoodChange={setSelectedDistrictId}
            onRetry={simulationHistory.retry}
            onClose={closeAnalytics}
          />
        </Suspense>
      )}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </div>
    </main>
  )
}
