# Simulation-core V3 integration

The engine returns deterministic explanations with every municipality frame.
They expose the intermediate calculations used by the model; they are not
post-hoc generated prose and they are not empirical causal estimates.

## Causal contract

- `municipality.hazard.explanation` contains all eleven hazard dimensions,
  scenario/climate drivers, and exact no-event/reference-climate/preparedness
  reruns.
- `municipality.services[service].explanation` follows the calculation order:
  baseline resilience, direct hazard damage, restoration, immediate upstream
  dependency or backup, intervention, and network transfer.
- `municipality.explanation` decomposes system pressure across all eight
  essential services.
- `district.explanation` records the aggregate regional context used for
  service-specific demand and allocation.

`CauseContribution.effect` always means `targetAfter - targetBefore`. Filter by
`target` before adding contributions. Availability-stage effects reconstruct
final availability exactly from a starting value of 1. System-pressure effects
sum exactly to the headline system pressure. Hazard-dimension effects use
`proportional-attribution`; the named counterfactuals use exact deterministic
reruns.

The current transparent system-pressure weights sum to 1:

| Service | Weight |
| --- | ---: |
| Power | 0.18 |
| Water | 0.15 |
| Drainage | 0.08 |
| Gas | 0.09 |
| Telecom | 0.12 |
| Mobility | 0.12 |
| Facilities | 0.14 |
| Supply | 0.12 |

These weights and every vulnerability coefficient are model assumptions, not
calibrated Dutch consequence functions.

## Operations controls

`ScenarioConfig` accepts `dayType`, `startClockHour`, `demandMultiplier`,
`backupMultiplier`, `networkCapacityMultiplier`, `repairCapacityMultiplier`,
and `householdPreparedness`. Omitted fields normalize to the old neutral
behavior. Household preparedness changes human need, supply demand/reserves,
and modeled human impact; it never changes physical asset fragility.

## Official regional context

Populate `LocalRegionDefinition.context` with fractions in the range 0..1 and
the named physical units. The engine supports age 65+, one-person households,
multi-family homes, social-assistance recipients, cars per household,
population density, GP/supermarket distance, and land/water area. Missing
fields are neutral and reduce `contextCoverage`; they are never silently
presented as observed values.

Aggregate business establishments and non-residential building counts may add
a separate local demand-allocation weight. This preserves official zero
resident counts in industrial areas and does not infer occupancy, criticality,
employment or measured utility load.

Regional context changes relative local demand and allocation by service, then
reconciles exactly to the municipality's demand and delivered-supply totals.
It is aggregate-area context and must not be described as an individual risk
score.

## Chart history

```ts
const history = simulateHistory(municipalities, simulationOptions, {
  municipalityIds: [selectedMunicipalityId],
})
const series = municipalityChartSeries(history, selectedMunicipalityId)
```

The responsive default returns 73 hourly points in `isolated` mode and retains
only compact numeric history. Use `intervalSteps: 1` for all 289 quarter-hour
points. Use `networkMode: 'full'` plus the real route definitions when national
network balancing must be included; run that option in a Web Worker. The batch
implementation caches cumulative per-city hazard/service history instead of
recomputing all preceding quarter hours for every sample.

`municipalityChartSeries()` returns all 17 numeric hazard metrics, four metrics
for each of eight services, and four municipality metrics. `nationalChartSeries()`
returns all six aggregate frame metrics.

## Required caveats in the UI

- A supplied NWB road graph is a **logical transfer proxy** for non-mobility
  services. It is not physical power, water, gas, or telecom topology.
- `affectedPopulation` is a modeled people-equivalent under service pressure,
  not an observed headcount.
- `deprivedPersonHours` is the quarter-hour integral of event-attributable
  weighted local service shortfall above a matched no-event baseline, before
  intermunicipal transfers and adjusted for household preparedness.
- `floodDepthM` is a legacy depth-like scenario amplitude, not a hydraulic or
  surveyed water-depth estimate. User-facing views normalize it to inundation
  stress until source-specific LIWO/breach rasters are calibrated.
- Determinism means reproducibility, not calibration or forecast confidence.
