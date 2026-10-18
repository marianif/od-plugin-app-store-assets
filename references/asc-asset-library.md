# App Store Connect — App Asset Library playbook

Snapshot date: **2026-10-18**. Apple deprecated the set-based media resources
(`appScreenshotSets`, `appScreenshots`, `appPreviewSets`, `appPreviews`,
`appEventScreenshots`) in App Store Connect API **4.5.1**. Use the Asset Library
and placements instead.

Base URL: `https://api.appstoreconnect.apple.com`

## 1. Authentication

- JWT signed with **ES256**, header `{ alg, kid, typ: "JWT" }`, payload
  `{ iss: <issuer id>, iat, exp, aud: "appstoreconnect-v1" }`.
- `exp - iat` must be **≤ 20 minutes**.
- Send `Authorization: Bearer <jwt>`.
- Roles that can manage assets: **Account Holder, Admin, App Manager**
  (Marketing can do some review submissions but not this whole surface).
- Rate limit is per key per rolling hour; every response carries
  `X-Rate-Limit: user-hour-lim:…;user-hour-rem:…`. A `429` means back off.

## 2. The model

- One **asset library per app**, found via `GET /v1/apps/{id}/assetLibrary`.
  Cache the library id; it is stable.
- An **asset** is uploaded once (`appAssetLibraryImages` or
  `appAssetLibraryVideos`). The asset is independent of where it appears.
- A **placement** links one asset to one surface: an App Store version
  localization, a custom product page localization, an in-app event
  localization, or a product-page-experiment treatment localization.
- **Placement type** names the slot (`APP_SCREENSHOT`, `APP_PREVIEW`,
  `PRODUCT_PAGE_HEADER_ASSET`, `APP_STORE_SEARCH_RESULTS_ASSET`,
  `EVENT_CARD_ASSET`, …).
- **Placement group** narrows the slot to a device family
  (`IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE`, `MAC_PROFILE`, …).
- **Specification** is the file requirement (exact pixels, aspect ratio,
  formats, max size, alpha allowed). App Store Connect matches an uploaded file
  to a spec during processing and returns its `specId`. You never send `specId`.

## 3. Reference data is the source of truth

`GET /v1/appAssetLibraryRefData` returns six parallel arrays:

- `features` — supported placement types and `groupLimits[].maxCount`
- `placementProfileGroups` — valid group ids + platform + display class
- `imageSpecs` — exact dimensions, extensions, MIME types, max size, alpha flag
- `videoSpecs` — same plus frame rate / duration / audio rules
- `placementTypes` — accepted asset categories + spec mappings per group
- `displayClasses` — device family and screen dimensions

Lookup chain for a target:

1. Find the feature (`APP_STORE_VERSIONS`, `IN_APP_EVENTS`, …).
2. Pick a `placementGroup` from `placementProfileGroups`.
3. Map group → specs in `placementTypes[].specMappings`.
4. Read the spec in `imageSpecs` / `videoSpecs`.

Never hardcode group ids or specs in the upload path. `scripts/refdata.mjs`
caches the catalog for the validator, but the uploader always refreshes it.

Useful shape of an image spec:

```json
{
  "specId": "f56c777c-99ea-5760-97ae-27c5f8cbb884",
  "shortName": "i1290x2796a0",
  "dimensions": { "minWidth": 1290, "maxWidth": 1290,
                   "minHeight": 2796, "maxHeight": 2796 },
  "aspectRatio": "6:13",
  "compatiblePlacementTypes": ["APP_SCREENSHOT"],
  "alphaAllowed": false,
  "fileExtensions": [".jpg", ".jpeg", ".png"],
  "mimeTypes": ["image/jpeg", "image/png"],
  "maxFileSize": 524288000,
  "universalAsset": false
}
```

Screenshot specs are exact (`minWidth === maxWidth`). Resize before reserving.

## 4. Upload sequence (images)

1. `GET /v1/apps/{appId}/assetLibrary` → `appAssetLibraries.id`.
2. `GET /v1/appAssetLibraryRefData` → confirm spec + group.
3. `POST /v1/appAssetLibraryImages`

   ```json
   {
     "data": {
       "type": "appAssetLibraryImages",
       "attributes": {
         "fileName": "01.png",
         "fileSize": 123456,
         "category": "APP_SCREENSHOTS_AND_PREVIEWS",
         "referenceName": "Trackly — 01 — iPhone 6.9"
       },
       "relationships": {
         "assetLibrary": { "data": { "type": "appAssetLibraries", "id": "…" } }
       }
     }
   }
   ```

