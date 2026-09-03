import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type LayerId,
  type HazardExplanation,
  type MunicipalityDefinition,
  type MunicipalityExplanation,
  type RouteDefinition,
  type ScenarioConfig,
  type Season,
  type ServiceExplanation,
  type ServiceId,
  type SimulationFrame,
} from '@disaster/sim-core'
import type {
  LiveSimulationRequest,
  LiveSimulationResponse,
} from './workers/live-simulation.worker'

type Intervention = 'baseline' | 'generator-priority' | 'mutual-aid'

interface LiveSimulationInputs {
  municipalities: MunicipalityDefinition[]
  network: RouteDefinition[]
  step: number
  selectedLayer: LayerId
  selectedMunicipalityId: string
  scenario: ScenarioConfig
  intervention: Intervention
  compareSeason: Season | 'none'
}

interface LiveSimulationResult {
  frame: SimulationFrame | null
  referenceFrame: SimulationFrame | null
  loading: boolean
  pending: boolean
  durationMs: number | null
  wireBytes: number | null
  error?: string
}

const compactHazardExplanation: HazardExplanation = {
  summary: 'Select this municipality for the complete hazard trace.',
  dominantDimension: null,
  contributions: [],
  drivers: [],
  counterfactuals: [],
  attributionNote: 'Numerical state is complete; causal detail is loaded for the selected municipality.',
}

const compactServiceExplanation: ServiceExplanation = {
  summary: 'Select this municipality for the complete service trace.',
  baselineResilience: 0,
  directHazardPressure: 0,
  recoveryProgress: 0,
  availabilityBeforeNetwork: 0,
  observedAvailability: 0,
  demandMultiplier: 1,
  contributions: [],
  dependencies: [],
  dependencyChain: { nodes: [], edges: [] },
  drivers: [],
  counterfactuals: [],
  attributionNote: 'Numerical state is complete; causal detail is loaded for the selected municipality.',
}

const compactMunicipalityExplanation: MunicipalityExplanation = {
  summary: 'Select this municipality for the complete system trace.',
  contributions: [],
  drivers: [],
  counterfactuals: [],
  attributionNote: 'Numerical state is complete; causal detail is loaded for the selected municipality.',
}

function hydrateFrame(
  frame: SimulationFrame,
): SimulationFrame {
  const municipalities = frame.municipalities.map((municipality) => ({
    ...municipality,
    hazard: {
      ...municipality.hazard,
      explanation: municipality.hazard.explanation ?? compactHazardExplanation,
    },
    services: Object.fromEntries(Object.entries(municipality.services).map(([service, state]) => [
      service,
      { ...state, explanation: state.explanation ?? compactServiceExplanation },
    ])) as SimulationFrame['municipalities'][number]['services'],
    explanation: municipality.explanation ?? compactMunicipalityExplanation,
  }))
  return {
    ...frame,
    municipalities,
  }
}

export function useLiveSimulation(inputs: LiveSimulationInputs): LiveSimulationResult {
  const [result, setResult] = useState<LiveSimulationResult>({
    frame: null,
    referenceFrame: null,
    loading: true,
    pending: true,
    durationMs: null,
    wireBytes: null,
  })
  const workerRef = useRef<Worker | null>(null)
  const nextJobId = useRef(0)
  const latestJobId = useRef(0)

  useEffect(() => {
    if (!inputs.municipalities.length || !inputs.network.length) return
    const worker = new Worker(
      new URL('./workers/live-simulation.worker.ts', import.meta.url),
      { type: 'module' },
    )
    workerRef.current = worker
    worker.postMessage({
      type: 'init',
      municipalities: inputs.municipalities,
      network: inputs.network,
    } satisfies LiveSimulationRequest)
    worker.onmessage = (event: MessageEvent<LiveSimulationResponse>) => {
      const response = event.data
      if (response.jobId !== latestJobId.current) return
      if (
        response.error ||
        !response.frame ||
        (!response.referenceMatchesPrimary && !response.referenceFrame) ||
        !response.routeService
      ) {
        setResult((current) => ({
          ...current,
          loading: false,
          pending: false,
          error: response.error ?? 'The live simulation worker returned an incomplete frame.',
        }))
        return
      }
      const frame = hydrateFrame(response.frame)
      const referenceFrame = response.referenceMatchesPrimary
        ? frame
        : hydrateFrame(response.referenceFrame!)
      setResult({
        frame,
        referenceFrame,
        loading: false,
        pending: false,
        durationMs: response.durationMs ?? null,
        wireBytes: response.wireBytes ?? null,
      })
    }
    worker.onerror = (event) => {
      setResult((current) => ({
        ...current,
        loading: false,
        pending: false,
        error: event.message || 'The live simulation worker stopped unexpectedly.',
      }))
    }
    return () => {
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }
  }, [inputs.municipalities, inputs.network])

  const request = useMemo<Omit<LiveSimulationRequest & { type: 'simulate' }, 'jobId'>>(
    () => ({
      type: 'simulate',
      step: inputs.step,
      selectedLayer: inputs.selectedLayer,
      selectedMunicipalityId: inputs.selectedMunicipalityId,
      scenario: inputs.scenario,
      intervention: inputs.intervention,
      compareSeason: inputs.compareSeason,
    }),
    [
      inputs.step,
      inputs.selectedLayer,
      inputs.selectedMunicipalityId,
      inputs.scenario,
      inputs.intervention,
      inputs.compareSeason,
    ],
  )

  useEffect(() => {
    const worker = workerRef.current
    if (!worker) return
    const jobId = ++nextJobId.current
    latestJobId.current = jobId
    setResult((current) => ({ ...current, pending: true, error: undefined }))
    worker.postMessage({ ...request, jobId } satisfies LiveSimulationRequest)
  }, [request, inputs.municipalities, inputs.network])

  return result
}
