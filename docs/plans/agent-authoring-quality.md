**Improve agent authoring**

Status: implementation authorized and in progress. Research and baseline
measurements are complete. Slice 1's [comparisons and interface decision](../research/agent-authoring-pilot-2026-09-12.md) are independently reviewed with all CI green in [PR #586](https://github.com/voidcraft-labs/commcare-nova/pull/586). Native tools are the selected direction: agents author wording and expressions as text; Nova binds names to canonical identities. The earlier proposal to expose typed reference parts was rejected as unnecessary agent work. Both native and hosted JavaScript candidates completed the corrected client workflow and repair scenarios. This establishes feasibility for that narrow task, not general quality or feature coverage. Total conservative model spend is $0.8024. Slice 2 must finish the remaining authoring surface before this stack lands. The delivery endpoint is a PR or
PR stack with independent subagent review for every slice and all required CI
green; merge is not authorized yet.

The objective is to help Nova's agents produce the best apps they can through
clear context, useful tools, good judgment, and feedback from the app. Quality
comes first. Reliability makes that quality repeatable. Time, cost, and context
size help explain a result and distinguish otherwise comparable approaches.

The user's 5,000-token prompt and 20,000-token tool figures express the ambition
of the work. They are not ceilings, release criteria, or a reason to withhold
helpful information. Keep context when its contribution justifies it. Change a
preferred approach when the evidence supports a better one.

CommCare belongs in the agent's orientation. Nova has its own authoring model
and produces CommCare apps; explaining both gives the model useful context.
The distinction concerns responsibility and vocabulary, not a ban on the word
CommCare. A possible opening is:

> You are the Solutions Architect in commcare nova. You help people design and
> build CommCare apps for data collection and case management.

The [research and measurements](../research/agent-authoring-2026-09-12.md)
support this plan. Current static paired probes put the tool contribution at
183,655 provider-counted tokens for the editor, 215,590 for the executor, and
21,300 for the design author. Those counts establish scale, not the quality of
an alternative. The two most recent local builds used older prompt versions.

**The design question.** For a realistic task, give an agent enough information
to understand the app, make the next meaningful decision, express it accurately,
and interpret the result. Remove work the server can already determine. Keep
the domain knowledge the agent needs to choose well. A smaller interface that
causes guessing, excessive retrieval, or difficult repairs is a regression.

Walk through examples from the agent's position while designing the interface:
what it knows, what it needs to learn, what choices remain open, and what the
result tells it. Use this as an engineering review method. Do not turn those
questions into another mandatory model-authored planning artifact.

**What remains authoritative.** The canonical Blueprint, identity-based AST,
shared mutation and authorization boundaries, valid canonical admission,
external-resource ownership, and durable recovery remain the foundation.
Design meaning stays private and non-executable. Construction candidates remain
private until canonical admission. Direct Builder and MCP edits remain usable
without reviewed-design metadata. Existing approved meaning cannot silently
change during implementation.

Prompts, tool shapes, how many model turns are needed, which decisions code
realizes, and when relevant material is supplied are design choices. Evaluate
them rather than treating the present implementation as a permanent contract.
When one changes, update the tests and documentation that describe it.

The [reviewed-build plan](reviewed-intent-atomic-change-sets-plan.md) already
owns Unit F, completion truth and Design history, and Unit G, substantial
reviewed edits and high-level MCP. This plan coordinates the authoring-interface
work with those units. It does not create another conformance system or another
edit authority. Historical foundation sections in that plan describe what is
implemented today; revise them when the corresponding replacement ships.

**Slice 1: a complete comparison on real authoring tasks.**

Extend the evidence provided by `/agents` just enough to capture the exact
request at the existing provider boundary, identify its prompt and tool
versions, and associate it with the resulting app. Use the current transport
seam and anatomy readers. Keep protected content in authorized inspection
artifacts, never operational logs. Capture request bodies without credentials.
Separate local estimates, provider counts, and reported usage/cache data.
Do not make a counting request on every production step.

Prepare the [comparison cases](agent-authoring-quality-cases.md), including
held-out variants. Each describes a user's task and observable app behavior,
not a golden Blueprint that rewards one architecture. Preserve real source
material where relevant. Reuse the current runtime, database fixtures, and
independent CommCare format/runtime oracles.

Develop two complete candidates for a small but representative set of tasks:

- compact native operations over a shared authoring vocabulary;
- a bounded authoring library using familiar JavaScript and shared type
  documentation, with direct inspection and interaction tools.

