---
name: app-store-assets
description: |
  Use this plugin when the user wants App Store artwork: screenshots,
  product-page header, search-results creative, or In-App Event media.
  It composes exact-size canvases from real app captures, validates them
  against Apple's specs and content rules, and uploads to the App Store
  Connect Asset Library on confirmation.
license: MIT
metadata:
  author: the-wedge
  version: "0.1.0"
od:
  mode: image
  scenario: marketing
  platform: mobile
  preview:
    type: html
    entry: preview/index.html
  design_system:
    requires: false
---

# App Store Assets

Produce App Store artwork that survives App Review and reads well at search
size. The plugin composes supplied app captures into exact-size canvases, checks
the mechanical rules, and uploads through the App Store Connect Asset Library.
It does **not** invent app UI and it does **not** submit anything for review.

## Resource map

```
.app-store-assets/
├── assets/canvases/      screenshot | header | search | event-card | event-detail
├── scripts/              bootstrap, compose, render, validate, refdata, asc-upload
├── references/
│   ├── apple-asset-rules.md     specs + policy rubric
│   ├── asc-asset-library.md     API playbook, states, errors
│   ├── copy-guidelines.md       caption rules + banned claims
│   └── refdata-snapshot.json    offline fallback (2026-10-18)
└── bootstrap.json
```

Read `references/apple-asset-rules.md` before writing copy. Read
`references/asc-asset-library.md` before the upload step.

## Step 0 — Bootstrap

Inside an OpenDesign project, copy the runtime files once:

```bash
mkdir -p .app-store-assets
curl -fsSL "$OD_DAEMON_URL/api/plugins/app-store-assets/asset/scripts/bootstrap.mjs" \
  -o .app-store-assets/bootstrap.mjs ||
curl -fsSL "$OD_DAEMON_URL/api/plugins/community-app-store-assets/asset/scripts/bootstrap.mjs" \
  -o .app-store-assets/bootstrap.mjs
node .app-store-assets/bootstrap.mjs
```

The first URL is the standalone plugin id; the second the OpenDesign community
id. `bootstrap.mjs` also probes both ids itself; pass `--plugin-id <id>` if you
installed under a different name. It reports the resolved id in
`bootstrap.json`.

If `OD_DAEMON_URL` is unset, resolve it from the CLI first:

```bash
[ -n "$OD_DAEMON_URL" ] || export OD_DAEMON_URL=$(
  "$OD_NODE_BIN" "$OD_BIN" daemon status --json |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('http://127.0.0.1:'+JSON.parse(s).port))"
)
```

From a local checkout, bootstrap with `node scripts/bootstrap.mjs --out .app-store-assets`.

Checkpoint: `.app-store-assets/bootstrap.json` exists and lists 20 files.

## Step 1 — Intake

Ask only for what is missing:

- App name and App Store Connect app id (upload only).
- Platform/device groups: iPhone only by default; iPad only if the app ships
  iPad UI.
- Version string for placement (e.g. `1.4`).
- Asset set: screenshots, creative (header + search), events, or all.
- Locale: default **en-US**. Other locales are a follow-up run.
- Raw captures: full-resolution app screenshots, one per screen. If the user
  cannot supply them, offer to capture from the iOS Simulator with
  `xcrun simctl io booted screenshot`; never fabricate a screen.
- Brand tokens: read the active `DESIGN.md` / `tokens.css`; fall back to
  `assets/tokens.example.css` only for a neutral demo.

Defaults: iPhone large (`iphone-1320x2868`), 5–8 screenshots, text-led layout,
one idea per screen.

## Step 2 — Write the asset plan

Create `asset-plan.json` **before** composing. One row per output file:

```json
{
  "version": 1,
  "app": "Trackly",
  "locale": "en-US",
  "ascAppId": "1234567890",
  "versionString": "1.4",
  "theme": {
    "bg": "#f4efe6",
    "ink": "#0f2a22",
    "accent": "#206956",
    "muted": "#5a6b64",
    "panel": "#e9f4ef"
  },
  "assets": [
    {
      "id": "shot-01",
      "kind": "screenshot",
      "spec": "iphone-1320x2868",
      "file": "store/en-US/iphone-1320x2868/01.png",
      "html": "store/en-US/iphone-1320x2868/01.html",
      "copy": {
        "brand": "TRACKLY",
        "headline": "Know exactly what you can spend.",
        "subline": "Set a monthly limit and see what is left."
      },
      "order": 1,
      "placementType": "APP_SCREENSHOT",
      "placementGroup": "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE"
    }
  ]
}
```

