# Province reconciliation reviewer runbook

Province reviews begin only after all 342 municipality artifacts pass
`node scripts/validate-audit-program.mjs --allow-incomplete`. Replace `PROVINCE_NAME`,
`province_slug`, and `province_task_name` with the exact entry from `audits/manifest.json`.
One agent turn owns one province and writes only `audits/provinces/province_slug.json`; it must
not review a second province or edit shared model, data, UI, documentation, or deployment files.

1. Read `audits/README.md`, `province-audit.schema.json`, the province's manifest entry, every
   referenced `audits/municipalities/GMXXXX.json`, and all correction-ledger entries that cite
   those municipality finding IDs. Refuse to proceed if a listed municipality artifact is absent
   or invalid; a province review cannot fill a municipal evidence gap by assumption.
2. Run `pnpm audit:province-context -- "PROVINCE_NAME"`. Reconcile the reported municipality set,
   verdicts, open critical/high findings, safety-region membership, internal and cross-province
   routes, correction status, common-mode corridors, and province-review flags against the raw
   source files.
3. Review **every** municipality code in `municipalitiesExpected`; copy that exact complete set to
   `municipalitiesReviewed` and leave `missingMunicipalities` empty only after actual inspection.
   Sampling a large province is not acceptable.
4. Perform all eight required cross-boundary checks from the schema:
   `water-systems`, `transport`, `safety-regions`, `energy`, `telecom`, `healthcare`, `evacuation`,
   and `hazard-continuity`. Check both municipal boundaries inside the province and interfaces to
   neighbouring provinces, Germany, Belgium, the North Sea, Wadden islands, and major water bodies
   where applicable.
5. Reconcile repeated A/N-road, rail, ferry, bridge, tunnel, waterway, defence, pump, hospital,
   operator-area, and mutual-aid dependencies. Consecutive sections of one physical corridor are
   not independent redundancy. Static geometry, registration, nominal capacity, or an empty live
   feed never proves event-time operation.
6. Compare municipal hazard eligibility and Unknown/NoData semantics at shared borders. Reject
   discontinuities created only by municipality-centre distance, a shared random ranking, missing
   point observations, or different source coverage. A selected river/coastal/pluvial/fire/seismic
   event must have a compatible forcing, footprint, validity interval, and resolution on both
   sides of a border before it drives consequences.
7. Use current correction-ledger status, not the immutable audit verdict alone. `applied` means the
   recorded validation must still pass; `interim-mitigation` means false precision is withheld but
   the calibrated replacement remains unresolved. Do not upgrade an entire province to verified
   because fail-closed guards pass.
8. Cite primary, province-scale evidence in each cross-boundary check. Prefer provincial risk
   profiles and climate/stress-test portals, water authorities, Rijkswaterstaat, safety regions,
   RIVM/ROAZ, grid and telecom operators, official transport registers, KNMI, BRO, and cross-border
   authorities. Record inaccessible, security-sensitive, incompatible, stale, or unlicensed data
   as a residual limitation; never invent topology or operational state.
9. Use `correction-required` if any municipality has an unresolved contradiction or any
   cross-boundary check fails. `verified-with-caveats` requires all municipal contradictions to be
   resolved and only explicitly bounded calibration gaps to remain. `blocked` applies only when
   the province review itself cannot be completed.
10. Validate with `jq empty audits/provinces/province_slug.json` and
    `node scripts/validate-audit-program.mjs --allow-incomplete`. Report the artifact, verdict,
    exact municipality count, cross-boundary failures/warnings, aggregate findings, validation,
    and confirmation that only the assigned province JSON was edited.

Keep the artifact evidence-dense. Aggregate repeated municipal findings without erasing local
exceptions, and explicitly identify common corrections that should be implemented once at national
or province scale rather than 20–60 times independently.
