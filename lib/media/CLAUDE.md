# lib/media — asset validation, attach/export verdicts, wire manifest

The trust layer between a user-uploaded asset and the wire. This package owns format validation, the attach- and export-time verdicts, the export budget, the wire manifest, and the deletion guard. It does NOT own the bytes (GCS, `lib/storage/media.ts`), the asset row (Postgres `media_assets`, `lib/db/mediaAssets.ts` + `MediaAssetDoc` in `lib/db/types.ts`), the domain primitives (`lib/domain/multimedia.ts` — `AssetKind` / `Media` / the MIME partitions / size caps / the export-ceiling constants / the GCS key derivations), or the wire emitters (`lib/commcare/multimedia/*`).

## Boundary

`manifest.ts` and `builtinIconAssets.ts` are two of the only consumers of the `@/lib/commcare` emission boundary outside the emitter itself (allowlisted in `biome.json`): they resolve assets to wire paths. The complete export composer, including media-row loading and the aggregate budget verdict, lives at `lib/export/boundaryValidation.ts`. Everything else here is boundary-free.

## The asset is the timeline; the attach is the last commit that can see it

An asset's state lives OUTSIDE the blueprint doc (bytes in GCS, a metadata row in Postgres), so a doc reference is a promise about something the doc can't observe. The whole design makes that promise safe to keep by making the asset's observable state **monotone after attach**, then checking it at the attach:

- **Two statuses, `ready` is terminal.** `pending` (row exists, bytes unvalidated) → `ready` (validated, sniffed `mimeType`/`extension`/`dimensions`/`durationMs` written). Nothing writes `status` after the flip. `failed` is NOT a state: a validation failure freshly locks and deletes the row only while it is still `pending` (plus the pending GCS object, guarded against shared-byte siblings); a concurrent `ready` winner is returned idempotently. A `pending` row a client never confirms is harmless — filtered from the library, rejected by the validator gate, and its GCS object reaped by the `pending/` lifecycle rule; the dangling row itself is never reaped (no row reaper today).
- **`project_id` is the tenant and the only tenancy gate.** An asset belongs to a **Project** (Better Auth organization) — the same tenancy axis apps + case rows use. A member with `view` may list/read/preview; upload, delete, and blueprint attachment changes require the Project's `edit` capability. The client file manager mirrors that boundary: viewers never see upload/delete/attach controls and do not start or retry document extraction. `project_id` is set authoritatively at upload (the app's Project for an app-context upload, else the uploader's active Project), NEVER self-asserted — so referencing a foreign asset's id can't grant access. Read/list/compile sites authorize `view`; upload/delete routes and app mutation paths authorize their matching write capability; and the manifest filters a doc's referenced ids to its Project. A non-member sees the same 404 as a missing row, and a foreign-Project ref reads as `MEDIA_ASSET_NOT_FOUND`. Bytes live at `projects/<project_id>/…` so a user-deletion can later purge personal-Project media without touching shared bytes.
- **`owner` and `kind` are immutable** — written once at `createPendingAsset`, never updated (confirm may refine `mimeType`/`extension` from the bytes, never these). `owner` is the uploader, recorded for provenance only — NOT an access gate (that's `project_id`) and NOT in the GCS path; `kind` keeps documents out of media slots.
- **`project_id` is immutable too — moving an app COPIES, never re-tenants.**
  `moveMedia.ts::copyAssetsIntoProject` get-or-creates a `ready` destination
  copy for every live authored Blueprint and canonical thread reference across
  all `AssetKind`s, then remaps every one in the destination app transaction.
  Documents copy only a published `ready` extract pair and preserve a newer
  destination extract state. Each copy takes source/destination
  extension-independent Project/hash locks in global order, re-reads and
  verifies the source bytes under those locks, and deduplicates publication
  against a verified destination sibling. A missing, foreign, unready, or
  wrong-kind live carrier fails the move. Event attachment UUIDs are audit-only
  and never participate. Source rows and bytes remain untouched, so sibling
  source apps are unaffected.
- **Deleting a referenced asset is refused** (the deletion guard, below).

So the four attach tools verify the asset **at the source** —
`attachVerdicts.ts::mediaAttachVerdict` checks that it exists in the app's
Project, is `ready`, matches the slot's `MediaKind`, and keeps the app inside the
export ceiling before the gated commit. Every authoritative app or thread
writer then derives the complete poststate projection from all authored
Blueprint references plus canonical thread attachments, locks every referenced
asset sorted `FOR SHARE`, verifies same Project, `ready`, and exact kind, and
deletes/reinserts that app's exact `media_asset_refs` rows in the SAME
transaction. Deletion takes the conflicting asset `FOR UPDATE`, so either the
writer commits and deletion's coherent re-walk sees the reference, or deletion
commits and the writer wakes to a missing row and rejects.

## Documents are library-only — enforced fail-closed in three places

`AssetKind` spans `MEDIA_KINDS` (`image`/`audio`/`video`, wire-attachable) and `DOCUMENT_KINDS` (`pdf`/`text`/`docx`/`xlsx`, inputs the user attaches to the SA chat, never to a CommCare carrier). The split is NOT compile-time — a slot's value is an opaque `MediaAssetId` (the brand doesn't encode kind) — so a document id is type-indistinguishable from a media id in a slot. Three independent runtime gates keep a document off the wire, none redundant: the attach verdict's kind check, the validator's `mediaKindMatches` rule (pre-compile), and `resolveMediaManifest`'s `isMediaKind` filter (pre-emit). The document extract lifecycle (`extracting`/`ready`/`failed`) and `EXTRACTOR_VERSION` live in `lib/domain/multimedia.ts`; the extraction machinery is `lib/agent/documentExtraction*`.

