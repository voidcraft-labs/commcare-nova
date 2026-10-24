# Step 4, part 04: Media by platform

Part of [step 4's plan](../4-platforms.md), which holds the baseline, the decisions, the stack and
the exit. This part fixes the second half of defect 11: from step 4 a media file goes into an app
only where every platform the app declares plays it, and HQ types it as its kind and can store
it. It fixes the variant registry, the readers that tell one variant from another, the asset
row's `media_format` column, acceptance at each reference (the commit kernel, the attach
verdicts, the export boundary, the builder and the declaration change), Preview's playback of a
file only Android plays, the corpus's media stand-ins, and the runs that record where each new
variant plays. It lands in pull request 7, with the public docs in pull request 14; the migration
that validates its presence constraint after the backfill is the cutover's (part 09 §8, pull
request 13).

The declaration itself (`appSettings.runsOnlyOn`, `lib/domain/platforms.ts::declaredPlatforms`,
`Platform`, `PLATFORM_LABELS`) is pull request 4's (part 01); this part reads it and never compares
the stored value. Part 07 owns the builder's screens and the agent tools: it places the pickers'
reasons, the file manager's line, the platform section's server-side preflight and `updateApp`'s
media pre-check, from the functions and copy this part defines (§6.4, §6.5). Part 02 owns the text
of every manifest edit this part's work makes (§7). The cutover (part 09, pull request 13) owns the
backfill Job, the transform, the notice and the migration ledger; §9 is what it takes from this
part.

Citations are `path::symbol` for Nova at `main` `e9e6cd93`, and `path::symbol` for CommCare at the
pins `proof/pins.json` names: commcare-hq `d6c6e16d8ae1` (paths under `corehq/apps` unless named),
commcare-android `7a5584475580`, commcare-core `8e9ba8d908e9`, formplayer `24383ac71bfb`, Vellum
`01215f251c57`, commcare-connect `046c7fd78081`. Every CommCare fact was read at the pin. A
platform's playback of a format is the vendor documentation `lib/commcare/surface/media-formats.json`
names for its item, unless that item carries an `executed` record; this part says which. Pull
requests are the stack's fifteen, by number (the plan, "The stack").

## Decisions in brief

1. **The variant is a fact of the bytes; acceptance is a fact of the app.** Each validated media
   asset stores one variant key (`media_assets.media_format`), written once when the bytes are
   validated and never changed, like `kind`. Whether a reference to it is accepted is decided per
   reference, against the referencing app's declared platforms, because an asset is the Project's
   and two apps of one Project may declare different platforms (`lib/media/CLAUDE.md`,
   "`project_id` is the tenant"). A stored verdict would freeze a reading of the documentation
   into rows, and a variant copied into the document would have to be proved equal to the row
   anyway.
2. **One variant registry, beneath `ACCEPTED_FORMATS`.** `lib/domain/multimedia.ts::MEDIA_FORMATS`
   lists 24 variants (§2), each with its key, canonical MIME, kind, label, the one
   `media-formats.json` item it is, and the platforms it plays on. `manifest.test.ts` holds each
   variant's platforms equal to its item's readings (§7.3). `ACCEPTED_FORMATS` keeps one entry
   per canonical MIME and loses `surfaceKeys`; six MIMEs join it (ICO, AVIF, AAC, AMR, MIDI, MKV).
3. **Upload accepts the union.** A file is stored when its variant plays on at least one
   platform, HQ types its bytes as its kind, and HQ can store it. Upload stays app-free: the MCP
   tool has no app, and the library is the Project's, so refusing a file one app cannot use would
   hide it from another app of the Project that can.
4. **New readers tell the variants apart** (§3): `lib/media/mp4.ts` (an ISO box walk: one video
   track of H.264 Baseline, Main or High, HEVC Main, or MPEG-4 Part 2 Simple, with AAC audio or
   none), `lib/media/wav.ts` (the `fmt ` chunk: 8- or 16-bit integer PCM), `lib/media/ico.ts`,
   AVIF through sharp, ADTS AAC through music-metadata's MPEG parser, AMR and MIDI by their
   headers, and MKV through `webm.ts`'s rules. `music-metadata` 12.2.0 names an MP4 track's sample
   entry only and has no AMR or MIDI parser, so Nova reads these itself, as step 2 did for BMP and
   VP9.
5. **SVG is refused for every app.** The research held SVG for an app that does not declare
   Android; HQ cannot store it (§4). It gets its own refusal sentence.
6. **Acceptance per reference has one rule and five places** (§6): the commit kernel's media
   admission (authoritative on every editor), the attach verdicts (SA and MCP), the export
   boundary rule `MEDIA_FORMAT_NOT_PLAYED`, the builder's attach guard and pickers, and the
   declaration-change preflight (part 07's server action and `updateApp`'s pre-check). All read
   `lib/media/platformPlayback.ts`.
7. **A refusal names every carrier.** The kernel's refusal lists each reference, the file's
   format and the platform that cannot play it, so the person sees the whole list from chat, MCP
   and the builder alike.
8. **Legacy bytes no variant admits are kept as `unplayable`.** Step 3's upload checked no MP4
   codec and no WAV encoding, so stored rows may hold, for one, a 24-bit WAV. The backfill stores
   `unplayable` for them; they stay in the library, playing nowhere, and no app references them
   after the cutover (§9). Production holds no audio or video row (the content-free scan of
   planning, §9), so there the rule meets nothing; it stands for every database that holds such
   rows, a local one or one whose files arrive before the window.
9. **Preview shows a stand-in where the browser cannot play a file.** Preview runs in the
   browser, so it plays what Web Apps plays; an audio or video variant only Android plays shows one
   line in its place (§6.6).
10. **H.264 High plays on both platforms, by a run.** Android 6.0 guarantees only Baseline and
    Main, so the documentation alone would have left High to Web Apps. The person ran Android's
    decode probe on their Mac during planning, and the three emulator images that are the
    `android-decode` record's readers each decoded the corpus's High video,
    `lib/media/__tests__/fixtures/tiny-video.mp4`, to the end of its stream (§8.5). So
    `media-format:video/mp4-h264-high` reads `runs` on Android with `executed: "android-decode"`,
    `mp4-h264-high` plays on both, the corpus video stays as it is (no document's bytes move,
    §8.1), and the cutover removes no High reference. Reason: a phone camera commonly records High,
    and the one run made decoded it on CommCare's floor and on two later releases; the note on
    the item keeps the documented guarantee in view.
11. **Executions.** The browser playback spec runs every variant Web Apps plays in CI; the
    native `media` family runs HQ's real bulk upload over three new scenarios; the Android decode
    probe is extended for the new variants, whose Android readings stay documentation unless the
    person asks for a run on their Mac; its planning run settled H.264 High (§8).
12. **The presence constraint is pull request 7's, validated in the window.** Pull request 7's
    migration `20261101020000_hq_round_trip_platforms_media_format` adds the column, its value
    domain (valid at once) and the check that every ready media row carries a format,
    `media_assets_ready_media_format`, `NOT VALID`; pull request 13's
    `20261101030000_hq_round_trip_platforms_media_format_validated` validates it after the
    backfill. The cutover applies both inside its fleet transaction (part 09 §8), so the check never
    commits while the old revision, which writes ready rows without a format, serves (§5.2).

---

## 1. What Nova does today

### 1.1 Upload

Both entry points run `lib/media/validate.ts::validateMediaBytes`: the browser's confirm
(`app/api/media/upload/[assetId]/confirm/route.ts`, which then calls
`lib/db/mediaAssets.ts::publishPendingAssetForActor`) and the MCP tool
(`lib/mcp/tools/uploadMediaAsset.ts`, which calls `insertReadyAssetInTransaction`). The pipeline:
the extension allow-list (`ACCEPTED_EXTENSIONS`), the claimed size and the per-kind cap, the
`file-type` 22.1.1 sniff normalized through `normalizeMimeType`, the claim and extension-family
checks, the body checks dispatched on the sniffed MIME, and SHA-256.

The body checks (`validate.ts::encodingRefusal`, `::webmRefusal`, `bmp.ts::readBmp`,
`webm.ts::readVp9Profile`) hold BMP to two headers, M4A to its brand, one track and AAC, FLAC to
its container, Ogg to Vorbis or Opus, and WebM to one VP8 or VP9 profile 0 video track with
Vorbis, Opus or no audio. **MP3, WAV and MP4 carry no check** (`encodingRefusal`'s `default`):
Nova stores an MP4 of any codec (HEVC, AV1, H.264 High 10, MPEG-4 Part 2, audio only) and a WAV
of any encoding. `lib/domain/multimedia.ts` says so on the two registry entries.

### 1.2 The row

`media_assets` (`lib/case-store/migrations/20260708000000_app_state.ts`; `lib/db/pg.ts::MediaAssetsTable`;
`lib/db/types.ts::MediaAssetDoc`) stores `mime_type`, `extension`, `kind`, `dimensions`,
`duration_ms` and `status`, and no codec, profile, encoding or variant. `WireMediaAsset`
(`lib/db/mediaAssets.ts::toWireMediaAsset`) mirrors it.

### 1.3 Acceptance

- **Attach** (SA and MCP: `attach_field_media`, `attach_option_media`, `set_menu_media`,
  `set_app_logo`): `lib/agent/tools/media/shared.ts` runs `lib/media/attachVerdicts.ts::mediaAttachVerdict`
  before the gated commit: the asset is in the app's Project, `ready`, of the slot's kind, and the
  app stays inside the export ceiling.
- **Every commit, every editor**: `lib/db/canonicalCommitKernel.ts::admitExactMediaReferences` →
  `::replaceExactMediaReferencesForApp` → `::blueprintMediaRequirements(doc)` (every
  `walkAuthoredAssetRefs` reference but built-in icons, as `{ assetId, expectedKind }`) →
  `lib/db/mediaAssets.ts::lockAndValidateMediaReferences`, which locks the rows `FOR SHARE` in id
  order and throws `MediaReferenceProjectionError` (reasons `missing`, `wrong-project`,
  `not-ready`, `wrong-kind`, `invalid-projection`) at the first failing requirement. The kernel
  maps it to one sentence: "A media file used by this app is unavailable, outside this Project,
  not ready, or the wrong kind for its authored slot. Choose it again and retry." Its callers are
  the kernel's commit, `lib/db/appGenesis.ts` and `lib/db/apps.ts`'s synthetic batch; the Project
  move (`lib/db/apps.ts`) calls `lockAndValidateMediaReferences` over destination rows and maps any
  failure to `media_stale`. Thread attachments use the same lock function with no slot
  (`replaceExactThreadMediaReferences`).
- **Export**: `lib/export/boundaryValidation.ts::prepareExportBoundary` loads every referenced
  row and runs the validator's `MEDIA_ASSET_RULES` (`mediaAssetExists`, `mediaAssetReady`,
  `mediaKindMatches`, over `walkAssetRefs`), all class `environment`.
- **The builder**: the pickers filter by kind (`components/builder/media/MediaPickerDialog.tsx`,
  `kinds`); `unavailableReason(mimeType)` exists for the chat composer's BMP; the pre-dispatch
  budget check is `components/builder/media/useAttachBudget.ts::useAttachBudgetGuard`.
