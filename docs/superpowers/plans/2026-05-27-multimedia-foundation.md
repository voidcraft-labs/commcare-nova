# Multimedia Foundation

Date: 2026-05-27 · Status: planning · Target branch: `feature/multimedia-foundation`

## Goal

Native display multimedia attached to CommCare web apps Nova generates: image/audio/video on every question's label/hint/help/validate_msg/required_msg and on select options; icons + audio prompts on modules / forms / case-list links; image-per-case-property columns in case lists; an app logo. End-to-end through authoring, MCP/SA tools, compile, and upload-to-HQ — coverage of every web-apps multimedia carrier CommCare supports, in one shipping cycle.

## Decisions (locked)

| | Decision | Rationale |
|---|---|---|
| **Dedup scope** | Per-owner | One stored blob per `(owner, contentHash)`. Same logo reused across all of a user's apps = one upload, one byte payload. Asset library follows the user, not the app. |
| **Storage backend** | GCS, content-hash keyed | GCP-native (matches Firestore + KMS + Cloud SQL Connector). Bytes never world-readable; proxied through ownership-gated Nova route. |
| **Upload flow** | Client-side hash + signed PUT + confirm | Browser computes SHA-256, posts `(claim → signed PUT URL → bytes → confirm)`. Server validates from GCS post-upload. Scales past Cloud Run's request-size limit; enables dedup-skip-the-upload. |
| **Size caps** | 5 MB image / 10 MB audio / 50 MB video | Forces sane originals. Cellular-deployment-friendly. |
| **Per-attachment caption** | None — asset-level `displayName` only | Single source of truth for asset identity. Library UI works like Photos / Drive. |
| **Help + required_msg text slots** | Ship both, with media siblings | Both alive-runtime on CCHQ; natural to add alongside their media counterparts. |
| **Per-language** | Out of scope | Nova is single-language today (`xform/builder.ts::buildXForm` hardcodes `lang="en"`; field text is `z.string()`, not `LangMap`). Per-language media rides whatever localization plan the labels themselves move with. |
| **TipTap inline `![alt](url)` image button** | Preserved untouched | Valid creative path for markdown-form labels. Structured media is additive, not replacement. |
| **`caseListForm` (registration-from-case-list) media** | Out of scope | Nova doesn't model `caseListForm` at the domain layer yet (`hqShells.ts:388` is wire-only). Adding multimedia to a non-existent carrier requires the carrier first. |
| **Generation (LLM-produced images)** | Out of scope — separate plan | Layers on top of the asset library; doesn't change this plan's surfaces. |
| **Orphan cleanup cron** | Out of scope — follow-up | Soft-delete-only here. Cleanup is a correctness optimization, not a feature gate. |

## Naming — Nova-native everywhere except wire emit

CCHQ vocabulary leaks ONLY at `lib/commcare/`. The authoring layer, tool surface, UI, and validator speak Nova names. Translation happens at the emit boundary.

**Convention split** (already established in Nova; new code follows):

- Field-property level (`lib/domain/fields/*.ts`) → snake_case. Existing precedent: `case_property_on`, `validate_msg`, `repeat_mode`.
- Module / form / case-list-config / column / blueprint level → camelCase. Existing precedent: `caseListConfig`, `visibleInList`, `searchInputs`.
- Discriminator literals → kebab-case. Existing precedent: `kind: "id-mapping"`, `kind: "interval"`.
- Type names → PascalCase. Existing precedent: `Field`, `BlueprintDoc`, `CaseListConfig`.

**Authoring vocabulary chosen for the carriers**:

| Carrier | Nova authoring name | CCHQ wire (emit-only) |
|---|---|---|
| Image / audio / video attached to a question's label | `field.label_media: Media` | `<value form="image\|audio\|video">jr://...` inside `<text>` |
| Same for question hint | `field.hint_media` | Same form, `-hint` itext key |
| Same for help text | `field.help_media` | Same form, `-help` itext key |
| Same for validation error | `field.validate_msg_media` | Same form, `-constraintMsg` itext key |
| Same for "you must fill this" error | `field.required_msg_media` | Same form, `-requiredMsg` itext key |
| Image / audio / video on a select option | `option.media` | Per-option itext entry, same shape |
| Module home-tile picture | `module.icon` | `media_image` on `NavMenuItemMediaMixin` shell + suite.xml `<media_image>` |
| Module spoken-name audio | `module.audioLabel` | `media_audio` on same shell |
| Same for forms | `form.icon`, `form.audioLabel` | Same |
| Same for the "Open case list" link | `caseListConfig.icon`, `caseListConfig.audioLabel` | `CaseList(NavMenuItemMediaMixin)` shell |
| Per-case-row icon driven by a case property's value | `caseListConfig.columns[i] = { kind: "image-map", ... }` | `format="enum-image"` column with `<enum>` mapping |
| App logo (web-apps slot) | `blueprintDoc.logo` | `hq_logo_web_apps` in `logo_refs` + profile property |

**Why these names**:

- `icon` for a menu item's image is honest authoring vocabulary. CCHQ's `media_image` is a Dimagi-mechanism term ("CouchDB-keyed media of image variety"). Users add "an icon" to their module.
- `audioLabel` (not "spoken name" or "voice prompt") because it's literally an audio version of the menu label — concise and unambiguous.
- `image-map` column kind mirrors the existing `id-mapping` column shape (case-property-value → display). Authors who already understand `id-mapping` immediately understand `image-map`.
- `Media` (the slot bundle) is short and accurate. Not `MediaRefSet` — there's no separate "ref" vs "slots" distinction worth preserving; the slot key (`image` / `audio` / `video`) already encodes the kind. Not `MediaAttachments` — too long; not `MediaContent` — vague.
- `MediaAsset` (the storable record) is standard photo-library vocabulary.
- `label_media` / `hint_media` etc. carry the parent slot prefix because they sit at field-property level; the prefix encodes which message-slot they decorate. Alternative was nesting (`label: { text, media }`), but that's a schema migration on every existing field — bad cost/benefit for a single payoff.