## Accepted formats are HQ-ingestion-bound, not arbitrary

`validate.ts::validateMediaBytes` is the format gate (extension allowlist → size cap → magic-bytes sniff via `file-type`, or UTF-8 validity for text → body re-parse via `sharp` / `music-metadata` → SHA-256 match). The accepted set is deliberately narrow and the audio restriction is load-bearing: **audio is `audio/mpeg` (`.mp3`) and `audio/wav` (`.wav`) ONLY.** `.m4a`/`.ogg` are rejected because CommCare HQ's media-upload endpoint validates the extension against Python's `mimetypes` table and its deployed image registers only CPython's hardcoded types — so accepting them would mint a dead affordance that 400s on every HQ upload (citation in `lib/domain/multimedia.ts`'s `AUDIO_MIME_TYPES`). SVG is excluded as an XSS script container.

## Upload: pending key, confirm re-validates from the bytes

Browser uploads can't be trusted to PUT what they claimed, so the signed-PUT URL lands at a per-attempt `pending/<project_id>/<assetId>` key (never the final content-hash key) and `confirm` re-derives everything from the stored bytes: it size-gates from GCS metadata BEFORE pulling bytes into memory (the signed URL stays valid, so a client could PUT an oversized object after the claim), runs the full validation pipeline, then writes that exact validated buffer to `gcsObjectKeyFor(projectId, hash, ext)` (`projects/<project_id>/<hash><ext>`). It never copies the still-mutable pending key after validation. The web upload + library routes resolve that Project from an optional `appId` (the app's Project) or the caller's active Project; `confirm` authorizes against the pending row's `project_id`, then freshly re-proves edit membership and locks the row for the terminal transition. A stale validation rejection deletes only a still-`pending` row; if publication or same-hash dedup won, it returns the authoritative `ready` row idempotently. When dedup replaces the attempt row with another canonical ready row, the same transaction writes a 24-hour attempt-id alias before deleting the pending row; a retry after response loss therefore resolves only that exact canonical result under fresh Project edit authority, never a coincidental later hash sibling. An initiate-time `(project, hash)` dedup probe short-circuits a re-upload of identical bytes; confirm rechecks under the canonical extension-independent Project/hash session advisory lock and holds it across byte publication plus committed `ready` metadata. MCP upload and Project-copy publication use the same lock. Each lock body runs metadata SQL on that same checked-out Postgres session, and the process admits at most two concurrent key-lock bodies against the current three-slot pool so unrelated request work keeps one connection. MCP has no untrusted PUT round trip, so after validating in memory it writes the final content key and publishes a caller-preallocated id as a complete `ready` row in ONE metadata transaction — never a separately committed pending row. An ambiguous insert result is reconciled after reacquiring the content lock: the Project/hash ready row is returned (distinguishing the exact attempt id from a later dedup winner), or the unclaimed object is removed after proving no row names its key. A hard process crash before metadata can leave only the deterministic content key; the next identical request safely overwrites that same key and publishes/adopts it, while a crash after commit dedups to the terminal row. Browser-confirm and extract publication failures similarly delete only after proving no authoritative row names the exact base key (or no ready row names the extract version). Post-commit cleanup rechecks sibling metadata, so a new ready row can never point at bytes a concurrent last-reference cleanup removed. The `pending/` prefix is top-level so ONE exact bucket policy reaps abandoned browser uploads while disabling soft delete, object versioning, and default event holds; a pre-existing retention policy fails the deploy instead of being removed. Apply the whole metageneration-fenced policy (idempotently) with `scripts/infra/apply-media-bucket-storage-policy.ts`.

## The export ceiling has one source; the client checks for UX, the boundary enforces

