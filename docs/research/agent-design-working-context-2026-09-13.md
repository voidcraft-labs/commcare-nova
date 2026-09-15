# One current design state

The [fourth garden trial](agent-design-selection-2026-09-13.md) accumulated four
server state packets. Later packets included both the reviewed source and the
current design. Old findings remained beside current findings with reused
positional labels. The durable history was useful for diagnosis, but carrying
all of it into every request made the current task harder to identify.

The request projection now retains one current server state. It identifies
those messages by their durable append provenance; a user message with the
same heading or even identical text stays in the conversation. Reasoning, tool
discovery, complete tool exchanges and other messages retain their content and
order. Every original state stays in the ledger. Provider compaction continues
to replace the earlier conversation with its checkpoint, followed by fresh
state derived from the workspace.

Each author phase records its current state, including when the candidate has
returned to an earlier value. The packet includes the current design once.
Focused `inspectDesign` source selections still read the immutable reviewed
design. Empty claim sections and repeated directions to continue are removed.
When new user content reopens authoring, the accepted design's old questions
are no longer separately presented as still awaiting answers.

## Recorded-trial replay

The [measurement record](agent-design-working-context-results.json) identifies
the captured trial and snapshot digest. This offline comparison used the
production request projection and state renderer. It kept the recorded
candidate and review values unchanged, including the old candidate's selection
metadata, to isolate the context change. It made no provider calls.

| State material | Packets | Characters |
| --- | ---: | ---: |
| Recorded trial | 4 | 207,372 |
| Keep the current packet | 1 | 70,484 |
| Include the current design once | 1 | 34,750 |

All 67 other messages in the final durable snapshot remain byte-equivalent
under the same JSON serialization and in the same order. These figures count
state-message characters, not the entire request, tokens or billed usage.

Controlled Responses and real Postgres tests cover a resumed author request,
retained ledger rows, source inspection after review, and fresh state after
provider compaction. A direct projection test distinguishes a server packet
from identical user text while preserving reasoning and a complete tool pair.
The existing answered-question case checks that old accepted questions do not
reappear as a separate blocking section.

This establishes the context projection and recovery behavior. The garden
trial remains unsuccessful. Explicit choice wording, the distinction between
construction dependencies and worker preconditions, and complete app/runtime
quality remain open before another intentional paid trial.