## Data model

### `lib/domain/multimedia.ts` (CREATE)

```ts
import { z } from "zod";
import { uuidSchema } from "./uuid";

/** Asset identity — an opaque UUID Nova owns. NEVER a jr:// path or CCZ install path. */
export const assetIdSchema = uuidSchema;
export type AssetId = z.infer<typeof assetIdSchema>;

/**
 * The MIME types we accept at upload, partitioned by kind. The sniffed
 * `mime_type` on a MediaAsset must be one of these — any other value is
 * a validation-pipeline failure (the upload is rejected, the GCS object
 * is deleted, the Firestore row is removed).
 */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const AUDIO_MIME_TYPES = ["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"] as const;
export const VIDEO_MIME_TYPES = ["video/mp4"] as const;
export const ALL_MIME_TYPES = [...IMAGE_MIME_TYPES, ...AUDIO_MIME_TYPES, ...VIDEO_MIME_TYPES] as const;

/**
 * The slot bundle attached to any carrier that can have media. Each slot
 * is independent: a question can have image+audio+video simultaneously,
 * or just image, or none. Slot key encodes the kind; the value is the
 * asset id, period.
 *
 * Menu-style carriers (module/form/case-list link) use `AssetId` slots
 * directly on the parent (`module.icon`, `module.audioLabel`) rather than
 * this bundle, because their slot count is small + asymmetric (image + audio,
 * no video).
 */
export const mediaSchema = z
  .object({
    image: assetIdSchema.optional(),
    audio: assetIdSchema.optional(),
    video: assetIdSchema.optional(),
  })
  .strict();
export type Media = z.infer<typeof mediaSchema>;

/**
 * The stored asset record. Lives at root collection `mediaAssets/{id}`;
 * the `owner` field is the gate for every read site. Apps reference
 * assets by id only; they never embed the record.
 *
 * `displayName` is user-editable in the asset library; defaults to
 * `originalFilename` at upload. `status` exists because the
 * (signed PUT → confirm) flow has an in-flight window where the row
 * exists but the bytes aren't validated yet.
 */
export const mediaAssetSchema = z
  .object({
    id: assetIdSchema,
    owner: z.string(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(ALL_MIME_TYPES),
    extension: z.string().regex(/^\.[a-z0-9]+$/),
    sizeBytes: z.number().int().positive(),
    dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
    durationMs: z.number().int().positive().optional(),
    gcsObjectKey: z.string(),
    originalFilename: z.string(),
    displayName: z.string().optional(),
    status: z.enum(["pending", "ready"]),
    createdAt: z.date(),
  })
  .strict();
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
```

### Field-schema additions — `lib/domain/fields/base.ts` (MODIFY)

`fieldBaseSchema` (every labeled field) gains:

- `label_media?: Media`

`containerFieldBase` (group, repeat) gains:

- `label_media?: Media`

`inputFieldBaseSchema` (every input-capable field) gains:

- `hint_media?: Media`
- `help?: string`
- `help_media?: Media`
- `validate_msg_media?: Media` (sibling of existing `validate_msg`)
- `required_msg?: string`
- `required_msg_media?: Media`

All optional. Existing apps parse unchanged.

`selectOptionSchema` gains:

- `media?: Media`

### Module schema — `lib/domain/modules.ts` (MODIFY)

`moduleSchema` gains:

- `icon?: AssetId`
- `audioLabel?: AssetId`

`caseListConfigSchema` gains:

- `icon?: AssetId`
- `audioLabel?: AssetId`

New column shape added to `columnSchema` discriminated union:

```ts
export const imageMapColumnSchema = z
  .object({
    kind: z.literal("image-map"),
    uuid: uuidSchema,
    field: z.string(),       // case property name, same as id-mapping
    header: z.string(),
    mapping: z
      .array(z.object({
        value: z.string().regex(/^\S*$/),
        assetId: assetIdSchema,
      }).strict())
      .refine(arr => new Set(arr.map(r => r.value)).size === arr.length, {
        message: "Duplicate `value` in image-map mapping — each case-property value can map to at most one image",
      }),
    sort: columnSortSchema.optional(),
    visibleInList: z.boolean().optional(),
    visibleInDetail: z.boolean().optional(),
  })
  .strict();
```

### Form schema — `lib/domain/forms.ts` (MODIFY)

`formSchema` gains:

- `icon?: AssetId`
- `audioLabel?: AssetId`

### Blueprint — `lib/domain/blueprint.ts` (MODIFY)

`blueprintDocSchema` gains:

- `logo?: AssetId`

## Storage backend

Bucket `nova-multimedia-${env}` (one per env: `nova-multimedia-prod`, `nova-multimedia-dev`). Uniform bucket-level access, public-access prevention enforced. The service account is the only writer.

Object layout: `gs://nova-multimedia-${env}/users/{owner}/{contentHash}.{ext}`. Per-owner namespace lets us discover (owner, hash) collisions and skip the byte push entirely on dedup hits.

`lib/storage/media.ts` (CREATE):

- `createSignedUploadUrl({ owner, contentHash, ext, contentType, sizeBytes })` → URL bound to hash + size + content-type via the V4 signature; 5-minute TTL. Tampered bytes write to a path that doesn't match what the route expects and fail confirm.
- `streamAsset(gcsObjectKey)` → `ReadableStream<Uint8Array>` for the proxy route.
- `sha256OfStream(stream)` — compute server-side hash for the confirm step.
- `deleteAsset(gcsObjectKey)`.

`lib/db/mediaAssets.ts` (CREATE) — Firestore at root collection `mediaAssets/`:

