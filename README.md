# jxf-site-experiments

Self-contained interactive explorations ("experiments") that are embedded into
[jxf-site](https://github.com/fj/jxf-site). This repo owns each experiment's
implementation; the site owns routing, page chrome, and the thin glue that
mounts an experiment into a page.

## How embedding works

jxf-site includes this repo as a git submodule at `site/assets/experiments/`.
For each experiment the site renders an empty mount element plus `<link>`/
`<script>` tags pointing at the files here:

- `manifest.yaml` — declares what the experiment is made of: its mount element,
  stylesheets, third-party dependencies (fetched at build time, pinned + verified
  via SRI), and local scripts in load order. The host reads this and hardcodes
  nothing about the experiment.
- `style.scss` — compiled to CSS by Hugo's SCSS step (self-contained; no shared
  imports). The dark variants key off `body.colorscheme-dark`, the class the
  site theme's toggle sets, so the experiment inherits the site's look.
- `app.js` — builds its own DOM inside the mount element and renders the
  experiment (d3). It reads its data from a global.
- `data.js` — sets `window.JXF_EXP_DATA["<name>"]`. Shipped as **JS, not JSON**,
  so the host page loads it with a plain `<script src>` and never runs it
  through a JSON/templating pipeline.
Third-party libraries (e.g. d3 v7) are **not committed here** — they're declared
as dependencies in `manifest.yaml`. The host pulls them down at build time
(verifying the pinned SRI) and serves them self-hosted, so this repo stays free of
vendored blobs and the dependency list lives with the experiment, not the host.

Because the app runs in the host page's document, it inherits the site's fonts,
colours, and dark mode while bringing its own scoped `.llmx-*` component styles.

## Experiments

### `llm-explorer/`

An interactive scatter plot comparing popular language models on cost vs. output
speed, with workload-aware cost (input/output token mix, request size, cache).

Regenerate its dataset:

```sh
python3 tools/build-llm-explorer-dataset.py           # fetch models.dev live
python3 tools/build-llm-explorer-dataset.py path.json # or build from a local copy
```

Pricing/metadata come from [models.dev](https://models.dev); median output
tokens/sec are indicative figures compiled from public
[Artificial Analysis](https://artificialanalysis.ai) benchmarks.
