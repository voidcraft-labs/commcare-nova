# Record lifecycle guidance for authors

Source audit, 2026-09-20. Nova baseline `090a493a`, CommCare Core
`8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305`, CommCare HQ
`5ca85b758d40dd22372f5889efd776d1f593de72`. This is a source audit, not a
physical-device or live-HQ acceptance result.

## Lifecycle versus business stage

Core's `cases/instance/CaseChildElement.java::buildAndCacheInternalTree`
projects `@status` from `Case.isClosed()`: `open` or `closed`.
`xml/CaseXmlParser.java::closeCase` sets that flag. A business-property update
is not that operation. HQ's
`casexml/apps/phone/data_providers/case/livequery.py::do_livequery` seeds restore
with owned cases where `closed=False`, then computes related live cases.
Closure normally removes a case from a worker's next synced set; it does not
delete the server record or its history. An open child can keep a closed parent
as a dependency. Closing an extension host can remove its extension chain.
Ownership alone therefore neither guarantees availability nor describes the
entire synced set.

Nova implements those restore relationships in
`lib/case-store/sql/compileRestoreScope.ts`. The existing Postgres harness
compares all 45 upstream relationship fixtures; its header documents a known
upstream ordering ambiguity rather than claiming universal native parity.
Ordinary Preview's post-submit device patch can retain a just-closed case until
sync. Do not describe closure as immediate deletion or an ordinary workflow
label, and do not promise every closed dependency disappears.

Core's `cases/model/Case.java::getState` reads `state`, falling back to
`current_status` only when `state` is absent. `CaseChildElement` exposes this as
`@state`; ordinary `current_status` remains a separate child. Core's
`cases/test/CaseXPathQueryTest.java::caseIndexAliasTest` explicitly demonstrates
that their query results can differ. These values describe an application's
stage, independently of the closed flag.

Nova admits ordinary `current_status` writes and reads. It reserves `state`
against ordinary writes and does not provide a supported `@state` authoring
alias. `lib/commcare/casePropertyWire.ts` emits `status` as `@status` and
`current_status` as `current_status`. Authors can use a business-specific
property or `current_status`; introducing another representation is unnecessary.
A close form or close operation expresses lifecycle closure.

## Timestamps and actor identity

Core's parser takes `last_modified` from the case block's `date_modified`,
including close/index changes. `Case.getLastModified` falls back to opening time
for older data. HQ's `SqlCaseUpdateStrategy._apply_case_update` advances
`modified_on` using the case update's date, while `server_modified_on` is a
separate server-processing concept. These timestamps are not interchangeable
with receipt time or a permanent business-event timestamp.

Nova's `PostgresCaseStore` initializes `opened_on` and `modified_on`, preserves
opening time on ordinary updates, and stamps modification time on updates and
closure. `caseRowDisplaySourceValue` projects them as `date_opened` and
`last_modified`. Local Nova writes use server time; this is not a promise of
identical clock provenance on a disconnected device. An approval timestamp
that must survive later edits requires a dedicated event value.

HQ's `CommCareCase` separately stores `opened_by`, `modified_by`, and `owner_id`;
its `user_id` property aliases `modified_by`. The SQL update strategy gets the
modifier from the submitted case update. Core's misleadingly named
`Case.getUserId()` instead backs the case's `@owner_id`: creation chooses an
explicit owner or defaults to the submitting user, and later owner changes
replace it. The parser does not expose each update's actor as that owner.
Neither this owner nor a session's current worker establishes who last edited
a loaded case.

Nova exposes owner identity and the current simulated worker, but no portable
built-in creator/modifier property across its storage, preview and export
consumers. Do not invent a `#case/user_id` read or duplicate generic dates to
compensate. Store actor history only where the user's requirement needs it,
such as an approver retained after later edits. Project membership remains the
authorization boundary; simulated worker ownership controls restore context
inside that authorized app.

## Current worker readings