Use native operations as the reference candidate. The library is a hypothesis:
type reuse may help, but code may add avoidable complexity. Both must perform
creation, a dependent edit, and a meaningful repair through the real canonical
boundaries. A schema sketch alone cannot establish usability. Keep prototypes
isolated from the production surface and remove the losing implementation.

Run the current interface as the baseline with the same model and effort.
Compare completed apps, instructions, calls, rejected operations, and the
information used during repair. Then vary prompt content and model configuration
separately. Start with a small repeated pilot, inspect disagreements, and expand
only when the evidence is useful. Record model settings, source, tool versions,
termination, and all attempts so retries cannot hide failures. The user has
authorized intentional paid API comparisons with a $200 ceiling and an aim to
stay below $50. Root owns paid calls and records spend; subagents do not make
paid calls. Use bounded pilots and preserve their results before expanding.

This slice ends with a demonstrated task, an interface decision and its reasons,
known weaknesses, and a concrete implementation scope. It does not end merely
because one candidate uses fewer tokens. If both candidates make authoring
worse, redesign them before expanding their coverage. Avoid building a large
evaluation platform before the first useful comparison.

**Slice 2: ship the shared authoring boundary.**

Delivery is split into a codec foundation and the production interface. The
foundation provides text, message, query-expression and schema codecs, plus
scoped name binding. It is internal until the production mount supplies complete
call scopes, read projections, and current guidance across the supported tools.
The codec foundation is independently reviewed and green in PR #587. Production
editor/MCP integration is independently reviewed with all CI green in PR #588.
It binds complete call scopes, projects readable values, provides focused
references, and defers editor tools through hosted search. Current
local estimates are 623 prompt tokens and 307 initially available tool tokens;
the full 96-tool catalog remains about 80,000 tokens. The two [production-interface trials](../research/agent-authoring-integration-2026-09-13.md)
completed creation and clarified repair with independent Preview observations.
Their first requests used 47,323 and 12,336 input tokens. Discovery loaded nine
tools and reloaded several definitions during creation. The current guidance
slice separates static MCP guidance from app reads, shares a concise app overview
across editor/retry/MCP, and replaces copied plugin manuals with server references.
Scalar reference coverage, compact results,
build-executor integration, migration, and broader quality evidence remain open.
These intermediate counts do not complete the slice.

Expand the selected interface to the current supported authoring capabilities.
Use a coverage inventory to prevent accidental omissions, while keeping worker
tasks as the design driver. Distinguish capabilities already available through
direct tools from those currently representable in reviewed design. For example,
Connect is directly authorable but does not yet have a complete reviewed-design
carrier. Preserve that capability without pretending that reviewed coverage
already exists or adding it implicitly through a generic escape hatch.

Give shared types one model-facing definition where the transport permits it.
Accept simple text naturally and normalize it to the existing prose model.
Resolve authored names into existing typed ASTs with stable identity. Keep the storage representation behind the authoring boundary: ordinary wording, conditions, and same-call references should not require agents to construct identity nodes. Use grammar-based parsing, complete name scopes, ambiguity rejection, and reversible literal escaping. Preserve
omission versus clearing, complete replacements, and explicit external effects.
Bind context and identities already known to the server. Infer defaults only
when they are intrinsic to the operation; form-specific requiredness and
validation are not global record-property defaults.

Compose a valid atomic mutation when interdependent changes need to happen
together. Do not distribute a valid creation over invalid canonical steps.
Keep authorization, concurrency, read-set checks, idempotency, and commit
authority below the model interface. A code-based candidate must additionally
prove bounded execution, cancellation, deterministic write ordering, durable
replay, and a clear failure boundary before becoming a production write path.

Return enough state to inform the next decision. Success results should report
what changed and any identities the agent needs. Rejections should identify a
repairable cause and preserve useful accepted work according to the operation's
atomicity contract. Remove repeated encouragement and known-next-step ceremony.

This slice includes SA, build, direct MCP, copied plugin guidance, relevant
public docs, and subtree contracts. Ship one current interface. For incompatible
stored shapes, prefer a one-time scan and migration over runtime compatibility
bridges. The user permits loss of obsolete diagnostic or design metadata when
needed; preserve app behavior and collected data deliberately. Update MCP and
plugin contracts together and explain any required client refresh. The selected
production path must be complete and exercised before it replaces the current one.

**Slice 3: supply the right work and context to each role.**

Compile exact decisions already established by accepted design: identities,
record mappings, module/form placement, chosen layout, and other fully specified
construction. Identify the remaining semantic decisions explicitly. Do not
pretend free-form intent is executable or have code choose unstated workflow
behavior. The executor may become much smaller, and some work may need no
executor inference at all.

