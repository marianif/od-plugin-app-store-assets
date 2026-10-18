# App Store Assets — OpenDesign plugin

Generate, validate and upload App Store artwork from inside OpenDesign:
screenshots, product-page header, search-results creative, and In-App Event
media — at Apple's exact specifications and with the content rules from
[Apple's asset best practices](https://developer.apple.com/app-store/asset-best-practices/)
applied as a pre-flight check.

- **Standalone plugin** (portable `SKILL.md` + `open-design.json`)
- **Exact-size rendering** through OpenDesign's native artifact export
- **Runtime spec resolution** from the App Store Connect App Asset Library
  reference data — no hardcoded device list
- **Upload** to the App Asset Library (`appAssetLibraryImages`,
  `appAssetLibraryPlacements`) with a dry-run and explicit confirmation
- **No credentials in prompts**: the upload script reads them from a local
  config file or environment variables

## Why the Asset Library API

Apple deprecated the old `appScreenshotSets` / `appPreviews` /
`appEventScreenshots` resources in App Store Connect API 4.5.1. The current
model uploads each file once to the app's Asset Library and then creates
*placements* on a version localization, custom product page, or event. This
plugin is built on that model.

## Install

From a local checkout:

```bash
od plugin validate ./od-plugin-app-store-assets
od plugin install ./od-plugin-app-store-assets
```

Grant the elevated capabilities the workflow needs (bash for the render/upload
scripts and network for App Store Connect):

```bash
od plugin trust app-store-assets --capabilities fs:read,fs:write,bash,network
```

Then open a project in OpenDesign and either:

- pick **App Store Assets** from the plugin picker, or
- mention it with `@app-store-assets` in the composer.

## Use

The agent will:

1. Bootstrap `.app-store-assets/` into the project (canvases, scripts,
   references) from the installed plugin.
2. Ask for the app, App Store Connect app id, version, platform and locale
   (default `en-US`).
3. Write `asset-plan.json` with one row per asset and the exact spec each file
   must match.
4. Compose HTML canvases, render them to PNG at Apple's pixel size, and run the
   validator.
5. Show the validation report. Only after an explicit confirmation, upload the
   files and create placements.

Generated files:

```
store/
  <locale>/
    <spec-key>/
      01.html          # the canvas source, editable
      01.png           # the exported asset
asset-plan.json
validation-report.md
upload-report.json     # after an upload
```

## Requirements

- OpenDesign desktop runtime (the exact-size PNG export uses the desktop
  renderer; a headless daemon answers `501`).
- Node 20+ for the scripts (zero npm dependencies).
- For upload only: an App Store Connect API key with the App Manager, Admin or
  Account Holder role.

## ASC credentials

The scripts resolve credentials from, in order:

1. `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_PRIVATE_KEY_PATH` (or `ASC_PRIVATE_KEY`)
2. `~/.config/app-store-assets/config.json`

Example config (keep it out of git):

```json
{
  "issuerId": "00000000-0000-0000-0000-000000000000",
  "keyId": "ABCDE12345",
  "privateKeyPath": "/Users/you/private_keys/AuthKey_ABCDE12345.p8",
  "appId": "1234567890"
}
```

`appId` is optional and can be passed per run.

## Validate the plugin

```bash
od plugin validate ./od-plugin-app-store-assets
pnpm --filter @open-design/plugin-runtime typecheck   # only inside the OD repo
```

The HTML preview is served from `preview/index.html` and must return
`200 text/html` through `/api/plugins/app-store-assets/preview`.

## Layout

```
.
├── SKILL.md                  portable agent workflow
├── open-design.json          OD manifest (inputs, pipeline, capabilities)
├── references/               Apple rules, API playbook, copy guidance, spec snapshot
├── assets/canvases/          exact-size HTML canvases
├── scripts/                  bootstrap, compose, render, validate, refdata, upload
├── preview/                  marketplace preview (HTML)
├── evals/                    regression prompts
└── ROADMAP.md                internal deferred items (not part of the plugin surface)
```

## Limitations

- v1 is `en-US` by default; additional locales are a follow-up run.
- App preview videos, event-record creation, iPad/Watch groups and automatic
  review submission are deferred — see `ROADMAP.md`.
- The validator catches mechanical failures (dimensions, alpha, format, counts,
  pricing/URL/recognition claims). Apple's 4+ content and "single clear idea"
  judgments still need human review.
