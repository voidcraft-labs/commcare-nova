# PR-08: Attachments — capture to case

> [!WARNING]
> **Execution superseded as of 2026-07-21.** Do not implement or sequence this legacy PR
> directly. Use the [Complex App Roadmap](../complex-app-roadmap.md) as the execution source
> of truth. This file remains as historical research, verified emission evidence, and design
> rationale; where it conflicts with the roadmap, current code, or current `CLAUDE.md`
> contracts, the current sources win.

## 2026-07-21 rebaseline

**Roadmap mapping:** capture/storage lifecycle and production emission/presentation are
split across **S13 and S14**; do not implement this document as one attachment PR.

- **Link-first URL-property mode is the default.** Store the URL as text and present an
  explicit link on supported case surfaces. Do not default to a picture column while Web
  Apps' HTTPS resource passthrough remains broken; inline-image emission is a later,
  capability-backed enhancement.
- `<attachment>` compatibility mode is never inferred or offered as a portable default. It
  is available only when deployment capability is known and the deprecated
  `MM_CASE_PROPERTIES` mode is explicitly enabled, with the limitation visible before the
  user selects it.
- Case captures need a staged upload/submission lifecycle, tenant keys, compensation and
  orphan cleanup, and distinct provenance/library visibility from reusable Project media.
  GCS and Postgres writes are not one transaction.
- URL emission must be target-aware: a generic local `.ccz` compile cannot invent an HQ
  origin/domain. The runtime field value supplies the attachment filename in the verified
  HQ bytes route. The source findings and verdict table below remain authoritative evidence.

*Self-contained implementation plan. Verified 2026-07-06/07 end-to-end (HQ + formplayer +
commcare-core + cloudcare) — the verdict table below is the ground truth; it corrects the
F4 plan's too-narrow "attachments are dead in Web Apps" line AND this plan's own earlier
draft, which under-read two gates (both now verified at source): the server-side attachment
processing is itself flag-gated, and cloudcare's URL passthrough is `http://`-only.*

**Goal.** A captured photo/file/signature can be **persisted onto a case**, not just onto the
form submission — configured on the capture field itself, executed fully in the preview
against Nova's own storage, and emitted honestly: the UI states, per mode, exactly which
production surfaces can see the result today. The blunt platform truth this PR ships around:
**no production CommCare surface renders a case-persisted image inline without either a
deprecated domain flag (attachment mode) or a one-line upstream cloudcare fix (url-property
images)** — so Nova's preview is the primary visibility surface at launch, the case data is
correct and durable everywhere, and both upstream unlocks are named and tracked.

