import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MunicipalityDefinition,
  RouteDefinition,
  ScenarioConfig,
  Season,
  SimulationHistory,
} from '@disaster/sim-core'
import type {
  SimulationHistoryRequest,
  SimulationHistoryResponse,
} from './workers/simulation-history.worker'

type Intervention = 'baseline' | 'generator-priority' | 'mutual-aid'

interface SimulationHistoryInputs {
  enabled: boolean
  municipalities: MunicipalityDefinition[]
  network: RouteDefinition[]
  municipalityId: string
  scenario: ScenarioConfig
  intervention: Intervention
  compareSeason: Season | 'none'
}

export function useSimulationHistory(inputs: SimulationHistoryInputs) {
  const [history, setHistory] = useState<SimulationHistory | null>(null)
  const [comparisonHistory, setComparisonHistory] = useState<SimulationHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [durationMs, setDurationMs] = useState<number>()
  const [cacheHit, setCacheHit] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const nextJobId = useRef(0)
  const workerRef = useRef<Worker | null>(null)
  const datasetVersion = useRef(0)

  const retry = useCallback(() => setRetryNonce((current) => current + 1), [])

  useEffect(() => {
    const worker = new Worker(
      new URL('./workers/simulation-history.worker.ts', import.meta.url),
      { type: 'module' },
    )
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<SimulationHistoryResponse>) => {
      if (
        event.data.jobId !== nextJobId.current ||
        event.data.datasetVersion !== datasetVersion.current
      ) return
      if (event.data.error) {
        setError(event.data.error)
      } else {
        setHistory(event.data.history ?? null)
        setComparisonHistory(event.data.comparisonHistory ?? null)
        setDurationMs(event.data.durationMs)
        setCacheHit(event.data.cacheHit ?? false)
      }
      setLoading(false)
    }
    worker.onerror = (event) => {
      setError(event.message || 'The simulation-history worker stopped unexpectedly.')
      setLoading(false)
    }
    return () => {
      nextJobId.current += 1
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!inputs.municipalities.length || !workerRef.current) return
    datasetVersion.current += 1
    workerRef.current.postMessage({
      type: 'init',
      datasetVersion: datasetVersion.current,
      municipalities: inputs.municipalities,
      network: inputs.network,
    } satisfies SimulationHistoryRequest)
  }, [inputs.municipalities, inputs.network])

  useEffect(() => {
    if (!inputs.enabled || !inputs.municipalities.length || !workerRef.current) {
      nextJobId.current += 1
      setLoading(false)
      return
    }
    const jobId = ++nextJobId.current
    const requestDatasetVersion = datasetVersion.current
    setLoading(true)
    setError(undefined)

    const debounce = window.setTimeout(() => {
      workerRef.current?.postMessage({
        type: 'run',
        jobId,
        datasetVersion: requestDatasetVersion,
        municipalityId: inputs.municipalityId,
        scenario: inputs.scenario,
        intervention: inputs.intervention,
        compareSeason: inputs.compareSeason,
      } satisfies SimulationHistoryRequest)
    }, 180)

    return () => {
      window.clearTimeout(debounce)
      if (nextJobId.current === jobId) nextJobId.current += 1
    }
  }, [
    inputs.enabled,
    inputs.municipalities,
    inputs.network,
    inputs.municipalityId,
    inputs.scenario,
    inputs.intervention,
    inputs.compareSeason,
    retryNonce,
  ])

  return { history, comparisonHistory, loading, error, durationMs, cacheHit, retry }
}
