**Comparison cases for agent authoring**

These cases support [Improve agent authoring](agent-authoring-quality.md).
They are evaluation work, not another runtime Design Contract collection. Use
the person's request and the observed app to judge a result. Several different
app designs may satisfy a case well.

**A small referral app.** Reuse the two local August 30 requests from sessions
`61ac1281-e793-4661-a6f9-2b77c5facc1b` and
`ff37edd4-a972-45d0-a736-f66e7a9e7527` after removing any identifying source
content. Each asks for a client record, registration and referral-update forms,
a shared service table, urgency choices, and a usable client list. Preserve the
actual requests; do not retrofit visit history into a current-state tracker.
Observe registration, lookup-backed choice values and labels, a subsequent
update to the same client, and list readback. Check that a request delegating
minor decisions does not trigger unnecessary questions or invented workflows.

**A history that must survive updates.** Ask for recurring household visits
whose earlier dates, observations, and outcomes must remain independently
available after later visits and household edits. Observe several visits and
read them back. Judge whether the worker can find the household, understand its
current situation, and inspect prior visits without confusing them. Do not
require one particular module arrangement merely because the baseline used it.

**Find, register, and update a group.** Ask workers to search before registering
a new client, then apply one shared update to several selected clients. Observe
no search, failed search, no matches, and actual matches as distinct states.
Verify the created record, carried search values, and next destination. Give
selected clients different existing values: blank shared answers must preserve
them, and answered questions must update the intended clients. Use the current
runtime and CommCare consumer oracles for the supported behavior.

**A source-led app with one consequential uncertainty.** Supply a document
with exact option codes, a table, a figure that carries a workflow requirement,
an explicitly excluded feature, and an undefined calculation. The model must
retrieve the relevant material, preserve exact requirements, respect the
exclusion, and ask about the missing calculation rather than invent it. Keep
the authoritative source accessible to reviewers. Include variants with
conflicting sources and variants where the user has already resolved the conflict.

**Worker language and conversation language.** Keep the conversation in English
while requesting worker-facing content in another supported language, with a
second language and supplied translations for selected phrases. Check the actual
forms, choices, validation, lists, and defaults, along with retained typed
references and honest translation review status. Do not reward a language badge
when the questions or messages remain wrong. Respect the current automatic-
translation and external-client capability boundaries.

**Shared data and access.** Reuse an existing Project table in an app with
location-based worker access. Observe who can find and act on records through
the relevant runtime. Verify that reusing a table did not change its rows or
other apps. Supply an explicit table-change request as a separate variant so
correctly authorized work is also tested. Treat unresolved worker or HQ setup
as a named prerequisite, not as an implemented permission system.

**A substantial edit to an existing app.** Begin with human edits and identities
that must survive. Ask for a new workflow and a rename or rearrangement that
touches referenced fields. Check references, record effects, prior data, and
unrelated content after the edit. Add a concurrent unrelated edit and a distinct
semantic conflict. The latter should produce a clear conflict rather than a
guessed name-based replacement. Include an app without original design lineage.

**Interrupted work.** Interrupt after a successful mutation, during a tool
response, after a user question, and across a context/model-generation change.
Resume through the real durable paths. Observe no duplicated records, apps, or
external data effects, no lost accepted work, and no completion claim before the
actual requested work is done. Use controlled interruption rather than sleeps
or repeatedly rerunning a lucky successful path.

Choose a small initial subset that exercises creation, dependency, edit, source,
and repair. Expand with the capability inventory and failures discovered in the
pilot. Include unfamiliar combinations and held-out wording so prompt examples
do not become the evaluation answers.

Human review considers requirement fidelity, worker comprehension and effort,
record behavior, useful defaults, necessary questions, and honest limitations.
Deterministic checks establish concrete failures where possible. Record all
attempts and incomplete outcomes. Do not collapse these dimensions into one
weighted score that could trade away missing requirements for shorter latency.
