# Valid Revisions, Reviewed Intent — implementation deviations log

Sibling to `reviewed-intent-atomic-change-sets-plan.md`. Each entry records
where the implementation deviates from the plan's letter, and why. The plan
owner reconciles the plan text; this file never edits the plan.

## Unit A — Tool Workspace and canonical commit kernel

1. **`WorkspaceSnapshot.externalContextDigest` deferred to Unit B.** The plan
   (§9.1) includes it in the snapshot. The canonical host captures no external
   context at invocation time — lookup/media/organization state is resolved
   fresh inside the commit — so any digest minted in Unit A would be a
   fabrication. The change-set workspace introduces it when there is real
   captured external state to bind.

2. **`ToolInvocationContext.appId` stays `string`, not `string | null`
   (§9.1).** `null` arises only in a genesis change set (no app row yet), a
   Unit B/E state. Widening now would force dead null-handling into ~48
   canonical tool bodies; Unit B widens the type when the state exists.

3. **`applyBatch`'s `intentIds`/`readSet` arguments deferred to Unit B**
   (§9.1). No design session or durable read-set record exists yet to receive
   them. The registry policy (`readSets` per entry) already declares WHICH
   kinds each tool will capture.

4. **`MutationApplicationPolicy` is the existing commit-option shape.** Unit A
   defines it as `{ expectedOrganizationRevision? }` — the organization
   revision fence that exists today — rather than inventing a broader policy
   vocabulary with no second consumer. §9.9's policy dimensions land with the
   read-set machinery.

5. **`ctx.adoptAuthoritativeSnapshot` added to the invocation context** (not
   in §9.1's listing). Two existing behaviors require a tool to hand the
   workspace a FRESHER authoritative document: the automation update's
   zero-diff proof (adopts the authoritative Blueprint+organization snapshot,
   on both its no-op and conflict branches) and the archive service's
   cross-store commit receipt (`setLocationArchived` commits persona mutations
   in its own app-locked transaction and returns the exact committed doc).
   The old channel was the tool nominating `newDoc` in its result — exactly
   the "caller-owned document" the plan abolishes — so the explicit, budgeted
   adoption operation is the principled replacement. It counts toward the
   invocation's one-workspace-write budget.

6. **§9.8 tool-level staging classification refined to mutation-kind
   granularity.** `renameCaseProperties` is classified `exclusive`;
   `removeModule` / `updateModule` / `editField` are `allowed` with the
   `case-store-migration` capability even though their batches can compose
   the retirement/row-migration saga, because whether a given call does so is
   batch content, not tool identity. The change-set admission fence (Unit B)
   keys on the batch-exclusive mutation KINDS (`renameCaseProperties`,
   `retireCaseType`), which is strictly more precise than a per-tool ban and
   matches how `applyBlueprintChange` routes today.

7. **The workspace allocates the invocation ordinal itself.** §9.2's `invoke`
   takes a caller-supplied `ToolInvocationIdentity`; here the caller supplies
   `toolName` + optional `requestId` (the AI SDK `toolCallId`) and the
   workspace mints the ordinal synchronously at `invoke` entry — a
   caller-supplied ordinal would let a buggy wrapper forge ordering, the
   exact hazard the ordinal exists to remove.

8. **Kernel receipt shape kept honest to today.** §9.5's
   `CanonicalCommitReceipt` lists `migration` / `postCommitWork` /
   `batchId` / `deduped`; Unit A's kernel returns `{ seq, committedDoc,
   deduped }` exactly as `commitGuardedBatch` always did, with migration
   outcomes staying on `applyBlueprintChange`'s result. The typed
   `CanonicalCommitSidecar` union is a Unit B deliverable; Unit A ships the
   server-owned transaction-hook seam (`CanonicalCommitTransactionHooks`)
   those sidecars extend.

9. **`ToolWorkspace.currentSnapshot()` added** (plan lists `inspect()`), as
   the read-only introspection the surface wrappers and tests need; the
   richer `inspect()` diagnostics belong to the change-set workspace.
