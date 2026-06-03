# Multimedia Foundation

Planned 2026-05-27 · Shipped 2026-05-29 (PR #45). This document records what landed, not the original proposal.

## What shipped

Native display multimedia on the CommCare web apps Nova generates: image / audio / video attached to a question's message slots and to select options; menu-tile image + audio on modules and forms; an image-per-case-property-value column kind in case lists; and an app logo. Assets are owned by the user (one stored blob per `(owner, contentHash)`), uploaded to GCS, referenced from the blueprint by opaque id, and translated to CommCare's wire vocabulary only at the `lib/commcare/` emit boundary — through authoring UI, the MCP/SA tool surface, `.ccz` compile, and HQ upload.

### Coverage

| Carrier | Schema | Builder UI | SA/MCP tool | Wire emit |
|---|---|---|---|---|
| Question label / hint / help / validation media | ✅ `label_media` / `hint_media` / `help_media` / `validate_msg_media` | ✅ inline field editor | ✅ `attach_field_media` | ✅ itext `<value form>` |
| Select-option media | ✅ `option.media` | ✅ inline in OptionsEditor | ✅ `attach_option_media` | ✅ per-option itext |
| Form menu tile | ✅ `form.icon` / `form.audioLabel` | ✅ form settings | ✅ `set_form_media` | ✅ nav-menu `media_image` / `media_audio` |
| Module menu tile | ✅ `module.icon` / `module.audioLabel` | ✅ module settings | ✅ `set_module_media` | ✅ nav-menu media |
| App logo | ✅ `blueprint.logo` | ✅ app settings | ✅ `set_app_logo` | ✅ `hq_logo_web_apps` profile property |

In-builder DISPLAY (rendering the attached media, not just attaching it) shipped as a follow-up — see "Display surface" below. The attach column above is unchanged; what was missing was the read side.
| Image-map case-list column | ✅ `kind: "image-map"` | ✅ column card | ✅ `add/updateCaseListColumn` | ✅ `enum-image` column |
| Help text (paired with `help_media`) | ✅ `field.help` | ✅ field editor | ✅ `edit_field` (`help` slot) | ✅ `<help ref="jr:itext(...)">` |

**Deliberately not built** (each a verified-against-source decision, not an oversight):

- **`required_msg` / `required_msg_media`** — `jr:requiredMsg` has no parse target in commcare-core (`XFormParser::parseBindAttributes` enumerates no `requiredMsg`). A required-message slot would be a dead authoring affordance, so it was dropped entirely. (`lib/domain/mediaRefs.ts` documents the omission.)
- **Case-list-link media (`caseListConfig.icon` / `audioLabel`)** — the slots are reserved in the schema but NOT walked, NOT given builder UI, and NOT emitted: Nova's compiler emits no standalone case-list-link command, so there is no wire path to anchor the bytes to. Stamping them would orphan assets in the `.ccz`.
- **`.m4a` / `.ogg` audio** — HQ's deployed image (`python3.13-bookworm-slim`, no `/etc/mime.types`) has no mime entry for `audio/mp4` or `audio/ogg`, so `validate_file` 400s them on upload. Accepting them would be a dead affordance. Audio is `.mp3` / `.wav` only.
- **Case-list-link media inline builder chrome** — reserved-but-not-walked (no wire path; see above), so no chrome. Module + app-logo settings chrome HAS since been built (`moduleSettings` / `appSettings` appearance panels), so the original "tool-only" scoping no longer holds for those — see the updated Coverage table.

## Naming — Nova-native everywhere except wire emit

CCHQ vocabulary leaks ONLY at `lib/commcare/`. Authoring layer, tools, UI, and validator speak Nova names; translation happens at the emit boundary.

| Carrier | Nova authoring name | CCHQ wire (emit-only) |
|---|---|---|
| Question label / hint / help / validation media | `field.label_media` / `hint_media` / `help_media` / `validate_msg_media`: `Media` | `<value form="image\|audio\|video">jr://…` inside the slot's itext `<text>` |
| Select-option media | `option.media` | per-option itext entry, same shape |
| Module / form menu tile | `module.icon` / `audioLabel`, `form.icon` / `audioLabel` | `media_image` / `media_audio` on `NavMenuItemMediaMixin` shell + suite nav node |
| Per-case-row icon by property value | `caseListConfig.columns[i] = { kind: "image-map", … }` | `format="enum-image"` column with inlined `jr://` literals |
| App logo (web-apps slot) | `blueprint.logo` | `hq_logo_web_apps` in `logo_refs` + profile property |

`icon` (not CCHQ's `media_image`) and `audioLabel` are honest authoring vocabulary; `image-map` mirrors the existing `id-mapping` column shape; `Media` is the slot bundle (the slot key — `image`/`audio`/`video` — already encodes the kind); `MediaAsset` is the storable record. Field-property slots carry the parent-slot prefix (`label_media`) so the prefix encodes which message they decorate. Convention split follows existing Nova precedent: field-property snake_case, module/form/column camelCase, discriminator literals kebab-case, types PascalCase.

## Data model

**`lib/domain/multimedia.ts`** — `Media` is a `{ image?, audio?, video? }` bundle of optional `AssetId`s (each carrier slot is independent). `AssetId` is a branded string. Accepted MIME types:

- `IMAGE_MIME_TYPES`: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
- `AUDIO_MIME_TYPES`: `audio/mpeg`, `audio/wav`
- `VIDEO_MIME_TYPES`: `video/mp4`

`EXTENSION_FOR_MIME_TYPE` maps each to its canonical extension; `MIME_ALIASES` folds `image/apng → image/png`. `MediaAsset` (stored at root `mediaAssets/{id}`, gated by an `owner` field) carries `contentHash` (sha256), `mimeType`, `extension`, `sizeBytes`, optional `dimensions` / `durationMs`, `gcsObjectKey`, `originalFilename`, `displayName`, and `status: "pending" | "ready"`.

**Field slots** (`lib/domain/fields/`): every visible field + containers gain `label_media`; input-capable kinds gain `hint_media`, `help` (text), `help_media`; kinds that support validation gain `validate_msg_media` (sibling of `validate_msg`). `selectOptionSchema` gains `media`. All optional — existing apps parse unchanged. The walk surface for all field/option refs lives in `lib/domain/mediaRefs.ts`.

**Module / form / blueprint**: `module` and `form` gain `icon` + `audioLabel` (`AssetId`); `blueprint` gains `logo`. `caseListConfig` gains `icon` + `audioLabel` (reserved, not walked — see Coverage). The `columnSchema` union gains an `image-map` arm: `{ kind, uuid, field, header, mapping: { value, assetId }[], … }` with a duplicate-`value` refinement (`imageMapValueUnique` validator backstops it).

## Storage + upload

GCS bucket `nova-multimedia-${env}`, uniform bucket-level access, public-access prevention; objects at `users/{owner}/{contentHash}.{ext}`. The service account is the only writer; bytes are never world-readable. `lib/storage/media.ts`: `createSignedUploadUrl`, `uploadAssetBytes`, `streamAsset`, `getStoredObjectSize`, `downloadAssetBytes`, `deleteAsset`. `lib/db/mediaAssets.ts` (Firestore `mediaAssets/`): `createPendingAsset`, `findReadyAssetByOwnerAndHash`, `confirmAssetReady`, `loadAssetForOwner`, `loadAssetsByIds`, `listReadyAssetsForOwner`, `deleteAsset`, `toWireMediaAsset`. Composite indexes: `(owner, contentHash)` for dedup, `(owner, createdAt DESC)` for the library list.

Browser-side flow (three routes under `app/api/media/`): the client computes SHA-256 and POSTs `/upload`; the server returns either a dedup hit (`{ assetId, deduplicated: true }`, no bytes pushed) or a signed PUT URL bound to hash + size + content-type; the client PUTs bytes straight to GCS, then POSTs `/upload/[assetId]/confirm`, where the server re-streams the object, re-validates, writes sniffed metadata, and flips `status` to `ready`. `/media/[assetId]` (GET) is the ownership-gated proxy; `/media/library` (GET) is the cursor-paginated picker list.

## Validation pipeline — `lib/media/validate.ts`

One module the HTTP confirm route and the MCP `upload_media_asset` tool both call. Five stages: (1) extension whitelist (`.png .jpg .jpeg .gif .webp .mp3 .mp4 .wav` — SVG and `.m4a`/`.ogg` rejected); (2) per-kind size cap (image 5 MB / audio 10 MB / video 50 MB); (3) magic-bytes sniff (`file-type`) matched against claim + extension; (4) container re-parse (`sharp` reads image dimensions; `music-metadata` parses audio/video containers in-process — no native binary, so it survives the Alpine + Next-standalone deploy and adds no native-demuxer CVE surface; duration is best-effort and informational); (5) SHA-256 from the validated bytes. Deps: `@google-cloud/storage`, `file-type`, `sharp`, `music-metadata`.

`lib/media/manifest.ts::resolveMediaManifest(doc, owner, { withBytes })` walks every reference, loads ready-status rows, optionally fetches bytes from GCS, and returns the `AssetManifest` the wire layer consumes. `lib/media/mediaValidation.ts::collectMediaValidationErrors(doc, owner)` runs the validator and filters to media-category errors — the actionable gate every media-ON entry point fires before expand.

## Authoring UI

`components/builder/media/`: `MediaSlot.tsx` (exports `MediaSlot`, the three-kind bundle, and `SingleAssetSlot`, the fixed-kind variant for menu/logo), `MediaPickerDialog.tsx` (Upload + Library tabs), `mediaClient.ts` (client hash + upload + library fetch), `useMedia.ts`, `assetKindMeta.ts`. The picker's Upload tab computes SHA-256 client-side and drives a real progress bar via `XMLHttpRequest.upload`; a dedup hit skips the PUT.

Mount sites: field message media via `components/builder/editor/fields/MediaSlotEditor.tsx` (driven by the declarative `fieldEditorSchemas` — no per-kind switching in the panel); option media inline in `OptionsEditor.tsx`; form menu tile in `formSettings/FormAppearanceSection.tsx`; image-map column rows in `case-list-config/cards/column/ImageMapColumnCard.tsx`. Module + app-logo media gained builder chrome since the original PR — `moduleSettings/ModuleAppearanceSection.tsx` and `appSettings/AppAppearanceSection.tsx` (a `…SettingsButton` → `…SettingsPanel` popover stack mirroring the form one). All Base UI primitives, `@iconify/react/offline` icons, semantic z-index tokens, `autoComplete="off"` + `data-1p-ignore` on inputs. The TipTap inline `![alt](url)` image button is untouched — structured media is additive.

## Display surface — `components/builder/media/MediaDisplay.tsx`

`MediaSlot` attaches media; `MediaDisplay` shows it — the read twin the builder renders so the form / menu / app actually look like the device will. It renders a `Media` bundle (image above the label, audio / video players) and takes `interactive`: preview mode plays the controls; edit mode is `pointer-events-none` (a live `<audio controls>` would swallow the field-select click) and renders the IDENTICAL elements, so a field's row is the same height in both modes and the edit↔preview flipbook never drifts.

Mount sites:
- **Field label media** — `MediaDisplay` above the prompt in BOTH form renderers: `FieldRow` (edit, `interactive={false}`) and `InteractiveFormRenderer` (live, `interactive`), at matching positions, plus the shared `LabelField` (label-only fields). The image lands at the identical top + size in both modes (verified live).
- **App logo** — a banner on the preview home screen (`HomeScreen`) and a thumbnail on each app-list card (`AppCard`). The list needed `logo` denormalized onto `AppSummary` (`lib/db/apps.ts::denormalize` + `SUMMARY_FIELDS`), since the list query never reads the blueprint; existing apps backfill on their next save the same way `module_count` does.
- **Module / form menu icons** — the tile glyph swaps to the carrier's `icon` image (glyph fallback when unset) on the preview home/module screens (`HomeScreen` / `ModuleScreen`) AND the app-tree rows (`ModuleCard` / `FormCard`).

Not yet displayed in-builder: select-option media, hint/help/validate message media, group/repeat label media. Wire emit + authoring for all of these already shipped; only the in-builder READ rendering is pending — a follow-up that mounts `MediaDisplay` at those sites.

**The web-apps logo has two CCHQ surfaces with different needs.** The web-apps RUNTIME banner resolves path-based — `cloudcare` reads `logo_refs['hq_logo_web_apps'].path` and the frontend looks that path up in the app's `multimedia_map` — so Nova's `{path}`-only `logo_refs` lights it up, PROVIDED the same image is also a form-label reference (logos alone are excluded from `all_media`, so a standalone logo's bytes never register in the map). HQ's app-builder logo PREVIEW is different: it renders from a rich `{url, multimedia_id, …}` record HQ writes only through its own session-auth logo uploader (`hqmedia/views.py::ProcessLogoFileUploadView`), and the `multimedia_id` isn't knowable until after the bytes upload — so a Nova-imported app's preview stays blank by construction. Backfilling it is deferred (the logo endpoint is session-auth, not api-key); the runtime banner is the surface that matters.

## MCP / SA tool surface

Seven media tools in `lib/agent/tools/media/`, registered on both the SA and MCP surfaces: `attach_field_media` (label/hint/help/validate-msg slots; `null` clears), `attach_option_media`, `set_module_media` (icon + audioLabel in one call), `set_form_media`, `set_app_logo`, `list_media_assets` (the discovery tool the others depend on), `remove_media_asset` (refuses, naming referrers, if any carrier references the asset). Image-map columns ride the existing `add_case_list_column` / `update_case_list_column` tools (the column union carries the `image-map` arm) — no dedicated column tools. Help text rides `edit_field`'s `help` slot — no dedicated text tool.

`lib/mcp/tools/uploadMediaAsset.ts` (`upload_media_asset`) is MCP-only: it takes inline base64 bytes for non-browser clients, runs the same validation pipeline, and returns `{ asset_id, deduplicated }`. The browser never calls it — it uploads via the HTTP routes and receives the `assetId` through the normal tool-call flow. The SA prompt's multimedia guidance is content-driven (label image to teach visual recognition, option images for concrete visual choices, module icon to make the home screen scannable) and media tools are available in both build and edit mode.

## Wire emission — `lib/commcare/multimedia/`

Pure CCHQ-shape translation, isolated to `lib/commcare/` by the Biome import boundary. `assetWirePath.ts` maps the manifest to wire paths (`commcare/<hash><ext>` + `jr://file/` refs); `itextMedia.ts` appends `<value form="…">` siblings to a slot's itext `<text>`; `navMenuMedia.ts` stamps module + form `media_image` / `media_audio` (HQ JSON dicts and the local suite nav node); `mediaSuiteXml.ts` builds the local `.ccz` `media_suite.xml`; `logoEntry.ts` emits the logo profile property; `bundle.ts` produces the `.ccz` file entries + `multimedia_map` (placeholder ids HQ overwrites on upload). Image-map columns emit the `enum-image` `<template form="image">` shape from the case-list emitter. XForm integration lives in `xform/builder.ts` (itext media siblings + the `<help>` body child); compiler + expander thread the manifest through.

### Media-OFF / ON contract

`expandDoc` / `compileCcz` take an optional `assets` manifest. **Manifest present → media-ON**: itext media, nav-menu media, logo, and `enum-image` columns all emit `jr://` refs. **Manifest absent → media-OFF**: media slots are skipped and image-map columns degrade to plain columns. Media wire artifacts therefore emit ONLY where the bytes also ship — the `.ccz` compile path and the HQ-upload path. Raw-JSON paths (`/api/compile/json`, MCP `compile_app` json) stay media-OFF and are byte-identical to pre-media output. Every media-ON entry point runs `collectMediaValidationErrors` before expand, so a stale/pending/foreign/kind-mismatched ref surfaces as an actionable error instead of a broken on-device reference.

## HQ upload — bulk ZIP, async status poll

`lib/commcare/client.ts::uploadAppMediaBundle` POSTs ALL the app's media as one ZIP to HQ's bulk endpoint (`POST /a/{domain}/apps/api/{app_id}/multimedia/`), then polls `GET .../multimedia/status/{processing_id}/` until HQ finishes async-processing the archive (or `timedOut`). The ZIP is built by `lib/commcare/multimedia/bulkUploadZip.ts::buildMediaBulkUploadZip` — the SAME dedup'd `commcare/<hash><ext>` layout the `/api/compile/json` media export bundles, so a manual import and an API upload can't diverge. The app is imported FIRST (its id goes in the upload URL); HQ matches each ZIP entry against the imported app's `get_all_paths_of_type` references and `create_mapping` assigns the real `multimedia_id`s so refs resolve on the device. The result (`MediaBundleUploadResult { matched, unmatched, errors, timedOut }`) surfaces as a warning — a media-byte failure never fails the upload (the app already exists), so partial failures degrade to warnings on both the chat route (`app/api/commcare/upload/route.ts`) and the MCP tool (`lib/mcp/tools/uploadAppToHq.ts`). Both apply the media-validation gate before expand.

This replaced the original per-file path (`uploadAppMedia` / `uploadMediaFile`, one POST per asset). Nova uploads with an api-key identity, and the per-kind multimedia endpoints are `login_and_domain_required` (session-only) — they reject an api-key, returning HTML login pages that surfaced as `"Unexpected token '<'"` JSON-parse failures. The bulk endpoint is `@api_auth()`, so it accepts the api-key. `matched: 0` therefore means HQ parsed the form but found no matching reference — caused, in one case this session, by a malformed `<orx:meta>` block that made the form fail to parse (fixed separately; see `lib/commcare/CLAUDE.md`'s meta build-time-injection note).

## Validators + oracles

User-facing rules in `lib/commcare/validator/rules/media/`: `mediaAssetExists` (every referenced id resolves to an owner-scoped row — owner mismatch reads as not-found, folding ownership into existence), `mediaAssetReady` (no `pending` assets in a shipped app), `mediaKindMatches` (an `image` slot references an image-typed asset, etc.), plus `imageMapValueUnique` (duplicate mapping values). Test-time totality oracles: `mediaSuiteOracle.ts::validateMediaSuite` (parses generated `media_suite.xml` against commcare-core's `MediaSuite.java` contract); `xformOracle`, `suiteOracle`, and `hqJsonOracle` gained media-resolution checks (every emitted `jr://` ref resolves against the bundled manifest; `enum-image` literals and `media_image`/`media_audio` dicts validated). Each oracle is co-developed with a fuzzer that emits from schema-valid arbitrary docs and asserts clean; a failure is an emitter bug, never a new reject rule.

## Migration + tooling

No migration — every new schema slot is optional. `scripts/scan-multimedia-readiness.ts` is a read-only diagnostic: given `--owner` or `--app`, it reports which apps would fail a media-ON upload and why (per-carrier broken refs classified `ready` / `pending` / `missing` / `kind-mismatch`, mirroring the three asset rules) plus orphaned-but-uploaded assets.

## How it verifies end-to-end

In the builder (`npm run dev`, open a form), the `+ Image` pill next to a question's label opens the picker; dropping a PNG shows a thumbnail within ~2s. A second image attaches to a select option, and the image-map column kind appears in the case-list column picker. Module icon and app logo are set through the SA chat or MCP tools (`set_module_media`, `set_app_logo`) — they have no builder chrome. Compile downloads `<app>.ccz`; the label/option images appear as `<value form="image">jr://file/commcare/…` in the form XML, the module icon as `<media_image>` in `suite.xml`, the logo's `jr://` path in `profile.ccpr`, and the bytes at `commcare/<hash>.png` in the archive. Asking the SA "what assets does this app use?" returns them via `list_media_assets`. Upload to HQ imports the app, then POSTs all assets as one bulk ZIP and polls HQ's processing status; a partial media failure surfaces as a warning (with `matched` / `unmatched` counts) while the app still lands. In the Nova builder itself, `MediaDisplay` renders the label image above the prompt (edit + live, verified live) and the app logo as a home-screen banner. On web apps the form renders the image beside the question prompt and the module shows its icon. (The on-device render is the one link that needs a live HQ.)

## CCHQ feature lifecycle citations

Every emitted carrier is alive-runtime, verified against `~/code/commcare-hq` and `~/code/commcare-core`:

- `<value form="image|audio|video|markdown">` — `commcare-hq/.../app_manager/xform.py::VALID_VALUE_FORMS`
- `<help ref="jr:itext(...)">` — `commcare-core/.../xform/parse/XFormParser.java::parseHelp`
- `NavMenuItemMediaMixin.media_image` / `media_audio` (Module / Form) — `commcare-hq/.../app_manager/models.py::NavMenuItemMediaMixin`
- `enum-image` column format — `commcare-hq/.../app_manager/suite_xml/sections/details.py::EnumImageColumn`
- `hq_logo_web_apps` slot — `commcare-hq/.../app_manager/models.py::ANDROID_LOGO_PROPERTY_MAPPING`; `commcare-hq/.../hqmedia/models.py::ApplicationMediaMixin.logo_refs`
- `multimedia_map` schema — `commcare-hq/.../app_manager/models.py::ApplicationMediaMixin.multimedia_map`
- Local-bundle requirement (remote-only refs fail install) — `commcare-core/.../resources/model/installers/BasicInstaller.java::install`
- `media_suite.xml` parse contract — `commcare-core/.../suite/model/MediaSuite.java`

Drove two omissions: `jr:requiredMsg` has **no** target in `XFormParser::parseBindAttributes` (→ no `required_msg` slot); `audio/mp4` / `audio/ogg` have no mime entry on HQ's deployed image (→ `.mp3` / `.wav` only).

## Out of scope (named handoffs)

- **LLM image generation** — layers on top of `upload_media_asset` (generators call the same validate+store path). Separate plan.
- **Per-language media** — rides whatever plan moves Nova's labels to a `LangMap`; single-language is the floor across the whole authoring layer, not a media gap.
- **Orphan cleanup cron** — soft-delete is enough; cleanup is a storage-cost optimization.
- **Module / case-list / app-logo builder chrome** — tool-only today; needs net-new per-app settings surfaces.
- **Case-list-link media** — needs Nova to model a case-list-link command (a wire path) first.
- **`caseListForm` media, Android `lookup_image` callouts, print-template HTML, import of existing CCHQ apps' media** — separate carriers / pipelines Nova doesn't model.