- **The runtime probe** (`lib/db/runtimeDatabaseProbe.ts::auditRuntimeMediaReferenceProjection`,
  run by every deploy's migration Job through `scripts/migrate.ts`) re-checks Project, `ready` and
  kind for every authored and thread reference.

### 1.4 What CommCare does with a file

- **HQ types each file by its bytes and must store it.** `hqmedia/models.py::CommCareMultimedia.get_mime_type`
  reads libmagic and falls back to the filename only for an `application/*` result;
  `::get_class_by_data` maps `image`, `audio` and `video` to `CommCareImage`, `CommCareAudio`,
  `CommCareVideo`. `hqmedia/tasks.py::process_bulk_upload_zip` matches each file only to the
  paths of its class. `CommCareImage.attach_data` opens every image with Pillow
  (`CommCareImage.get_image_object` → `Image.open`, `BadMediaFileException` on failure) and reads
  its size and format; that call has no `try` of its own inside the loop, so the outer
  `except Exception` marks the whole status "Error while processing zip", the loop stops, and the
  `app.save()` that keeps every mapping made so far is skipped. `CommCareAudio` and `CommCareVideo`
  decode nothing.
- **Web Apps plays what the browser plays.** Its form media are a plain `<img>`, `<audio
  controls>` and `<video controls>`
  (`cloudcare/templates/cloudcare/partials/form_entry/multimedia.html`).
- **Android plays what the platform's own players play.** `commcare-android/app/build.gradle`
  `minSdkVersion 23`; audio through `android.media.MediaPlayer`
  (`app/src/org/commcare/views/media/AudioController.java`), video through `VideoView`
  (`app/src/org/commcare/views/media/CommCareVideoView.java`), images through `BitmapFactory`
  (`app/src/org/commcare/utils/MediaUtil.java`).

`lib/commcare/surface/media-formats.json` holds, per format item, each platform's reading
(`runs`, `unavailable` or `not-assessed`), the class HQ gives it (executed for every item in the
proof image, `hqClassification`), and `executed` records for the seven items step 2 ran
(`android-decode`, `browser-playback`). Only tests read it; the runtime registry is
`ACCEPTED_FORMATS`, because `lib/domain` may not import `lib/commcare`.

---

## 2. The variant registry

### 2.1 `MEDIA_FORMATS`

From step 4 `lib/domain/multimedia.ts` holds:

```ts
export const MEDIA_FORMAT_KEYS = [
	"png", "jpeg", "gif", "webp", "bmp", "ico", "avif",
	"mp3", "wav-pcm", "m4a", "flac", "ogg-vorbis", "ogg-opus", "aac-adts", "amr", "midi",
	"mp4-h264-baseline", "mp4-h264-main", "mp4-h264-high", "mp4-hevc", "mp4-mpeg4-part2",
	"webm-vp8", "webm-vp9", "mkv",
] as const;
export type MediaFormatKey = (typeof MEDIA_FORMAT_KEYS)[number];

/** What a stored media row holds: a variant, or bytes no variant admits. */
export const UNPLAYABLE_MEDIA_FORMAT = "unplayable";
export type MediaFormatValue = MediaFormatKey | typeof UNPLAYABLE_MEDIA_FORMAT;
export const mediaFormatValueSchema = z.enum([...MEDIA_FORMAT_KEYS, UNPLAYABLE_MEDIA_FORMAT]);

export interface MediaFormat {
	readonly key: MediaFormatKey;
	/** The canonical MIME of its `ACCEPTED_FORMATS` entry. */
	readonly mime: AssetMimeType;
	readonly kind: MediaKind;
	/** The format as a person reads it: "MP4 (HEVC)". */
	readonly label: string;
	/** The one `lib/commcare/surface/media-formats.json` item it is. */
	readonly surfaceKey: string;
	/** The platforms that play it, in `PLATFORMS` order; never empty. */
	readonly playsOn: readonly Platform[];
}
export const MEDIA_FORMATS: readonly MediaFormat[]; // the table below, in key order
export function mediaFormatOf(key: MediaFormatKey): MediaFormat;
/** The platforms a stored value plays on: `[]` for `unplayable`. */
export function mediaFormatPlaysOn(value: MediaFormatValue): readonly Platform[];
/** The label of a stored value; for `unplayable`, the label of the row's MIME. */
export function mediaFormatLabel(value: MediaFormatValue, mimeType: AssetMimeType): string;
```

`Platform` is `lib/domain/platforms.ts`'s (`"web-apps" | "android"`, pull request 4).

| Key | MIME | Kind | Label | `media-formats.json` item | Plays on | Reader |
|---|---|---|---|---|---|---|
| `png` | `image/png` | image | PNG | `media-format:image/png` | Web Apps, Android | sharp |
| `jpeg` | `image/jpeg` | image | JPEG | `media-format:image/jpeg` | Web Apps, Android | sharp |
| `gif` | `image/gif` | image | GIF | `media-format:image/gif` | Web Apps, Android | sharp |
| `webp` | `image/webp` | image | WebP | `media-format:image/webp` | Web Apps, Android | sharp |
| `bmp` | `image/bmp` | image | BMP | `media-format:image/bmp` | Web Apps, Android | `bmp.ts` |
| `ico` | `image/vnd.microsoft.icon` | image | ICO | `media-format:image/ico` | Web Apps | `ico.ts` (new) |
| `avif` | `image/avif` | image | AVIF | `media-format:image/avif` | Web Apps | sharp |
| `mp3` | `audio/mpeg` | audio | MP3 | `media-format:audio/mp3` | Web Apps, Android | music-metadata |
| `wav-pcm` | `audio/wav` | audio | WAV | `media-format:audio/wav-pcm-8-or-16-bit` | Web Apps, Android | `wav.ts` (new) |
| `m4a` | `audio/mp4` | audio | M4A | `media-format:audio/m4a` | Web Apps, Android | music-metadata, brand |
| `flac` | `audio/flac` | audio | FLAC | `media-format:audio/flac` | Web Apps, Android | music-metadata |
| `ogg-vorbis` | `audio/ogg` | audio | Ogg (Vorbis) | `media-format:audio/ogg-vorbis` | Web Apps, Android | music-metadata |
| `ogg-opus` | `audio/ogg` | audio | Ogg (Opus) | `media-format:audio/ogg-opus` | Web Apps, Android | music-metadata |
| `aac-adts` | `audio/aac` | audio | AAC | `media-format:audio/aac-adts` | Android | music-metadata, MPEG parser |
| `amr` | `audio/amr` | audio | AMR | `media-format:audio/amr` | Android | header (new) |
| `midi` | `audio/midi` | audio | MIDI | `media-format:audio/midi` | Android | header (new) |
| `mp4-h264-baseline` | `video/mp4` | video | MP4 (H.264 Baseline) | `media-format:video/mp4-h264-baseline` | Web Apps, Android | `mp4.ts` (new) |
| `mp4-h264-main` | `video/mp4` | video | MP4 (H.264 Main) | `media-format:video/mp4-h264-main` | Web Apps, Android | `mp4.ts` |
| `mp4-h264-high` | `video/mp4` | video | MP4 (H.264 High) | `media-format:video/mp4-h264-high` | Web Apps, Android | `mp4.ts` |
| `mp4-hevc` | `video/mp4` | video | MP4 (HEVC) | `media-format:video/mp4-hevc` | Android | `mp4.ts` |
| `mp4-mpeg4-part2` | `video/mp4` | video | MP4 (MPEG-4 Part 2) | `media-format:video/mp4-mpeg4-part2` | Android | `mp4.ts` |
| `webm-vp8` | `video/webm` | video | WebM (VP8) | `media-format:video/webm-vp8` | Web Apps, Android | `webm.ts` |
| `webm-vp9` | `video/webm` | video | WebM (VP9) | `media-format:video/webm-vp9` | Web Apps, Android | `webm.ts` |
| `mkv` | `video/x-matroska` | video | MKV | `media-format:video/mkv` | Android | `webm.ts` rules |

The "Plays on" column is each item's readings: `runs` on a platform puts that platform in the
list (§7.3 holds them equal). The readings for ICO, AVIF, AAC, AMR, MIDI, HEVC, MPEG-4 Part 2 and
MKV are the documentation the items name (`android-supported-formats`, `chromium-audio-video`,
`mdn-*`, `apple-safari-html5-audio-video`) until §8 records runs. H.264 High's Android reading is
the planning run of §8.5 (`executed: "android-decode"`), which overrides the documentation's
`unavailable`.

`wav-pcm` keeps the label "WAV" and `m4a` "M4A", the labels step 2's messages use; the two Ogg
variants and the two WebM variants name their codec, because a person choosing between them needs
it.

### 2.2 `ACCEPTED_FORMATS`

`AcceptedFormat.surfaceKeys` is removed: `MEDIA_FORMATS` is the one source of the items a MIME
admits. Its two readers are tests: `lib/commcare/surface/__tests__/manifest.test.ts` (rewritten,
§7.3) and `lib/domain/__tests__/multimedia.test.ts`, whose "names the fifteen surface items of the
formats it admits, and none for a document" becomes "names a variant for every media entry, and
none for a document" (each media entry of `ACCEPTED_FORMATS` is the `mime` of at least one
`MEDIA_FORMATS` variant, and no variant's `mime` is a document entry's). Six entries join, in kind
order after the existing entries of their kind, so the same file's "derives the kind partitions"
expects `IMAGE_MIME_TYPES` to be PNG, JPEG, GIF, WebP, BMP, `image/vnd.microsoft.icon`,
`image/avif`; `AUDIO_MIME_TYPES` `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/flac`,
`audio/ogg`, `audio/aac`, `audio/amr`, `audio/midi`; and `VIDEO_MIME_TYPES` `video/mp4`,
`video/webm`, `video/x-matroska` (`multimedia.ts::mimesOfKind` keeps registry order):

| MIME | Kind | Extension | Declared extensions | Aliases | Label |
|---|---|---|---|---|---|
| `image/vnd.microsoft.icon` | image | `.ico` | `.ico` | `image/x-icon` | ICO |
| `image/avif` | image | `.avif` | `.avif` | (none) | AVIF |
| `audio/aac` | audio | `.aac` | `.aac` | `audio/x-aac` | AAC |
| `audio/amr` | audio | `.amr` | `.amr` | (none) | AMR |
| `audio/midi` | audio | `.mid` | `.mid`, `.midi` | `audio/x-midi` | MIDI |
| `video/x-matroska` | video | `.mkv` | `.mkv` | `video/matroska` | MKV |

The canonical MIME for ICO is the registered `image/vnd.microsoft.icon`, the spelling HQ's
libmagic gives (`media-formats.json`, `hq.mimeTypes`); `file-type` sniffs `image/x-icon`
(`node_modules/file-type/source/index.js`, the `00 00 01 00` check), which the alias maps. For
MKV, `file-type` gives `video/matroska` (`source/detectors/ebml.js`) and HQ `video/x-matroska`;
the alias maps the sniff. `file-type` sniffs ADTS as `audio/aac` (`scanMpeg`), any file starting
`#!AMR` as `audio/amr`, and `MThd` as `audio/midi`.

The comments on the WAV and MP4 entries ("The item is the one step 4 narrows acceptance to") are
removed, and the registry's doc comment becomes: a media format is accepted when at least one
CommCare platform plays it and HQ types and stores its bytes as its kind; `MEDIA_FORMATS` names
each variant and where it plays; SVG is absent because HQ cannot store it (§4), and as a script
container.

`imageFormatNoun` picks its article from the label's first letter, so ICO and AVIF read "an ICO
image" and "an AVIF image" (today it writes "a" before every label). `MODEL_READABLE_IMAGE_MIME_TYPES`
stays PNG, JPEG, GIF and WebP: an ICO or AVIF reaches the model as BMP does, as a placeholder.

---

## 3. The readers

### 3.1 Where they run

`validate.ts`'s stage 4 returns, for a media kind, `mediaFormat: MediaFormatKey` beside
`dimensions` and `durationMs`; `ValidatedMediaMetadata` gains `mediaFormat?: MediaFormatKey`,
present exactly when `kind` is a media kind. The dispatch on the sniffed MIME becomes:

| Sniffed MIME | Check | Key |
|---|---|---|
| `image/bmp` | `bmp.ts::readBmp` (unchanged) | `bmp` |
| `image/vnd.microsoft.icon` | `ico.ts::readIco` (§3.4) | `ico` |
| `image/avif` | `sharp(bytes).metadata()`: `format === "heif"`, `compression === "av1"`, width and height present | `avif` |
| `image/png`, `jpeg`, `gif`, `webp` | `sharp(bytes).metadata()` (unchanged) | `png`, `jpeg`, `gif`, `webp` |
| `audio/mpeg` | the music-metadata parse (unchanged) | `mp3` |
| `audio/wav` | `wav.ts::readWav` (§3.3), then the music-metadata parse for duration | `wav-pcm` |
| `audio/mp4` | step 2's brand, track and AAC check (unchanged) | `m4a` |
| `audio/flac` | unchanged | `flac` |
| `audio/ogg` | unchanged; the codec picks the key | `ogg-vorbis` or `ogg-opus` |
| `audio/aac` | music-metadata with `mimeType: "audio/aac"`: `container` starts `ADTS/` and `codec === "AAC"` | `aac-adts` |
| `audio/amr` | `amr.ts::readAmr` (§3.5); no music-metadata parse | `amr` |
| `audio/midi` | `midi.ts::readMidi` (§3.6); no music-metadata parse | `midi` |
| `video/mp4` | `mp4.ts::readMp4` (§3.2), then the music-metadata parse for duration | from the reading |
| `video/webm` | `webmRefusal` (unchanged) | `webm-vp8` or `webm-vp9` |
| `video/x-matroska` | `webmRefusal` over container `EBML/matroska` (§3.7) | `mkv` |

The music-metadata parse for `audio/aac` reaches its MPEG parser: `MpegLoader.js` lists
`audio/aacs` and `audio/aacp`, and `ParserFactory.findLoaderForContentType` matches by
`indexOf("audio/aac")`. Its ADTS header (`mpeg/AdtsFrameHeader.js`) sets `container` to
`ADTS/MPEG-4` or `ADTS/MPEG-2` and `codec` to `AAC`. The AAC object type is not read, for ADTS as
for M4A (step 2's rule, `lib/media/CLAUDE.md`), so `media-formats.json`'s `format` text for
`audio/m4a`, `video/mp4-h264-baseline` and `video/mp4-h264-main` changes "AAC-LC" to "AAC" in
pull request 7, and the MP4 video entry's cell names no AAC profile; part 02 §7.1 and §7.2 make
both edits.

`scripts/rollout/verify-runtime-packages.mjs` gains two probes, by step 2's rule that every lazily
loaded parser the upload gate reads is loaded from the standalone package at build: an ADTS file
(`["audio/aac", <base64 of tone.aac>, "ADTS/MPEG-4", "AAC"]` in its parser table, the bytes of
§8.2's `tone.aac`), and `sharp(<base64 of pattern.avif>).metadata()` asserting `format: "heif"`
and `compression: "av1"`, so an image without libheif's AV1 decoder fails the build rather than
every AVIF upload.

A refusal keeps step 2's shape: `codecRefusal(codec, accepted)` ("This file's audio or video is
encoded in a way some CommCare apps can't play (…). Exporting it again as … fixes that.") for an
encoding, and a dedicated sentence for a container, a track or an unreadable header. §3.8 lists
every new one.

### 3.2 `lib/media/mp4.ts`

```ts
export type Mp4Reading =
	| { readonly kind: "variant"; readonly key: "mp4-h264-baseline" | "mp4-h264-main" | "mp4-h264-high" | "mp4-hevc" | "mp4-mpeg4-part2" }
	| { readonly kind: "no-video" }
	| { readonly kind: "several-videos" }
	| { readonly kind: "other-track"; readonly handler: string }
	| { readonly kind: "codec"; readonly codec: string; readonly accepted: string }
	| { readonly kind: "unreadable"; readonly detail: string };
export function readMp4(bytes: Uint8Array): Mp4Reading;
```

The walk reads box headers bounded by the buffer and by each parent's end: a 32-bit size and a
four-character type; size 1 reads the 64-bit size after the type, size 0 runs to the parent's
end; a size below its header or past its parent's end is `unreadable` ("a box runs past the end
of the file"). It reads the first top-level `moov` (none: `unreadable`, "no movie header"), and in
it every `trak`, through `mdia/hdlr` and `mdia/minf/stbl/stsd`:

- **`hdlr`** (full box): the handler type is the four bytes at payload offset 8. `vide` is a
  video track, `soun` an audio track, any other (`text`, `sbtl`, `subt`, `meta`, `hint`, `tmcd`
  and the rest) is `other-track` with that handler.
- **`stsd`** (full box): `entry_count` at payload offset 4 must be 1 (otherwise `codec`, codec
  "several encodings in one track"); the one sample entry is a box whose type is the four-cc.
- **A video sample entry**'s child boxes start 78 bytes into its payload (6 reserved, the data
  reference index, then `VisualSampleEntry`'s 70 bytes).
  - `avc1`: the `avcC` child's payload byte 1 is `AVCProfileIndication`: 66 → `mp4-h264-baseline`,
    77 → `mp4-h264-main`, 100 → `mp4-h264-high`; any other is `codec`, named "H.264 Extended" (88),
    "H.264 High 10" (110), "H.264 High 4:2:2" (122), "H.264 High 4:4:4" (244), else "H.264
    profile <n>". A constrained Baseline is profile 66 and is Baseline.
  - `hvc1` or `hev1`: the `hvcC` child's payload byte 1, low five bits, is `general_profile_idc`:
    1 → `mp4-hevc`; any other is `codec`, named "HEVC Main 10" (2), "HEVC Main Still Picture" (3),
    else "HEVC profile <n>".
  - `mp4v`: the `esds` child's `DecoderConfigDescriptor` (below) must have
    `objectTypeIndication` `0x20` (MPEG-4 Visual), and its `DecoderSpecificInfo` must be Simple
    Profile: when it starts with the visual object sequence start code `00 00 01 B0`, the next
    byte (`profile_and_level_indication`, ISO/IEC 14496-2 Table G-1) is one of `0x01` to `0x06`,
    `0x08`, `0x09`; when it starts with a video object layer start code (`00 00 01 20` to `00 00 01 2F`),
    the 8 bits after the one `random_accessible_vol` bit (`video_object_type_indication`) are 1,
    the Simple object. Either passes → `mp4-mpeg4-part2`. Otherwise `codec`, named "MPEG-4 Part 2
    Advanced Simple" for `0xF0` to `0xF7`, else "MPEG-4 Part 2 of another profile".
  - Any other four-cc is `codec`, named "AV1" (`av01`), "VP9 in MP4" (`vp09`), "Dolby Vision"
    (`dvh1`, `dvhe`), "H.264 with its settings inside the video stream" (`avc2`, `avc3`, `avc4`:
    no reader was run on these sample entries, and ffmpeg writes `avc1`), else `"<four-cc>" video`.
- **An audio sample entry**'s child boxes start 28 bytes into its payload for sound description
  version 0, 44 for version 1 and 64 for version 2 (the version is the 16 bits at payload offset 8).
  `mp4a` is AAC when the `esds` `objectTypeIndication` is `0x40` (MPEG-4 Audio) or `0x66`, `0x67`,
  `0x68` (MPEG-2 AAC); `0x69` and `0x6B` are "MP3". Other four-ccs: "AC-3" (`ac-3`), "E-AC-3"
  (`ec-3`), "Opus" (`Opus`), "FLAC" (`fLaC`), "Apple Lossless" (`alac`), "AMR" (`samr`), "AMR-WB"
  (`sawb`), else `"<four-cc>" audio`. A non-AAC audio track is `codec` with accepted "MP4 with AAC
  audio, or with none".
- **`esds`** (full box): descriptors are a tag byte, then a size of one to four bytes, seven bits
  each, high bit set on all but the last. `ES_Descriptor` (tag `0x03`): `ES_ID` (2 bytes), a
  flags byte; `0x80` skips 2 bytes, `0x40` skips a length byte and that many bytes, `0x20` skips 2
  bytes; then `DecoderConfigDescriptor` (tag `0x04`): `objectTypeIndication` is its first byte,
  and its `DecoderSpecificInfo` (tag `0x05`) follows 12 bytes later.
- **The verdict**: no video track → `no-video`; more than one → `several-videos`; any
  `other-track` → that; every audio track AAC; the one video track's variant.

The order of checks follows WebM's (`webmRefusal`): sound only first, then several videos, then
another track, then audio codecs, then the video codec.

### 3.3 `lib/media/wav.ts`

```ts
export type WavReading =
	| { readonly kind: "pcm"; readonly bits: 8 | 16 }
	| { readonly kind: "codec"; readonly codec: string }
	| { readonly kind: "unreadable"; readonly detail: string };
export function readWav(bytes: Uint8Array): WavReading;
```

The file is `RIFF`, a 32-bit little-endian size, `WAVE`, then chunks from byte 12: a four-byte id,
a 32-bit little-endian size, the data, and a pad byte when the size is odd. The first `fmt ` chunk
is read (none, or one shorter than 16 bytes: `unreadable`, "no format chunk"):

- `wFormatTag` (offset 0) and `wBitsPerSample` (offset 14).
- `wFormatTag` 1 (integer PCM): bits 8 or 16 → `pcm`; any other → `codec` "<bits>-bit PCM".
- `wFormatTag` `0xFFFE` (`WAVE_FORMAT_EXTENSIBLE`): the chunk must be at least 40 bytes; the
  sub-format GUID at offset 24 equal to `01 00 00 00 00 00 10 00 80 00 00 AA 00 38 9B 71` is
  integer PCM (then the bits rule as above); `03 00 00 00 …` with the same tail is floating point
  (`codec` "<bits>-bit float"); any other is `codec` "an extensible format".
- Any other tag is `codec`: "Microsoft ADPCM" (2), "<bits>-bit float" (3), "A-law" (6), "mu-law"
  (7), "IMA ADPCM" (`0x11`), "GSM 6.10" (`0x31`), "MP3" (`0x55`), else "format <tag>".

The channel count and sample rate are not read: the item is "WAV holding 8- or 16-bit integer
PCM" and says nothing of either. ffmpeg writes the extensible header for samples above 16 bits,
so §8.2's 24-bit and float fixtures read the extensible path.

### 3.4 `lib/media/ico.ts`

```ts
export type IcoReading =
	| { readonly kind: "icon"; readonly width: number; readonly height: number }
	| { readonly kind: "cursor" }
	| { readonly kind: "variant" }
	| { readonly kind: "unreadable"; readonly detail: string };
export function readIco(bytes: Uint8Array): Promise<IcoReading>;
```

HQ stores an image only when Pillow opens it (§1.4); Pillow 12.3.0, the version
`commcare-hq/uv.lock` pins, opened a 32 by 32 ICO during planning. The reader holds an ICO to what
Pillow's ICO loader reads and decodes: `ICONDIR` (reserved 0; type 1, while 2 is `cursor`; a count
of 1 to 255), then one 16-byte entry per image (width and height bytes, 0 meaning 256; the image's
byte size and offset as 32-bit little-endian values). Every entry's image lies inside the file
(otherwise `unreadable`, "an image runs past the end of the file"). The largest entry by width
times height is the image's dimensions, and its bytes are checked: a PNG (the eight-byte PNG
signature) must give `sharp(bytes).metadata()` that entry's width and height; otherwise the bytes
start with a 40-byte `BITMAPINFOHEADER` (`biSize` 40, planes 1, `biCompression` 0, `biBitCount`
1, 4, 8, 24 or 32), the header `bmp.ts` reads for a BMP without its file header. Anything else is
`variant`.

