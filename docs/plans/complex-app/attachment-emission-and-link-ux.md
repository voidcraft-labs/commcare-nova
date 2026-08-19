# Attachment target-aware emission and link UX

**PR:** `Attachment URL columns, link presentation, and the opt-in legacy attachment mode`

**Depends on:** the deployment target from
nothing outstanding. · **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first — the link-first
> case-attachment gap there is the product decision this unit implements.

**Built:** the save-to-case shape and its URL emission. A capture's `caseWrite`
carries a required `mode` whose only member is `"url"`, so a destination
without a wire spelling is unrepresentable and `MEDIA_CASE_PROPERTY` is retired
rather than narrowed. The address is emitted on a sibling node
(`lib/commcare/xform/captureUrlNode.ts`) that the case update names instead of
the capture question, from a target resolved off the deployment record
(`lib/deployment/attachmentTarget.ts`); with none, nothing is emitted and
`lib/publish/exportAdvisories.ts` says so on the download. Preview writes
nothing. Preview replacement and removal were already shipped.

**Remains, in two PRs:**

1. **The `link` column kind.** A translatable `linkText` emitted as
   `<template form="markdown">` over a
   `concat('[', $link_text, '](', value, ')')` xpath with a locale variable.
   This is the only thing that makes the saved address usable in a case list.
2. **The opt-in `MM_CASE_PROPERTIES` attachment mode.** A second `mode` member
   with the `<case><attachment>` emission, offered only when the deployment
   record shows the target domain carries HQ's deprecated toggle, and stated in
   the field UI before selection. Never a publish gate.

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
  column once the cloudcare HTTPS passthrough is fixed. `resolveUri`
  (`cloudcare/.../formplayer/app.js`) passes through only `http://` (7
  characters) and never `https://`, so an https URL falls into the multimedia
  map, misses, and yields `<img src="">`. Do not default to a broken HTTPS
  picture column.
- **Neither column format autolinks a bare URL, and a `plain` cell is not a
  link at all.** `case_list/item.html` renders a plain cell as `<%- datum %>`
  (escaped text); only a `Markdown` cell reaches `renderMarkdown`, and a tile
  cell (`tile_item.html`) runs it on every non-image cell regardless of format.
  `markdown.js::initMd` builds `markdowner({breaks: true})`, leaving `linkify`
  at its `false` default, and DOMPurify sanitizes the SOURCE before rendering,
  so an `<url>` autolink is stripped too. **A literal `[label](url)` in a
  markdown-format cell is the only spelling that produces a link** — which is
  what makes `linkText` a required part of the column rather than a nicety.
- Nova targets the API route rather than the reports viewer for a reason the
  MIME type does not cover: `reports/views.py::_can_view_form_attachment`
  admits the API route via `api_auth()` plus the `VIEW_FORM_ATTACHMENT` domain
  toggle **or** `require_form_view_permission`, while the reports route has
  `login_and_domain_required` + `require_form_view_permission` and no toggle
  bypass. A mobile worker without Submission History cannot open the reports
  page at all. **`VIEW_FORM_ATTACHMENT` (`view_form_attachments`, `TAG_GA_PATH`,
  domain) is therefore a second target prerequisite**, and belongs in
  `config/commcare-hq-feature-flags.json` alongside `MM_CASE_PROPERTIES`.
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
deployment record, which `lib/deployment` now supplies. A local `.ccz` export
has no origin or domain to resolve, so it emits the field without the URL column
and says so at export time rather than writing a URL that resolves nowhere.

**Observed:** a case list shows a working link to a captured photo, and an author
is told plainly why inline display is not offered.
