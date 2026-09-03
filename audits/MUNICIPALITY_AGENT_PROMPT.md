# Municipality reviewer runbook

Replace `GMXXXX` and `municipality_gmxxxx` with the assigned manifest entry. One agent turn owns
one municipality and writes only `audits/municipalities/GMXXXX.json`; it must not review a second
municipality or edit shared code/data. Read `README.md`, `municipality-audit.schema.json`,
`manifest.json`, and `correction-ledger.json` first.

1. Run `pnpm audit:context -- GMXXXX` and inspect the actual municipality, region, settlement,
   safety-region, NWB/ProRail and GTFS inputs consumed by the app. Do not infer missing values.
2. Run `MUNICIPALITY_AUDIT_CODE=GMXXXX pnpm audit:model`. This is the complete ten-preset,
   six-checkpoint, eight-service deterministic contract; add focused reproductions for local
   concerns. Also use `apps/web/src/scenarios.ts`, whose factory is required to equal the canonical
   sim-core presets.
3. Verify identity, boundary edition, population and material regional totals using primary
   CBS/PDOK sources. Cite at least one locally relevant primary authority (municipality, province,
   safety region, water board, KNMI/RIVM/Rijkswaterstaat/NIPV, or infrastructure operator).
4. Evaluate whether coastal/major-river/pluvial flooding, wind, heat/drought, winter weather,
   induced earthquake, wildfire/smoke and cyber forcing are locally plausible. A bounded output is
   not automatically a physically valid output. Separate direct local impact from indirect supply
   effects, and compare against local catchments, terrain, known risk areas and response plans.
5. Verify official zero and null semantics, neighborhood/woonplaats/settlement membership,
   cross-boundary routes, service-layer-invariant hazard, exact population/demand/delivery
   reconciliation, causal ledgers, determinism and event-attributable person-hours.
6. Treat NWB service flows, capacities, utility dependencies, backup, restoration and household
   preparedness as scenario/logical proxies unless primary operator evidence supports a stronger
   claim. Never invent sensitive or unavailable topology.
7. Prefer integration-ready public authoritative data over hand calibration. For each material
   correction, identify the strongest machine-readable dataset, API or downloadable layer that
   could drive it, including publisher, spatial/temporal resolution, update cadence and reuse
   licence when discoverable. If topology is unavailable or security-sensitive, say so explicitly
   and define the smallest transparent synthetic fallback; do not imply observed precision.
8. Use `correction-required` for a reproducible contradiction, `verified-with-caveats` when public
   inputs and model contracts pass but calibration is unavailable, and `blocked` only when the
   audit itself cannot be completed. Include exact finding IDs, evidence, actions, correction files
   and province-review flags.
9. Set `agent.taskName` to the unique manifest task, `agent.agentId` to the canonical worker path,
   and `completedAt` to the actual completion time. Validate JSON and run `pnpm audit:status`.

Keep the artifact evidence-dense and bounded: normally use 4–8 of the strongest primary sources and
6–12 material findings. Do not build an exhaustive local asset catalogue. Prioritize reproducible
model contradictions, first-72-hour dependencies, source/semantic errors and province-level review
flags so the national programme can move municipality by municipality without sacrificing its
release gate.

The final response must state the artifact path, verdict, important local issues, commands run and
that only the assigned JSON artifact was edited.
