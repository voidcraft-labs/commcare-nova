# Executor authoring trial, 13 September 2026

One bounded trial at `9a7530d4` completed a client-registration workflow through
the production executor, durable private workspace, and canonical genesis commit.
This establishes feasibility for one accepted workflow. It is not a comparison
of overall app quality or proof of full feature coverage.

The human-authored accepted fixture required a name and age in completed years,
an age range of 0 through 120, an optional phone question shown from age 18, and
a closing note using the client's name. The fixture used production artifact
validation, planning, attempt, context, staging, and commit owners. Its accepted
review was controlled fixture content; no design-author or reviewer call ran.
The database was disposable and removed by the existing Postgres harness.

GPT-5.6 Luna at `xhigh` completed eight provider requests, capped at twelve requests
and five minutes. It made nine local tool calls, with no rejected call or repair
round: three focused guide reads, an app update, record declaration, module/form
creation, two focused app reads, and completion. The app name came from the
fixture's accepted charter. Two hosted searches loaded ten tool definitions in
total; eight loaded in the first search. Reported input grew from 9,282 tokens
on the first step to 30,246 on the last. These request counts differ from the
local static estimates: 373 system-prompt tokens, 199 initially mounted tool
tokens, and a 72,265-token deferred catalog. Deferral does not make the full
catalog small or prevent broad retrieval.

After loading the committed app at sequence 1, the production Preview engine
rejected ages -1 and 121, accepted 0, 17, 18, and 120, hid phone below 18, and
left it optional when shown. The note resolved to “Thank you, Ada Example.”
Separate checks confirmed that a missing name or age prevents submission.
No form was submitted and no case row was created by these observations.

An additional check found a runtime gap: Preview accepted `2.5` for the correctly
authored integer field. That observation is recorded as a failure, not folded
into a successful integer-validity result. The numeric input control and
submission conversion need investigation before this scenario is considered
complete. The remedy should belong to the field/value boundary if the type
already establishes the rule; it should not become another model instruction.

The conservative charge was $0.0542365, pricing all input uncached with a 25%
margin. Total recorded program spend is $0.856605, with no pending request
reservations. [The sanitized results](agent-executor-authoring-results-2026-09-13.json)
retain every step's usage, loaded tool names, and the successful and failing
observations. Raw requests, responses, and the canonical app remain in private
local artifacts.

The next construction work should move exact accepted question identities,
layout, and record facts into Nova. This trial still spent model work copying
those decisions into creation calls. Further evaluation must include held-out
workflows, preservation edits, full-plan conformance, and actual submissions.
