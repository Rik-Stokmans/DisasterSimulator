import type { CSSProperties } from 'react'
import { Activity, FlaskConical, GitBranch, ListTree, SlidersHorizontal } from 'lucide-react'
import type {
  CauseContribution,
  DistrictSnapshot,
  DriverMetadata,
  LayerId,
  MunicipalitySnapshot,
  ServiceExplanation,
  ServiceId,
  ExplanationTarget,
} from '@disaster/sim-core'
import { layerById } from '../config'

interface CausalExplanationProps {
  selected: MunicipalitySnapshot
  selectedDistrict: DistrictSnapshot | null
  activeLayer: LayerId
}

function selectedService(selected: MunicipalitySnapshot, layer: LayerId): ServiceId {
  return layer === 'overview' || layer === 'hazard' || layer === 'population'
    ? selected.limitingService
    : layer
}

function compactValue(value: number) {
  if (Math.abs(value) >= 100_000) return new Intl.NumberFormat('en-NL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  if (Math.abs(value) >= 100) return new Intl.NumberFormat('en-NL', { maximumFractionDigits: 0 }).format(value)
  if (Math.abs(value) >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function formattedEffect(contribution: CauseContribution) {
  const fractionUnit = /fraction|availability|severity|pressure|share/i.test(contribution.effectUnit)
  const value = fractionUnit ? contribution.effect * 100 : contribution.effect
  const suffix = fractionUnit ? ' pp' : contribution.effectUnit ? ` ${contribution.effectUnit}` : ''
  return `${value > 0 ? '+' : ''}${compactValue(value)}${suffix}`
}

function effectTone(contribution: CauseContribution) {
  if (Math.abs(contribution.effect) < 0.000001) return 'neutral'
  const higherIsBeneficial = contribution.target === 'service-availability'
  const helpful = higherIsBeneficial ? contribution.effect > 0 : contribution.effect < 0
  return helpful ? 'helpful' : 'harmful'
}

function formattedCounterfactual(delta: number, unit: string) {
  if (/fraction|availability|severity|pressure|share/i.test(unit)) {
    const value = delta * 100
    return `${value > 0 ? '+' : ''}${compactValue(value)} pp`
  }
  return `${delta > 0 ? '+' : ''}${compactValue(delta)}${unit ? ` ${unit}` : ''}`
}

function formattedDriver(driver: DriverMetadata) {
  if (typeof driver.value === 'string') return `${driver.value}${driver.unit ? ` ${driver.unit}` : ''}`
  if (/fraction|share/i.test(driver.unit)) return `${Math.round(driver.value * 100)}%`
  return `${compactValue(driver.value)}${driver.unit ? ` ${driver.unit}` : ''}`
}

function Contributions({
  contributions,
  targets,
}: {
  contributions: CauseContribution[]
  targets: ExplanationTarget[]
}) {
  const visible = [...contributions]
    .filter((contribution) => Number.isFinite(contribution.effect) && targets.includes(contribution.target))
    .sort((left, right) => Math.abs(right.effect) - Math.abs(left.effect))
    .slice(0, 6)
  const maximum = Math.max(0.000001, ...visible.map((contribution) => Math.abs(contribution.effect)))

  return (
    <div className="causal-contributions" role="list" aria-label="Largest model contributions">
      {visible.map((contribution) => (
        <div className="causal-contribution" role="listitem" key={contribution.id}>
          <div className="causal-contribution-label">
            <span>{contribution.label}</span>
            <strong className={effectTone(contribution)}>
              {formattedEffect(contribution)}
            </strong>
          </div>
          <div className="causal-contribution-track" aria-hidden="true">
            <i
              className={effectTone(contribution)}
              style={{ '--cause-width': `${Math.max(2, (Math.abs(contribution.effect) / maximum) * 100)}%` } as CSSProperties}
            />
          </div>
          <small>{contribution.description}</small>
          <span className="causal-method">{contribution.method.replaceAll('-', ' ')} · {contribution.confidence}</span>
        </div>
      ))}
    </div>
  )
}

function Dependencies({ explanation }: { explanation: ServiceExplanation }) {
  const dependencies = explanation.dependencies.filter((dependency) => Math.abs(dependency.effect) > 0.0001 || dependency.backupActive)
  if (!dependencies.length) return null
  return (
    <div className="dependency-trace">
      <div className="causal-subheading"><GitBranch size={13} /><strong>Operational dependencies</strong></div>
      {dependencies.map((dependency) => (
        <div className="dependency-row" key={dependency.upstreamService}>
          <span>{layerById[dependency.upstreamService].compactLabel}</span>
          <i aria-hidden="true">→</i>
          <strong>{Math.round(dependency.upstreamAvailability * 100)}% upstream</strong>
          <small>
            {dependency.backupActive
              ? `Backup active · ${Math.max(0, dependency.backupRemainingHours ?? 0).toFixed(1)}h remaining`
              : `${dependency.effect >= 0 ? '+' : ''}${(dependency.effect * 100).toFixed(1)} pp downstream`}
          </small>
        </div>
      ))}
    </div>
  )
}

export function CausalExplanation({ selected, selectedDistrict, activeLayer }: CausalExplanationProps) {
  const serviceId = selectedService(selected, activeLayer)
  const serviceExplanation = selected.services[serviceId].explanation
  const explanation = activeLayer === 'hazard'
    ? selected.hazard.explanation
    : activeLayer === 'population'
      ? selected.explanation
      : serviceExplanation
  const drivers = explanation.drivers
  const counterfactuals = explanation.counterfactuals.slice(0, 3)
  const contributionTargets: ExplanationTarget[] = activeLayer === 'hazard'
    ? ['hazard-severity']
    : activeLayer === 'population'
      ? ['system-pressure', 'affected-population']
      : ['service-availability']

  return (
    <section className="inspector-section causal-explanation">
      <div className="section-heading"><ListTree size={15} /><h3>Why this state?</h3><span className="trace-badge">model trace</span></div>
      <p className="causal-summary">{explanation.summary}</p>

      <div className="causal-subheading"><Activity size={13} /><strong>Largest contributions</strong></div>
      <Contributions contributions={explanation.contributions} targets={contributionTargets} />

      {activeLayer !== 'hazard' && activeLayer !== 'population' && <Dependencies explanation={serviceExplanation} />}
      {activeLayer === 'overview' && <Dependencies explanation={serviceExplanation} />}

      {selectedDistrict?.explanation && (
        <details className="causal-details local-allocation-details">
          <summary>Why this buurt receives this allocation</summary>
          <p>{selectedDistrict.explanation.summary}</p>
          <div className="local-explanation-metrics">
            <span><small>Vulnerability pressure</small><strong>{Math.round(selectedDistrict.explanation.vulnerabilityPressure * 100)}%</strong></span>
            <span><small>Demand share</small><strong>{Math.round(selectedDistrict.explanation.demandShare * 100)}%</strong></span>
            <span><small>Context coverage</small><strong>{Math.round(selectedDistrict.explanation.contextCoverage * 100)}%</strong></span>
          </div>
        </details>
      )}

      {counterfactuals.length > 0 && (
        <div className="counterfactual-section">
          <div className="causal-subheading"><FlaskConical size={13} /><strong>What-if checks</strong></div>
          <div className="counterfactual-grid">
            {counterfactuals.map((counterfactual) => (
              <article key={counterfactual.id}>
                <span>{counterfactual.question}</span>
                <strong>{formattedCounterfactual(counterfactual.delta, counterfactual.unit)}</strong>
                <small>{counterfactual.label} · {counterfactual.method.replaceAll('-', ' ')}</small>
              </article>
            ))}
          </div>
        </div>
      )}

      <details className="causal-details">
        <summary><SlidersHorizontal size={13} /> Inspect {drivers.length} drivers & methods</summary>
        <div className="driver-list">
          {drivers.map((driver) => (
            <div key={driver.id}>
              <span><strong>{driver.label}</strong><small>{driver.description}</small></span>
              <span><b>{formattedDriver(driver)}</b><small>{driver.role.replaceAll('-', ' ')}{driver.editable ? ' · editable' : ''}</small></span>
            </div>
          ))}
        </div>
      </details>

      {'attributionNote' in explanation && typeof explanation.attributionNote === 'string' && (
        <p className="causal-caveat">{explanation.attributionNote}</p>
      )}
    </section>
  )
}