### 3.5 `lib/media/amr.ts`

`readAmr(bytes)`: the file starts `#!AMR\n` (AMR-NB) or `#!AMR-WB\n` (AMR-WB) and holds at least
one byte after it → `{ kind: "amr" }`. `#!AMR_MC1.0\n` or `#!AMR-WB_MC1.0\n` (multichannel) →
`{ kind: "multichannel" }`. A header and nothing after it → `{ kind: "empty" }`. The item is "AMR",
and Android's documented decoders take both NB and WB.

### 3.6 `lib/media/midi.ts`

`readMidi(bytes)`: `MThd`, a 32-bit big-endian length of 6, a format of 0, 1 or 2, a track count
of at least 1 (exactly 1 for format 0), a nonzero division, and `MTrk` at byte 14 → `{ kind:
"midi" }`; otherwise `{ kind: "unreadable", detail }` naming the first field that fails.

### 3.7 MKV through `webm.ts`'s rules

`webmRefusal(bytes, container, tracks, filename)` becomes `matroskaRefusal(bytes, container,
tracks, filename, family)` with `family: "webm" | "mkv"`: container `EBML/webm` for WebM and
`EBML/matroska` for MKV, the same track rules (one VP8 or VP9 profile 0 video track, Vorbis or
Opus audio or none, no other track), and the noun "WebM" or "MKV" in each sentence. MKV accepts
WebM's codec set and no other, the codecs Android's supported-formats table pairs with Matroska;
an H.264 MKV is refused with codec "H.264 in MKV" and accepted "MP4 with H.264 Main video".
`webm.ts::readVp9Profile` already walks any EBML Segment, so `webm.ts` changes only its doc
comment, which reads "a WebM or MKV file's first video track"; `matroskaRefusal` stays in
`validate.ts`, where `webmRefusal` is today.

`pattern-matroska.webm` (a VP8 Matroska named `.webm`) sniffs `video/matroska`, which from step 4
normalizes to an accepted MIME, so its refusal moves from `magic-bytes-sniff-failed` to
`extension-mime-mismatch` ("… has extension `.webm` but its bytes are `video/x-matroska` …").

### 3.8 Every new refusal

`ValidationFailureReason` gains `"svg-not-accepted"` and `"ico-variant-not-accepted"`. Each row is
the exact copy; `<name>` is the reader's codec name of §3.2 to §3.7.

| Case | Reason | Message |
|---|---|---|
| A `.svg` file, or a claim of `image/svg+xml` | `svg-not-accepted` | CommCare HQ can't store SVG images, so no CommCare app can show this one. Saving it as a PNG fixes that. |
| MP4 with sound and no picture | `codec-not-accepted` | This MP4 holds sound and no picture. CommCare HQ files it as video, so it could never fill an audio slot. Exporting it again as M4A (AAC) audio fixes that. |
| MP4 with several video tracks | `codec-not-accepted` | This MP4 holds more than one video track, and CommCare apps play one. Exporting it again with a single video track fixes that. |
| MP4 with another track | `codec-not-accepted` | This MP4 holds a track that is neither video nor sound (`<handler>`). Exporting it again with only its video and its AAC audio fixes that. |
| MP4 audio not AAC | `codec-not-accepted` | `codecRefusal(<name>, "MP4 with AAC audio, or with none")` |
| MP4 video codec or profile | `codec-not-accepted` | `codecRefusal(<name>, "MP4 with H.264 Main video")` |
| MP4 unreadable | `media-parse-failed` | Couldn't read the video of `` `<filename>` ``: `<detail>`. Exporting it again as MP4 with H.264 Main video fixes that. |
| WAV not 8- or 16-bit PCM | `codec-not-accepted` | `codecRefusal(<name>, "WAV with 16-bit PCM audio")` |
| WAV unreadable | `media-parse-failed` | Couldn't read the WAV header of `` `<filename>` ``: `<detail>`. Exporting it again as WAV with 16-bit PCM audio fixes that. |
| ICO cursor | `image-parse-failed` | `` `<filename>` `` is a cursor rather than an icon. Saving the image as a PNG fixes that. |
| ICO entry Pillow or a device would not read | `ico-variant-not-accepted` | This ICO holds an image saved in a way some CommCare apps can't show. Saving it again as a PNG fixes that. |
| ICO unreadable | `image-parse-failed` | Couldn't read `` `<filename>` `` as an ICO image: `<detail>`. Saving the image as a PNG fixes that. |
| AVIF that is not AV1 | `image-parse-failed` | `` `<filename>` `` holds HEIF images that are not AV1. Saving it as a PNG fixes that. |
| ADTS not AAC | `codec-not-accepted` | `codecRefusal(<codec>, "AAC (ADTS) or M4A (AAC) audio")` |
| AMR multichannel | `codec-not-accepted` | `codecRefusal("multichannel AMR", "AMR or M4A (AAC) audio")` |
| AMR with no audio | `media-parse-failed` | `` `<filename>` `` holds no audio after its header. Exporting it again as AMR or M4A (AAC) audio fixes that. |
| MIDI unreadable | `media-parse-failed` | Couldn't read `` `<filename>` `` as a MIDI file: `<detail>`. Exporting it again as a standard MIDI file fixes that. |
| MKV refusals | as WebM's | WebM's sentences with "MKV" for "WebM"; the sound-only one reads "CommCare HQ files every MKV as video" |

`SVG_REFUSAL_MESSAGE` is exported from `validate.ts`. Stage 1 refuses with it, before the
allow-list, when the filename ends `.svg` (case-insensitive) or the raw claim, lowercased with its
parameters stripped as `normalizeMimeType` strips them, is `image/svg+xml`, so a claim of SVG under
an accepted extension (MCP bytes named `x.png`) gets the SVG sentence rather than falling through
to the sniff, since `normalizeMimeType` maps no SVG claim and `validateMediaBytes` would otherwise
read the extension's kind. The initiate route (`app/api/media/upload/route.ts`) answers a claim that is `image/svg+xml` or a
filename ending `.svg` with it (400) before its generic "isn't one we accept", and the picker's
Upload tab shows it for a dropped `.svg` (§6.4). A renamed SVG fails the sniff, as today:
`file-type` reads no SVG.

### 3.9 Classifying stored bytes

```ts
/** The variant stored bytes are, or `unplayable` where no variant admits them. */
export async function classifyStoredMediaBytes(
	bytes: Buffer,
	stored: { readonly mimeType: AssetMimeType; readonly extension: string },
): Promise<MediaFormatValue>;
```

It runs `validateMediaBytes` with the stored MIME as the claim, the byte length as the claimed
size and `asset<extension>` as the filename, and returns `validated.mediaFormat` on success and
`unplayable` on any refusal, a sniff that disagrees with the stored MIME included. The cutover's
backfill (part 09 §7, §9 here) is its one production caller, for the rows whose MIME it cannot
settle without bytes; `lib/commcare/__tests__/mediaWireFixtures.ts` and `proof/corpus` use it to
prove their stand-in rows (§8.1).

---

## 4. SVG

The research held SVG for an app that does not declare Android (its "Questions" and "Media", the
`lib/media/CLAUDE.md` contract row), and the inventory has it HELD-NEW in
`expressions-and-data/image-ico-svg-avif`. At the pin it is unreachable: HQ types SVG as an image
(libmagic `image/svg+xml`, `media-formats.json`), `CommCareImage.attach_data` opens it with
Pillow, which reads no SVG (Pillow 12.3.0 raised `UnidentifiedImageError` during planning), and
that error stops the whole bulk upload, so no file of that publish is mapped (§1.4). Every Web
Apps user receives media through HQ, and Nova's local `.ccz` is a device archive Android cannot
decode SVG from. **From step 4 SVG is refused for every app**, with HQ's fact first and the
script-container fact second in `ACCEPTED_FORMATS`' comment and `lib/media/CLAUDE.md`. The native
`media` family's `media-svg-refused` scenario executes the whole-upload stop (§8.3). Nothing
changes for serving: `app/api/media/[assetId]/route.ts` already sends `Content-Security-Policy:
sandbox` and `X-Content-Type-Options: nosniff`.

---

## 5. The asset row

### 5.1 The column and its value domain (pull request 7)

`lib/case-store/migrations/20261101020000_hq_round_trip_platforms_media_format.ts`, registered in
`migrations/index.ts` as `"20261101020000_hq_round_trip_platforms_media_format"`, the name part 09
§8's ledger lists; its stamp sorts after pull request 6's
`20261101010000_hq_round_trip_platforms_form_entry_sync` and before pull request 8's
`20261101025000_hq_round_trip_platforms_android_capture_size`, so the stack's five migrations sort
in pull request order. It holds the column, its value domain (below) and the presence check of
§5.2:

```sql
ALTER TABLE media_assets ADD COLUMN media_format text;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_media_format_known CHECK (
	media_format IS NULL
	OR (kind = 'image' AND media_format IN ('png','jpeg','gif','webp','bmp','ico','avif','unplayable'))
	OR (kind = 'audio' AND media_format IN ('mp3','wav-pcm','m4a','flac','ogg-vorbis','ogg-opus','aac-adts','amr','midi','unplayable'))
	OR (kind = 'video' AND media_format IN ('mp4-h264-baseline','mp4-h264-main','mp4-h264-high','mp4-hevc','mp4-mpeg4-part2','webm-vp8','webm-vp9','mkv','unplayable'))
);
```

The value domain is valid at once: every existing row is `NULL`, and no writer of the image before
the stack writes the column. A document row (`pdf`, `text`, `docx`, `xlsx`) and a `pending` row
hold `NULL`. A key outside the kind's set is refused by the database, so a reader that names the
wrong kind fails loudly.

`lib/db/pg.ts::MediaAssetsTable` gains `media_format: string | null`; `MediaAssetDoc` gains
`mediaFormat?: MediaFormatValue`; `mediaAssetRecordFromRow` parses a non-null value with
`mediaFormatValueSchema` (an unknown value throws, failing closed) and leaves the field absent for
`NULL`.

### 5.2 The presence constraint (pull request 7, validated in pull request 13)

The same migration, after the value domain:

