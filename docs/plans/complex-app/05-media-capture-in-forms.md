# Unit 5 — Capture, storage, and submission lifecycle

**PR:** `Media capture in forms: staged upload, lifecycle, and case references`

**Depends on:** nothing outstanding. · **Blocks:** unit 6.

> Read [the binding contracts](00-contracts.md) first, and
> [what is built](../complex-app-plan.md#media) for the Project-scoped authoring
> media boundary this unit sits beside.

Implement real image, audio, video, and signature capture, and decide generic-file
scope explicitly before implementation starts. Media capture in a Web Apps form
works end to end; the platform caps are 4 MB per file, 50 files, and a 5 MB
request (`MediaValidator.kt`, Formplayer `application.properties`).

Specify staged upload, cancellation, retry, required/relevant behavior, repeat
support, compensation and orphan cleanup, authorization, case-reference deletion
guards, and why case captures do not pollute the authoring media library.

This unit stops at the form. The `MEDIA_CASE_PROPERTY` validator rule
(`lib/commcare/validator/rules/form.ts::mediaCaseProperty`) keeps rejecting media
capture kinds that carry `case_property_on`, and unit 6 lifts it — writing a
capture onto the case is inseparable from emitting its URL column, so the two
ship together rather than leaving a field an author can tick and no export can
represent. Nothing here needs a deployment target, which is why it can go first.

**Observed:** a worker photographs something in a preview form, the image rides
the submission, and it can be replaced or removed before submitting.
