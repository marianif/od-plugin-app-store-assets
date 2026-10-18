# Apple App Store asset rules — working rubric

Source of truth:
[App Store asset best practices](https://developer.apple.com/app-store/asset-best-practices/)
plus the App Store Connect reference pages for screenshots, app previews and
creative assets. Snapshot date: **2026-10-18**. Specs move (iPhone Duo is
already on the page); resolve the live catalog before every upload with
`GET /v1/appAssetLibraryRefData`.

## 1. What we produce in v1

| Asset | Placement type | Category | Exact pixels (2026-10-18) |
| --- | --- | --- | --- |
| Screenshot — iPhone large | `APP_SCREENSHOT` | `APP_SCREENSHOTS_AND_PREVIEWS` | 1320×2868, 1290×2796 or 1260×2736 |
| Screenshot — iPhone medium (required minimum) | `APP_SCREENSHOT` | `APP_SCREENSHOTS_AND_PREVIEWS` | 1206×2622 or 1179×2556 |
| Screenshot — iPad 13" | `APP_SCREENSHOT` | `APP_SCREENSHOTS_AND_PREVIEWS` | 2064×2752 or 2048×2732 |
| Product page header | `PRODUCT_PAGE_HEADER_ASSET` | `CREATIVE_ASSETS` | 3840×1646 (21:9) or 5244×2950 (16:9 PNG) |
| Search results creative | `APP_STORE_SEARCH_RESULTS_ASSET` | `CREATIVE_ASSETS` | 1920×1280 → 3840×2560 (3:2) or 5244×2950 (16:9 PNG) |
| In-App Event card | `EVENT_CARD_ASSET` | `CREATIVE_ASSETS` | 1920×1080 → 3840×2160 (16:9) |
| In-App Event detail | resolve live (not documented as a fixed id) | `CREATIVE_ASSETS` | 1080×1920 → 2160×3840 (9:16) |

Rules that are mechanical:

- Screenshots: at least 1, at most **10 per device size and localization**.
  `.jpeg`, `.jpg`, `.png`. **No alpha channel, no transparency.**
- At least one screenshot is required for **iPhone with Dynamic Island
  (medium display)**; iPad 13" is required if the app runs on iPad.
- App previews (deferred to a later iteration): up to 3 per device size and
  language, 15–30 s, ≤500 MB, 30 fps, H.264 10–12 Mbps or ProRes 422 HQ,
  AAC 256 kbps stereo 44.1/48 kHz. Accepted resolutions are render sizes
  (e.g. iPhone 886×1920 portrait), not device pixels.
- Creative assets: 1 header per group, 1 search asset per localization; video
  5–30 s, 30/60 fps. Event media: 1 asset per placement type per group, video
  15–30 s.
- iPhone Duo screenshots become required in **April 2027** for apps built with
  iOS 27.1 SDK or later (1398×2034 outer, 2007×2853 inner). Not part of v1, but
  do not design layouts that only tolerate 19.5:9 forever.

## 2. Content policy — what gets an asset rejected

Hard failures (the validator treats these as P0 when they appear in our copy):

- Specific pricing or discounts, currency amounts, "% off", "sale", "free" as a
  price claim
- Website URLs
- Copyright symbols, `©`, `®`, `™`
- Apple recognitions: Editor's Choice, App of the Day, Game of the Day, Apple
  Design Award, "Featured by Apple"
- Logos or references to other platforms/marketplaces (Android, Google Play,
  Samsung, Windows, Meta Quest, …)
- Unverifiable claims: "#1", awards, "best app", review counts that cannot be
  substantiated
- Objectionable content: explicit imagery, profanity, illegal drugs,
  self-harm, hate speech, stereotypes, sexually suggestive content, inflammatory
  religious commentary, gore, weapons pointed at a person or the viewer

Judgment calls (human/AI critique, not a regex):

- Assets must be suitable for a **4+** audience even when the app is rated
  higher.
- Imagery should be inclusive and work for a **global** audience.
- One single, clear idea per asset; visually dense compositions dilute impact.
- Screenshots must show the **real app in use**, not invented UI.
- The whole set should read as one story: similar palette, typography,
  iconography, tone.

## 3. Craft rules by format

### Screenshots
- Lead with the strongest feature; sequence the set so it tells a story.
- Use text as a short phrase that enhances the visual, not a description.
  Localize for every language the app supports.
- Keep key elements inside a safe area; keep the focal point centered so
  cropping never removes it.
- Stay focused on the core experience; do not turn the asset into an accolade
  or a call-to-action billboard.
- Up to three screenshots can appear in search results depending on
  orientation — the first one must work small.

### Product page header
- Single clear idea, designed for a first-time visitor.
- The screenshots sit right below the header; repeating a phone screen in the
  header is usually redundant.
- A **universal creative asset** can serve both header and search results.
- Apple's template safe area for the 3840×1646 header: x 1097–2743,
  y 493–1154 (in image pixels).

### Search results
- Purpose must be obvious at a glance; show the firsthand experience.
- Search shows the asset at roughly 365 pt wide. At that size only a very large
  subject and a 2–4 word hook survive. Test a 384 px-wide copy: the app screen's
  title and the hook must both still read.
- Apple's template safe area for the 3840×2560 (3:2) search asset:
  x 836–3004, y 765–1795.

### In-App Events
- Card media is landscape 16:9; detail media is portrait 9:16.
- The event badge (Challenge, Competition, Live Event, Major Update, New Season,
  Premiere, Special Event) is applied by App Store Connect. Complement it; do
  not draw or duplicate it, and keep the top-left of the art clear.
- Event localizations are not orderable; each placement type allows one asset
  per group.

### App icon
- Outside v1 image generation, but screenshots should not fake the icon. If the
  icon appears, use the real current icon.
- Apple recommends Icon Composer for layered Liquid Glass icons; ensure
  legibility at every size.

## 4. Submission paths

- Alongside a new app version, or standalone via **Asset Library**.
- The Asset Library submission can be approved before a version is ready; the
  asset then waits in the library.
- Placements follow the review state of their parent surface. The plugin
  deliberately stops after creating placements — submitting the parent stays
  manual.

## 5. What this plugin does not do

- It does not redistribute Apple's design templates.
- It does not invent screenshots; it composes supplied captures.
- It does not guarantee App Review approval. It removes the mechanical
  rejections and gives a human a precise checklist for the rest.