Media-ON compile / HQ upload load every referenced ready asset's bytes into memory at once, so an aggregate ceiling (`MAX_MEDIA_EXPORT_ASSETS` / `MAX_MEDIA_EXPORT_BYTES` in `lib/domain/multimedia.ts`) bounds the whole export before a byte is fetched. The math lives in ONE place — `exportBudget.ts` — consumed by the attach verdict, the browser pre-dispatch check (`components/builder/media/useAttachBudget.ts`), and the export boundary. The trust model: the client checks are an honest-user UX guarantee and fail OPEN on a fetch error (refusing over transient network is worse than letting the boundary enforce); the **boundary is the enforcement authority** — a bypassing client changes nothing, the export still refuses.

## The export boundary — zero tolerance, every entry point

`lib/export/boundaryValidation.ts::prepareExportBoundary` runs at EVERY media-ON export entry (`.ccz` compile, HQ upload, JSON export) before the emitter. It first loads one exact rows-free lookup snapshot, including for an empty target set, then walks the doc's asset refs, loads the rows (ready AND pending, so a still-uploading ref surfaces "not ready" rather than "not found"), runs the complete validator with the supplied lookup context and media group (`mediaAssetExists` / `mediaAssetReady` / `mediaKindMatches`), and appends the aggregate budget error. ANY finding rejects with actionable prose. Only a clean result proceeds to `manifest.ts::resolveMediaManifest`, which resolves refs → wire paths and streams bytes under bounded concurrency; it filters to `ready` + media-kind, so a media-free app does zero I/O.

## Built-in library icons — one shared copy, no asset row

A module/form/case-list menu tile can carry a curated **built-in icon** instead of an upload. Uploaded rows use a strict UUID-branded `MediaAssetId`; a built-in uses the separate, catalog-closed `BuiltinIconRef` (`nova-icon:<slug>`, helpers and schemas in `lib/domain/builtinIcons.ts`). Only the three menu-icon carriers union those identity families, and the module/case-list and form catalogs remain separately closed. App logos, audio labels, field/option media, image-map cells, chat attachments, API routes, storage metadata, and reverse indexes accept uploaded UUIDs only. An unknown or merely prefixed string is invalid, not a stale built-in identity. Every app points at one shared copy of the built-in bytes, shipped at `public/nova-icons/<slug>.png` (crunched 512² PNGs, regenerated from the 1024² masters by `scripts/build-builtin-icons.ts`): no per-user asset, database row, or GCS object.

Built-in awareness is **quarantined to `lib/media/builtinIconAssets.ts`** (the partition + synthesis) plus three other seams; the validator, the wire emitters, and the export budget stay built-in-agnostic and consume synthesized rows:

- **Manifest** (`manifest.ts`) — `partitionAssetRefs` splits validated icon refs into uploaded ids (the asset-row load runs on those only) and built-in refs; `resolveBuiltinManifestEntries` synthesizes a `ResolvedMediaAsset` per catalog entry, with a **content-hash** wire path (so HQ bulk-upload path-matching + cross-app dedup work identically to an upload) and bytes read from `public/nova-icons/` only when `withBytes`.
- **Boundary** (`boundaryValidation.ts`) — same partition; `builtinAssetRows` synthesizes `ready`/`image` rows into the map so the validator's media group passes and the budget counts them (distinct slugs, deduped). Genesis change-set diagnostics and the sequence-one materialization transaction use that same synthesis for their export-readiness proof. The reference-count cap is `realIds + distinct builtin slugs`.
- **Reverse index** — built-in refs are filtered out because they have no asset
  row and are undeletable. `media_asset_refs(project_id, app_id, asset_id)` is
  the exact whole-app projection of every authored Blueprint reference,
  including hidden or inactive case-list/icon/audio/image-map definitions, plus
  strict canonical `threads.messages[*].metadata.attachments[*]`. Every app and
  thread writer replaces that complete projection transactionally.
- **Client** (`components/builder/media/mediaClient.ts::mediaSrc`) routes a closed built-in ref to its static `/nova-icons/<slug>.png` (not `/api/media`). The picker returns a discriminated uploaded-row or built-in-ref result, so built-ins never impersonate `WireMediaAsset`; `useAttachBudget.ts` receives uploaded candidates only and drops existing built-ins from its gap-fetch.

The commit gate needs no manifest awareness — it skips the row-backed media rules (`gate.ts::evaluateCommit`), while the domain schemas still reject a built-in outside its exact icon carrier. The runtime `fs` read of `public/` is invisible to the standalone tracer, so `next.config.ts`'s `outputFileTracingIncludes` ships `public/nova-icons/**` with the emit routes (the browser's static handler needs nothing). The SA sets a built-in via a `set_menu_media` item's exact catalog slug; `resolveIconInput` turns that slug into the closed ref with no row expectation. The only other accepted non-null input is a canonical uploaded-media UUID, which follows the ordinary attach verdict. Reads project built-ins back to their catalog slug and never expose the internal prefixed ref as an authoring address.