```sql
ALTER TABLE media_assets ADD CONSTRAINT media_assets_ready_media_format CHECK (
	status <> 'ready' OR kind NOT IN ('image','audio','video') OR media_format IS NOT NULL
) NOT VALID;
```

A `NOT VALID` check skips the existing rows but holds every insert and update from the moment it
commits. The old image confirms a browser upload by updating a `pending` row to `ready` without the
column, and inserts MCP uploads without it, so this check must never commit while the old revision
serves. It does not: the stack's migrations are not applied while the previous revision serves.
The cutover applies pull request 7's migration in its ledger's phase 1, inside the fleet
transaction, with each migration in its own savepoint (part 09 §8), so the check commits only with
the backfill and the fleet and rolls back with them when the window closes without a commit.

The validation is part 09's migration
`20261101030000_hq_round_trip_platforms_media_format_validated` (pull request 13), applied in the
ledger's phase 2 after the backfill: it counts the ready media rows with no format, refuses with
its message when any remain, and otherwise runs `ALTER TABLE media_assets VALIDATE CONSTRAINT
media_assets_ready_media_format`; its body and message are part 09 §8's. Runbook check 1 (part 09
§14) holds as written, since pull request 15 adds no migration.

### 5.3 The writers

| Writer | From step 4 |
|---|---|
| `lib/db/mediaAssets.ts::createPendingAsset` | unchanged: a pending row holds no format |
| `::publishPendingAssetForActor` | `args.mediaFormat?: MediaFormatKey`, written as `media_format` with the `ready` flip |
| `::confirmAssetReady` | the same optional argument (no production caller today; its tests pass it) |
| `::canonicalizePendingAssetForActor` | unchanged: it aliases to a ready row of the same bytes, which holds the same format |
| `::insertReadyAssetInTransaction` | `ReadyAssetInsert.mediaFormat?: MediaFormatValue`, written when present |
| `::createReadyAsset` | passes it through |
| `app/api/media/upload/[assetId]/confirm/route.ts` | passes `result.validated.mediaFormat` |
| `lib/mcp/tools/uploadMediaAsset.ts` | passes `validated.mediaFormat` |
| `lib/media/moveMedia.ts::copyAssetsIntoProject` | passes `source.mediaFormat`, so a copy into another Project keeps it; a destination sibling of the same bytes found by `findReadyAssetByProjectAndHash` holds the same format |
| `lib/media/builtinIconAssets.ts::builtinAssetRows` | the synthesized rows carry `mediaFormat: "png"` |
| `scripts/evaluate-architect.ts` | unchanged: its two rows are text documents |

From pull request 7's migration on, the presence check (§5.2) refuses a `ready` image, audio or
video row written without a format, so every production writer of one above passes it. Every test
that inserts a `ready` image, audio or video row writes the format its bytes are (the classifier on
real bytes, or the stand-in key of its MIME for a row with no bytes: `png`, `wav-pcm`,
`mp4-h264-main`), so the presence check finds every suite green: `lib/db/__tests__/*.postgres.test.ts`, `lib/deployment/__tests__/publishGates.postgres.test.ts`,
`publishSequence.postgres.test.ts`, `lib/mcp/__tests__/compileApp.postgres.test.ts`,
`uploadAppToHq.postgres.test.ts`, `lib/agent/__tests__/sourceDocuments.postgres.test.ts`,
`documentExtractionStore.postgres.test.ts`, `proof/corpus/__tests__/publish.postgres.test.ts` and
`lib/case-store/migrations/__tests__/mediaUploadAliases.postgres.test.ts`, whose seeded `ready`
image writes `media_format = 'png'` (it imports `lib/case-store/sql/__tests__/setup.ts`'s `test`,
whose database `globalSetup.ts` migrates through the whole production chain with
`applyMigrations.ts::applyMigrations` → `runCaseStoreMigrations`, so pull request 7's presence
check holds its insert). Only the suites that migrate a frozen prefix with
their own `Migrator`, `canonicalIdentityFoundation.postgres.test.ts` and
`designSessionsBackfill.postgres.test.ts` (whose rows are PDFs), never reach the check and are
untouched.

### 5.4 What clients see

`WireMediaAsset` (`lib/db/mediaAssets.ts`) gains three fields, present exactly on a ready row of a
media kind:

```ts
/** The variant the bytes are, or `unplayable`. */
mediaFormat?: MediaFormatValue;
/** "MP4 (HEVC)", or the MIME's label for `unplayable` ("WAV"). */
formatLabel?: string;
/** Where it plays, in `PLATFORMS` order; `[]` for `unplayable`. */
playsOn?: Platform[];
```

`toWireMediaAsset` derives the second and third from the first (`mediaFormatLabel`,
`mediaFormatPlaysOn`). `list_media_assets` returns them with no change to its name, description or
input (`lib/agent/tools/media/listMediaAssets.ts`), so `MODEL_CONTEXT_VERSION` does not move for
them (`lib/agent/CLAUDE.md`: a field added to a shared read tool's result moves no stored model
context). The library route, the confirm route and the resolve mode `fetchAssetsByIds` calls
return the same shape.

`upload_media_asset`'s description (MCP only) becomes:

> Upload a media file (image, audio, or video) from inline base64 bytes, returning the asset id the
> attach/set media tools reference. Media is Project-scoped: pass project_id to upload into a shared
> Project's library (use the Project of the app that will reference it); omit it for your personal
> Project. Images: .png, .jpg, .gif, .webp, .bmp, .ico or .avif. Audio: .mp3, .wav (8- or 16-bit
> PCM), .m4a (AAC), .flac, .ogg (Vorbis or Opus), .aac, .amr or .mid. Video: .mp4 (H.264, HEVC Main
> or MPEG-4 Part 2), .webm (VP8, or VP9 in 8-bit 4:2:0 color) or .mkv. ICO and AVIF play only in
> Web Apps; AAC, AMR, MIDI, HEVC, MPEG-4 Part 2 and MKV play only on Android, and
> an app takes a file only where it plays on every platform the app runs on. list_media_assets
> shows where each file plays. The file is validated (format, encoding, size, integrity) before
> it's stored; a re-upload of an identical file returns the existing asset.

