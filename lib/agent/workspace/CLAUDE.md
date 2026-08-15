# lib/agent/workspace — the Tool Workspace

The workspace owns the document and the ordering every shared-tool invocation
runs under. Tool bodies never receive a `BlueprintDoc` argument and cannot
nominate a `prevDoc`: each invocation reads one immutable
`WorkspaceSnapshot` (`ctx.snapshot.doc`) and may perform at most ONE
workspace mutation operation — `applyBatch`, `applyStages`, or
`adoptAuthoritativeSnapshot` — which the workspace verifies against the exact
revision the invocation read. A stale revision or a second write is a loud
protocol error, never a silent overwrite.

## Authority

- `types.ts` — the vocabulary: `WorkspaceSnapshot`, `WorkspaceRevision`,
  `ToolInvocationIdentity`, `ToolInvocationContext` (the ONLY context tool
  bodies see — it exposes no persistence methods), `WorkspaceMutationOutcome`,
  `ToolWorkspace`.
- `canonicalHost.ts` — `CanonicalMutationHost`, the persistence seam behind
  the canonical workspace. Two hosts implement it: `GenerationContext` (chat —
  inline guarded commit, SSE/event emission after commit, terminal-error
  latches, the authorized conflict reload) and `McpContext` (MCP — the
  transactional guarded save; no reload, a rejection propagates to the wire
  envelope).
- `canonicalWorkspace.ts` — `CanonicalMutationWorkspace`, the one
  implementation both canonical surfaces use. The private change-set
  workspace (`lib/agent/change-set/workspace.ts`) implements the same
  tool-facing contract over durable staged state; its extensions —
  `appId: string | null` (a genesis change set has no app row) and automatic
  external read-set capture — stay inside that host. Shared tool bodies receive
  one workspace contract and never supply design attribution or explicit
  read-set bookkeeping.

## Invariants

1. **The workspace owns its current document.** Every accepted commit adopts
   the HOST's committed doc (a concurrent peer edit merged in); an
   authoritative zero-diff proof adopts through
   `ctx.adoptAuthoritativeSnapshot`; an authoritative commit conflict
   (`BlueprintCommitRejectedError`) adopts one fresh AUTHORIZED snapshot via
   the host's reload before the error surfaces. Nothing else replaces the
   document.
2. **Ordering is explicit, synchronous, and asserted — at the dispatch
   boundary.** `invoke` allocates the invocation ordinal before any await
   and runs bodies strictly in that order; an out-of-order start throws
   instead of corrupting the document, and no body ever reads a torn or
   stale-overwritten doc (`__tests__/canonicalWorkspace.test.ts` pins it
   with a delayed first branch). The ordinal captures DISPATCH order —
   whether dispatch matches model-emit order remains the SDK-boundary
   property it always was: an await inserted upstream of `invoke` reorders
   dispatch itself, which a dependent sibling call surfaces as a visible
   missing-target error, never as silent state corruption. Ordering-
   dependent creation therefore rides one semantic creation call or the
   executor's server-ordered native call sequence.
3. **The optimistic gate lives in the workspace.** `applyBatch` /
   `applyStages` run the whole-document verdict (with the unioned lookup
   context) against the invocation's snapshot before anything reaches the
   host; the host's canonical commit re-applies the admitted batch to fresh
   locked state. A gate rejection returns `{ ok: false, error }`, persists
   nothing, and advances nothing. A multi-stage sequence gates and persists
   as ONE save — a rejection anywhere commits zero stages.
4. **No persistence bypass.** `ToolInvocationContext` exposes no
   `recordMutations`/`recordMutationStages`;
   `lib/agent/__tests__/toolSourceGuards.test.ts` bans the canonical writers
   and external write services from tool imports outside declared capability
   adapters.

## Tests

`__tests__/canonicalWorkspace.test.ts` — ordering, one-write budget, stale
revision, gate rejection, adoption, conflict recovery (with and without a
host reload), and the no-persistence-methods introspection. Semantic parity
of the whole surface lives in the existing tool/adapter suites
(`lib/agent/tools/__tests__`, `lib/mcp/__tests__/sharedToolAdapter.test.ts`,
`lib/mcp/__tests__/stagedToolTransactionalCommit.test.ts`).
