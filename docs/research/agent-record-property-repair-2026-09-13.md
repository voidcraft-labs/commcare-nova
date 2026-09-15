# Garden construction and record-property repair

The fifth garden trial accepted a design but produced no canonical app. Its
first construction slice stopped because a catalog property could be created
but not edited through the available tools. This is evidence of an incomplete
authoring interface, not evidence that a longer prompt or another retry would
improve the app.

## Recorded trial

The run used source `21a7747cb9af62b199724ac62f630618c708c120`, the reviewed
construction-order slice. The private harness digest was
`6046540bdddfbea210700e52ac37773ef3a4c7cb4ba9162f18b334bc875f989a`.
Its credential-free requests, source manifest, durable snapshots, and terminal
result are retained locally in `build-construction-order-1` under the private
authoring research directory. It exercised the production design runner,
independent reviewer, planner, executor, and disposable Postgres lifecycle.

The 30 completed generation requests cost an estimated $2.520733. Cumulative
recorded generation spend reached $23.67825675 over 223 completed requests,
with no pending reservations. Design used 11 requests with Sol at medium
effort. Construction used 17 Luna executor requests and two Sol helper
requests. The terminal result was `blocker-resolution-budget-exhausted`;
the app ID and canonical app were null. The test harness successfully captured
that failure; its passing exit status is not an app-quality pass.

The initial reviewer requested worker-accessible check history. The author
added a read-only task and a list of checks scoped to the selected plot, with
date and soil condition in the list and the note in details. A second review
accepted the revised design. That advances beyond the previous trials, but one
run does not establish a success rate or isolate which preceding changes caused
the improvement.

Construction exposed three distinct issues:

- The executor initially declared a future slice's record. Its refusal blamed
  record naming even though the current record's spelling was correct.
- It used the query helper `between()` in a form XPath expression and a catalog
  validation. Those expression slots rejected the unsupported function during
  workflow finalization. The executor corrected the form rule to comparisons.
- `generateSchema` refused the corresponding catalog correction because it is
  additive. No shared tool exposed the existing `setCaseProperty` mutation.
  Both helper responses advised repairing that state without supplying an
  operation able to do so. The bounded run then stopped.

The trial does not prove the rest of the app: submission behavior, chronology,
history preservation, offline navigation, and cross-plot isolation remain
unobserved. These checks must use the generated app once construction succeeds.

## Interface change

Shared `getCaseProperty` and `updateCaseProperty` operations give the editor,
MCP client, and permitted build slices a focused read and explicit patch.
They use the canonical property schema and existing workspace mutation path.
An omitted setting survives; null clears an optional setting. The complete
merged definition must remain coherent, and canonical writes still pass the
whole-app gate. Existing questions retain their own content and rules.

Property identity and type changes retain their existing semantic operations:
app-wide rename and field conversion. A generic metadata patch cannot bypass
their reference, writer, and saved-data handling. No data migration or alternate
historical reader is needed for these added operations.

Local verification exercises a private invalid catalog, a stopped executor,
durable recovery, property inspection, correction, and genesis publication.
Separate MCP coverage verifies persisted metadata changes, unchanged saved case
values, and current read/write permissions. These controlled-response tests
establish repair capability; they do not establish whether a model chooses it.

The misleading refusal, expression-language overlap, early diagnostic feedback,
and helper grounding remain part of the broader interface audit. This slice
does not resolve them by adding repetitive prompt instructions.
