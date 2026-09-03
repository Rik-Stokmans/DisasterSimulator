import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BarChart3,
  BookOpenCheck,
  ChevronDown,
  CircleAlert,
  Database,
  LineChart,
  LoaderCircle,
  X,
} from 'lucide-react'
import type { SimulationHistory } from '@disaster/sim-core'
import type { MunicipalityRegionBundle } from '../data'
import { useModalIsolation } from '../useModalIsolation'
import {
  RegionalStatisticsDashboard,
  SimulationTimelineDashboard,
} from './statistics'
import './AnalyticsWorkspace.css'

type AnalyticsTab = 'simulation' | 'observed' | 'method'

interface AnalyticsWorkspaceProps {
  municipalityId: string
  municipalityName: string
  regionBundle: MunicipalityRegionBundle | null
  selectedNeighborhoodId: string | null
  activeHour: number
  history: SimulationHistory | null
  comparisonHistory: SimulationHistory | null
  primaryLabel?: string
  comparisonLabel?: string
  loading: boolean
  error?: string
  onNeighborhoodChange: (id: string | null) => void
  onRetry: () => void
  onClose: () => void
}

export function AnalyticsWorkspace({
  municipalityId,
  municipalityName,
  regionBundle,
  selectedNeighborhoodId,
  activeHour,
  history,
  comparisonHistory,
  primaryLabel = 'Active scenario',
  comparisonLabel,
  loading,
  error,
  onNeighborhoodChange,
  onRetry,
  onClose,
}: AnalyticsWorkspaceProps) {
  const workspaceRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [tab, setTab] = useState<AnalyticsTab>('simulation')
  const [comparisonNeighborhoodId, setComparisonNeighborhoodId] = useState<string | null>(null)
  const neighborhoods = regionBundle?.neighborhoods.features ?? []
  const effectiveNeighborhoodId = (selectedNeighborhoodId ?? String(neighborhoods[0]?.id ?? '')) || null

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const focusable = [...(workspaceRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      window.clearTimeout(focusTimer)
      window.setTimeout(() => previouslyFocused?.focus(), 0)
    }
  }, [onClose])

  useModalIsolation()

  useEffect(() => {
    setComparisonNeighborhoodId(null)
  }, [municipalityId])

  const sampleDescription = useMemo(() => {
    if (!history) return 'Preparing history'
    const minutes = history.intervalSteps * 15
    const interval = minutes >= 60 ? `${minutes / 60}h` : `${minutes} min`
    return `${history.points.length} full-network states · ${interval} interval`
  }, [history])

  return createPortal(
    <div className="analytics-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={workspaceRef}
        className="analytics-workspace"
        role="dialog"
        aria-modal="true"
        aria-labelledby="analytics-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="analytics-header">
          <div className="analytics-title-icon"><BarChart3 size={20} /></div>
          <div>
            <span className="eyebrow">Every statistic · source-aware</span>
            <h1 id="analytics-title">Analytics & evidence</h1>
            <p>{municipalityName} · {sampleDescription}</p>
          </div>
          <button ref={closeButtonRef} type="button" className="analytics-close" onClick={onClose} aria-label="Close analytics">
            <X size={19} />
          </button>
        </header>

        <div className="analytics-context-bar">
          <label>
            <span>Buurt for official statistics</span>
            <select
              value={effectiveNeighborhoodId ?? ''}
              onChange={(event) => onNeighborhoodChange(event.target.value || null)}
              disabled={!neighborhoods.length}
            >
              {!neighborhoods.length && <option value="">Regional data loading…</option>}
              {neighborhoods.map((feature) => (
                <option key={String(feature.id)} value={String(feature.id)}>{feature.properties.name}</option>
              ))}
            </select>
            <ChevronDown size={13} aria-hidden="true" />
          </label>
          <label>
            <span>Compare buurt</span>
            <select
              value={comparisonNeighborhoodId ?? ''}
              onChange={(event) => setComparisonNeighborhoodId(event.target.value || null)}
              disabled={!neighborhoods.length}
            >
              <option value="">No buurt comparison</option>
              {neighborhoods.filter((feature) => String(feature.id) !== effectiveNeighborhoodId).map((feature) => (
                <option key={String(feature.id)} value={String(feature.id)}>{feature.properties.name}</option>
              ))}
            </select>
            <ChevronDown size={13} aria-hidden="true" />
          </label>
          <div className="analytics-context-note">
            <Database size={13} />
            <span>Official CBS fields are distributions, never invented time series.</span>
          </div>
        </div>

        <nav className="analytics-tabs" aria-label="Analytics views">
          <button type="button" className={tab === 'simulation' ? 'active' : ''} aria-pressed={tab === 'simulation'} onClick={() => setTab('simulation')}>
            <LineChart size={14} /> 72-hour simulation
          </button>
          <button type="button" className={tab === 'observed' ? 'active' : ''} aria-pressed={tab === 'observed'} onClick={() => setTab('observed')}>
            <Database size={14} /> 36 official statistics
          </button>
          <button type="button" className={tab === 'method' ? 'active' : ''} aria-pressed={tab === 'method'} onClick={() => setTab('method')}>
            <BookOpenCheck size={14} /> Read the model
          </button>
        </nav>

        <div className="analytics-scroll">
          {tab === 'simulation' && (
            loading && !history ? (
              <div className="analytics-loading" role="status"><LoaderCircle className="spin" size={24} /><strong>Building 72-hour history off the UI thread</strong><span>The map remains interactive while full-network states are evaluated.</span></div>
            ) : error && !history ? (
              <div className="analytics-loading error" role="alert"><CircleAlert size={24} /><strong>History could not be generated</strong><span>{error}</span><button type="button" onClick={onRetry}>Try again</button></div>
            ) : history ? (
              <>
                {loading && <div className="analytics-refreshing" role="status"><LoaderCircle className="spin" size={12} /> Recalculating changed assumptions…</div>}
                <SimulationTimelineDashboard
                  history={history}
                  municipalityId={municipalityId}
                  primaryLabel={primaryLabel}
                  comparison={comparisonHistory ? { label: comparisonLabel ?? 'Comparison', history: comparisonHistory } : undefined}
                  activeHour={activeHour}
                  title={`All modeled statistics · ${municipalityName}`}
                  provenance="Deterministic scenario-engine output sampled from the full municipal network in a background worker. Curves are planning-model states, not live measurements or forecasts."
                />
              </>
            ) : null
          )}

          {tab === 'observed' && (
            <RegionalStatisticsDashboard
              bundle={regionBundle}
              selectedNeighborhoodId={effectiveNeighborhoodId}
              comparisonNeighborhoodId={comparisonNeighborhoodId}
              title={`All 36 official statistics · ${municipalityName}`}
            />
          )}

          {tab === 'method' && <ModelReadingGuide />}
        </div>
      </section>
    </div>,
    document.body,
  )
}

