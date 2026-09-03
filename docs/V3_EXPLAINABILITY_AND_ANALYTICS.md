# V3 realism, explainability and analytics

V3 makes the prototype substantially more inspectable and configurable. It is
still a deterministic scenario-exploration model, not an operational forecast,
asset register or calibrated digital twin. This document records what the
interface can support, what each class of value means, and what must happen
before the model can support real crisis decisions.

## What V3 adds

- Structured causal traces for hazard, service, municipality and buurt results.
- Signed contribution ledgers, explicit dependencies and backup windows,
  inspectable drivers, and deterministic what-if substitutions/reruns.
- Advanced controls for local start time, day type, demand, network capacity,
  backup endurance, repair capacity, household preparedness, climate overrides,
  deterministic seed, geographic focus and compound-hazard membership.
- A compact history API plus a background worker. The map retains all 289
  quarter-hour states; analytics samples 25 full-network states at three-hour
  intervals so the map remains responsive.
- Searchable charts for all 60 numeric model outputs: six national outputs,
  five municipal-impact outputs, 17 hazard fields and four fields for each of
  eight essential services.
- Distribution graphs for all 36 official CBS buurt fields. These are cross-
  sectional observations, not invented time series. Null and suppressed values
  stay missing.
- Hazard-specific map motion, directional model-transfer motion, stressed-node
  signals, selection pulses, and a fully static `prefers-reduced-motion` mode.
- The 25 official safety-region boundaries and labels from CBS/PDOK 2025.
- Buurt allocation sensitivity to aggregate CBS context such as age 65+, one-
  person households, housing form, social assistance, car availability,
  density and distance to essential services.

## Evidence classes

The interface intentionally uses three different kinds of information:

| Class | Examples | Meaning |
|---|---|---|
| Official/observed context | CBS boundaries and 36 buurt fields, BAG woonplaatsen, NWB roads, ProRail, GTFS and safety regions | A sourced geographic or statistical observation with an edition/retrieval record. Missing official values remain missing. |
| Scenario input | Disaster, season, intensity, duration, response delay and advanced controls | A user-selected condition for sensitivity analysis. It is neither an observation nor a probability. |
| Model-derived | Hazard proxies, demand, delivery, availability, reserves, logical transfers, residents under pressure and person-hours | A deterministic calculation from official context and scenario assumptions. It is not live telemetry or a forecast. |

Official geography does not make the overlaid impact official. Every map layer
retains a visible “scenario” or “derived” source class, and the analytics method
tab repeats this boundary.

## What an explanation means

Each contribution includes its raw input, normalized value where applicable,
signed effect, target, unit, method and evidence confidence. Three methods are
distinguished:

1. **Exact stage delta** is the arithmetic difference before and after one
   documented model stage.
2. **Exact counterfactual** substitutes or reruns a condition and reports the
   deterministic difference from the displayed result.
3. **Proportional attribution** divides an exact combined stage loss among its
   inputs in proportion to their modeled pressure. It makes the equation
   readable but is not empirical causal inference.

Service traces expose direct hazard pressure, recovery progress, upstream
dependencies, backup status, network-transfer effect and intervention effect.
Municipality traces expose the declared headline weights for all eight services:
electricity 18%, water 15%, drainage 8%, gas/heating 9%, telecom 12%, mobility
12%, critical facilities 14% and emergency supply 12%.

The displayed “modeled residents under service pressure” is a current,
post-network equivalent count derived from CBS population and the model's
weighted service-pressure curve. It does not identify people and is not an
observed casualty, outage or needs count. The separately labelled “local
pre-network deprived person-hours” metric numerically integrates the declared
local eight-service shortfall in 15-minute steps above a matched no-event
baseline. Network transfers are excluded from that historical integral, so zero
local burden can coexist with nonzero current post-network pressure and the two
metrics must not be read as directly comparable scopes.

## Regional context and privacy

Buurt context changes modeled allocation need, not individual identity. A
service-specific transparent coefficient table turns available aggregate fields
into a bounded demand/vulnerability multiplier. Missing fields have neutral
effect and reduce the displayed context-coverage score.

