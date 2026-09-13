# Garden submission context

The accepted-record catalog trial built all three planned garden workflows on
`361f05959261414653795e23cb654ea0545bcc46`. Its exact recorded app then failed
on the first weekly submission: a new history record used the selected plot's
name, but SQL evaluated that expression without the selected row.

`expandPhysicalInstances` had applied multiple-selection expansion to every
form. It removed the case context from all operations except session targets
and moved them before session-targeted operations. That contradicted single-case
authoring: the validator's split-order restriction applies only to multiple
selection, and the XForm emitter supplies the selected case to every operation
in a single-case form.

The correction preserves authored order and the selected row for single-case
operations. Multiple-selection forms retain their separate expansion, even when
only one row is selected. All expressions still read the pre-submission snapshot;
effects and authorization remain inside the same transaction. No stored format
changes or model instructions are needed.

The full submission-envelope suite passes 58 tests against real Postgres,
including a new mixed update/create/expression-target sequence. It proves the
created record reads the original name and property, links to the selected case,
and respects final write order. Another case proves a multiple-selection form
with one selected row still rejects a session link without partial writes.

The private recorded-app harness then passed without modifying the generated
blueprint. It checks matching source and persisted digests, required answers and
integer bounds, two plots with the same name and distinct identities, correction
prefills and selected-plot isolation. Weekly submissions create three distinct
history rows linked to the chosen plot: a backdated check preserves the latest
summary, a later check advances it, and the first history row remains unchanged.
The other plot is unchanged throughout. Observations are in
`/private/tmp/nova-agent-research-20260912/garden-submission-context-runtime.json`.

These are Nova runtime and storage observations. They do not exercise browser
navigation, history-list rendering, native device execution or HQ processing.
Local Core's `CaseXmlParser` accepts a supplied case name and case index; that
source inspection is orientation, not runtime evidence for this generated app.
The checks made no API calls; cumulative recorded API spend remains $31.91011850.
