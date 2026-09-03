# Regional statistics catalogue

Every simulated time-varying field is keyed by a stable CBS municipality (`GMxxxx`) or real wijk/buurt code (`WKxxxxxx` / `BUxxxxxxxx`) and quarter-hour simulation step (`0…288`). Official CBS context is keyed by geography and edition—not given a fabricated time axis. BAG woonplaats IDs provide named-place grouping. Store provenance per value as `official`, `derived`, or `scenario`, plus source edition, retrieval time, and evidence class.

The catalogue deliberately contains aggregate indicators only. The meeting highlighted the privacy and legal problems around identifying vulnerable individuals; the simulator therefore uses regional proxies and never person-level records.

## Mandatory evidence envelope

A regional statistic is not just a number. Every official, derived, forecast or simulated value must travel with the fields below from ingest through maps, charts and export:

- `value` and `unit`, or an explicit `null` plus `noDataReason`;
- stable region ID and source geometry/coverage, edition, resolution and CRS;
- publisher, dataset, version, source URL, licence and retrieval time;
- evidence class: observation, forecast, official scenario, static context, derived, synthetic or unknown;
- observation time, issue time, valid-from and valid-through where applicable;
- quality/revision flags, uncertainty or ensemble interval and transformation/model version;
- `affectsSimulation`, which defaults to `false` until a reviewed causal binding exists.

The interface must distinguish at least four visual states: known official value, modeled/derived estimate, explicit scenario assumption and Unknown/NoData. Expired observations become Unknown rather than being held through T+72. A missing asset or event match never means zero, safe, open or available.

## Implemented CBS context per buurt

Every one of the 14,729 2025 buurt records has the same 36-field schema below. A value can be `null` when CBS suppresses it or does not publish it for that buurt; missing is never converted to zero.

| # | Field | Unit |
|---:|---|---|
| 1 | Population | people |
| 2 | Men | people |
| 3 | Women | people |
| 4 | Age 0–14 | people |
| 5 | Age 15–24 | people |
| 6 | Age 25–44 | people |
| 7 | Age 45–64 | people |
| 8 | Age 65+ | people |
| 9 | Total households | households |
| 10 | One-person households | households |
| 11 | Households without children | households |
| 12 | Households with children | households |
| 13 | Average household size | people/household |
| 14 | Population density | people/km² |
| 15 | Homes | buildings/dwellings |
| 16 | Non-residential building stock | buildings |
| 17 | Average assessed home value | € thousands |
| 18 | Single-family homes | % |
| 19 | Multi-family homes | % |
| 20 | Owner-occupied homes | % |
| 21 | Rental homes | % |
| 22 | Housing-corporation rentals | % |
| 23 | District-heated homes | % |
| 24 | Public charging points | count |
| 25 | Social-assistance recipients | people |
| 26 | Disability-benefit recipients | people |
| 27 | Old-age-pension recipients | people |
| 28 | Business establishments | count |
| 29 | Passenger cars | count |
| 30 | Cars per household | cars/household |
| 31 | Distance to GP practice | km |
| 32 | Distance to large supermarket | km |
| 33 | Land area | ha |
| 34 | Water area | ha |
| 35 | Urbanity class | CBS class 1–5 |
| 36 | Address density | addresses/km² |

These official context fields remain separate from the simulated, time-varying operational fields in the next catalogue.

