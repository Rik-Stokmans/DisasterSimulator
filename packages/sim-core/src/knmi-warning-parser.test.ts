import { describe, expect, it } from 'vitest'
// The deployment adapter is plain ESM so it can run directly under Node.
// @ts-expect-error There is intentionally no emitted declaration for a build script.
import { parseKnmiWarningsXml } from '../../../scripts/fetch-knmi-warnings.mjs'

const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<root><data><cube>
  <timeslice>
    <timeslice_id>2026-05-29T12:00:00</timeslice_id>
    <phenomenon><phenomenon_id>thunderstorm</phenomenon_id>
      <location><location_id>FR</location_id><location_warning_status>1</location_warning_status><text><text_data>Onweersbuien &amp; windstoten.</text_data></text></location>
      <location><location_id>ZH</location_id><location_warning_status>2</location_warning_status><text><text_data>Hevige onweersbuien.</text_data></text></location>
    </phenomenon>
  </timeslice>
  <timeslice>
    <timeslice_id>2026-05-29T13:00:00</timeslice_id>
    <phenomenon><phenomenon_id>thunderstorm</phenomenon_id>
      <location><location_id>FR</location_id><location_warning_status>1</location_warning_status><text><text_data>Onweersbuien &amp; windstoten.</text_data></text></location>
      <location><location_id>ZH</location_id><location_warning_status>0</location_warning_status></location>
    </phenomenon>
  </timeslice>
</cube></data></root>`

describe('KNMI warning XML parser', () => {
  it('merges consecutive hourly province slots without losing level, text or valid time', () => {
    const parsed = parseKnmiWarningsXml(fixture)
    expect(parsed.slotCount).toBe(2)
    expect(parsed.maxLevelByLocation.FR).toBe(1)
    expect(parsed.maxLevelByLocation.ZH).toBe(2)
    expect(parsed.warnings).toHaveLength(2)
    expect(parsed.warnings.find((warning: { locationCode: string }) => warning.locationCode === 'FR')).toMatchObject({
      phenomenonId: 'thunderstorm',
      phenomenonLabel: 'Thunderstorms',
      level: 1,
      levelLabel: 'Code yellow',
      validFrom: '2026-05-29T10:00:00.000Z',
      validThrough: '2026-05-29T12:00:00.000Z',
      slotCount: 2,
      texts: ['Onweersbuien & windstoten.'],
    })
  })

  it('rejects XML that cannot establish any recognized KNMI location slots', () => {
    expect(() => parseKnmiWarningsXml('<root><timeslice /></root>')).toThrow(
      'contains no recognized hourly location records',
    )
  })
})