- `createPendingAsset(args)` → reserves an id + writes a `status: "pending"` row.
- `confirmAssetReady(assetId, validated)` → flips to `status: "ready"`, writes sniffed metadata.
- `findAssetByOwnerAndHash(owner, hash)` — primary dedup probe at upload-initiate.
- `loadAssetForOwner(owner, assetId)` — every read site uses this; throws on owner mismatch.
- `listAssetsForOwner(owner, cursor)` — paginated library list.
- `loadAssetsByIds(ownerScope, ids)` — used by the compiler to resolve every reference in one batch.
- `deleteAsset(assetId)`.

Composite indexes in `firestore.indexes.json`:

- `(owner ASC, contentHash ASC)` — dedup lookup
- `(owner ASC, createdAt DESC)` — library pagination

## HTTP routes

`app/api/media/upload/route.ts` (CREATE) — `POST`. Body: `{ filename, mimeType, sizeBytes, contentHashClaim }`.

- Validate session; load `owner = session.user.id`.
- Reject MIME outside `ALL_MIME_TYPES`, reject SVG, reject `sizeBytes > capForKind(mimeType)`.
- `findAssetByOwnerAndHash(owner, contentHashClaim)` — if hit AND `status: "ready"`, return `{ assetId, deduplicated: true }` (no upload URL — browser skips bytes push).
- Else `createPendingAsset(...)`, generate signed PUT URL, return `{ assetId, uploadUrl, expiresAt }`.

`app/api/media/upload/[assetId]/confirm/route.ts` (CREATE) — `POST`.

- Load asset; assert `owner === session.user.id` and `status === "pending"`.
- `streamAsset(gcsObjectKey)` → consume once. Compute SHA-256, run `file-type` for magic-bytes sniff, run `sharp.metadata()` for images (dimensions + parse validity), run `ffprobe` for audio/video (duration + parse validity).
- Mismatches (sniffed MIME ≠ claim, hash ≠ claim, sharp/ffprobe parse fail, SVG sneaking in): delete GCS object, delete Firestore row, return 400 with Elm-shape message.
- Success: write verified `mimeType`, `extension`, `sizeBytes`, `dimensions`/`durationMs`, flip `status: "ready"`.

`app/api/media/[assetId]/route.ts` (CREATE) — `GET`.

- Load asset, assert `owner === session.user.id` AND `status === "ready"`.
- Stream from GCS with `Content-Type: <sniffed-mime>`, `Cache-Control: private, immutable, max-age=86400`, `Content-Length: <sizeBytes>`.

`app/api/media/library/route.ts` (CREATE) — `GET`. Cursor-paginated list of the owner's `ready` assets for the library picker tab.

## Validation pipeline — `lib/media/validate.ts` (CREATE)

Single module both the HTTP route and the MCP `upload_media_asset` tool call. One source of truth.

1. Extension whitelist (hard reject before reading body): `.png .jpg .jpeg .gif .webp .mp3 .m4a .mp4 .wav .ogg`. SVG explicitly rejected.
2. Size cap per kind (image ≤5 MB, audio ≤10 MB, video ≤50 MB).
3. Magic-bytes sniff via `file-type` package (reads first ~262 bytes). Detected MIME must match claim AND extension.
4. Library re-parse: `sharp` for images (canonical re-encode strips EXIF; failure = reject), `ffprobe` for audio/video.
5. SHA-256 computed from the validated bytes. Stored as `contentHash`.

Add deps to `package.json`: `@google-cloud/storage`, `file-type`, `sharp`, `@ffprobe-installer/ffprobe`, `fluent-ffmpeg`.

## Authoring UI

### MediaSlot — the universal mount

`components/builder/media/MediaSlot.tsx` (CREATE). Single component every carrier mounts.

Props: `{ value: Media | undefined; onChange: (next: Media | undefined) => void; kinds: ReadonlyArray<"image" | "audio" | "video">; surfaceLabel: string; }`.

Renders one row per `kinds` entry. Empty slot shows a `+ Image` / `+ Audio` / `+ Video` pill (Tabler icon via `@iconify/react/offline`). Filled slot shows a 40×40 thumbnail (image) or codec-icon + filename (audio/video) + kebab menu (Replace / Remove / Edit name).

Click `+` opens `MediaPickerDialog`. Click thumbnail opens `MediaPreviewPopover` (Base UI Popover; never `createPortal`).

For carriers whose slot is a single `AssetId` (module icon, audio label, app logo): a thin `SingleAssetSlot` variant with `kind: "image" | "audio"` and `value: AssetId | undefined`.

### MediaPickerDialog

`components/builder/media/MediaPickerDialog.tsx` (CREATE). Base UI Dialog. Two tabs:

- **Upload** — drag-and-drop zone + `<input type="file" autoComplete="off" data-1p-ignore>`. Progress bar driven by `XMLHttpRequest.upload.onprogress` (fetch has no upload progress). Computes SHA-256 client-side via SubtleCrypto before posting initiate. On dedup hit, skips the PUT entirely.
- **Library** — grid of the owner's `ready` assets, fetched from `/api/media/library`. Thumbnail proxied through `/api/media/{assetId}`. Search by `displayName` / `originalFilename`. Click commits.

### MediaPreviewPopover

`components/builder/media/MediaPreviewPopover.tsx` (CREATE). Base UI Popover. Image: large preview + dimensions + filename + `displayName` editor (commit on blur). Audio/video: native `<audio controls>` / `<video controls>` sourced from `/api/media/{assetId}`.

### Editor-schema integration

`components/builder/editor/fieldEditorSchemas.ts` (MODIFY). Add a `mediaEntry<F, K>(key, label, kinds)` factory alongside the existing `xpathEntry` / `hintEntry`. For every visible field kind (all except `hidden`):

- Add `mediaEntry("label_media", "Image / audio / video for label", ["image", "audio", "video"])` to the `ui` section.
- For input kinds, add the same factory call for `hint_media`, `help_media`, `validate_msg_media`, `required_msg_media`. Add plain `textEntry` calls for `help` and `required_msg` text slots.

