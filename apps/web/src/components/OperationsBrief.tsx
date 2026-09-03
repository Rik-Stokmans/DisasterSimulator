import { useMemo, useState } from 'react'
import { ClipboardList, Search, X } from 'lucide-react'
import {
  formatSimulationTime,
  type LayerId,
  type ServiceId,
  type SimulationFrame,
} from '@disaster/sim-core'
import { layerById } from '../config'
import { compactNumber, metricForLayer, percent } from '../utils'

const services: Array<{ id: ServiceId; label: string }> = [
  { id: 'power', label: 'Electricity' },
  { id: 'water', label: 'Drinking water' },
  { id: 'drainage', label: 'Drainage' },
  { id: 'gas', label: 'Gas & heating' },
  { id: 'telecom', label: 'Telecom' },
  { id: 'mobility', label: 'Mobility' },
  { id: 'facilities', label: 'Critical facilities' },
  { id: 'supply', label: 'Emergency supply' },
]

const checkpoints = [0, 24, 48, 96, 192, 288] as const

interface OperationsBriefProps {
  open: boolean
  frame: SimulationFrame
  referenceFrame: SimulationFrame
  activeLayer: LayerId
  selectedMunicipalityId: string
  referenceLabel: string
  onClose: () => void
  onStepChange: (step: number) => void
  onSelectMunicipality: (id: string) => void
}

function weightedAvailability(frame: SimulationFrame, service: ServiceId) {
  const population = frame.municipalities.reduce((sum, city) => sum + city.population, 0)
  return frame.municipalities.reduce(
    (sum, city) => sum + city.services[service].availability * city.population,
    0,
  ) / Math.max(1, population)
}

function signedPercent(value: number) {
  const points = value * 100
  return `${points > 0 ? '+' : ''}${points.toFixed(1)} pp`
}

function layerValue(frame: SimulationFrame, municipalityId: string, layer: LayerId) {
  const municipality = frame.municipalities.find((candidate) => candidate.id === municipalityId)
  return municipality ? metricForLayer(municipality, layer) : 0
}

function formattedLayerValue(frame: SimulationFrame, municipalityId: string, layer: LayerId) {
  const municipality = frame.municipalities.find((candidate) => candidate.id === municipalityId)
  if (!municipality) return 'Unknown'
  if (layer === 'population') return compactNumber.format(municipality.affectedPopulation)
  return percent(metricForLayer(municipality, layer))
}

