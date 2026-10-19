# App Store Assets — OpenDesign plugin

Generate, validate and upload App Store artwork from inside OpenDesign:
screenshots, product-page header, search-results creative, and In-App Event
media — at Apple's exact specifications, with the content rules from
[Apple's asset best practices](https://developer.apple.com/app-store/asset-best-practices/)
applied as a pre-flight check.

[![skills.sh](https://skills.sh/b/marianif/od-plugin-app-store-assets)](https://skills.sh/marianif/od-plugin-app-store-assets)

- **Standalone plugin** — portable `SKILL.md` + `open-design.json`, zero npm deps
- **Exact-size rendering** through OpenDesign's native artifact export
- **Runtime spec resolution** from the App Store Connect App Asset Library
  reference data — no hardcoded device list
- **Upload** to the App Asset Library (`appAssetLibraryImages`,
  `appAssetLibraryPlacements`) with a dry-run and explicit confirmation
- **Idempotent** — re-runs adopt images and placements already in the library
- **No credentials in prompts**: the upload script reads them from a local
  config file or environment variables

## Install

### OpenDesign

```bash
git clone https://github.com/marianif/od-plugin-app-store-assets.git
od plugin install --source ./od-plugin-app-store-assets          # validate first: od plugin validate ./od-plugin-app-store-assets
od plugin trust app-store-assets --capabilities fs:read,fs:write,bash,network
```

`bash` and `network` are elevated capabilities: the workflow runs local Node
scripts and talks to App Store Connect. The plugin is a `restricted` install
until you grant them.

Then open a project in OpenDesign and pick **App Store Assets** from the plugin
picker, or mention it with `@app-store-assets` in the composer.

### Generic Agent Skills clients

The folder is a valid Agent Skill on its own — `open-design.json` is additive
and safe to ignore outside OpenDesign:

```bash
npx skills add marianif/od-plugin-app-store-assets --skill app-store-assets
```

## Use

The agent will:

1. Bootstrap `.app-store-assets/` into the project (canvases, scripts,
   references) from the installed plugin.
2. Ask for the app, App Store Connect app id, version, platform and locale
   (default `en-US`).
3. Write `asset-plan.json` — one row per asset with the exact spec it must match.
4. Compose HTML canvases, render PNG at Apple's pixel size, run the validator.
5. Show the validation report. Only after an explicit confirmation, upload the
   files and create placements.

Generated files:

```
store/<locale>/<spec-key>/
  01.html          # the canvas source — editable
  01.png           # the exported asset
asset-plan.json
validation-report.md
upload-report.json # after an upload
```

## Requirements

- OpenDesign desktop runtime (the exact-size PNG export uses the desktop
  renderer; a headless daemon answers `501`).
- Node 20+ for the scripts (zero npm dependencies).
- For upload only: an App Store Connect API key (team key) with the App Manager,
  Admin or Account Holder role.

## App Store Connect credentials

The scripts resolve credentials from, in order:

1. `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_PRIVATE_KEY_PATH` (or `ASC_PRIVATE_KEY`)
2. `~/.config/app-store-assets/config.json`

```json
{
  "issuerId": "00000000-0000-0000-0000-000000000000",
  "keyId": "ABCDE12345",
  "privateKeyPath": "/Users/you/.config/app-store-assets/AuthKey_ABCDE12345.p8",
  "appId": "1234567890"
}
```

Create the key in App Store Connect → **Users and Access** → **Integrations** →
**App Store Connect API** → **Team Keys**. The `.p8` downloads once; it is a
PKCS#8 EC (ES256) key starting with `-----BEGIN PRIVATE KEY-----`. Keep it out
of the repo.

Typical run:

```bash
node .app-store-assets/scripts/asc-upload.mjs apps --bundle com.example.app
node .app-store-assets/scripts/asc-upload.mjs library --app 1234567890
node .app-store-assets/scripts/refdata.mjs                     # freeze the live catalog
node .app-store-assets/scripts/asc-upload.mjs upload --plan asset-plan.json --app 1234567890 --version 1.0
node .app-store-assets/scripts/asc-upload.mjs upload --plan asset-plan.json --app 1234567890 --version 1.0 --execute
```

`upload` is a dry-run by default; it resolves the version, localization, matches
each file against a live spec for its placement type and group, and reports what
it would change. `--execute` performs it. The script never submits for review.

## Validation

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
├── evals/                    regression prompts + trigger queries
├── examples/trackly/         a real generated set (iOS + watchOS + creative)
├── ROADMAP.md                deferred work
└── CHANGELOG.md
```

## Limitations

- `en-US` by default; additional locales reuse the same canvases with translated
  copy (a follow-up run, not a code change).
- App preview videos, in-app event record creation, and automated review
  submission are deferred — see `ROADMAP.md`.
- The validator catches mechanical failures. Apple's 4+ content judgment, "one
  clear idea", and claim verification still need human review.

## License

MIT — see `LICENSE`.