The declarative schema means `FieldEditorPanel` needs no per-kind switching — the panel reads the schema and renders.

### Other mount sites

| Surface | File | Slot |
|---|---|---|
| Per-option media | `components/builder/editor/fields/OptionsEditor.tsx` (MODIFY) | inline `MediaSlot` on each option row, `kinds: ["image", "audio", "video"]` |
| Module icon + audio label | `components/builder/detail/moduleSettings/AppearanceSection.tsx` (CREATE) | two `SingleAssetSlot`s in a module-settings panel |
| Form icon + audio label | `components/builder/detail/formSettings/AppearanceSection.tsx` (CREATE) | same shape |
| Case-list icon + audio label | `components/builder/case-list-config/AppearanceSection.tsx` (CREATE) — sits in the Display block | same shape |
| `image-map` column editor | `components/builder/case-list-config/cards/column/ImageMapColumnCard.tsx` (CREATE) + `columnEditorSchemas.ts` (MODIFY) | one row per mapping, value text input + image `SingleAssetSlot` |
| App logo | `components/builder/appSettings/LogoSection.tsx` (CREATE) — within existing app settings | single `SingleAssetSlot` |
| TipTap inline image | `lib/tiptap/markdownExtensions.ts` (NO CHANGE) | preserved untouched |

All UI uses Base UI primitives (Dialog, Popover, Field, Tabs), `motion/react` for transitions, `@iconify/react/offline` for icons. All `<input>` and `<textarea>` carry `autoComplete="off"` + `data-1p-ignore`. Z-index uses semantic tokens, not literal numbers.

## MCP / SA tool surface

Two categories per existing Nova convention (`lib/agent/CLAUDE.md`):

- **MCP-only** (bytes-in-line for non-browser clients): `upload_media_asset`. The chat-side SA never invokes this directly — the browser handles bytes via HTTP route, and the chat receives the resulting `assetId` from `useChat`'s tool-call flow.
- **Shared** (blueprint mutations): everything else. Registered in `lib/mcp/server.ts::SHARED_TOOLS` with both `mcp__plugin_nova_nova__` and `mcp__nova__` prefix variants per the existing pattern.

`lib/agent/tools/media/` (CREATE one file per tool) + `lib/mcp/tools/uploadMediaAsset.ts` (CREATE):

| Tool name | Inputs | Effect |
|---|---|---|
| `upload_media_asset` (MCP-only) | `{ filename, mime_type, base64_bytes }` | Runs validation pipeline against decoded bytes; uploads to GCS at `users/{caller}/{hash}.{ext}`; returns `{ asset_id, deduplicated }`. Caller owner derived from MCP auth context. |
| `list_media_assets` | `{ kind?: "image"\|"audio"\|"video", query?: string }` | Returns paginated `MediaAsset[]` for the caller. |
| `remove_media_asset` | `{ asset_id }` | Refuses if any carrier in any of the caller's apps references the asset; surfaces the referrers in the error. |
| `attach_field_media` | `{ app_id, field_uuid, slot: "label" \| "hint" \| "help" \| "validate_msg" \| "required_msg", media: Media \| null }` | Sets `field.<slot>_media`. `null` clears. |
| `set_field_help_text` | `{ app_id, field_uuid, text: string \| null }` | Sets `field.help` (paired with `attach_field_media slot: "help"` for media). |
| `set_field_required_msg_text` | `{ app_id, field_uuid, text: string \| null }` | Sets `field.required_msg`. |
| `attach_option_media` | `{ app_id, field_uuid, option_value, media: Media \| null }` | Sets `option.media`. Disambiguation index hint for the rare same-value collision. |
| `set_module_icon` | `{ app_id, module_uuid, asset_id: AssetId \| null }` | Sets `module.icon`. |
| `set_module_audio_label` | `{ app_id, module_uuid, asset_id: AssetId \| null }` | Sets `module.audioLabel`. |
| `set_form_icon` | `{ app_id, module_uuid, form_uuid, asset_id }` | Sets `form.icon`. |
| `set_form_audio_label` | `{ app_id, module_uuid, form_uuid, asset_id }` | Sets `form.audioLabel`. |
| `set_case_list_icon` | `{ app_id, module_uuid, asset_id }` | Sets `caseListConfig.icon`. |
| `set_case_list_audio_label` | `{ app_id, module_uuid, asset_id }` | Sets `caseListConfig.audioLabel`. |
| `set_app_logo` | `{ app_id, asset_id: AssetId \| null }` | Sets `blueprintDoc.logo`. |
| `add_image_map_column` | `{ app_id, module_uuid, field, header, mapping: Array<{ value, asset_id }>, ...common_slots }` | Adds a column with `kind: "image-map"`. |
| `update_image_map_column` | `{ app_id, module_uuid, column_uuid, patch }` | Mutates an existing image-map column. |

SA prompt updates (`lib/agent/prompts.ts`):

- New "Multimedia" section. Content-driven attachment guidance: "Use a label image when the question is teaching the FLW to recognize visual content; use option images on selects when the user picks from concrete visual items; use a module icon to make the home screen scannable."
- Media tools are available in both build mode AND edit mode (display media is additive, never structurally generative).

## Compile-time emit

`lib/commcare/multimedia/` (CREATE) — pure-function CCHQ-shape translation, isolated to the `lib/commcare/` package per the Biome `noRestrictedImports` boundary.

