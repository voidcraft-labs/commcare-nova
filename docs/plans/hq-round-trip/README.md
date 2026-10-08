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
| 1 | The manifest and the harness | done: [`proof/README.md`](../../../proof/README.md) |
| 2 | [Emission and publish fixes](2-emission-and-publish.md) | work items, planned in full next |
| 3 | [Expressions](3-expressions.md) | outline |
| 4 | [Platforms](4-platforms.md) | outline |
| 5 | [Case writes, forms and navigation](5-case-writes-forms-navigation.md) | outline |
| 6 | [Import](6-import.md) | outline |
| 7 | [The rest of the model](7-rest-of-model.md) | outline |

## Step 1 is done

Step 1 built the evidence every later step stands on, and its plan has left
this directory. What endures lives where it is read:

- **The surface manifest**, `lib/commcare/surface/`: the generated surface of
  everything HQ, Core and Android accept in an app, and the authored entries
  that give each inventory row and each gate its disposition
  (`lib/commcare/CLAUDE.md`, "The surface manifest"). The project-space check
  reads its flags' identities from the gate entries, and the weekly pin pull
  request (`.github/workflows/upstream-pins.yml`) brings upstream changes in
  as one reviewed pull request.
- **The proof lane**, `proof/`: CommCare's own code reading Nova's exports at
  the pinned commits, over a reproducible corpus, on every pull request:
  HQ's import, build, case processing, editors, receiver, restore, search
  views and Connect repeater; CommCare Core's runtime; Formplayer's own
  application; HQ's Web Apps client in Chromium; CommCare Connect's own
  server; and commcare-android's own code, in a stage of its own.
  `proof/README.md` holds what it proves (the bar, the intent, manifest and
  sensitivity checks, proofs 1 to 5, each judged over every reader), the
  corpus, the registers, the spelling rules, the defect rows of the plan's
  work item 12, and step 1's decisions; `proof/CLAUDE.md` holds the rules
  that bind changes to it; `docs/architecture/contracts.md` the delivery
  contract it enforces.
- **The known-defect register**, `proof/known-defects.json`: one entry per
  symptom the lane reproduces, each with its document and its retained
  control, each resting on a record a real reader made (an entry of a
  reader names it in its artifact: `formplayer@`, `webapps@`, `connect@`,
  `android@`). Its `defect` is the research's number or one of the
  harness's own findings, numbered from 31 in
  [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md),
  which also records the research claims the harness corrected. It holds no
  entry for an equivalence: two spellings every reader reads alike are a
  spelling rule, proven by tests that run each of those readers on both.

Every row of step 1's defect table now has register entries that reproduce on
their controls or a test that runs HQ's own page or view over a Nova export
(`proof/views`), with one exception that a test settles the other way:
"12, same-type child", whose input no Nova document holds
(`proof/targeted/__tests__/unproducedInputs.test.ts`). The clause step 1 was
once done but for, defect 3's unknown-question warning, shows on
`targeted-save-to-case-read`; and "20, CommTrack", which step 1 had left out
as an input Nova cannot produce, is a row again, since Nova's gate admits the
read it needs (finding 68). `proof/README.md` ("What the lane does not
observe") names what is still not run, each with the reader that would
settle it: none is out of reach, and step 2's work takes each up where it
fixes the defect it belongs to.

## Why each later step is planned when the one before it exits

Each defect part step 2 fixes that the lane reproduces is observed in the
system it harms, by a register entry, before its fix is designed in detail,
and step 2's proofs are written against the harness step 1 built rather than
one imagined in advance. Each later step is planned in full when the step
before it exits, against the code as it then stands.

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