Rules for the plan:

- `spec` is a key from `references/refdata-snapshot.json` (e.g.
  `iphone-1320x2868`, `header-3840x1646`, `search-3840x2560`,
  `event-card-3840x2160`, `event-detail-2160x3840`).
- `file` and `html` are project-relative.
- Screenshot `order` starts at 1, is unique per placement group, and tells the
  story (strongest feature first).
- `placementGroup` may be omitted only for specs whose snapshot value is known.
  For medium iPhone, iPad, and event detail, resolve it from live ref data and
  fill it in before upload.
- Copy lives in the plan, never baked into an untracked image.

## Step 3 — Compose the canvases

For each plan row, write a small data file and compose:

```bash
node .app-store-assets/scripts/compose.mjs \
  --template .app-store-assets/assets/canvases/screenshot.html \
  --out store/en-US/iphone-1320x2868/01.html \
  --shot store/source/01-home.png \
  --data-file .tmp/shot-01.json
```

Data fields per canvas:

| Canvas | Fields |
| --- | --- |
| `screenshot.html` | `brand`, `headline`, `subline`, `shot`, `layout` (`top`/`bottom`/`quiet`), `theme` |
| `widgets.html` | `brand`, `headline`, `subline`, `widgets` (`medium`, `small`, `voice`, `recent` paths), `theme` |
| `watch.html` | `layout` (`app`/`faces`), `headline`, `subline`, `screen` (app layout) or `faces` (`circular`, `rectangular`, `corner`), `theme` |
| `header.html` | `name`, `mark` (1–2 letters) or `markImage`, `tagline` (optional), `theme` |
| `search.html` | `kicker`, `hook` (2–4 words), `subhook`, `shot`, `theme` |
| `event-card.html` | `kicker`, `title`, `sub` (optional), `shot` (optional), `theme` |
| `event-detail.html` | `kicker`, `title`, `sub` (optional), `shot` (optional), `theme` |

Canvas rules:

- Screenshot: 2–6 word headline, max 3 lines, auto-fitted; the device frame is
  drawn in CSS and the capture is placed inside. Use `layout: "bottom"` for
  variety, `"quiet"` for a text-free hero shot.
