import type { Coordinates, MunicipalityCollection, MunicipalityDefinition } from './types'

export function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function seededUnit(seed: number, salt = 0): number {
  const value = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

export function distanceKm(a: Coordinates, b: Coordinates): number {
  const radians = Math.PI / 180
  const lat1 = a[1] * radians
  const lat2 = b[1] * radians
  const dLat = (b[1] - a[1]) * radians
  const dLon = (b[0] - a[0]) * radians
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function flattenCoordinates(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): Coordinates[] {
  if (geometry.type === 'Polygon') return geometry.coordinates.flat() as Coordinates[]
  return geometry.coordinates.flat(2) as Coordinates[]
}

export function geometryCentroid(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): Coordinates {
  const points = flattenCoordinates(geometry)
  if (points.length === 0) return [5.3, 52.1]
  const totals = points.reduce(
    (acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat] as Coordinates,
    [0, 0] as Coordinates,
  )
  return [totals[0] / points.length, totals[1] / points.length]
}

export function collectionToMunicipalities(
  collection: MunicipalityCollection,
): MunicipalityDefinition[] {
  return collection.features.map((feature) => {
    const coordinates = feature.properties.center ?? geometryCentroid(feature.geometry)
    const population = feature.properties.population ?? 35_000
    const density = feature.properties.density ?? 450
    return {
      ...feature.properties,
      population,
      density,
      coordinates,
      areaScale: clamp(Math.sqrt(population / Math.max(120, density)) / 35, 0.55, 1.65),
      seed: hashString(feature.properties.code),
    }
  })
}

export function circlePolygon(
  center: Coordinates,
  radiusKm: number,
  points = 32,
): GeoJSON.Polygon {
  const ring: Coordinates[] = []
  const latScale = 1 / 111.32
  const lonScale = 1 / (111.32 * Math.cos((center[1] * Math.PI) / 180))
  for (let i = 0; i <= points; i += 1) {
    const angle = (i / points) * Math.PI * 2
    ring.push([
      center[0] + Math.cos(angle) * radiusKm * lonScale,
      center[1] + Math.sin(angle) * radiusKm * latScale,
    ])
  }
  return { type: 'Polygon', coordinates: [ring] }
}
