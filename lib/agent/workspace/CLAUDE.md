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
- The private change-set workspace (`lib/agent/change-set/workspace.ts`)
  implements this contract over durable pending mutations. Architect builds,
  ordinary chat and MCP app edits use it. Candidate and canonical identities,
  session authorization and durable request receipts stay inside its host.
- `canonicalHost.ts` and `canonicalWorkspace.ts` retain the immediate canonical
  implementation for callers that intentionally use that boundary. Do not route
  ordinary agent edits through it to bypass private work. Builder commits still
  use the canonical mutation kernel.
- `WorkspaceSnapshot.mode` distinguishes canonical from private operation.
  Shared tool bodies receive the same contract and never supply build attribution.

## Invariants

1. **The workspace owns its current document.** Every accepted operation adopts
   its host's authoritative result. A canonical host may adopt an authorized
   reload after a commit conflict or a proved zero-diff result through
   `ctx.adoptAuthoritativeSnapshot`. Private save conflicts retain the candidate
   and require explicit restart; they never adopt a newer base implicitly.
2. **Ordering is explicit, synchronous, and asserted — at the dispatch
   boundary.** `invoke` allocates the invocation ordinal before any await
   and runs bodies strictly in that order; an out-of-order start throws
   instead of corrupting the document, and no body ever reads a torn or
   stale-overwritten doc (`__tests__/canonicalWorkspace.test.ts` exercises it
   with a delayed first branch). The ordinal captures DISPATCH order —
   whether dispatch matches model-emit order remains the SDK-boundary
   property it always was: an await inserted upstream of `invoke` reorders
   dispatch itself, which a dependent sibling call surfaces as a visible
   missing-target error, never as silent state corruption. Ordering-
   dependent creation therefore awaits its predecessor before dispatch; a form
   creation cannot race the module whose returned identity it needs.
3. **Admission and publication have distinct boundaries.** A private operation
   admits the complete pending mutation batch against its original base and may
   retain whole-app completeness findings. A saved checkpoint must pass the full
   canonical gate under lock and match the exact original canonical sequence.
   A rejected edit changes no candidate state; a rejected save retains the
   candidate. There is no implicit merge after another editor saves. Immediate
   canonical callers still gate their whole operation before persistence.
4. **No persistence bypass.** `ToolInvocationContext` exposes no
   `recordMutations`/`recordMutationStages`;
   `lib/agent/__tests__/toolSourceGuards.test.ts` bans the canonical writers
   and external write services from tool imports outside declared capability
   adapters.

## Tests

`__tests__/canonicalWorkspace.test.ts` — ordering, one-write budget, stale
revision, gate rejection, the lookup-context union (a table swap must resolve
definitions for both the snapshot's table and the candidate's, on `applyBatch`
and `applyStages` alike), adoption, conflict recovery (with and without a
host reload), and the no-persistence-methods introspection. Semantic parity
of the whole surface lives in the existing tool/adapter suites
(`lib/agent/tools/__tests__`, `lib/mcp/__tests__/sharedToolAdapter.postgres.test.ts`,
`lib/mcp/__tests__/context.postgres.test.ts`);
`lib/agent/tools/__tests__/lookupCarrierMutation.test.ts` is the tool-level
home for mutations on a doc that carries a lookup reference and for mutations
that introduce one.

MCP persistence proofs use real SDK calls and migrated Postgres. They inspect
complete durable changes and logs, reject the patch stage with a native trigger,
and hold actual app/event locks to prove the request awaits its writes. Pure
result-projection tests cover chat-summary stripping and saved-value notes.