The role-gated trial exposed a discovery gap: the expressions guide described
record-scope `session(...)`, but neither that guide nor `getUsers` named the
existing built-in form readings. The architect tried the record function in
forms, received a refusal, then added custom audit identity properties. That
was not evidence that the platform lacked worker identity. The correction
exposes each supported reading in the guide and the existing worker read.

HQ's `corehq/apps/callcenter/sync_usercase.py::_get_user_case_fields` writes
`hq_user_id` and `username` (`raw_username`). It sets `name` to the display name
or login name; `_UserCaseHelper.create_usercase` and `update_user_case` consume
that key into the case's own name, not a custom `name` property. Core's
`CaseChildElement` projects that as `case_name`. Consequently form expressions
read `#user/hq_user_id`, `#user/username` and `#user/case_name`. Nova's
`lib/domain/usercase.ts` and `lib/commcare/hashtags.ts` implement the same worker
record and join. Record expressions instead use `session('userid')` and
`session('username')`; `session()` is not a form function.

The authoring test consumes the actual `getUsers` output, admits a complete form
using those expressions, and runs it through the production Preview engine as
both the real member and a persona. It separately evaluates the returned record
expressions. This proves the exposed Nova runtime contract; it does not establish
provisioning, sync or physical-device behavior. No creator or last-modifier
reading is inferred from current worker identity.

Independent review identified a prerequisite the first draft omitted. HQ's
`sync_usercase.py::_iter_sync_usercase_helpers` creates the `commcare-user` case
only with the `USERCASE` privilege; `app_manager/util.py::domain_has_usercase_access`
uses that same privilege. Form reads need that case restored on the device.
Missing records can yield blank reads. The existing suite assertion protects
worker-record writers, not read-only forms. The shared setup/preflight projection
now identifies both read and write dependencies, and authoring guidance states
what Preview cannot establish. Record-scope session identity does not have this
worker-record dependency.

Core's `WorkerIdentityRuntimeTest.builtInFormIdentityRequiresTheMatchingWorkerRecord`
passed against the current generated CCZ form at the audited Core SHA. Its three
calculated values match the selected worker with a restored usercase and are blank
without it, despite wrong-user and wrong-type records being present. Reproduction
is in `scripts/fixtures/javarosa/README.md`; target privilege assignment and sync
remain separately unverified.

## Form participation and child ownership

Relevance is more than visibility. Core's `TreeElement.isRelevant` includes
inherited relevance. `XPathPathExpr.getRefValue` reads a non-relevant node as
null, and `XPathLazyNodeset` excludes non-relevant nodes during expansion.
`XFormSerializingVisitor` also omits them from the submitted instance. Nova's
`FormEngine.createEvalContext` supplies effective relevance to the main-instance
reader, and its submission projection checks inherited relevance for ordinary
writes. A default on a non-relevant question therefore does not establish a
usable submitted value. A hidden value field expresses data that needs no
visible question; making a question non-relevant expresses different semantics.
The generated tool argument description previously said only to show the field
when the condition holds. That reduced participation to visibility at the actual
authoring boundary, even if a focused guide explained more. Both now describe
the data consequence; this is a shared schema description, not an extra prompt
inventory.

Independent Core execution of the role-gated trial's final saved export found
that distinction consequential: a question with a default business status and
`relevant: false()` read blank and produced a blank created-record status.
Parsing succeeded, and the preceding native grower/plot creation established
correct owners and parent indices. The native journey could not establish the
later review and delivery steps. This is retained failed evidence, not a repaired
fixture or an autonomous pass.

Ordinary child writes also have a concrete ownership default. Nova's
`lib/commcare/xform/caseBlocks.ts` binds every ordinary child's owner to the
submitting worker. HQ's `app_manager/xform.py::autoset_owner_id_for_subcase`
and its basic-module subcase generation use the same rule. A child relationship
does not mean ownership is inherited. Explicit creation operations can supply
the owner required by case sharing. The trial's disposable submission exposed
this difference, and the architect corrected its child creation through normal
tools; the native export subsequently preserved the chosen branch owner.
