import { ChevronDown, ChevronUp, Settings2, SlidersHorizontal, Undo2 } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
import type {
  ClimateHorizon,
  KNMIClimatePath,
  MunicipalityDefinition,
  ScenarioConfig,
  ScenarioPresetId,
  Season,
} from '@disaster/sim-core'
import {
  climateHorizons,
  climatePathLabels,
  createScenario,
  scenarioLabels,
  seasonLabels,
} from '../scenarios'
import { AdvancedScenarioPanel } from './AdvancedScenarioPanel'

interface ScenarioControlsProps {
  scenario: ScenarioConfig
  municipalities: MunicipalityDefinition[]
  selectedMunicipalityId: string
  compareSeason: Season | 'none'
  intervention: 'baseline' | 'generator-priority' | 'mutual-aid'
  onChange: (scenario: ScenarioConfig) => void
  onCompareSeasonChange: (season: Season | 'none') => void
  onAdvancedOpenChange?: (open: boolean) => void
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string | number
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label className="scenario-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
      <ChevronDown size={13} aria-hidden="true" />
    </label>
  )
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  valueLabel,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  valueLabel: string
  onChange: (value: number) => void
}) {
  return (
    <label className="scenario-range">
      <span>{label}</span>
      <strong>{valueLabel}</strong>
      <input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

export function ScenarioControls({
  scenario,
  municipalities,
  selectedMunicipalityId,
  compareSeason,
  intervention,
  onChange,
  onCompareSeasonChange,
  onAdvancedOpenChange,
}: ScenarioControlsProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const [replacedScenario, setReplacedScenario] = useState<{
    scenario: ScenarioConfig
    changedFields: number
  } | null>(null)
  const setAdvancedVisibility = useCallback((open: boolean) => {
    setAdvancedOpen(open)
    onAdvancedOpenChange?.(open)
  }, [onAdvancedOpenChange])
  const closeAdvanced = useCallback(
    () => setAdvancedVisibility(false),
    [setAdvancedVisibility],
  )
  const patch = (partial: Partial<ScenarioConfig>) => onChange({ ...scenario, ...partial })
  const seasons = Object.keys(seasonLabels) as Season[]
  const climatePaths = Object.keys(climatePathLabels) as KNMIClimatePath[]
  const canonicalScenario = createScenario(scenario.disaster)
  const interventionLabel = intervention === 'generator-priority'
    ? 'protect critical generators'
    : intervention === 'mutual-aid'
      ? 'early municipal mutual aid'
      : 'baseline response'
  const referenceLabel = compareSeason !== 'none'
    ? `${seasonLabels[compareSeason]} with the same intervention`
    : intervention !== 'baseline'
      ? `baseline response with the same ${seasonLabels[scenario.season].toLowerCase()} scenario`
      : 'the same baseline state'
  const modified = JSON.stringify(scenario) !== JSON.stringify(canonicalScenario)
  const countChangedFields = (left: ScenarioConfig, right: ScenarioConfig) => {
    const values = (value: ScenarioConfig) => [
      value.season,
      value.climate.path,
      value.climate.horizon,
      value.intensity,
      value.durationHours,
      value.startHour,
      value.preparedness,
      value.responseDelayHours,
      value.dayType,
      value.startClockHour,
      value.referenceDate,
      value.demandMultiplier,
      value.backupMultiplier,
      value.networkCapacityMultiplier,
      value.repairCapacityMultiplier,
      value.householdPreparedness,
      JSON.stringify(value.targetMunicipalityIds ?? []),
      JSON.stringify(value.epicenter ?? null),
      JSON.stringify(value.components ?? []),
    ]
    const before = values(left)
    const after = values(right)
    return before.filter((value, index) => value !== after[index]).length
  }

  const selectPreset = (preset: ScenarioPresetId) => {
    const next = createScenario(preset)
    if (modified) {
      setReplacedScenario({ scenario, changedFields: countChangedFields(scenario, next) })
    } else {
      setReplacedScenario(null)
    }
    onChange(next)
  }

  return (
    <section className={`scenario-console panel${mobileExpanded ? ' mobile-expanded' : ''}`} aria-label="Scenario assumptions and comparison controls">
      <div className="scenario-console-heading">
        <SlidersHorizontal size={15} />
        <div>
          <strong>Scenario lab {modified && <em>Edited</em>}</strong>
          <span title={`Primary: ${interventionLabel}. Reference: ${referenceLabel}.`}>
            {scenario.name} · {seasonLabels[scenario.season]} · primary {interventionLabel} · reference {referenceLabel}
          </span>
        </div>
        <button
          type="button"
          className="scenario-mobile-toggle"
          aria-expanded={mobileExpanded}
          onClick={() => setMobileExpanded((current) => !current)}
        >
          {mobileExpanded ? 'Hide tuning' : 'Tune'}
          {mobileExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        <button type="button" className="advanced-scenario-button" onClick={() => setAdvancedVisibility(true)}>
          <Settings2 size={13} /> Advanced
        </button>
      </div>
      <div className="scenario-controls-body">
        <div className="scenario-select-grid">
          <SelectField
            label="Disaster"
            value={scenario.disaster}
            onChange={(value) => selectPreset(value as ScenarioPresetId)}
          >
            {Object.entries(scenarioLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </SelectField>
          <SelectField label="Season" value={scenario.season} onChange={(value) => patch({ season: value as Season })}>
            {seasons.map((season) => <option key={season} value={season}>{seasonLabels[season]}</option>)}
          </SelectField>
          <SelectField
            label="Climate"
            value={scenario.climate.path}
            onChange={(value) => patch({ climate: { ...scenario.climate, path: value as KNMIClimatePath, horizon: value === 'reference' ? 'current' : scenario.climate.horizon === 'current' ? 2050 : scenario.climate.horizon } })}
          >
            {climatePaths.map((path) => <option key={path} value={path}>{climatePathLabels[path]}</option>)}
          </SelectField>
          <SelectField
            label="Horizon"
            value={scenario.climate.horizon}
            onChange={(value) => patch({ climate: { ...scenario.climate, horizon: value === 'current' ? 'current' : Number(value) as ClimateHorizon } })}
          >
            {climateHorizons.map((horizon) => (
              <option key={horizon} value={horizon}>
                {horizon === 'current'
                  ? 'Current'
                  : horizon === 2033
                    ? '2033 · model interpolation'
                    : horizon === 2150
                      ? '2150 · model extension'
                      : horizon}
              </option>
            ))}
          </SelectField>
          <SelectField label="Compare with" value={compareSeason} onChange={(value) => onCompareSeasonChange(value as Season | 'none')}>
            <option value="none">Comparison off</option>
            {seasons.filter((season) => season !== scenario.season).map((season) => <option key={season} value={season}>{seasonLabels[season]}</option>)}
          </SelectField>
        </div>
        <div className="scenario-knobs">
          <RangeField label="Intensity" value={scenario.intensity} min={0.25} max={1} step={0.01} valueLabel={`${Math.round(scenario.intensity * 100)}%`} onChange={(intensity) => patch({ intensity })} />
          <RangeField label="Forcing duration" value={scenario.durationHours} min={4} max={336} step={1} valueLabel={`${scenario.durationHours}h`} onChange={(durationHours) => patch({ durationHours })} />
          <RangeField label="Infrastructure readiness" value={scenario.preparedness} min={0.1} max={1} step={0.01} valueLabel={`${Math.round(scenario.preparedness * 100)}%`} onChange={(preparedness) => patch({ preparedness })} />
          <RangeField label="Response delay" value={scenario.responseDelayHours} min={0} max={36} step={1} valueLabel={`${scenario.responseDelayHours}h`} onChange={(responseDelayHours) => patch({ responseDelayHours })} />
        </div>
        <small className="scenario-caveat">Climate transforms weather inputs; infrastructure fragility remains a model assumption.</small>
      </div>
      {replacedScenario && (
        <div className="scenario-preset-notice" role="status">
          <span>{replacedScenario.changedFields} tuned assumptions replaced by this preset.</span>
          <button
            type="button"
            onClick={() => {
              onChange(replacedScenario.scenario)
              setReplacedScenario(null)
            }}
          >
            <Undo2 size={12} /> Undo
          </button>
        </div>
      )}
      <AdvancedScenarioPanel
        open={advancedOpen}
        scenario={scenario}
        municipalities={municipalities}
        selectedMunicipalityId={selectedMunicipalityId}
        onChange={onChange}
        onClose={closeAdvanced}
      />
    </section>
  )
}