Only the description moves: `uploadMediaAssetInputSchema` (`lib/mcp/tools/uploadMediaAsset.ts`)
keeps its fields and their descriptions, none of which names a format.
`lib/mcp/__tests__/servedSchemas.test.ts` runs unchanged as the check that every served input
schema compiles; it reads no description. `scripts/test-schema.ts`'s one MCP-only entry,
`uploadMediaAsset`, sends a fixed description of its own ("Upload a media file to the library from
inline base64 bytes.") with `uploadMediaAssetInputSchema`, which pull request 7 does not change, so
no billed `test:schema` run is asked for it.

`lib/session/store.ts::assetMeta` rows become `AssetMetaRow = ExportBudgetRowView & { mediaFormat?:
MediaFormatValue }`, and `recordAssetMeta` compares `mediaFormat` with the other fields, so the
builder's guard, the pickers and Preview read the format from the registry they already fill
(`lib/session/CLAUDE.md`, `assetMeta`).

---

## 6. Acceptance per reference

### 6.1 The one rule: `lib/media/platformPlayback.ts`

A client-safe module (it imports only `lib/domain`):

```ts
export interface UnplayableReference {
	readonly ref: AssetRef;                 // lib/domain/mediaRefs.ts
	readonly mediaFormat: MediaFormatValue;
	readonly label: string;                 // mediaFormatLabel
	/** The declared platforms that cannot play it; all of them for `unplayable`. */
	readonly missing: readonly Platform[];
}

/** Whether a stored value plays on every one of `platforms`. */
export function playsOnEvery(value: MediaFormatValue, platforms: readonly Platform[]): boolean;

/** Every authored reference whose file a declared platform cannot play, in walk order. */
export function unplayableReferences(
	doc: BlueprintDoc,
	formats: ReadonlyMap<string, { readonly mediaFormat?: MediaFormatValue; readonly mimeType: string }>,
	platforms: readonly Platform[],
): UnplayableReference[];

/** The row fields every judgment below reads. */
export interface PlaybackRow {
	readonly kind: AssetKind;
	readonly mimeType: string;
	readonly mediaFormat?: MediaFormatValue;
}

export function describeUnplayableReferences(references: readonly UnplayableReference[]): string;
export function attachPlatformLine(args: {
	readonly assetId: string;
	readonly slot: string;
	readonly row: PlaybackRow;
	readonly platforms: readonly Platform[];
}): string | null;
export function attachPlatformSentence(row: PlaybackRow, platforms: readonly Platform[]): string | null;
export function assetUnavailableReason(row: PlaybackRow, platforms: readonly Platform[]): string | undefined;
export function formatUnavailableReason(mimeType: string, platforms: readonly Platform[]): string | undefined;
export function playsOnLine(playsOn: readonly Platform[]): string;
/** Preview's line for an audio or video file only Android plays, or null (§6.6). */
export function browserStandIn(row: { readonly kind: AssetKind; readonly playsOn?: readonly Platform[] }): string | null;
export const REEXPORT_AS: Readonly<Record<MediaKind, string>>;
```

- `unplayableReferences` walks `walkAuthoredAssetRefs` (built-in icons skipped: they are PNG and
  play everywhere), the same walk as the kernel's kind rule, so no stored reference, a hidden case
  list column or an inactive icon included, names a file its app's platforms cannot play. A
  reference whose id has no entry in `formats` is skipped (the existence rules own it), as is a
  ready media row with no format, which only a row the backfill has not reached can be and which
  the kernel treats as `unplayable` (§6.2).
- `REEXPORT_AS`: image "a PNG or JPEG", audio "MP3, or M4A with AAC audio", video "MP4 with H.264
  Main video" (each plays on both platforms). It is the one source of re-export advice: the
  refusals below, the boundary rule and the cutover's notice (part 09 §12) read it. A sentence
  that continues after an advice holding a comma closes it with one ("Exporting it again as MP3,
  or M4A with AAC audio, fixes that.").
- A platform named as the subject reads `PLATFORM_LABELS` ("Web Apps can't play"); a platform named
  as a place takes its own preposition, as part 01 §2.1 and §2.3 do: `lib/domain/platforms.ts::inPlatform(platform)`,
  "in Web Apps" or "on Android" (part 01 §2.1, exported beside `platformDeclarationPhrase`), and a
  list of where a file plays reads `platformDeclarationPhrase`.
  A variant plays on at least one platform, so a file of a variant misses at most one; a file that
  misses both is `unplayable`, which has its own sentence.
- **An absent format reads as `unplayable`** in every judgment over a `PlaybackRow` of a ready
  media row (`playsOnEvery`, `attachPlatformLine`, `attachPlatformSentence`,
  `assetUnavailableReason`), as the kernel reads `NULL` (§6.2), so no earlier check admits what the
  kernel refuses. `unplayableReferences` skips such a row instead (the first bullet), and `browserStandIn`
  shows nothing for it (§6.6).

**The copy.** `describeUnplayableReferences` writes one sentence per missing platform, over the
references only that platform cannot play, then one for the references no platform plays, then the
closing sentence. Each reference is `describeCarrier(ref)` followed by " in " and its label:

- One platform, one file: `Web Apps can't play a file this app uses: the video on field "intro"'s label (form "Visit") in MP4 (HEVC). You can replace it or remove it, then try again.`
- One platform, several: `Web Apps can't play 2 files this app uses: the video on field "intro"'s label (form "Visit") in MP4 (HEVC) and the audio label on module "Visits" in AMR. You can replace or remove them, then try again.`
- Both platforms (a file each cannot play): `Web Apps can't play a file this app uses: the audio label on module "Visits" in AMR. Android can't play a file this app uses: the image on option "yes" of field "consent" (form "Visit") in ICO. You can replace or remove them, then try again.`
- No platform: `No CommCare app can play a file this app uses: the audio on field "note"'s help (form "Visit") in WAV. You can replace it or remove it, then try again.`

The closing sentence invites rather than instructs: `You can replace it or remove it, then try
again.` for one reference, `You can replace or remove them, then try again.` for several. A list of
three or more joins with commas and a final "and". Every reference is named: a person fixing them
needs each one, and the kernel's message has no length limit.

### 6.2 The commit kernel (authoritative, every editor)

- `lib/db/mediaAssets.ts::MediaReferenceRequirement` gains `platforms?: readonly Platform[]`.
  `lib/db/canonicalCommitKernel.ts::blueprintMediaRequirements(doc)` sets it to
  `declaredPlatforms(doc)` on every requirement; thread requirements
  (`replaceExactThreadMediaReferences`, the Project move's thread half) carry none, because
  conversation files never reach a runtime.
- `lockAndValidateMediaReferences` keeps its first pass unchanged, throwing at the first missing,
  foreign, unready or wrong-kind requirement as today. A second pass collects every requirement
  with `platforms` whose row's `media_format` (a `NULL` read as `unplayable`) does not play on every
  one of them, and, when any, throws one `MediaReferenceProjectionError` with reason
  **`platform-unplayable`**, the first failing id as `assetId`, and a new field
  `formats: ReadonlyMap<MediaAssetId, { mediaFormat: MediaFormatValue; mimeType: AssetMimeType }>`
  holding every failing row. The error's `message` is "A referenced media file does not play on
  every platform its app runs on."
- `admitExactMediaReferences` maps that reason to `BlueprintCommitRejectedError(describeUnplayableReferences(unplayableReferences(asWalkableDoc(candidateDoc), error.formats, declaredPlatforms(candidateDoc))))`
  and keeps today's sentence for every other reason.
- The kernel's commit, genesis (`lib/db/appGenesis.ts`) and the synthetic batch (`lib/db/apps.ts`)
  all reach this through `admitExactMediaReferences`, so a declaration change, an attach, a birth
  and a migration batch meet the same rule on chat, MCP and the builder. The Project move's
  destination requirements come from `blueprintMediaRequirements` too, so they carry the
  platforms; the move keeps mapping every `MediaReferenceProjectionError` to `media_stale`, and
  `copyAssetsIntoProject` carrying the format (§5.3) is what keeps a moved app admitted.
- `lib/db/runtimeDatabaseProbe.ts::auditRuntimeMediaReferenceProjection` selects `media_format`
  as well and counts a Blueprint requirement whose row does not play on every declared platform as
  a finding, as it counts a wrong kind. Thread requirements are not judged by platform.
- `lib/chat/attachmentErrors.ts` and `lib/db/threads.ts`, which read the error for thread
  attachments, never meet the new reason (thread requirements carry no platforms) and are
  unchanged.

### 6.3 The attach verdicts (SA and MCP)

`lib/media/attachVerdicts.ts`: `MediaExpectationRow` adds `mediaFormat` and `mimeType`;
`describeMediaExpectationFailures(expectations, rows, projectId, platforms)` takes the declared
platforms (`mediaAttachVerdict` passes `declaredPlatforms(doc)` of the pre-attach document) and,
after the kind check passes, adds one line per expectation whose row does not play on every
platform (an absent `mediaFormat` read as `unplayable`, §6.1), written by `attachPlatformLine`:

- `Tried to attach asset "<id>" as <slot>, but it is <label>, which <missing> can't play, and this app runs <inPlatform(missing)>. Exporting it again as <REEXPORT_AS[kind]> and uploading that fixes it.`
- `unplayable`: `Tried to attach asset "<id>" as <slot>, but no CommCare app can play it (<label>). Exporting it again as <REEXPORT_AS[kind]> and uploading that fixes it.`

No tool's name, description or input changes, so `MODEL_CONTEXT_VERSION` does not move in pull
request 7. The model learns what plays where from `list_media_assets`' `playsOn` and from these
lines; pull request 12 owns any guide sentence.

### 6.4 The builder

**In pull request 7** (behavior the builder needs so it never dispatches a commit the kernel
refuses; a refused builder batch is a reload that drops it, `lib/collab/reconciler.ts`,
`commitRejected`):

- `useAttachBudgetGuard` (`components/builder/media/useAttachBudget.ts`) checks the candidate's
  platforms before the budget, against `declaredPlatforms(docApi.getState())`, from the
  candidate's own `mediaFormat` (no fetch). A refusal is `{ ok: false, error:
  attachPlatformSentence(candidate, platforms) }`:
  - `This <image|audio|video> is <label>, which <missing> can't play, and this app runs <inPlatform(missing)>. Exporting it again as <REEXPORT_AS[kind]> fixes that.`
  - `unplayable`: `No CommCare app can play this <image|audio|video> (<label>). Exporting it again as <REEXPORT_AS[kind]> fixes that.`
  The slot shows the error where it shows the budget error today, and the file stays in the
  library.
- `MediaPickerDialog`'s Upload tab answers a dropped `.svg` with `SVG_REFUSAL_MESSAGE`.

**In pull request 11**, placed by part 07 (its §2.5 and its pull request 11 files), from these
functions and their copy:

- `assetUnavailableReason(row, platforms)`, a disabled line with no period: `<missing> can't play <label>` ("Web Apps can't play MP4 (HEVC)"), or `No CommCare app can play this file`. Part 07 adds the `MediaPickerDialog` prop that takes it per asset and shows a row of the Library as unavailable with it.
- `formatUnavailableReason(mimeType, platforms)`: a sentence for the Upload tab, for a MIME none of whose variants plays on every declared platform (ICO, AVIF, AAC, AMR, MIDI, MKV in an app declaring both): `<missing> can't play <label> <images|audio|video>, and this app runs <inPlatform(missing)>. Exporting it again as <REEXPORT_AS[kind]> fixes that.` ("Android can't play ICO images, and this app runs on Android. Exporting it again as a PNG or JPEG fixes that."). It is passed as the picker's existing `unavailableReason`, which leaves the format out of `accept`. MP4, WAV and the rest keep their upload, since some variant of each plays everywhere; a file of a variant the app cannot use is refused at attach by the guard above.
- `playsOnLine(playsOn)` for the file manager, "Plays " and `platformDeclarationPhrase(playsOn)`: "Plays in Web Apps and on Android", "Plays only in Web Apps", "Plays only on Android"; for `[]`, "No CommCare app plays this file".

### 6.5 The declaration change

A change of `runsOnlyOn` commits through the kernel, so §6.2 refuses one that leaves a reference
its new platforms cannot play, on every editor, with every carrier named, in
`describeUnplayableReferences`' words. Two earlier checks read the same rule, both part 07's, and
both run on the server, where the rows are:

- **The builder's platform section** (pull request 11, part 07 §2.3) checks a change that adds a
  platform with one server action, `lib/doc/platformChangePreflight.ts::platformChangePreflightAction`,
  after the reconciler's save barrier, over the committed document and the referenced rows of the
  app's Project; it checks content and media together. Its media half is
  `lib/media/attachVerdicts.ts::mediaDeclarationVerdict({ projectId, doc, db })`, a thin
  loader: `walkAuthoredAssetRefs`, `partitionAssetRefs`, `loadAssetsByIds(ids, projectId,
  db)`, then `unplayableReferences(doc, formats, declaredPlatforms(doc))` over the candidate
  document. `db` is an optional executor, `Kysely<AppDatabase>` (a `Transaction<AppDatabase>` is
  one), and `lib/db/mediaAssets.ts::loadAssetsByIds` gains the same optional third parameter in
  pull request 11, reading through `db ?? await getAppDb()`. The preflight passes the `tx` of its
  `withAppTx(body, { isolationLevel: "repeatable read" })` transaction (part 07 §2.3), so the
  content check and the media rows are read on one connection from one snapshot, and a preflight
  holds one of the pool's three connections
  (`lib/case-store/postgres/connection.ts::POOL_MAX_PER_INSTANCE`), not two. Each
  media row of its refusal block is `describeUnplayableReferences` of that one reference, so the
  builder, the kernel and the agent give one copy. A reference whose row is absent is skipped, as
  `unplayableReferences` skips it, and the kernel stays the authority.
- **`updateApp`'s `runs_only_on`** (pull request 12, part 07 §3.3) runs the same
  `mediaDeclarationVerdict` (with no `db`) before staging when its change adds a platform,
  beside its pre-check of content (part 07 §3.3), because a chat edit
  stages in private work, where the pure gate sees no media rows, so without it the refusal would
  first reach the model at `saveWork`. Its error's media lines are `describeUnplayableReferences`'
  text, and part 07 §3.3 owns the sentences around them.

A change that only removes a platform needs neither check: a file that plays on every declared
platform still plays on fewer.

`components/builder/media/useReferencedAssetRows.ts::useReferencedAssetRows(assetIds)` (pull
request 7): reads `assetMeta` for each id and fetches the missing ones once through
`fetchAssetsByIds(ids, appId)`, coalescing the ids asked for in one tick, recording the rows and
retiring on a Project scope reset as `useAttachBudgetGuard` does. Preview's stand-in (§6.6) uses
it.

### 6.6 Preview

Preview plays media in the browser, so it plays what Web Apps plays, whatever platform Preview
runs as (pull request 8's `previewPlatform`, part 06). `components/builder/media/MediaDisplay.tsx` (used by
Preview's form renderers and the builder's form view) reads each audio and video id's row through
`useReferencedAssetRows`; where `platformPlayback.ts::browserStandIn(row)` gives a line, it renders
that line in the player's place, `components/builder/media/MediaStandIn.tsx`:

- `This audio plays on Android devices. Your browser can't play it here.`
- `This video plays on Android devices. Your browser can't play it here.`

`browserStandIn` gives the line only when the row's `playsOn` holds `android` and not `web-apps`:
a variant only Android plays. An `unplayable` row (`playsOn` `[]`) and a row with no format keep
the native player: no CommCare app plays the first, so "plays on Android devices" would be false,
the second's variant is not known, and the browser may well play either (a 24-bit WAV, an AV1 MP4).
Images need no stand-in: no image variant plays only on Android. `AssetPreviewDialog.tsx` shows the
same line for such a file, by the same function.

While its row is unknown, an audio or video slot renders the player without a source, so it
requests no bytes until the row says whether the browser plays the file; the row comes from
`assetMeta`, which the builder has usually filled, or from one coalesced resolve. A spec that
answers the bytes route of a Preview slot therefore answers the resolve route too (the library
route `fetchAssetsByIds` reads), as `e2e/tests/app/media-library.spec.ts` does today. The line is
a property of the file,
the same in both Preview platforms, so it adds no row to Preview's cell table (part 06, pull
request 9), which lists feature behaviors that differ by platform.

### 6.7 The export boundary: `MEDIA_FORMAT_NOT_PLAYED`

`lib/commcare/validator/rules/media/mediaFormatPlays.ts`, the fourth of `MEDIA_ASSET_RULES`: over
`walkAssetRefs(doc)` (what ships, as its three siblings walk), for each reference whose record is
`ready`, of the slot's kind and of a media kind, the record's format (`NULL` read as `unplayable`)
must play on every `declaredPlatforms(doc)`. A failure is:

```ts
validationError("MEDIA_FORMAT_NOT_PLAYED", scopeFor(location), message, validationLocationFor(location), {
	assetId, mediaFormat, missingPlatforms: missing.join(","), ...navigabilityDetailsFor(location),
});
```

- message: `At <describeLocation(location)>, the attached <slotKind> is <label>, which <missing> can't play, and this app runs <inPlatform(missing)>. Exporting it again as <REEXPORT_AS[kind]>, or clearing the slot, fixes that.`; for `unplayable`: `At <describeLocation(location)>, no CommCare app can play the attached <slotKind> (<label>). Exporting it again as <REEXPORT_AS[kind]>, or clearing the slot, fixes that.`
- `lib/doc/userFacingErrors.ts`: `MEDIA_FORMAT_NOT_PLAYED: (e) =>` `An attached file can't play <inPlatform of the one missing platform>, where this app runs. You can swap it for a file that plays there, or clear the slot.` ("An attached file can't play in Web Apps, where this app runs. …"), or, when `mediaFormat` is `unplayable`, `An attached file can't play in any CommCare app. You can swap it out, or clear the slot.`
- Registered as the other media codes are: `ValidationErrorCode` and `MEDIA_VALIDATION_CODES`
  (`lib/commcare/validator/errors.ts`), `"environment"` in `gate.ts`'s class table (the commit gate
  sees no rows), and `SCOPE_EXEMPT_CODES` (`runner.ts`).

It is defense in depth beside the kernel, for references committed before the cutover's
transform and for a row changed by hand, and it is what the corpus's publish findings read
(`proof/corpus/editBatches.ts::publishFindings` → `evaluateBoundary`).

---

## 7. The manifest

Part 02 owns the text of every manifest edit step 4 makes, so the edits this part's work needs in
pull request 7 are written there once, and this section cites them; it keeps only the registry's
own test (§7.3).

### 7.1 Inventory entries

Part 02 §7.1: the two narrows step 2 left (WAV and MP4) become HELD with an encoding and a codec
check, the MP4 video cell naming no AAC profile (§3.1); `image-ico-svg-avif` is replaced by
`expressions-and-data/image-ico-avif` (HELD, Web Apps only) and `expressions-and-data/image-svg`
(REFUSED, broken at runtime, §4); the Android-only variant entries become HELD; and
`video-mp4-h-264-high` merges into the Baseline-or-Main video entry, since High now reads as
Baseline and Main do (§8.5). The variants of §2.1 are what those entries hold.

The research's held-for-Web-Apps SVG line and its `lib/media/CLAUDE.md` contract row are corrected
by the `image-svg` entry; the plan records the correction here, `lib/media/CLAUDE.md` says SVG is
refused (pull request 7), and `docs/architecture/contracts.md` gains a "Deliberate target gaps"
bullet that SVG images never ship (pull request 14, §11).

### 7.2 `media-formats.json`

Part 02 §7.2: the SVG item's `hq.note`, `hqClassification`'s `storage` note, the `format` text
"AAC-LC" to "AAC" in `audio/m4a`, `video/mp4-h264-baseline` and `video/mp4-h264-main` (§3.1), and
the `browser-playback-ci` execution record with the `webApps.executed` marks on the items §8.4's
spec plays, and `video/mp4-h264-high`'s Android reading `runs` with `executed: "android-decode"`
and its note (§8.5).

### 7.3 `lib/commcare/surface/__tests__/manifest.test.ts`

"the accepted formats and the media-format family" is rewritten:

1. Each `MEDIA_FORMATS` variant names an item; the item's `kind` is the variant's, its `hq.class` is
   the kind's class (`HQ_CLASS_OF_KIND`), and the variant's `playsOn` holds `web-apps` exactly when
   `webApps.reading` is `runs` and `android` exactly when `android.reading` is `runs`; `playsOn` is
   never empty.
2. Each variant's MIME is an `ACCEPTED_FORMATS` entry of its kind, and each media entry of
   `ACCEPTED_FORMATS` has at least one variant.
3. Completeness: every item with a `runs` reading on some platform whose `hq.class` is its kind's
   class is either a variant's item or named by a REFUSED inventory entry (today `image/svg`, by
   `expressions-and-data/image-svg`). An item that plays somewhere and that Nova neither accepts nor
   refuses for a reason fails.
4. `EXECUTED_ITEMS` (step 2's, both platforms) stays; `CI_EXECUTED_ITEMS` lists §8.4's items, each
   with `webApps.executed: "browser-playback-ci"`; and `ANDROID_RUN_ITEMS`, today
   `["media-format:video/mp4-h264-high"]`, each with `android.executed: "android-decode"` and the
   reading `runs`.
5. The existing "names every execution record from an item, and no record on a reading that is not
   runs" stays.

Rule 7 of pull request 4's `platformFeatures.test.ts` (part 01 §8.2: a HELD media entry reads as its formats)
holds the inventory against the items; this test holds the registry against them.

### 7.4 The lane's SVG reader

Part 02 §7.3: `proof/checks/manifest_value_classes.py::svg_image`, registered in `VALUE_CLASSES` for
`expressions-and-data/image-svg`, and its accepted and refused shapes in
`proof/checks/test_manifest_value_classes.py`. Without it, a REFUSED entry with a value class and no
reader would leave every `media-class:CommCareImage` use undecided. The HELD variant entries need no
reader: an allowing class is not judged.

---

## 8. Proof

### 8.1 The corpus video fixture

`lib/media/__tests__/fixtures/tiny-video.mp4` is H.264 **High** (read during planning from its
`avcC`: profile 100, level 10; 32 by 32; 13 samples at timescale 12800, duration 6656; no audio;
SHA-256 `e9cefb19834b705b60adbb1f14ae4cce5313616c0390e9b9601a50b3ca9bab38`). It is the video of every
corpus document, every media wire fixture and the compiler fuzz
(`lib/commcare/__tests__/mediaWireFixtures.ts::mediaManifest`, `lib/commcare/__tests__/compilerEvidence.ts`,
`proof/corpus/emitCorpus.ts::EDIT_UPLOADS` through `mediaManifest()`, and
`proof/native/producers/emit-media-evidence.ts`). From step 4 it plays on both platforms: it is the
file the three Android images decoded during planning (§8.5). So it stays as it is, and pull
request 7 moves no corpus document's bytes or key for media: the three committed literals of its
SHA-256 (`proof/webapps/test_media_slots.py::LABEL_VIDEO`,
`proof/formplayer/media_slots/targeted-media-slots.form.xml` and `media-rich.form.xml`) and the
controls that hold it are untouched. `validate.test.ts`'s `durationMs` expectation for it stays 520,
and it gains `mediaFormat: "mp4-h264-high"`. It is the registry's H.264 High fixture, so §8.2
commits no other.

- **The stand-in rows prove themselves.** `mediaWireFixtures.ts::mediaManifest` gains each file's
  `mediaFormat` and `mediaRecords` writes it; `proof/corpus/editBatches.ts::readyRow` writes the key
  of its kind's stand-in (`png`, `wav-pcm`, `mp4-h264-high`, beside `MEDIA_MIME`). Two tests hold
  them equal to the production classifier over the real bytes, so a fixture that stopped playing on a
  platform fails there rather than passing the corpus while production refuses it:
  `lib/commcare/__tests__/mediaWireFixtures.test.ts` (new: each file's `mediaFormat`, in
  `mediaManifest` of every `formats` set of §8.3, equals `classifyStoredMediaBytes` of its bytes; the
  SVG of §8.3 is never in a manifest) and `proof/corpus/__tests__/editBatches.test.ts` (each
  kind's stand-in key equals `classifyStoredMediaBytes` of `mediaManifest()`'s file of that kind).

`proof/core/captures/proof-video.mp4` (also High) is a worker's capture answer, not an authoring
asset, and is unaffected.

### 8.2 New fixtures

Made once with the Homebrew ffmpeg 9.0.2 on the author's machine, with the template of
`validate.test.ts`'s header (`T` the 440 Hz tone, `V` the 64 by 64 test pattern, the bit-exact
flags and `-map_metadata -1`), and listed in that header with their commands. H.264 High has no
pattern file of its own: `tiny-video.mp4` is the High fixture (§8.1), and the one the planning run
decoded (§8.5).

