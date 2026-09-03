/// <reference lib="webworker" />

import {
  createSimulationSession,
  type LayerId,
  type MunicipalityDefinition,
  type RouteDefinition,
  type ScenarioConfig,
  type Season,
  type ServiceId,
  type SimulationFrame,
} from '@disaster/sim-core'

type Intervention = 'baseline' | 'generator-priority' | 'mutual-aid'

export interface LiveSimulationInitRequest {
  type: 'init'
  municipalities: MunicipalityDefinition[]
  network: RouteDefinition[]
}

export interface LiveSimulationRunRequest {
  type: 'simulate'
  jobId: number
  step: number
  selectedLayer: LayerId
  selectedMunicipalityId: string
  scenario: ScenarioConfig
  intervention: Intervention
  compareSeason: Season | 'none'
}

export type LiveSimulationRequest = LiveSimulationInitRequest | LiveSimulationRunRequest

export interface LiveSimulationResponse {
  jobId: number
  routeService?: ServiceId
  frame?: SimulationFrame
  referenceFrame?: SimulationFrame
  referenceMatchesPrimary?: boolean
  durationMs?: number
  wireBytes?: number
  error?: string
}

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

function serviceForLayer(layer: LayerId): ServiceId {
  return layer === 'overview' || layer === 'hazard' || layer === 'population'
    ? 'supply'
    : layer
}

/** Geometry is immutable input already held by the browser. Keep it off the wire. */
function compactFrameForWire(
  frame: SimulationFrame,
  routeService: ServiceId,
  selectedMunicipalityId: string,
): SimulationFrame {
  const routes = frame.routesByService[routeService].map((route) => ({
    ...route,
    coordinates: [],
    flowCoordinates: [],
  }))
  const routesByService = Object.fromEntries(
    serviceIds.map((service) => [service, service === routeService ? routes : []]),
  ) as unknown as SimulationFrame['routesByService']
  const municipalities = frame.municipalities.map((municipality) => {
    if (municipality.id === selectedMunicipalityId) return municipality
    const { explanation: _municipalityExplanation, ...municipalityState } = municipality
    const { explanation: _hazardExplanation, ...hazard } = municipality.hazard
    const services = Object.fromEntries(serviceIds.map((service) => {
      const { explanation: _serviceExplanation, ...state } = municipality.services[service]
      return [service, state]
    }))
    return { ...municipalityState, hazard, services }
  }) as unknown as SimulationFrame['municipalities']
  return { ...frame, municipalities, routes, routesByService }
}

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope
let primarySession: ReturnType<typeof createSimulationSession> | null = null
let referenceSession: ReturnType<typeof createSimulationSession> | null = null
let latestRequest: LiveSimulationRunRequest | null = null
let runScheduled = false

function scheduleLatestRequest() {
  if (runScheduled) return
  runScheduled = true
  setTimeout(runLatestRequest, 0)
}

function runLatestRequest() {
  runScheduled = false
  const request = latestRequest
  latestRequest = null
  if (!request || !primarySession || !referenceSession) return

  const startedAt = performance.now()
  try {
    const routeService = serviceForLayer(request.selectedLayer)
    const sharedProjection = {
      explanationMunicipalityIds: [request.selectedMunicipalityId],
    }
    const frame = primarySession.simulate(request.step, {
      selectedLayer: request.selectedLayer,
      intervention: request.intervention,
      scenario: request.scenario,
      materializedRouteServices: [routeService],
      ...sharedProjection,
    })

    let referenceFrame: SimulationFrame
    if (request.compareSeason !== 'none') {
      referenceFrame = referenceSession.simulate(request.step, {
        selectedLayer: request.selectedLayer,
        intervention: request.intervention,
        scenario: { ...request.scenario, season: request.compareSeason },
        materializedRouteServices: [],
        ...sharedProjection,
      })
    } else if (request.intervention !== 'baseline') {
      referenceFrame = referenceSession.simulate(request.step, {
        selectedLayer: request.selectedLayer,
        intervention: 'baseline',
        scenario: request.scenario,
        materializedRouteServices: [],
        ...sharedProjection,
      })
    } else {
      referenceFrame = frame
    }

    const response: LiveSimulationResponse = {
      jobId: request.jobId,
      routeService,
      frame: compactFrameForWire(frame, routeService, request.selectedMunicipalityId),
      referenceFrame: referenceFrame === frame
        ? undefined
        : compactFrameForWire(referenceFrame, routeService, request.selectedMunicipalityId),
      referenceMatchesPrimary: referenceFrame === frame,
      durationMs: performance.now() - startedAt,
    }
    // JSON length is diagnostic only; postMessage still uses structured clone.
    response.wireBytes = JSON.stringify(response).length
    workerScope.postMessage(response)
  } catch (error) {
    workerScope.postMessage({
      jobId: request.jobId,
      error: error instanceof Error ? error.message : String(error),
    } satisfies LiveSimulationResponse)
  }
}

workerScope.onmessage = (event: MessageEvent<LiveSimulationRequest>) => {
  const request = event.data
  if (request.type === 'init') {
    primarySession = createSimulationSession(request.municipalities, request.network)
    referenceSession = createSimulationSession(request.municipalities, request.network)
    return
  }
  latestRequest = request
  scheduleLatestRequest()
}

export {}