- **URL-property mode (default)**: store the file's HQ bytes-endpoint URL as a plain case
  property. Data works everywhere; in Web Apps case lists/details it renders as a
  **clickable link column today** (opens the image/file), upgrading to inline images when
  the upstream `resourceMap` https passthrough lands. The pattern HQ's own code documents
  apps using deliberately (`reports/views.py::view_form_attachment` docstring — "the link…
  is created in the apps and saved as case properties").
- **Attachment mode (flag-gated compatibility)**: the CommCare `<attachment>` case block.
  **Server-side processing only runs on domains with the deprecated `MM_CASE_PROPERTIES`
  toggle** — on a stock domain the block parses and is silently dropped. Offered only with
  that prerequisite stated in the field UI and the deployment notes; for flagged domains it
  yields HQ-case-page + Android display.

## Verified contracts (per-surface verdict table — cite these, do not re-derive)

| Capability | Verdict | Citation |
|---|---|---|
| Capture image/file/audio/video/signature in a Web Apps form | Works | `cloudcare/.../form_entry/entries.js::ImageEntry/DocumentEntry/AudioEntry/VideoEntry/SignatureEntry`; `formplayer/.../FormController.java::answerMediaQuestion` |
| Submission carries the files (multipart), visible on the HQ form page | Works | `FormSubmissionHelper.java::getMultiPartFormBody`; `form_processor/submission_post.py`; caps: 4 MB/file (`MediaValidator.kt`), 50 files, 5 MB request (`application.properties`) |
| Persist onto a case via `<attachment from="local">` | **Flag-gated end-to-end**: server processing early-returns without the deprecated `MM_CASE_PROPERTIES` toggle (`update_strategy.py::_apply_attachments_action` opens `if not toggles.MM_CASE_PROPERTIES.enabled(...): return` — verified verbatim), so on a stock domain the block is parsed then silently dropped. WITH the flag: HQ case page + Android display; Web Apps in-app display never (no formplayer serving path; restore emission behind the same flag; `FormplayerCaseXmlParser` no-op hooks) | generation `xform.py::CaseBlock.is_attachment`; fixture `form_preparation_v2/update_attachment_case.xml`; `toggles/__init__.py::MM_CASE_PROPERTIES` (TAG_DEPRECATED) |
| Display an image-valued case property inline in Web Apps case detail/list | **Not today**: cloudcare's passthrough is literally `resourcePath.substring(0, 7) === 'http://'` — an `https://` URL falls into the app multimedia-map lookup and returns `undefined` (broken `<img>`), and a real `http://` URL would be mixed-content-blocked inside the https page. Every image cell funnels through it (`case_list/item.html`, `case_detail.html`, `tile_item.html` → `resolveUri` → the `resourceMap` channel) | `cloudcare/.../formplayer/app.js` (`resourceMap` reply); `menus/views.js::resolveUri`; `detail_screen.py::Picture` remains the correct wire format for when the passthrough is fixed |
| Display the URL as a clickable link in Web Apps | Works (plain text column renders the URL; markdown link formatting per the runtime's markdown itext support) | `detail_screen.py` plain/markdown formats |
| The bytes endpoint for machine-rendered images | `GET /a/<domain>/api/form_attachment/v1/<instance_id>/<attachment_id>` (`name="api_form_attachment"`) — a `StreamingHttpResponse` with the attachment's MIME type. The reports route (`form_data/<instance_id>/attachment/<attachment_id>`) is a human HTML **viewer page**, not bytes — never target it from an image column | `corehq/apps/api/object_fetch_api.py::view_form_attachment` + `api/urls.py` (verified); `reports/views.py::view_form_attachment` (the HTML page) |
| Remove/replace a case attachment | Server (flagged domains) + Android (empty `<attachment>` = removal) | `CaseXmlParser.java::processCaseAttachment` removal branch; `update_strategy.py` track_delete |

Client-side parser facts that shape emission: `processAttachment` returns null in
formplayer (reference never stored locally); attachment-only blocks share the index-arm's
null-deref shape, so the PR-03 emitter guard (always pair with `<update/>` on non-create
blocks) applies to attachment-carrying blocks too.

**Upstream issues to file (tracked with the F6 API-push conversation):** (1) the cloudcare
`resourceMap` https passthrough (one line — unlocks inline url-property images in Web Apps);
(2) the Web Apps case-attachment serving path (larger — would unlock attachment-mode display
in Web Apps).

## Nova baseline (what exists)

Nova already has media capture field kinds (the `mediaCaseProperty` validator currently
REJECTS them carrying `case_property_on` — `lib/commcare/CLAUDE.md` records the deliberate
block and names the lift as a separate feature). Captured bytes in the preview go through
Nova's media store (GCS, Project-scoped, `lib/media` + `lib/storage`).

## Build

1. **Domain**: media capture kinds gain `save_to_case?: { mode: "url-property" | "attachment" }`
   valid only with `case_property_on` set; lift `mediaCaseProperty` for exactly these shapes
   (the rejection stays for media kinds with `case_property_on` and NO mode). Validator
   codes + class rows + repair judgments; reference indexing unchanged. **Mode default and
   framing**: `url-property` is the default; `attachment` is labeled "compatibility — needs
   the Multimedia Case Properties flag on your HQ domain (deprecated; enabled by Dimagi
   support)" in the field UI, and the prerequisite joins the deployment notes the same way
   wave-2's setup artifact carries HQ-side prerequisites.
2. **Wire — url-property mode (default)**: the property's value is a calculated URL to the
   **bytes endpoint**: `concat('<origin>/a/<domain>/api/form_attachment/v1/',
   /data/meta/instanceID, '/', '<attachment filename>')` — pin the route in a fixture
   against `api/urls.py::api_form_attachment` at build time; never the reports HTML-viewer
   route. Auth caveat documented: the endpoint is HQ-session-gated (the same property the
   documented field practice relies on). Emitted as an ordinary case-property write.
3. **Wire — attachment mode**: both paths emit the verified shape (attachment element named
   by the field's property id, `from="local"`, `@src` calculate, `count()=1` relevant
   guard), pinned against `update_attachment_case.xml`; source-carried on the HQ path (the
   verified append-only render); the PR-03 `<update/>` pairing guard extends to
   attachment-carrying blocks.
4. **Preview**: captured files store as Project-scoped media objects; both modes render
   inline images in the preview (Nova controls its renderer), each with an explicit
   production-visibility caption: url-property — "in CommCare Web Apps this shows as a
   link until the upstream image fix lands"; attachment — "has effect only on HQ domains
   with the Multimedia Case Properties flag; visible there on the HQ case page and
   Android". Attachment mode materializes a preview-side `case_attachments` record
   (case_id, name, asset id); url-property stores the Nova-served URL in the property.
   The preview-vs-production difference is stated, never blurred.
5. **Case-list/detail display**: the `picture`-format column arm (image-from-expression,
   distinct from `image-map`) — renders inline in the preview; on the Web Apps wire it is
   the correct format for the post-upstream-fix state, and v1 pairs it with a link-column
   fallback recommendation in the UI copy; plus the `cc_case_image` reserved-property note
   in docs.
6. **SA + docs**: guidance defaults to url-property with the link-today/image-later story
   stated; attachment mode suggested ONLY when the user's domain is known-flagged
   (Android/HQ-review deployments) — never silently; the 4 MB/50-file caps surfaced; the
   docs page is the verdict table prose-ified, per surface, exactly as a user experiences
   it.

## Tests / acceptance

Fixture-pinned emission for both modes (url fixture pins the bytes route); preview
round-trip for both modes; the unconstructible-ambiguous-state gate; oracle/fuzz extensions
for the attachment block shape; `lint/typecheck/test` clean. Acceptance, user-phrased:
"I add a photo question, tick 'save to the case', and after submitting I see the photo on
the case in the preview immediately — and the field told me, before I picked, exactly what
each mode shows on HQ, Android, and Web Apps today."

## Non-goals

Serving Nova-hosted bytes to real CommCare runtimes; landing the two upstream fixes (filed
and tracked, not built here); audio/video case-list rendering (image only in v1; playback
stays form-level).

## Open choices (implementer)

- Whether attachment-mode preview records ride the media store's GC rules or pin (recommend
  pin while the case row lives; delete with the case).
- The link-column fallback shape for url-property in v1 (plain text URL vs markdown link —
  pick what renders best in Web Apps' markdown itext path and pin it).