| # | Field | Unit | Provenance / likely source | Phase |
|---:|---|---|---|---|
| 1 | Municipality code and name | ID | CBS/PDOK Gebiedsindelingen | V1 official |
| 2 | Boundary geometry and reference point | geometry | CBS/PDOK | V1 official |
| 3 | Resident population | people | CBS 86165NED | V1 official |
| 4 | Population density | people/km² | CBS 86165NED | V1 official |
| 5 | Households | households | CBS Wijken en buurten | Next official |
| 6 | One-person households | households | CBS 86165NED | V1 official |
| 7 | Population aged 65+ | people / % | CBS 86165NED | V1 official |
| 8 | Low-income household share | % | CBS regional income statistics | Next official |
| 9 | High-rise dependent population | people | BAG building height/use + CBS aggregate | Next derived |
| 10 | Daytime population | people | CBS jobs/education/mobility aggregates | Later derived |
| 11 | Electricity availability | % demand served | Scenario grid model | V1 simulated |
| 12 | Electricity unserved load | simulation u/h; later MW | Scenario; later operator aggregates | V1 simulated |
| 13 | Powered critical nodes | count / % | Scenario asset inventory | V1 simulated |
| 14 | Backup-generation capacity | simulation u/h; later kVA | Facility/operator inventory | Next mixed |
| 15 | Generator fuel endurance | hours | Scenario; later facility plans | V1 simulated |
| 16 | Drinking-water availability | % demand served | Scenario pressure model | V1 simulated |
| 17 | Drinking-water reserve | hours | Scenario buffers; later operator zones | V1 simulated |
| 18 | People without adequate pressure | people | Population × pressure deficiency | Next derived |
| 19 | Drainage/pumping availability | % | Scenario dependency model | V1 simulated |
| 20 | Inundation stress | % stress | Normalized generic scenario amplitude; only source-specific LIWO/water-board layers may later claim metres | V1 simulated |
| 21 | Gas/heating availability | % demand served | Scenario generalized zones | V1 simulated |
| 22 | Heating/cooling demand stress | index | KNMI forcing + building archetypes | Next derived |
| 23 | Telecom reachable capacity | % | Scenario battery/generator/congestion model | V1 simulated |
| 24 | Telecom backup endurance | hours | Scenario; later anonymized operator aggregates | V1 simulated |
| 25 | Emergency-call load | calls/hour index | Scenario demand model | Next simulated |
| 26 | Public-information reach | % population reachable | Telecom + radio + physical-channel model | Next derived |
| 27 | Road accessible capacity | % | Scenario closures on NWB context | V1 simulated |
| 28 | Blocked or degraded corridors | count | Scenario; later NWB/RWS events | V1 simulated |
| 29 | Rail operational status | % / categorical | Scenario; later ProRail open data | Next mixed |
| 30 | Emergency travel time | minutes | Accessibility model on road graph | Next derived |
| 31 | Critical-facility availability | % | Scenario hospital/fire/police/care model | V1 simulated |
| 32 | Care capacity at risk | beds / people | Aggregated facility context × dependencies | Next derived |
| 33 | Shelter capacity and occupancy | places / % | Municipal/safety-region scenario inventory | Next mixed |
| 34 | Safe food stock endurance | hours | Household/retail scenario assumptions | Next simulated |
| 35 | Emergency potable-water demand | litres/hour | Population and vulnerability demand model | Next derived |
| 36 | Emergency-supply delivery | u/h and % demand | Connected allocation graph | V1 simulated |
| 37 | Modeled equivalent population under service pressure | people / % | CBS population × transparent simulated service-pressure curve; not identified people | V3 derived |
| 38 | Vulnerable population proxy | people | Aggregated age, income, household, care proxies | Next derived |
| 39 | Local pre-network deprived person-hours | person-hours | Quarter-hour event-attributable integration of the declared weighted local eight-service shortfall; excludes network-transfer history and is not directly comparable to the current post-network pressure count | V3 derived |
| 40 | Confidence, freshness, and source class | category / timestamp | Metadata attached to every field | V1 metadata |

## Regional operational snapshot shape

```ts
interface EvidenceValue<T> {
  value: T | null
  unit: string
  state: 'official' | 'derived' | 'scenario' | 'unknown'
  publisher?: string
  datasetVersion?: string
  observedAt?: string
  issuedAt?: string
  validFrom?: string
  validThrough?: string
  retrievedAt?: string
  licence?: string
  uncertainty?: { low: number; high: number; confidence: number }
  noDataReason?: string
  affectsSimulation: boolean
}

interface RegionState {
  regionId: `GM${string}`
  step: number                 // 0..288
  minute: number               // step * 15
  population: EvidenceValue<number>
  hazard: {
    rainMmH: EvidenceValue<number>
    floodDepthM: EvidenceValue<number> // null until a source-specific hydraulic case supports metres
    inundationStress: EvidenceValue<number>
    windGustMs: EvidenceValue<number>
    heatC: EvidenceValue<number>
    severity: EvidenceValue<number>
  }
  services: Record<ServiceId, {
    availability: EvidenceValue<number> // 0..1 only when supported
    demand: EvidenceValue<number>
    delivered: EvidenceValue<number>
    reserveHours: EvidenceValue<number>
    status: OperationalStatus
    cause: string
  }>
  affectedPopulation: EvidenceValue<number>
  deprivedPersonHours: EvidenceValue<number>
  limitingService: ServiceId
}
```

## Data contract rules

- Layer selection changes presentation and route projection, never canonical municipal service state.
- `delivered ≤ demand`, route flow `≤ effective capacity`, and all availability values stay in `[0,1]`.
- Intercity redistribution conserves units: total donor loss equals total receiver gain.
- City district deliveries sum to the municipality gateway delivery and district populations/affected people reconcile to the municipal totals.
- Unknown official values remain `null`; do not silently replace them with zero.
- Synthetic values must remain visibly distinguishable from official context in the interface and exports.
