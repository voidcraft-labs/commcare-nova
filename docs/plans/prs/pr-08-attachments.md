# PR-08: Attachments — capture to case

*Self-contained implementation plan. Verified 2026-07-06 end-to-end (HQ + formplayer +
commcare-core + cloudcare) — the verdict table below is the ground truth; it corrects the
F4 plan's too-narrow "attachments are dead in Web Apps" line (the parser fact stands; the
conclusion didn't).*

**Goal.** A captured photo/file/signature can be **persisted onto a case**, not just onto the
form submission — configured on the capture field itself, executed in the preview against
Nova's own storage, and emitted in the mode the deployment can actually *see*. Nova ships
both wire modes with the visibility trade stated in the UI, because they genuinely differ:

- **Attachment mode** (CommCare `<attachment>` case block): canonical, HQ case page +
  Android display — but **Web Apps cannot display it in-app** (verified: no formplayer
  serving path; restore emission gated behind the deprecated `MM_CASE_PROPERTIES` toggle and
  dropped by the no-op parser anyway).
- **URL-property mode** (store the file's resolvable URL as a plain case property): the
  pattern HQ's own code documents apps using deliberately
  (`reports/views.py::view_form_attachment` — "the link… is created in the apps and saved as
  case properties") — displays in **Web Apps** case lists/details via the `picture` image
  format, and everywhere else.

## Verified contracts (per-surface verdict table — cite these, do not re-derive)

| Capability | Verdict | Citation |
|---|---|---|
| Capture image/file/audio/video/signature in a Web Apps form | Works | `cloudcare/.../form_entry/entries.js::ImageEntry/DocumentEntry/AudioEntry/VideoEntry/SignatureEntry`; `formplayer/.../FormController.java::answerMediaQuestion` |
| Submission carries the files (multipart), visible on the HQ form page | Works | `FormSubmissionHelper.java::getMultiPartFormBody`; `form_processor/submission_post.py`; caps: 4 MB/file (`MediaValidator.kt`), 50 files, 5 MB request (`application.properties`) |
| Persist onto a case via `<attachment from="local">` | Server + Android + HQ case page; **no Web Apps in-app display** | generation `xform.py::CaseBlock.is_attachment` (upload-source detection → attachment element + `@src` calculate + `count()=1` relevant); processing `update_strategy.py::_apply_attachments_action` (links the form blob); fixture `form_preparation_v2/update_attachment_case.xml`; the Web Apps gap: `FormplayerCaseXmlParser` no-op hooks + `generator.py::add_attachments` behind `MM_CASE_PROPERTIES` (TAG_DEPRECATED) + no formplayer serving endpoint (searched) |
| Display an image-valued case property in Web Apps case detail/list | Works when the value is an `http(s)://` URL (passthrough) or static app media | `detail_screen.py::Picture` (`template_form='image'`, plain `{xpath}`); `cloudcare/.../views.js::resolveUri` → `app.js::resourceMap`; also the `cc_case_image` micro-image reserved property |
| Remove/replace a case attachment | Server + Android (empty `<attachment>` = removal) | `CaseXmlParser.java::processCaseAttachment` removal branch; `update_strategy.py` track_delete |

Client-side parser facts that shape emission: `processAttachment` returns null in
formplayer (reference never stored locally — harmless, display is server-routed);
attachment-only blocks share the index-arm's null-deref shape (`loadCase(errorIfMissing=
false)`), so the PR-03 emitter guard (always pair with `<update/>` on non-create blocks)
applies to attachment-carrying blocks too.

## Nova baseline (what exists)

Nova already has media capture field kinds (the `mediaCaseProperty` validator currently
REJECTS them carrying `case_property_on` — `lib/commcare/CLAUDE.md` records the deliberate
block and names the lift as a separate feature: "lift the rejection + emit on both pipelines
+ CCZ media bundling"). Captured bytes in the preview go through Nova's media store (GCS,
Project-scoped, `lib/media` + `lib/storage`).

## Build

1. **Domain**: media capture kinds gain `save_to_case?: { mode: "attachment" | "url-property" }`
   valid only with `case_property_on` set; lift `mediaCaseProperty` for exactly these shapes
   (the rejection stays for media kinds with `case_property_on` and NO mode — the old
   ambiguous state remains unconstructible). Validator codes + class rows + repair judgments;
   reference indexing unchanged (property identity already flows through `case_property_on`).
2. **Wire — attachment mode**: both paths emit the verified shape (attachment element named
   by the field's property id, `from="local"`, `@src` calculated from the upload node,
   `count()=1` relevant guard), pinned against `update_attachment_case.xml`; on the HQ-upload
   path this rides the FormActions-adjacent source the same way PR-03's op blocks do (HQ
   regenerates ITS attachment blocks only from its own config — Nova's are source-carried,
   preserved per the verified append-only render). The PR-03 `<update/>` pairing guard
   extends to attachment-carrying blocks.
3. **Wire — url-property mode**: the property's value is a calculated URL to the submission
   attachment (`concat(<view_form_attachment base>, /data/meta/instanceID, '/', <filename>)`
   — implementer verifies the exact HQ URL shape from `reports/urls.py` at build time and
   pins it in a fixture; auth caveat documented: the URL is HQ-session-gated, which is the
   same property the field practice relies on). Emitted as an ordinary case-property write —
   no attachment block.
4. **Preview**: captured files store as Project-scoped media objects; attachment mode
   materializes a preview-side case-attachment record (Nova's store gains a small
   `case_attachments` table: case_id, name, asset id) rendered in the preview's case detail;
   url-property mode stores the Nova-served URL in the property and the preview's `picture`
   column machinery renders it — the preview thereby demonstrates BOTH modes' actual
   visibility semantics (attachment-mode images render in the preview case detail with a
   "visible on HQ/Android, not Web Apps case screens" caption; url-property images render
   exactly as Web Apps would).
5. **Case-list/detail display**: the `picture`-format column arm on case-list columns
   (image-from-expression — distinct from the existing `image-map`), rendering resolvable
   URLs; plus the `cc_case_image` reserved-property note in docs.
6. **SA + docs**: guidance chooses the mode from the deployment story (Web-Apps-first ⇒
   url-property; Android/HQ-review ⇒ attachment; both is legal — two fields or one field +
   one hidden calculate); the 4 MB/50-file caps surfaced; docs page grounded in what the
   user sees on each surface (the verdict table, prose-ified).

## Tests / acceptance

Fixture-pinned emission for both modes; preview round-trip (capture → submit → case detail
shows the image) for both modes; the unconstructible-ambiguous-state gate; oracle/fuzz
extensions for the attachment block shape; `lint/typecheck/test` clean. Acceptance, user-
phrased: "I add a photo question, tick 'save to the case', pick where it should be visible,
and after submitting I see the photo on the case — in the preview immediately, and on the
surfaces the mode I picked supports, which the UI told me up front."

## Non-goals

Serving Nova-hosted bytes to real CommCare runtimes (the preview serves Nova's copies;
production surfaces resolve HQ's); fixing Web Apps' missing case-attachment path upstream
(worth an upstream issue — noted for the same conversation as the F6 API push); audio/video
case-list rendering (image only in v1 — columns; playback stays form-level).

## Open choices (implementer)

- The url-property URL shape: verify `view_form_attachment`'s exact route + whether a
  stable non-session-gated variant exists before choosing the emitted base; if none, keep
  the session-gated URL and say so in the field's helper copy.
- Whether attachment-mode preview records ride the media store's GC rules or pin (recommend
  pin while the case row lives; delete with the case).
