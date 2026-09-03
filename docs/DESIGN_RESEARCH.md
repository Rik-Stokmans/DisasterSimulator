# Design research and implementation decisions

## Inputs from the whiteboard and meeting

The whiteboard separated the problem into six decisions: split the map, choose regional statistics, identify data sources, define simulation logic, choose disaster types, and back the timeline with known data. The current V2 turns those into separate map modes, an explicit regional field catalogue, reproducible official-context ingestion, a deterministic multi-hazard dependency engine, and 289 inspectable quarter-hour states.

The meeting made the desired experience more specific:

- Treat a 72-hour power outage as a cascade across payments, traffic controls, food cooling, medical records, fuel access, transport, communications, water, sanitation, care, and emergency response.
- Represent different clocks. Workshop estimates included mobile degradation within roughly 6–12 hours, loss of much national data connectivity within about 8 hours, water-pressure problems that differ sharply for high floors, and longer gas endurance. These are design hypotheses from the meeting, not calibrated engineering facts.
- Make compound effects visible: heat or cold can amplify a power failure; loss of water can reduce hospital capability; loss of communications affects both citizens and the crisis organization itself.
- Support scarcity decisions, critical-service prioritization, municipal-versus-regional trade-offs, and disproportionate effects on vulnerable groups.
- Preserve privacy: use aggregated vulnerability indicators, not lists of individuals.
- Leave room for social behavior, self-sufficiency, public information, neighborhood organization, and trust in a later model.

The current scenario therefore emphasizes cause chains and delayed dependencies. It does not encode the workshop's timing estimates as verified facts; calibration must come from utility operators, safety regions, facility continuity plans, and published research.

### Meeting-to-feature traceability

| Meeting/whiteboard concern | First implementation behavior | Evidence still required before operational use |
|---|---|---|
| Split the map and choose regional statistics | Persistent Windy-like workspace with separate Hazard, Power, Water, Drainage, Gas, Telecom, Mobility, Facilities, Population and Supply questions; 36 official CBS buurt fields plus 40 operational metrics | Owner-approved layer definitions, decision thresholds and privacy aggregation level |
| Timeline backed by known data | One 0–72-hour scenario clock with 289 quarter-hour states; observations, forecasts, plans and simulated values keep separate issue/valid times and evidence classes | Archived event inputs for replay and operator-approved forecast-to-model bindings |
| Payments, traffic lights, cooling, medical records and fuel fail through a power cascade | Explicit service dependency graph and causal trace instead of independent percentage sliders | Calibrated dependency clocks, backup endurance, demand and restoration curves by asset/facility class |
| High floors may lose water differently | Proposed high-rise pressure-dependent population metric; building height/use stays static context and is not converted into affected people by itself | Drinking-water pressure-zone model, booster-pump dependencies, safe aggregation and building occupancy |
| Mobile/data channels and the crisis organization itself degrade | Telecom and public-information reach are separate; an Unknown-first action ledger must model warning issue, channel reach and confirmation rather than assuming successful communication | Authorized aggregate telecom resilience, emergency-network/analogue-channel endurance and exercise observations |
| Scarce generators, fuel, staff, transport, food, water and care must be prioritized | Typed resource and intervention backlog, route-aware Supply map and explicit requested/accepted/in-progress/completed action states | Real unit conversions, stock/endurance distributions, owner/priority rules and completion evidence |
| Municipal interests compete with regional missions | Municipality, safety-region and later province views share stable IDs; comparison and decision logging are planned | Governance rules, escalation thresholds and reviewed regional mutual-aid constraints |
| Vulnerable groups are hit disproportionately, but person-level lists create privacy and legal risk | Aggregate CBS vulnerability proxies only; no individuals, addresses or inferred medical status | DPIA, minimum-cell/suppression policy, fairness review and authorized care aggregates |
| Low-tech community response matters when digital systems fail | Public-information reach, support-point, neighborhood organization and self-sufficiency are explicit future modules; an unconfirmed point never becomes an open shelter | Authority-confirmed locations/functions, staffing, stock, accessibility, validity and analogue communication plans |

The workshop's quoted endurance estimates—such as hours for communications or days for water/gas—are hypotheses, not defaults. The simulator should expose them only as named exercise assumptions with ranges and sensitivity analysis until a responsible operator or validated study supplies the scope, start condition and uncertainty.

## Windy-inspired interaction model

The useful pattern is not visual imitation but interaction consistency:

1. One map remains the workspace.
2. A compact layer rail changes the question being asked.
3. Every layer has its own metric, palette, legend, and inspector wording.
4. Time is a first-class direct-manipulation control.
5. The selected place and timestamp persist when layers change.

The simulator implements this with 11 modes and a fixed 72-hour control. Hazard and population use distinct palettes; service layers use a shared operational-state palette so users learn the color grammar once.

Basemap, perspective, simulation question and context overlays are deliberately separate dimensions.
Switching from cartography to the annual PDOK aerial orthophoto, or from 2D to official PDOK 3D,
must not reset the selected municipality, scenario clock or service layer. Likewise, **Affected
regions** is a persistent simulation overlay rather than a twelfth statistic: it outlines the
municipalities affected at the current quarter-hour in amber/red and preserves unsupported spatial
evidence as gray Unknown. **Traffic + accidents** is independently toggleable observed context;
`Accident`, congestion and other DATEX II records keep their source publication/validity semantics
and expose whether delivery is live, stale, or the deployment fallback. A same-origin server adapter
refreshes through a 60-second cache because the public gzip is not a browser API. Records do not
become simulated road capacity merely because they are drawn over a scenario. This lets
an operator ask, for example, “where is drinking-water availability low, which surrounding regions
are affected, and what current road incidents complicate access?” without swapping among mutually
exclusive maps.

