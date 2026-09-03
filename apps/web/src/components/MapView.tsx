import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl'
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { ThreeDTilesLayer } from 'maplibre-gl-3d-tiles'
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Point,
  Polygon,
} from 'geojson'
import {
  circlePolygon,
  distanceKm,
  formatSimulationTime,
  type CityDetailFrame,
  type LayerId,
  type MunicipalityCollection,
  type MunicipalityDefinition,
  type SimulationFrame,
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
  PublicRoadSituationCollection,
  PublicTrafficCameraCollection,
  PublicPrecipitationProbabilityContext,
  PublicWeatherObservationCollection,
  PublicWeatherWarningCollection,
  PublicUtilityCollection,
  PublicWaterAssetCollection,
  PublicWaterForecastCollection,
  PublicWaterObservationCollection,
  PublicCapacityContextCollection,
  TransitRouteData,
  TransportData,
} from '../data'
import {
  isExplicitlyWithdrawnPublicWaterAsset,
  loadPublicPowerBackbone,
  loadPublicTrafficCameras,
  loadPublicUtilityViewport,
  nearestPrecipitationProbabilityCheckpoint,
  nearestWaterForecastCheckpoint,
} from '../data'
import { realisticLightingForFrame } from '../realisticLighting'
import {
  colorForAvailability,
  colorForImpact,
  colorForLayer,
  colorForSeverity,
  metricForLayer,
} from '../utils'

setWorkerUrl(mapWorkerUrl)

const NETHERLANDS_BOUNDS: [[number, number], [number, number]] = [
  [-2, 47],
  [12, 58],
]

const DETAIL_ENTER_ZOOM = 8.45
const DETAIL_EXIT_ZOOM = 7.75
const MOTION_UPDATE_INTERVAL_MS = 80
const OFFICIAL_3D_MIN_ZOOM = 12.5
const PDOK_3D_BUILDINGS_URL =
  'https://api.pdok.nl/kadaster/3d-basisvoorziening/ogc/v1/collections/gebouwen/3dtiles?f=json'
const PDOK_3D_TERRAIN_URL =
  'https://api.pdok.nl/kadaster/3d-basisvoorziening/ogc/v1/collections/terreinen/3dtiles?f=json'
const THREE_DECODER_ROOT = 'https://unpkg.com/three@0.184.0/examples/jsm/libs'

type BasemapMode = 'cartographic' | 'aerial' | 'realistic'
type PerspectiveMode = '2d' | '3d'
type OverlayPreference = 'auto' | 'on' | 'off'
type Official3dState =
  | 'idle'
  | 'waiting-for-city'
  | 'loading'
  | 'ready'
  | 'partial'
  | 'unavailable'

interface MeshoptCapableTilesLayer {
  _tiles?: {
    manager?: {
      getHandler(path: string): {
        setMeshoptDecoder(decoder: object): void
      } | null
    }
  }
}

interface ViewportSynchronizedTilesLayer {
  _renderer?: {
    setViewport(x: number, y: number, width: number, height: number): void
    setScissor(x: number, y: number, width: number, height: number): void
    setScissorTest(enabled: boolean): void
  }
  _tilesCamera?: object
  _tiles?: {
    setResolution(camera: object, width: number, height: number): boolean
  }
}

function attachMeshoptDecoder(layer: ThreeDTilesLayer, decoder: object) {
  // maplibre-gl-3d-tiles configures Draco and KTX2 itself, but v0.5.6 does
  // not yet expose the Meshopt hook used by PDOK's GLBs. Attach it before the
  // layer becomes visible so no compressed tile can race the decoder setup.
  const loader = (layer as unknown as MeshoptCapableTilesLayer)
    ._tiles?.manager?.getHandler('tile.glb')
  if (!loader) throw new Error('The official 3D mesh decoder could not be initialized')
  loader.setMeshoptDecoder(decoder)
}

function synchronizeThreeDTilesViewport(layer: ThreeDTilesLayer) {
  // maplibre-gl-3d-tiles v0.5.6 snapshots the shared canvas dimensions in
  // onAdd. MapLibre owns that canvas and can resize its drawing buffer later,
  // leaving both Three.js's viewport and the tileset's screen-space-error
  // resolution stale. Refresh them immediately before every custom render so
  // resize, DPR, zoom, and pan transitions all use the same live dimensions.
  const render = layer.render.bind(layer)
  layer.render = (gl, args) => {
    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    const internals = layer as unknown as ViewportSynchronizedTilesLayer
    const renderer = internals._renderer
    if (width > 0 && height > 0 && renderer) {
      renderer.setViewport(0, 0, width, height)
      renderer.setScissor(0, 0, width, height)
      renderer.setScissorTest(false)
      if (internals._tiles && internals._tilesCamera) {
        internals._tiles.setResolution(internals._tilesCamera, width, height)
      }
    }
    render(gl, args)
  }
}

const FLOW_DASH_FRAMES = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
] as const

type HazardMotionKind =
  | 'storm'
  | 'rain'
  | 'flood'
  | 'heat'
  | 'winter'
  | 'cyber'
  | 'earthquake'
  | 'fire'
  | 'compound'

interface HazardMotionProfile {
  kind: HazardMotionKind
  color: string
  periodMs: number
  edgeActivity: number
}

const hazardMotionProfiles: Record<HazardMotionKind, HazardMotionProfile> = {
  storm: { kind: 'storm', color: '#75dcff', periodMs: 1_450, edgeActivity: 0.78 },
  rain: { kind: 'rain', color: '#52c8ff', periodMs: 1_700, edgeActivity: 0.92 },
  flood: { kind: 'flood', color: '#36bff4', periodMs: 2_300, edgeActivity: 1 },
  heat: { kind: 'heat', color: '#ff9d5c', periodMs: 3_200, edgeActivity: 0.28 },
  winter: { kind: 'winter', color: '#c5efff', periodMs: 2_600, edgeActivity: 0.52 },
  cyber: { kind: 'cyber', color: '#bd8cff', periodMs: 1_450, edgeActivity: 0.58 },
  earthquake: { kind: 'earthquake', color: '#ffd06b', periodMs: 900, edgeActivity: 0.52 },
  fire: { kind: 'fire', color: '#ff7657', periodMs: 1_150, edgeActivity: 0.72 },
  compound: { kind: 'compound', color: '#d88cff', periodMs: 1_650, edgeActivity: 0.72 },
}

const flowSpeedByLayer: Record<LayerId, number> = {
  overview: 0.72,
  hazard: 0.28,
  power: 1.55,
  water: 0.78,
  drainage: 0.64,
  gas: 0.88,
  telecom: 1.9,
  mobility: 1.2,
  facilities: 0.58,
  population: 0.22,
  supply: 0.92,
}

function hazardMotionProfile(frame: SimulationFrame): HazardMotionProfile {
  switch (frame.scenario.disaster) {
    case 'severe-storm':
      return hazardMotionProfiles.storm
    case 'pluvial-flood':
      return hazardMotionProfiles.rain
    case 'river-flood':
    case 'coastal-flood':
      return hazardMotionProfiles.flood
    case 'heatwave':
      return hazardMotionProfiles.heat
    case 'winter-storm':
      return hazardMotionProfiles.winter
    case 'cyberattack':
      return hazardMotionProfiles.cyber
    case 'earthquake':
      return hazardMotionProfiles.earthquake
    case 'wildfire':
      return hazardMotionProfiles.fire
    case 'compound':
      return hazardMotionProfiles.compound
  }
}

function motionPulse(profile: HazardMotionProfile, phase: number) {
  const wave = (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2
  if (profile.kind === 'cyber') {
    const firstSignal = Math.max(0, 1 - phase * 9)
    const secondSignal = Math.max(0, 1 - Math.abs(phase - 0.28) * 11)
    return Math.max(0.16, firstSignal, secondSignal * 0.72)
  }
  if (profile.kind === 'fire') {
    const flicker = (Math.sin(phase * Math.PI * 6 + 0.7) + 1) / 2
    return 0.2 + wave * 0.52 + flicker * 0.28
  }
  if (profile.kind === 'earthquake') {
    return Math.max(0.12, 1 - phase * 3.6)
  }
  if (profile.kind === 'heat') return 0.28 + wave * 0.62
  return 0.18 + wave * 0.82
}

const mapStyle: StyleSpecification = {
  version: 8,
  state: {
    motionPulse: { default: 0.55 },
    motionSecondary: { default: 0.45 },
    selectionPulse: { default: 0.5 },
    flowDash: { default: [2, 2.5] },
    hazardDash: { default: [2, 2.5] },
    hazardColor: { default: '#61d9ff' },
    hazardActivity: { default: 0 },
    hazardEdgeActivity: { default: 0 },
    flowActivity: { default: 0.7 },
    signalActivity: { default: 1 },
    gatewayActivity: { default: 1 },
  },
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    'pdok-grey': {
      type: 'raster',
      tiles: [
        'https://service.pdok.nl/kadaster/brt-achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution:
        'Kadaster / PDOK · <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxzoom: 19,
    },
    'pdok-aerial': {
      type: 'raster',
      tiles: [
        'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_ortho25/EPSG:3857/{z}/{x}/{y}.jpeg',
      ],
      tileSize: 256,
      attribution:
        'Aerial imagery: <a href="https://www.pdok.nl/ogc-webservices/-/article/pdok-luchtfoto-rgb-open-">Beeldmateriaal / PDOK Luchtfoto RGB</a> · current 25 cm orthophoto · annual context, not live satellite imagery',
      maxzoom: 20,
    },
    'pdok-bgt-detail': {
      type: 'raster',
      tiles: [
        'https://service.pdok.nl/kadaster/bgt/wmts/v1_0/achtergrondvisualisatie/EPSG:3857/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution:
        'Large-scale object geography: <a href="https://api.pdok.nl/lv/bgt/ogc/v1?f=html">Basisregistratie Grootschalige Topografie / PDOK</a> · daily · CC0 1.0',
      minzoom: 17,
      maxzoom: 21,
    },
    'pdok-bag-buildings': {
      type: 'vector',
      tiles: [
        'https://api.pdok.nl/kadaster/bag/ogc/v2/tiles/WebMercatorQuad/{z}/{y}/{x}?f=mvt',
      ],
      attribution:
        'Building register: <a href="https://api.pdok.nl/kadaster/bag/ogc/v2?f=html">Kadaster LV-BAG / PDOK</a> · daily · Public Domain Mark 1.0',
      minzoom: 17,
      maxzoom: 17,
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0d1419' } },
    {
      id: 'pdok-grey',
      type: 'raster',
      source: 'pdok-grey',
      paint: {
        'raster-opacity': 0.58,
        'raster-saturation': -0.85,
        'raster-contrast': 0.18,
        'raster-brightness-min': 0.12,
        'raster-brightness-max': 0.52,
      },
    },
    {
      id: 'pdok-aerial',
      type: 'raster',
      source: 'pdok-aerial',
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': 0.78,
        'raster-saturation': -0.12,
        'raster-contrast': 0.08,
        'raster-brightness-min': 0.08,
        'raster-brightness-max': 0.72,
        'raster-fade-duration': 140,
      },
    },
    {
      id: 'pdok-bgt-detail',
      type: 'raster',
      source: 'pdok-bgt-detail',
      minzoom: 17,
      paint: {
        'raster-opacity': 0.44,
        'raster-saturation': -0.88,
        'raster-contrast': 0.2,
        'raster-brightness-min': 0.08,
        'raster-brightness-max': 0.48,
        'raster-fade-duration': 120,
      },
    },
    {
      id: 'official-bag-building-fill',
      type: 'fill',
      source: 'pdok-bag-buildings',
      'source-layer': 'pand',
      minzoom: 17,
      filter: [
        'match',
        ['get', 'status'],
        ['Pand in gebruik', 'Pand in gebruik (niet ingemeten)', 'Verbouwing pand'],
        true,
        false,
      ],
      layout: { visibility: 'none' },
      paint: {
        'fill-color': '#a9cae8',
        'fill-opacity': 0.14,
      },
    },
    {
      id: 'official-bag-building-outline',
      type: 'line',
      source: 'pdok-bag-buildings',
      'source-layer': 'pand',
      minzoom: 17,
      filter: [
        'match',
        ['get', 'status'],
        ['Pand in gebruik', 'Pand in gebruik (niet ingemeten)', 'Verbouwing pand'],
        true,
        false,
      ],
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#d8ebfb',
        'line-opacity': 0.52,
        'line-width': 0.7,
      },
    },
  ],
}

const emptyCollection: FeatureCollection = { type: 'FeatureCollection', features: [] }

export interface ViewCommand {
  nonce: number
  mode: 'national' | 'city'
  municipalityId?: string
}

interface MapViewProps {
  collection: MunicipalityCollection
  municipalities: MunicipalityDefinition[]
  frame: SimulationFrame
  safetyRegions?: FeatureCollection<Polygon | MultiPolygon> | null
  cityDetail: CityDetailFrame | null
  regionBundle: MunicipalityRegionBundle | null
  transport: TransportData
  transit: Partial<TransitRouteData> | null
  publicWaterAssets: PublicWaterAssetCollection | null
  publicFacilities: PublicFacilityCollection | null
  publicAcuteCare: PublicAcuteCareCollection | null
  publicEducationLocations: PublicEducationLocationCollection | null
  publicAntennaSites: PublicAntennaSiteCollection | null
  publicRoadSituations: PublicRoadSituationCollection | null
  publicRoadSituationsError: string | null
  publicPrecipitationProbabilityContext: PublicPrecipitationProbabilityContext | null
  publicWeatherObservations: PublicWeatherObservationCollection | null
  publicWeatherWarnings: PublicWeatherWarningCollection | null
  publicAirQuality: PublicAirQualityCollection | null
  publicSeismicEvents: PublicSeismicEventCollection | null
  publicWaterObservations: PublicWaterObservationCollection | null
  publicWaterForecasts: PublicWaterForecastCollection | null
  publicCapacityContext: PublicCapacityContextCollection | null
  activeLayer: LayerId
  selectedMunicipalityId: string
  selectedDistrictId: string | null
  viewMode: 'national' | 'city'
  animationsPaused?: boolean
  viewCommand: ViewCommand
  onRequestRoadSituations: () => void
  onSelectMunicipality: (id: string) => void
  onSelectDistrict: (id: string | null) => void
  onViewModeChange: (mode: 'national' | 'city', municipalityId?: string) => void
}

function safetyRegionFeatures(
  safetyRegions: FeatureCollection<Polygon | MultiPolygon> | null | undefined,
  selectedMunicipalityId: string,
): FeatureCollection<Polygon | MultiPolygon> {
  if (!safetyRegions) return emptyCollection as FeatureCollection<Polygon | MultiPolygon>
  return {
    type: 'FeatureCollection',
    features: safetyRegions.features.map((feature, index) => {
      const properties = feature.properties ?? {}
      const municipalityCodes = Array.isArray(properties.municipalityCodes)
        ? properties.municipalityCodes.filter((code): code is string => typeof code === 'string')
        : []
      const code = typeof properties.code === 'string' ? properties.code : `safety-region-${index}`
      const name = typeof properties.name === 'string' ? properties.name : code
      return {
        ...feature,
        id: feature.id ?? code,
        properties: {
          ...properties,
          code,
          name,
          selected: municipalityCodes.includes(selectedMunicipalityId) ? 1 : 0,
        },
      }
    }),
  }
}

function safetyRegionLabelFeatures(
  safetyRegions: FeatureCollection<Polygon | MultiPolygon>,
): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: safetyRegions.features.flatMap((feature) => {
      const properties = feature.properties ?? {}
      const center = properties.center
      if (
        !Array.isArray(center) ||
        center.length < 2 ||
        !Number.isFinite(center[0]) ||
        !Number.isFinite(center[1])
      ) return []
      return [{
        type: 'Feature' as const,
        id: `${String(feature.id ?? properties.code)}-label`,
        geometry: { type: 'Point' as const, coordinates: [Number(center[0]), Number(center[1])] },
        properties,
      }]
    }),
  }
}

function signalForMetric(metric: number, activeLayer: LayerId) {
  if (activeLayer === 'hazard' || activeLayer === 'population') return metric
  return 1 - metric
}

interface DynamicFeatureState {
  id: string
  state: Record<string, string | number>
}

function municipalityGeometry(
  collection: MunicipalityCollection,
): FeatureCollection<Polygon | GeoJSON.MultiPolygon> {
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => ({
      ...feature,
      id: feature.properties.code,
    })),
  }
}

function municipalityFeatureStates(
  collection: MunicipalityCollection,
  frame: SimulationFrame,
  activeLayer: LayerId,
  selectedId: string,
): DynamicFeatureState[] {
  const snapshotById = new Map(frame.municipalities.map((city) => [city.id, city]))
  return collection.features.map((feature) => {
      const city = snapshotById.get(feature.properties.code)
      const rawMetric = city ? metricForLayer(city, activeLayer) : 1
      const metric = Math.round(rawMetric * 200) / 200
      const unsupportedHazard =
        activeLayer === 'hazard' && city?.hazard.spatialEvidence === 'unsupported'
      const impactUnsupported = city?.hazard.spatialEvidence === 'unsupported'
      const affectedShare = city
        ? Math.min(1, city.affectedPopulation / Math.max(1, city.population))
        : 0
      const impactState = impactUnsupported
        ? 'unsupported'
        : city?.status === 'failed' || city?.status === 'critical'
          ? 'critical'
          : city && city.affectedPopulation > 0
            ? 'affected'
            : 'unaffected'
      return {
        id: feature.properties.code,
        state: {
          metric,
          signal: signalForMetric(metric, activeLayer),
          color: unsupportedHazard ? '#7f8c93' : city ? colorForLayer(city, activeLayer) : '#33434a',
          opacity:
            unsupportedHazard
              ? 0.5
              : activeLayer === 'hazard'
              ? 0.18 + metric * 0.54
              : activeLayer === 'population'
                ? 0.2 + metric * 0.48
                : 0.17 + (1 - metric) * 0.44,
          selected: feature.properties.code === selectedId ? 1 : 0,
          status: unsupportedHazard ? 'unknown' : city?.status ?? 'unknown',
          evidence: unsupportedHazard ? 'unsupported' : 'available',
          impactState,
          affectedShare: Math.round(affectedShare * 200) / 200,
          affectedPopulation: city?.affectedPopulation ?? 0,
          powerAvailability: city?.services.power.availability ?? 1,
          powerOutage: city ? 1 - city.services.power.availability : 0,
        },
      }
    })
}

function gatewayGeometryFeatures(
  municipalities: MunicipalityDefinition[],
  selectedId: string,
): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: municipalities.map((municipality) => {
      return {
        type: 'Feature',
        id: municipality.code,
        geometry: { type: 'Point', coordinates: municipality.coordinates },
        properties: {
          code: municipality.code,
          name: municipality.name,
          population: municipality.population ?? 35_000,
          radius: Math.max(4.2, Math.min(12, 3.8 + Math.sqrt((municipality.population ?? 35_000) / 12_000))),
          selected: municipality.code === selectedId ? 1 : 0,
        },
      }
    }),
  }
}

function gatewayFeatureStates(
  frame: SimulationFrame,
  activeLayer: LayerId,
): DynamicFeatureState[] {
  return frame.municipalities.map((city) => {
    const metric = Math.round(metricForLayer(city, activeLayer) * 200) / 200
    const unsupportedHazard =
      activeLayer === 'hazard' && city.hazard.spatialEvidence === 'unsupported'
    const impactUnsupported = city.hazard.spatialEvidence === 'unsupported'
    const impactState = impactUnsupported
      ? 'unsupported'
      : city.status === 'failed' || city.status === 'critical'
        ? 'critical'
        : city.affectedPopulation > 0
          ? 'affected'
          : 'unaffected'
    return {
      id: city.id,
      state: {
        metric,
        signal: signalForMetric(metric, activeLayer),
        color: unsupportedHazard ? '#7f8c93' : colorForLayer(city, activeLayer),
        impactState,
        affectedShare: Math.round(
          Math.min(1, city.affectedPopulation / Math.max(1, city.population)) * 200,
        ) / 200,
        powerAvailability: city.services.power.availability,
        powerOutage: 1 - city.services.power.availability,
      },
    }
  })
}

function routeGeometryFeatures(
  routes: TransportData['routes'],
): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: routes.map((route) => ({
      type: 'Feature',
      id: route.id,
      geometry: { type: 'LineString', coordinates: route.coordinates },
      properties: {
        id: route.id,
        from: route.from,
        to: route.to,
        mode: route.mode,
      },
    })),
  }
}

function routeFeatureStates(
  routeDefinitions: TransportData['routes'],
  frame: SimulationFrame,
  selectedId: string,
  activeLayer: LayerId,
): DynamicFeatureState[] {
  const snapshots = new Map(frame.routes.map((route) => [route.id, route]))
  return routeDefinitions.map((definition) => {
    const route = snapshots.get(definition.id)
    if (!route) {
      const contextOnlyVisible =
        definition.affectsSimulation === false &&
        (activeLayer === 'mobility' || activeLayer === 'supply') &&
        definition.supportedServices?.includes(activeLayer)
      return {
        id: definition.id,
        state: {
          color: contextOnlyVisible ? '#a8b7bb' : '#54d7b0',
          width: contextOnlyVisible
            ? definition.mode === 'ferry'
              ? 1.8
              : definition.mode === 'trunk'
                ? 3.1
                : definition.mode === 'regional'
                  ? 2.2
                  : 1.35
            : 0,
          opacity: contextOnlyVisible
            ? selectedId === definition.from || selectedId === definition.to
              ? 0.9
              : 0.4
            : 0,
          selected:
            contextOnlyVisible &&
            (selectedId === definition.from || selectedId === definition.to)
              ? 1
              : 0,
          motionOpacity: 0,
          flowDirection: 0,
        },
      }
    }
    const opacity =
      activeLayer === 'hazard' || activeLayer === 'population'
        ? 0.18
        : selectedId === route.from || selectedId === route.to
          ? 0.96
          : 0.56
    const motionOpacity = route.flow > 0.05
      ? opacity * Math.max(0.18, Math.min(1, route.utilization))
      : 0
    return {
      id: route.id,
      state: {
        color: route.color,
        width:
          (route.mode === 'trunk' ? 3.1 : route.mode === 'regional' ? 2.2 : route.mode === 'ferry' ? 1.8 : 1.35) +
          (route.bottleneck ? 1.2 : 0),
        opacity,
        selected: selectedId === route.from || selectedId === route.to ? 1 : 0,
        motionOpacity: Math.round(motionOpacity * 50) / 50,
        flowDirection: route.flowDirection,
      },
    }
  })
}