## Media-OFF / ON emit contract — artifacts emit only where bytes ship

The manifest threads through the emitter as `opts.assets`; the wire media artifacts emit ONLY on the paths that also ship the bytes:

- **`.ccz` compile** (`lib/commcare/compiler.ts` + `lib/commcare/multimedia/bundle.ts`) — assets bundled into the archive at their wire paths, described by a `media_suite.xml`.
- **HQ upload** — the app imports media-ON, then every referenced file ships as ONE bulk `multimedia.zip` to HQ's `upload_multimedia_api`, which path-matches each entry to the app's `jr://file/commcare/...` references. HQ's match set (`ApplicationMediaMixin.all_media`) deliberately EXCLUDES app-level logos, so a logo image used ONLY as the logo is ALWAYS reported `unmatched` — this is expected, not a failure. `uploadOutcome.ts::reportMediaAttach` (the shared entry both the chat route and the MCP tool call) reconciles HQ's `unmatched_files` against the doc's references (via `manifest.ts::assetWirePaths`) and emits the log decision: a logo-only file becomes a gentle heads-up logged at `warn` (never Sentry), everything else a genuine per-carrier failure logged at `error`. The "app-level media doesn't ride the bulk upload" rule lives in ONE predicate, `lib/domain/mediaRefs.ts::carriesViaBulkUpload`, read by both the reconciliation and its proactive twin `uncarriedLogoAsset` (the app-settings warning, before any upload).
- **JSON export** (`/api/compile/json`, MCP `compile_app` json) — a media-ON bundle (app JSON + the same bulk zip) when the app has media; the plain media-OFF JSON otherwise.

itext `<value form="image|audio|video">` (image→audio→video order, after the text + markdown values), `multimedia_map`, and the logo profile property emit the same way. **An app with NO media emits output byte-identical to the pre-media output** — empty manifest means the media-on code paths never run, `multimedia_map: {}`, no `media_suite.xml`, no media itext values. The validator returns zero findings for a media-free doc, so this is structural, not a special case.

## Clearing a media slot uses a dedicated mutation kind

Media slots clear through their own `null`-carrying mutation kinds (`setFieldMedia` / `setModuleMedia` / `setFormMedia` / `setAppLogo`), never an `{ key: undefined }` patch — `JSON.stringify` drops `undefined` on the SSE wire, so a generic patch-clear would no-op and the stale ref would auto-save back. The reducer maps the on-wire `null` to `undefined` internally. Full rationale in `lib/doc/CLAUDE.md`.

## Deletion guard — authoritative transaction, then serialized object cleanup

Both the SA `removeMediaAsset` tool and `DELETE /api/media/[assetId]` end
at `lib/db/mediaDeletion.ts`: one transaction takes the shared membership gate,
freshly proves Project `edit`, locks the asset `FOR UPDATE`, queries its exact
composite reverse-edge candidates, and coherently re-walks each candidate's
authored Blueprint plus canonical thread attachments. Metadata is deleted only
when that re-walk is empty. There is no app lock, whole-Project fallback scan,
completion marker, or post-commit synchronization path. The atomic Project move
copies and remaps every live Blueprint/thread reference in the same projection;
immutable event attachment UUIDs remain audit receipts and are never
dereferenced, remapped, copied, indexed, or deletion blockers. The SA's in-hand
walk remains an actionable preflight only and never authorizes deletion; chat
additionally holds its app/holder fence around the same core, so takeover/scope
loss deletes nothing. `purgeAssetStorage` receives the locked deleted row,
commits metadata first, then takes the extension-independent canonical
Project/hash session lock, rechecks the exact base-object key and the extract's
`(Project, hash, version)` references separately, and removes each object only
when unshared.

Document extraction permissions follow the side effect: preview/status `GET` needs Project view, while extraction `POST` spends model cost and writes status/extract data, so it requires Project edit. A claim's `(version, model, extractedAt)` is a fencing token, and an older server cannot claim over any higher-version state. After model work, terminal publication takes the asset's canonical extension-independent Project/hash content lock, re-locks the row, and writes GCS only if that exact `extracting` claim still owns the slot. A committed ready Project/hash/version sibling wins: extraction and Project-copy adopt its exact metadata/object, while a first publisher advances every non-newer duplicate row to the same metadata in its transaction. Deletion cleanup takes the same content lock. Thus delete-first never recreates an orphan extract, publication-first exposes a matching object/metadata pair before delete can clean it, a copied equal/newer ready result supersedes the stale model job safely, and identical `.txt`/`.md` bytes cannot split one shared object from per-row metadata. If GCS succeeds but the metadata transaction rejects, cleanup under the still-held content lock deletes the unpublished extract unless a committed deduplicated sibling already names that Project/hash/version.