These are ecological proxies. They must not be used to label an individual as
vulnerable, deprioritize an area, infer protected attributes or replace local
knowledge. Before operational use, the coefficient table requires review by
municipalities, safety regions, public-health specialists and affected
communities.

The household-preparedness default is 44% because a 2026 national survey release
reported that share of respondents saying they had an emergency kit. It is
explicitly a national sensitivity proxy—not a regional CBS observation, a
complete-kit probability or proof of 72-hour self-sufficiency. The model keeps
this separate from infrastructure preparedness.

## Map semantics

- Official road, rail, transit and boundary geometry stays static.
- Moving colored NWB lines are **logical Mobility and road-logistics/Supply
  transfers**. They are never physical electricity, water, drainage, gas,
  telecom or facility assets. Those services use municipality-level synthetic
  indices until service-specific, security-reviewed topology is supplied.
- Time-bounded official restrictions affect a route only when the scenario has
  an explicit ISO reference date inside the source validity interval. A blank
  date keeps observations and plans visible without silently replaying them.
- Hazard animation is driven by the current modeled severity and disaster type.
  It communicates change; it adds no stochastic or physical state.
- Safety-region boundaries provide response geography. A safety region
  coordinates the common picture, population care and partners; it does not
  operate utility networks.

## First-72-hour interpretation

The public Dutch preparedness campaign asks households to bridge the first 72
hours, while government and responders prioritize critical locations. The
simulator therefore treats 72 hours as the planning horizon and maintains
different dependency/backup clocks. The generic timeline markers are checkpoints
or assumption activation times; they do not claim that a real failure must occur
at that hour.

An evidence-informed power-loss exercise can consider the following sequence,
but only as an illustrative template:

- **0–2 hours:** grid-powered household/business functions and some transport,
  pumps and communications are immediately constrained; critical sites transfer
  to backup arrangements.
- **2–8 hours:** congestion and finite telecom backup can matter; payments,
  ordinary fuel access and retail become relevant dependencies.
- **8–24 hours:** staffing, access, food/cold-chain and sanitation pressure can
  accumulate, with large geographic and weather differences.
- **24–72 hours:** generator fuel, healthcare logistics, drinking-water access,
  drainage and emergency distribution can dominate.

The NIPV describes such timelines as an illustrative synthesis. V3 does not
hardcode those statements as observations.

## Primary references

