/// <reference lib="webworker" />

import {
  simulateHistory,
  type MunicipalityDefinition,
  type RouteDefinition,
  type ScenarioConfig,
  type Season,
  type SimulationHistory,
} from '@disaster/sim-core'

type Intervention = 'baseline' | 'generator-priority' | 'mutual-aid'

export interface SimulationHistoryInitRequest {
  type: 'init'
  datasetVersion: number
  municipalities: MunicipalityDefinition[]
  network: RouteDefinition[]
}

export interface SimulationHistoryRunRequest {
  type: 'run'
  jobId: number
  datasetVersion: number
  municipalityId: string
  scenario: ScenarioConfig
  intervention: Intervention
  compareSeason: Season | 'none'
}

export type SimulationHistoryRequest =
  | SimulationHistoryInitRequest
  | SimulationHistoryRunRequest

export interface SimulationHistoryResponse {
  jobId: number
  datasetVersion: number
  history?: SimulationHistory
  comparisonHistory?: SimulationHistory
  durationMs?: number
  cacheHit?: boolean
  error?: string
}

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope
let municipalities: MunicipalityDefinition[] = []
let network: RouteDefinition[] = []
let activeDatasetVersion = -1
const historyCache = new Map<
  string,
  Pick<SimulationHistoryResponse, 'history' | 'comparisonHistory'>
>()
const MAX_CACHE_ENTRIES = 8

function cacheKey(request: SimulationHistoryRunRequest): string {
  return JSON.stringify([
    request.datasetVersion,
    request.municipalityId,
    request.scenario,
    request.intervention,
    request.compareSeason,
  ])
}

workerScope.onmessage = (event: MessageEvent<SimulationHistoryRequest>) => {
  const request = event.data
  if (request.type === 'init') {
    municipalities = request.municipalities
    network = request.network
    activeDatasetVersion = request.datasetVersion
    historyCache.clear()
    return
  }

  const startedAt = performance.now()
  try {
    if (request.datasetVersion !== activeDatasetVersion || !municipalities.length) {
      throw new Error('Simulation-history data is not initialized for this request.')
    }
    const key = cacheKey(request)
    const cached = historyCache.get(key)
    if (cached) {
      workerScope.postMessage({
        jobId: request.jobId,
        datasetVersion: request.datasetVersion,
        ...cached,
        durationMs: performance.now() - startedAt,
        cacheHit: true,
      } satisfies SimulationHistoryResponse)
      return
    }

    const sharedHistoryOptions = {
      intervalSteps: 12,
      municipalityIds: [request.municipalityId],
      network,
      networkMode: 'full' as const,
    }
    const history = simulateHistory(
      municipalities,
      {
        selectedLayer: 'overview',
        intervention: request.intervention,
        scenario: request.scenario,
      },
      sharedHistoryOptions,
    )
    const comparisonHistory = request.compareSeason !== 'none'
      ? simulateHistory(
          municipalities,
          {
            selectedLayer: 'overview',
            intervention: request.intervention,
            scenario: { ...request.scenario, season: request.compareSeason },
          },
          sharedHistoryOptions,
        )
      : request.intervention !== 'baseline'
        ? simulateHistory(
            municipalities,
            {
              selectedLayer: 'overview',
              intervention: 'baseline',
              scenario: request.scenario,
            },
            sharedHistoryOptions,
          )
        : undefined

    const result = { history, comparisonHistory }
    historyCache.set(key, result)
    if (historyCache.size > MAX_CACHE_ENTRIES) {
      historyCache.delete(historyCache.keys().next().value!)
    }
    workerScope.postMessage({
      jobId: request.jobId,
      datasetVersion: request.datasetVersion,
      ...result,
      durationMs: performance.now() - startedAt,
      cacheHit: false,
    } satisfies SimulationHistoryResponse)
  } catch (error) {
    workerScope.postMessage({
      jobId: request.jobId,
      datasetVersion: request.datasetVersion,
      error: error instanceof Error ? error.message : String(error),
    } satisfies SimulationHistoryResponse)
  }
}

export {}