function ModelReadingGuide() {
  return (
    <section className="model-guide">
      <header>
        <span className="eyebrow">How to challenge the output</span>
        <h2>Read the model as an argument, not an oracle</h2>
        <p>The interface deliberately separates official observations, transparent transformations and scenario assumptions.</p>
      </header>
      <div className="model-guide-grid">
        <article className="observed"><Database size={18} /><h3>Observed context</h3><p>CBS/BAG boundaries and regional statistics, NWB roads, ProRail traces and stations, GTFS routes, CBS/PDOK safety regions, HWH/PDOK water assets, KVK/PDOK governmental-service locations, RIVM 2026 SEH/acute-obstetric roles, daily DUO RIO education-location uses, Liander public electricity/gas geometry, the timestamped NDW current-road snapshot, a cached current KNMI precipitation-radar rendering, KNMI's sparse 10-minute station observations, and KNMI's issued 48-hour province warnings. Missing values stay missing; fixed stations are not interpolated, and registers, questionnaires, observations and warnings do not automatically become simulated operating states or a scenario forecast.</p></article>
        <article className="derived"><LineChart size={18} /><h3>Derived model state</h3><p>Hazard forcing, service demand, capacity, reserves, dependencies, allocations and recovery are deterministic equations over those inputs.</p></article>
        <article className="assumed"><CircleAlert size={18} /><h3>Planning assumptions</h3><p>Utility topology, fragility, backup windows, response and restoration are not operator telemetry. Use the advanced controls to test sensitivity.</p></article>
      </div>
      <div className="model-guide-section">
        <h3>What “why” means here</h3>
        <ol>
          <li><strong>Exact stage deltas</strong> show the arithmetic difference created by one documented stage.</li>
          <li><strong>Exact counterfactuals</strong> substitute or rerun one condition and compare the deterministic result.</li>
          <li><strong>Proportional attribution</strong> divides a combined modeled effect among drivers; it is an explanation aid, not empirical causal inference.</li>
        </ol>
      </div>
      <div className="model-guide-section sources">
        <h3>Primary references used for V3</h3>
        <a href="https://iplo.nl/thema/water/applicaties-modellen/berichtgeving-crisismanagement/liwo/" target="_blank" rel="noreferrer">LIWO · flood and water information</a>
        <a href="https://www.klimaatscenarios-data.knmi.nl/kerncijfers" target="_blank" rel="noreferrer">KNMI’23 · climate scenario core figures</a>
        <a href="https://www.nctv.nl/onderwerpen/v/vitale-infrastructuur" target="_blank" rel="noreferrer">NCTV · vital infrastructure dependencies</a>
        <a href="https://www.rivm.nl/hitte/kwetsbare-groepen" target="_blank" rel="noreferrer">RIVM · heat-vulnerable groups</a>
        <a href="https://www.ncsc.nl/incidenten-en-herstellen/herstel-van-een-cyberincident" target="_blank" rel="noreferrer">NCSC · cyber incident recovery</a>
        <a href="https://www.rijksoverheid.nl/vraag-en-antwoord/veiligheidsregios-en-crisisbeheersing/wat-zit-er-in-een-noodpakket" target="_blank" rel="noreferrer">Rijksoverheid · first-72-hour supplies</a>
      </div>
      <div className="model-guide-warning"><CircleAlert size={15} /><p><strong>Not for operational dispatch.</strong> Before real-world use, calibrate each sector with infrastructure operators, safety regions and incident data; validate hazards against authoritative rasters and forecasts.</p></div>
    </section>
  )
}

export default AnalyticsWorkspace
