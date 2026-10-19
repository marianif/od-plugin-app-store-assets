# Changelog

All notable changes to this plugin are documented here. The plugin follows
semantic versioning; `specVersion` (OpenDesign plugin spec) is separate from the
plugin `version`.

## 0.1.0 — 2026-10-19

First public release.

- Portable `SKILL.md` + `open-design.json` (specVersion 1.0.0), no runtime deps.
- Canvases: `screenshot` (top/bottom/quiet), `widgets`, `watch` (app/duo/faces),
  `header`, `search`, `event-card`, `event-detail`.
- Scripts: bootstrap, compose, render, validate, refdata, asc-upload (+ libs).
- Exact-size rendering through the OpenDesign desktop exporter (CSS points ×2,
  always opaque RGB).
- Validator: exact pixels, format, alpha, size, count limits, ordering,
  kind/spec/placement agreement, and copy lint (prices, URLs, ©/®/™, Apple
  recognitions, other platforms, unverifiable claims).
- Uploader: App Store Connect App Asset Library (ASC API 4.5.1+) — reserve,
  upload, commit, poll, placement, ordering. Dry-run by default.
- Revision tracking: reference names carry a content digest; a re-rendered file
  replaces its previous placement and retires the superseded image. Unchanged
  files are adopted. `--prune` removes assets no longer in the plan.
- Strict event locales (exact match, no silent fallback), and the file-format
  preflight now rejects bytes that disagree with the extension.
- `scripts/selftest.mjs` covers the image gates with real generated fixtures.
- Live spec resolution from `GET /v1/appAssetLibraryRefData` with a dated
  offline snapshot (2026-10-18) as fallback.
- Verified live on App Store Connect: 8 iPhone screenshots placed and ordered,
  plus product-page header and search-results creative.
- Deferred (see `ROADMAP.md`): in-app event record creation, app preview videos,
  locale expansion, iPad/Watch groups beyond the initial set, review submission.