- [NCTV: vital infrastructure](https://www.nctv.nl/onderwerpen/v/vitale-infrastructuur)
  and the [2025 threat landscape](https://www.nctv.nl/site/binaries/site-content/collections/documents/2025/07/23/dreigingslandschap-vitale-infrastructuur/Dreigingslandschap%2BVitale%2BInfrastructuur%2B%282025%29.pdf)
  for cross-sector dependencies and hidden coupling.
- [NIPV: power outage expectations and preparedness, 2026](https://nipv.nl/wp-content/uploads/2026/05/20260512-NIPV-Stroomuitval-verwachtingen-en-voorbereidingen-in-Nederland.pdf)
  for an explicitly illustrative 0–72-hour consequence synthesis.
- [Rijksoverheid: emergency kit](https://www.rijksoverheid.nl/vraag-en-antwoord/veiligheidsregios-en-crisisbeheersing/wat-zit-er-in-een-noodpakket)
  for 72-hour preparation and three litres of water per person per day.
- [Rijksoverheid: 2026 preparedness survey](https://www.rijksoverheid.nl/actueel/nieuws/2026/04/13/steeds-meer-nederlanders-bereiden-zich-voor-op-noodsituatie-door-denk-vooruit)
  for the carefully qualified 44% reported-emergency-kit proxy.
- [KNMI’23 core figures](https://www.klimaatscenarios-data.knmi.nl/kerncijfers)
  and [KNMI scenario publication](https://www.knmi.nl/kennis-en-datacentrum/publicatie/knmi-23-klimaatscenario-s-voor-nederland)
  for climate-sensitivity context. KNMI scenarios are not event forecasts.
- [LIWO](https://iplo.nl/thema/water/applicaties-modellen/berichtgeving-crisismanagement/liwo/)
  for authoritative professional flood-information layers and their
  interpretation boundary.
- [RIVM: heat-vulnerable groups](https://www.rivm.nl/hitte/kwetsbare-groepen)
  and [National Heat Plan](https://www.rivm.nl/hitte/nationaal-hitteplan) for
  aggregate heat-vulnerability mechanisms.
- [NCSC: recovery from a cyber incident](https://www.ncsc.nl/incidenten-en-herstellen/herstel-van-een-cyberincident)
  for process dependencies, BIA, MTPD, RTO, RPO, backups and staged recovery.
- [Rijksoverheid: safety regions](https://www.rijksoverheid.nl/themas/recht-veiligheid-en-defensie/veiligheidsregios-en-crisisbeheersing/veiligheidsregios)
  and [NIPV guidance on vital-service disruption](https://nipv.nl/documenten/handreiking-de-veiligheidsregio-bij-dreigende-verstoring-of-uitval-van-vitale-voorzieningen/)
  for coordination roles and operator responsibility.
- [National Crisis Plan Electricity](https://www.nctv.nl/site/binaries/site-content/collections/documents/2022/03/15/nationaal-crisisplan-elektriciteit-2021/nationaal-crisisplan-elektriciteit-2021.pdf)
  and [National Crisis Plan Gas](https://www.nctv.nl/site/binaries/site-content/collections/documents/2022/03/15/nationaal-crisisplan-gas-2021/nationaal-crisisplan-gas-2021.pdf)
  for sector roles and restoration constraints.
- [Drinkwaterwet](https://wetten.overheid.nl/BWBR0026338/2024-01-01),
  [Drinkwaterbesluit](https://wetten.overheid.nl/BWBR0030111/2024-01-01/0) and
  [ILT delivery plans](https://www.ilent.nl/onderwerpen/drinkwater/besluiten)
  for continuity and emergency drinking-water responsibilities.
- [RDI: 112 during outages](https://www.rdi.nl/onderwerpen/consumenten/informatiepunt-112/veelgestelde-vragen)
  for finite backup and selective generator deployment.
- [NDW open data](https://opendata.ndw.nu/) and
  [situation-message documentation](https://docs.ndw.nu/producten/situatieberichten-v3/)
  for future measured road speed, closure and incident integration.

## Highest-priority calibration backlog

1. Replace shared logical corridors with authorized sector-specific aggregate
   networks or hide them when no defensible topology exists.
2. Replace synthetic flood depth/arrival with named LIWO-compatible scenarios
   and validated local hydrodynamic/drainage inputs.
3. Split generic facilities into hospital/SEH, nursing/home care, GP/pharmacy,
   ambulance/fire and emergency coordination, each with typed dependencies.
4. Split drinking water into production/quality, network pressure, high-rise
   access and emergency distribution; model statutory litres and distribution
   points rather than generic units.
5. Give drainage storage, inflow, pump and overflow state; give gas linepack,
   depressurization and safe restart state; split telecom into fixed, mobile,
   voice/SMS and 112 reachability.
6. Turn response options into inventories of crews, generators, fuel, tankers,
   depots, travel time, dispatch delay and failure modes.
7. Generate operational events from threshold crossings rather than generic
   timeline positions.
8. Add low/base/high ensembles, parameter sensitivity rankings and historical
   incident replay. A deterministic seed provides reproducibility, not
   confidence.
9. Calibrate Eindhoven and Veiligheidsregio Brabant-Zuidoost with infrastructure
   operators, GHOR/healthcare partners, water boards and exercises before any
   operational claim.

## V3 acceptance boundary

V3 is suitable for product exploration, tabletop discussion, teaching about
dependencies and testing interface concepts. It is not suitable for dispatch,
evacuation, infrastructure switching, public warnings, resource commitment or
estimates of actual casualties/outages. Those uses require named scenario data,
operator review, uncertainty, validation ownership, secure data governance and
independent evaluation.