| File | Command | Reading |
|---|---|---|
| `pattern-h264-baseline.mp4` | `V -c:v libx264 -profile:v baseline -pix_fmt yuv420p -f mp4` | `mp4-h264-baseline` |
| `pattern-h264-main-aac.mp4` | `V T -c:v libx264 -profile:v main -pix_fmt yuv420p -c:a aac -f mp4` | `mp4-h264-main` |
| `pattern-h264-high10.mp4` | `V -c:v libx264 -profile:v high10 -pix_fmt yuv420p10le -f mp4` | refused, H.264 High 10 |
| `pattern-hevc.mp4` | `V -c:v libx265 -profile:v main -pix_fmt yuv420p -tag:v hvc1 -f mp4` | `mp4-hevc` |
| `pattern-hevc-main10.mp4` | `V -c:v libx265 -profile:v main10 -pix_fmt yuv420p10le -tag:v hvc1 -f mp4` | refused, HEVC Main 10 |
| `pattern-mpeg4.mp4` | `V -c:v mpeg4 -f mp4` | `mp4-mpeg4-part2` (ffmpeg's encoder writes Simple Profile level 1 with no B-frames) |
| `pattern-mpeg4-asp.mp4` | `V -c:v mpeg4 -bf 1 -f mp4` | refused, MPEG-4 Part 2 Advanced Simple |
| `pattern-av1.mp4` | `V -c:v libsvtav1 -f mp4` | refused, AV1 |
| `pattern-h264-mp3.mp4` | `V T -c:v libx264 -profile:v main -pix_fmt yuv420p -c:a libmp3lame -f mp4` | refused, MP3 audio |
| `pattern-h264-subtitles.mp4` | `V -i subtitles.vtt -map 0 -map 1 -c:v libx264 -profile:v main -pix_fmt yuv420p -c:s mov_text -f mp4` | refused, another track |
| `tone-audio-only.mp4` | `T -c:a aac -f mp4` | refused, sound and no picture |
| `tone.wav` | `T -c:a pcm_s16le` | `wav-pcm` |
| `tone-8.wav` | `T -c:a pcm_u8` | `wav-pcm` |
| `tone-24.wav` | `T -c:a pcm_s24le` | refused, 24-bit PCM (extensible header) |
| `tone-float.wav` | `T -c:a pcm_f32le` | refused, 32-bit float |
| `tone-mulaw.wav` | `T -c:a pcm_mulaw` | refused, mu-law |
| `tone.mp3` | `T -c:a libmp3lame` | `mp3` |
| `tone.aac` | `T -c:a aac -f adts` | `aac-adts` |
| `pattern-vp8.mkv` | `V -c:v libvpx -f matroska` | `mkv` |
| `pattern-h264.mkv` | `V -c:v libx264 -profile:v main -pix_fmt yuv420p -f matroska` | refused, H.264 in MKV |
| `pattern-png.ico` | `V -frames:v 1 -c:v png -f ico` | `ico`, 64 by 64 |
| `pattern-bmp.ico` | `V -frames:v 1 -c:v bmp -pix_fmt bgra -f ico` | `ico`, 64 by 64 |
| `pattern.svg` | (text) `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>` | refused, SVG |
| `pattern.png`, `pattern.jpg`, `pattern.gif`, `pattern.webp`, `pattern.avif` | sharp 0.35.5: `sharp({ create: { width: 64, height: 64, channels: 3, background: "#3366cc" } })` then `.png()`, `.jpeg()`, `.gif()`, `.webp()` or `.avif()`, `.toFile(<name>)` | `png`, `jpeg`, `gif`, `webp`, `avif`, 64 by 64 |

The five raster images are committed files made once, like every other fixture here, so every
reader (the proof image's HQ, the browser spec, the decode probe and
`scripts/rollout/verify-runtime-packages.mjs`' AVIF probe) reads the same bytes, and HQ's input
stays deterministic from its content key (`proof/CLAUDE.md`) whatever sharp or libaom a later host
holds. The header records the sharp call beside the ffmpeg commands, since that ffmpeg has no WebP
encoder.

That ffmpeg has no AMR encoder and no MIDI muxer, so these two are built in code from fixed bytes,
as the BMPs are, in `lib/media/__tests__/builtFixtures.ts` (new). `writeBuiltFixtures(directory)`
writes the three accepted ones for the decode probe, `amr-nb.amr`, `amr-wb.amr` and `midi.mid`; the
two refused AMR files stay in memory for `amrMidi.test.ts`.

- `amrNb()`: `#!AMR\n` and 50 speech frames of mode 7 (12.2 kbit/s): each the header byte `0x3C`
  (frame type 7, quality bit set) and 31 payload bytes of zero, 20 ms each, so one second of audio
  a decoder outputs (RFC 4867 §5's storage format; any payload bits decode as speech
  parameters). `amrWb()`: `#!AMR-WB\n` and 50 frames of mode 8 (23.85 kbit/s): the header `0x44`
  and 60 payload bytes of zero. `amrMultichannel()`: `#!AMR_MC1.0\n` and the NB frames (refused);
  `amrEmpty()`: `#!AMR\n` alone (refused).
- `midi()`: `MThd`, length 6, format 0, one track, division 96, then `MTrk` of 12 bytes: note on
  middle C at velocity 64 (`00 90 3C 40`), note off a quarter later (`60 80 3C 40`), end of track
  (`00 FF 2F 00`).

### 8.3 The native `media` family (HQ's real bulk upload)

`mediaWireFixture(mediaOnly, formats)` (`lib/commcare/__tests__/mediaWireFixtures.ts`) takes
`formats: "none" | "every-platform" | "web-apps" | "android"` in place of its boolean (`false` is
`"none"`, `true` is `"every-platform"`, today's seven formats). The two new sets add select options
holding their files, each in a slot of its kind, and declare the app; both stay admissible, so
`mediaWireFixture` still runs `runValidation` over `mediaRecords(assets)` and throws on any finding:

| Set | Declares | Added files | Files in the zip (image, audio, video) |
|---|---|---|---|
| `web-apps` | `runsOnlyOn: "web-apps"` | `pattern-png.ico`, `pattern.avif` (image) | 7 (5, 1, 1) |
| `android` | `runsOnlyOn: "android"` | `tone.aac`, `amrNb()`, `midi()` (audio), `pattern-hevc.mp4`, `pattern-mpeg4.mp4`, `pattern-vp8.mkv` (video) | 11 (3, 4, 4) |

**The SVG scenario is the one deliberately inadmissible emission**, so it is not a `formats` set.
Nova's own validator refuses its document (`classifyStoredMediaBytes` of an SVG is `unplayable`,
stage 1 refusing it, and `image/svg+xml` is no `AssetMimeType`, so `MEDIA_FORMAT_NOT_PLAYED` fires
on a both-declared app), and no production path can emit it. The producer builds it on its own
path, `emit-media-evidence.ts::svgRefusedScenario()`: it takes `mediaWireFixture(false, "none")`'s
document and manifest (both platforms declared), adds a select option whose image is the SVG's
asset id (`testMediaAssetId("wire-svg")`), and appends `pattern.svg` to the manifest after the base
PNGs (kind `image`, MIME `image/svg+xml`, extension `.svg`), then runs `expandDoc` and
`buildMediaBulkUploadZip` with no `runValidation`. The SVG never enters `mediaManifest`, so
`mediaWireFixtures.test.ts`'s classifier equality (§8.1), which runs over every file of every
`formats` set, never meets it; the function's comment names it as the one emission Nova would
refuse, built only so HQ's refusal is executed.

`proof/native/producers/emit-media-evidence.ts` emits three more scenarios, `media-web-apps-on`
and `media-android-on` from the two sets and `media-svg-refused` from `svgRefusedScenario()`, and
adds the new fixture files (`pattern.svg` among them) and `builtFixtures.ts` to
`media-source-hashes.json`'s paths. `media-kinds.json` and `media-paths.properties` are written
from the union of every set's assets and the SVG scenario's file, not from the every-platform set
alone: `proof/native/steps/media_emission.py::media` gives each uploaded file the `novaKind` that
`media-kinds.json` names for its path, and `test_media_emission.py::_check_upload` asserts each
file's class is `HQ_CLASS[novaKind]`, so a path missing from it would fail every new file, and
`mediaIds` gains a key per new file, which `media-paths.properties` resolves.
`proof/native/steps/media_emission.py` gains `FORMAT_SCENARIOS` with the three names, run by the
same `media(session)` body after `SCENARIOS`; `validation_sources` covers both lists, and
`proof/native/core/MediaRuntimeTest.java`'s `sourceFormsParseWithRealCoreBeforeHqMatching`
certifies both (its other methods keep the four scenarios, whose Core installs they hold).
`proof/native/test_media_emission.py`:

- `media-web-apps-on` and `media-android-on`: the upload completes with no error, unmatched or
  skipped file, at the counts above; each file's class is its Nova kind's; HQ maps and stores each
  file's exact bytes. This executes HQ storing an ICO and an AVIF through Pillow in the proof image
  (the Linux wheel `uv.lock` pins).
- `media-svg-refused`: the status's errors hold "Error while processing zip", and no file of the zip
  is in the app's `multimedia_map` afterwards, the PNG processed before the SVG included.
- The certificate's canonical count becomes 7.

**The AVIF gate.** Pillow's manylinux wheels are documented to carry libavif, and the planning run
opened AVIF only on the author's Mac. If `media-web-apps-on` shows HQ's image refusing the AVIF
(the whole upload stopping, as for the SVG), pull request 7 removes `avif` from `MEDIA_FORMATS` and
`image/avif` from `ACCEPTED_FORMATS`, the inventory's `image-ico-avif` becomes `image-ico` (HELD)
beside an AVIF entry REFUSED for the same reason as SVG with the run named (part 02 §7.1), and the
AVIF leaves the `web-apps` set (then 6 files: 4, 1, 1) for the inadmissible path: `svgRefusedScenario()`
becomes `refusedImageScenario(file)`, emitting `media-svg-refused` and `media-avif-refused`, the
second asserting what the first does, and the certificate's canonical count becomes 8. If HQ
stores it, the plan stands.

### 8.4 Browser playback (CI)

`e2e/tests/browser/media-play.spec.ts` runs in CI's `browser` project (the Chromium headless shell
Playwright drives, Linux amd64) and `browser-webkit` (WebKit, Linux amd64). It gains, in `PLAYED`:
`tone.wav` and `tone-8.wav` (`audio/wav`), `tone.mp3` (`audio/mpeg`), `tiny-video.mp4` (the High
fixture), `pattern-h264-baseline.mp4` and `pattern-h264-main-aac.mp4` (`video/mp4`);
and in a decoded-image map with each MIME: `pattern.png`, `pattern.jpg`, `pattern.gif`, `pattern.webp` and `pattern.avif`, and
`pattern-png.ico` and `pattern-bmp.ico` (`image/vnd.microsoft.icon`). The test's name becomes "every
format Web Apps plays plays to its end, and every image decodes".

The run is recorded in `media-formats.json` as the execution record `browser-playback-ci`, its
readers the two engines at the versions the installed Playwright's `browsers.json` pins when pull
request 7 is written, with `webApps.executed: "browser-playback-ci"` on `image/png`, `image/jpeg`,
`image/gif`, `image/webp`, `image/ico`, `image/avif`, `audio/mp3`, `audio/wav-pcm-8-or-16-bit`,
`video/mp4-h264-baseline`, `video/mp4-h264-main` and `video/mp4-h264-high`; the record's text and
the marks are part 02 §7.2's. These are the readings step 2 left as documentation ("The eight
other items the registry names … carry no `executed`") and the two Web-Apps-only image items. No spec asserts an Android-only variant fails to play: a reading
of `unavailable` means some browser in the bar does not play it, which one engine playing it would
not contradict.

**Both outcomes.** Each file plays in both engines: the records land as above. A file an engine
does not play fails the spec in pull request 7's CI. That engine is a build of a browser Web Apps
runs in (Chrome's headless shell, Safari's WebKit), so the item's `webApps.reading` becomes
`unavailable` with a note naming the engine and the run, `MEDIA_FORMATS` loses `web-apps` for the
variant (and the variant leaves the registry if it then plays nowhere), the inventory entry reading
it is edited to match (part 01 §8.2's rule 7 of `platformFeatures.test.ts` holds them together), and the spec
keeps the file out of `PLAYED`.

### 8.5 Android: H.264 High and the decode probe

**Executed during planning: Android decodes H.264 High.** The documentation reads `unavailable` on
Android for H.264 High ("Android 6.0 guarantees only the Baseline and Main profiles",
`android-supported-formats`), and CommCare's minimum is Android 6.0 (`minSdkVersion 23`). Phone
cameras commonly record High, so the reading decided how much video an app that runs on Android
could hold, and the person ran `proof/android/decode/run.sh` on their Mac on 2026-10-23, at their
request. It ran on three emulator images whose build fingerprints equal exactly the three readers
of `lib/commcare/surface/media-formats.json`'s `executions["android-decode"]`: Android 6.0
(`Android/sdk_google_phone_arm64/generic_arm64:6.0/MASTER/8690019:userdebug/test-keys`), Android
10 (`google/sdk_gphone64_arm64/emulator64_arm64:10/QSR1.211112.011/13135432:userdebug/dev-keys`)
and Android 15 (`google/sdk_gphone64_arm64/emu64a:15/AE3A.240806.036/12592187:user/release-keys`).
Each decoded `lib/media/__tests__/fixtures/tiny-video.mp4` (H.264, `avcC`
`AVCProfileIndication` 100, High, §8.1) to the end of its stream, 13 frames: Android 6.0 with
`OMX.google.h264.decoder`, Android 10 with `c2.android.avc.decoder`, Android 15 with
`c2.goldfish.h264.decoder`. Every other fixture's outcome matched step 2's records but one that
Nova refuses anyway: `pattern-h264.m4a`, an M4A holding only H.264 High 4:4:4 video (profile 244),
was refused on Android 10 and decoded on 6.0 and 15; step 2's M4A check refuses it at upload (it
holds no audio track, `validate.test.ts`), and `mp4.ts` would refuse its profile (§3.2).

**Decision: H.264 High plays on both platforms.** In pull request 7,
`items["media-format:video/mp4-h264-high"].android` becomes `{"reading": "runs", "executed":
"android-decode", "note": "Decoded by the emulator images' software decoders; Android 6.0
guarantees only Baseline and Main."}` (part 02 §7.1 holds the text), `mp4-h264-high` plays on Web
Apps and Android (§2.1), and the inventory's `video-mp4-h-264-high` entry merges into the
Baseline-or-Main one (part 02 §7.1). The `android-decode` record's readers are unchanged, since the
fingerprints are the ones it names. Reason: the one run made is the evidence, and it decoded the
file on CommCare's floor and on two later releases. An emulator decodes in software and is not a
phone's hardware decoder (step 2's own caveat in `lib/media/CLAUDE.md`), which the note says; the
documentation states what every phone guarantees, and the run shows Android's own software
decoder, which every image ships, playing it.

