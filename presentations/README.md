# NL Resilience Lab presentation

The presentation is a five-page HTML-first 16:9 executive overview. It uses one
idea per page, large type and a small number of product screenshots so it
remains readable both on a projector and as a PDF.

## Files

- `overview.html` — editable presentation source with presenter notes.
- `NL-Resilience-Lab-overview.pdf` — generated presentation.
- `build-pdf.mjs` — Playwright export plus layout-overflow validation.
- `NL-Resilience-Lab-overview.pptx` / `build-deck.cjs` — legacy PowerPoint
  version, kept only for reference.

## Suggested delivery

- **Overview:** present all five pages in roughly three to five minutes.
- **Live demo:** continue from page 4 with one scenario, one changed assumption
  and one explained downstream effect, then return to page 5 for questions.

## Accuracy notes

- Repository snapshot: 4 September 2026.
- Audit snapshot: 245 of 342 municipalities completed, generated 3 September 2026.
- Operational and official overlays are not described as causal inputs unless the engine explicitly binds them.
- Dataset counts shown in the deck come from the checked-in compressed GeoJSON fixtures.

To rebuild from the repository root, run:

```sh
pnpm presentation:build
```

The export uses the checked-in Playwright dependency and fails when visible slide
content overflows its layout. Open `overview.html` directly in a browser for an
editable, searchable preview.