4. Upload the bytes to every `uploadOperations[]` entry: use its `method`, `url`,
   `offset`, `length` and `requestHeaders`. **No JWT on these URLs.**
5. `PATCH /v1/appAssetLibraryImages/{id}` with `{ "uploaded": true }`. There is
   **no checksum** in the Asset Library flow.
6. Poll `GET /v1/appAssetLibraryImages/{id}` until `state` is
   `PREPARE_FOR_SUBMISSION` (or `FAILED`; read `stateDetails`). States:
   `AWAITING_UPLOAD → UPLOAD_COMPLETE → PREPARE_FOR_SUBMISSION`; then review
   states `READY_FOR_REVIEW / WAITING_FOR_REVIEW / IN_REVIEW / ACCEPTED /
   APPROVED`; terminal `FAILED`, `REJECTED`, `ARCHIVED`.
7. Compare the returned `specId` with the intended spec. If it matched a
   different spec, the file was resized/encoded wrong — abort.
8. Create placements, then order them.

## 5. Placements

`POST /v1/appAssetLibraryPlacements`

```json
{
  "data": {
    "type": "appAssetLibraryPlacements",
    "attributes": {
      "placementType": "APP_SCREENSHOT",
      "placementGroup": "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE"
    },
    "relationships": {
      "image": { "data": { "type": "appAssetLibraryImages", "id": "…" } },
      "appStoreVersionLocalization": {
        "data": { "type": "appStoreVersionLocalizations", "id": "…" }
      }
    }
  }
}
```

- Exactly one asset relationship (`image` or `video`) and exactly one target
  surface relationship.
- Type + group + asset category must agree (`placementTypes[].acceptsAssetCategories`).
- The parent surface must be editable; approved versions/PCP versions reject
  new placements.
- **Placements are immutable.** To replace artwork, delete the placement,
  create a new one, then re-order the group.
- Delete an asset only after deleting its placements (`ASSET_HAS_PLACEMENTS`).
- `GET …/placements?filter[placementType]=…&filter[placementGroup]=…&sort=placementGroupPosition`
  returns them in display order.

## 6. Ordering

`POST /v1/appAssetLibraryPlacementOrderingRequests`

```json
{
  "data": {
    "type": "appAssetLibraryPlacementOrderingRequests",
    "attributes": { "placementGroup": "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE" },
    "relationships": {
      "orderedPlacements": { "data": [
        { "type": "appAssetLibraryPlacements", "id": "…" },
        { "type": "appAssetLibraryPlacements", "id": "…" }
      ]},
      "appStoreVersionLocalization": {
        "data": { "type": "appStoreVersionLocalizations", "id": "…" }
      }
    }
  }
}
```

Ordering is scoped to one group within one localization. In-app event
localizations are not orderable.

## 7. Localizations and versions

- `GET /v1/apps/{id}/appStoreVersions?filter[platform]=IOS` → versions.
- `GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations` → locale map.
- Custom product pages use `appCustomProductPageLocalizations`; events use
  `appEventLocalizations`. The placement payload is the same, only the target
  relationship changes.
- For events, `GET /v1/apps/{id}/appEvents` and the event's `localizations`
  relationship give the event localization id.

## 8. Failure playbook

| Symptom | Cause | Fix |
| --- | --- | --- |
| `409 ENTITY_ERROR.ATTRIBUTE.INVALID` on placement | type/group/category disagree | re-read `placementTypes` + `acceptsAssetCategories` |
| `409 STATE_ERROR.INVALID_STATE` | parent surface approved | use an editable version or a draft event |
| `409 STATE_ERROR.ASSET_HAS_PLACEMENTS` | deleting a used asset | delete placements first |
| `409 STATE_ERROR.INVALID_ASSET_STATE` on archive | asset not approved | archive only approved assets |
| Asset state `FAILED` | dimensions/format/alpha mismatch | read `stateDetails`, re-render, new reservation |
| `429` | rate limit | honor `X-Rate-Limit`, back off, retry later |
| `401` | JWT expired / bad key | re-sign (≤20 min), check key id + issuer |

## 9. What v1 deliberately leaves out

- Creating in-app event records (`appEvents` + `appEventLocalizations`).
- Submitting the parent surface for review.
- App preview video uploads (`appAssetLibraryVideos` + preview frame).
- Custom product pages and product page optimization.
