import { describe, expect, it } from 'vitest'
import {
  nearestPrecipitationProbabilityCheckpoint,
  type PublicPrecipitationProbabilityContext,
} from './data'

const precipitationContext = {
  source: { forecastHorizonHours: 6 },
  checkpoints: [
    { leadHours: 1, validTime: '2026-09-03T06:40:00Z' },
    { leadHours: 3, validTime: '2026-09-03T08:40:00Z' },
    { leadHours: 6, validTime: '2026-09-03T11:40:00Z' },
  ],
} as PublicPrecipitationProbabilityContext

describe('nearestPrecipitationProbabilityCheckpoint', () => {
  it('uses only declared T+1/T+3/T+6 forecast checkpoints inside the published horizon', () => {
    expect(nearestPrecipitationProbabilityCheckpoint(precipitationContext, 0)).toBeNull()
    expect(nearestPrecipitationProbabilityCheckpoint(precipitationContext, 0.25)?.leadHours).toBe(1)
    expect(nearestPrecipitationProbabilityCheckpoint(precipitationContext, 2)?.leadHours).toBe(1)
    expect(nearestPrecipitationProbabilityCheckpoint(precipitationContext, 2.25)?.leadHours).toBe(3)
    expect(nearestPrecipitationProbabilityCheckpoint(precipitationContext, 4.5)?.leadHours).toBe(3)
    expect(nearestPrecipitationProbabilityCheckpoint(precipitationContext, 4.75)?.leadHours).toBe(6)
    expect(nearestPrecipitationProbabilityCheckpoint(precipitationContext, 6)?.leadHours).toBe(6)
    expect(nearestPrecipitationProbabilityCheckpoint(precipitationContext, 6.25)).toBeNull()
    expect(nearestPrecipitationProbabilityCheckpoint(precipitationContext, 72)).toBeNull()
  })
})
