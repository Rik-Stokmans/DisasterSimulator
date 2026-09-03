# Netherlands municipality accuracy programme

This directory is the evidence ledger for the simulator's municipality-by-municipality review.
It deliberately separates three claims that must not be confused:

1. **Official input verified** — an identity, boundary, population, neighbourhood, settlement,
   safety-region, or transport datum agrees with a cited public primary source.
2. **Model contract verified** — deterministic simulation outputs remain finite, bounded,
   reconciled, reproducible, and causally explainable for the municipality.
3. **Locally calibrated** — a hazard or service parameter has been calibrated against local
   measurements or operator data. This stronger claim is only allowed when the audit cites that
   evidence. Public-data verification alone never establishes physical utility topology.

Independent municipality artifacts preserve the reviewer's findings at completion time. Shared
fixes applied after a review are tracked separately in `correction-ledger.json`; this avoids
silently rewriting the original evidence while still giving province reviewers a current status.

## Required sequence

1. Generate `manifest.json` with `pnpm audit:manifest`.
2. Run exactly one distinct subagent task for every entry in `manifest.json.municipalities`.
   The runtime permits only three worker threads beside the coordinator, so a completed worker is
   reused for later tasks; `agent.taskName` and the evidence artifact remain unique per municipality
   even though a canonical `agentId` can recur.
3. Each municipality agent writes exactly one `municipalities/GMxxxx.json` file conforming to
   `municipality-audit.schema.json`. Agents may report corrections, but shared model/data changes
   are integrated centrally to avoid conflicting edits.
4. Only after all 342 municipality artifacts validate, run one distinct reviewer for each of the
   12 provinces. Province reviewers reconcile every contained municipality and write a file under
   `provinces/` conforming to `province-audit.schema.json`. Use
   `pnpm audit:province-context -- "Province name"`; it refuses an incomplete municipality set by
   default. `--allow-incomplete` is for coordinator readiness inspection only, never final review.
5. At least three independent UI agents write optimization reviews under `ui/`; accepted changes
   must be measured and regression-tested.
6. `pnpm audit:validate` is the completion gate. During the programme,
   `pnpm audit:status` validates completed artifacts while allowing unfinished entries.

## Municipality-agent contract

An agent receives one municipality code and no second municipality. It must:

- inspect the generated municipality, regional, settlement, safety-region, national road/rail,
  and transit data actually consumed by the application;
- verify code, name, province, safety region, boundary edition, municipality centre, population,
  neighbourhood/woonplaats membership, and material demographic totals against primary sources;
- examine all ten scenario presets, all eight services, and checkpoints at T+0, 6, 12, 24, 48,
  and 72 hours using the shared deterministic coverage test;
- assess local spatial plausibility for coastal/river/pluvial flooding, wind, heat/drought,
  winter weather, earthquake, wildfire/smoke, and cyber disruption;
- verify causal ledgers, dependency chains, local population/demand/delivery reconciliation,
  bounds, determinism, and monotonic cumulative person-hours;
- cite at least three primary sources, including CBS/PDOK and at least one locally relevant
  authority such as the municipality, province, safety region, water board, RIVM, KNMI, NIPV,
  Rijkswaterstaat, BRO, or an infrastructure operator;
- label inaccessible or non-public infrastructure facts as residual limitations instead of
  inventing precision;
- use `correction-required` when evidence contradicts an input or behavior, and describe a
  reproducible correction and validation path.

`verified-with-caveats` is the expected honest verdict for many municipalities: public geography
and demography can be verified, while electricity, drinking-water, gas, telecom, and emergency
logistics networks generally cannot be fully calibrated from open data.

## UI-agent contract

The three independent UI tracks are `runtime-map-performance`, `operations-workflow`, and
`accessibility-mobile-visualization`. Each agent owns exactly one track, writes one JSON artifact
conforming to `ui-audit.schema.json`, and must inspect the running application rather than only
reading source code. Reviews must contain reproducible methods, at least one before/after or
before-only baseline measurement, prioritized findings, the disposition of each recommendation,
and the commands or browser checks used for validation. An empty “looks good” review does not
count. Changes are integrated centrally after resolving conflicts across the three tracks.