export function OperationsBrief({
  open,
  frame,
  referenceFrame,
  activeLayer,
  selectedMunicipalityId,
  referenceLabel,
  onClose,
  onStepChange,
  onSelectMunicipality,
}: OperationsBriefProps) {
  const [tab, setTab] = useState<'services' | 'municipalities'>('services')
  const [query, setQuery] = useState('')
  const selected = frame.municipalities.find((city) => city.id === selectedMunicipalityId)
  const referenceById = useMemo(
    () => open
      ? new Map(referenceFrame.municipalities.map((city) => [city.id, city]))
      : new Map(),
    [open, referenceFrame],
  )
  const municipalityRows = useMemo(() => {
    if (!open) return []
    const normalized = query.trim().toLocaleLowerCase('nl')
    return [...frame.municipalities]
      .filter((city) => !normalized || city.name.toLocaleLowerCase('nl').includes(normalized) || city.id.toLocaleLowerCase('nl').includes(normalized))
      .sort((left, right) => {
        const statusRank = { failed: 5, critical: 4, degraded: 3, strained: 2, recovering: 1, operational: 0 }
        const statusDelta = statusRank[right.status] - statusRank[left.status]
        return statusDelta || layerValue(frame, right.id, activeLayer) - layerValue(frame, left.id, activeLayer)
      })
  }, [open, frame, activeLayer, query])

  if (!open) return null

  return (
    <aside className="operations-brief panel" aria-labelledby="operations-brief-title">
      <header>
        <div className="operations-brief-icon"><ClipboardList size={18} /></div>
        <div>
          <span className="eyebrow">Operational checkpoint · modeled state</span>
          <h2 id="operations-brief-title">{formatSimulationTime(frame.step)} decision brief</h2>
          <p>{frame.scenario.name} · active versus {referenceLabel}</p>
        </div>
        <button type="button" className="operations-brief-close" onClick={onClose} aria-label="Close decision brief"><X size={18} /></button>
      </header>

      <nav className="operations-brief-tabs" aria-label="Decision brief views">
        <button type="button" className={tab === 'services' ? 'active' : ''} aria-pressed={tab === 'services'} onClick={() => setTab('services')}>Eight services</button>
        <button type="button" className={tab === 'municipalities' ? 'active' : ''} aria-pressed={tab === 'municipalities'} onClick={() => setTab('municipalities')}>Municipality table</button>
      </nav>

      <div className="operations-checkpoints" aria-label="Decision checkpoints">
        {checkpoints.map((checkpoint) => (
          <button
            type="button"
            key={checkpoint}
            className={frame.step === checkpoint ? 'active' : ''}
            aria-current={frame.step === checkpoint ? 'step' : undefined}
            onClick={() => onStepChange(checkpoint)}
          >
            T+{checkpoint / 4}h
          </button>
        ))}
      </div>

      {tab === 'services' ? (
        <div className="operations-brief-scroll">
          <div className="operations-brief-kpis">
            <div><span>Under pressure</span><strong>{compactNumber.format(frame.national.affectedPopulation)}</strong><small>{frame.national.affectedPopulation - referenceFrame.national.affectedPopulation >= 0 ? '+' : ''}{compactNumber.format(frame.national.affectedPopulation - referenceFrame.national.affectedPopulation)} vs reference</small></div>
            <div><span>Critical municipalities</span><strong>{frame.national.criticalMunicipalities}</strong><small>{frame.national.activeBottlenecks} route bottlenecks</small></div>
          </div>
          <table className="operations-service-table">
            <caption>National service state and selected municipality reserve at {formatSimulationTime(frame.step)}</caption>
            <thead><tr><th scope="col">Service</th><th scope="col">NL</th><th scope="col">Δ ref.</th><th scope="col">Critical</th><th scope="col">{selected?.name ?? 'Selected'} reserve</th></tr></thead>
            <tbody>
              {services.map(({ id, label }) => {
                const active = weightedAvailability(frame, id)
                const reference = weightedAvailability(referenceFrame, id)
                const critical = frame.municipalities.filter((city) => city.services[id].availability < 0.7).length
                return (
                  <tr key={id} className={activeLayer === id ? 'selected' : ''}>
                    <th scope="row">{label}</th>
                    <td>{percent(active)}</td>
                    <td className={active - reference < 0 ? 'harmful' : active - reference > 0 ? 'helpful' : ''}>{signedPercent(active - reference)}</td>
                    <td>{critical}</td>
                    <td>{selected?.services[id].reserveHours.toFixed(1) ?? '—'} h</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {selected && (
            <section className="operations-leading-cause">
              <span>Leading local constraint · {selected.name}</span>
              <strong>{selected.limitingService}</strong>
              <p>{selected.services[selected.limitingService].explanation.summary}</p>
            </section>
          )}
        </div>
      ) : (
        <div className="operations-brief-scroll municipality-results">
          <label className="operations-municipality-search">
            <Search size={15} />
            <span className="visually-hidden">Search municipalities</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search 342 municipalities" />
          </label>
          <table className="operations-municipality-table">
            <caption>{layerById[activeLayer].label} by municipality at {formatSimulationTime(frame.step)}</caption>
            <thead><tr><th scope="col">Municipality</th><th scope="col">Status</th><th scope="col">Value</th><th scope="col">Δ ref.</th></tr></thead>
            <tbody>
              {municipalityRows.map((city) => {
                const reference = referenceById.get(city.id)
                const delta = metricForLayer(city, activeLayer) - (reference ? metricForLayer(reference, activeLayer) : 0)
                return (
                  <tr key={city.id} className={city.id === selectedMunicipalityId ? 'selected' : ''}>
                    <th scope="row"><button type="button" onClick={() => onSelectMunicipality(city.id)}>{city.name}<small>{city.id}</small></button></th>
                    <td><span className={`status-label ${city.status}`}>{city.status}</span></td>
                    <td>{formattedLayerValue(frame, city.id, activeLayer)}</td>
                    <td>{activeLayer === 'population' ? `${delta > 0 ? '+' : ''}${compactNumber.format(delta)}` : signedPercent(delta)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  )
}
