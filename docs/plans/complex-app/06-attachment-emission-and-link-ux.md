# Unit 6 — Attachment target-aware emission and link UX

**PR:** `Attachment URL columns, link presentation, and the opt-in legacy attachment mode`

**Depends on:** the deployment target from unit 11. · **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first — the link-first
> case-attachment gap there is the product decision this unit implements.

Lift the `MEDIA_CASE_PROPERTY` rejection for exactly the save-to-case shapes —
keeping it for a media kind with `case_property_on` and no mode — and ship that
constructibility together with the emission it needs, so save-to-case is never
authorable without a wire spelling.

Add target-aware URL-property emission only when the deployment server and domain
are known, explicit link presentation, preview replacement and removal, SA and
docs coverage, and the deprecated attachment compatibility path — offered only
when the deployment record shows the target domain carries HQ's
`MM_CASE_PROPERTIES` toggle, and stated in the field UI before selection.

## Binding facts

- Web Apps **never** displays a case-persisted attachment in-app: Formplayer's
  `processCaseAttachment` hooks are no-ops, the reference is never stored locally,
  there is no serving path, and restore emission sits behind the deprecated flag.
  Attachment mode's only display surfaces are the HQ case page and Android.
- The machine-readable bytes endpoint is
  `GET /a/<domain>/api/form_attachment/v1/<instance_id>/<attachment_id>` (url name
  `api_form_attachment`), a `StreamingHttpResponse` with the attachment's MIME
  type, HQ-session-gated. The reports route
  `form_data/<instance_id>/attachment/<attachment_id>` is a **human HTML viewer
  page** and must never be targeted from an image or link column.
- `detail_screen.py::Picture` is the correct wire format for an image-valued
  column once the cloudcare HTTPS passthrough is fixed. Until then the
  plain/markdown column formats render the stored URL as a clickable link, which
  is the working link-first path. Do not default to a broken HTTPS picture column.
- An empty `<attachment>` element removes a case attachment on both runtimes.
- **Preview must not synthesize the URL at all — the whole column is absent
  there, not merely origin-less.** The capture answer is identical in shape
  wherever the form ran (a server-minted `<uuid>.<ext>`), but a PREVIEW
  capture's bytes live in Nova's own submission-scoped lane
  (`lib/db/formAttachments.ts`), not on HQ. There is no HQ instance, so
  `/data/meta/instanceID` names nothing, and
  `form_attachment/v1/<instance_id>/<attachment_id>` resolves to nothing no
  matter what precedes it. **Supplying a placeholder origin in preview does not
  make the link work; it makes a broken link look deliberate.** So the URL
  *column* is the target-dependent thing, not just the origin inside it — read
  the "no origin or domain to resolve" framing below as naming what a `.ccz`
  export lacks, never as implying that an origin is all preview needs. This is
  the honest-preview rule in
  [the binding contracts](00-contracts.md#users-personas-and-workers) applied
  one level up from the domain slug it already names. A submitted preview
  attachment is real data with a real name; what it lacks is an HQ submission
  to hang off.

The emitted value is a calculate over the submission's own metadata —
`concat('<origin>/a/<domain>/api/form_attachment/v1/', /data/meta/instanceID, '/',
'<attachment name>')` — so `instance_id` comes from the form instance and the
attachment name from the capture field. Both halves of the origin come from the
deployment record, which is why this unit waits on unit 11. A local `.ccz` export
has no origin or domain to resolve, so it emits the field without the URL column
and says so at export time rather than writing a URL that resolves nowhere.

**Observed:** a case list shows a working link to a captured photo, and an author
is told plainly why inline display is not offered.
