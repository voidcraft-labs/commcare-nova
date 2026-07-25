# Unit 5 — Capture, storage, and submission lifecycle

**PR:** `Media capture in forms: staged upload, lifecycle, and case references`

**Depends on:** nothing outstanding. · **Blocks:** unit 6.

> Read [the binding contracts](00-contracts.md) first, and
> [what is built](../complex-app-plan.md#media) for the Project-scoped authoring
> media boundary this unit sits beside.

Implement image, audio, video, signature, and generic-file capture, staged
upload through submission.

Specify staged upload, cancellation, retry, required/relevant behavior, repeat
support, compensation and orphan cleanup, authorization, case-reference deletion
guards, and why case captures do not pollute the authoring media library.

This unit stops at the form. The `MEDIA_CASE_PROPERTY` validator rule
(`lib/commcare/validator/rules/form.ts::mediaCaseProperty`) keeps rejecting media
capture kinds that carry `case_property_on`, and unit 6 lifts it — writing a
capture onto the case is inseparable from emitting its URL column, so the two
ship together rather than leaving a field an author can tick and no export can
represent. Nothing here needs a deployment target, which is why it can go first.

## Binding facts

### The question shape

- The whole wire is `<bind type="binary">` plus `<upload ref mediatype>`. No
  suite entry, no app-level declaration. Fixture:
  `commcare-hq/corehq/apps/app_manager/tests/data/form_preparation_v2/attachment.xml`.
- `binary` is a non-standard bind type (`XFormParser`'s `typeMappings` carries the
  inline `//non-standard` comment), carried as `UncastData`
  (`AnswerDataFactory::templateByDataType` groups `DATATYPE_BINARY` with
  `BARCODE`/`UNSUPPORTED`/`NULL`) — so the answer is a plain string, never a typed
  binary value.
- **`mediatype` is a closed four-literal enum with no fallback.**
  `XFormParser::parseUpload` does literal `String.equals` against `image/*`,
  `audio/*`, `video/*`, and `application/*,text/*` (comma, **no space**) — no
  trimming, no case folding — remapping `CONTROL_UPLOAD` to `CONTROL_IMAGE_CHOOSE`
  / `CONTROL_AUDIO_CAPTURE` / `CONTROL_VIDEO_CAPTURE` / `CONTROL_DOCUMENT_UPLOAD`.
  Anything else leaves the control at `CONTROL_UPLOAD`, `entries.js::getEntry`
  falls through to `UnsupportedEntry`, and **`UnsupportedEntry`'s constructor sets
  the answer to the literal string `Not Supported by Web Entry`** — which then
  submits and, through the unit-6 seam, would be copied into a case attachment
  `@src`. The failure mode is silent bad data, not a visible error, so the emitter
  makes an unmatched `mediatype` structurally unrepresentable rather than checking
  for one.
- Signature is not a distinct control type: it is `image/*` plus
  `appearance="signature"`. `entries.js::getEntry` picks `SignatureEntry` only when
  `question.stylesContains(constants.SIGNATURE)` inside the `CONTROL_IMAGE_CHOOSE`
  case; `WidgetFactory::createWidgetFromPrompt` branches the same way on Android.
  So there are **three runtime control types behind four author-facing kinds**, and
  Nova models signature as its own kind because every worker-visible property
  differs — a canvas rather than a picker, `image/*,.pdf` rather than `image/*`,
  PNG output, and no restore on resume.
- `appearance="face"` is authorable in Vellum (`mugs/types/media.js::FaceCapture`)
  and inert everywhere Nova targets: no `face` branch in
  `WidgetFactory::createWidgetFromPrompt`, no occurrence in cloudcare's
  `entries.js` / `const.js` / `form_ui.js`. Offering it would be a dead
  affordance, so it stays out.
- `jr:imageDimensionScaledMax` is inert on Formplayer.
  `UploadQuestionExtensionParser` is registered only by
  `commcare-android/.../XFormExtensionUtils::getAllAndroidExtensionParsers`;
  Formplayer parses through `XFormUtils.getFormRaw` with no extension-parser list.
  Web Apps therefore also does no downscaling — the picked bytes are what uploads.
- HQ's app-summary inference has no signature row: `xform.py::VELLUM_TYPES` carries
  Audio / Document / Image / Video, and `_infer_vellum_type` resolves a signature
  question to `Image` through the index's deliberate appearance-agnostic fallback.
  Display-only in HQ's own surfaces; no wire effect.

### Generic-file capture

- It is a first-class Web Apps kind, not a fallback: `entries.js::DocumentEntry`
  carries `accept = ".pdf,.xlsx,.docx,.html,.txt,.rtf,.msg"` and
  `acceptedMimeTypes = "application/*,text/*"`, `getEntry` has a real
  `CONTROL_DOCUMENT_UPLOAD` branch, HQ models it
  (`xform.py::VELLUM_TYPES["Document"]`), and the receiver accepts those
  extensions. It is the only kind that sets `acceptedMimeTypes` as well as
  `accept`, because `FileEntry.onAnswerChange` prefers `acceptedMimeTypes` for both
  the extension-map lookup and the MIME match.
- **HQ dates document upload to CommCare 2.57**
  (`feature_support.py::support_document_upload`), and that gate is
  authoring-palette-only — its sole consumer is `views/formdesigner.py`, feeding
  `Vellum/src/core.js`'s question palette. `XFormParser::parseUpload`,
  `entries.js::getEntry`, and HQ's form validation carry no version check, so an
  emitted form renders regardless. What it forces is the profile: whatever minimum
  CommCare version Nova declares must be ≥ 2.57 while it offers this kind, or Nova
  claims a compatibility HQ itself does not.
- **Android has no handling for it at all** — `CONTROL_DOCUMENT_UPLOAD` appears
  nowhere in the checkout, so `WidgetFactory::createWidgetFromPrompt` falls to
  `default: new StringWidget(...)`. A worker types arbitrary text into a `binary`
  node and that string submits. Stated where the author picks the kind.

### Capture and staging in Web Apps

- Capture is an immediate round trip at pick time, not at submit:
  `entries.js::FileEntry.prototype.onAnswerChange` validates extension / MIME /
  size in the browser, then `form_ui.js::Question.triggerAnswer` →
  `web_form_session.js::answerQuestion`. The endpoint is `POST answer_media`,
  `multipart/form-data`, two parts named `file` and `answer`
  (`FormController::answerMediaQuestion`).
- Every request including `answer_media` goes through the session's
  `taskQueue` (`web_form_session.js`), so rapid captures serialize — there is no
  client-side race between two uploads or between an upload and a `clear_answer`.
- Staged bytes live on the Formplayer instance's own filesystem at the **relative**
  path `forms/<domain>/<username>[/<asUser>]/<appId>/<sessionId>/media/`
  (`FormSession::getMediaDirectoryPath` — its own source comment says `<form_id>`
  where the code uses `getSessionId()`), with a `media_meta_data` row alongside
  (`V26__init_media_meta_data` for the table and its `ON DELETE SET NULL` FK,
  `V27__media_meta_data_fileid` for the `fileid` column). There is no blob store, no
  serving endpoint, and nothing in the checkout promises a worker's requests reach
  the same instance.
- **Attachment names are server-generated UUIDs.** `MediaHandler.kt::saveFile`
  names the file `PropertyUtils::genUUID()` plus the *uploaded* file's extension;
  nothing in the call chain sees the question, the node path, the `FormIndex`, or
  the repeat multiplicity. Two instances of one repeat holding one capture field
  get two unrelated names — so Nova needs no per-instance naming scheme and **must
  not invent one**, because a name derived from the field would collide exactly
  where CommCare's does not. Edge: `FileUtils::getExtension` returns `""` for a
  name with no dot and Kotlin's `?.let` runs on `""`, so the stored name is
  `<uuid>.` with a trailing dot. "The answer splits on a dot into uuid + real
  extension" is not an invariant.
- One string is the answer, the multipart part name, and the HQ attachment name.
  `FormController::saveAnswer` sets the answer to `saveMediaAnswer`'s returned file
  id; `FormSubmissionHelper::createFilePart` names each part `file.getName()`;
  `parsers/form.py::_create_new_xform` builds `Attachment(name=<part name>, …)`.
  Unit 6 reads the attachment id straight off the capture answer with no
  transformation.
- Replacement saves the new file, then deletes the previous answer's file
  (`FormSession::saveMediaAnswer` → `cleanCurrentMedia`). Removal is a separate
  endpoint, `clear_answer` → `FormController::clearAnswer` → the same
  `cleanCurrentMedia`; `web_form_session.js::updateXformAction` flips a `file` or
  `signature` entry back to `answer_media` afterwards.
- A failed capture is not retried and leaves nothing staged:
  `MediaValidator.validateFile` is the first statement of `MediaHandler.saveFile`,
  before `genUUID` and before `copyFile`, and the failure arm of `answerQuestion`
  only sets a per-question error.
- A failed byte copy leaks a file the purge can never see: `saveFile` calls
  `FileUtils.copyFile` and writes the `media_meta_data` row only afterwards, while
  `MediaMetaDataService::purge` walks rows (`findByFormSessionIsNull`). A partial
  copy also leaves a truncated file the directory walk still submits.

### The caps

- **The browser's 4,000,000-byte check is the only cap a worker normally meets.**
  `entries.js::FileEntry.prototype.onAnswerChange` refuses at `size > 4000000`
  (decimal); Formplayer's `MediaValidator::MAX_BYTES_PER_ATTACHMENT` is
  `4 * 1048576 - 1024` = 4,193,280. Nova quotes 4 MB and never promises the extra
  193 KB.
- **Never surface Formplayer's own oversize string.**
  `formplayer_translatable_strings.txt` advertises
  `form.attachment.oversize.error=File ${0} is more than the maximum limit of 3 MB.`
  while `MediaValidator` enforces ~4 MB. It is a Formplayer string, so Nova can
  only avoid it.
- The 5 MB Spring limit
  (`spring.servlet.multipart.max-request-size` in Formplayer's
  `application.properties`) bounds the **capture** request, whose only form-entry
  consumer is `answer_media`. The outbound submission runs through
  `SubmitService::submitForm` → `WebClient::post` with no size check, so restating
  5 MB as a submission cap would be wrong. HQ's own caps are separate and looser:
  `MAX_UPLOAD_SIZE_ATTACHMENT` = 15 MiB per attachment,
  `MAX_UPLOAD_SIZE` = 10 MiB for `xml_submission_file`
  (`settings.py`, applied in `getters.py::get_instance_and_attachment`).
- **50 attachments is a submit-time directory count.**
  `FormSubmissionHelper::getMultiPartFormBody` lists the session media directory
  and throws `form.upload.attachments.limit.exceeded` when
  `files.length > maxAttachmentsPerForm`
  (`formplayer.form.submit.max_attachments=50`, unoverridden in either config
  file). It is counted over the raw listing before any per-file logic, so orphans
  consume slots. What it forces: an exact commit-gate finding over a form's
  non-repeating capture fields, plus an honest statement that captures inside a
  repeat are unbounded at authoring time and no authoring-time check closes that.
- **HQ's receiver is not a meaningful second line of defense on file type.**
  `couchforms/getters.py::_valid_attachment_file` is disjunctive
  (`_valid_attachment_file_extension(file) or _valid_attachment_file_mimetype(file)`)
  and its MIME arm accepts `application/octet-stream` — which is exactly the default
  `FormSubmissionHelper::createFilePart` uses when `FileUtils::getContentType`
  returns blank. Formplayer's own gate is disjunctive too
  (`MediaValidator.validateFile` rejects only when the extension **and** the sniffed
  MIME are unsupported, and its extension test is a suffix match on the whole
  filename, so `reportmp3` passes). The browser `accept` list is effectively the only
  gate, which makes Nova's authoring-side constraints matter more, not less.
- Per-kind accepted extensions come from one HQ table shipped to the browser:
  `couchforms/const.py::VALID_ATTACHMENT_FILE_EXTENSION_MAP` — `image/*` →
  jpg/jpeg/png; `image/*,.pdf` → those plus pdf; `audio/*` →
  3ga/mp3/wav/amr/qcp/ogg; `video/*` → 3gpp/3gp/3gp2/3g2/mp4/mpg4/mpeg4/m4v/mpg/mpeg;
  `application/*,text/*` → docx/msg/pdf/xlsx/html/rtf/txt. `cloudcare/views.py`
  publishes it as `valid_multimedia_extensions_map` and `entries.js::FileEntry`
  reads it.

### Orphans, relevance, and repeats

- **The submission enumerates the session media directory, not the answers.**
  `FormSubmissionHelper::getMultiPartFormBody` walks
  `mediaDirPath.toFile().listFiles()` and never consults the instance or the answer
  tree; the instance is added separately as `xml_submission_file`.
- Deleting a repeat instance does not delete its staged bytes —
  `JsonActionUtils::deleteRepeatToJson` is three statements and touches no media,
  and neither does its `URL_DELETE_REPEAT` caller.
- An irrelevant question keeps its bytes and loses its node.
  `Condition::performAction`'s hide arm only calls `node.setRelevant(false)`;
  `FormSession::submitGetXml` → `getInstanceXml(false)` constructs the serializing
  visitor with respect-relevance **on**, and `XFormSerializingVisitor::serializeNode`
  returns null for a non-relevant node. `FormSession::serialize` takes the other
  branch (respect-relevance off), so the value survives a resume.
- Together: **"attachments on the form" is not "captures the worker kept."** A
  capture the worker deleted still uploads, still consumes one of the 50 slots, and
  lands in HQ as an attachment nothing references — and there is no worker-facing
  way to remove it, because `clear_answer` and the replace path both resolve the
  file through a live question's current answer.
- Worse: every staged file is **re-validated at submit** — `getMultiPartFormBody`
  runs `MediaValidator.validateFile` per file — and `executeStep` aborts the
  pipeline on any exception. A single unvalidatable orphan blocks the entire
  submission with no worker-facing way to remove it.
- The session is deleted only on a fully successful submit
  (`FormSubmissionHelper::processAndSubmitForm` runs validateAnswers →
  processFormXml → updateVolatility → performSync → doEndOfFormNav, aborting on the
  first failure, and calls `deleteSessionById` after all of them). A submission
  rejected for the attachment cap leaves the session and its files intact.
- Reaping is one nightly pass, not two: `ScheduledTasks::purge` runs the 7-day
  `FormSessionService::purge` bulk delete first, whose `ON DELETE SET NULL` nulls
  those media rows, and the media purge last in the same invocation.

### Two upstream Formplayer defects

Both confirmed in source. Nova designs around them and documents what a worker
sees; neither is Nova's to fix.

- **Clearing a required capture destroys the bytes and keeps the reference.**
  `FormController::saveAnswer` runs `cleanCurrentMedia` before the answer attempt,
  and `FormEntryController::answerQuestion` returns `ANSWER_REQUIRED_BUT_EMPTY`
  before reaching `commitAnswer` when `element.isRequired() && data == null` — so
  the node keeps the old `<uuid>.<ext>` while the file is gone, and the worker sees
  only a "required" validation error. The non-required path is clean.
  Replacement has the same delete-before-commit ordering, so a constraint violation
  at commit leaves the same dangling reference. `MediaHandler.kt::cleanMedia`
  additionally returns a boolean neither caller inspects, so the clear path cannot
  even tell whether the delete succeeded. What it forces: capture fields **may**
  still be marked required — forbidding a legitimate authoring capability to route
  around someone else's bug is not the trade Nova makes — and unit 6 must not
  assume an answer implies a present attachment.
- **`MediaMetaDataService::purge` ignores the `Instant` cutoff it is handed.** It
  deletes every null-session row regardless of age; the parameter exists only to
  satisfy `doTimedPurge`'s functional interface, and `V26__init_media_meta_data`
  creates a `datecreated` column and an index on it that the service never uses.

### What Web Apps does not do

- **No camera, no microphone, no recorder.** `entry_file.html`'s
  `<input type="file">` binds `accept` and nothing else — no `capture` attribute —
  and `getUserMedia` / `MediaRecorder` / `capture=` occur nowhere in
  `corehq/apps/cloudcare`. Every kind except signature is the OS file picker.
  Android is the contrast (`ImageWidget` fires `MediaStore.ACTION_IMAGE_CAPTURE`,
  `WidgetFactory` routes audio to `CommCareAudioWidget`), and that contrast is a
  docs fact, not a Nova behavior. What it forces: all author- and worker-facing
  wording is "attach a photo", never "take a photo", and the SA vocabulary must not
  describe audio or video kinds as recording.
- **No playback and no preview of a staged capture.** `entry_file.html` is a Browse
  button, a filename text node, and a Clear button; `entry_signature.html` is a
  canvas, a Clear button, and a hidden file input. Neither renders a stored
  capture, and Formplayer declares no read route — `FormController` has one GET
  mapping, `URL_GET_INSTANCE`.
- **Even the filename is not durable.** The only picked-name mapping is
  `form_ui.js`'s in-memory per-`Form` `fileNameCache`, written and read within one
  page load; the tree-refresh path (`findChildAndSetFilename`) instead sets the
  server-generated `<uuid>.<ext>`, and `FileEntry`'s constructor seeds
  "No file selected." after `EntrySingleAnswer` has already stored the answer
  without firing `onPreProcess`. A resumed signature question renders a blank pad
  over a live answer (`SignatureEntry`'s `afterRender` sets `signatureData = null`
  and reads nothing back). What it forces: Nova's preview must not promise a
  confirmation the device cannot give.
- No upload progress and no chunking — `web_form_session.js::_serverRequest` is one
  `$.ajax` POST with no `xhr:` override; the only feedback is `BLOCK_SUBMIT`
  disabling Submit while the capture is in flight.
- Capture questions do carry a broadcast/receive affordance:
  `FileEntry`'s constructor calls `buildBroadcastTopics` and `onAnswerChange`
  publishes the picked filename under `BROADCAST_FIELD_FILENAME`. `getEntry` passes
  broadcast styles to image / audio / video / document entries but **not** to
  `SignatureEntry`. Nova need not support it, but `appearance` on a capture field
  is not unused.

### The unit-5 / unit-6 seam

- The capture answer is what a case block consumes, unchanged. Fixture:
  `commcare-hq/corehq/apps/app_manager/tests/data/form_preparation_v2/update_attachment_case.xml`
  — `<bind nodeset="/data/case/attachment/photo/@src" calculate="/data/thepicture"/>`
  beside `<bind nodeset="/data/case/attachment/photo" relevant="count(/data/thepicture) = 1"/>`,
  over a static instance node `<attachment><photo src="" from="local"/></attachment>`
  whose `from="local"` attribute no bind writes. Unit 5 owns everything up to
  `/data/thepicture` holding the attachment name; unit 6 owns what reads it.

**Observed:** a worker attaches a photo in a preview form, the image rides the
submission, and it can be replaced or removed before submitting.
