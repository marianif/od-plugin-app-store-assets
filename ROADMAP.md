# ROADMAP — internal only

This file is for the people maintaining this plugin. It is intentionally **not**
referenced by `SKILL.md` or `open-design.json`, so it never becomes part of the
marketplace surface, the agent prompt, or the plugin preview.

## Deferred to a later iteration

1. **In-App Event record creation via the `appEvents` API.**
   v1 generates and validates event card/detail *media*, and can attach that
   media to an existing event localization. Creating the event record itself —
   badge, deep link, schedule, territories, priority, localized name/short/long
   description — is deliberately deferred. When this lands, it belongs in
   `scripts/asc-upload.mjs` as a separate `event create` subcommand, with its
   own confirmation gate.

2. **Live ASC upload acceptance.**
   The upload path is built against the App Asset Library API (ASC 4.5.1+), but
   cannot be acceptance-tested until an App Store Connect API key is added.
   Required: `.p8` key path, key id, issuer id, app id, and an App Manager (or
   Admin/Account Holder) role. Until then, `asc-upload` is dry-run only.

3. **Locale expansion.**
   v1 defaults to `en-US`. The plan format, canvases, and validator are already
   locale-keyed, so adding `it-IT`, `de-DE`, etc. is a follow-up run, not a code
   change. Add per-locale screenshot copy and (optionally) per-locale search
   creative.

4. **App preview videos.**
   The 15–30 s H.264/ProRes preview pipeline is out of v1. It needs a
   storyboard canvas, a video renderer (ffmpeg), poster-frame selection, and a
   separate validator for duration/fps/audio.

5. **iPad and Apple Watch placement groups.**
   The canvas system scales, but the placement-group ids and per-group limits
   must come from `GET /v1/appAssetLibraryRefData` at runtime. Enable after
   dogfooding the iPhone path.

6. **Submit-for-review automation.**
   v1 uploads assets and creates placements, then stops. Submitting the parent
   surface (app version, custom product page, in-app event) stays a manual step
   in App Store Connect. A future `--submit` flag would need review-submission
   API coverage and a stronger confirmation gate.

7. **OCR-based policy checks.**
   Caption lint currently inspects the plan's copy strings. A future version can
   OCR the rendered PNG to catch text baked into supplied imagery.

## Deliberate non-goals

- Redistributing Apple's Figma/Photoshop/Pixelmator/Sketch templates. We encode
  our own safe-area layouts instead.
- Generating fake app UI. Screenshots must show the real app; the plugin
  composes supplied captures, it does not invent screens.
- Bypassing App Review. The validator catches mechanical rejections; a human
  still owns policy judgment and submission.
