import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  CalendarClock,
  CloudSun,
  Gauge,
  MapPinned,
  Network,
  RotateCcw,
  ShieldCheck,
  UsersRound,
  X,
} from 'lucide-react'
import type {
  DayType,
  DisasterType,
  MunicipalityDefinition,
  ScenarioConfig,
  ScenarioPresetId,
} from '@disaster/sim-core'
import { createScenario, scenarioLabels } from '../scenarios'
import { useModalIsolation } from '../useModalIsolation'

interface AdvancedScenarioPanelProps {
  open: boolean
  scenario: ScenarioConfig
  municipalities: MunicipalityDefinition[]
  selectedMunicipalityId: string
  onChange: (scenario: ScenarioConfig) => void
  onClose: () => void
}

const componentHazards: Array<Exclude<DisasterType, 'compound'>> = [
  'severe-storm',
  'pluvial-flood',
  'river-flood',
  'coastal-flood',
  'heatwave',
  'winter-storm',
  'cyberattack',
  'earthquake',
  'wildfire',
]

const dayTypeLabels: Record<DayType, string> = {
  weekday: 'Weekday',
  weekend: 'Weekend',
  holiday: 'Public holiday',
}

function Slider({
  label,
  description,
  value,
  min,
  max,
  step,
  valueLabel,
  onChange,
}: {
  label: string
  description: string
  value: number
  min: number
  max: number
  step: number
  valueLabel: string
  onChange: (value: number) => void
}) {
  return (
    <label className="advanced-slider">
      <span><strong>{label}</strong><small>{description}</small></span>
      <output>{valueLabel}</output>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function numericOverride(value: string) {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function coordinatesMatch(
  left: MunicipalityDefinition['coordinates'] | undefined,
  right: MunicipalityDefinition['coordinates'],
) {
  return Boolean(
    left && Math.abs(left[0] - right[0]) < 0.000001 && Math.abs(left[1] - right[1]) < 0.000001,
  )
}

export function AdvancedScenarioPanel({
  open,
  scenario,
  municipalities,
  selectedMunicipalityId,
  onChange,
  onClose,
}: AdvancedScenarioPanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
  }, [open, onClose])

  useModalIsolation(open)

  if (!open) return null

  const patch = (partial: Partial<ScenarioConfig>) => onChange({ ...scenario, ...partial })
  const focusSupported = ['cyberattack', 'earthquake', 'wildfire'].includes(scenario.disaster)
  const focusedMunicipality =
    scenario.disaster === 'cyberattack'
      ? scenario.targetMunicipalityIds?.[0]
      : municipalities.find((municipality) => coordinatesMatch(scenario.epicenter, municipality.coordinates))?.code
  const focusValue = focusSupported && focusedMunicipality ? focusedMunicipality : 'preset'
  const compoundComponents = scenario.components ?? []

  const setFocus = (municipalityId: string) => {
    if (municipalityId === 'preset') {
      const preset = createScenario(scenario.disaster as ScenarioPresetId)
      patch({
        targetMunicipalityIds: undefined,
        epicenter: scenario.disaster === 'earthquake' || scenario.disaster === 'wildfire'
          ? preset.epicenter
          : scenario.epicenter,
      })
      return
    }
    const municipality = municipalities.find((candidate) => candidate.code === municipalityId)
    if (!municipality) return
    if (scenario.disaster === 'cyberattack') {
      patch({ targetMunicipalityIds: [municipalityId] })
    } else {
      patch({ epicenter: municipality.coordinates })
    }
  }

  const resetOperations = () => {
    const preset = createScenario(scenario.disaster as ScenarioPresetId)
    onChange({
      ...scenario,
      dayType: preset.dayType,
      startClockHour: preset.startClockHour,
      referenceDate: preset.referenceDate,
      demandMultiplier: preset.demandMultiplier,
      backupMultiplier: preset.backupMultiplier,
      networkCapacityMultiplier: preset.networkCapacityMultiplier,
      repairCapacityMultiplier: preset.repairCapacityMultiplier,
      householdPreparedness: preset.householdPreparedness,
      targetMunicipalityIds: undefined,
      epicenter: preset.epicenter,
      climate: {
        ...scenario.climate,
        temperatureDeltaC: undefined,
        precipitationMultiplier: undefined,
        seaLevelDeltaM: undefined,
      },
    })
  }

  return createPortal(
    <div className="scenario-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={panelRef}
        className="advanced-scenario-panel panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-scenario-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="advanced-scenario-header">
          <div>
            <span className="eyebrow">Transparent sensitivity analysis</span>
            <h2 id="advanced-scenario-title">Operational assumptions</h2>
            <p>Change the conditions behind the 72-hour model. Every control is recorded in the explanation trace.</p>
          </div>
          <div>
            <button type="button" className="advanced-reset" onClick={resetOperations}>
              <RotateCcw size={14} /> Reset assumptions
            </button>
            <button ref={closeButtonRef} type="button" className="advanced-close" onClick={onClose} aria-label="Close operational assumptions">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="advanced-scenario-scroll">
          <section className="advanced-group">
            <div className="advanced-group-heading"><CalendarClock size={17} /><div><h3>Timing & activity</h3><p>Demand changes with the local clock and type of day.</p></div></div>
            <div className="advanced-field-grid">
              <label className="advanced-select-field">
                <span>Day type</span>
                <select value={scenario.dayType ?? 'weekday'} onChange={(event) => patch({ dayType: event.target.value as DayType })}>
                  {Object.entries(dayTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="advanced-select-field">
                <span>Clock at T+00</span>
                <select value={scenario.startClockHour ?? 8} onChange={(event) => patch({ startClockHour: Number(event.target.value) })}>
                  {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00 local</option>)}
                </select>
              </label>
              <label className="advanced-number-field">
                <span>Reference date · optional</span>
                <input
                  aria-label="Reference date"
                  type="date"
                  value={scenario.referenceDate ?? ''}
                  onChange={(event) => patch({ referenceDate: event.target.value || undefined })}
                />
                <small>Set this only when applying time-bounded public observations or closures. Blank keeps the exercise calendar-unbound.</small>
              </label>
              <label className="advanced-number-field">
                <span>Deterministic seed</span>
                <input type="number" min="0" max="2147483647" step="1" value={scenario.seed} onChange={(event) => patch({ seed: Math.max(0, Math.trunc(Number(event.target.value) || 0)) })} />
              </label>
            </div>
            <Slider label="System demand" description="Load across essential services." value={scenario.demandMultiplier ?? 1} min={0.25} max={2.5} step={0.05} valueLabel={`${(scenario.demandMultiplier ?? 1).toFixed(2)}×`} onChange={(demandMultiplier) => patch({ demandMultiplier })} />
          </section>

          <section className="advanced-group">
            <div className="advanced-group-heading"><ShieldCheck size={17} /><div><h3>Resilience & response</h3><p>Separate physical readiness, backup endurance, repairs and household readiness.</p></div></div>
            <Slider label="Backup endurance" description="Fuel, batteries and on-site reserve windows." value={scenario.backupMultiplier ?? 1} min={0.25} max={3} step={0.05} valueLabel={`${(scenario.backupMultiplier ?? 1).toFixed(2)}×`} onChange={(backupMultiplier) => patch({ backupMultiplier })} />
            <Slider label="Network capacity" description="Intermunicipal transfer capacity after disruption." value={scenario.networkCapacityMultiplier ?? 1} min={0} max={3} step={0.05} valueLabel={`${(scenario.networkCapacityMultiplier ?? 1).toFixed(2)}×`} onChange={(networkCapacityMultiplier) => patch({ networkCapacityMultiplier })} />
            <Slider label="Repair capacity" description="Crews, access and restoration throughput." value={scenario.repairCapacityMultiplier ?? 1} min={0.25} max={3} step={0.05} valueLabel={`${(scenario.repairCapacityMultiplier ?? 1).toFixed(2)}×`} onChange={(repairCapacityMultiplier) => patch({ repairCapacityMultiplier })} />
            <Slider label="Household preparedness" description="Human need buffer; it does not make infrastructure stronger." value={scenario.householdPreparedness ?? 0.44} min={0} max={1} step={0.01} valueLabel={`${Math.round((scenario.householdPreparedness ?? 0.44) * 100)}%`} onChange={(householdPreparedness) => patch({ householdPreparedness })} />
            <p className="advanced-source-note"><UsersRound size={13} /> The 44% default is a 2026 national emergency-kit survey proxy, not a local CBS observation.</p>
          </section>

          <section className="advanced-group">
            <div className="advanced-group-heading"><CloudSun size={17} /><div><h3>Climate sensitivity</h3><p>Leave fields blank to use the selected built-in KNMI’23 pathway transform.</p></div></div>
            <div className="advanced-field-grid climate-overrides">
              <label className="advanced-number-field">
                <span>Temperature delta · °C</span>
                <input type="number" min="-5" max="10" step="0.1" placeholder="Automatic" value={scenario.climate.temperatureDeltaC ?? ''} onChange={(event) => patch({ climate: { ...scenario.climate, temperatureDeltaC: numericOverride(event.target.value) } })} />
              </label>
              <label className="advanced-number-field">
                <span>Precipitation factor</span>
                <input type="number" min="0.25" max="3" step="0.05" placeholder="Automatic" value={scenario.climate.precipitationMultiplier ?? ''} onChange={(event) => patch({ climate: { ...scenario.climate, precipitationMultiplier: numericOverride(event.target.value) } })} />
              </label>
              <label className="advanced-number-field">
                <span>Sea-level delta · m</span>
                <input type="number" min="-0.5" max="3" step="0.01" placeholder="Automatic" value={scenario.climate.seaLevelDeltaM ?? ''} onChange={(event) => patch({ climate: { ...scenario.climate, seaLevelDeltaM: numericOverride(event.target.value) } })} />
              </label>
            </div>
          </section>

          <section className="advanced-group">
            <div className="advanced-group-heading"><MapPinned size={17} /><div><h3>Geographic focus</h3><p>Choose the target or epicentre for scenarios that have one.</p></div></div>
            <label className="advanced-select-field wide">
              <span>Target / epicentre</span>
              <select disabled={!focusSupported} value={focusValue} onChange={(event) => setFocus(event.target.value)}>
                <option value="preset">Preset geography</option>
                {municipalities.map((municipality) => <option key={municipality.code} value={municipality.code}>{municipality.name}</option>)}
              </select>
              <small>{focusSupported ? 'Cyber scenarios target a municipality; earthquake and wildfire use its official centre as epicentre.' : 'This scenario uses a national or hazard-specific spatial field.'}</small>
            </label>
            {focusSupported && focusValue === 'preset' && selectedMunicipalityId && (
              <button type="button" className="focus-selected-button" onClick={() => setFocus(selectedMunicipalityId)}>
                <MapPinned size={14} /> Focus on the currently selected municipality
              </button>
            )}
          </section>

          {scenario.disaster === 'compound' && (
            <section className="advanced-group">
              <div className="advanced-group-heading"><Network size={17} /><div><h3>Compound hazards</h3><p>Combine two or more initiating events; their shared dependencies can amplify disruption.</p></div></div>
              <div className="compound-grid">
                {componentHazards.map((hazard) => {
                  const checked = compoundComponents.includes(hazard)
                  return (
                    <label key={hazard}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const components = checked
                            ? compoundComponents.filter((component) => component !== hazard)
                            : [...compoundComponents, hazard]
                          if (components.length >= 2) patch({ components })
                        }}
                      />
                      <span>{scenarioLabels[hazard]}</span>
                    </label>
                  )
                })}
              </div>
            </section>
          )}

          <section className="advanced-disclosure" role="note">
            <Gauge size={15} />
            <p><strong>Interpretation boundary.</strong> These controls support deterministic planning and sensitivity analysis. They do not turn the model into an operational forecast or a calibrated digital twin.</p>
          </section>
        </div>
      </section>
    </div>,
    document.body,
  )
}
