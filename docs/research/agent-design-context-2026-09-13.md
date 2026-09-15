# Design context and tool discovery

The design author now receives a task brief and one generated capability catalog.
The brief keeps useful CommCare orientation, source fidelity, concrete app quality
judgment, and the decisions an author owns. The catalog includes platform
constraints once. It no longer lists construction tools unavailable to this role
or explains storage attestations the server now binds.

The reviewer shares the app quality guidance, then receives its own remit and
finding rules. Neither role is asked to reproduce persistence or review
orchestration. Saved updates return `ok` and `deduplicated`; completion and
independent review remain server-gated.

Design operations load through native hosted tool search. Questions, waiting,
and completion remain immediately available. Production and `/agents` use the
same mount; its durable digest now includes the owned tools, hosted discovery,
and provider loading flags. Discovery survives in model history without entering
the local operation queue.

## Local measurements

These are **estimates**, using `o200k_base` over prompt text and the same JSON tool
wrappers on both revisions. They are not provider input counts or billing data.
The comparison is `0b575ef8` against this slice.

| Context | Before | After |
| --- | ---: | ---: |
| Author brief | 3,998 | 1,211 |
| Complete author system prompt | 8,368 | 3,517 |
| Reviewer system prompt | 2,279 | 1,374 |
| Full tool catalog | 25,419 | 25,060 |
| Initially loaded tool definitions | 25,419 | 432 |
| Largest deferred definition | 8,359 | 8,341 |

The remaining large definition is `updateLookupTables`. Deferral changes when its
cost is paid; it does not simplify that interface. Large loaded schemas,
repeated accepted design facts during construction, and broader app quality
comparisons remain unfinished work in the authoring plan.

## Verification and limits

The installed OpenAI SDK sent `tool_search` and the intended `defer_loading`
flags to a controlled Responses peer. The same test decoded hosted discovery,
executed a subsequent native inspection exactly once, persisted the provider
items, and replayed the search and native result on the next request. Required
questions retained their exact forced client tool while the deferred catalog
remained mounted. Existing compaction and real Postgres lifecycle tests exercised
the changed production factory.

The related suite passed 608 tests across 37 files. These tests establish wire,
persistence, and lifecycle behavior. No paid model call was made for this change,
and no claim of improved generated app quality follows from the token counts.
A live author and reviewer comparison is still needed.

The design follows the official guidance to provide clear objectives and useful
context, use tools with a defined purpose, and expose definitions when needed:
[OpenAI prompting guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6),
[GPT-6 Astra prompt guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra),
and [tool search](https://developers.openai.com/api/docs/guides/tools-tool-search).
