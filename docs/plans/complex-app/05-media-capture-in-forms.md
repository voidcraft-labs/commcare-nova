# Unit 5 — Capture, storage, and submission lifecycle

**PR:** `Capture in the running preview: staged upload through submission`

**Depends on:** nothing outstanding. · **Blocks:** unit 6.

> Read [the binding contracts](00-contracts.md) first, and
> [what is built](../complex-app-plan.md#attachment-questions) for the capture
> vocabulary and wire this unit runs, plus
> [media](../complex-app-plan.md#media) for the Project-scoped authoring library
> it sits beside.

Attachment questions already author, validate, and emit; what remains is running
them. Build capture in the running preview: staged upload at pick time,
cancellation, retry, required/relevant behavior, repeat support, compensation and
orphan cleanup, authorization, and the durable landing the submission gives a
capture.

**Captures live in a submission-scoped lane, never `media_assets`.** A
worker-captured photo is data, not an authoring asset: putting it in the library
would surface it in the media picker, count it against the export budget, and
make it deletable through the library UI. The platform's own model is
session-scoped and disposable, which independently supports the split.

This unit stops at the form. `mediaCaseProperty` keeps rejecting a capture kind
carrying `case_property_on`, and unit 6 lifts it.

## Binding facts

### Naming and the answer

- **Attachment names are server-generated UUIDs.** `MediaHandler.kt::saveFile`
  names the file `PropertyUtils::genUUID()` plus the *uploaded* file's extension;
  nothing in the call chain sees the question, the node path, the `FormIndex`, or
  the repeat multiplicity, and no other site constructs a name. Two instances of
  one repeat holding one capture field get two unrelated names — so Nova needs no
  per-instance naming scheme and **must not invent one**, because a name derived
  from the field would collide exactly where CommCare's does not.
- Edge: `FileUtils::getExtension` returns `""` (not null) for a name with no dot
  and Kotlin's `?.let` runs on `""`, so the stored name is `<uuid>.` with a
  trailing dot. "The answer splits on a dot into uuid + real extension" is not an
  invariant.
- One string is the answer, the multipart part name, and the HQ attachment name.
  `FormController::saveAnswer` sets the answer to `saveMediaAnswer`'s returned
  file id; `FormSubmissionHelper::createFilePart` names each part
  `file.getName()`; `parsers/form.py::_create_new_xform` builds
  `Attachment(name=<part name>, …)`. The answer is carried as `UncastData`
  (`AnswerDataFactory::templateByDataType` groups `DATATYPE_BINARY` with
  `BARCODE`/`UNSUPPORTED`/`NULL`) — a plain string, never a typed binary value.

### Staging

- Capture is an immediate round trip at pick time, not at submit:
  `entries.js::FileEntry.prototype.onAnswerChange` validates extension / MIME /
  size in the browser, then `form_ui.js::Question.triggerAnswer` →
  `web_form_session.js::answerQuestion`. The endpoint is `POST answer_media`,
  `multipart/form-data`, two parts named `file` and `answer`
  (`FormController::answerMediaQuestion`).
- Every request including `answer_media` goes through the session's `taskQueue`
  (`web_form_session.js`), so rapid captures serialize — there is no client-side
  race between two uploads or between an upload and a `clear_answer`. The window
  is server-side only.
- Staged bytes live on the Formplayer instance's own filesystem at the
  **relative** path
  `forms/<domain>/<username>[/<asUser>]/<appId>/<sessionId>/media/`
  (`FormSession::getMediaDirectoryPath` — its own source comment says `<form_id>`
  where the code uses `getSessionId()`), with a `media_meta_data` row alongside
  (`V26__init_media_meta_data` for the table and its `ON DELETE SET NULL` FK,
  `V27__media_meta_data_fileid` for the `fileid` column). There is no blob store,
  no serving endpoint, and nothing in the checkout promises a worker's requests
  reach the same instance.
- Replacement saves the new file, then deletes the previous answer's file
  (`FormSession::saveMediaAnswer` → `cleanCurrentMedia`). Removal is a separate
  endpoint, `clear_answer` → `FormController::clearAnswer` → the same
  `cleanCurrentMedia`; `web_form_session.js::updateXformAction` flips a `file` or
  `signature` entry back to `answer_media` afterwards.
- A failed capture is not retried and leaves nothing staged:
  `MediaValidator.validateFile` is the first statement of
  `MediaHandler.saveFile`, before `genUUID` and before `copyFile`, and the
  failure arm of `answerQuestion` only sets a per-question error.
- A failed byte copy leaks a file the purge can never see: `saveFile` calls
  `FileUtils.copyFile` and writes the `media_meta_data` row only afterwards,
  while `MediaMetaDataService::purge` walks rows (`findByFormSessionIsNull`). A
  partial copy also leaves a truncated file the directory walk still submits.
- There is no upload progress and no chunking —
  `web_form_session.js::_serverRequest` is one `$.ajax` POST with no `xhr:`
  override; the only feedback is `BLOCK_SUBMIT` disabling Submit while the
  capture is in flight.

### Orphans, relevance, and repeats

- **The submission enumerates the session media directory, not the answers.**
  `FormSubmissionHelper::getMultiPartFormBody` walks
  `mediaDirPath.toFile().listFiles()` and never consults the instance or the
  answer tree; the instance is added separately as `xml_submission_file`.
- Deleting a repeat instance does not delete its staged bytes —
  `JsonActionUtils::deleteRepeatToJson` is three statements and touches no media,
  and neither does its `URL_DELETE_REPEAT` caller.
- An irrelevant question keeps its bytes and loses its node.
  `Condition::performAction`'s hide arm only calls `node.setRelevant(false)`;
  `FormSession::submitGetXml` → `getInstanceXml(false)` constructs the serializing
  visitor with respect-relevance **on**, and
  `XFormSerializingVisitor::serializeNode` returns null for a non-relevant node.
  `FormSession::serialize` takes the other branch (respect-relevance off), so the
  value survives a resume.
- Together: **"attachments on the form" is not "captures the worker kept."** A
  capture the worker deleted still uploads, still consumes one of the 50 slots,
  and lands in HQ as an attachment nothing references — and there is no
  worker-facing way to remove it, because `clear_answer` and the replace path both
  resolve the file through a live question's current answer.
- Worse: every staged file is **re-validated at submit** —
  `getMultiPartFormBody` runs `MediaValidator.validateFile` per file — and
  `executeStep` aborts the pipeline on any exception. A single unvalidatable
  orphan blocks the entire submission.
- The session is deleted only on a fully successful submit
  (`FormSubmissionHelper::processAndSubmitForm` runs validateAnswers →
  processFormXml → updateVolatility → performSync → doEndOfFormNav, aborting on
  the first failure, and calls `deleteSessionById` after all of them). A
  submission rejected for the attachment cap leaves the session and its files
  intact.
- Reaping is one nightly pass, not two: `ScheduledTasks::purge` runs the 7-day
  `FormSessionService::purge` bulk delete first, whose `ON DELETE SET NULL` nulls
  those media rows, and the media purge last in the same invocation.

### Two upstream Formplayer defects

Both confirmed in source. Nova designs around them and documents what a worker
sees; neither is Nova's to fix.

- **Clearing a required capture destroys the bytes and keeps the reference.**
  `FormController::saveAnswer` runs `cleanCurrentMedia` before the answer
  attempt, and `FormEntryController::answerQuestion` returns
  `ANSWER_REQUIRED_BUT_EMPTY` before reaching `commitAnswer` when
  `element.isRequired() && data == null` — so the node keeps the old
  `<uuid>.<ext>` while the file is gone, and the worker sees only a "required"
  validation error. The non-required path is clean. Replacement has the same
  delete-before-commit ordering, so a constraint violation at commit leaves the
  same dangling reference. `MediaHandler.kt::cleanMedia` additionally returns a
  boolean neither caller inspects, so the clear path cannot even tell whether the
  delete succeeded. What it forces: capture fields **may** still be marked
  required — forbidding a legitimate authoring capability to route around someone
  else's bug is not the trade Nova makes — and unit 6 must not assume an answer
  implies a present attachment.
- **`MediaMetaDataService::purge` ignores the `Instant` cutoff it is handed.** It
  deletes every null-session row regardless of age; the parameter exists only to
  satisfy `doTimedPurge`'s functional interface, and `V26__init_media_meta_data`
  creates a `datecreated` column and an index on it that the service never uses.

### What a worker can see

- **Web Apps never plays back or previews a staged capture.** `entry_file.html`
  is a Browse button, a filename text node, and a Clear button;
  `entry_signature.html` is a canvas, a Clear button, and a hidden file input.
  Neither renders a stored capture, and Formplayer declares no read route —
  `FormController` has one GET mapping, `URL_GET_INSTANCE`.
- **Even the filename is not durable.** The only picked-name mapping is
  `form_ui.js`'s in-memory per-`Form` `fileNameCache`, written and read within one
  page load; the tree-refresh path (`findChildAndSetFilename`) instead sets the
  server-generated `<uuid>.<ext>`, and `FileEntry`'s constructor seeds "No file
  selected." after `EntrySingleAnswer` has already stored the answer without
  firing `onPreProcess`. A resumed signature question renders a blank pad over a
  live answer (`SignatureEntry`'s `afterRender` sets `signatureData = null` and
  reads nothing back).
- What it forces: **the preview must not promise a confirmation the device cannot
  give.** Nova's preview runs its own engine, so it *could* show a thumbnail Web
  Apps will not. Follow the precedent display conditions already set — truthful
  device behavior by default, author-only inspection clearly marked — and per
  [the binding contracts](00-contracts.md) the modes must not blend.
- Capture questions do carry a broadcast/receive affordance: `FileEntry`'s
  constructor calls `buildBroadcastTopics` and `onAnswerChange` publishes the
  picked filename under `BROADCAST_FIELD_FILENAME`. `getEntry` passes broadcast
  styles to image / audio / video / document entries but **not** to
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