function districtCollections(
  cityDetail: CityDetailFrame | null,
  activeLayer: LayerId,
  regionBundle: MunicipalityRegionBundle | null,
  selectedDistrictId: string | null,
) {
  if (!cityDetail) {
    return {
      areas: emptyCollection as FeatureCollection<Polygon | MultiPolygon>,
      nodes: emptyCollection as FeatureCollection<Point>,
      links: emptyCollection as FeatureCollection<LineString>,
    }
  }
  const unsupportedHazard =
    activeLayer === 'hazard' && cityDetail.municipality.hazard.spatialEvidence === 'unsupported'
  const districtMetric = (district: CityDetailFrame['districts'][number]) => {
    if (activeLayer === 'hazard') return district.hazardSeverity
    if (activeLayer === 'population') {
      return district.affectedPopulation / Math.max(1, district.population)
    }
    return district.availability
  }
  const districtColor = (district: CityDetailFrame['districts'][number]) => {
    if (unsupportedHazard) return '#7f8c93'
    const metric = districtMetric(district)
    if (activeLayer === 'hazard') return colorForSeverity(metric)
    if (activeLayer === 'population') return colorForImpact(metric)
    return colorForAvailability(metric, district.status)
  }
  const geometryById = new Map(
    regionBundle?.neighborhoods.features.map((feature) => [String(feature.id), feature.geometry]) ?? [],
  )
  const areaScale = Math.max(0.7, Math.min(1.6, Math.sqrt(cityDetail.municipality.population / 120_000)))
  const areas: Feature<Polygon | MultiPolygon>[] = cityDetail.districts.map((district) => ({
    type: 'Feature',
    id: `${district.id}-area`,
    geometry:
      district.geometry ??
      geometryById.get(district.id) ??
      circlePolygon(district.coordinates, (district.isHub ? 1.75 : 1.35) * areaScale),
    properties: {
      id: district.id,
      name: district.name,
      color: districtColor(district),
      opacity:
        unsupportedHazard
          ? 0.42
          : activeLayer === 'hazard' || activeLayer === 'population'
          ? 0.2 + districtMetric(district) * 0.38
          : 0.24 + (1 - district.availability) * 0.24,
      availability: district.availability,
      metric: districtMetric(district),
      signal: unsupportedHazard ? 0 : signalForMetric(districtMetric(district), activeLayer),
      evidence: unsupportedHazard ? 'unsupported' : 'available',
      selected: district.id === selectedDistrictId ? 1 : 0,
    },
  }))
  const nodes: Feature<Point>[] = cityDetail.districts.map((district) => ({
    type: 'Feature',
    id: district.id,
    geometry: { type: 'Point', coordinates: district.coordinates },
    properties: {
      id: district.id,
      municipalityId: district.municipalityId,
      name: district.name,
      color: districtColor(district),
      radius: regionBundle ? (district.isHub ? 5.5 : 2.2) : district.isHub ? 12 : 7.5,
      availability: district.availability,
      signal: unsupportedHazard ? 0 : signalForMetric(districtMetric(district), activeLayer),
      selected: district.id === selectedDistrictId ? 1 : 0,
      status: unsupportedHazard ? 'unknown' : district.status,
      evidence: unsupportedHazard ? 'unsupported' : 'available',
      isHub: district.isHub ? 1 : 0,
      population: district.population,
    },
  }))
  // Local allocation links are logical, not physical infrastructure. Once real
  // CBS regions are present they stay in the model/inspector but are not drawn
  // as misleading straight lines over the official road and rail geometry.
  const links: Feature<LineString>[] = (regionBundle ? [] : cityDetail.links).map((link) => ({
    type: 'Feature',
    id: link.id,
    geometry: { type: 'LineString', coordinates: link.coordinates },
    properties: {
      id: link.id,
      color:
        activeLayer === 'hazard' || activeLayer === 'population'
          ? '#8aaeb8'
          : link.bottleneck
            ? '#ff6577'
            : '#7ee4d1',
      width: link.bottleneck ? 4 : 2.5,
      opacity: activeLayer === 'hazard' || activeLayer === 'population' ? 0.3 : 0.84,
      bottleneck: link.bottleneck ? 1 : 0,
      utilization: Math.round(link.utilization * 100),
    },
  }))
  return {
    areas: { type: 'FeatureCollection', features: areas } as FeatureCollection<Polygon | MultiPolygon>,
    nodes: { type: 'FeatureCollection', features: nodes } as FeatureCollection<Point>,
    links: { type: 'FeatureCollection', features: links } as FeatureCollection<LineString>,
  }
}

function placeFeatures(regionBundle: MunicipalityRegionBundle | null): FeatureCollection<Polygon | MultiPolygon> {
  if (!regionBundle) return emptyCollection as FeatureCollection<Polygon | MultiPolygon>
  return {
    type: 'FeatureCollection',
    features: regionBundle.places.features.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        labelLongitude: feature.properties.center?.[0] ?? 0,
        labelLatitude: feature.properties.center?.[1] ?? 0,
      },
    })),
  }
}

function settlementFeatures(
  regionBundle: MunicipalityRegionBundle | null,
): FeatureCollection<Polygon | MultiPolygon> {
  return regionBundle?.settlements ?? (emptyCollection as FeatureCollection<Polygon | MultiPolygon>)
}

function operationalBoundaryFeatures(
  regionBundle: MunicipalityRegionBundle | null,
): FeatureCollection<Polygon | MultiPolygon> {
  return regionBundle?.operationalBoundary ??
    (emptyCollection as FeatureCollection<Polygon | MultiPolygon>)
}

