# lib/media — asset validation, attach/export verdicts, wire manifest

The trust layer between a user-uploaded asset and the wire. This package owns format validation, the attach- and export-time verdicts, the export budget, the wire manifest, and the deletion guard. It does NOT own the bytes (GCS, `lib/storage/media.ts`), the asset row (Firestore, `lib/db/mediaAssets.ts` + the `mediaAssetDocSchema` in `lib/db/types.ts`), the domain primitives (`lib/domain/multimedia.ts` — `AssetKind` / `Media` / the MIME partitions / size caps / the export-ceiling constants / the GCS key derivations), or the wire emitters (`lib/commcare/multimedia/*`).

## Boundary

`manifest.ts` and `boundaryValidation.ts` are two of the only consumers of the `@/lib/commcare` emission boundary outside the emitter itself (allowlisted in `biome.json`): they resolve assets to wire paths and run the export-boundary validation. Everything else here is boundary-free.

## The asset is the timeline; the attach is the last commit that can see it

An asset's state lives OUTSIDE the blueprint doc (bytes in GCS, a status row in Firestore), so a doc reference is a promise about something the doc can't observe. The whole design makes that promise safe to keep by making the asset's observable state **monotone after attach**, then checking it at the attach:

- **Two statuses, `ready` is terminal.** `pending` (row exists, bytes unvalidated) → `ready` (validated, sniffed `mimeType`/`extension`/`dimensions`/`durationMs` written). Nothing writes `status` after the flip. `failed` is NOT a state: a validation failure DELETES the row (and the pending GCS object, guarded against shared-byte siblings). A `pending` row a client never confirms is harmless — filtered from the library, rejected by the validator gate, and its GCS object reaped by the `pending/` lifecycle rule; the dangling row itself is never reaped (no row reaper today).
- **`owner` and `kind` are immutable** — written once at `createPendingAsset`, never updated (confirm may refine `mimeType`/`extension` from the bytes, never these). The verdict reads `owner` to gate foreign-asset probing (a guessed id can't reveal another user's asset exists) and `kind` to keep documents out of media slots.
- **Deleting a referenced asset is refused** (the deletion guard, below).

So the five attach tools verify the asset **at the source** — `attachVerdicts.ts::mediaAttachVerdict` (via `tools/media/shared.ts::attachGuardedMutate`) checks: exists in the caller's library, `ready`, `kind` matches the slot's `MediaKind`, and the app's referenced-ready-media aggregate stays inside the export ceiling — before the gated commit, persisting nothing on failure. Because the asset can't go bad afterward, attach-time checking is sufficient; the verdict module's header carries these citations. Clears carry no expectations and skip the asset read. On MCP the per-asset judgment re-runs INSIDE the transactional commit (asset rows join the read set), so a delete racing the attach serializes against it.

## Documents are library-only — enforced fail-closed in three places

`AssetKind` spans `MEDIA_KINDS` (`image`/`audio`/`video`, wire-attachable) and `DOCUMENT_KINDS` (`pdf`/`text`/`docx`/`xlsx`, inputs the user attaches to the SA chat, never to a CommCare carrier). The split is NOT compile-time — a slot's value is an opaque `AssetId` (the brand doesn't encode kind) — so a document id is type-indistinguishable from a media id in a slot. Three independent runtime gates keep a document off the wire, none redundant: the attach verdict's kind check, the validator's `mediaKindMatches` rule (pre-compile), and `resolveMediaManifest`'s `isMediaKind` filter (pre-emit). The document extract lifecycle (`extracting`/`ready`/`failed`) and `EXTRACTOR_VERSION` live in `lib/domain/multimedia.ts`; the extraction machinery is `lib/agent/documentExtraction*`.

## Accepted formats are HQ-ingestion-bound, not arbitrary

`validate.ts::validateMediaBytes` is the format gate (extension allowlist → size cap → magic-bytes sniff via `file-type`, or UTF-8 validity for text → body re-parse via `sharp` / `music-metadata` → SHA-256 match). The accepted set is deliberately narrow and the audio restriction is load-bearing: **audio is `audio/mpeg` (`.mp3`) and `audio/wav` (`.wav`) ONLY.** `.m4a`/`.ogg` are rejected because CommCare HQ's media-upload endpoint validates the extension against Python's `mimetypes` table and its deployed image registers only CPython's hardcoded types — so accepting them would mint a dead affordance that 400s on every HQ upload (citation in `lib/domain/multimedia.ts`'s `AUDIO_MIME_TYPES`). SVG is excluded as an XSS script container.

## Upload: pending key, confirm re-validates from the bytes