Make submission advance the server-owned review lifecycle where the next stage
is determined. Preserve independent review, durable suspension for user answers,
and honest failure. Do not require model calls whose only purpose is acknowledging
that the server is ready for another server action.

Rewrite prompts around each role's actual responsibility. Preserve useful
CommCare orientation, Nova's voice, domain distinctions, user priorities, and
deployment truth. Explain difficult concepts where needed, with measured examples.
Consolidate repeated rules and remove contradictions at their source. Evaluate
the complete composition, including tool descriptions, briefs, returned messages,
review instructions, extraction, translation, and MCP prompt pages. A tiny core
with a giant required appendix is still a giant instruction set.

Supply an authoritative view of the active work and its dependencies, with
bounded retrieval of omitted facts. Preserve source material for precise reads
of requirements, tables, and figures. Retrieval must be discoverable and include
enough context to interpret what it returns. An extract becomes an index and
useful synthesis rather than the architect's only surviving source.

Evaluate reasoning continuation against current model guidance and intact
response-item pairing. Retain compatible prior reasoning when it helps a
continuing task; choose an explicit reset when it no longer applies. Couple
tool discovery to the existing server policy without confusing visibility with
authorization. Measure newly loaded definitions and accumulated reference
material, not only the opening request.

**Slice 4: observe workflow quality through Unit F.**

Use Unit F's deterministic implementation projection, sequence-bound conformance,
grounded quality review, bounded correction, and completion report. Add useful
runtime observations to that evidence: what the worker sees, which branches
are reachable, where submission leads, and which records change.

The early comparison harness uses disposable canonical apps and data through
the production Preview and persistence paths. The product capability must define
equally explicit isolation and cleanup, be tied to the canonical sequence it
observes, and require appropriate authorization for its data. It must not run
a staged private candidate, create a second Preview evaluator, or seed examples
into a user's existing working records. Define the resource lifecycle before
exposing this as an agent tool.

Keep source-based facts and deterministic failures distinct from subjective
quality judgments. A model reviewer cannot invent a critical blocker. Correct
implementation defects through ordinary valid changes; amend reviewed design
when user meaning changes. Finish the Unit F user-facing completion and Design
history surfaces through its existing plan rather than leaving competing reports.

**Slice 5: carry the same quality through edits and MCP.**

Integrate Unit G with the selected authoring boundary and Unit F evidence.
Substantial edits must reconcile the current app with the user's new intent,
preserve unrelated human changes, and avoid fabricating the rationale of apps
that lack design history. Ordinary direct edits remain immediate.

External agents receive the same useful concepts and consistent results,
including clear capability discovery and source access. Test a real external
client, its prompt-loading behavior, and sibling `nova-plugin` workflows; internal
SA success does not prove that MCP is pleasant to use. Use existing app/run
authority, resumable questions, explicit destructive consequences, and durable
retry behavior. Avoid exposing a public private-workspace protocol solely to
reuse an internal implementation.

**Slice 6: calibrate, finish, and remove obsolete guidance.**

Run the broader and held-out task set through the final integrated system.
Review resulting apps without revealing which variant produced them. Investigate
quality disagreements in the source, app, and trace. Compare model and effort
profiles only after the interface comparison is interpretable; GPT-6 Astra is
a candidate, not a promised fix. Keep model-specific additions small and justified.

Confirm capability coverage, edit fidelity, source fidelity, recovery, CommCare
compatibility, and user-facing completion. Retire obsolete schemas, prompt
fragments, copied recipes, and prototype paths as their replacements land.
Keep enduring behavior in architecture/subtree docs; remove completed plan
sections. Evidence can justify more context, different operation boundaries, or
retaining a model role. Follow that evidence.

**How the slices land.** These are coherent delivery outcomes, not mandatory PR
counts. Split or stack implementation where the dependencies make sense. Keep
production-behavior changes complete across their affected surfaces; experimental
comparisons stay out of the public API. Arrange the stack around dependency order,
not an arbitrary train of token reductions. Verify available repository hosting
and CI behavior when preparing it rather than assuming a particular stack feature.

For each shipping unit, run checks that prove the changed contract, an independent
review of the complete frozen change, and the required CI. Coordinate Nova and
plugin changes. Follow authorized merges through actual migration/deployment and
serving-revision verification, then clean up branches and worktrees. Stacking
changes review logistics; it does not replace integration evidence.

The program is complete when agents can reliably build and revise better apps
through the selected interface, with full supported capability, useful source
and runtime evidence, clear prose, truthful completion, and no obsolete parallel
system. Report the remaining limitations plainly. A token reduction or one
successful demonstration cannot establish that result.