function addSimulationLayers(map: MapLibreMap) {
  map.addSource('municipalities-state', { type: 'geojson', data: emptyCollection })
  map.addSource('official-safety-regions', { type: 'geojson', data: emptyCollection })
  map.addSource('official-safety-region-label-points', { type: 'geojson', data: emptyCollection })
  map.addSource('transport-roads', { type: 'geojson', data: emptyCollection })
  map.addSource('transport-rail', { type: 'geojson', data: emptyCollection })
  map.addSource('transport-stations', { type: 'geojson', data: emptyCollection })
  map.addSource('transit-bus', { type: 'geojson', data: emptyCollection })
  map.addSource('transit-urban-rail', { type: 'geojson', data: emptyCollection })
  map.addSource('transit-rail-services', { type: 'geojson', data: emptyCollection })
  map.addSource('transit-ferries', { type: 'geojson', data: emptyCollection })
  map.addSource('official-road-situations', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Current road situations: <a href="https://opendata.ndw.nu/">Nationaal Dataportaal Wegverkeer</a> · CC0 unless stated · observed snapshot, not a scenario forecast',
  })
  map.addSource('official-traffic-cameras', {
    type: 'geojson',
    data: emptyCollection,
    cluster: true,
    clusterMaxZoom: 12,
    clusterRadius: 38,
    attribution:
      'Traffic-camera adapter: inventory and media state remain separate · no authorized public feed configured · <a href="https://www.rijkswaterstaat.nl/wegen/wegbeheer/onderzoek/verkeersonderzoek/wat-doet-rijkswaterstaat-met-camerabeelden">Rijkswaterstaat media policy</a>',
  })
  map.addSource('official-knmi-weather-observations', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Weather-station observations: <a href="https://dataplatform.knmi.nl/dataset/10-minute-in-situ-meteorological-observations-1-0">KNMI 10-minute in-situ observations</a> · CC BY 4.0 · sparse observed points, not a forecast or interpolated field',
  })
  map.addSource('official-knmi-weather-warnings', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Issued weather warnings: <a href="https://dataplatform.knmi.nl/catalog/datasets/index.html?x-dataset=waarschuwingen_nederland_48h&x-dataset-version=1.0">KNMI 48-hour warnings</a> on CBS 2025 province geometry · CC BY 4.0 · issued context, not a simulation forecast',
  })
  map.addSource('official-water-assets', {
    type: 'geojson',
    data: emptyCollection,
    cluster: true,
    clusterMaxZoom: 9,
    clusterRadius: 42,
    attribution:
      'Water assets: <a href="https://api.pdok.nl/hwh/waterschappen-kunstwerken-imwa/ogc/v2?f=html">Het Waterschapshuis / PDOK</a> · CC BY-SA 4.0',
  })
  map.addSource('official-wastewater-damo-lines', {
    type: 'raster',
    tiles: [
      'https://service.pdok.nl/hwh/waterschappen-waterketen-damo/wms/v1_0?service=WMS&version=1.3.0&request=GetMap&layers=leiding%2Cleidingsegment&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 10,
    maxzoom: 18,
    attribution:
      'Wastewater lines: <a href="https://api.pdok.nl/hwh/waterschappen-waterketen-damo/ogc/v1?f=html">Het Waterschapshuis / PDOK DAMO</a> · CC BY-SA 4.0 · variable completeness',
  })
  map.addSource('official-wastewater-gwsw-lines', {
    type: 'raster',
    tiles: [
      'https://service.pdok.nl/rioned/waterschappen-waterketen-gwsw/wms/v1_0?service=WMS&version=1.3.0&request=GetMap&layers=waterschap_leiding%2Cwaterschap_leidingsegment&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 10,
    maxzoom: 18,
    attribution:
      'Wastewater lines: <a href="https://api.pdok.nl/rioned/waterschappen-waterketen-gwsw/ogc/v1?f=html">RIONED / PDOK GWSW</a> · CC0 · variable completeness',
  })
  map.addSource('official-water-management-areas', {
    type: 'raster',
    tiles: [
      'https://service.pdok.nl/hwh/waterschappen-waterbeheergebieden-imwa/wms/v2_0?service=WMS&version=1.3.0&request=GetMap&layers=afvoergebiedaanvoergebied%2Cpeilgebied&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 7,
    maxzoom: 18,
    attribution:
      'Drainage/supply and level areas: <a href="https://api.pdok.nl/hwh/waterschappen-waterbeheergebieden-imwa/ogc/v1?f=html">Het Waterschapshuis / PDOK IMWA</a> · CC BY-SA 4.0 · provider-supplied context',
  })
  map.addSource('official-bro-groundwater-monitoring', {
    type: 'raster',
    tiles: [
      'https://service.pdok.nl/tno/bro-grondwatermonitoring-in-samenhang-karakteristieken/wms/v1_0?service=WMS&version=1.3.0&request=GetMap&layers=gm_gmw%2Cgm_gld&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 10,
    maxzoom: 18,
    attribution:
      'Groundwater-monitoring registrations: <a href="https://www.pdok.nl/ogc-webservices/-/article/bro-grondwatermonitoring-gm-in-samenhang-karakteristieken">TNO / Basisregistratie Ondergrond via PDOK</a> · CC0 · register characteristics, not current groundwater level',
  })
  map.addSource('official-flood-risk-areas', {
    type: 'raster',
    tiles: [
      'https://service.pdok.nl/rws/overstromingen-risicogebied/wms/v1_0?service=WMS&version=1.3.0&request=GetMap&layers=NZ.RiskZone&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 18,
    attribution:
      'Flood-risk areas: <a href="https://api.pdok.nl/rws/overstromingen-risicogebied/ogc/v1?f=html">Rijkswaterstaat / PDOK · 2018 report, ROR second cycle 2016–2021</a> · CC0 · no planned refresh · risk context, not depth',
  })
  map.addSource('official-liwo-breach-locations', {
    type: 'raster',
    tiles: [
      'https://basisinformatie-overstromingen.nl/geoserver/ows?service=WMS&version=1.3.0&request=GetMap&layers=LIWO_Basis%3Agebiedsindeling_doorbraaklocaties_primair%2CLIWO_Basis%3Agebiedsindeling_doorbraaklocaties_regionaal%2CLIWO_Basis%3Agebiedsindeling_doorbraaklocaties_regionaalwatersysteem%2CLIWO_Basis%3Agebiedsindeling_doorbraaklocaties_buitendijks&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 8,
    maxzoom: 18,
    attribution:
      'Candidate breach locations: <a href="https://iplo.nl/thema/water/applicaties-modellen/berichtgeving-crisismanagement/liwo/">WMCN / LIWO 2025.1.6</a> · public WMS, reuse-licence version not established · scenario-selection context, not an active breach or forecast',
  })
  map.addSource('official-pluvial-depth-scenario', {
    type: 'raster',
    tiles: [
      'https://geo.rijkswaterstaat.nl/services/ogc/gdr/klimaat_effect_atlas/ows?service=WMS&version=1.3.0&request=GetMap&layers=bij_70mm_per_2uur&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 18,
    attribution:
      'Cloudburst depth scenario: <a href="https://data.overheid.nl/dataset/3d9640b8-a6ae-449c-88dd-0ab186094fae">Rijkswaterstaat / Klimaateffectatlas · 70 mm in 2 hours</a> · CC0 · official national scenario context, not a current observation or forecast',
  })
  map.addSource('official-ahn-terrain', {
    type: 'raster',
    tiles: [
      'https://service.pdok.nl/rws/ahn/wms/v1_0?service=WMS&version=1.3.0&request=GetMap&layers=dtm_05m&styles=default&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 10,
    maxzoom: 18,
    attribution:
      'Terrain elevation: <a href="https://data.overheid.nl/dataset/47567-actueel-hoogtebestand-nederland--ahn--dtm">Rijkswaterstaat / AHN4 DTM 0.5 m</a> · acquired 2020–2022 · CC0 · terrain context, not water depth or live state',
  })
  map.addSource('official-rev-attention-areas', {
    type: 'raster',
    tiles: [
      'https://rev-portaal.nl/geoserver/wms?service=WMS&version=1.3.0&request=GetMap&layers=rev_public%3Aqs_aandachtsgebieden&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 18,
    attribution:
      'External-safety attention areas: <a href="https://www.registerexterneveiligheid.nl/kaartbeelden">Rijkswaterstaat / Register Externe Veiligheidsrisico\'s</a> · public WMS; cadence and reuse terms not stated by the service · register context, not an incident plume',
  })
  map.addSource('official-rev-risk-activities', {
    type: 'raster',
    tiles: [
      'https://rev-portaal.nl/geoserver/wms?service=WMS&version=1.3.0&request=GetMap&layers=rev_public%3Aqs_ev_activiteiten&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 18,
    attribution:
      'Regulated external-safety activities: <a href="https://www.registerexterneveiligheid.nl/kaartbeelden">Rijkswaterstaat / Register Externe Veiligheidsrisico\'s</a> · public WMS; cadence and reuse terms not stated by the service · location context, not live status',
  })
  map.addSource('official-rev-pipelines', {
    type: 'raster',
    tiles: [
      'https://rev-portaal.nl/geoserver/wms?service=WMS&version=1.3.0&request=GetMap&layers=rev_public%3Abl_buisleidingreferentie&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 18,
    attribution:
      'Hazardous-substance pipeline references: <a href="https://www.registerexterneveiligheid.nl/kaartbeelden">Rijkswaterstaat / Register Externe Veiligheidsrisico\'s</a> · public WMS; cadence and reuse terms not stated by the service · not gas flow or availability',
  })
  map.addSource('official-rev-basisnet', {
    type: 'raster',
    tiles: [
      'https://rev-portaal.nl/geoserver/wms?service=WMS&version=1.3.0&request=GetMap&layers=rev_public%3Abn_locatie_activiteiten&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 18,
    attribution:
      'Basisnet hazardous-goods transport locations: <a href="https://www.registerexterneveiligheid.nl/kaartbeelden">Rijkswaterstaat / Register Externe Veiligheidsrisico\'s</a> · public WMS; cadence and reuse terms not stated by the service · not a current closure',
  })
  map.addSource('official-fis-waterways', {
    type: 'raster',
    tiles: [
      'https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/fis_vnds/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256%2C256&format=png32&transparent=true&layers=show%3A55%2C3%2C19&f=image',
    ],
    tileSize: 256,
    minzoom: 6,
    maxzoom: 18,
    attribution:
      'Inland waterways, bridges and locks: <a href="https://data.overheid.nl/dataset/42643-fis-vnds---fairway---lijnen">Rijkswaterstaat FIS-VNDS</a> · catalogue updated 15 April 2026 · CC0 · static network/register context, not current navigability or operating state',
  })
  map.addSource('official-combustible-nature-areas', {
    type: 'raster',
    tiles: [
      'https://servicespub.risicokaart.nl/geoserver/ISOR_RK/wms?service=WMS&version=1.3.0&request=GetMap&layers=isor_brandbaar_natuurgebied&styles=Natuurbrandvlak&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 18,
    attribution:
      'Combustible nature areas: <a href="https://data.overheid.nl/dataset/13235-natuurbranden">Interprovinciaal Overleg / Risicokaart</a> · Public Domain · metadata updated 19 February 2026 · eligibility context, not an incident perimeter',
  })
  map.addSource('official-agricultural-parcels', {
    type: 'raster',
    tiles: [
      'https://service.pdok.nl/rvo/gewaspercelen/wms/v1_0?service=WMS&version=1.3.0&request=GetMap&layers=BrpGewas&styles=Default&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 12,
    maxzoom: 18,
    attribution:
      'Agricultural parcels/crop declaration: <a href="https://www.pdok.nl/ogc-webservices/-/article/basisregistratie-gewaspercelen-brp-">RVO Basisregistratie Gewaspercelen via PDOK</a> · 2025 definitive annual fixture · WMS capabilities CC0 / dataset metadata Public Domain Mark 1.0 · parcel context, not current crop condition or supply',
  })
  map.addSource('official-water-defences', {
    type: 'raster',
    tiles: [
      'https://service.pdok.nl/hwh/waterschappen-keringen-imwa/wms/v3_0?service=WMS&version=1.3.0&request=GetMap&layers=waterkering&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 11,
    maxzoom: 18,
    attribution:
      'Water defences: <a href="https://api.pdok.nl/hwh/waterschappen-keringen-imwa/ogc/v1?f=html">Het Waterschapshuis / PDOK IMWA</a> · CC BY-SA 4.0 · register context, not assumed performance',
  })
  map.addSource('official-knmi-radar', {
    type: 'image',
    url: `${import.meta.env.BASE_URL}data/public-context/knmi-radar.png`,
    coordinates: [
      [3.2, 53.7],
      [7.3, 53.7],
      [7.3, 50.7],
      [3.2, 50.7],
    ],
  })
  for (const leadHours of [1, 3, 6] as const) {
    map.addSource(`official-knmi-precipitation-probability-t-plus-${leadHours}`, {
      type: 'image',
      url: `${import.meta.env.BASE_URL}data/public-context/knmi-precipitation-probability-t-plus-${leadHours}.png`,
      coordinates: [
        [3.2, 53.7],
        [7.3, 53.7],
        [7.3, 50.7],
        [3.2, 50.7],
      ],
    })
  }
  map.addSource('official-air-quality', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Air-quality observations: <a href="https://www.luchtmeetnet.nl/">RIVM Luchtmeetnet</a> · indicative hourly station readings; no standard reuse licence stated and no rights may be derived · not a continuous surface, plume or forecast',
  })
  map.addSource('official-knmi-seismic-events', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Seismic-event source parameters: <a href="https://rdsa.knmi.nl/fdsnws/event/1/">KNMI FDSN Event</a> · RDSA default CC BY 4.0 where no dataset-specific terms apply · observed catalogue points, not ground motion, damage or forecast',
  })
  map.addSource('official-waterinfo-observations', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Water level and discharge observations: <a href="https://waterinfo.rws.nl/">Rijkswaterstaat Waterinfo</a> · CC0 unless stated otherwise · timestamped station context, not a hydraulic surface or scenario forecast',
  })
  map.addSource('official-waterinfo-forecast-water-levels', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Issued water-level guidance: <a href="https://data.overheid.nl/dataset/79082-verwachting-waterstanden-en-afvoeren">Rijkswaterstaat Waterinfo forecasts</a> · CC0 1.0 as catalogued; verify component exceptions · rolling point forecast context, not an inundation surface, defence state or scenario impact',
  })
  map.addSource('official-waterinfo-forecast-discharges', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Issued discharge guidance: <a href="https://data.overheid.nl/dataset/79082-verwachting-waterstanden-en-afvoeren">Rijkswaterstaat Waterinfo forecasts</a> · CC0 1.0 as catalogued; verify component exceptions · rolling point forecast context, not a municipal prediction or causal simulation input',
  })
  map.addSource('official-government-services', {
    type: 'geojson',
    data: emptyCollection,
    cluster: true,
    clusterMaxZoom: 9,
    clusterRadius: 44,
    attribution:
      'Governmental services: <a href="https://api.pdok.nl/kvk/overheidsdiensten-geharmoniseerd/ogc/v1?f=html">KVK / PDOK</a> · Public Domain Mark 1.0',
  })
  map.addSource('official-education-locations', {
    type: 'geojson',
    data: emptyCollection,
    cluster: true,
    clusterMaxZoom: 11,
    clusterRadius: 38,
    attribution:
      'Education locations: <a href="https://onderwijsdata.duo.nl/dataset/c416acd1-e083-4ec6-9203-3b20f98fe143">DUO RIO</a> · Creative Commons Attribution (publisher does not specify version) · registered use, not shelter or live occupancy',
  })
  map.addSource('official-antenna-sites', {
    type: 'geojson',
    data: emptyCollection,
    cluster: true,
    clusterMaxZoom: 11,
    clusterRadius: 38,
    attribution:
      'Antenna installations: <a href="https://antenneregister.nl/">RDI / Antennebureau Antenneregister</a> · statutory public register; WFS reuse licence not stated · installation context, not coverage or live availability',
  })
  map.addSource('official-acute-care', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Acute-care roles: <a href="https://datacatalogus.rivm.nl/dataset.xhtml?persistentId=doi:10.21945/8E767B2D-9CED-4A85-A95D-3AC1A608C663">RIVM questionnaire 2026 v1.1</a> · CC0 · dated context, not live capacity',
  })
  map.addSource('official-power-backbone', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Electricity geometry: <a href="https://www.liander.nl/over-ons/open-data">Liander / Alliander</a> · CC BY 4.0 · partial service area',
  })
  map.addSource('official-nbnl-capacity-samples', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Electricity capacity planning: <a href="https://www.netbeheernederland.nl/netcapaciteit-en-flexibiliteit/capaciteitskaart">Netbeheer Nederland</a> · open-data statement; exact dataset licence identifier not stated · sampled context only',
  })
  map.addSource('official-power-detail', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Electricity geometry: <a href="https://www.liander.nl/over-ons/open-data">Liander / Alliander</a> (CC BY 4.0) and <a href="https://www.stedin.net/zakelijk/open-data/liggingsdata-kabels-en-leidingen">Stedin Netbeheer</a> (free reuse statement; exact standard licence identifier not stated) · partial service areas',
  })
  map.addSource('official-national-overhead-high-voltage-lines', {
    type: 'raster',
    tiles: [
      'https://data.rivm.nl/geo/nl/wms?service=WMS&version=1.3.0&request=GetMap&layers=netkaart_actuele_versie_atlas_rivm&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 18,
    attribution:
      'Overhead high-voltage lines: <a href="https://data.overheid.nl/dataset/83491-bovengrondse-hoogspanningslijnen-met-rekenafstanden">RIVM public national grid map</a> · November 2023 situation · Public Domain Mark 1.0 · dated line/register context, not live or connected operational topology',
  })
  map.addSource('official-zuid-holland-electricity-stations', {
    type: 'raster',
    tiles: [
      'https://geodata.zuid-holland.nl/geoserver/energie/wms?service=WMS&version=1.3.0&request=GetMap&layers=energie%3ARV_ET_ELEKTRICITEITSSTATIONS_LIANDER_PZH_2025_PUNTLOCATIES%2Cenergie%3ARV_ET_ELEKTRICITEITSSTATIONS_STEDIN_PZH_2025_PUNTLOCATIES&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}',
    ],
    tileSize: 256,
    minzoom: 7,
    maxzoom: 18,
    attribution:
      'Electricity-station atlas: <a href="https://opendata.zuid-holland.nl/geonetwork/srv/dut/catalog.search#/metadata/b9a933f4-ab25-46e2-a7e4-afb73f1039b9">Provincie Zuid-Holland / Liander + Stedin 2025</a> · Public Domain Mark 1.0 · province-scoped register context, not connected topology or live state',
  })
  map.addSource('official-gas-detail', {
    type: 'geojson',
    data: emptyCollection,
    attribution:
      'Gas context: <a href="https://www.liander.nl/over-ons/open-data">Liander / Alliander</a> pipe geometry (CC BY 4.0) and <a href="https://www.stedin.net/zakelijk/open-data/liggingsdata-kabels-en-leidingen">Stedin Netbeheer</a> gas-replacement programme (free reuse statement; exact standard licence identifier not stated) · partial service areas',
  })
  const providerAreaLayers = {
    power: 'netbeheergebieden_elektriciteit',
    gas: 'netbeheergebieden_gas',
    water: 'netbeheergebieden_water',
    drainage: 'netbeheergebieden_riolering',
    telecom: 'netbeheergebieden_media',
  } as const
  for (const [discipline, layer] of Object.entries(providerAreaLayers)) {
    map.addSource(`official-provider-area-${discipline}`, {
      type: 'raster',
      tiles: [
        `https://public.geodata.mijnaansluiting.nl/geoserver/mijnaansluiting_open/ows?service=WMS&version=1.3.0&request=GetMap&layers=mijnaansluiting_open%3A${layer}&styles=&format=image%2Fpng&transparent=true&crs=EPSG%3A3857&width=256&height=256&bbox={bbox-epsg-3857}`,
      ],
      tileSize: 256,
      minzoom: 5,
      maxzoom: 18,
      attribution:
        'Provider territories: <a href="https://wiki.service.mijnaansluiting.nl/wiki/spaces/Wiki/pages/693731329">Stichting Mijn Aansluiting</a> · Public Domain · responsibility context, not network topology',
    })
  }
  map.addSource('national-routes', { type: 'geojson', data: emptyCollection })
  map.addSource('city-gateways', { type: 'geojson', data: emptyCollection })
  map.addSource('city-operational-boundary', { type: 'geojson', data: emptyCollection })
  map.addSource('city-areas', { type: 'geojson', data: emptyCollection })
  map.addSource('city-places', { type: 'geojson', data: emptyCollection })
  map.addSource('city-settlements', { type: 'geojson', data: emptyCollection })
  map.addSource('city-links', { type: 'geojson', data: emptyCollection })
  map.addSource('city-nodes', { type: 'geojson', data: emptyCollection })

  map.addLayer({
    id: 'municipality-fill',
    type: 'fill',
    source: 'municipalities-state',
    paint: {
      'fill-color': ['coalesce', ['feature-state', 'color'], '#33434a'],
      'fill-opacity': ['coalesce', ['feature-state', 'opacity'], 0.2],
    },
  })
  map.addLayer({
    id: 'realistic-power-outage-fill',
    type: 'fill',
    source: 'municipalities-state',
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#01050a',
      'fill-opacity': [
        '*',
        ['coalesce', ['feature-state', 'powerOutage'], 0],
        0.7,
      ],
    },
  })
  map.addLayer({
    id: 'realistic-power-outage-outline',
    type: 'line',
    source: 'municipalities-state',
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#18232d',
      'line-opacity': [
        '*',
        ['coalesce', ['feature-state', 'powerOutage'], 0],
        0.72,
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 12, 3.2],
    },
  })
  map.addLayer({
    id: 'hazard-area-pulse',
    type: 'fill',
    source: 'municipalities-state',
    paint: {
      'fill-color': ['global-state', 'hazardColor'],
      'fill-opacity': [
        '*',
        ['global-state', 'hazardActivity'],
        ['coalesce', ['feature-state', 'metric'], 0],
        ['+', 0.035, ['*', 0.13, ['global-state', 'motionPulse']]],
      ],
    },
  })
  map.addLayer({
    id: 'official-knmi-warning-fill',
    type: 'fill',
    source: 'official-knmi-weather-warnings',
    filter: ['>', ['get', 'warningLevel'], 0],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': [
        'match',
        ['get', 'warningLevel'],
        3, '#ff3b4f',
        2, '#ff9f43',
        1, '#ffd84a',
        '#77858c',
      ],
      'fill-opacity': 0.16,
    },
  })
  map.addLayer({
    id: 'official-knmi-warning-outline',
    type: 'line',
    source: 'official-knmi-weather-warnings',
    filter: ['>', ['get', 'warningLevel'], 0],
    layout: { visibility: 'none' },
    paint: {
      'line-color': [
        'match',
        ['get', 'warningLevel'],
        3, '#ff5062',
        2, '#ffad52',
        1, '#ffe36d',
        '#77858c',
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.2, 9, 4.2],
      'line-opacity': 0.92,
      'line-dasharray': [2.4, 1.2],
    },
  })
  map.addLayer({
    id: 'official-knmi-weather-wind-points',
    type: 'circle',
    source: 'official-knmi-weather-observations',
    filter: ['all', ['has', 'windGustMs'], ['!=', ['get', 'windGustMs'], null]],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': [
        'interpolate', ['linear'], ['to-number', ['get', 'windGustMs'], 0],
        0, '#63c9ef',
        12, '#ffd45c',
        20, '#ff8654',
        30, '#ff4f68',
      ],
      'circle-radius': [
        'interpolate', ['linear'], ['to-number', ['get', 'windGustMs'], 0],
        0, 3.5,
        15, 7,
        30, 11,
      ],
      'circle-opacity': 0.9,
      'circle-stroke-color': '#eefaff',
      'circle-stroke-width': 1.2,
    },
  })
  map.addLayer({
    id: 'official-knmi-weather-wind-labels',
    type: 'symbol',
    source: 'official-knmi-weather-observations',
    minzoom: 6.8,
    filter: ['all', ['has', 'windGustMs'], ['!=', ['get', 'windGustMs'], null]],
    layout: {
      visibility: 'none',
      'text-field': ['format', ['get', 'stationName'], {}, '\n', {}, ['get', 'windLabel'], {}],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-offset': [0, 1.4],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#eefaff',
      'text-halo-color': '#14242c',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-knmi-weather-rain-points',
    type: 'circle',
    source: 'official-knmi-weather-observations',
    filter: ['all', ['has', 'rainfallLastHourMm'], ['!=', ['get', 'rainfallLastHourMm'], null]],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': [
        'interpolate', ['linear'], ['to-number', ['get', 'rainfallLastHourMm'], 0],
        0, '#688a97',
        2, '#53c8f3',
        10, '#477df4',
        30, '#b45fea',
      ],
      'circle-radius': [
        'interpolate', ['linear'], ['to-number', ['get', 'rainfallLastHourMm'], 0],
        0, 3.5,
        5, 7,
        30, 11,
      ],
      'circle-opacity': 0.9,
      'circle-stroke-color': '#e9f8ff',
      'circle-stroke-width': 1.2,
    },
  })
  map.addLayer({
    id: 'official-knmi-weather-rain-labels',
    type: 'symbol',
    source: 'official-knmi-weather-observations',
    minzoom: 6.8,
    filter: ['all', ['has', 'rainfallLastHourMm'], ['!=', ['get', 'rainfallLastHourMm'], null]],
    layout: {
      visibility: 'none',
      'text-field': ['format', ['get', 'stationName'], {}, '\n', {}, ['get', 'rainLabel'], {}],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-offset': [0, 1.4],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#eaf8ff',
      'text-halo-color': '#14242c',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-knmi-weather-temperature-points',
    type: 'circle',
    source: 'official-knmi-weather-observations',
    filter: ['all', ['has', 'airTemperatureC'], ['!=', ['get', 'airTemperatureC'], null]],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': [
        'interpolate', ['linear'], ['to-number', ['get', 'airTemperatureC'], 0],
        -10, '#8adfff',
        10, '#79ccee',
        25, '#ffd35a',
        35, '#ff654f',
        45, '#d73455',
      ],
      'circle-radius': [
        'interpolate', ['linear'], ['to-number', ['get', 'airTemperatureC'], 0],
        -10, 4,
        25, 6.5,
        45, 10,
      ],
      'circle-opacity': 0.9,
      'circle-stroke-color': '#fff7e8',
      'circle-stroke-width': 1.2,
    },
  })
  map.addLayer({
    id: 'official-knmi-weather-temperature-labels',
    type: 'symbol',
    source: 'official-knmi-weather-observations',
    minzoom: 6.8,
    filter: ['all', ['has', 'airTemperatureC'], ['!=', ['get', 'airTemperatureC'], null]],
    layout: {
      visibility: 'none',
      'text-field': ['format', ['get', 'stationName'], {}, '\n', {}, ['get', 'temperatureLabel'], {}],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-offset': [0, 1.4],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#fff6e7',
      'text-halo-color': '#231c18',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'municipality-outline',
    type: 'line',
    source: 'municipalities-state',
    paint: {
      'line-color': [
        'case',
        ['==', ['feature-state', 'selected'], 1],
        '#f5fbff',
        'rgba(164, 202, 215, 0.38)',
      ],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        ['case', ['==', ['feature-state', 'selected'], 1], 1.8, 0.45],
        10,
        ['case', ['==', ['feature-state', 'selected'], 1], 4.2, 1.35],
      ],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.65, 9, 0.95],
    },
  })
  map.addLayer({
    id: 'municipality-status-outline',
    type: 'line',
    source: 'municipalities-state',
    paint: {
      // A dashed, progressively heavier boundary makes degraded/critical
      // status distinguishable without relying on the thematic fill color.
      'line-color': '#f8f4e8',
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        [
          'match',
          ['feature-state', 'status'],
          'failed', 2.4,
          'critical', 1.9,
          'degraded', 1.25,
          0,
        ],
        10,
        [
          'match',
          ['feature-state', 'status'],
          'failed', 5,
          'critical', 4,
          'degraded', 2.8,
          0,
        ],
      ],
      'line-opacity': [
        'match',
        ['feature-state', 'status'],
        'failed', 0.95,
        'critical', 0.82,
        'degraded', 0.58,
        0,
      ],
      'line-dasharray': [1.25, 1.5],
    },
  })
  map.addLayer({
    id: 'affected-region-overlay-fill',
    type: 'fill',
    source: 'municipalities-state',
    layout: { visibility: 'none' },
    paint: {
      'fill-color': [
        'match',
        ['feature-state', 'impactState'],
        'critical', '#ff4f68',
        'affected', '#ffad4d',
        'unsupported', '#9aa8ad',
        'rgba(0, 0, 0, 0)',
      ],
      'fill-opacity': [
        'match',
        ['feature-state', 'impactState'],
        'critical', ['+', 0.16, ['*', 0.08, ['global-state', 'selectionPulse']]],
        'affected', 0.12,
        'unsupported', 0.025,
        0,
      ],
    },
  })
  map.addLayer({
    id: 'affected-region-overlay-halo',
    type: 'line',
    source: 'municipalities-state',
    layout: { visibility: 'none' },
    paint: {
      'line-color': [
        'match',
        ['feature-state', 'impactState'],
        'critical', '#ff4f68',
        'affected', '#ffad4d',
        'unsupported', '#9aa8ad',
        'rgba(0, 0, 0, 0)',
      ],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        [
          'match',
          ['feature-state', 'impactState'],
          'critical', 5,
          'affected', 3.2,
          'unsupported', 2.1,
          0,
        ],
        11,
        [
          'match',
          ['feature-state', 'impactState'],
          'critical', 10,
          'affected', 6.5,
          'unsupported', 4,
          0,
        ],
      ],
      'line-opacity': [
        'match',
        ['feature-state', 'impactState'],
        'critical', 0.28,
        'affected', 0.18,
        'unsupported', 0.14,
        0,
      ],
      'line-blur': 3,
    },
  })
  map.addLayer({
    id: 'affected-region-overlay-outline',
    type: 'line',
    source: 'municipalities-state',
    layout: { visibility: 'none' },
    paint: {
      'line-color': [
        'match',
        ['feature-state', 'impactState'],
        'critical', '#ff6f82',
        'affected', '#ffc067',
        'unsupported', '#afbbc0',
        'rgba(0, 0, 0, 0)',
      ],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        [
          'match',
          ['feature-state', 'impactState'],
          'critical', 3.2,
          'affected', 2.2,
          'unsupported', 1.1,
          0,
        ],
        11,
        [
          'match',
          ['feature-state', 'impactState'],
          'critical', 6.4,
          'affected', 4.5,
          'unsupported', 2.4,
          0,
        ],
      ],
      'line-opacity': [
        'match',
        ['feature-state', 'impactState'],
        'critical', 0.98,
        'affected', 0.9,
        'unsupported', 0.72,
        0,
      ],
      'line-dasharray': [2, 1.2],
    },
  })
  map.addLayer({
    id: 'hazard-area-edge',
    type: 'line',
    source: 'municipalities-state',
    paint: {
      'line-color': ['global-state', 'hazardColor'],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        ['+', 0.35, ['*', 0.8, ['coalesce', ['feature-state', 'metric'], 0]]],
        11,
        ['+', 0.8, ['*', 2.2, ['coalesce', ['feature-state', 'metric'], 0]]],
      ],
      'line-opacity': [
        '*',
        ['global-state', 'hazardActivity'],
        ['global-state', 'hazardEdgeActivity'],
        ['coalesce', ['feature-state', 'metric'], 0],
        ['+', 0.16, ['*', 0.38, ['global-state', 'motionSecondary']]],
      ],
      'line-dasharray': ['global-state', 'hazardDash'],
    },
  })
  map.addLayer({
    id: 'official-safety-region-boundaries',
    type: 'line',
    source: 'official-safety-regions',
    minzoom: 5.2,
    paint: {
      'line-color': '#b8d7df',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.75, 9, 1.45],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.28, 9, 0.16],
      'line-dasharray': [3, 2],
    },
  })
  map.addLayer({
    id: 'selected-safety-region-boundary',
    type: 'line',
    source: 'official-safety-regions',
    minzoom: 5.2,
    filter: ['==', ['get', 'selected'], 1],
    paint: {
      'line-color': '#d7f6ff',
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        ['+', 1.2, ['*', 0.45, ['global-state', 'selectionPulse']]],
        11,
        ['+', 2.4, ['*', 0.9, ['global-state', 'selectionPulse']]],
      ],
      'line-opacity': ['+', 0.42, ['*', 0.3, ['global-state', 'selectionPulse']]],
      'line-dasharray': [5, 2],
    },
  })
  map.addLayer({
    id: 'municipality-selection-pulse',
    type: 'line',
    source: 'municipalities-state',
    paint: {
      'line-color': '#ffffff',
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        ['+', 1.4, ['*', 0.75, ['global-state', 'selectionPulse']]],
        11,
        ['+', 3.5, ['*', 1.8, ['global-state', 'selectionPulse']]],
      ],
      'line-opacity': [
        '*',
        ['case', ['==', ['feature-state', 'selected'], 1], 1, 0],
        ['+', 0.48, ['*', 0.28, ['global-state', 'selectionPulse']]],
      ],
      'line-blur': ['*', 0.9, ['global-state', 'selectionPulse']],
    },
  })
  map.addLayer({
    id: 'official-water-management-areas',
    type: 'raster',
    source: 'official-water-management-areas',
    minzoom: 7,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.3,
      'raster-saturation': -0.18,
      'raster-contrast': 0.08,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-bro-groundwater-monitoring',
    type: 'raster',
    source: 'official-bro-groundwater-monitoring',
    minzoom: 10,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.78,
      'raster-contrast': 0.12,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-flood-risk-areas',
    type: 'raster',
    source: 'official-flood-risk-areas',
    minzoom: 5,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.34,
      'raster-saturation': -0.08,
      'raster-contrast': 0.16,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-liwo-breach-locations',
    type: 'raster',
    source: 'official-liwo-breach-locations',
    minzoom: 8,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.82,
      'raster-contrast': 0.08,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-pluvial-depth-scenario',
    type: 'raster',
    source: 'official-pluvial-depth-scenario',
    minzoom: 5,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.58,
      'raster-saturation': -0.04,
      'raster-contrast': 0.18,
      'raster-fade-duration': 120,
      'raster-resampling': 'nearest',
    },
  })
  map.addLayer({
    id: 'official-ahn-terrain',
    type: 'raster',
    source: 'official-ahn-terrain',
    minzoom: 10,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.26,
      'raster-saturation': -0.12,
      'raster-contrast': 0.12,
      'raster-fade-duration': 120,
      'raster-resampling': 'nearest',
    },
  })
  map.addLayer({
    id: 'official-rev-attention-areas',
    type: 'raster',
    source: 'official-rev-attention-areas',
    minzoom: 5,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.3,
      'raster-saturation': -0.08,
      'raster-contrast': 0.12,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-rev-risk-activities',
    type: 'raster',
    source: 'official-rev-risk-activities',
    minzoom: 5,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.82,
      'raster-contrast': 0.16,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-rev-pipelines',
    type: 'raster',
    source: 'official-rev-pipelines',
    minzoom: 5,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.78,
      'raster-contrast': 0.16,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-rev-basisnet',
    type: 'raster',
    source: 'official-rev-basisnet',
    minzoom: 5,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.76,
      'raster-contrast': 0.14,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-fis-waterways',
    type: 'raster',
    source: 'official-fis-waterways',
    minzoom: 6,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.58,
      'raster-contrast': 0.18,
      'raster-saturation': -0.06,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-combustible-nature-areas',
    type: 'raster',
    source: 'official-combustible-nature-areas',
    minzoom: 5,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.78,
      'raster-contrast': 0.18,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-agricultural-parcels',
    type: 'raster',
    source: 'official-agricultural-parcels',
    minzoom: 12,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.46,
      'raster-saturation': -0.08,
      'raster-contrast': 0.14,
      'raster-fade-duration': 120,
      'raster-resampling': 'nearest',
    },
  })
  map.addLayer({
    id: 'official-water-defences',
    type: 'raster',
    source: 'official-water-defences',
    minzoom: 11,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.74,
      'raster-contrast': 0.18,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-knmi-radar-observation',
    type: 'raster',
    source: 'official-knmi-radar',
    minzoom: 5,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.62,
      'raster-fade-duration': 120,
    },
  })
  for (const leadHours of [1, 3, 6] as const) {
    map.addLayer({
      id: `official-knmi-precipitation-probability-t-plus-${leadHours}`,
      type: 'raster',
      source: `official-knmi-precipitation-probability-t-plus-${leadHours}`,
      minzoom: 5,
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': 0.68,
        'raster-fade-duration': 120,
      },
    })
  }
  map.addLayer({
    id: 'official-air-quality-halos',
    type: 'circle',
    source: 'official-air-quality',
    minzoom: 5.3,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 7, 12, 17],
      'circle-color': [
        'interpolate', ['linear'], ['get', 'pm25UgM3'],
        0, '#79d6ff',
        10, '#e8dc65',
        20, '#ffad4d',
        30, '#ff5f55',
        50, '#a65be8',
      ],
      'circle-opacity': 0.18,
      'circle-blur': 0.55,
    },
  })
  map.addLayer({
    id: 'official-air-quality-points',
    type: 'circle',
    source: 'official-air-quality',
    minzoom: 5.3,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 2.8, 12, 6.6],
      'circle-color': [
        'interpolate', ['linear'], ['get', 'pm25UgM3'],
        0, '#79d6ff',
        10, '#e8dc65',
        20, '#ffad4d',
        30, '#ff5f55',
        50, '#a65be8',
      ],
      'circle-opacity': 0.94,
      'circle-stroke-color': '#f4fbff',
      'circle-stroke-width': 1,
    },
  })
  map.addLayer({
    id: 'official-air-quality-labels',
    type: 'symbol',
    source: 'official-air-quality',
    minzoom: 9,
    layout: {
      visibility: 'none',
      'text-field': [
        'concat',
        ['get', 'stationNumber'],
        ' · ',
        ['to-string', ['get', 'pm25UgM3']],
        ' µg/m³ PM2.5',
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
      'text-offset': [0, 0.95],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 5,
    },
    paint: {
      'text-color': '#eaf8ff',
      'text-halo-color': '#15181d',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-knmi-seismic-event-halos',
    type: 'circle',
    source: 'official-knmi-seismic-events',
    minzoom: 5.3,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['get', 'magnitude'],
        0, 5,
        1, 8,
        2, 13,
        3, 20,
        4, 30,
      ],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': [
        'case',
        ['==', ['get', 'reviewStatus'], 'reviewed'],
        '#f6f9ff',
        '#ff6f7d',
      ],
      'circle-stroke-width': [
        'case',
        ['==', ['get', 'reviewStatus'], 'reviewed'],
        1.2,
        2.2,
      ],
      'circle-opacity': 0.8,
    },
  })
  map.addLayer({
    id: 'official-knmi-seismic-event-points',
    type: 'circle',
    source: 'official-knmi-seismic-events',
    minzoom: 5.3,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['get', 'magnitude'],
        0, 2.5,
        1, 4,
        2, 6.5,
        3, 10,
        4, 15,
      ],
      'circle-color': [
        'case',
        ['==', ['get', 'eventType'], 'induced or triggered event'],
        '#ff9d5c',
        '#ffd866',
      ],
      'circle-opacity': 0.9,
      'circle-stroke-color': '#15181d',
      'circle-stroke-width': 0.8,
    },
  })
  map.addLayer({
    id: 'official-knmi-seismic-event-labels',
    type: 'symbol',
    source: 'official-knmi-seismic-events',
    minzoom: 8,
    layout: {
      visibility: 'none',
      'text-field': [
        'concat',
        ['get', 'location'],
        ' · M',
        ['to-string', ['get', 'magnitude']],
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
      'text-offset': [0, 1.15],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 5,
    },
    paint: {
      'text-color': '#fff5d6',
      'text-halo-color': '#15181d',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-level-warnings',
    type: 'circle',
    source: 'official-waterinfo-observations',
    minzoom: 5.3,
    filter: [
      'all',
      ['==', ['get', 'observationType'], 'water-level'],
      ['any', ['==', ['get', 'possiblyFaulty'], true], ['==', ['get', 'freshness'], 'stale']],
    ],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 6.5, 12, 12],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#ff765f',
      'circle-stroke-width': 2,
      'circle-opacity': 0.92,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-water-levels',
    type: 'circle',
    source: 'official-waterinfo-observations',
    minzoom: 5.3,
    filter: ['==', ['get', 'observationType'], 'water-level'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 3.1, 12, 6.8],
      'circle-color': ['coalesce', ['get', 'measurementColor'], '#61c8ff'],
      'circle-opacity': [
        'match', ['get', 'freshness'],
        'fresh', 0.94,
        'delayed', 0.7,
        0.42,
      ],
      'circle-stroke-color': '#e8f8ff',
      'circle-stroke-width': 1,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-water-level-labels',
    type: 'symbol',
    source: 'official-waterinfo-observations',
    minzoom: 9.2,
    filter: ['==', ['get', 'observationType'], 'water-level'],
    layout: {
      visibility: 'none',
      'text-field': [
        'concat', ['get', 'name'], ' · ', ['to-string', ['get', 'latestValue']], ' ', ['get', 'unitCode'],
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
      'text-offset': [0, 0.95],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 5,
    },
    paint: {
      'text-color': '#e8f8ff',
      'text-halo-color': '#0b2029',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-discharge-warnings',
    type: 'circle',
    source: 'official-waterinfo-observations',
    minzoom: 5.3,
    filter: [
      'all',
      ['==', ['get', 'observationType'], 'discharge'],
      ['any', ['==', ['get', 'possiblyFaulty'], true], ['==', ['get', 'freshness'], 'stale']],
    ],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 7.5, 12, 13],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#ff765f',
      'circle-stroke-width': 2,
      'circle-opacity': 0.92,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-discharges',
    type: 'circle',
    source: 'official-waterinfo-observations',
    minzoom: 5.3,
    filter: ['==', ['get', 'observationType'], 'discharge'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 3.7, 12, 7.8],
      'circle-color': ['coalesce', ['get', 'measurementColor'], '#6ae1bd'],
      'circle-opacity': [
        'match', ['get', 'freshness'],
        'fresh', 0.94,
        'delayed', 0.7,
        0.42,
      ],
      'circle-stroke-color': '#eafff8',
      'circle-stroke-width': 1.2,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-discharge-labels',
    type: 'symbol',
    source: 'official-waterinfo-observations',
    minzoom: 9.2,
    filter: ['==', ['get', 'observationType'], 'discharge'],
    layout: {
      visibility: 'none',
      'text-field': [
        'concat', ['get', 'name'], ' · ', ['to-string', ['get', 'latestValue']], ' ', ['get', 'unitCode'],
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
      'text-offset': [0, 1.05],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 5,
    },
    paint: {
      'text-color': '#eafff8',
      'text-halo-color': '#0b211c',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-forecast-water-level-warnings',
    type: 'circle',
    source: 'official-waterinfo-forecast-water-levels',
    minzoom: 5.3,
    filter: ['==', ['get', 'possiblyFaulty'], true],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 8, 12, 14],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#ff765f',
      'circle-stroke-width': 2.2,
      'circle-opacity': 0.95,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-forecast-water-levels',
    type: 'circle',
    source: 'official-waterinfo-forecast-water-levels',
    minzoom: 5.3,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 4.4, 12, 8.4],
      'circle-color': '#102d39',
      'circle-opacity': 0.9,
      'circle-stroke-color': ['coalesce', ['get', 'measurementColor'], '#87e1ff'],
      'circle-stroke-width': 2.2,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-forecast-water-level-labels',
    type: 'symbol',
    source: 'official-waterinfo-forecast-water-levels',
    minzoom: 9.2,
    layout: {
      visibility: 'none',
      'text-field': [
        'concat',
        'FORECAST +', ['to-string', ['get', 'requestedLeadEndHours']], 'h · ',
        ['get', 'name'], ' · ', ['to-string', ['get', 'value']], ' ', ['get', 'unitCode'],
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
      'text-offset': [0, 1.15],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 5,
    },
    paint: {
      'text-color': '#c9f3ff',
      'text-halo-color': '#071b23',
      'text-halo-width': 1.5,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-forecast-discharge-warnings',
    type: 'circle',
    source: 'official-waterinfo-forecast-discharges',
    minzoom: 5.3,
    filter: ['==', ['get', 'possiblyFaulty'], true],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 9, 12, 15],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#ff765f',
      'circle-stroke-width': 2.2,
      'circle-opacity': 0.95,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-forecast-discharges',
    type: 'circle',
    source: 'official-waterinfo-forecast-discharges',
    minzoom: 5.3,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 5.1, 12, 9.2],
      'circle-color': '#102f28',
      'circle-opacity': 0.9,
      'circle-stroke-color': ['coalesce', ['get', 'measurementColor'], '#80f0c9'],
      'circle-stroke-width': 2.2,
    },
  })
  map.addLayer({
    id: 'official-waterinfo-forecast-discharge-labels',
    type: 'symbol',
    source: 'official-waterinfo-forecast-discharges',
    minzoom: 9.2,
    layout: {
      visibility: 'none',
      'text-field': [
        'concat',
        'FORECAST +', ['to-string', ['get', 'requestedLeadEndHours']], 'h · ',
        ['get', 'name'], ' · ', ['to-string', ['get', 'value']], ' ', ['get', 'unitCode'],
      ],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 5,
    },
    paint: {
      'text-color': '#cffff0',
      'text-halo-color': '#071d18',
      'text-halo-width': 1.5,
    },
  })
  map.addLayer({
    id: 'official-road-network',
    type: 'line',
    source: 'transport-roads',
    minzoom: 5.2,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'case',
        ['==', ['get', 'functionalClass'], 0],
        '#f0ba62',
        ['==', ['get', 'functionalClass'], 1],
        '#c5a96b',
        '#9a8b69',
      ],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        ['case', ['==', ['get', 'functionalClass'], 0], 1.25, 0.62],
        11,
        ['case', ['==', ['get', 'functionalClass'], 0], 4.2, 2.1],
      ],
      'line-opacity': 0.36,
    },
  })
  map.addLayer({
    id: 'official-rail-network',
    type: 'line',
    source: 'transport-rail',
    minzoom: 5.4,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#8ad8df',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 11, 2.4],
      'line-opacity': 0.4,
      'line-dasharray': [2, 1.5],
    },
  })
  map.addLayer({
    id: 'official-stations',
    type: 'circle',
    source: 'transport-stations',
    minzoom: 7,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2, 12, 5],
      'circle-color': '#d8fbff',
      'circle-stroke-color': '#337681',
      'circle-stroke-width': 1,
      'circle-opacity': 0.72,
    },
  })
  map.addLayer({
    id: 'scheduled-bus-routes',
    type: 'line',
    source: 'transit-bus',
    minzoom: 8.7,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#70a8b0'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8.7, 0.55, 13, 1.8],
      'line-opacity': 0.08,
    },
  })
  map.addLayer({
    id: 'scheduled-urban-rail-routes',
    type: 'line',
    source: 'transit-urban-rail',
    minzoom: 7.2,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['get', 'color'], '#d78bdd'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.8, 13, 2.6],
      'line-opacity': 0.18,
    },
  })
  map.addLayer({
    id: 'scheduled-rail-services',
    type: 'line',
    source: 'transit-rail-services',
    minzoom: 6.3,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#f0d257',
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.65, 12, 2.2],
      'line-opacity': 0.12,
    },
  })
  map.addLayer({
    id: 'scheduled-ferry-routes',
    type: 'line',
    source: 'transit-ferries',
    minzoom: 6.5,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#60c9ef',
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 12, 3],
      'line-opacity': 0.22,
      'line-dasharray': [2, 1.2],
    },
  })
  map.addLayer({
    id: 'official-road-situation-lines',
    type: 'line',
    source: 'official-road-situations',
    minzoom: 6,
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'match', ['get', 'severity'],
        'highest', '#ff354d',
        'high', '#ff654f',
        'medium', '#ffad45',
        'low', '#ffe066',
        'lowest', '#d2e87d',
        '#c5a8f5',
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.35, 12, 5],
      'line-opacity': 0.88,
      'line-blur': 0.15,
    },
  })
  map.addLayer({
    id: 'official-road-situation-points',
    type: 'circle',
    source: 'official-road-situations',
    minzoom: 6,
    filter: ['==', ['geometry-type'], 'Point'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.2, 12, 6.2],
      'circle-color': [
        'match', ['get', 'severity'],
        'highest', '#ff354d',
        'high', '#ff654f',
        'medium', '#ffad45',
        'low', '#ffe066',
        'lowest', '#d2e87d',
        '#c5a8f5',
      ],
      'circle-stroke-color': '#171419',
      'circle-stroke-width': 1.2,
      'circle-opacity': 0.94,
    },
  })
  map.addLayer({
    id: 'official-road-congestion-lines',
    type: 'line',
    source: 'official-road-situations',
    minzoom: 6,
    filter: [
      'all',
      ['==', ['geometry-type'], 'LineString'],
      ['==', ['get', 'recordClass'], 'AbnormalTraffic'],
    ],
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffd05a',
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.8, 12, 6.2],
      'line-opacity': 0.96,
      'line-dasharray': [1.4, 0.8],
    },
  })
  map.addLayer({
    id: 'official-road-accident-halos',
    type: 'circle',
    source: 'official-road-situations',
    minzoom: 6,
    filter: [
      'all',
      ['==', ['geometry-type'], 'Point'],
      ['==', ['get', 'recordClass'], 'Accident'],
    ],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 5.5, 12, 13],
      'circle-color': '#ff425d',
      'circle-opacity': 0.24,
      'circle-blur': 0.5,
    },
  })
  map.addLayer({
    id: 'official-road-accident-points',
    type: 'circle',
    source: 'official-road-situations',
    minzoom: 6,
    filter: [
      'all',
      ['==', ['geometry-type'], 'Point'],
      ['==', ['get', 'recordClass'], 'Accident'],
    ],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 12, 8],
      'circle-color': '#ff425d',
      'circle-stroke-color': '#fff1f3',
      'circle-stroke-width': 1.4,
      'circle-opacity': 0.98,
    },
  })
  map.addLayer({
    id: 'official-road-accident-symbols',
    type: 'symbol',
    source: 'official-road-situations',
    minzoom: 7.2,
    filter: [
      'all',
      ['==', ['geometry-type'], 'Point'],
      ['==', ['get', 'recordClass'], 'Accident'],
    ],
    layout: {
      visibility: 'none',
      'text-field': '!',
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': '#61101d',
      'text-halo-width': 0.6,
    },
  })
  map.addLayer({
    id: 'official-traffic-camera-clusters',
    type: 'circle',
    source: 'official-traffic-cameras',
    filter: ['has', 'point_count'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 50, 22],
      'circle-color': '#24343d',
      'circle-stroke-color': '#9bd8e4',
      'circle-stroke-width': 1.6,
      'circle-opacity': 0.9,
    },
  })
  map.addLayer({
    id: 'official-traffic-camera-cluster-counts',
    type: 'symbol',
    source: 'official-traffic-cameras',
    filter: ['has', 'point_count'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
    },
    paint: {
      'text-color': '#eaf9fc',
    },
  })
  map.addLayer({
    id: 'official-traffic-camera-points',
    type: 'circle',
    source: 'official-traffic-cameras',
    filter: ['!', ['has', 'point_count']],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 4.5, 14, 8],
      'circle-color': [
        'match', ['get', 'operationalState'],
        'online', '#64dbc1',
        'offline', '#ff6577',
        '#9ba9ae',
      ],
      'circle-stroke-color': '#f0fbfc',
      'circle-stroke-width': 1.4,
      'circle-opacity': 0.94,
    },
  })
  map.addLayer({
    id: 'official-traffic-camera-labels',
    type: 'symbol',
    source: 'official-traffic-cameras',
    minzoom: 11,
    filter: ['!', ['has', 'point_count']],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
      'text-offset': [0, 1.25],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#eaf9fc',
      'text-halo-color': '#101a20',
      'text-halo-width': 1.4,
    },
  })
  for (const discipline of ['power', 'gas', 'water', 'drainage', 'telecom'] as const) {
    map.addLayer({
      id: `official-provider-area-${discipline}`,
      type: 'raster',
      source: `official-provider-area-${discipline}`,
      minzoom: 5.3,
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': 0.24,
        'raster-saturation': -0.32,
        'raster-contrast': 0.12,
        'raster-fade-duration': 120,
      },
    })
  }
  map.addLayer({
    id: 'official-national-overhead-high-voltage-lines',
    type: 'raster',
    source: 'official-national-overhead-high-voltage-lines',
    minzoom: 5,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.76,
      'raster-contrast': 0.12,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-zuid-holland-electricity-stations',
    type: 'raster',
    source: 'official-zuid-holland-electricity-stations',
    minzoom: 7,
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': 0.88,
      'raster-contrast': 0.1,
      'raster-fade-duration': 120,
    },
  })
  map.addLayer({
    id: 'official-nbnl-capacity-sample-halos',
    type: 'circle',
    source: 'official-nbnl-capacity-samples',
    minzoom: 6,
    filter: ['==', ['get', 'sampleStatus'], 'sampled'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate', ['linear'],
        ['coalesce', ['get', 'queueWithdrawalMw'], 0],
        0, 4,
        25, 7,
        100, 11,
        500, 15,
      ],
      'circle-color': [
        'match', ['get', 'tennetWithdrawalClass'],
        3, '#ff354d',
        2, '#ff9f43',
        1, '#ffd95e',
        0, '#65dfb2',
        '#9aa7b8',
      ],
      'circle-opacity': 0.34,
      'circle-blur': 0.32,
    },
  })
  map.addLayer({
    id: 'official-nbnl-capacity-sample-points',
    type: 'circle',
    source: 'official-nbnl-capacity-samples',
    minzoom: 6,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.3, 12, 5.2],
      'circle-color': [
        'case',
        ['==', ['get', 'sampleStatus'], 'no-published-match'], '#758292',
        ['match', ['get', 'tennetWithdrawalClass'],
          3, '#ff354d',
          2, '#ff9f43',
          1, '#ffd95e',
          0, '#65dfb2',
          '#9aa7b8'],
      ],
      'circle-stroke-color': '#14181e',
      'circle-stroke-width': 1.2,
      'circle-opacity': 0.9,
    },
  })
  map.addLayer({
    id: 'official-power-high-underground',
    type: 'line',
    source: 'official-power-backbone',
    minzoom: 7.4,
    filter: ['==', ['get', 'assetClass'], 'high-voltage-underground'],
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffd866',
      'line-width': ['interpolate', ['linear'], ['zoom'], 7.4, 0.75, 14, 3.2],
      'line-opacity': 0.82,
    },
  })
  map.addLayer({
    id: 'official-power-high-overhead',
    type: 'line',
    source: 'official-power-backbone',
    minzoom: 7.4,
    filter: ['==', ['get', 'assetClass'], 'high-voltage-overhead'],
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#fff2ad',
      'line-width': ['interpolate', ['linear'], ['zoom'], 7.4, 1.05, 14, 3.8],
      'line-opacity': 0.94,
      'line-dasharray': [3, 1.4],
    },
  })
  map.addLayer({
    id: 'official-power-high-stations',
    type: 'circle',
    source: 'official-power-backbone',
    minzoom: 9.7,
    filter: ['==', ['get', 'assetClass'], 'high-voltage-station'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9.7, 2.5, 15, 6.5],
      'circle-color': '#fff4b8',
      'circle-stroke-color': '#5d4816',
      'circle-stroke-width': 1.2,
      'circle-opacity': 0.94,
    },
  })
  map.addLayer({
    id: 'official-power-distribution-lines',
    type: 'line',
    source: 'official-power-detail',
    minzoom: 13.5,
    filter: ['in', ['get', 'assetClass'], ['literal', [
      'high-voltage-underground',
      'medium-voltage-cable',
      'low-voltage-cable',
    ]]],
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'match', ['get', 'assetClass'],
        'high-voltage-underground', '#ffe99a',
        'low-voltage-cable', '#e7c86b',
        '#ffc64b',
      ],
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        13.5, 0.45,
        17.5, ['match', ['get', 'assetClass'], 'low-voltage-cable', 1.35, 2.2],
      ],
      'line-opacity': 0.76,
    },
  })
  map.addLayer({
    id: 'official-power-distribution-stations',
    type: 'circle',
    source: 'official-power-detail',
    minzoom: 13.5,
    filter: ['in', ['get', 'assetClass'], ['literal', ['medium-voltage-station', 'low-voltage-station']]],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 2.2, 17.5, 4.8],
      'circle-color': '#fff1a2',
      'circle-stroke-color': '#5a4513',
      'circle-stroke-width': 1,
      'circle-opacity': 0.9,
    },
  })
  map.addLayer({
    id: 'official-gas-pipes',
    type: 'line',
    source: 'official-gas-detail',
    minzoom: 13.2,
    filter: ['==', ['get', 'assetClass'], 'gas-pipe'],
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ff9d5c',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13.2, 0.65, 17.5, 2.35],
      'line-opacity': 0.82,
      'line-dasharray': [4, 1.2],
    },
  })
  map.addLayer({
    id: 'official-gas-replacement-pipes',
    type: 'line',
    source: 'official-gas-detail',
    minzoom: 13.2,
    filter: ['==', ['get', 'assetClass'], 'gas-replacement-pipe'],
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#d88cff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13.2, 0.8, 17.5, 2.5],
      'line-opacity': 0.84,
      'line-dasharray': [1.4, 1.1],
    },
  })
  map.addLayer({
    id: 'official-wastewater-damo-lines',
    type: 'raster',
    source: 'official-wastewater-damo-lines',
    minzoom: 10.5,
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.72, 'raster-fade-duration': 120 },
  })
  map.addLayer({
    id: 'official-wastewater-gwsw-lines',
    type: 'raster',
    source: 'official-wastewater-gwsw-lines',
    minzoom: 10.5,
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.62, 'raster-fade-duration': 120 },
  })
  map.addLayer({
    id: 'official-water-asset-clusters',
    type: 'circle',
    source: 'official-water-assets',
    minzoom: 5.5,
    filter: ['has', 'point_count'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'step',
        ['get', 'point_count'],
        8,
        50,
        11,
        250,
        15,
        1000,
        19,
      ],
      'circle-color': '#2bb8cb',
      'circle-opacity': 0.72,
      'circle-stroke-color': '#d9fbff',
      'circle-stroke-width': 1.2,
    },
  })
  map.addLayer({
    id: 'official-water-asset-cluster-counts',
    type: 'symbol',
    source: 'official-water-assets',
    minzoom: 5.5,
    filter: ['has', 'point_count'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': '#10313a',
      'text-halo-width': 1,
    },
  })
  map.addLayer({
    id: 'official-water-asset-points',
    type: 'circle',
    source: 'official-water-assets',
    minzoom: 8.4,
    filter: ['!', ['has', 'point_count']],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        8,
        ['match', ['get', 'assetType'], 'wastewater-treatment', 3.8, 'surface-water-pump', 3, 'sewer-pump', 2.7, 'sluice', 2.6, 1.8],
        13,
        ['match', ['get', 'assetType'], 'wastewater-treatment', 7.5, 'surface-water-pump', 6.2, 'sewer-pump', 5.5, 'sluice', 5, 3.5],
      ],
      'circle-color': [
        'match',
        ['get', 'assetType'],
        'surface-water-pump',
        '#59dcff',
        'sewer-pump',
        '#ffb35c',
        'wastewater-treatment',
        '#d79bff',
        'sluice',
        '#68e1b4',
        '#46a8c5',
      ],
      'circle-opacity': 0.88,
      'circle-stroke-color': '#0a1820',
      'circle-stroke-width': 1,
    },
  })
  map.addLayer({
    id: 'official-water-asset-labels',
    type: 'symbol',
    source: 'official-water-assets',
    minzoom: 11.2,
    filter: ['all', ['!', ['has', 'point_count']], ['has', 'name']],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 4,
    },
    paint: {
      'text-color': '#dff8fb',
      'text-halo-color': '#09151b',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-government-service-clusters',
    type: 'circle',
    source: 'official-government-services',
    minzoom: 5.5,
    filter: ['has', 'point_count'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['step', ['get', 'point_count'], 8, 20, 11, 100, 15],
      'circle-color': '#ef7690',
      'circle-opacity': 0.74,
      'circle-stroke-color': '#ffe2e8',
      'circle-stroke-width': 1.2,
    },
  })
  map.addLayer({
    id: 'official-government-service-cluster-counts',
    type: 'symbol',
    source: 'official-government-services',
    minzoom: 5.5,
    filter: ['has', 'point_count'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#4a1725', 'text-halo-width': 1 },
  })
  map.addLayer({
    id: 'official-government-service-points',
    type: 'circle',
    source: 'official-government-services',
    minzoom: 8.2,
    filter: ['!', ['has', 'point_count']],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        8,
        ['match', ['get', 'facilityType'], 'public-order-and-safety', 3.4, 2.7],
        13,
        ['match', ['get', 'facilityType'], 'public-order-and-safety', 7, 5.5],
      ],
      'circle-color': [
        'match',
        ['get', 'facilityType'],
        'public-order-and-safety',
        '#ff7e93',
        '#79bfff',
      ],
      'circle-opacity': 0.9,
      'circle-stroke-color': '#111923',
      'circle-stroke-width': 1.1,
    },
  })
  map.addLayer({
    id: 'official-education-location-clusters',
    type: 'circle',
    source: 'official-education-locations',
    minzoom: 5.5,
    filter: ['has', 'point_count'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['step', ['get', 'point_count'], 8, 20, 11, 100, 15],
      'circle-color': '#62c9bb',
      'circle-opacity': 0.78,
      'circle-stroke-color': '#d9fff8',
      'circle-stroke-width': 1.1,
    },
  })
  map.addLayer({
    id: 'official-education-location-cluster-counts',
    type: 'symbol',
    source: 'official-education-locations',
    minzoom: 5.5,
    filter: ['has', 'point_count'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#123b37', 'text-halo-width': 1 },
  })
  map.addLayer({
    id: 'official-education-location-points',
    type: 'circle',
    source: 'official-education-locations',
    minzoom: 8,
    filter: ['!', ['has', 'point_count']],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.4, 13, 5.2],
      'circle-color': [
        'match', ['get', 'educationType'],
        'special education', '#c89bff',
        'primary education', '#65d4a6',
        'secondary education', '#61b6ff',
        'vocational or adult education', '#ffc45e',
        'higher education', '#ff8fcf',
        '#9caec0',
      ],
      'circle-opacity': 0.88,
      'circle-stroke-color': '#0b181b',
      'circle-stroke-width': 0.9,
    },
  })
  map.addLayer({
    id: 'official-education-location-labels',
    type: 'symbol',
    source: 'official-education-locations',
    minzoom: 12,
    filter: ['!', ['has', 'point_count']],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 5,
    },
    paint: {
      'text-color': '#dcfff8',
      'text-halo-color': '#0b1f1c',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-antenna-site-clusters',
    type: 'circle',
    source: 'official-antenna-sites',
    minzoom: 5.5,
    filter: ['has', 'point_count'],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['step', ['get', 'point_count'], 8, 25, 11, 125, 15],
      'circle-color': '#69c9ff',
      'circle-opacity': 0.78,
      'circle-stroke-color': '#d8f3ff',
      'circle-stroke-width': 1.1,
    },
  })
  map.addLayer({
    id: 'official-antenna-site-cluster-counts',
    type: 'symbol',
    source: 'official-antenna-sites',
    minzoom: 5.5,
    filter: ['has', 'point_count'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9.5,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#12354a', 'text-halo-width': 1 },
  })
  map.addLayer({
    id: 'official-antenna-site-points',
    type: 'circle',
    source: 'official-antenna-sites',
    minzoom: 8,
    filter: ['!', ['has', 'point_count']],
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.4, 13, 5.4],
      'circle-color': [
        'match', ['get', 'primaryCategory'],
        'mobile communication', '#55c8ff',
        'fixed link', '#c89bff',
        'broadcast', '#ff9568',
        'other mobile', '#68e0be',
        'radio amateur', '#ffd15d',
        '#9caec0',
      ],
      'circle-opacity': 0.9,
      'circle-stroke-color': '#0a1720',
      'circle-stroke-width': 0.9,
    },
  })
  map.addLayer({
    id: 'official-antenna-site-labels',
    type: 'symbol',
    source: 'official-antenna-sites',
    minzoom: 12.5,
    filter: ['!', ['has', 'point_count']],
    layout: {
      visibility: 'none',
      'text-field': ['coalesce', ['get', 'technologySummary'], ['get', 'primaryCategory']],
      'text-font': ['Noto Sans Regular'],
      'text-size': 9,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 5,
    },
    paint: {
      'text-color': '#d9f4ff',
      'text-halo-color': '#0a1922',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-acute-care-points',
    type: 'circle',
    source: 'official-acute-care',
    minzoom: 5.3,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.3, 3.6, 12, 8.5],
      'circle-color': [
        'case',
        ['==', ['get', 'emergencyOpen247'], true],
        '#ff5d7b',
        '#ffb75c',
      ],
      'circle-opacity': 0.94,
      'circle-stroke-color': '#fff3f5',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5.3, 0.8, 12, 1.8],
    },
  })
  map.addLayer({
    id: 'official-acute-care-labels',
    type: 'symbol',
    source: 'official-acute-care',
    minzoom: 9.2,
    layout: {
      visibility: 'none',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-offset': [0, 1.05],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 5,
    },
    paint: {
      'text-color': '#ffe8ed',
      'text-halo-color': '#251018',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'official-station-labels',
    type: 'symbol',
    source: 'transport-stations',
    minzoom: 10,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
    },
    paint: {
      'text-color': '#d7eff1',
      'text-halo-color': '#0a1419',
      'text-halo-width': 1.3,
    },
  })
  map.addLayer({
    id: 'official-safety-region-labels',
    type: 'symbol',
    source: 'official-safety-region-label-points',
    minzoom: 5.55,
    maxzoom: 8.8,
    filter: ['!=', ['get', 'selected'], 1],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5.5, 9, 8.5, 11],
      'text-letter-spacing': 0.08,
      'text-transform': 'uppercase',
      'text-allow-overlap': false,
      'text-padding': 10,
    },
    paint: {
      'text-color': '#b7d0d7',
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 5.5, 0.5, 8.8, 0.22],
      'text-halo-color': '#0b151a',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'selected-safety-region-label',
    type: 'symbol',
    source: 'official-safety-region-label-points',
    minzoom: 5.4,
    maxzoom: 10.8,
    filter: ['==', ['get', 'selected'], 1],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5.4, 10, 10.5, 12.5],
      'text-letter-spacing': 0.08,
      'text-transform': 'uppercase',
      'text-allow-overlap': false,
      'text-padding': 14,
    },
    paint: {
      'text-color': '#e3f8fd',
      'text-opacity': 0.82,
      'text-halo-color': '#091318',
      'text-halo-width': 1.8,
    },
  })
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'national-routes',
    paint: {
      'line-color': '#071116',
      'line-width': ['+', ['coalesce', ['feature-state', 'width'], 1.35], 2.2],
      'line-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
    },
  })
  map.addLayer({
    id: 'national-route-lines',
    type: 'line',
    source: 'national-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['feature-state', 'color'], '#54d7b0'],
      'line-width': ['coalesce', ['feature-state', 'width'], 1.35],
      'line-opacity': ['coalesce', ['feature-state', 'opacity'], 0],
      'line-blur': ['case', ['==', ['feature-state', 'selected'], 1], 0, 0.25],
    },
  })
  map.addLayer({
    id: 'national-route-flow-dashes',
    type: 'line',
    source: 'national-routes',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': ['coalesce', ['feature-state', 'color'], '#54d7b0'],
      'line-width': ['+', 0.55, ['*', 0.62, ['coalesce', ['feature-state', 'width'], 1.35]]],
      'line-opacity': [
        '*',
        ['global-state', 'flowActivity'],
        ['coalesce', ['feature-state', 'motionOpacity'], 0],
        ['+', 0.38, ['*', 0.5, ['global-state', 'motionSecondary']]],
      ],
      'line-dasharray': ['global-state', 'flowDash'],
    },
  })
  map.addLayer({
    id: 'route-flow-arrows',
    type: 'symbol',
    source: 'national-routes',
    minzoom: 6,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 84,
      'text-field': '›',
      'text-font': ['Noto Sans Regular'],
      'text-size': 17,
      'text-keep-upright': false,
      'text-rotation-alignment': 'map',
    },
    paint: {
      'text-color': ['coalesce', ['feature-state', 'color'], '#54d7b0'],
      'text-opacity': [
        '*',
        ['case', ['==', ['feature-state', 'flowDirection'], 1], 1, 0],
        ['coalesce', ['feature-state', 'opacity'], 0],
        ['global-state', 'flowActivity'],
        ['+', 0.54, ['*', 0.46, ['global-state', 'motionSecondary']]],
      ],
      'text-halo-color': '#091218',
      'text-halo-width': 1,
    },
  })
  map.addLayer({
    id: 'route-flow-arrows-reverse',
    type: 'symbol',
    source: 'national-routes',
    minzoom: 6,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 84,
      'text-field': '‹',
      'text-font': ['Noto Sans Regular'],
      'text-size': 17,
      'text-keep-upright': false,
      'text-rotation-alignment': 'map',
    },
    paint: {
      'text-color': ['coalesce', ['feature-state', 'color'], '#54d7b0'],
      'text-opacity': [
        '*',
        ['case', ['==', ['feature-state', 'flowDirection'], -1], 1, 0],
        ['coalesce', ['feature-state', 'opacity'], 0],
        ['global-state', 'flowActivity'],
        ['+', 0.54, ['*', 0.46, ['global-state', 'motionSecondary']]],
      ],
      'text-halo-color': '#091218',
      'text-halo-width': 1,
    },
  })
  map.addLayer({
    id: 'gateway-signal-pulse',
    type: 'circle',
    source: 'city-gateways',
    paint: {
      'circle-radius': [
        '+',
        ['get', 'radius'],
        ['*', ['coalesce', ['feature-state', 'signal'], 0], ['+', 3, ['*', 7, ['global-state', 'motionPulse']]]],
      ],
      'circle-color': ['coalesce', ['feature-state', 'color'], '#54d7b0'],
      'circle-opacity': [
        '*',
        ['global-state', 'signalActivity'],
        ['global-state', 'gatewayActivity'],
        ['coalesce', ['feature-state', 'signal'], 0],
        ['+', 0.06, ['*', 0.24, ['global-state', 'motionSecondary']]],
      ],
      'circle-blur': 0.68,
      'circle-stroke-color': ['coalesce', ['feature-state', 'color'], '#54d7b0'],
      'circle-stroke-width': 0.8,
      'circle-stroke-opacity': [
        '*',
        ['global-state', 'signalActivity'],
        ['global-state', 'gatewayActivity'],
        ['coalesce', ['feature-state', 'signal'], 0],
        ['+', 0.08, ['*', 0.24, ['global-state', 'motionPulse']]],
      ],
    },
  })
  map.addLayer({
    id: 'city-gateway-halo',
    type: 'circle',
    source: 'city-gateways',
    paint: {
      'circle-radius': ['+', ['get', 'radius'], ['case', ['==', ['get', 'selected'], 1], 6, 2]],
      'circle-color': ['coalesce', ['feature-state', 'color'], '#54d7b0'],
      'circle-opacity': 0.14,
      'circle-blur': 0.55,
    },
  })
  map.addLayer({
    id: 'realistic-city-light-glow',
    type: 'circle',
    source: 'city-gateways',
    maxzoom: 13.8,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        ['*', ['get', 'radius'], 1.15],
        12,
        ['*', ['get', 'radius'], 2.8],
      ],
      'circle-color': '#ffc66d',
      'circle-opacity': [
        '*',
        ['coalesce', ['feature-state', 'powerAvailability'], 1],
        0.34,
      ],
      'circle-blur': 0.82,
    },
  })
  map.addLayer({
    id: 'realistic-city-lights',
    type: 'circle',
    source: 'city-gateways',
    maxzoom: 13.8,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 12, 3.4],
      'circle-color': '#ffe5a7',
      'circle-opacity': [
        '*',
        ['coalesce', ['feature-state', 'powerAvailability'], 1],
        0.88,
      ],
      'circle-blur': 0.18,
    },
  })
  map.addLayer({
    id: 'city-gateways',
    type: 'circle',
    source: 'city-gateways',
    paint: {
      'circle-radius': ['+', ['get', 'radius'], ['case', ['==', ['get', 'selected'], 1], 2.5, 0]],
      'circle-color': ['coalesce', ['feature-state', 'color'], '#54d7b0'],
      'circle-stroke-color': ['case', ['==', ['get', 'selected'], 1], '#ffffff', '#12232b'],
      'circle-stroke-width': ['case', ['==', ['get', 'selected'], 1], 3, 1.5],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.9, 9, 0.45],
    },
  })
  map.addLayer({
    id: 'selected-gateway-pulse',
    type: 'circle',
    source: 'city-gateways',
    filter: ['==', ['get', 'selected'], 1],
    paint: {
      'circle-radius': [
        '+',
        ['get', 'radius'],
        ['+', 3.5, ['*', 3.5, ['global-state', 'selectionPulse']]],
      ],
      'circle-color': 'rgba(0, 0, 0, 0)',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['+', 1, ['*', 0.8, ['global-state', 'selectionPulse']]],
      'circle-stroke-opacity': [
        '*',
        ['global-state', 'gatewayActivity'],
        ['+', 0.42, ['*', 0.4, ['global-state', 'selectionPulse']]],
      ],
    },
  })
  map.addLayer({
    id: 'city-gateway-labels',
    type: 'symbol',
    source: 'city-gateways',
    minzoom: 6,
    filter: ['all', ['>', ['get', 'population'], 85_000], ['!=', ['get', 'selected'], 1]],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.25],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#eaf4f5',
      'text-halo-color': '#111a20',
      'text-halo-width': 1.4,
    },
  })
  map.addLayer({
    id: 'selected-gateway-label',
    type: 'symbol',
    source: 'city-gateways',
    minzoom: 5.4,
    filter: ['==', ['get', 'selected'], 1],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.35],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': '#0a141a',
      'text-halo-width': 1.8,
    },
  })
  map.addLayer({
    id: 'affected-region-gateway-markers',
    type: 'circle',
    source: 'city-gateways',
    maxzoom: 9.2,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        '+',
        ['get', 'radius'],
        [
          'match',
          ['feature-state', 'impactState'],
          'critical', 5.5,
          'affected', 3.5,
          0,
        ],
      ],
      'circle-color': [
        'match',
        ['feature-state', 'impactState'],
        'critical', 'rgba(255, 66, 93, 0.18)',
        'affected', 'rgba(255, 192, 103, 0.12)',
        'rgba(0, 0, 0, 0)',
      ],
      'circle-stroke-color': [
        'match',
        ['feature-state', 'impactState'],
        'critical', '#ff526b',
        'affected', '#ffc067',
        'rgba(0, 0, 0, 0)',
      ],
      'circle-stroke-width': [
        'match',
        ['feature-state', 'impactState'],
        'critical', 3.2,
        'affected', 2,
        0,
      ],
      'circle-stroke-opacity': [
        'match',
        ['feature-state', 'impactState'],
        'critical', 1,
        'affected', 0.92,
        0,
      ],
    },
  })
  map.addLayer({
    id: 'city-service-areas',
    type: 'fill',
    source: 'city-areas',
    minzoom: 7.8,
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'] },
  })
  map.addLayer({
    id: 'realistic-settlement-lights',
    type: 'fill',
    source: 'city-settlements',
    minzoom: 8.2,
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#ffd27d',
      'fill-opacity': 0.12,
      'fill-outline-color': 'rgba(255, 224, 156, 0.28)',
    },
  })
  map.addLayer({
    id: 'city-hazard-pulse',
    type: 'fill',
    source: 'city-areas',
    minzoom: 7.8,
    filter: ['>', ['get', 'metric'], 0.01],
    paint: {
      'fill-color': ['global-state', 'hazardColor'],
      'fill-opacity': [
        '*',
        ['global-state', 'hazardActivity'],
        ['get', 'metric'],
        ['+', 0.055, ['*', 0.17, ['global-state', 'motionPulse']]],
      ],
    },
  })
  map.addLayer({
    id: 'city-service-area-outline',
    type: 'line',
    source: 'city-areas',
    minzoom: 7.8,
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 1.2,
      'line-opacity': 0.66,
      'line-dasharray': [2, 2],
    },
  })
  map.addLayer({
    id: 'city-operational-boundary-outline',
    type: 'line',
    source: 'city-operational-boundary',
    minzoom: 7.8,
    paint: {
      'line-color': '#f5fbff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 14, 3.2],
      'line-opacity': 0.92,
      'line-dasharray': [5, 1.4],
    },
  })
  map.addLayer({
    id: 'selected-city-service-area',
    type: 'line',
    source: 'city-areas',
    minzoom: 7.8,
    filter: ['==', ['get', 'selected'], 1],
    paint: {
      'line-color': '#ffffff',
      'line-width': ['+', 2, ['*', 1.2, ['global-state', 'selectionPulse']]],
      'line-opacity': ['+', 0.5, ['*', 0.38, ['global-state', 'selectionPulse']]],
      'line-dasharray': ['global-state', 'hazardDash'],
    },
  })
  map.addLayer({
    id: 'official-settlement-fill',
    type: 'fill',
    source: 'city-settlements',
    minzoom: 8.4,
    paint: {
      'fill-color': [
        'match',
        ['get', 'settlementType'],
        'woonkern',
        '#d8e7a8',
        'deelkern',
        '#b5dba6',
        'gehucht',
        '#91c9ad',
        '#79a99a',
      ],
      'fill-opacity': 0.08,
    },
  })
  map.addLayer({
    id: 'official-settlement-outlines',
    type: 'line',
    source: 'city-settlements',
    minzoom: 8.4,
    paint: {
      'line-color': [
        'match',
        ['get', 'settlementType'],
        'woonkern',
        '#e0edb8',
        'deelkern',
        '#bedfae',
        'gehucht',
        '#8fcbb0',
        '#76a99b',
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.65, 13, 1.8],
      'line-opacity': 0.7,
    },
  })
  map.addLayer({
    id: 'official-settlement-labels',
    type: 'symbol',
    source: 'city-settlements',
    minzoom: 9.1,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': [
        'case',
        ['==', ['get', 'settlementType'], 'woonkern'],
        12,
        ['==', ['get', 'settlementType'], 'deelkern'],
        10.5,
        9.5,
      ],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#e8f4d1',
      'text-halo-color': '#0b1418',
      'text-halo-width': 1.5,
    },
  })
  map.addLayer({
    id: 'official-place-boundaries',
    type: 'line',
    source: 'city-places',
    minzoom: 8.2,
    paint: {
      'line-color': '#dce9c5',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 13, 1.8],
      'line-opacity': 0.58,
      'line-dasharray': [4, 2],
    },
  })
  map.addLayer({
    id: 'official-place-labels',
    type: 'symbol',
    source: 'city-places',
    minzoom: 8.8,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 14],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#eef6df',
      'text-halo-color': '#0b1418',
      'text-halo-width': 1.6,
    },
  })
  map.addLayer({
    id: 'city-local-links-casing',
    type: 'line',
    source: 'city-links',
    minzoom: 7.8,
    paint: {
      'line-color': '#071116',
      'line-width': ['+', ['get', 'width'], 2.3],
      'line-opacity': ['get', 'opacity'],
    },
  })
  map.addLayer({
    id: 'city-local-links',
    type: 'line',
    source: 'city-links',
    minzoom: 7.8,
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['get', 'width'],
      'line-opacity': ['get', 'opacity'],
    },
  })
  map.addLayer({
    id: 'city-node-signal-pulse',
    type: 'circle',
    source: 'city-nodes',
    minzoom: 7.8,
    filter: ['>', ['get', 'signal'], 0.08],
    paint: {
      'circle-radius': [
        '+',
        ['get', 'radius'],
        ['*', ['get', 'signal'], ['+', 3, ['*', 6, ['global-state', 'motionPulse']]]],
      ],
      'circle-color': ['get', 'color'],
      'circle-opacity': [
        '*',
        ['global-state', 'signalActivity'],
        ['get', 'signal'],
        ['+', 0.08, ['*', 0.3, ['global-state', 'motionSecondary']]],
      ],
      'circle-blur': 0.58,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 1,
      'circle-stroke-opacity': [
        '*',
        ['global-state', 'signalActivity'],
        ['get', 'signal'],
        ['+', 0.12, ['*', 0.3, ['global-state', 'motionPulse']]],
      ],
    },
  })
  map.addLayer({
    id: 'city-nodes',
    type: 'circle',
    source: 'city-nodes',
    minzoom: 7.8,
    paint: {
      'circle-radius': ['get', 'radius'],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': ['case', ['==', ['get', 'isHub'], 1], '#ffffff', '#14232b'],
      'circle-stroke-width': ['case', ['==', ['get', 'isHub'], 1], 3, 2],
      'circle-opacity': 0.96,
    },
  })
  map.addLayer({
    id: 'selected-city-node-pulse',
    type: 'circle',
    source: 'city-nodes',
    minzoom: 7.8,
    filter: ['==', ['get', 'selected'], 1],
    paint: {
      'circle-radius': [
        '+',
        ['get', 'radius'],
        ['+', 3, ['*', 3, ['global-state', 'selectionPulse']]],
      ],
      'circle-color': 'rgba(0, 0, 0, 0)',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['+', 1, ['*', 0.8, ['global-state', 'selectionPulse']]],
      'circle-stroke-opacity': ['+', 0.38, ['*', 0.48, ['global-state', 'selectionPulse']]],
    },
  })
  map.addLayer({
    id: 'city-node-labels',
    type: 'symbol',
    source: 'city-nodes',
    minzoom: 8.4,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.15],
      'text-anchor': 'top',
    },
    paint: {
      'text-color': '#eff7f7',
      'text-halo-color': '#101a20',
      'text-halo-width': 1.5,
    },
  })
  // Current road incidents and impact boundaries answer high-priority map
  // questions and must stay legible above gateway/status markers. The impact
  // fill deliberately keeps its original lower position so it never masks
  // city service areas, infrastructure, facilities, labels or night lights.
  for (const layerId of [
    'official-road-situation-lines',
    'official-road-situation-points',
    'official-road-congestion-lines',
    'official-road-accident-halos',
    'official-road-accident-points',
    'official-road-accident-symbols',
  ]) map.moveLayer(layerId)
  map.moveLayer('affected-region-overlay-halo')
  map.moveLayer('affected-region-overlay-outline')
  map.moveLayer('affected-region-gateway-markers')
}