**What it costs: nothing removed.** The cutover's `remove-unplayed-media` step removes no H.264
High reference (part 09 §5, step 2), a phone's High video attaches to an app that runs on both
platforms, and the corpus video stays as it is (§8.1). There is no question to put to the person
before pull request 7 and no confirmation in the runbook: the reading the removal would have rested
on is gone.

**The probe for later runs.** `proof/android/decode/probe.py`'s `ACCEPTED` becomes every fixture
of a variant whose Android reading is `runs`: today's sixteen, plus `tiny-video.mp4`,
`pattern-h264-baseline.mp4`, `pattern-h264-main-aac.mp4`, `pattern-hevc.mp4`, `pattern-mpeg4.mp4`,
`pattern-vp8.mkv`, `tone.wav`, `tone-8.wav`, `tone.mp3`, `tone.aac`, `amr-nb.amr`, `amr-wb.amr`,
`midi.mid`, `pattern.png`, `pattern.jpg`, `pattern.gif` and `pattern.webp`; `run.sh` writes
`writeBuiltFixtures`' three files beside the BMPs it writes today. `DecodeProbe.java` sends a file to
`BitmapFactory` by its extension, which today is `.bmp` alone, so every other image would reach
`MediaExtractor` and fail: it decodes `.bmp`, `.png`, `.jpg`, `.gif` and `.webp` as images, and
`probe.py`'s frame check, today `if not name.endswith(".bmp")`, skips the same five extensions.
These additions serve future runs: the planning run used the probe as it stands at `main`, which
pushes every file of `lib/media/__tests__/fixtures/` and so read `tiny-video.mp4`, and the new
variants' Android readings (HEVC, MPEG-4 Part 2, MKV, AAC, AMR, MIDI) stay the documentation's.

