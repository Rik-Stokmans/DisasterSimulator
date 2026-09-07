# DisasterSimulator showcase submission

## File to submit

Submit **`DisasterSimulator-showcase.pdf`**. It is a single-page 16:9 visual
summary designed to be understood in two to five minutes.

`DisasterSimulator-showcase.png` is an image alternative or quick preview.
`showcase.html` and `assets/` are the editable source bundle.

## Requirement checklist

- **Group members:** Daniil, Vince and Rik.
- **Problem:** cascading failure of essential systems during the first 72 hours.
- **Target group:** municipal crisis teams, safety regions, infrastructure
  partners and tabletop-exercise facilitators.
- **Solution:** an interactive national-to-neighbourhood scenario simulator with
  separate system maps, a 72-hour timeline, interventions and explanations.
- **Testing:** stakeholder problem briefing, end-to-end proof-of-concept
  walkthroughs, 147 passing automated tests, and generated-data validation for
  all 342 municipalities and 14,729 neighbourhoods.
- **Learning:** a realistic interface must distinguish observed public data,
  model assumptions and Unknown/NoData; reproducibility is not prediction.
- **Visual evidence:** one full prototype screenshot and one nationwide impact
  inset are embedded in the page.

## Accuracy boundary

This is a scenario-exploration prototype. It has not been calibrated or
validated for live operational dispatch, evacuation orders or real resource
commitments. The visual summary keeps that limitation visible.

## Rebuild

From the repository root:

```sh
node submission/build-showcase.mjs
```