function setSourceData(map: MapLibreMap, sourceId: string, data: FeatureCollection) {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined
  source?.setData(data)
}

export function MapView({
  collection,
  municipalities,
  frame,
  safetyRegions = null,
  cityDetail,
  regionBundle,
  transport,
  transit,
  publicWaterAssets,
  publicFacilities,
  publicAcuteCare,
  publicEducationLocations,
  publicAntennaSites,
  publicRoadSituations,
  publicRoadSituationsError,
  publicPrecipitationProbabilityContext,
  publicWeatherObservations,
  publicWeatherWarnings,
  publicAirQuality,
  publicSeismicEvents,
  publicWaterObservations,
  publicWaterForecasts,
  publicCapacityContext,
  activeLayer,
  selectedMunicipalityId,
  selectedDistrictId,
  viewMode,
  animationsPaused = false,
  viewCommand,
  onRequestRoadSituations,
  onSelectMunicipality,
  onSelectDistrict,
  onViewModeChange,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const loadedRef = useRef(false)
  const programmaticMoveRef = useRef(false)
  const centeredDistrictRef = useRef<string | null>(null)
  const official3dLayersRef = useRef<ThreeDTilesLayer[]>([])
  const official3dLoadRef = useRef<Promise<void> | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [mapZoom, setMapZoom] = useState(6.25)
  const [basemapMode, setBasemapMode] = useState<BasemapMode>('cartographic')
  const [perspectiveMode, setPerspectiveMode] = useState<PerspectiveMode>('2d')
  const [affectedOverlayEnabled, setAffectedOverlayEnabled] = useState(true)
  const [roadSituationOverlayPreference, setRoadSituationOverlayPreference] =
    useState<OverlayPreference>('auto')
  const [cameraOverlayEnabled, setCameraOverlayEnabled] = useState(false)
  const [mobileMapControlsOpen, setMobileMapControlsOpen] = useState(false)
  const [trafficCameras, setTrafficCameras] = useState<PublicTrafficCameraCollection | null>(null)
  const [cameraLoadError, setCameraLoadError] = useState<string | null>(null)
  const [official3dState, setOfficial3dState] = useState<Official3dState>('idle')
  const [official3dError, setOfficial3dError] = useState<string | null>(null)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === 'undefined' || document.visibilityState === 'visible',
  )
  const [powerBackbone, setPowerBackbone] = useState<PublicUtilityCollection | null>(null)
  const [powerBackboneLoading, setPowerBackboneLoading] = useState(false)
  const [utilityDetail, setUtilityDetail] = useState<PublicUtilityCollection | null>(null)
  const [utilityDetailLoading, setUtilityDetailLoading] = useState(false)
  const [utilityContextError, setUtilityContextError] = useState<string | null>(null)
  const [utilityViewportZoom, setUtilityViewportZoom] = useState(6.25)
  const modeRef = useRef(viewMode)
  const selectedIdRef = useRef(selectedMunicipalityId)
  const perspectiveModeRef = useRef(perspectiveMode)
  const handlersRef = useRef({ onSelectMunicipality, onSelectDistrict, onViewModeChange })

  modeRef.current = viewMode
  selectedIdRef.current = selectedMunicipalityId
  perspectiveModeRef.current = perspectiveMode
  handlersRef.current = { onSelectMunicipality, onSelectDistrict, onViewModeChange }

  const transportFocus = activeLayer === 'mobility' || activeLayer === 'supply'
  const roadSituationOverlayEnabled =
    roadSituationOverlayPreference === 'on' ||
    (roadSituationOverlayPreference === 'auto' && transportFocus)

  const realisticLighting = useMemo(
    () => realisticLightingForFrame(frame.scenario, frame.minute),
    [
      frame.minute,
      frame.scenario.referenceDate,
      frame.scenario.season,
      frame.scenario.startClockHour,
    ],
  )
  const selectedPowerAvailability = useMemo(
    () => frame.municipalities.find((municipality) => municipality.id === selectedMunicipalityId)
      ?.services.power.availability ?? 1,
    [frame.municipalities, selectedMunicipalityId],
  )

  const municipalityGeometryData = useMemo(
    () => municipalityGeometry(collection),
    [collection],
  )
  const municipalityStates = useMemo(
    () => municipalityFeatureStates(collection, frame, activeLayer, selectedMunicipalityId),
    [collection, frame, activeLayer, selectedMunicipalityId],
  )
  const impactSummary = useMemo(() => {
    let affected = 0
    let critical = 0
    let unsupported = 0
    for (const municipality of frame.municipalities) {
      if (municipality.hazard.spatialEvidence === 'unsupported') {
        unsupported += 1
        continue
      }
      if (municipality.affectedPopulation > 0) affected += 1
      if (municipality.status === 'critical' || municipality.status === 'failed') critical += 1
    }
    return { affected, critical, unsupported }
  }, [frame.municipalities])
  const roadSituationSummary = useMemo(() => {
    let accidents = 0
    let congestion = 0
    let obstructions = 0
    for (const feature of publicRoadSituations?.features ?? []) {
      if (feature.properties.recordClass === 'Accident') accidents += 1
      if (feature.properties.recordClass === 'AbnormalTraffic') congestion += 1
      if (
        feature.properties.recordClass === 'VehicleObstruction' ||
        feature.properties.recordClass === 'GeneralObstruction'
      ) obstructions += 1
    }
    return {
      total: publicRoadSituations?.features.length ?? 0,
      accidents,
      congestion,
      obstructions,
    }
  }, [publicRoadSituations])
  const gatewayGeometryData = useMemo(
    () => gatewayGeometryFeatures(municipalities, selectedMunicipalityId),
    [municipalities, selectedMunicipalityId],
  )
  const gatewayStates = useMemo(
    () => gatewayFeatureStates(frame, activeLayer),
    [frame, activeLayer],
  )
  const routeGeometryData = useMemo(
    () => routeGeometryFeatures(transport.routes),
    [transport.routes],
  )
  const routeStates = useMemo(
    () => routeFeatureStates(transport.routes, frame, selectedMunicipalityId, activeLayer),
    [transport.routes, frame, selectedMunicipalityId, activeLayer],
  )
  const safetyData = useMemo(() => {
    const regions = safetyRegionFeatures(safetyRegions, selectedMunicipalityId)
    return { regions, labels: safetyRegionLabelFeatures(regions) }
  }, [safetyRegions, selectedMunicipalityId])
  const placeData = useMemo(() => placeFeatures(regionBundle), [regionBundle])
  const settlementData = useMemo(() => settlementFeatures(regionBundle), [regionBundle])
  const defaultWaterAssetData = useMemo<FeatureCollection<Point>>(
    () => publicWaterAssets
      ? {
          type: 'FeatureCollection',
          features: publicWaterAssets.features.filter(
            (feature) => !isExplicitlyWithdrawnPublicWaterAsset(feature),
          ),
        }
      : emptyCollection as FeatureCollection<Point>,
    [publicWaterAssets],
  )
  const waterForecastCheckpoint = nearestWaterForecastCheckpoint(frame.step / 4)
  const waterForecastData = useMemo(() => {
    const checkpointFeatures = publicWaterForecasts?.features.filter(
      (feature) => feature.properties.requestedLeadEndHours === waterForecastCheckpoint,
    ) ?? []
    return {
      waterLevels: {
        type: 'FeatureCollection' as const,
        features: checkpointFeatures.filter(
          (feature) => feature.properties.forecastType === 'water-level',
        ),
      },
      discharges: {
        type: 'FeatureCollection' as const,
        features: checkpointFeatures.filter(
          (feature) => feature.properties.forecastType === 'discharge',
        ),
      },
    }
  }, [publicWaterForecasts, waterForecastCheckpoint])
  const operationalBoundaryData = useMemo(
    () => operationalBoundaryFeatures(regionBundle),
    [regionBundle],
  )
  const cityData = useMemo(
    () => districtCollections(cityDetail, activeLayer, regionBundle, selectedDistrictId),
    [cityDetail, activeLayer, regionBundle, selectedDistrictId],
  )
  const initialData = {
    municipalities: municipalityGeometryData,
    safetyRegions: safetyData.regions,
    safetyRegionLabels: safetyData.labels,
    gateways: gatewayGeometryData,
    routes: routeGeometryData,
    roads: transport.roads,
    rail: transport.rail,
    stations: transport.stations,
    transitBus: transit?.bus ?? emptyCollection,
    transitUrbanRail: transit?.urbanRail ?? emptyCollection,
    transitRailServices: transit?.railServices ?? emptyCollection,
    transitFerries: transit?.ferries ?? emptyCollection,
    roadSituations: publicRoadSituations ?? emptyCollection,
    trafficCameras: trafficCameras ?? emptyCollection,
    weatherObservations: publicWeatherObservations ?? emptyCollection,
    weatherWarnings: publicWeatherWarnings ?? emptyCollection,
    waterAssets: defaultWaterAssetData,
    governmentServices: publicFacilities ?? emptyCollection,
    acuteCare: publicAcuteCare ?? emptyCollection,
    educationLocations: publicEducationLocations ?? emptyCollection,
    antennaSites: publicAntennaSites ?? emptyCollection,
    airQuality: publicAirQuality ?? emptyCollection,
    seismicEvents: publicSeismicEvents ?? emptyCollection,
    waterObservations: publicWaterObservations ?? emptyCollection,
    waterForecastLevels: waterForecastData.waterLevels,
    waterForecastDischarges: waterForecastData.discharges,
    capacitySamples: publicCapacityContext ?? emptyCollection,
    powerBackbone: powerBackbone ?? emptyCollection,
    powerDetail:
      utilityDetail?.query.kind === 'power-detail' ? utilityDetail : emptyCollection,
    gasDetail:
      utilityDetail?.query.kind === 'gas-detail' ? utilityDetail : emptyCollection,
    operationalBoundary: operationalBoundaryData,
    places: placeData,
    settlements: settlementData,
    ...cityData,
  }
  const dataRef = useRef(initialData)
  dataRef.current = initialData
  const sourceDataRef = useRef(new Map<string, FeatureCollection>())
  const featureStateRef = useRef(new Map<string, Record<string, string | number>>())
  const updateSource = useCallback(
    (map: MapLibreMap, sourceId: string, nextData: FeatureCollection) => {
      if (sourceDataRef.current.get(sourceId) === nextData) return
      setSourceData(map, sourceId, nextData)
      sourceDataRef.current.set(sourceId, nextData)
    },
    [],
  )
  const updateFeatureStates = useCallback(
    (map: MapLibreMap, sourceId: string, entries: DynamicFeatureState[]) => {
      for (const entry of entries) {
        const cacheKey = `${sourceId}:${entry.id}`
        const previous = featureStateRef.current.get(cacheKey)
        const keys = Object.keys(entry.state)
        if (
          previous &&
          keys.length === Object.keys(previous).length &&
          keys.every((key) => previous[key] === entry.state[key])
        ) continue
        map.setFeatureState({ source: sourceId, id: entry.id }, entry.state)
        featureStateRef.current.set(cacheKey, entry.state)
      }
    },
    [],
  )

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches)
    updatePreference()
    mediaQuery.addEventListener('change', updatePreference)
    return () => mediaQuery.removeEventListener('change', updatePreference)
  }, [])

  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])

  useEffect(() => {
    if (!cameraOverlayEnabled || trafficCameras) return
    const controller = new AbortController()
    setCameraLoadError(null)
    loadPublicTrafficCameras(controller.signal)
      .then((collection) => setTrafficCameras(collection))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setCameraLoadError(error.message)
      })
    return () => controller.abort()
  }, [cameraOverlayEnabled, trafficCameras])

  useEffect(() => {
    if (activeLayer !== 'power' || powerBackbone) return
    const controller = new AbortController()
    setPowerBackboneLoading(true)
    setUtilityContextError(null)
    loadPublicPowerBackbone(controller.signal)
      .then((collection) => setPowerBackbone(collection))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setUtilityContextError(error.message)
      })
      .finally(() => setPowerBackboneLoading(false))
    return () => controller.abort()
  }, [activeLayer, powerBackbone])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || (activeLayer !== 'power' && activeLayer !== 'gas')) {
      if (activeLayer !== 'power' && activeLayer !== 'gas') {
        setUtilityDetail(null)
        setUtilityDetailLoading(false)
        setUtilityContextError(null)
      }
      return
    }
    let requestController: AbortController | null = null
    let refreshTimer: number | null = null
    let lastQueryKey = ''
    let requestSequence = 0
    const refresh = () => {
      const zoom = map.getZoom()
      const extent = map.getBounds()
      const bounds = {
        west: Number(extent.getWest().toFixed(5)),
        south: Number(extent.getSouth().toFixed(5)),
        east: Number(extent.getEast().toFixed(5)),
        north: Number(extent.getNorth().toFixed(5)),
      }
      const minimumZoom = activeLayer === 'power' ? 13.5 : 13.2
      const queryKey = zoom < minimumZoom
        ? `${activeLayer}:below-scale`
        : `${activeLayer}:${zoom >= 16.2 ? 'street' : 'distribution'}:${Object.values(bounds).join(':')}`
      setUtilityViewportZoom(zoom)
      if (queryKey === lastQueryKey) return
      lastQueryKey = queryKey
      requestController?.abort()
      requestController = new AbortController()
      const sequence = ++requestSequence
      setUtilityDetail(null)
      setUtilityDetailLoading(zoom >= minimumZoom)
      setUtilityContextError(null)
      loadPublicUtilityViewport(
        activeLayer,
        bounds,
        zoom,
        requestController.signal,
      )
        .then((collection) => {
          if (sequence === requestSequence) setUtilityDetail(collection)
        })
        .catch((error: Error) => {
          if (sequence === requestSequence && error.name !== 'AbortError') {
            setUtilityContextError(error.message)
          }
        })
        .finally(() => {
          if (sequence === requestSequence) setUtilityDetailLoading(false)
        })
    }
    const scheduleRefresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(refresh, 180)
    }
    map.on('moveend', scheduleRefresh)
    refresh()
    return () => {
      map.off('moveend', scheduleRefresh)
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
      requestSequence += 1
      requestController?.abort()
    }
  }, [activeLayer, mapReady])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new MapLibreMap({
      container: containerRef.current,
      style: mapStyle,
      center: [5.33, 52.12],
      zoom: 6.25,
      minZoom: 5.35,
      maxZoom: 17.5,
      maxPitch: 75,
      maxBounds: NETHERLANDS_BOUNDS,
      attributionControl: false,
      pitchWithRotate: true,
      dragRotate: false,
      touchPitch: false,
      canvasContextAttributes: { antialias: true },
    })
    mapRef.current = map
    if (import.meta.env.DEV || navigator.webdriver) {
      ;(window as Window & { __resilienceMap?: MapLibreMap }).__resilienceMap = map
    }
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-left')
    map.addControl(new ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-left')
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right')

    map.on('load', () => {
      addSimulationLayers(map)
      const initialData = dataRef.current
      updateSource(map, 'municipalities-state', initialData.municipalities)
      updateSource(map, 'official-safety-regions', initialData.safetyRegions)
      updateSource(map, 'official-safety-region-label-points', initialData.safetyRegionLabels)
      updateSource(map, 'transport-roads', initialData.roads)
      updateSource(map, 'transport-rail', initialData.rail)
      updateSource(map, 'transport-stations', initialData.stations)
      updateSource(map, 'transit-bus', initialData.transitBus)
      updateSource(map, 'transit-urban-rail', initialData.transitUrbanRail)
      updateSource(map, 'transit-rail-services', initialData.transitRailServices)
      updateSource(map, 'transit-ferries', initialData.transitFerries)
      updateSource(map, 'official-road-situations', initialData.roadSituations)
      updateSource(map, 'official-traffic-cameras', initialData.trafficCameras)
      updateSource(map, 'official-knmi-weather-observations', initialData.weatherObservations)
      updateSource(map, 'official-knmi-weather-warnings', initialData.weatherWarnings)
      updateSource(map, 'official-water-assets', initialData.waterAssets)
      updateSource(map, 'official-government-services', initialData.governmentServices)
      updateSource(map, 'official-acute-care', initialData.acuteCare)
      updateSource(map, 'official-education-locations', initialData.educationLocations)
      updateSource(map, 'official-antenna-sites', initialData.antennaSites)
      updateSource(map, 'official-air-quality', initialData.airQuality)
      updateSource(map, 'official-knmi-seismic-events', initialData.seismicEvents)
      updateSource(map, 'official-waterinfo-observations', initialData.waterObservations)
      updateSource(map, 'official-waterinfo-forecast-water-levels', initialData.waterForecastLevels)
      updateSource(map, 'official-waterinfo-forecast-discharges', initialData.waterForecastDischarges)
      updateSource(map, 'official-nbnl-capacity-samples', initialData.capacitySamples)
      updateSource(map, 'official-power-backbone', initialData.powerBackbone)
      updateSource(map, 'official-power-detail', initialData.powerDetail)
      updateSource(map, 'official-gas-detail', initialData.gasDetail)
      updateSource(map, 'city-gateways', initialData.gateways)
      updateSource(map, 'city-operational-boundary', initialData.operationalBoundary)
      updateSource(map, 'national-routes', initialData.routes)
      updateSource(map, 'city-areas', initialData.areas)
      updateSource(map, 'city-places', initialData.places)
      updateSource(map, 'city-settlements', initialData.settlements)
      updateSource(map, 'city-links', initialData.links)
      updateSource(map, 'city-nodes', initialData.nodes)
      loadedRef.current = true
      if (modeRef.current === 'city') {
        const selected = municipalities.find((city) => city.code === selectedIdRef.current)
        if (selected) map.jumpTo({ center: selected.coordinates, zoom: 10.05 })
      }
      map.resize()
      setMapReady(true)
    })

    map.on('moveend', () => {
      const zoom = map.getZoom()
      setMapZoom(zoom)
      if (programmaticMoveRef.current) {
        programmaticMoveRef.current = false
        return
      }
      if (zoom >= DETAIL_ENTER_ZOOM) {
        const center = map.getCenter()
        const nearest = municipalities
          .map((city) => ({ city, distance: distanceKm([center.lng, center.lat], city.coordinates) }))
          .sort((a, b) => a.distance - b.distance)[0]
        if (
          nearest &&
          nearest.distance < 24 &&
          (modeRef.current !== 'city' || nearest.city.code !== selectedIdRef.current)
        ) {
          handlersRef.current.onSelectDistrict(null)
          handlersRef.current.onSelectMunicipality(nearest.city.code)
          handlersRef.current.onViewModeChange('city', nearest.city.code)
        }
      } else if (zoom <= DETAIL_EXIT_ZOOM && modeRef.current !== 'national') {
        handlersRef.current.onSelectDistrict(null)
        handlersRef.current.onViewModeChange('national')
      }
    })

    const interactiveLayers = ['city-nodes', 'city-service-areas', 'city-gateways', 'municipality-fill']
    map.on('mousemove', (event: MapMouseEvent) => {
      if (!loadedRef.current) return
      const features = map.queryRenderedFeatures(event.point, { layers: interactiveLayers })
      map.getCanvas().style.cursor = features.length ? 'pointer' : ''
    })
    map.on('click', (event: MapMouseEvent) => {
      if (!loadedRef.current) return
      const features = map.queryRenderedFeatures(event.point, { layers: interactiveLayers })
      const feature = features[0]
      if (!feature) return
      if (feature.layer.id === 'city-nodes' || feature.layer.id === 'city-service-areas') {
        handlersRef.current.onSelectDistrict(String(feature.properties.id))
        return
      }
      const code = String(feature.properties.code ?? feature.id ?? '')
      if (code) {
        handlersRef.current.onSelectMunicipality(code)
        handlersRef.current.onSelectDistrict(null)
      }
    })

    return () => {
      loadedRef.current = false
      if (import.meta.env.DEV || navigator.webdriver) {
        delete (window as Window & { __resilienceMap?: MapLibreMap }).__resilienceMap
      }
      map.remove()
      mapRef.current = null
      official3dLayersRef.current = []
      official3dLoadRef.current = null
      sourceDataRef.current.clear()
      featureStateRef.current.clear()
    }
  }, [municipalities, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const realistic = basemapMode === 'realistic'
    const aerial = basemapMode === 'aerial' || realistic
    const night = realistic ? realisticLighting.nightFactor : 0
    // Keep a dim cartographic fallback underneath realistic aerial imagery so
    // orthophoto coverage edges never turn into black tile-shaped holes.
    map.setLayoutProperty('pdok-grey', 'visibility', aerial && !realistic ? 'none' : 'visible')
    map.setLayoutProperty('pdok-aerial', 'visibility', aerial ? 'visible' : 'none')
    // BGT is a cartographic reference layer. Drawing it over the orthophoto
    // would make source dates and visual meaning needlessly ambiguous.
    map.setLayoutProperty('pdok-bgt-detail', 'visibility', aerial ? 'none' : 'visible')
    map.setPaintProperty(
      'background',
      'background-color',
      realistic
        ? night > 0.72
          ? '#01050b'
          : night > 0.08
            ? '#0b1420'
            : '#13272c'
        : '#0d1419',
    )
    map.setPaintProperty('pdok-aerial', 'raster-opacity', realistic ? 0.9 : 0.78)
    map.setPaintProperty('pdok-aerial', 'raster-saturation', realistic ? -0.05 - night * 0.7 : -0.12)
    map.setPaintProperty('pdok-aerial', 'raster-contrast', realistic ? 0.08 + night * 0.25 : 0.08)
    map.setPaintProperty('pdok-aerial', 'raster-brightness-min', realistic ? 0.07 - night * 0.05 : 0.08)
    map.setPaintProperty('pdok-aerial', 'raster-brightness-max', realistic ? 0.78 - night * 0.62 : 0.72)
    map.setPaintProperty('pdok-grey', 'raster-opacity', realistic ? 0.5 : 0.58)
    map.setPaintProperty('pdok-grey', 'raster-saturation', realistic ? -0.92 : -0.85)
    map.setPaintProperty('pdok-grey', 'raster-contrast', realistic ? 0.22 + night * 0.08 : 0.18)
    map.setPaintProperty('pdok-grey', 'raster-brightness-min', realistic ? 0.02 : 0.12)
    map.setPaintProperty('pdok-grey', 'raster-brightness-max', realistic ? 0.38 - night * 0.22 : 0.52)

    const realisticVisibility = realistic ? 'visible' : 'none'
    for (const layerId of ['realistic-power-outage-fill', 'realistic-power-outage-outline']) {
      map.setLayoutProperty(layerId, 'visibility', realisticVisibility)
    }
    map.setPaintProperty('realistic-power-outage-fill', 'fill-opacity', [
      '*',
      ['coalesce', ['feature-state', 'powerOutage'], 0],
      0.58 + night * 0.18,
    ])
    const lightsVisible = realistic && night > 0.025
    for (const layerId of ['realistic-city-light-glow', 'realistic-city-lights']) {
      map.setLayoutProperty(layerId, 'visibility', lightsVisible ? 'visible' : 'none')
    }
    map.setLayoutProperty(
      'realistic-settlement-lights',
      'visibility',
      lightsVisible && viewMode === 'city' ? 'visible' : 'none',
    )
    map.setPaintProperty('realistic-city-light-glow', 'circle-opacity', [
      '*',
      ['coalesce', ['feature-state', 'powerAvailability'], 1],
      night * 0.38,
    ])
    map.setPaintProperty('realistic-city-lights', 'circle-opacity', [
      '*',
      ['coalesce', ['feature-state', 'powerAvailability'], 1],
      night * 0.92,
    ])
    map.setPaintProperty(
      'realistic-settlement-lights',
      'fill-opacity',
      night * (0.04 + selectedPowerAvailability * 0.22),
    )
    map.setPaintProperty(
      'realistic-settlement-lights',
      'fill-outline-color',
      `rgba(255, 224, 156, ${Math.min(0.42, night * selectedPowerAvailability * 0.38).toFixed(3)})`,
    )
    map.triggerRepaint()
  }, [basemapMode, mapReady, realisticLighting.nightFactor, selectedPowerAvailability, viewMode])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const visibility = affectedOverlayEnabled ? 'visible' : 'none'
    for (const layerId of [
      'affected-region-overlay-fill',
      'affected-region-overlay-halo',
      'affected-region-overlay-outline',
      'affected-region-gateway-markers',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', visibility)
    }
    // This overlay always reads the complete national municipality source.
    // At country scale, slightly stronger fills make a dispersed event legible
    // without replacing municipality-level detail when the operator zooms in.
    const countryScale = mapZoom <= DETAIL_EXIT_ZOOM
    map.setPaintProperty('affected-region-overlay-fill', 'fill-opacity', [
      'match',
      ['feature-state', 'impactState'],
      'critical', ['+', countryScale ? 0.22 : 0.16, ['*', 0.08, ['global-state', 'selectionPulse']]],
      'affected', countryScale ? 0.17 : 0.12,
      'unsupported', countryScale ? 0.045 : 0.025,
      0,
    ])
  }, [affectedOverlayEnabled, mapReady, mapZoom])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const visibility = cameraOverlayEnabled ? 'visible' : 'none'
    for (const layerId of [
      'official-traffic-camera-clusters',
      'official-traffic-camera-cluster-counts',
      'official-traffic-camera-points',
      'official-traffic-camera-labels',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', visibility)
    }
  }, [cameraOverlayEnabled, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    if (perspectiveMode === '2d') {
      map.dragRotate.disable()
      map.touchPitch.disable()
      for (const layer of official3dLayersRef.current) layer.setVisible(false)
      setOfficial3dState(official3dLayersRef.current.length ? 'ready' : 'idle')
      if (map.getPitch() > 0.1 || Math.abs(map.getBearing()) > 0.1) {
        map.easeTo({
          pitch: 0,
          bearing: 0,
          duration: prefersReducedMotion ? 0 : 420,
          animate: !prefersReducedMotion,
        })
      }
      return
    }

    map.dragRotate.enable()
    map.touchPitch.enable()
    for (const layer of official3dLayersRef.current) layer.setVisible(true)

    if (mapZoom < OFFICIAL_3D_MIN_ZOOM) {
      setOfficial3dState('waiting-for-city')
      return
    }
    if (map.getPitch() < 38) {
      map.easeTo({
        pitch: 52,
        bearing: -14,
        duration: prefersReducedMotion ? 0 : 520,
        animate: !prefersReducedMotion,
      })
    }
    if (official3dLayersRef.current.length === 2) {
      setOfficial3dState((current) => current === 'unavailable' ? 'partial' : 'ready')
      return
    }
    if (official3dLoadRef.current) return

    setOfficial3dState('loading')
    setOfficial3dError(null)
    let loadedLayers = 0
    let failedLayers = 0
    const markLoaded = () => {
      loadedLayers += 1
      if (mapRef.current !== map) return
      setOfficial3dState(loadedLayers === 2 ? 'ready' : failedLayers ? 'partial' : 'loading')
    }
    const markFailed = (error: Error) => {
      failedLayers += 1
      if (mapRef.current !== map) return
      setOfficial3dError(error.message)
      setOfficial3dState(loadedLayers > 0 ? 'partial' : failedLayers >= 2 ? 'unavailable' : 'partial')
    }

    official3dLoadRef.current = Promise.all([
      import('maplibre-gl-3d-tiles'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js'),
    ])
      .then(([{ ThreeDTilesLayer: RuntimeThreeDTilesLayer }, { MeshoptDecoder }]) => {
        if (mapRef.current !== map || !map.getLayer('municipality-fill')) return
        const visible = perspectiveModeRef.current === '3d'
        const decoderOptions = {
          dracoDecoderPath: `${THREE_DECODER_ROOT}/draco/`,
          ktx2TranscoderPath: `${THREE_DECODER_ROOT}/basis/`,
        }
        const terrain = new RuntimeThreeDTilesLayer({
          ...decoderOptions,
          id: 'official-pdok-3d-terrain',
          tilesetUrl: PDOK_3D_TERRAIN_URL,
          altitudeOffset: 0,
          opacity: 0.48,
          visible: false,
          onLoad: markLoaded,
          onError: markFailed,
        })
        const buildings = new RuntimeThreeDTilesLayer({
          ...decoderOptions,
          id: 'official-pdok-3d-buildings',
          tilesetUrl: PDOK_3D_BUILDINGS_URL,
          altitudeOffset: 0,
          opacity: 0.94,
          visible: false,
          onLoad: markLoaded,
          onError: markFailed,
        })
        synchronizeThreeDTilesViewport(terrain)
        synchronizeThreeDTilesViewport(buildings)
        const addedLayers: ThreeDTilesLayer[] = []
        try {
          map.addLayer(terrain, 'municipality-fill')
          addedLayers.push(terrain)
          attachMeshoptDecoder(terrain, MeshoptDecoder)
          map.addLayer(buildings, 'municipality-fill')
          addedLayers.push(buildings)
          attachMeshoptDecoder(buildings, MeshoptDecoder)
          terrain.setVisible(visible)
          buildings.setVisible(visible)
          official3dLayersRef.current = [terrain, buildings]
        } catch (error) {
          for (const layer of addedLayers.reverse()) {
            if (map.getLayer(layer.id)) map.removeLayer(layer.id)
          }
          throw error
        }
      })
      .catch((error: unknown) => {
        markFailed(error instanceof Error ? error : new Error('Unable to initialize official 3D data'))
        official3dLoadRef.current = null
      })
  }, [mapReady, mapZoom, perspectiveMode, prefersReducedMotion])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'transport-roads', transport.roads)
    updateSource(map, 'transport-rail', transport.rail)
    updateSource(map, 'transport-stations', transport.stations)
  }, [transport.roads, transport.rail, transport.stations, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'transit-bus', transit?.bus ?? emptyCollection)
    updateSource(map, 'transit-urban-rail', transit?.urbanRail ?? emptyCollection)
    updateSource(map, 'transit-rail-services', transit?.railServices ?? emptyCollection)
    updateSource(map, 'transit-ferries', transit?.ferries ?? emptyCollection)
  }, [transit?.bus, transit?.urbanRail, transit?.railServices, transit?.ferries, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-road-situations', publicRoadSituations ?? emptyCollection)
  }, [publicRoadSituations, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-traffic-cameras', trafficCameras ?? emptyCollection)
  }, [trafficCameras, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-knmi-weather-observations', publicWeatherObservations ?? emptyCollection)
  }, [publicWeatherObservations, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-knmi-weather-warnings', publicWeatherWarnings ?? emptyCollection)
  }, [publicWeatherWarnings, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-water-assets', defaultWaterAssetData)
  }, [defaultWaterAssetData, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-government-services', publicFacilities ?? emptyCollection)
  }, [publicFacilities, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-acute-care', publicAcuteCare ?? emptyCollection)
  }, [publicAcuteCare, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-education-locations', publicEducationLocations ?? emptyCollection)
  }, [publicEducationLocations, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-antenna-sites', publicAntennaSites ?? emptyCollection)
  }, [publicAntennaSites, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-air-quality', publicAirQuality ?? emptyCollection)
  }, [publicAirQuality, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-knmi-seismic-events', publicSeismicEvents ?? emptyCollection)
  }, [publicSeismicEvents, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-waterinfo-observations', publicWaterObservations ?? emptyCollection)
  }, [publicWaterObservations, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-waterinfo-forecast-water-levels', waterForecastData.waterLevels)
    updateSource(map, 'official-waterinfo-forecast-discharges', waterForecastData.discharges)
  }, [mapReady, updateSource, waterForecastData])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-nbnl-capacity-samples', publicCapacityContext ?? emptyCollection)
  }, [publicCapacityContext, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-power-backbone', powerBackbone ?? emptyCollection)
  }, [powerBackbone, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(
      map,
      'official-power-detail',
      utilityDetail?.query.kind === 'power-detail' ? utilityDetail : emptyCollection,
    )
    updateSource(
      map,
      'official-gas-detail',
      utilityDetail?.query.kind === 'gas-detail' ? utilityDetail : emptyCollection,
    )
  }, [utilityDetail, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'official-safety-regions', safetyData.regions)
    updateSource(map, 'official-safety-region-label-points', safetyData.labels)
  }, [safetyData, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'city-gateways', gatewayGeometryData)
  }, [gatewayGeometryData, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateFeatureStates(map, 'municipalities-state', municipalityStates)
    updateFeatureStates(map, 'city-gateways', gatewayStates)
    updateFeatureStates(map, 'national-routes', routeStates)
  }, [municipalityStates, gatewayStates, routeStates, mapReady, updateFeatureStates])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'city-places', placeData)
    updateSource(map, 'city-settlements', settlementData)
    updateSource(map, 'city-operational-boundary', operationalBoundaryData)
  }, [placeData, settlementData, operationalBoundaryData, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    updateSource(map, 'city-areas', cityData.areas)
    updateSource(map, 'city-links', cityData.links)
    updateSource(map, 'city-nodes', cityData.nodes)
  }, [cityData, mapReady, updateSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const hazardProfile = hazardMotionProfile(frame)
    const flowActivity =
      (activeLayer === 'hazard' || activeLayer === 'population' ? 0 : 1) *
      (viewMode === 'city' ? 0.28 : 1)
    map.setGlobalStateProperty('hazardColor', hazardProfile.color)
    map.setGlobalStateProperty('hazardActivity', activeLayer === 'hazard' ? 1 : 0)
    map.setGlobalStateProperty('hazardEdgeActivity', hazardProfile.edgeActivity)
    map.setGlobalStateProperty('flowActivity', flowActivity)
    map.setGlobalStateProperty('signalActivity', activeLayer === 'population' ? 0.72 : 1)
    map.setGlobalStateProperty('gatewayActivity', viewMode === 'city' ? 0.2 : 1)

    const setMotionState = (timestamp: number, reduceMotion: boolean) => {
      if (reduceMotion) {
        map.setGlobalStateProperty('motionPulse', 0.58)
        map.setGlobalStateProperty('motionSecondary', 0.46)
        map.setGlobalStateProperty('selectionPulse', 0.56)
        map.setGlobalStateProperty('flowDash', [2, 2.5])
        map.setGlobalStateProperty('hazardDash', [2, 2.5])
        return
      }

      // Wall-clock motion is deliberately phase-shifted by the simulated minute.
      // Severity and flow magnitude still come only from the current model frame.
      const hazardPhase =
        ((timestamp + frame.minute * 37) % hazardProfile.periodMs) / hazardProfile.periodMs
      const flowFrame = Math.floor(
        timestamp / (110 / flowSpeedByLayer[activeLayer]) + frame.step * 0.7,
      ) % FLOW_DASH_FRAMES.length
      const hazardFrame = Math.floor(
        timestamp / Math.max(115, hazardProfile.periodMs / FLOW_DASH_FRAMES.length) + frame.step * 0.35,
      ) % FLOW_DASH_FRAMES.length
      const selectionWave =
        (Math.sin(timestamp / 620 + frame.step * 0.035 - Math.PI / 2) + 1) / 2

      map.setGlobalStateProperty('motionPulse', motionPulse(hazardProfile, hazardPhase))
      map.setGlobalStateProperty(
        'motionSecondary',
        motionPulse(hazardProfile, (hazardPhase + 0.3) % 1),
      )
      map.setGlobalStateProperty('selectionPulse', 0.2 + selectionWave * 0.8)
      map.setGlobalStateProperty('flowDash', FLOW_DASH_FRAMES[flowFrame])
      map.setGlobalStateProperty(
        'hazardDash',
        FLOW_DASH_FRAMES[(FLOW_DASH_FRAMES.length - 1 - hazardFrame) % FLOW_DASH_FRAMES.length],
      )
    }

    if (prefersReducedMotion || animationsPaused || !pageVisible) {
      setMotionState(0, true)
      return
    }

    let animationFrame = 0
    let lastUpdate = -Infinity
    const animate = (timestamp: number) => {
      if (timestamp - lastUpdate >= MOTION_UPDATE_INTERVAL_MS) {
        lastUpdate = timestamp
        setMotionState(timestamp, false)
      }
      animationFrame = window.requestAnimationFrame(animate)
    }
    animationFrame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [activeLayer, frame, mapReady, prefersReducedMotion, viewMode, animationsPaused, pageVisible])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || viewCommand.nonce === 0) return
    programmaticMoveRef.current = true
    if (viewCommand.mode === 'national') {
      map.flyTo({
        center: [5.33, 52.12],
        zoom: 6.25,
        duration: prefersReducedMotion ? 0 : 900,
        animate: !prefersReducedMotion,
      })
      return
    }
    const municipality = municipalities.find((city) => city.code === viewCommand.municipalityId)
    if (municipality) {
      map.flyTo({
        center: municipality.coordinates,
        zoom: 10.05,
        duration: prefersReducedMotion ? 0 : 1_050,
        animate: !prefersReducedMotion,
      })
    }
  }, [viewCommand, municipalities, mapReady, prefersReducedMotion])

  useEffect(() => {
    const map = mapRef.current
    if (!selectedDistrictId) {
      centeredDistrictRef.current = null
      return
    }
    if (
      !map ||
      !mapReady ||
      !cityDetail ||
      centeredDistrictRef.current === selectedDistrictId
    ) return
    const district = cityDetail.districts.find((item) => item.id === selectedDistrictId)
    if (district) {
      centeredDistrictRef.current = selectedDistrictId
      programmaticMoveRef.current = true
      map.easeTo({
        center: district.coordinates,
        duration: prefersReducedMotion ? 0 : 450,
        animate: !prefersReducedMotion,
      })
    }
  }, [selectedDistrictId, cityDetail, mapReady, prefersReducedMotion])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const nationalFactor = viewMode === 'city' ? 0.24 : 1
    map.setPaintProperty('municipality-fill', 'fill-opacity', [
      '*',
      ['coalesce', ['feature-state', 'opacity'], 0.2],
      viewMode === 'city' ? 0.42 : 1,
      basemapMode === 'realistic' ? 0.46 : basemapMode === 'aerial' ? 0.72 : 1,
      perspectiveMode === '3d' ? 0.58 : 1,
    ])
    const outlineFactor = viewMode === 'city' ? 0.48 : 1
    map.setPaintProperty('municipality-outline', 'line-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      5,
      0.65 * outlineFactor,
      9,
      0.95 * outlineFactor,
    ])
    for (const layerId of ['route-casing', 'national-route-lines']) {
      map.setPaintProperty(layerId, 'line-opacity', [
        '*',
        ['coalesce', ['feature-state', 'opacity'], 0],
        nationalFactor,
      ])
    }
    for (const [layerId, direction] of [
      ['route-flow-arrows', 1],
      ['route-flow-arrows-reverse', -1],
    ] as const) {
      map.setPaintProperty(layerId, 'text-opacity', [
        '*',
        ['case', ['==', ['feature-state', 'flowDirection'], direction], 1, 0],
        ['coalesce', ['feature-state', 'opacity'], 0],
        nationalFactor,
        ['global-state', 'flowActivity'],
        ['+', 0.54, ['*', 0.46, ['global-state', 'motionSecondary']]],
      ])
    }
    const realisticNight = basemapMode === 'realistic' ? realisticLighting.nightFactor : 0
    map.setPaintProperty(
      'city-gateway-halo',
      'circle-opacity',
      (viewMode === 'city' ? 0.035 : 0.14) * (1 - realisticNight * 0.76),
    )
    const gatewayFactor = (viewMode === 'city' ? 0.28 : 1) * (1 - realisticNight * 0.7)
    map.setPaintProperty('city-gateways', 'circle-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      5,
      0.9 * gatewayFactor,
      9,
      0.45 * gatewayFactor,
    ])
    map.setLayoutProperty('city-gateway-labels', 'visibility', viewMode === 'city' ? 'none' : 'visible')
    map.setLayoutProperty('selected-gateway-label', 'visibility', viewMode === 'city' ? 'none' : 'visible')
    map.setPaintProperty(
      'city-gateway-labels',
      'text-color',
      realisticNight > 0.3 ? '#ead9b7' : '#eaf4f5',
    )
  }, [basemapMode, perspectiveMode, realisticLighting.nightFactor, viewMode, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const transportFocus = activeLayer === 'mobility' || activeLayer === 'supply'
    map.setPaintProperty('official-road-network', 'line-opacity', transportFocus ? 0.88 : 0.3)
    map.setPaintProperty('official-rail-network', 'line-opacity', transportFocus ? 0.8 : 0.32)
    map.setPaintProperty('official-stations', 'circle-opacity', transportFocus ? 0.92 : 0.56)
    map.setPaintProperty('official-station-labels', 'text-opacity', transportFocus ? 1 : 0.58)
    map.setPaintProperty('scheduled-bus-routes', 'line-opacity', transportFocus ? 0.5 : 0.06)
    map.setPaintProperty('scheduled-urban-rail-routes', 'line-opacity', transportFocus ? 0.82 : 0.14)
    map.setPaintProperty('scheduled-rail-services', 'line-opacity', transportFocus ? 0.55 : 0.1)
    map.setPaintProperty('scheduled-ferry-routes', 'line-opacity', transportFocus ? 0.8 : 0.18)
    const roadSituationVisibility = roadSituationOverlayEnabled ? 'visible' : 'none'
    for (const layerId of [
      'official-road-situation-lines',
      'official-road-situation-points',
      'official-road-congestion-lines',
      'official-road-accident-halos',
      'official-road-accident-points',
      'official-road-accident-symbols',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', roadSituationVisibility)
    }
    const waterFocus = activeLayer === 'water' || activeLayer === 'drainage'
    map.setLayoutProperty(
      'official-water-management-areas',
      'visibility',
      waterFocus ? 'visible' : 'none',
    )
    for (const layerId of [
      'official-wastewater-damo-lines',
      'official-wastewater-gwsw-lines',
      'official-water-asset-clusters',
      'official-water-asset-cluster-counts',
      'official-water-asset-points',
      'official-water-asset-labels',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', waterFocus ? 'visible' : 'none')
    }
    const groundwaterRegistrationFocus =
      waterFocus ||
      (activeLayer === 'hazard' &&
        (['pluvial-flood', 'river-flood', 'coastal-flood', 'heatwave', 'wildfire'].includes(
          frame.scenario.disaster,
        ) ||
          (frame.scenario.disaster === 'compound' &&
            frame.scenario.components?.some((component) =>
              ['pluvial-flood', 'river-flood', 'coastal-flood', 'heatwave', 'wildfire'].includes(
                component,
              )))))
    map.setLayoutProperty(
      'official-bro-groundwater-monitoring',
      'visibility',
      groundwaterRegistrationFocus ? 'visible' : 'none',
    )
    const floodContextFocus =
      activeLayer === 'hazard' &&
      (frame.scenario.disaster === 'river-flood' || frame.scenario.disaster === 'coastal-flood')
    map.setLayoutProperty(
      'official-flood-risk-areas',
      'visibility',
      floodContextFocus ? 'visible' : 'none',
    )
    map.setLayoutProperty(
      'official-liwo-breach-locations',
      'visibility',
      floodContextFocus ? 'visible' : 'none',
    )
    map.setLayoutProperty(
      'official-water-defences',
      'visibility',
      floodContextFocus ? 'visible' : 'none',
    )
    const pluvialDepthContextFocus =
      activeLayer === 'hazard' &&
      (frame.scenario.disaster === 'pluvial-flood' ||
        (frame.scenario.disaster === 'compound' &&
          frame.scenario.components?.includes('pluvial-flood')))
    map.setLayoutProperty(
      'official-pluvial-depth-scenario',
      'visibility',
      pluvialDepthContextFocus ? 'visible' : 'none',
    )
    const floodTerrainContextFocus =
      activeLayer === 'hazard' &&
      (['pluvial-flood', 'river-flood', 'coastal-flood'].includes(frame.scenario.disaster) ||
        (frame.scenario.disaster === 'compound' &&
          frame.scenario.components?.some((component) =>
            ['pluvial-flood', 'river-flood', 'coastal-flood'].includes(component))))
    map.setLayoutProperty(
      'official-ahn-terrain',
      'visibility',
      floodTerrainContextFocus ? 'visible' : 'none',
    )
    const externalSafetyFocus = activeLayer === 'hazard'
    map.setLayoutProperty(
      'official-rev-attention-areas',
      'visibility',
      externalSafetyFocus ? 'visible' : 'none',
    )
    map.setLayoutProperty(
      'official-rev-risk-activities',
      'visibility',
      externalSafetyFocus ? 'visible' : 'none',
    )
    map.setLayoutProperty(
      'official-rev-pipelines',
      'visibility',
      activeLayer === 'gas' ? 'visible' : 'none',
    )
    map.setLayoutProperty(
      'official-rev-basisnet',
      'visibility',
      activeLayer === 'mobility' || activeLayer === 'supply' ? 'visible' : 'none',
    )
    map.setLayoutProperty(
      'official-fis-waterways',
      'visibility',
      activeLayer === 'mobility' || activeLayer === 'supply' ? 'visible' : 'none',
    )
    const precipitationContextFocus =
      activeLayer === 'hazard' &&
      ['severe-storm', 'pluvial-flood', 'compound'].includes(frame.scenario.disaster)
    map.setLayoutProperty(
      'official-knmi-radar-observation',
      'visibility',
      precipitationContextFocus && frame.hour === 0 ? 'visible' : 'none',
    )
    const precipitationForecastCheckpoint = publicPrecipitationProbabilityContext
      ? nearestPrecipitationProbabilityCheckpoint(
          publicPrecipitationProbabilityContext,
          frame.hour,
        )
      : null
    for (const leadHours of [1, 3, 6] as const) {
      map.setLayoutProperty(
        `official-knmi-precipitation-probability-t-plus-${leadHours}`,
        'visibility',
        precipitationContextFocus && precipitationForecastCheckpoint?.leadHours === leadHours
          ? 'visible'
          : 'none',
      )
    }
    const weatherObservationMode = activeLayer !== 'hazard'
      ? null
      : frame.scenario.disaster === 'severe-storm' ||
          frame.scenario.disaster === 'coastal-flood' ||
          frame.scenario.disaster === 'winter-storm'
        ? 'wind'
        : frame.scenario.disaster === 'pluvial-flood' || frame.scenario.disaster === 'river-flood'
          ? 'rain'
          : frame.scenario.disaster === 'heatwave' || frame.scenario.disaster === 'wildfire'
            ? 'temperature'
            : frame.scenario.disaster === 'compound'
              ? frame.scenario.components?.some((component) =>
                  component === 'severe-storm' ||
                  component === 'coastal-flood' ||
                  component === 'winter-storm')
                ? 'wind'
                : frame.scenario.components?.some((component) =>
                    component === 'pluvial-flood' || component === 'river-flood')
                  ? 'rain'
                  : 'temperature'
              : null
    for (const mode of ['wind', 'rain', 'temperature'] as const) {
      for (const suffix of ['points', 'labels'] as const) {
        map.setLayoutProperty(
          `official-knmi-weather-${mode}-${suffix}`,
          'visibility',
          weatherObservationMode === mode ? 'visible' : 'none',
        )
      }
    }
    const weatherWarningFocus =
      activeLayer === 'hazard' &&
      viewMode === 'national' &&
      frame.scenario.disaster !== 'cyberattack' &&
      frame.scenario.disaster !== 'earthquake'
    for (const layerId of ['official-knmi-warning-fill', 'official-knmi-warning-outline']) {
      map.setLayoutProperty(layerId, 'visibility', weatherWarningFocus ? 'visible' : 'none')
    }
    const smokeContextFocus =
      activeLayer === 'hazard' &&
      (frame.scenario.disaster === 'wildfire' ||
        (frame.scenario.disaster === 'compound' && frame.scenario.components?.includes('wildfire')))
    for (const layerId of [
      'official-air-quality-halos',
      'official-air-quality-points',
      'official-air-quality-labels',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', smokeContextFocus ? 'visible' : 'none')
    }
    map.setLayoutProperty(
      'official-combustible-nature-areas',
      'visibility',
      smokeContextFocus ? 'visible' : 'none',
    )
    const agriculturalParcelFocus =
      activeLayer === 'supply' ||
      (activeLayer === 'hazard' &&
        (frame.scenario.disaster === 'heatwave' ||
          frame.scenario.disaster === 'wildfire' ||
          (frame.scenario.disaster === 'compound' &&
            frame.scenario.components?.some((component) =>
              component === 'heatwave' || component === 'wildfire'))))
    map.setLayoutProperty(
      'official-agricultural-parcels',
      'visibility',
      agriculturalParcelFocus ? 'visible' : 'none',
    )
    const seismicEventFocus =
      activeLayer === 'hazard' &&
      (frame.scenario.disaster === 'earthquake' ||
        (frame.scenario.disaster === 'compound' &&
          frame.scenario.components?.includes('earthquake')))
    for (const layerId of [
      'official-knmi-seismic-event-halos',
      'official-knmi-seismic-event-points',
      'official-knmi-seismic-event-labels',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', seismicEventFocus ? 'visible' : 'none')
    }
    const waterInfoLevelFocus =
      activeLayer === 'water' ||
      (activeLayer === 'hazard' &&
        (frame.scenario.disaster === 'river-flood' || frame.scenario.disaster === 'coastal-flood'))
    for (const layerId of [
      'official-waterinfo-level-warnings',
      'official-waterinfo-water-levels',
      'official-waterinfo-water-level-labels',
      'official-waterinfo-forecast-water-level-warnings',
      'official-waterinfo-forecast-water-levels',
      'official-waterinfo-forecast-water-level-labels',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', waterInfoLevelFocus ? 'visible' : 'none')
    }
    const waterInfoDischargeFocus =
      activeLayer === 'water' ||
      (activeLayer === 'hazard' && frame.scenario.disaster === 'river-flood')
    for (const layerId of [
      'official-waterinfo-discharge-warnings',
      'official-waterinfo-discharges',
      'official-waterinfo-discharge-labels',
      'official-waterinfo-forecast-discharge-warnings',
      'official-waterinfo-forecast-discharges',
      'official-waterinfo-forecast-discharge-labels',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', waterInfoDischargeFocus ? 'visible' : 'none')
    }
    for (const discipline of ['power', 'gas', 'water', 'drainage', 'telecom'] as const) {
      map.setLayoutProperty(
        `official-provider-area-${discipline}`,
        'visibility',
        activeLayer === discipline ? 'visible' : 'none',
      )
    }
    for (const layerId of [
      'official-antenna-site-clusters',
      'official-antenna-site-cluster-counts',
      'official-antenna-site-points',
      'official-antenna-site-labels',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', activeLayer === 'telecom' ? 'visible' : 'none')
    }
    const facilityFocus = activeLayer === 'facilities'
    const realisticBuildingLights =
      basemapMode === 'realistic' && realisticLighting.nightFactor > 0.025
    const buildingContextFocus =
      viewMode === 'city' &&
      perspectiveMode === '2d' &&
      (activeLayer === 'hazard' || activeLayer === 'population' || facilityFocus || realisticBuildingLights)
    for (const layerId of ['official-bag-building-fill', 'official-bag-building-outline']) {
      map.setLayoutProperty(layerId, 'visibility', buildingContextFocus ? 'visible' : 'none')
    }
    map.setPaintProperty(
      'official-bag-building-fill',
      'fill-color',
      realisticBuildingLights ? '#ffd27d' : '#a9cae8',
    )
    map.setPaintProperty(
      'official-bag-building-fill',
      'fill-opacity',
      realisticBuildingLights
        ? realisticLighting.nightFactor * (0.04 + selectedPowerAvailability * 0.3)
        : 0.14,
    )
    map.setPaintProperty(
      'official-bag-building-outline',
      'line-color',
      realisticBuildingLights ? '#ffe9b1' : '#d8ebfb',
    )
    map.setPaintProperty(
      'official-bag-building-outline',
      'line-opacity',
      realisticBuildingLights
        ? realisticLighting.nightFactor * (0.08 + selectedPowerAvailability * 0.58)
        : 0.52,
    )
    for (const layerId of [
      'official-government-service-clusters',
      'official-government-service-cluster-counts',
      'official-government-service-points',
      'official-education-location-clusters',
      'official-education-location-cluster-counts',
      'official-education-location-points',
      'official-education-location-labels',
      'official-acute-care-points',
      'official-acute-care-labels',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', facilityFocus ? 'visible' : 'none')
    }
    const powerFocus = activeLayer === 'power'
    for (const layerId of [
      'official-national-overhead-high-voltage-lines',
      'official-zuid-holland-electricity-stations',
      'official-nbnl-capacity-sample-halos',
      'official-nbnl-capacity-sample-points',
      'official-power-high-underground',
      'official-power-high-overhead',
      'official-power-high-stations',
      'official-power-distribution-lines',
      'official-power-distribution-stations',
    ]) {
      map.setLayoutProperty(layerId, 'visibility', powerFocus ? 'visible' : 'none')
    }
    map.setLayoutProperty(
      'official-gas-pipes',
      'visibility',
      activeLayer === 'gas' ? 'visible' : 'none',
    )
    map.setLayoutProperty(
      'official-gas-replacement-pipes',
      'visibility',
      activeLayer === 'gas' ? 'visible' : 'none',
    )
  }, [
    activeLayer,
    basemapMode,
    frame.hour,
    frame.scenario.components,
    frame.scenario.disaster,
    mapReady,
    perspectiveMode,
    publicPrecipitationProbabilityContext,
    realisticLighting.nightFactor,
    roadSituationOverlayEnabled,
    selectedPowerAvailability,
    viewMode,
  ])

  const utilityContextMessage = (() => {
    if (activeLayer !== 'power' && activeLayer !== 'gas') return null
    if (utilityContextError) return `Official DSO geometry unavailable · ${utilityContextError}`
    if (activeLayer === 'power') {
      if (powerBackboneLoading || !powerBackbone) return 'Loading official Liander high-voltage context…'
      const backboneCount = powerBackbone.loadedFeatureCount.toLocaleString('en-NL')
      const backbonePartial = powerBackbone.failures.length
        ? ' · partial response: Liander layer unavailable'
        : ''
      if (utilityDetailLoading) {
        return `${backboneCount} high-voltage assets · loading visible distribution geometry…${backbonePartial}`
      }
      if (utilityViewportZoom < 13.5 || !utilityDetail) {
        return `${backboneCount} Liander backbone assets · zoom to 13.5+ for Liander + Stedin distribution geometry${backbonePartial}`
      }
      const loaded = utilityDetail.loadedFeatureCount.toLocaleString('en-NL')
      const available = utilityDetail.availableFeatureCount.toLocaleString('en-NL')
      const partial = utilityDetail.failures.length
        ? ` · partial response: ${[...new Set(utilityDetail.failures.map((failure) => failure.publisher))].join(' + ')} layer unavailable`
        : ''
      return utilityDetail.truncated
        ? `${backboneCount} backbone + ${loaded} / ${available} visible distribution records · capped; zoom in${backbonePartial}${partial}`
        : `${backboneCount} backbone + ${loaded} visible distribution records · official context${backbonePartial}${partial}`
    }
    if (utilityDetailLoading) return 'Loading visible Liander pipe + Stedin gas-replacement context…'
    if (utilityViewportZoom < 13.2 || !utilityDetail) {
      return 'Official Liander + Stedin gas context · zoom to 13.2+ to query the visible street-scale extent'
    }
    const loaded = utilityDetail.loadedFeatureCount.toLocaleString('en-NL')
    const available = utilityDetail.availableFeatureCount.toLocaleString('en-NL')
    const partial = utilityDetail.failures.length
      ? ` · partial response: ${[...new Set(utilityDetail.failures.map((failure) => failure.publisher))].join(' + ')} layer unavailable`
      : ''
    return utilityDetail.truncated
      ? `${loaded} / ${available} visible DSO gas-context records · capped; zoom in for completeness${partial}`
      : `${loaded} visible DSO gas-context records · pipe/replacement context, not live flow or outage state${partial}`
  })()

  const waterForecastContextMessage = (() => {
    const relevant =
      activeLayer === 'water' ||
      (activeLayer === 'hazard' &&
        (frame.scenario.disaster === 'river-flood' || frame.scenario.disaster === 'coastal-flood'))
    if (!relevant) return null
    if (!publicWaterForecasts) return 'Loading issued Rijkswaterstaat Waterinfo forecast context…'
    const snapshots = publicWaterForecasts.snapshots.filter(
      (snapshot) => snapshot.requestedLeadEndHours === waterForecastCheckpoint,
    )
    const levels = snapshots.find((snapshot) => snapshot.forecastType === 'water-level')?.returnedFeatures ?? 0
    const includeDischarge = activeLayer === 'water' || frame.scenario.disaster === 'river-flood'
    const discharges = snapshots.find((snapshot) => snapshot.forecastType === 'discharge')?.returnedFeatures ?? 0
    if (levels === 0 && (!includeDischarge || discharges === 0)) {
      return `Issued Waterinfo +${waterForecastCheckpoint}h · no point coverage · NoData, not zero`
    }
    const dischargeCopy = includeDischarge ? ` · ${discharges} discharge` : ''
    return `Issued Waterinfo +${waterForecastCheckpoint}h · ${levels} level${dischargeCopy} points · context, not exercise forcing`
  })()
  const mapContextMessage = utilityContextMessage ?? waterForecastContextMessage
  const simulationTimeLabel = formatSimulationTime(frame.step)
  const roadSituationStatusLabel = (() => {
    if (!roadSituationOverlayEnabled) return 'Auto on Mobility + Supply'
    if (publicRoadSituationsError) return 'NDW unavailable · Unknown'
    if (!publicRoadSituations) return 'Loading current NDW feed…'
    return `${roadSituationSummary.accidents.toLocaleString('en-NL')} accidents · ${roadSituationSummary.congestion.toLocaleString('en-NL')} congestion`
  })()
  const roadSituationPublicationLabel = (() => {
    if (!publicRoadSituations) return null
    const timestamp = new Date(publicRoadSituations.source.publicationTime)
    const observedAt = Number.isNaN(timestamp.getTime())
      ? publicRoadSituations.source.publicationTime
      : timestamp.toLocaleString('en-GB', {
          timeZone: 'Europe/Amsterdam',
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
    const deliveryLabel = (() => {
      switch (publicRoadSituations.source.deliveryMode) {
        case 'live-server-proxy':
          return `server-refreshed current picture every ${publicRoadSituations.source.refreshIntervalSeconds ?? 60}s`
        case 'live-server-proxy-stale':
          return 'last live response · refresh failed · freshness Unknown'
        case 'deployment-snapshot-fallback':
          return 'deployment snapshot fallback · live refresh unavailable'
        default:
          return 'deployment snapshot'
      }
    })()
    return `NDW ${observedAt} · ${roadSituationSummary.total.toLocaleString('en-NL')} real DATEX II records · ${deliveryLabel} · observed context, not a 72-hour forecast`
  })()
  const roadSituationFreshnessUnknown = Boolean(
    publicRoadSituationsError ||
    publicRoadSituations?.source.deliveryMode === 'live-server-proxy-stale' ||
    publicRoadSituations?.source.deliveryMode === 'deployment-snapshot-fallback',
  )
  const cameraStatusLabel = (() => {
    if (!cameraOverlayEnabled) return 'Connector ready'
    if (cameraLoadError) return 'Registry unavailable · Unknown'
    if (!trafficCameras) return 'Loading registry contract…'
    if (trafficCameras.feedState === 'not-configured') return 'No authorized feed · Unknown'
    return `${trafficCameras.features.length.toLocaleString('en-NL')} inventory locations`
  })()
  const official3dStatusLabel = (() => {
    if (official3dState === 'waiting-for-city') return 'Zooming to city scale before loading 3D…'
    if (official3dState === 'loading') return 'Loading PDOK terrain + buildings…'
    if (official3dState === 'ready') return 'PDOK terrain + buildings · annual source data'
    if (official3dState === 'partial') return `Partial 3D response · ${official3dError ?? 'one collection unavailable'}`
    if (official3dState === 'unavailable') return `3D unavailable · ${official3dError ?? 'source error'}`
    return 'Loads official data at city scale'
  })()

  const choosePerspective = (next: PerspectiveMode) => {
    setPerspectiveMode(next)
    if (next !== '3d') return
    const map = mapRef.current
    if (!map || map.getZoom() >= OFFICIAL_3D_MIN_ZOOM) return
    const selected = municipalities.find((municipality) => municipality.code === selectedMunicipalityId)
    if (!selected) return
    programmaticMoveRef.current = true
    handlersRef.current.onSelectDistrict(null)
    handlersRef.current.onViewModeChange('city', selected.code)
    map.easeTo({
      center: selected.coordinates,
      zoom: 13.25,
      pitch: 52,
      bearing: -14,
      duration: prefersReducedMotion ? 0 : 760,
      animate: !prefersReducedMotion,
    })
  }

  return (
    <div className={`map-shell${basemapMode === 'realistic' ? ' realistic-view' : ''}`}>
      <div
        ref={containerRef}
        className="map-canvas"
        role="region"
        tabIndex={0}
        aria-label={`Interactive Netherlands map · ${layerById[activeLayer].label}`}
        aria-describedby="map-keyboard-instructions"
      />
      {basemapMode === 'realistic' && (
        <div
          className="realistic-atmosphere"
          aria-hidden="true"
          style={{
            '--sun-azimuth': `${realisticLighting.azimuthDegrees}deg`,
            '--sun-wash-alpha': realisticLighting.daylightBand === 'twilight'
              ? 0.16
              : Math.max(0.015, (1 - realisticLighting.nightFactor) * 0.085),
            '--night-wash-alpha': realisticLighting.nightFactor * 0.2,
          } as CSSProperties}
        />
      )}
      <span id="map-keyboard-instructions" className="visually-hidden">
        Use the municipality chooser for a nonvisual location selection. Use the layer controls to
        change the mapped service and the timeline checkpoints to change time.
      </span>
      <section
        className={`map-view-controls panel${mobileMapControlsOpen ? ' mobile-expanded' : ''}`}
        aria-label="Map view and context overlays"
      >
        <button
          type="button"
          className="map-view-mobile-toggle"
          aria-expanded={mobileMapControlsOpen}
          aria-label={`${mobileMapControlsOpen ? 'Close' : 'Open'} map view and overlays`}
          onClick={() => setMobileMapControlsOpen((current) => !current)}
        >
          <span>Map tools</span>
          <span aria-hidden="true">{mobileMapControlsOpen ? '×' : '+'}</span>
        </button>
        <header>
          <strong>Map view</strong>
          <small>{
            basemapMode === 'realistic'
              ? `${realisticLighting.daylightBand} · ${realisticLighting.localTime} NL`
              : basemapMode === 'aerial'
                ? 'PDOK orthophoto · not live'
                : 'PDOK cartography'
          }</small>
        </header>
        <div className="map-view-segment basemap-segment" role="group" aria-label="Basemap">
          <button
            type="button"
            className={basemapMode === 'cartographic' ? 'active' : ''}
            aria-pressed={basemapMode === 'cartographic'}
            aria-label="Use cartographic basemap"
            onClick={() => setBasemapMode('cartographic')}
          >
            Map
          </button>
          <button
            type="button"
            className={basemapMode === 'aerial' ? 'active' : ''}
            aria-pressed={basemapMode === 'aerial'}
            aria-label="Use official aerial imagery basemap"
            onClick={() => setBasemapMode('aerial')}
          >
            Aerial
          </button>
          <button
            type="button"
            className={basemapMode === 'realistic' ? 'active' : ''}
            aria-pressed={basemapMode === 'realistic'}
            aria-label="Use sun-synchronised realistic basemap"
            onClick={() => setBasemapMode('realistic')}
          >
            Realistic
          </button>
        </div>
        <div className="map-view-segment" role="group" aria-label="Map perspective">
          <button
            type="button"
            className={perspectiveMode === '2d' ? 'active' : ''}
            aria-pressed={perspectiveMode === '2d'}
            aria-label="Use flat 2D map"
            onClick={() => choosePerspective('2d')}
          >
            2D
          </button>
          <button
            type="button"
            className={perspectiveMode === '3d' ? 'active' : ''}
            aria-pressed={perspectiveMode === '3d'}
            aria-label="Use official 3D buildings and terrain"
            onClick={() => choosePerspective('3d')}
          >
            3D
          </button>
        </div>
        <button
          type="button"
          className={`map-overlay-switch affected${affectedOverlayEnabled ? ' active' : ''}`}
          aria-pressed={affectedOverlayEnabled}
          aria-label="Toggle affected regions overlay"
          onClick={() => setAffectedOverlayEnabled((current) => !current)}
        >
          <span>Affected regions</span>
          <small>{impactSummary.affected} affected · {impactSummary.critical} critical · nationwide</small>
        </button>
        <button
          type="button"
          className={`map-overlay-switch traffic${roadSituationOverlayEnabled ? ' active' : ''}`}
          aria-pressed={roadSituationOverlayEnabled}
          aria-label="Toggle observed traffic and accidents overlay"
          onClick={() => {
            const nextEnabled = !roadSituationOverlayEnabled
            setRoadSituationOverlayPreference(nextEnabled ? 'on' : 'off')
            if (nextEnabled) onRequestRoadSituations()
          }}
        >
          <span>Traffic + accidents</span>
          <small>{roadSituationStatusLabel}</small>
        </button>
        <button
          type="button"
          className={`map-overlay-switch cameras${cameraOverlayEnabled ? ' active' : ''}`}
          aria-pressed={cameraOverlayEnabled}
          aria-label="Toggle traffic camera overlay"
          onClick={() => setCameraOverlayEnabled((current) => !current)}
        >
          <span>Traffic cameras</span>
          <small>{cameraStatusLabel}</small>
        </button>
        {affectedOverlayEnabled && (
          <div className="affected-overlay-key" aria-label={`Affected-region status at ${simulationTimeLabel}`}>
            <strong>{simulationTimeLabel} · all NL</strong>
            <span><i className="affected" />Affected</span>
            <span><i className="critical" />Critical</span>
            {impactSummary.unsupported > 0 && (
              <span><i className="unsupported" />Unknown {impactSummary.unsupported}</span>
            )}
          </div>
        )}
        {basemapMode === 'realistic' && (
          <p className="map-source-status realistic" role="status">
            {realisticLighting.daylightBand === 'daylight'
              ? 'Daylight'
              : realisticLighting.daylightBand === 'twilight'
                ? 'Twilight'
                : 'Night'} · {realisticLighting.localDate} {realisticLighting.localTime} NL · sun {realisticLighting.elevationDegrees.toFixed(1)}° · {realisticLighting.usesScenarioDate ? 'scenario-date solar model' : `${frame.scenario.season} reference-day solar model`} · lights and local darkness follow simulated power availability
          </p>
        )}
        {roadSituationOverlayEnabled && (
          <div className="traffic-overlay-key" aria-label="Observed traffic and accident status">
            <span><i className="accident" />Accident</span>
            <span><i className="congestion" />Congestion</span>
            <span><i className="incident" />Other incident</span>
          </div>
        )}
        {roadSituationOverlayEnabled && (publicRoadSituationsError || roadSituationPublicationLabel) && (
          <p className={`map-source-status ${roadSituationFreshnessUnknown ? 'unknown' : ''}`} role="status">
            {publicRoadSituationsError
              ? `NDW traffic/incident data unavailable · Unknown · ${publicRoadSituationsError}`
              : roadSituationPublicationLabel}
          </p>
        )}
        {perspectiveMode === '3d' && (
          <p className={`map-source-status ${official3dState}`} role="status">
            {official3dStatusLabel} · <a
              href="https://www.pdok.nl/introductie/-/article/3d-basisvoorziening-1"
              target="_blank"
              rel="noreferrer"
            >source</a>
          </p>
        )}
        {cameraOverlayEnabled && trafficCameras?.feedState === 'not-configured' && (
          <p className="map-source-status unknown" role="status">
            Empty means not configured, never zero cameras or clear roads.
          </p>
        )}
      </section>
      <div className="map-fidelity-badge">
        <span className="fidelity-dot" />
        Official geography, transport & public assets · logical service transfers · scenario impacts
      </div>
      {mapContextMessage && (
        <div
          className={`map-utility-badge${utilityContextMessage && utilityContextError ? ' error' : ''}`}
          role="status"
          aria-live="polite"
        >
          <span className="fidelity-dot" />
          {mapContextMessage}
        </div>
      )}
      <div className="map-layer-title" style={{ '--layer-accent': layerById[activeLayer].color } as CSSProperties}>
        <span>{layerById[activeLayer].label}</span>
        <small>{layerById[activeLayer].metric}</small>
      </div>
    </div>
  )
}