Browser uploads can't be trusted to PUT what they claimed, so the signed-PUT URL lands at a per-attempt `pending/<owner>/<assetId>` key (never the final content-hash key) and `confirm` re-derives everything from the stored bytes: it size-gates from GCS metadata BEFORE pulling bytes into memory (the signed URL stays valid, so a client could PUT an oversized object after the claim), runs the full validation pipeline, then promotes clean bytes to `gcsObjectKeyFor(owner, hash, ext)`. An initiate-time `(owner, hash)` dedup probe short-circuits a re-upload of identical bytes; a confirm-time sibling check collapses dedup races. The MCP `upload_media_asset` tool (`lib/mcp/tools/uploadMediaAsset.ts`) is the bytes-inline path for clients that can't run that dance — it shares `validateMediaBytes` but skips the transit-hash check (bytes never leave server memory) and writes straight to the final key. The `pending/` prefix is top-level so ONE bucket lifecycle rule reaps abandoned uploads; apply it (idempotently) with `scripts/infra/apply-media-bucket-lifecycle.ts`.

## The export ceiling has one source; the client checks for UX, the boundary enforces

Media-ON compile / HQ upload load every referenced ready asset's bytes into memory at once, so an aggregate ceiling (`MAX_MEDIA_EXPORT_ASSETS` / `MAX_MEDIA_EXPORT_BYTES` in `lib/domain/multimedia.ts`) bounds the whole export before a byte is fetched. The math lives in ONE place — `exportBudget.ts` — consumed by the attach verdict, the browser pre-dispatch check (`components/builder/media/useAttachBudget.ts`), and the export boundary. The trust model: the client checks are an honest-user UX guarantee and fail OPEN on a fetch error (refusing over transient network is worse than letting the boundary enforce); the **boundary is the enforcement authority** — a bypassing client changes nothing, the export still refuses.

## The export boundary — zero tolerance, every entry point

`boundaryValidation.ts::collectBoundaryViolations` runs at EVERY media-ON export entry (`.ccz` compile, HQ upload, JSON export) before the emitter: it walks the doc's asset refs, loads the rows (ready AND pending, so a still-uploading ref surfaces "not ready" rather than "not found"), runs the validator's media group (`mediaAssetExists` / `mediaAssetReady` / `mediaKindMatches`), and appends the aggregate budget error. ANY finding rejects with actionable prose. This is defense-in-depth — legacy refs committed before the attach verdict existed, plus ops disasters (a hand-deleted row, a reaped object) — the same standing role the rest of the boundary plays. `manifest.ts::resolveMediaManifest` then resolves refs → wire paths and streams bytes under bounded concurrency; it filters to `ready` + media-kind, so a media-free app does zero I/O.

## Media-OFF / ON emit contract — artifacts emit only where bytes ship

The manifest threads through the emitter as `opts.assets`; the wire media artifacts emit ONLY on the paths that also ship the bytes:

- **`.ccz` compile** (`lib/commcare/compiler.ts` + `lib/commcare/multimedia/bundle.ts`) — assets bundled into the archive at their wire paths, described by a `media_suite.xml`.
- **HQ upload** — the app imports media-ON, then every referenced file ships as ONE bulk `multimedia.zip` to HQ's `upload_multimedia_api`, which path-matches each entry to the app's `jr://file/commcare/...` references.
- **JSON export** (`/api/compile/json`, MCP `compile_app` json) — a media-ON bundle (app JSON + the same bulk zip) when the app has media; the plain media-OFF JSON otherwise.

itext `<value form="image|audio|video">` (image→audio→video order, after the text + markdown values), `multimedia_map`, and the logo profile property emit the same way. **An app with NO media emits output byte-identical to the pre-media output** — empty manifest means the media-on code paths never run, `multimedia_map: {}`, no `media_suite.xml`, no media itext values. The validator returns zero findings for a media-free doc, so this is structural, not a special case.

## Clearing a media slot uses a dedicated mutation kind

Media slots clear through their own `null`-carrying mutation kinds (`setFieldMedia` / `setModuleMedia` / `setFormMedia` / `setAppLogo`), never an `{ key: undefined }` patch — `JSON.stringify` drops `undefined` on the SSE wire, so a generic patch-clear would no-op and the stale ref would auto-save back. The reducer maps the on-wire `null` to `undefined` internally. Full rationale in `lib/doc/CLAUDE.md`.

## Deletion guard — reverse index, then a re-walk

`assetDeletion.ts::findAppReferencesToAsset` refuses to delete a still-referenced asset, shared by the SA `removeMediaAsset` tool and the `DELETE /api/media/[assetId]` route (the tool adds the in-hand working-doc check the route can't see). It reads the asset's `referencingAppIds` reverse index (append-only, maintained by the blueprint writers) and re-walks ONLY those 0–2 candidate apps to confirm a live reference and name the carrier in authoring vocabulary (`describeCarrier` — never wire tokens); an un-backfilled row falls back to a full owner-wide scan. On allow, `purgeAssetStorage` deletes the row, then the GCS object only if no sibling row shares the key, plus the document-extract sibling. This turned the guard from ~8s on a large account to ~0ms for an unreferenced asset.
