import { describe, expect, it } from 'vitest'
import { createScenarioConfig, scenarioPresetIds } from '@disaster/sim-core'
import { createScenario, eventsForScenario } from './scenarios'

describe('public scenario presets', () => {
  it('uses the exact canonical sim-core configuration for every public preset', () => {
    for (const preset of scenarioPresetIds) {
      expect(createScenario(preset)).toEqual(createScenarioConfig(preset))
    }
  })

  it('retains every operational meaning when scenario events share a timestamp', () => {
    const events = eventsForScenario(createScenario('severe-storm'))
    const atEightHours = events.filter((event) => event.step === 32)

    expect(atEightHours.map((event) => event.label)).toEqual([
      'Dependency checkpoint',
      'Response assumption activates',
    ])
  })
})
