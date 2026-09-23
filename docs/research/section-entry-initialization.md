# Section entry and nested initialization

A controlled, admitted two-section app demonstrated a production mismatch.
The first page defaulted an area to north. The next page contained a one-row
count repeat, whose nested query selected two assets for north and one for south.
Changing the first answer to south before Next produced the single southern
asset in CommCare Core, but Preview still displayed the northern pair.

The independent consumer was CommCare Core `8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305`.
`FormEntryController::getQuestionPrompts` traverses the active field-list group
through `getNextIndex`; this creates later-page rows when that page is reached.
Nova’s initialization previously inserted every section’s rows at form start.
Both consumed the exact Nova export. Browser observation began at app entry and
used the actual answer control and Next button. No operator expression repair
or real-record submission was part of this controlled reproduction.

The engine now retains form-start counts and IDs separately from pending row
insertion. Entering a section consumes its pending snapshots and initializes
nested scopes using the answers then present. The worker protocol and ordinary
browser controller use the same engine operation. Checkpoints retain pending
snapshots and the active section, so a journey continuation cannot rerun form
initialization. Existing rows survive Back/Next and relevance changes.

Independent review also caught same-entry rebuilds attaching retained answers
to newly selected query IDs, live relevance edits failing to insert newly
required rows, and queued page navigation faulting a replacement form. Rebuilds
now restore the full entry before healing context; untouched defaults may
refresh, but consumed membership and query IDs stay attached to their answers.
Document reconciliation uses the same atomic page-entry operation as input
changes, and queued navigation retains its original entry fence.

Disposable app tests expose section navigation and current-page questions.
They reject off-page answers and require reaching the final available page
before submission. A standalone form check traverses the supplied answer order
and remaining pages; it does not prove navigation validation. Page availability
and re-anchoring share the browser’s pure paging projection.

Evidence is at the owning boundary: production engine and worker checks,
real-Postgres journey actions, Playwright over the real FormScreen, and
`ContainerRuntimeTest::laterFieldListInsertsRowsAfterEarlierAnswers` consuming
`emit-container-evidence.ts` exports. The latter verifies both later insertion
and retained answers when earlier input changes again.

This does not prove universal native parity. Unsectioned Preview displays the
whole form together, unlike native question-by-question navigation. No new
agent build trial has yet demonstrated first-delivery quality after this fix.
