# HQ round trip: the plans

These plans carry out the HQ round-trip research
([`docs/research/2026-09-26-hq-round-trip/`](../../research/2026-09-26-hq-round-trip/README.md)):
Nova imports any app CommCare HQ's editors can build, holds it typed, edits it,
and publishes it back. The research is the design. Its "Order of work" gives
seven steps, each with one cutover, and these plans follow that order. Where a
plan cites a defect, a section or a contract row, it means the research's
"Defects in Nova today", its section of that name, or its "Contracts this work
changes" table.

| Step | Plan | Depth |
|---|---|---|
| 1 | [The manifest and the harness](1-manifest-and-harness.md) | full |
| 2 | [Emission and publish fixes](2-emission-and-publish.md) | work items, planned in full when step 1 exits |
| 3 | [Expressions](3-expressions.md) | outline |
| 4 | [Platforms](4-platforms.md) | outline |
| 5 | [Case writes, forms and navigation](5-case-writes-forms-navigation.md) | outline |
| 6 | [Import](6-import.md) | outline |
| 7 | [The rest of the model](7-rest-of-model.md) | outline |

## Why only step 1 is planned in full

Step 1's exit is a harness that reproduces the symptom of every defect visible
in HQ's build, HQ's search, HQ's lookup upload, HQ's submission processing,
Core's runtime or an HQ editor save. That reproduction checks the premises of
step 2: each defect step 2 fixes is observed in the system it harms before its
fix is designed in detail, and step 2's proofs are written against the harness
step 1 builds rather than one imagined in advance. Each later step is planned
in full when the step before it exits, against the code as it then stands.

## Rules every plan follows

- A plan states decisions as decisions. It names what Nova does today in the
  present tense and what changes as "from step N".
- One concept per meaning; no reference a reader of the repo cannot see.
- One cutover per step. A step that changes the stored shape of Nova documents
  migrates all of that step's changes in one direct maintenance cutover
  (`docs/architecture/contracts.md`), with its production scan first, and
  leaves every document valid. One-off data migrations ship as a read-only scan
  script plus a separate migrate script in `scripts/`, which are removed after
  they run.
- No rollouts, flags, leases or transitional cutovers.
- Tests earn their boundary (`docs/testing.md`).
- Every CommCare fact a plan relies on is settled at source, in local
  checkouts of the Dimagi repositories at the research pins: commcare-hq `f57e85e02913` (with
  `525becc2963` where the research names it), formplayer `24383ac71bfb`,
  commcare-core `8e9ba8d908e9`, commcare-android `fd79cac4a0f1`, Vellum
  `01215f251c57`, commcare-connect `4a200c9d9`. A subagent's brief carries the
  same rules: search every checkout for every reader of a value, read each
  reader's enclosing condition, never read a repo through `git show` or raw
  URLs, never switch a shared checkout, and execute where reading leaves doubt.
- The repo is public. Plans never describe an HQ route a caller can use without
  a credential, or any other HQ weakness; client data and execution evidence
  stay out of the repo.
- A plan leaves `docs/plans/` when its step ships; what endures moves to the
  architecture docs or a subtree `CLAUDE.md`.

## Nova since the research

The research reads Nova `main` at `982d2630`. Main has since gained #699 and
#701 (dependency upgrades, MCP OAuth scope challenges on the HQ tools, an MCP
request-body cap) and the research itself (#698). None of them changes what the
research says Nova does. The one consequence for these plans: from #701 every
MCP tool that reads or writes HQ declares its scope through
`lib/mcp/scopes.ts::oauthScopeChallenge`, so each new or changed HQ-facing MCP
tool in these steps does the same.