**If the person asks for another run** (`PROOF_ANDROID_DECODE_AVDS="23=<avd>,29=<avd>,35=<avd>" python3 -m unittest proof.android.decode.probe -v`):
every file of `ACCEPTED` that decodes on all three images gains `android.executed: "android-decode"`
on its item (the record's readers are the same three images; a changed fingerprint updates them);
a file that does not is a finding, handled as §8.4's second outcome on the Android side. It runs only
on the person's own yes, since it needs their Mac.

---

## 9. What the cutover takes from this part

The cutover (part 09, pull request 13) owns the backfill Job, the transform, the notices, the
migration ledger and the runbook. It relies on these, each landed in pull request 7, by the names
and signatures this part gives:

- **The backfill** (part 09 §7): every `ready` row of a media kind with `media_format IS NULL`
  gets its variant. A row whose stored MIME has exactly one variant in §2.1 and whose body check is
  the one upload already ran on it takes that variant without its bytes being read, since
  `classifyStoredMediaBytes` would return the same (part 09 §7 derives the list from `MEDIA_FORMATS`
  and gives each MIME's reason). Every other row gets `classifyStoredMediaBytes(bytes, { mimeType,
  extension })` (§3.9) over its object, read once per distinct `gcs_object_key` (rows sharing bytes
  share the key and so the format); a row whose bytes no variant admits gets `unplayable`
  (`MediaFormatValue`). Which rows part 09 marks `unplayable` without classifying (a missing object,
  one over its kind's cap) and how it reports them are part 09 §7's. Document rows and pending rows
  stay `NULL`.
- **What production holds.** The content-free production scan made during planning found ready
  image rows (JPEG and PNG) and document rows, and no audio or video row at all. So the backfill
  there classifies images only, each from its MIME with no byte read, and the cutover removes no
  media reference (no image variant stored there plays on one platform alone). The rows that would
  need bytes (WAV, Ogg, MP4, WebM) and the removals stay planned, for local databases and for any
  such file uploaded before the window; part 09 §7 and §14 write both branches of the bucket
  grant.
- **The transform's media step** (part 09 §5, step 2 `remove-unplayed-media`), after the app's
  declaration is stored (media never shapes the declaration): `unplayableReferences(doc, formats,
  declaredPlatforms(doc))` lists the references to remove, and `playsOnEvery(format,
  declaredPlatforms(doc))` (or `mediaFormatPlaysOn(format)`) is the per-file judgment it applies. A
  field's `label_media` or `help_media` slot and an option's media slot are cleared; a module, form
  or case-list icon or audio label is cleared; the logo is cleared; an image-map entry is removed
  whole, because `lib/domain/modules.ts::imageMapEntrySchema` requires its `assetId`, which also
  moves that column's mapping-position sort order. Each removal names the file, the carrier, the
  format and the platform that cannot play it, for the notice.
- **The notice's re-export advice** (part 09 §12) reads `REEXPORT_AS` (§6.1), so the notice and
  the refusals give the same advice.
- **The constraint and the postconditions** (part 09 §8, §10): pull request 7's migration
  (§5.1, §5.2) is the ledger's phase 1; after the backfill no `ready` media row has a `NULL`
  format, and `lockAndValidateMediaReferences` with the platform-aware requirements admits every
  app's projection, so pull request 13's validation migration (phase 2) and the deploy's runtime
  probe pass.

---

## 10. Tests

| Test | Boundary | Failure it distinguishes |
|---|---|---|
| `lib/media/__tests__/mp4.test.ts` (new) | pure reader over §8.2's committed bytes and `tiny-video.mp4` (High, §8.1) | a profile read from the wrong byte (Baseline, Main, High, High 10, HEVC Main and Main 10, MPEG-4 Simple and Advanced Simple each read as itself); a sound-only, two-video, subtitle or MP3-audio file accepted; the 200-byte prefix of `pattern-h264-main-aac.mp4` read as anything but `unreadable` |
| `lib/media/__tests__/wav.test.ts` (new) | pure, ffmpeg files and in-code WAVs | an 8- or 16-bit PCM file refused; a 24-bit, float or mu-law file accepted; a `LIST` chunk of odd size before `fmt ` read without its pad byte; a 12-byte file read as anything but `unreadable` |
| `lib/media/__tests__/ico.test.ts` (new) | pure, ffmpeg files and edited bytes | the two ICOs not read at 64 by 64; type 2 not read as a cursor; an entry offset past the end, or a DIB with `biCompression` 3, accepted |
| `lib/media/__tests__/amrMidi.test.ts` (new) | pure, `builtFixtures.ts` | NB and WB not read as AMR; multichannel or empty accepted; a MIDI of format 0 with two tracks accepted |
| `lib/media/__tests__/validate.test.ts` (extended) | the pipeline over real bytes | each accepted fixture without its `mediaFormat`, MIME and extension; each refusal of §3.8 caught by another gate or with other copy; a `.svg` filename, and a claim of `image/svg+xml` (and of `Image/SVG+XML; charset=utf-8`) under the name `x.png` over PNG bytes, not refused with `SVG_REFUSAL_MESSAGE` at stage 1; `pattern-matroska.webm` not `extension-mime-mismatch`; `tiny-video.mp4` not `mp4-h264-high` at 520 ms; AMR and MIDI given a duration; `classifyStoredMediaBytes` not `unplayable` for `tone-24.wav` stored as `audio/wav`, `pattern-h264-high10.mp4` stored as `video/mp4`, and a PNG stored as `image/gif` |
| `lib/media/__tests__/platformPlayback.test.ts` (new) | pure over `buildDoc` documents | a reference of each carrier kind missed or misnamed; a built-in icon judged; a both-declared app with an ICO option and an AMR menu label not refused with the exact copy of §6.1's both-platforms example (one sentence per platform, then the closing sentence); one plays-nowhere file not "No CommCare app can play"; a judgment admitting a ready row with no `mediaFormat`; `formatUnavailableReason` refusing MP4 in a both-declared app or allowing ICO; "runs on Web Apps" or "Plays on Web Apps" anywhere in the copy (each place reads `inPlatform` or `platformDeclarationPhrase`); `assetUnavailableReason` and `playsOnLine` copy; `browserStandIn` giving a line for an `unplayable` row, a row with no format, a variant Web Apps plays or an image, or none for an AMR or HEVC row |
| `lib/media/__tests__/attachVerdicts.test.ts` (extended) | pure judgment | an HEVC video attached to a both-declared app, an ICO to an Android-only app or an `unplayable` file accepted, or refused with other copy |
| `lib/commcare/validator/rules/media/__tests__/mediaFormatPlays.test.ts` (new) | pure rule over `mediaRecords` | a reference refused on a platform its app does not declare; a missing, pending, wrong-kind or document row judged by this rule; details missing `missingPlatforms` |
| `lib/media/__tests__/boundaryValidation.test.ts` (extended) | the export composer | an Android-only file in a both-declared app passing the boundary |
| `lib/db/__tests__/addReferencingApp.postgres.test.ts` (extended) | real Postgres through the production commit kernel | an Android-only app's commit of an AMR label refused; the batch clearing its `runsOnlyOn` admitted, or refused with copy other than §6.1's (the carrier, "AMR" and "Web Apps"); a both-declared app's genesis holding an ICO admitted; a thread attachment of an AMR in a both-declared app's thread refused |
| `lib/db/__tests__/mediaAssetDoc.postgres.test.ts` (extended) | real Postgres | `media_format` not round-tripping; an image row with `mp3`, or an unknown key, accepted by the value domain; a `NULL` read as anything but absent |
| `lib/case-store/migrations/__tests__/mediaFormat.postgres.test.ts` (new in pull request 7; the one file for both media-format migrations, part 09 §15 adding its validation cases in pull request 13; kept after the removal) | real Postgres, main's prefix then the stack's migrations | pull request 7's migration failing over existing ready media rows with no format (`NOT VALID` must keep them), or admitting, after it, a ready image, audio or video insert, or a `pending` to `ready` update, without a format (it must refuse naming `media_assets_ready_media_format`), or an image row holding `mp3` (it must refuse naming `media_assets_media_format_known`); pull request 13's validation migration failing over an empty table or a fully recorded one, or validating over one ready image with no format (it must refuse with its message, the constraint still `NOT VALID`). The presence check holds every insert from pull request 7's migration on, so a row without a format exists only if it is written first: each such case migrates to the prefix ending at `20261101010000_hq_round_trip_platforms_form_entry_sync`, the migration before pull request 7's, inserts its ready rows there, then migrates through `20261101020000_hq_round_trip_platforms_media_format`; pull request 13's cases go on through `20261101025000_hq_round_trip_platforms_android_capture_size` and the validation migration and read `pg_constraint.convalidated` |
| `lib/media/__tests__/moveMedia.test.ts` (extended) | the production copy | a copy into another Project losing `mediaFormat` |
| `lib/mcp/__tests__/uploadMediaAsset.postgres.test.ts` (extended) | real Postgres through the MCP tool | an uploaded HEVC file stored without `mp4-hevc`; an SVG not refused with `SVG_REFUSAL_MESSAGE` |
| `app/api/media/upload/[assetId]/confirm/__tests__/route.test.ts` and `app/api/media/upload/__tests__/route.test.ts` (extended) | the routes with their boundaries mocked as today | the confirm not passing `mediaFormat`; initiate answering an SVG claim with the generic sentence |
| `lib/db/__tests__/runtimeDatabaseProbe.test.ts` (extended) | the probe's audit with its reads mocked as the suite does today | an Android-only file referenced by a both-declared app not counted as a media finding |
| `lib/commcare/__tests__/mediaWireFixtures.test.ts` (new) and `proof/corpus/__tests__/editBatches.test.ts` (extended) | the production classifier over the fixtures' bytes | a stand-in format that the bytes are not (§8.1) |
| `lib/commcare/surface/__tests__/manifest.test.ts` (rewritten block, §7.3) | the registry against the items | a variant's platforms off its item's readings; an item that plays somewhere neither accepted nor refused |
| `proof/checks/test_manifest_value_classes.py` (extended) | the lane's reader | an SVG use not in `image-svg`'s class |
| `proof/native/test_media_emission.py` (extended, §8.3) | HQ's own bulk upload in the proof image | a new variant HQ types as another kind or cannot store; an SVG that does not stop the whole upload |
| `e2e/tests/browser/media-play.spec.ts` (extended, §8.4) | Chromium headless shell and WebKit in CI | a format Web Apps is held to play that a browser engine does not |
| `e2e/tests/app/preview-android-media.spec.ts` (new Playwright smoke, `@seed:preview-android-media`) | the production build over the seed below, the real resolve route with no `page.route` mock | the player shown instead of "This audio plays on Android devices. Your browser can't play it here.", or the stand-in missing because the route did not carry the row's `mediaFormat` and `playsOn` |
| `lib/domain/__tests__/multimedia.test.ts` (rewritten cases, §2.2) | the registry | a media entry with no variant, a variant naming a document entry, or a partition out of registry order |

**The smoke's seed.** `e2e/CLAUDE.md` gives every authenticated test one typed `@seed:` profile
whose seed owns its prerequisites, and no seed writes a media row today, so pull request 7 adds the
profile `preview-android-media`: its name in `e2e/lib/smokeProfiles.ts::SMOKE_PROFILES`, its entry
in `e2e/lib/smokeSeedFactory.ts` (data `previewAndroidMedia: { appId, assetId, route }`), and its
blueprint in `e2e/lib/previewRuntimeSeeds.ts` (`PREVIEW_ANDROID_MEDIA_SEED`,
`buildPreviewAndroidMediaBlueprint(appId, assetId)`, `previewAndroidMediaRoute(appId)`), held by
`e2e/lib/previewRuntimeSeeds.test.ts` beside the other builders. The entry writes everything
through production writers: `lib/db/mediaAssets.ts::createReadyAsset` makes one ready audio row in
the seed's Project from `builtFixtures.ts::amrNb()` (`audio/amr`, `.amr`, its SHA-256 and size,
`mediaFormat: "amr"`), and `seedRuntimeApp` births an app whose `appSettings.runsOnlyOn` is
`"android"`, with one survey form whose text question's `label_media.audio` is that row, through
`appendSyntheticBatch`, so the commit kernel admits the reference as it admits any (§6.2). The spec
opens the form in Preview and reads the stand-in from the real library route; Preview never asks for
the bytes (§6.6), so the seed stores none.

**Tests whose ready media rows meet a judgment.** From pull request 7 every judgment reads a
missing format as `unplayable` (§6.1, §6.2, §6.7), so each test or spec that hands a ready image,
audio or video row to the kernel, the export boundary, the attach verdict or the builder writes the
format its bytes are, or for a row with no bytes the stand-in key of its MIME (the MIME's one
variant; `mp4-h264-main`, `ogg-vorbis` or `webm-vp8` where a MIME has several). Found at `main` by
`rg -l 'status: "ready"'` over test files and `e2e`, narrowed to rows of a media kind that reach
one of those judgments:

- `app/api/compile/__tests__/route.test.ts`: `ROW` gains `mediaFormat: "png"`, and the audio
  variant of "runs the real media gate before downloading a mismatched asset" `mp3`, so that case
  stays a kind mismatch alone.
- `__tests__/integration/media-validation.test.ts`: `record()` writes `png`, and its two
  `audio/mpeg` overrides (`pending-audio`, `audio-asset`) write `mp3`, so the repaired manifest
  still runs clean.
- `proof/corpus/__tests__/publishReadiness.test.ts`: `storedRow` writes the stand-in key of the
  uploaded file's MIME (`png`, `wav-pcm`), which `classifyStoredMediaBytes` of its bytes equals.
- `lib/commcare/validator/rules/media/__tests__/fixtures.ts::makeAssetRecord`: the stand-in key of
  the record's MIME unless an override names one; the rule tests that pass `mediaRecords` get it
  from §8.1's manifest.
- `lib/agent/tools/media/__tests__/fixtures.ts::seedTestAsset`: `TestAssetRow` gains `mediaFormat`,
  the stand-in key of its kind (`png`, `wav-pcm`, `mp4-h264-main`) unless an override names one, so
  `attachFieldMedia.test.ts`, `attachOptionMedia.test.ts` and `menuMedia.test.ts` keep their
  admissions.
- The Playwright specs that answer a library or resolve route with a media row,
  `e2e/tests/app/media-library.spec.ts`, `e2e/tests/browser/builder-controls.spec.ts`,
  `media-authority.spec.ts`, `chat-controls-audit.spec.ts` and `case-workspace-audit.spec.ts`: each
  row gains the `mediaFormat`, `formatLabel` and `playsOn` the production route returns for it
  (§5.4), so the builder's guard admits what it admitted.

`useAttachBudgetGuard`'s platform arm and `useReferencedAssetRows` are covered through the pure
functions they call and the smoke above; no jsdom test of a component is added.

---

## 11. Files

New: `lib/media/mp4.ts`, `wav.ts`, `ico.ts`, `amr.ts`, `midi.ts`, `platformPlayback.ts`;
`lib/commcare/validator/rules/media/mediaFormatPlays.ts`;
`components/builder/media/useReferencedAssetRows.ts`, `MediaStandIn.tsx`;
`lib/case-store/migrations/20261101020000_hq_round_trip_platforms_media_format.ts`; §8.2's fixtures
(the five raster images among them) and `lib/media/__tests__/builtFixtures.ts`; the new tests of
§10, and `e2e/tests/app/preview-android-media.spec.ts`.

Rewritten: `lib/domain/multimedia.ts` (`MEDIA_FORMATS`, the six entries, `surfaceKeys` removed,
`imageFormatNoun`); `lib/media/validate.ts` (the dispatch, `mediaFormat`,
`classifyStoredMediaBytes`, `SVG_REFUSAL_MESSAGE`, `matroskaRefusal`); `lib/media/webm.ts`
(`readVp9Profile`'s doc comment, §3.7); `lib/media/attachVerdicts.ts`;
`lib/media/moveMedia.ts`; `lib/media/builtinIconAssets.ts`; `lib/db/pg.ts`, `lib/db/types.ts`,
`lib/db/mediaAssets.ts` (row, writers, `WireMediaAsset`, `MediaReferenceRequirement`,
`MediaReferenceProjectionError`, `lockAndValidateMediaReferences`); `lib/db/canonicalCommitKernel.ts`;
`lib/db/runtimeDatabaseProbe.ts`; `lib/case-store/migrations/index.ts`;
`app/api/media/upload/route.ts`, `app/api/media/upload/[assetId]/confirm/route.ts`;
`lib/mcp/tools/uploadMediaAsset.ts`; `lib/commcare/validator/errors.ts`, `gate.ts`, `runner.ts`,
`rules/media/index.ts`; `lib/doc/userFacingErrors.ts`; `lib/session/store.ts` (`AssetMetaRow`);
`components/builder/media/useAttachBudget.ts`, `MediaDisplay.tsx`, `AssetPreviewDialog.tsx`,
`MediaPickerDialog.tsx` (the SVG sentence); `lib/commcare/surface/media-formats.json`,
`entries/expressions-and-data.json` and its `.md` (their text is part 02 §7's);
`lib/commcare/surface/__tests__/manifest.test.ts`;
`lib/commcare/__tests__/mediaWireFixtures.ts`; `proof/corpus/editBatches.ts`;
`proof/checks/manifest_value_classes.py` and its test (part 02 §7.3); `proof/native/producers/emit-media-evidence.ts`,
`proof/native/steps/media_emission.py`, `proof/native/test_media_emission.py`,
`proof/native/core/MediaRuntimeTest.java`; `proof/android/decode/probe.py`, `run.sh`;
`proof/android/decode/DecodeProbe.java` (images by extension, §8.5);
`e2e/tests/browser/media-play.spec.ts`; `scripts/rollout/verify-runtime-packages.mjs`;
`e2e/lib/smokeProfiles.ts`, `e2e/lib/smokeSeedFactory.ts`, `e2e/lib/previewRuntimeSeeds.ts` and
`previewRuntimeSeeds.test.ts` (the `preview-android-media` profile, §10).

Tests that change because a reader or a writer moved, beside the new ones of §10:
`lib/domain/__tests__/multimedia.test.ts` (§2.2); the Postgres suites of §5.3, with
`lib/case-store/migrations/__tests__/mediaUploadAliases.postgres.test.ts`; the rows of §10's "Tests
whose ready media rows meet a judgment" (`app/api/compile/__tests__/route.test.ts`,
`__tests__/integration/media-validation.test.ts`, `proof/corpus/__tests__/publishReadiness.test.ts`,
`lib/commcare/validator/rules/media/__tests__/fixtures.ts`,
`lib/agent/tools/media/__tests__/fixtures.ts`, and the five Playwright specs it names).

In pull request 11, beside part 07's files: `lib/db/mediaAssets.ts::loadAssetsByIds` gains its
optional executor and `lib/media/attachVerdicts.ts::mediaDeclarationVerdict` takes it (§6.5);
`lib/media/platformPlayback.ts` is unchanged there.

`CLAUDE.md` files, in pull request 7, by part 10's rows marked 7, whose text is part 10's:
`lib/media/CLAUDE.md`'s six rows (the heading "Accepted formats are the ones every platform plays"
becomes "Accepted formats and where they play"; the registry sentence names `MEDIA_FORMATS` beneath
each MIME with its item and its platforms; SVG refused with HQ's fact first, then the script
container; the second paragraph's union at upload, the variant on the row, `unplayable`, and
acceptance per reference at the kernel, the attach verdicts, the boundary and the builder; the WebM
bullet becoming the MKV rule of §3.7; the last paragraph naming the readers of §3 and where each
variant plays); the root `CLAUDE.md`'s "The map" `lib/media` row (adds "Upload accepts a file some
CommCare platform plays, and an app references it only where every platform the app runs on plays
it."); `lib/domain/CLAUDE.md` (the registry paragraph names `MEDIA_FORMATS` and drops the items each
`ACCEPTED_FORMATS` entry admitted); `lib/session/CLAUDE.md` (`assetMeta` rows carry their
`mediaFormat`); `proof/README.md` (the native `media` family's three scenarios).

Public docs and contracts, in pull request 14:

- `content/docs/building-with-nova.mdx`, the media paragraph becomes: "The images, audio and video
  you upload can be PNG, JPEG, GIF, WebP, BMP, ICO or AVIF images, MP3, WAV, M4A, FLAC, Ogg, AAC,
  AMR or MIDI audio, and MP4, WebM or MKV video. Nova checks each file as you add it and shows where
  it plays: ICO and AVIF images play only in Web Apps, and AAC, AMR and MIDI audio, MP4 with HEVC
  or MPEG-4 Part 2 video and MKV play only on Android. A file goes in
  an app where it plays on every platform the app runs on. SVG images can't be used, because
  CommCare HQ can't store them."
- `content/docs/mcp/tools.mdx`, the `upload_media_asset` row: "Upload an image, audio, or video file
  (sent as base64) and get back its asset id. Media libraries are per-Project: pass `project_id` to
  upload into a shared Project's library (use the Project of the app that will reference it); omit
  it for your personal Project. Images are `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.ico` or
  `.avif`; audio is `.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.aac`, `.amr` or `.mid`; video is
  `.mp4`, `.webm` or `.mkv`. Some formats play only in Web Apps or only on Android:
  `list_media_assets` shows where each file plays, and an app takes a file only where it plays on
  every platform the app runs on."
- `docs/architecture/complex-apps.md`, "Media", gains: "Each media asset stores the variant its
  bytes are (`media_assets.media_format`, `lib/domain/multimedia.ts::MEDIA_FORMATS`). Upload accepts
  a variant that plays on at least one platform and that HQ types and stores as its kind; a
  reference is accepted only where its file plays on every platform the app declares, held at the
  commit kernel's media admission on every editor and at the export boundary
  (`MEDIA_FORMAT_NOT_PLAYED`)."
- `docs/architecture/contracts.md`, "Deliberate target gaps", gains part 10's new bullet after
  "Smart links belong to data registries": "**SVG images never ship.** HQ types an SVG as an image
  and cannot store it (Pillow reads none), and one SVG stops a whole bulk upload, so Nova refuses
  SVG at upload for every app (`lib/media/validate.ts::SVG_REFUSAL_MESSAGE`)." Acceptance by declared platform is recorded in
  `complex-apps.md`'s "Media" (above) and `lib/media/CLAUDE.md` (pull request 7); `contracts.md`
  has no media row to change.

The nova-plugin sweep finds no skill naming a media format, so no plugin change rides this part.

---

## 12. How this part lands in the stack

**Pull request 7, media by platform**, stacked on pull request 6, after pull request 4's
declaration. In order of its commits: the registry and the readers with their tests; the migration
and the row; the kernel, attach and boundary rules; the builder guard, `useReferencedAssetRows` and
the Preview stand-in; the manifest edits, with the planning decode run's mark on H.264 High (§8.5),
and the SVG reader; the native scenarios, the browser spec and the probe lists. Its CI shows the
browser outcomes (§8.4), and the native `media` family's three scenarios run in the pull request's
own lane, as every native family does (part 08 §5.3). It moves no corpus document's key (§8.1), so
no reader run by hand is made for it (part 08 §6.3): every reader reads the corpus as main's
records hold it, and the first scheduled night after the merge reads it whole (part 08 §6.4).

**Pull request 11** (part 07 §2.3, §2.5): the pickers' per-asset reasons, the Upload tab's format
reasons, the file manager's line and the platform section's server-side preflight, from §6.4 and
§6.5.

**Pull request 12** (part 07 §3.3): `updateApp`'s media pre-check when `runs_only_on` adds a
platform (§6.5).

**Pull request 13** (part 09): §9, and the migration that validates `media_assets_ready_media_format`
(§5.2, part 09 §8).

**Pull request 14**: §11's public docs and contracts.

Pull request 15 adds nothing of this part's.

## What changes for a person

- Uploading accepts more: ICO and AVIF images, AAC, AMR and MIDI audio, and MKV video, and MP4s of
  HEVC or MPEG-4 Part 2 are now told apart from the rest. SVG is refused with a sentence that says
  why and what to do.
- A file shows where it plays. One that the app's platforms cannot play cannot be attached, and the
  refusal says which platform, which format, and how to export it again.
- Turning a platform on for an app that holds a file it cannot play is refused, with every such
  file and its place named.
- Preview shows a line where a file plays only on Android.
- An H.264 video, Baseline, Main or High, goes into an app on either platform or both, so the
  High video a phone camera records attaches as it does today and the cutover removes none (§8.5).

## Executed during planning

- **The video fixture's `avcC`.** A box walk over `tiny-video.mp4`, read only: `ftyp` `isom`; one
  `vide` track; `avc1` 32 by 32; `avcC` version 1, profile 100, level 10; `mdhd` timescale 12800,
  duration 6656; 13 samples; no audio track.
- **Pillow 12.3.0** (the version `commcare-hq/uv.lock` pins), on the author's Mac: an ICO opened as
  `ICO (32, 32)`, AVIF opened with `features.check('avif')` true, SVG raised `UnidentifiedImageError`.
- **`file-type` 22.1.1 sniffs**: `image/x-icon` for ICO, `audio/aac` for ADTS, `audio/amr`,
  `audio/midi`; and its source read for MKV (`video/matroska`) and the `#!AMR` prefix.
- **`music-metadata` 12.2.0 read, not run**: its MPEG parser's ADTS header and loader table, and its
  list of parsers (no AMR or MIDI).
- **The local ffmpeg's encoder and muxer lists** (Homebrew ffmpeg 9.0.2): libx264, libx265, mpeg4,
  libsvtav1, libmp3lame, aac, the PCM encoders, `mov_text`, and the `ico`, `avif`, `adts` and
  `matroska` muxers are present; no AMR encoder, no MIDI muxer, no WebP encoder, which is why §8.2
  builds AMR and MIDI in code and makes the raster images once with sharp.
- **The corpus census of video bytes**: every `media` entry of every document and edit of a corpus
  emitted at `main` hashed against the fixture; 46 documents hold it, no other video appears, so
  the decode run of that one file covers every video the corpus emits.
- **Android's decode probe**, on the person's Mac on 2026-10-23 at their request
  (`proof/android/decode/run.sh` as it stands at `main`): the three emulator images whose
  fingerprints are `android-decode`'s readers each decoded `tiny-video.mp4` (H.264 High) to the end
  of its stream, 13 frames, with `OMX.google.h264.decoder` (6.0), `c2.android.avc.decoder` (10) and
  `c2.goldfish.h264.decoder` (15); every other fixture matched step 2's records but
  `pattern-h264.m4a`, which Nova refuses at upload (§8.5).
- **The content-free production scan**, read only, which the person approved: production holds
  ready image rows of JPEG and PNG and document rows, and no audio or video row (§9). No count from
  it enters this plan.

Nothing was run in HQ, Core or a lane for this part; §8 says what each remaining run will record
and what each outcome changes.

## Departures from the decision spine

None. The presence check is pull request 7's migration, `NOT VALID`, validated after the backfill by
pull request 13's, as the spine places it; the cutover applies both inside its fleet transaction
(part 09 §8), which is what keeps the check from holding the old revision's writes (§5.2).