- `assetWirePath.ts::wirePathFor(asset) → "commcare/{contentHash}.{ext}"` — the path that appears in `jr://file/...` references and as the CCZ entry path. Stable, deterministic, content-hash-keyed.
- `itextMedia.ts::extendItextValues(textElement, media, wirePaths)` — appends `<value form="image\|audio\|video">jr://file/{path}</value>` siblings inside an existing itext `<text>` element. Uses the `domhandler` construction pattern from `lib/commcare/elementBuilders.ts`.
- `mediaSuiteXml.ts::buildMediaSuiteXml(wirePathsToAssets) → string` — replaces the hardcoded empty `'<?xml version="1.0"?>\n<suite version="1"/>'` in `lib/commcare/compiler.ts`. One `<media>` entry per asset, with `<resource id>`, `<location authority="local">./commcare/{hash}.{ext}</location>`.
- `navMenuMedia.ts::applyNavMenuMedia(shell, { icon, audioLabel }, wirePaths)` — stamps `media_image` / `media_audio` on `Module` / `Form` / `CaseList` HQ shells. Module-icon-only carriers ignore the audio slot.
- `imageMapColumn.ts::emitImageMapColumn(column, wirePaths)` — emits the suite.xml `<field>` with `<template form="image"><text><xpath function="..."><variable name="...">jr://...` shape per CCHQ `detail_screen.py`.
- `logoEntry.ts::buildLogoProperty(logoAssetId, wirePaths)` — emits the `profile.ccpr` `<property id="hq_logo_web_apps">jr://file/{path}</property>` entry.
- `bundle.ts::buildMultimediaBundle(doc, hqJson, assetRows)` — single DFS walk producing:
  - `wirePaths: Map<AssetId, string>`
  - `cczBlobs: Map<wirePath, Buffer>` (bytes streamed from GCS)
  - `hqMultimediaMap: Record<wirePath, { multimedia_id, media_type, version }>` (placeholder values; CCHQ assigns real `multimedia_id` after the multimedia upload step)
  - `hqMultimediaZip: Buffer` (the standalone ZIP for HQ's step-2 multimedia endpoint)
  - `mediaSuiteXml: string`

The bundle builder is the totality boundary — given a doc that passed validation, it MUST emit a complete bundle. Any internal inconsistency throws a `compiler bug` per Nova's emitter-totality discipline (`feedback_total_function_emitters_no_emit_time_errors`).

### XForm builder integration — `lib/commcare/xform/builder.ts` (MODIFY)

`addItext(itextKey, label, media?)` extended — appends media value siblings when `media` is non-empty. Internal walker grows a parallel `mediaForItextKey: Map<itextKey, Media>` so the helper has the data when it builds each `<text>` node.

`buildLeafControl` gains a `<help ref="jr:itext('{itextKey}-help')"/>` body child when `field.help` is set, alongside existing `<label>` + `<hint>`.

`addItext` is also called for `-constraintMsg` (existing) and `-requiredMsg` (new); the corresponding `*_media` slots flow through the same extension point.

### Compiler integration — `lib/commcare/compiler.ts` (MODIFY)

`compileCcz` signature evolves: `(hqJson, appName, doc, assetRows) → Buffer`. Caller (the `/api/compile` route + `compile_app` MCP tool) is responsible for pre-loading asset rows; the compiler is pure.

- Bundle builder is invoked with `(doc, hqJson, assetRows)`.
- `files["media_suite.xml"] = bundle.mediaSuiteXml`.
- Every `bundle.cczBlobs` entry writes to the zip at its wire path.
- `generateProfile` gains logo property emission from `doc.logo` via `buildLogoProperty`.
- `hqJson.multimedia_map = bundle.hqMultimediaMap`.

### Expander integration

`lib/commcare/expander/*` (MODIFY — locate via `expandDoc` callers): per-module / per-form / per-case-list shell stamping via `applyNavMenuMedia`.

## Upload-to-HQ — 2-step sequence

`lib/commcare/client.ts` (MODIFY) — add:

- `uploadMultimedia(creds, domain, hqAppId, bundleZip)` → POSTs multipart `bulk_upload_file` to `/a/{domain}/apps/api/{hq_app_id}/multimedia/`. Same CSRF + 16KB WAF padding as `importApp` (defense-in-depth — the WAF block exists for this endpoint too, verified empirically). Returns `{ processing_id }`.
- `pollMultimediaStatus(creds, domain, processingId)` → polls `…/multimedia/status/{processing_id}/` at 1s intervals until `complete: true` or `failed`. 30s overall budget.

`lib/mcp/tools/uploadAppToHq.ts` (MODIFY):

1. `importApp(...)` → `hq_app_id` (existing path).
2. `buildMultimediaBundle(...)` → if `cczBlobs.size === 0`, skip steps 3–4.
3. `uploadMultimedia(creds, domain, hq_app_id, bundle.hqMultimediaZip)` → `processing_id`.
4. `pollMultimediaStatus(...)` until terminal. Fail the tool call if multimedia state is `failed` (the app would render without images — degraded shipped state).
5. Surface the HQ app URL + multimedia status to the caller.

## Validators

User-facing gates under `lib/commcare/validator/rules/media/` (CREATE):

- `mediaAssetExists.ts` — every `AssetId` referenced by any carrier resolves to a Firestore row.
- `mediaAssetOwnership.ts` — every referenced asset's `owner` matches the app's `owner`.
- `mediaAssetReady.ts` — every referenced asset has `status === "ready"` (no pending in shipped apps).
- `mediaKindMatches.ts` — `field.label_media.image` references an asset whose `mimeType` is in `IMAGE_MIME_TYPES`; same for audio + video.
- `imageMapValueUnique.ts` — same shape as the existing `idMappingValueUnique` rule, generalized for image-map columns.

Test-time totality oracles (extensions to existing oracle files in `lib/commcare/validator/`):

- `xformOracle.ts::validateXForm` — gains optional second arg `mediaManifest?: ReadonlySet<string>`; every `<value form="image|audio|video">jr://...</value>` reference must be in the manifest. Co-developed fuzzer extension in `__tests__/xformOracle.fuzz.test.ts`.
- `suiteOracle.ts::validateSuite` — every `media_image` / `media_audio` slot's jr:// path resolves to a manifest entry.
- `hqJsonOracle.ts::validateHqJson` — `multimedia_map` shape regression guard; every shell's media slot is `{ en: "<jr://...>" }` or absent.
- `bindingResolutionOracle.ts::validateBindingResolution` — every itext media-value jr:// path resolves to an entry in the bundled multimedia.
- New `lib/commcare/validator/mediaSuiteOracle.ts` — parses generated `media_suite.xml` against the `commcare-core MediaSuite.java` parse contract (Category-1 fatal + Category-2 cross-ref split).

## Tests

- **State model** (Vitest, no DOM): asset CRUD reducer; blueprint mutations attaching/detaching media; undo/redo across media changes; image-map column edits.
- **Validation pipeline** (Vitest): exhaustive codec coverage; rejection matrix (MIME spoof, hash mismatch, oversized, SVG, sharp-failure, ffprobe-failure, expired upload URL).
- **Wire emission** — oracle assertions on hand-crafted fixtures + property-fuzz against schema-valid arbitrary docs with random media refs. Each carrier asserts clean against the shipped CCHQ fixture in `commcare-hq/corehq/apps/app_manager/tests/data/` (e.g. `suite/form_media_suite.xml`, `suite/case_list_image.xml`).
- **Upload-to-HQ** — Vitest with HTTP mock; full 2-step sequence including poll loop; failure-state propagation.
- **Playwright** — single end-to-end flow (one per carrier family) when Playwright lands.

## Migration

None — every new schema slot is optional. Existing apps parse unchanged.

`scripts/scan-multimedia-readiness.ts` (CREATE) — read-only scan reporting per-app counts of fields/options/modules/forms/case-lists that *could* carry media. Informational only. No writes.

## File structure

### CREATE

```
lib/domain/multimedia.ts
lib/db/mediaAssets.ts
lib/storage/media.ts
lib/media/validate.ts
app/api/media/upload/route.ts
app/api/media/upload/[assetId]/confirm/route.ts
app/api/media/[assetId]/route.ts
app/api/media/library/route.ts
components/builder/media/MediaSlot.tsx
components/builder/media/SingleAssetSlot.tsx
components/builder/media/MediaPickerDialog.tsx
components/builder/media/MediaPreviewPopover.tsx
components/builder/media/useMediaUpload.ts
components/builder/media/useMediaLibrary.ts
components/builder/media/useMediaSrc.ts
components/builder/editor/fields/MediaSlotEditor.tsx
components/builder/detail/moduleSettings/AppearanceSection.tsx
components/builder/detail/formSettings/AppearanceSection.tsx
components/builder/case-list-config/AppearanceSection.tsx
components/builder/case-list-config/cards/column/ImageMapColumnCard.tsx
components/builder/appSettings/LogoSection.tsx
lib/commcare/multimedia/assetWirePath.ts
lib/commcare/multimedia/itextMedia.ts
lib/commcare/multimedia/mediaSuiteXml.ts
lib/commcare/multimedia/navMenuMedia.ts
lib/commcare/multimedia/imageMapColumn.ts
lib/commcare/multimedia/logoEntry.ts
lib/commcare/multimedia/bundle.ts
lib/commcare/multimedia/__tests__/bundle.test.ts
lib/commcare/multimedia/__tests__/itextMedia.test.ts
lib/commcare/multimedia/__tests__/navMenuMedia.test.ts
lib/commcare/multimedia/__tests__/imageMapColumn.test.ts
lib/commcare/multimedia/__tests__/mediaSuiteXml.test.ts
lib/commcare/validator/rules/media/mediaAssetExists.ts
lib/commcare/validator/rules/media/mediaAssetOwnership.ts
lib/commcare/validator/rules/media/mediaAssetReady.ts
lib/commcare/validator/rules/media/mediaKindMatches.ts
lib/commcare/validator/rules/media/imageMapValueUnique.ts
lib/commcare/validator/mediaSuiteOracle.ts
lib/agent/tools/media/listMediaAssets.ts
lib/agent/tools/media/removeMediaAsset.ts
lib/agent/tools/media/attachFieldMedia.ts
lib/agent/tools/media/setFieldHelpText.ts
lib/agent/tools/media/setFieldRequiredMsgText.ts
lib/agent/tools/media/attachOptionMedia.ts
lib/agent/tools/media/setModuleIcon.ts
lib/agent/tools/media/setModuleAudioLabel.ts
lib/agent/tools/media/setFormIcon.ts
lib/agent/tools/media/setFormAudioLabel.ts
lib/agent/tools/media/setCaseListIcon.ts
lib/agent/tools/media/setCaseListAudioLabel.ts
lib/agent/tools/media/setAppLogo.ts
lib/agent/tools/media/addImageMapColumn.ts
lib/agent/tools/media/updateImageMapColumn.ts
lib/agent/tools/media/index.ts
lib/mcp/tools/uploadMediaAsset.ts
scripts/scan-multimedia-readiness.ts
```

### MODIFY

```
package.json                                              # add deps
firestore.indexes.json                                     # composite indexes
lib/domain/fields/base.ts                                  # label_media on fieldBase + containerFieldBase; hint/help/validate/required _media + help, required_msg text on inputFieldBase; option media
lib/domain/fields/singleSelect.ts                          # picks up option media via shared schema
lib/domain/fields/multiSelect.ts                           # same
lib/domain/modules.ts                                       # icon + audioLabel on module + caseListConfig; image-map column schema
lib/domain/forms.ts                                         # icon + audioLabel on form
lib/domain/blueprint.ts                                     # logo
lib/commcare/xform/builder.ts                              # addItext extension; buildLeafControl help child
lib/commcare/compiler.ts                                   # signature evolution; bundle integration; profile logo
lib/commcare/expander/*                                    # NavMenu shell stamping
lib/commcare/client.ts                                     # uploadMultimedia + pollMultimediaStatus
lib/commcare/validator/xformOracle.ts                      # mediaManifest arg
lib/commcare/validator/suiteOracle.ts                      # NavMenu + image-map + logo validation
lib/commcare/validator/hqJsonOracle.ts                     # multimedia_map shape
lib/commcare/validator/bindingResolutionOracle.ts          # itext media path resolution
lib/mcp/server.ts                                          # SHARED_TOOLS += media tools
lib/mcp/tools/uploadAppToHq.ts                             # 2-step sequence
lib/agent/prompts.ts                                       # multimedia SA guidance
components/builder/editor/fieldEditorSchemas.ts            # mediaEntry factory + per-kind entries
components/builder/editor/fields/OptionsEditor.tsx         # inline option MediaSlot
components/builder/case-list-config/columnEditorSchemas.ts # image-map column registration
lib/tiptap/markdownExtensions.ts                            # NO CHANGE — preserved coexistently
```

## Tasks

Each is dispatchable to an implementer with the named acceptance criteria.

### T1 — Infra: GCS bucket + dependencies

Provision `nova-multimedia-${env}` with uniform bucket-level access and public-access prevention enforced. Add `@google-cloud/storage`, `file-type`, `sharp`, `@ffprobe-installer/ffprobe`, `fluent-ffmpeg` to `package.json`. Add `NOVA_MEDIA_BUCKET` env var.

**Acceptance:** `gcloud storage buckets describe gs://nova-multimedia-prod` shows uniform access + PAP enforced; `npm install` succeeds.

### T2 — Asset schema + Firestore client

Create `lib/domain/multimedia.ts`, `lib/db/mediaAssets.ts`. Add Firestore composite indexes to `firestore.indexes.json`.

**Acceptance:** new vitest `__tests__/multimedia.schema.test.ts` asserts round-trip parse; emulator-backed CRUD tests for `createPendingAsset` / `confirmAssetReady` / `findAssetByOwnerAndHash`.

### T3 — Validation pipeline

Create `lib/media/validate.ts` with the 5-stage gauntlet. Unit tests covering: each valid codec, magic-mismatch reject, oversized reject, SVG reject, sharp-failure reject, ffprobe-failure reject, hash-claim-mismatch reject.

**Acceptance:** 100% branch coverage on `validate.ts`.

### T4 — Storage client + HTTP routes

Create `lib/storage/media.ts` and the four `app/api/media/...` routes. End-to-end integration test posts an image through initiate → signed PUT → confirm → GET, asserts byte round-trip identity. Rejection cases each return correct status with Elm-shape messages.

**Acceptance:** integration test green; foreign-owner GET returns 403.

### T5 — Domain schema additions

Modify `lib/domain/fields/base.ts`, `lib/domain/modules.ts` (including `imageMapColumnSchema`), `lib/domain/forms.ts`, `lib/domain/blueprint.ts`. Verify `fieldPatchSchemaByKind` picks up new optional keys via the existing `partialOf` machinery.

**Acceptance:** `npm run build` clean; new test confirms (a) docs without any media parse, (b) docs with every new optional slot parse, (c) `imageMapColumnSchema` rejects duplicate values.

### T6 — MediaSlot + Picker + Preview primitives

Create the components under `components/builder/media/`. Use Base UI for Dialog + Popover. State-model tests for the slot reducer (kind toggle, replace, remove, displayName commit). Mock fetch tests for `MediaPickerDialog` upload + library tabs.

**Acceptance:** state-model tests green; manual smoke on a test page.

### T7 — Field editor integration

Modify `components/builder/editor/fieldEditorSchemas.ts` with `mediaEntry` factory + per-kind entries. Create `MediaSlotEditor.tsx`. Modify `OptionsEditor.tsx`. State-model test: adding the `+ Image` pill on a text field's label commits a doc-store mutation that round-trips through `fieldSchema.parse`.

**Acceptance:** all existing `FieldEditorPanel` tests still green; new media-slot tests green.

### T8 — Module / Form / Case-list / Logo mount sites

Create the four `AppearanceSection.tsx` components and `LogoSection.tsx`. Each uses `SingleAssetSlot`. State-model tests per surface confirming mutations round-trip.

**Acceptance:** every named surface has a mount point in the UI; state-model tests green.

### T9 — Image-map column editor

Create `ImageMapColumnCard.tsx` + register in `columnEditorSchemas.ts`. Same shape of acceptance as the existing id-mapping card (duplicate-value rejection in the schema, drag-reorder via existing `useReorderableList`, value→media binding).

**Acceptance:** integration test on a fresh case-list shows the new column kind in the picker; adding two rows with the same value surfaces a validator error.

### T10 — Wire emission package

Create `lib/commcare/multimedia/` (all named files). Each emit helper validated against CCHQ fixtures in `~/code/commcare-hq/corehq/apps/app_manager/tests/data/` (specifically `suite/form_media_suite.xml` for media_suite shape, `suite/case_list_image.xml` for case-list-row carrier, `suite/enum_image_column.xml` for image-map). Unit tests per builder.

**Acceptance:** bundle determinism test (same inputs → same outputs); each helper passes its CCHQ-fixture comparison.

### T11 — XForm builder integration

Modify `lib/commcare/xform/builder.ts` for the `addItext` extension and `<help>` body child emission. New test file `__tests__/buildXForm.media.test.ts` asserts every media-bearing field emits the expected itext siblings; XForm oracle returns clean.

**Acceptance:** existing builder tests green; new media tests green.

### T12 — Compiler + Expander integration

Modify `lib/commcare/compiler.ts` (signature + bundle wiring + profile logo) and the expander files for NavMenu shell stamping. Modify `/api/compile/route.ts` + MCP `compile_app` tool to pre-load asset rows.

**Acceptance:** existing compiler-test golden corpus green; new media-bearing test passes against hand-validated wire fixtures.

### T13 — HQ multimedia upload

Modify `lib/commcare/client.ts` (`uploadMultimedia` + `pollMultimediaStatus`). Modify `lib/mcp/tools/uploadAppToHq.ts` for the 2-step chain. Vitest mock test for the full HQ sequence including poll loop.

**Acceptance:** mock test green; manual run against CCHQ staging domain renders a media-bearing app on web apps.

### T14 — Validator rules + oracle extensions

Create rules under `lib/commcare/validator/rules/media/`. Extend `xformOracle`, `suiteOracle`, `hqJsonOracle`, `bindingResolutionOracle`. Create `mediaSuiteOracle.ts`. Co-developed fuzzer extensions covering each new oracle.

**Acceptance:** per-rule tests + property-fuzz runs (10k iterations) emit clean.

### T15 — MCP / SA tool surface

Create every tool under `lib/agent/tools/media/` and `lib/mcp/tools/uploadMediaAsset.ts`. Register in `lib/mcp/server.ts::SHARED_TOOLS`. Update `lib/agent/prompts.ts` with the multimedia guidance section. Run `npx tsx scripts/test-schema.ts` — every tool's schema compiles within the Anthropic 8-optional-field ceiling.

**Acceptance:** schema-test script green; sample SA conversation in tests confirms the agent calls the right tool for a "add a picture to this question" prompt.

### T16 — Scan script + docs

Create `scripts/scan-multimedia-readiness.ts`. Create `app/(docs)/docs/builder/multimedia/page.mdx` (user-facing docs page; plain English voice per `feedback_docs_voice`).

**Acceptance:** scan runs against a sample-app set and reports counts; docs build green.

### T17 — Async-leak gate + final integration

Verify all GCS streams, signed-URL fetchers, and ffprobe child processes tear down in test teardown. Run `npm run test:leaks` — passes clean.

**Acceptance:** pre-push gate green on the branch.

## CCHQ feature lifecycle citations

Every carrier is alive-runtime, verified against `~/code/commcare-hq` and `~/code/commcare-core`:

- `<value form="image|audio|video|video-inline|markdown">` — `commcare-hq/corehq/apps/app_manager/xform.py::VALID_VALUE_FORMS`
- `<help ref="jr:itext(...)">` — `commcare-core/.../javarosa/xform/parse/XFormParser.java::parseHelp`
- `jr:requiredMsg` attribute — `commcare-core/.../javarosa/xform/parse/XFormParser.java::parseBindAttributes`
- `NavMenuItemMediaMixin.media_image` / `media_audio` (Module / Form / CaseList) — `commcare-hq/corehq/apps/app_manager/models.py::NavMenuItemMediaMixin`
- `enum-image` column format — `commcare-hq/corehq/apps/hqmedia/models.py::ApplicationMediaMixin.all_media`, `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::EnumImageColumn`
- `hq_logo_web_apps` slot — `commcare-hq/corehq/apps/hqmedia/models.py::ApplicationMediaMixin.logo_refs`, `commcare-hq/corehq/apps/app_manager/models.py::ANDROID_LOGO_PROPERTY_MAPPING`
- `multimedia_map` schema — `commcare-hq/corehq/apps/app_manager/models.py::ApplicationMediaMixin.multimedia_map`
- `import_app_api` + `upload_multimedia_api` + `multimedia_status_api` — `commcare-hq/corehq/apps/app_manager/views/app_import_api.py`
- Local-bundle requirement for media install — `commcare-core/src/main/java/org/commcare/resources/model/installers/BasicInstaller.java::install` (the `RESOURCE_AUTHORITY_REMOTE` branch has a `//TODO: Implement local cache code` and returns `false`; remote-only references fail install)
- `media_suite.xml` parse contract — `commcare-core/.../suite/model/MediaSuite.java`

No deprecated paths involved.

## Final user-runnable verification

User runs `npm run dev`, opens `http://localhost:3000/build/<app-id>/<form-uuid>`, clicks the `+ Image` pill next to a question's label, drops a PNG into the upload dialog, sees a 40×40 thumbnail within 2 seconds. Adds a different PNG to a select option in the same form. Sets a module icon from app settings. Uploads a logo. Clicks Compile — the browser downloads `<app-name>.ccz`. User runs:

```
unzip -p <app-name>.ccz commcare/$(sha256sum label-image.png | cut -c1-64).png | file -
# → PNG image data

unzip -p <app-name>.ccz modules-0/forms-0.xml | grep -c '<value form="image">jr://file/commcare/'
# → 2  (one for the label, one for the option)

unzip -p <app-name>.ccz suite.xml | grep -c '<media_image>jr://file/commcare/'
# → 1  (module icon)

unzip -p <app-name>.ccz profile.ccpr | grep 'hq_logo_web_apps'
# → 1 line, with the jr:// path
```

Then user opens the SA chat, types "what assets does this app use?" — SA returns the four assets via `list_media_assets`. User clicks Upload to CommCare HQ, picks their test domain, watches the tool report `import_app → success`, then `multimedia_state: complete`. Opens the resulting HQ app URL on web apps — the form renders the image alongside the question prompt and the module shows its icon on the home screen.

## Out of scope (named handoffs)

- **Generation foundation** — pluggable LLM image generation backend. Layers on top of `upload_media_asset` (generator implementations call the same validate+store path). Separate plan when prioritized.
- **Per-language media** — rides whatever plan migrates Nova's labels to a `LangMap` model. Single-language is the current floor across the whole authoring layer, not a multimedia-specific gap.
- **Orphan cleanup cron** — soft-delete is enough through this plan. Cleanup is a storage-cost optimization, not a correctness requirement.
- **`caseListForm` (registration-from-case-list) media** — requires Nova to add a domain-level `caseListForm` carrier first.
- **Android-only `lookup_image` callouts** — Nova targets web apps.
- **Print template HTML** — different rendering pipeline, separate concern.
- **Import / round-trip from existing CCHQ apps with media** — Nova creates apps fresh today.
- **`validate_msg` rename to a Nova-native term** — `validate_msg` is already established in the field schema; a rename is its own refactor with its own migration cost. Not blocked by this plan and not folded into it.