Traffic cameras follow the same composition rule but a stricter media boundary. An inventory point,
an online/offline observation and permission to display a live image are three different facts. The
browser contract therefore contains no vendor stream or credential, requires observation and expiry
times for media, and accepts only an allow-listed same-origin proxy after privacy/licence review. An
empty or failed adapter is labeled Unknown, never “no cameras” or an all-clear road state.

## Hearts-of-Iron-inspired supply model

The transferable idea is a readable logistics hierarchy:

```text
national capacity → intercity corridor → municipal gateway → local branches → demand sectors
```

Useful behaviors carried into V1:

- Bright lines show actual transfer direction; dormant links have no movement arrows.
- Capacity, health, utilization, reserve, demand, and delivered supply are different values.
- A constrained link or gateway is visually distinct from a destroyed/disconnected one.
- Allocation is automatic, while the user chooses high-level priorities and interventions.
- Zoom changes representation, not the underlying municipal total.

The implementation uses original terminology and generalized civilian infrastructure. Its inter-municipality corridors now follow real NWB geometry and topology; the visual design does not copy game assets or military calculations.

Primary references used for the interaction and logistics research:

- [Windy interactive weather map](https://www.windy.com/) for the persistent-place, changing-layer map workflow.
- Paradox's official Hearts of Iron IV supply-system development notes: [Supply System Details](https://steamcommunity.com/games/394360/announcements/detail/2979676242188327733) and [Supply and Mulberry Harbors](https://steamcommunity.com/games/394360/announcements/detail/2962794086561626765).
- [CBS Gebiedsindelingen through PDOK](https://api.pdok.nl/cbs/gebiedsindelingen/ogc/v1_0-demo/), [CBS table 86165NED](https://opendata.cbs.nl/#/CBS/nl/dataset/86165NED), and [Kadaster BRT Achtergrondkaart](https://service.pdok.nl/kadaster/brt-achtergrondkaart/wmts/v2_0/) for the official V1 context.

## Simulation logic

The model is deterministic and recalculates any requested quarter-hour independently:

1. A selected preset produces its own physical or digital forcing: storm, pluvial/river/coastal flood, heat/drought, winter weather, cyber disruption, earthquake, wildfire/smoke, or a declared compound event.
2. Season and the selected KNMI sensitivity path/horizon alter only relevant forcing and demand assumptions.
3. Direct service capacity responds to hazard exposure, preparedness, response delay, and a deterministic municipal resilience seed.
4. The real NWB-derived inter-municipality graph redistributes only Mobility and explicitly assumed road-logistics/Supply units across route capacity. It is prohibited from standing in for physical power, water, drainage, gas, telecom or facility topology.
5. Electricity constrains water, drainage, telecom, gas controls and critical facilities; mobility constrains emergency-supply delivery.
6. Remaining service networks redistribute units without exceeding capacity or creating supply.
7. The weakest services produce affected-population, status and cumulative-deprivation estimates.
8. City mode reconciles the municipal gateway total exactly across real CBS buurten, weighted by population and aggregate vulnerability context.

Every operational claim is labeled scenario/synthetic. Tests cover determinism, layer independence, conservation, zero-capacity behavior, route bounds, climate/season controls, cyber pre-start behavior, reverse-flow geometry, city reconciliation, exact timeline endpoints, and cumulative impact monotonicity.

## Implemented scenario packs and their next calibration step

1. **Severe/winter storm:** calibrate wind and ice fragility plus empirically supported backup clocks.
2. **Pluvial, coastal and river flood:** replace the analytic footprint with selected LIWO arrival/depth rasters; add evacuation, tunnels, shelters, pumps and potable-water contamination.
3. **Wildfire/drought:** add KNMI fire-weather inputs, land-cover fuels, smoke transport, closures, firefighting water and evacuation.
4. **Heatwave:** calibrate cooling/water demand, care vulnerability, surface-water quality and workforce limits.
5. **Groningen earthquake:** add scenario-specific ground motion, building archetype damage, gas safety shutdowns and shelter demand.
6. **Cyber disruption:** calibrate service-specific RTO/RPO, backup control, uncertain situational awareness and recovery playbooks with operators.
7. **Compound cascade:** give each component its own footprint, onset, duration and confidence distribution.

Each pack should declare its geographic validity, initiating event, evidence sources, uncertain parameters, validation owner, and permitted decisions. Avoid a single universal “disaster severity” slider that hides different causal mechanisms.

## Recommended implementation sequence

1. Replace analytic flood forcing with named LIWO scenarios and representative KNMI event time series.
2. Add separate, authorized graphs for electricity, drinking water, gas and telecom instead of projecting services over one road-derived connectivity graph.
3. Introduce typed resources (MW, m³/h, litres, vehicles, beds, meals, messages) instead of generalized units.
4. Add facilities, sources, bridges, tunnels and depots as separate graph nodes, not only municipality gateways.
5. Calibrate dependency clocks and backup policies with Eindhoven and Veiligheidsregio Brabant-Zuidoost.
6. Add uncertainty ensembles, decision logging, saved comparisons and after-action export.
7. Add aggregated social-response modules: information reach, spontaneous help, compliance, trust, shelter choice and self-sufficiency.
8. Create formal validation suites for historical case replay, subject-matter review, privacy and provenance alongside the existing conservation/data checks.

## Guardrails

- Never display synthetic lines as real power, gas, water, telecom, or emergency routes.
- Avoid asset-level sensitive infrastructure unless the data owner explicitly authorizes its use.
- Do not infer vulnerable individuals. Aggregate to a privacy-safe region and explain proxy limitations.
- Show uncertainty and source class alongside every operational metric.
- Keep scenario exploration separate from live incident command unless the model is independently validated for that use.
