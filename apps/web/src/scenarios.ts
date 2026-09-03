import {
  createScenarioConfig,
  scenarioPresetIds,
  scenarioPresets,
  type ClimateHorizon,
  type DisasterType,
  type KNMIClimatePath,
  type ScenarioConfig,
  type ScenarioPresetId,
  type Season,
} from '@disaster/sim-core'
/*
 * Public presets are defined once in sim-core. Keeping the UI factory as a
 * thin clone guarantees the national audit executes exactly what users select.
 */

export const scenarioLabels = Object.fromEntries(
  scenarioPresetIds.map((preset) => [preset, scenarioPresets[preset].name]),
) as Record<ScenarioPresetId, string>

export function createScenario(preset: ScenarioPresetId): ScenarioConfig {
  return createScenarioConfig(preset)
}

export const seasonLabels: Record<Season, string> = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
}

export const climatePathLabels: Record<KNMIClimatePath, string> = {
  reference: 'Reference 1991–2020',
  Ld: 'KNMI’23 Ld',
  Ln: 'KNMI’23 Ln',
  Md: 'Supplementary Md',
  Mn: 'Supplementary Mn',
  Hd: 'KNMI’23 Hd',
  Hn: 'KNMI’23 Hn',
}

export const climateHorizons: ClimateHorizon[] = ['current', 2033, 2050, 2100, 2150]

export function eventsForScenario(scenario: ScenarioConfig) {
  const startStep = Math.round(scenario.startHour * 4)
  const durationStep = Math.round(scenario.durationHours * 4)
  const initiatingLabel: Record<DisasterType, string> = {
    'severe-storm': 'Storm reaches NL',
    'pluvial-flood': 'Cloudburst begins',
    'river-flood': 'River level rises',
    'coastal-flood': 'Surge arrives',
    heatwave: 'Heat emergency',
    'winter-storm': 'Snow and ice',
    cyberattack: 'Intrusion starts',
    earthquake: 'Ground shaking',
    wildfire: 'Fire spreads',
    compound: 'Compound event',
  }
  const forcingEndHour = scenario.startHour + scenario.durationHours
  const forcingEndEvent = forcingEndHour <= 72
    ? { step: Math.round(forcingEndHour * 4), label: 'Forcing subsides', tone: 'repair' }
    : { step: 288, label: 'Forcing continues beyond 72h', tone: 'hazard' }
  return [
    { step: Math.min(288, startStep), label: initiatingLabel[scenario.disaster], tone: 'hazard' },
    { step: Math.min(288, startStep + 12), label: 'Service-threshold checkpoint', tone: 'failure' },
    { step: Math.min(288, startStep + Math.max(24, Math.round(durationStep * 0.45))), label: 'Dependency checkpoint', tone: 'failure' },
    { step: Math.min(288, Math.round((scenario.startHour + scenario.responseDelayHours) * 4)), label: 'Response assumption activates', tone: 'decision' },
    forcingEndEvent,
    { step: 192, label: 'Recovery checkpoint', tone: 'repair' },
    { step: 264, label: 'Residual-impact checkpoint', tone: 'repair' },
  ]
}
