import { describe, expect, it } from 'vitest'
import {
  finiteOrNull,
  observationFreshness,
  secondsSince1950ToIso,
} from '../../../scripts/fetch-knmi-observations.mjs'

describe('KNMI 10-minute observation normalization', () => {
  it('converts the NetCDF seconds-since-1950 coordinate to the UTC interval end', () => {
    expect(secondsSince1950ToIso(2_419_543_800)).toBe('2026-09-02T23:30:00.000Z')
  })

  it('keeps true measured zero distinct from missing or implausible values', () => {
    expect(finiteOrNull(0, 0, 300, 3)).toBe(0)
    expect(finiteOrNull(Number.NaN, 0, 300, 3)).toBeNull()
    expect(finiteOrNull(-0.01, 0, 300, 3)).toBeNull()
    expect(finiteOrNull(301, 0, 300, 3)).toBeNull()
  })

  it('classifies source age without projecting the observation into the future', () => {
    const observed = '2026-09-02T23:30:00.000Z'
    expect(observationFreshness(observed, '2026-09-02T23:38:00.000Z')).toEqual({
      ageMinutesAtRetrieval: 8,
      statusAtRetrieval: 'fresh',
    })
    expect(observationFreshness(observed, '2026-09-03T00:31:00.000Z').statusAtRetrieval).toBe('delayed')
    expect(observationFreshness(observed, '2026-09-03T03:31:00.000Z').statusAtRetrieval).toBe('stale')
  })
})