- Widgets: a light panel on a dark backdrop; pass the real widget renders in
  `widgets`. The panel background must match the widget render background
  (#f8f7f3 by default) so the cards blend.
- Watch: a CSS watch case around a real Watch frame; `layout: "faces"` swaps to
  the complication crops. Use frames extracted from a Watch screen recording.
- Header: text-free by default. One clear idea, no phone repeating the
  screenshots below. Keep the mark + name inside the safe box.
- Search: one big tilted phone + a huge hook. The hook must still read when the
  asset is 10% wide; test with `sips -Z 384`.
- Event: card 16:9, detail 9:16; keep the badge's top-left zone clear; do not
  draw a badge.

## Step 4 — Render at exact size

```bash
node .app-store-assets/scripts/render.mjs \
  --html store/en-US/iphone-1320x2868/01.html \
  --out store/en-US/iphone-1320x2868/01.png \
  --spec iphone-1320x2868
```

- The desktop renderer takes CSS points and exports at 2×, so 660×1434 becomes
  1320×2868. `render.mjs` reads the CSS size from the spec.
- The script fails if the output pixel size differs from the spec or if the PNG
  has an alpha channel.
- A `501` means a headless daemon; start the OpenDesign desktop app.
- Keep the HTML next to the PNG: it is the editable source for the next
  iteration and for localization.

## Step 5 — Validate

```bash
node .app-store-assets/scripts/validate.mjs --plan asset-plan.json
```

Outputs `validation-report.md`. Exit code 1 means at least one P0 blocker.

Checks: exact pixels, format, alpha, size, count limits, screenshot ordering,
kind/spec/placement agreement, and copy lint (prices, URLs, ©/®/™, Apple
recognitions, other platforms, unverifiable claims).

The validator cannot judge 4+ suitability, inclusivity, "one clear idea", or
whether a number is true. Run a critique pass on the visual set before upload;
the pipeline's `critique-theater` stage is for that.

Checkpoint: PASS, then show the user the report and the rendered set.

## Step 6 — Upload (only on explicit confirmation)

Upload credentials come from the daemon environment or a local config file —
never from the chat and never from the plan:

- `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_PRIVATE_KEY_PATH` (or `ASC_PRIVATE_KEY`)
- or `~/.config/app-store-assets/config.json`

Required role: App Manager, Admin, or Account Holder.

```bash
# 1. Refresh the live catalog (needed for medium iPhone / iPad / events).
node .app-store-assets/scripts/refdata.mjs

# 2. Resolve the version + localization ids.
node .app-store-assets/scripts/asc-upload.mjs localizations --app "$ASC_APP_ID" --version 1.4

# 3. Dry-run: prints every reserve/upload/placement action, mutates nothing.
node .app-store-assets/scripts/asc-upload.mjs upload \
  --plan asset-plan.json --app "$ASC_APP_ID" --version 1.4

# 4. After the user confirms in the UI (genui surface confirm-upload):
node .app-store-assets/scripts/asc-upload.mjs upload \
  --plan asset-plan.json --app "$ASC_APP_ID" --version 1.4 --execute
```

What `--execute` does:

- Finds the app's asset library.
- Reserves each file, uploads the parts, commits with `uploaded: true`, polls
  until `PREPARE_FOR_SUBMISSION`.
- Verifies the returned `specId` is valid for the placement type + group.
- **Revisions are tracked by content**: the reference name carries a short
  digest of the file. Unchanged files are adopted; a re-rendered file becomes a
  new image, its old placement is replaced and the superseded image is retired.
  Re-running is safe and idempotent.
- Orders screenshots per group, then writes `upload-report.json`.
- `--prune` additionally removes placements and unused images whose asset id is
  no longer in the plan (renamed or deleted assets). It refuses to run together
  with `--only`, since a partial plan would prune everything else.

It does **not** submit the version, the event, or the assets for review, and it
does not create In-App Event records. Those stay manual (see `ROADMAP.md`).

If credentials are missing, the dry-run still works and says so; `--execute`
fails with the exact env/config names.

## Step 7 — Output contract

```
store/<locale>/<spec-key>/
  01.html    editable canvas source
  01.png     the App Store asset (exact pixels)
asset-plan.json
validation-report.md
upload-report.json   (after an upload)
```

Name files `NN` matching the screenshot order. Keep `store/` in the project so
the set can be re-opened, re-rendered, and localized.

## Guardrails

- Never invent screenshots, reviews, awards, user counts, or Apple
  recognitions. If a claim cannot be verified, remove it.
- Never include prices, discounts, URLs, ©/®/™, or other platforms in artwork.
- Use the real app icon if one appears; do not redraw a fake one.
- No alpha, no transparency, no upscaling: render at Apple's exact pixels.
- Do not paste credentials into the chat. The scripts read env/config only.
- Do not upload without the confirmation surface. Do not submit for review from
  this plugin.
- The art is for a global 4+ audience: inclusive imagery, no gore, no weapons
  pointed at the viewer.

## Localization follow-up

v1 ships `en-US`. To add a locale, reuse the same plan and canvases with a new
`locale` and translated copy; keep the header text-free so one file serves all
locales. The search asset can be per-locale. Apple scales screenshots down from
the highest resolution when the UI is consistent across sizes.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `export/image returned 501` | Use the OpenDesign desktop app, not a headless daemon. |
| `project id required` | Run inside a project or pass `--project <id>`. |
| `no refdata snapshot found` | Bootstrap first, or pass `--refdata`. |
| `rendered PNG has an alpha channel` | Make the canvas background opaque; check the shot's PNG. |
| Output is 2× the requested `--width` | That is correct: width/height are CSS points. Use `--spec`. |
| `no editable version` | The version is already approved; create a new version or use a draft. |
| `placementGroup` missing | Run `scripts/refdata.mjs --placement <TYPE>` and pass `--group`. |
| `429` from ASC | Rate limit; wait and retry, honor `X-Rate-Limit`. |
| `specId` mismatch | Re-render at the exact dimensions in the live catalog. |
