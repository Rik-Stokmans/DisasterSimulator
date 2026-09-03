export interface NdwCurrentSituationCollection {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    id: string
    geometry: { type: 'Point' | 'LineString'; coordinates: unknown }
    properties: Record<string, string | null>
  }>
  evidenceClass: 'observed-context'
  affectsSimulation: false
  source: {
    id: 'ndw-datex3-current-situations'
    publisher: 'Nationaal Dataportaal Wegverkeer (NDW)'
    url: string
    documentation: string
    license: string
    licenseUrl: string
    publicationTime: string
    sourceLastModified: string | null
    retrievedAt: string
    validityWindowHours: 72
    coverage: string
    caveat: string
  }
  processing: {
    totalSituations: number
    confidentialSituationsExcluded: number
    recordsOutside72HoursExcluded: number
    recordsWithoutUsableGeometryExcluded: number
  }
}

export function parseNdwCurrentSituations(
  compressedInput: ArrayBuffer | ArrayBufferView,
  metadata?: { sourceLastModified?: string | null; retrievedAt?: string },
): NdwCurrentSituationCollection

export function fetchNdwCurrentSituations(options?: {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<{ collection: NdwCurrentSituationCollection; compressedBytes: number }>

export const NDW_CURRENT_SITUATIONS_URL: string
