import { describe, expect, it } from 'vitest'
import { realisticLightingForFrame } from './realisticLighting'

describe('realistic simulation lighting', () => {
  it('tracks daylight and night across the simulation clock', () => {
    const scenario = { season: 'summer' as const, referenceDate: '2026-06-21', startClockHour: 0 }
    const midnight = realisticLightingForFrame(scenario, 0)
    const noon = realisticLightingForFrame(scenario, 12 * 60)

    expect(midnight.daylightBand).toBe('night')
    expect(midnight.nightFactor).toBeGreaterThan(0.9)
    expect(noon.daylightBand).toBe('daylight')
    expect(noon.nightFactor).toBe(0)
    expect(noon.elevationDegrees).toBeGreaterThan(55)
  })

  it('rolls through the full 72-hour exercise using Amsterdam local time', () => {
    const lighting = realisticLightingForFrame(
      { season: 'autumn', referenceDate: '2026-09-03', startClockHour: 8 },
      72 * 60,
    )

    expect(lighting.localDate).toBe('2026-09-06')
    expect(lighting.localTime).toBe('08:00')
    expect(lighting.usesScenarioDate).toBe(true)
  })

  it('uses a disclosed seasonal reference date when the calendar date is unbound', () => {
    const lighting = realisticLightingForFrame(
      { season: 'winter', referenceDate: undefined, startClockHour: 12 },
      0,
    )

    expect(lighting.localDate).toBe('2026-01-15')
    expect(lighting.usesScenarioDate).toBe(false)
    expect(lighting.elevationDegrees).toBeGreaterThan(10)
    expect(lighting.elevationDegrees).toBeLessThan(20)
  })

  it('advances through Amsterdam daylight-saving transitions as elapsed time', () => {
    const scenario = {
      season: 'spring' as const,
      referenceDate: '2026-03-29',
      startClockHour: 0,
    }

    expect(realisticLightingForFrame(scenario, 60).localTime).toBe('01:00')
    expect(realisticLightingForFrame(scenario, 120).localTime).toBe('03:00')
  })
})
