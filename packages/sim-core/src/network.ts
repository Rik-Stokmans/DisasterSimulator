import { clamp, distanceKm } from './geometry'
import type { MunicipalityDefinition, RouteDefinition } from './types'

const MAX_NEIGHBOR_DISTANCE_KM = 58
const NEIGHBORS_PER_MUNICIPALITY = 2

export function buildNationalNetwork(
  municipalities: MunicipalityDefinition[],
): RouteDefinition[] {
  const routeKeys = new Set<string>()
  const routes: RouteDefinition[] = []

  const addRoute = (
    city: MunicipalityDefinition,
    neighbor: MunicipalityDefinition,
    distance: number,
  ) => {
    const ids = [city.code, neighbor.code].sort()
    const key = ids.join('--')
    if (routeKeys.has(key)) return false
    routeKeys.add(key)

    const populationWeight = Math.sqrt(
      Math.max(8_000, city.population ?? 35_000) *
        Math.max(8_000, neighbor.population ?? 35_000),
    )
    const nominalCapacity = Math.round(
      clamp(populationWeight / 90_000, 0.32, 2.8) * 100,
    )
    routes.push({
      id: `route-${key}`,
      from: city.code,
      to: neighbor.code,
      coordinates: [city.coordinates, neighbor.coordinates],
      nominalCapacity,
      mode:
        nominalCapacity > 150
          ? 'trunk'
          : nominalCapacity > 75
            ? 'regional'
            : 'local',
      distanceKm: distance,
    })
    return true
  }

  for (const city of municipalities) {
    const neighbors = municipalities
      .filter((candidate) => candidate.code !== city.code)
      .map((candidate) => ({
        city: candidate,
        distance: distanceKm(city.coordinates, candidate.coordinates),
      }))
      .sort((a, b) => a.distance - b.distance)

    const selected = neighbors
      .filter((entry) => entry.distance <= MAX_NEIGHBOR_DISTANCE_KM)
      .slice(0, NEIGHBORS_PER_MUNICIPALITY)
    if (selected.length === 0 && neighbors[0]) selected.push(neighbors[0])

    for (const neighbor of selected) {
      addRoute(city, neighbor.city, neighbor.distance)
    }
  }

  // Two-nearest-neighbor graphs can leave geographic clusters disconnected. Add
  // the shortest possible cross-component links until every municipality belongs
  // to one graph. These bridges are logical synthetic corridors, not asset claims.
  const parent = new Map(municipalities.map((city) => [city.code, city.code]))
  const find = (code: string): string => {
    const current = parent.get(code) ?? code
    if (current === code) return code
    const root = find(current)
    parent.set(code, root)
    return root
  }
  const union = (left: string, right: string) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot)
  }
  for (const route of routes) union(route.from, route.to)

  while (new Set(municipalities.map((city) => find(city.code))).size > 1) {
    let bridge:
      | { from: MunicipalityDefinition; to: MunicipalityDefinition; distance: number }
      | undefined
    for (let left = 0; left < municipalities.length; left += 1) {
      for (let right = left + 1; right < municipalities.length; right += 1) {
        const from = municipalities[left]
        const to = municipalities[right]
        if (find(from.code) === find(to.code)) continue
        const distance = distanceKm(from.coordinates, to.coordinates)
        if (!bridge || distance < bridge.distance) bridge = { from, to, distance }
      }
    }
    if (!bridge) break
    addRoute(bridge.from, bridge.to, bridge.distance)
    union(bridge.from.code, bridge.to.code)
  }

  return routes
}
