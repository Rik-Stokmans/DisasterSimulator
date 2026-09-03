import { describe, expect, it } from 'vitest'
import {
  gtsFlowFreshness,
  normalizeGtsFlowPayload,
} from '../../../scripts/fetch-entsog-gts-flows.mjs'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: `flow-${Math.random()}`,
  indicator: 'Physical Flow',
  periodType: 'hour',
  periodFrom: '2026-09-02T21:00:00+02:00',
  periodTo: '2026-09-02T22:00:00+02:00',
  operatorKey: 'NL-TSO-0001',
  operatorLabel: 'GTS',
  tsoEicCode: '21X-NL-A-A0A0A-Z',
  pointKey: 'ITP-00001',
  pointLabel: 'Test point',
  tsoItemIdentifier: '21Z000000000000A',
  directionKey: 'entry',
  unit: 'kWh/h',
  pointType: 'Cross-Border Transmission IP within EU',
  value: 1,
  flowStatus: 'Provisional',
  lastUpdateDateTime: '2026-09-02T22:30:00+02:00',
  itemRemarks: null,
  generalRemarks: null,
  ...overrides,
})

function fixture(rows: Array<Record<string, unknown>>) {
  return {
    meta: {
      query: {
        operatorKey: 'NL-TSO-0001',
        periodType: 'hour',
        indicator: ['Physical Flow'],
      },
    },
    operationaldatas: rows,
  }
}

describe('ENTSOG GTS hourly physical-flow normalization', () => {
  it('selects the latest numeric hour and preserves reported zero', () => {
    const earlier = row({ id: 'earlier', value: 999 })
    const latest = Array.from({ length: 20 }, (_, index) => row({
      id: `latest-${index}`,
      pointKey: `ITP-${String(index).padStart(5, '0')}`,
      pointLabel: `Point ${index}`,
      periodFrom: '2026-09-02T22:00:00+02:00',
      periodTo: '2026-09-02T23:00:00+02:00',
      value: index === 0 ? 0 : index * 10,
    }))
    const missing = row({
      id: 'missing',
      pointKey: 'ITP-MISSING',
      periodFrom: '2026-09-02T22:00:00+02:00',
      periodTo: '2026-09-02T23:00:00+02:00',
      value: '',
      isNA: 1,
    })
    const result = normalizeGtsFlowPayload(
      fixture([earlier, ...latest, missing]),
      '2026-09-02T22:15:00.000Z',
    )
    expect(result.observationTime).toBe('2026-09-02T22:00:00+02:00')
    expect(result.records).toHaveLength(20)
    expect(result.records.some((record) => record.valueKwhPerHour === 0)).toBe(true)
    expect(result.counts.missingOrNaAtObservationHour).toBe(1)
    expect(result.counts.zeroDirectionalRecords).toBe(1)
  })

  it('rejects incompatible units instead of silently converting them', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row({
      id: `bad-${index}`,
      pointKey: `ITP-${String(index).padStart(5, '0')}`,
      pointLabel: `Point ${index}`,
      unit: index === 0 ? 'MWh/h' : 'kWh/h',
    }))
    expect(() => normalizeGtsFlowPayload(fixture(rows), '2026-09-02T21:30:00.000Z'))
      .toThrow('Invalid GTS physical-flow record')
  })

  it('makes processing delay visible without projecting the record through T+72', () => {
    expect(gtsFlowFreshness(
      '2026-09-02T21:00:00.000Z',
      '2026-09-02T22:45:00.000Z',
    )).toEqual({ ageMinutesAtRetrieval: 105, statusAtRetrieval: 'fresh' })
    expect(gtsFlowFreshness(
      '2026-09-02T21:00:00.000Z',
      '2026-09-03T04:00:00.000Z',
    ).statusAtRetrieval).toBe('delayed')
  })
})
