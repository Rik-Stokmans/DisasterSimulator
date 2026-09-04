# NL Resilience Lab presentation

The editable deck is generated from the current DisasterSimulator repository and is intentionally broader than a short school presentation, so slides can be removed without breaking the story.

## Files

- `NL-Resilience-Lab-overview.pptx` — editable 16:9 PowerPoint deck with speaker notes.
- `NL-Resilience-Lab-overview.pdf` — portable presentation/export copy.
- `build-deck.cjs` — source used to regenerate the deck.

## Suggested cuts

- **5-minute version:** slides 1, 2, 3, 5, 6, 8, 14, 17.
- **10-minute version:** add slides 4, 7, 9, 11, 13 and 15.
- **Technical review:** keep the full deck; move slides 9, 13 and 16 to an appendix if needed.

## Accuracy notes

- Repository snapshot: 4 September 2026.
- Audit snapshot: 245 of 342 municipalities completed, generated 3 September 2026.
- Operational and official overlays are not described as causal inputs unless the engine explicitly binds them.
- Dataset counts shown in the deck come from the checked-in compressed GeoJSON fixtures.

To rebuild, install `pptxgenjs` in the local Node environment and run:

```sh
node presentations/build-deck.cjs
```

The deck uses Avenir Next. PowerPoint can substitute Aptos or another sans-serif if the font is unavailable.
