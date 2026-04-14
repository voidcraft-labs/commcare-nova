# Phase 4 Session Prompt — Generation + Replay as Mutation Stream

Paste this into a fresh session verbatim to execute Phase 4 of the commcare-nova builder state re-architecture.

---

You're executing Phase 4 of a multi-phase builder state re-architecture in commcare-nova. This work chains across sessions — each phase gets a fresh context. Phases 0, 1a, 1b, 2, and 3 are merged to main. The overall design was approved in a /brainstorming session at the start of this chain; the canonical spec lives at `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md`.

━━━ READ IN THIS ORDER BEFORE DOING ANYTHING ELSE ━━━

1. Invoke Skill(superpowers:using-superpowers), Skill(superpowers:subagent-driven-development), Skill(superpowers:writing-plans). Optional: Skill(superpowers:brainstorming) for framework provenance — not to re-brainstorm, just to see how this chain started.
2. `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md` — full spec. **Section 7 "Generation + replay as one mutation stream"** is Phase 4's primary territory. Also skim Section 1 (BlueprintDoc), Section 2 (BuilderSession), Section 4 (dissolution table — done) for context.
3. `docs/superpowers/plans/2026-04-12-phase-0-scaffolding.md`
4. `docs/superpowers/plans/2026-04-12-phase-1a-blueprintdoc-store.md`
5. `docs/superpowers/plans/2026-04-12-phase-1b-doc-wiring.md`
6. `docs/superpowers/plans/2026-04-12-phase-2-url-state.md`
7. `docs/superpowers/plans/2026-04-13-phase-3-engine-dissolution.md` — the most recent precedent. Study the task sizing, the review cadence, and the review-fix pattern.
8. `CLAUDE.md` (root) — the "Builder State" section documents the post-Phase-3 architecture (provider stack, no engine class, session store).
9. `lib/services/builder.ts` — `applyDataPart({ store, docStore }, type, data)`. This is the current generation stream dispatcher. Phase 4 replaces it with a mutation mapper.
10. `lib/services/builderStore.ts` — what's LEFT on the legacy store after Phase 3: `phase`, `agentActive`, `postBuildEdit`, generation lifecycle actions (`startGeneration`, `setSchema`, `setPartialScaffold`, `setScaffold`, `setModuleContent`, `setFormContent`, `advanceStage`, `setFixAttempt`, `completeGeneration`, `acknowledgeCompletion`, `loadApp`, `loadReplay`, `setReplayMessages`, `setAgentActive`, `setGenerationError`), `generationData` + `partialModules`, replay state, `appId`, `_docStore`. **This is all Phase 4 territory.**
11. `lib/services/logReplay.ts` — `ReplayStage.applyToBuilder({ store, docStore })` is a Phase 3 shim. Phase 4 rewrites replay as a true mutation stream (no legacy-store hop).

━━━ MERGED PHASES (lineage) ━━━

- **Phase 0 (merged)** — `lib/doc/types.ts`, `lib/session/types.ts`, `lib/routing/{types.ts,location.ts}` scaffolding + unit tests for pure helpers.
- **Phase 1a (merged)** — `lib/doc/store.ts`, `lib/doc/provider.tsx`, `lib/doc/mutations/**`, domain hooks.
- **Phase 1b (merged `c738781`)** — `syncOldFromDoc` adapter, `useBlueprintMutations` legacy-shape hook, entity-mutation call-site migration, gutted legacy store's mutation action bodies.
- **Phase 2 (merged `021acce`)** — URL-driven nav/selection: `lib/routing/hooks.tsx`, `lib/routing/builderActions.ts`, `LocationRecoveryEffect`, `BuilderReferenceProvider`, RSC URL validation, `useBlueprintMutations` rewritten uuid-first, deleted legacy store `selected`/`screen`/`navEntries`/`navCursor` + engine nav/select/undo/redo/deleteSelected.
- **Phase 3 (merged `<FILL IN HASH AFTER MERGE>`)** — BuilderEngine class deleted. BuilderSession store created (`cursorMode`, sidebars, `activeFieldId`, `connectStash`, `focusHint`, `newQuestionUuid`). Scoped contexts for scroll, edit guard, drag state. `signalGrid` nanostore replaces engine energy counters. `syncOldFromDoc` adapter + all mirrored entity fields deleted from legacy store. `EngineController` subscribes to the doc store directly. `MoveQuestionResult.renamed` + `QuestionRenameResult.xpathFieldsRewritten` instrumentation landed with toast UX. `BuilderProvider` is now a provider stack (`StoreContext` → `BlueprintDocProvider` → `BuilderSessionProvider` → `ScrollRegistryProvider` → `EditGuardProvider` → `BuilderFormEngineProvider` → children). Test count: 910 → 1001 (+91). Stats: 85 files, +6134/-2957 lines.

━━━ WHAT PHASE 4 OWNS ━━━

Per spec Section 7 + the Phase 4 row of the migration table:

1. **Translation layer** — `lib/generation/mutationMapper.ts` — pure `toMutations(event, doc): Mutation[]`. Given a doc-state snapshot and an SA agent event, returns the mutations to apply. Every agent event shape (`scaffold`, `moduleStart`, `addForm`, `addQuestion`, `updateQuestion`, `setCaseConfig`, `setConnect`, `error`) translates to one or more doc mutations.

2. **Stream consumer** — `useAgentStream(stream)` hook that:
   - Calls `sessionStore.beginAgentWrite(initialStage)` (or equivalent — may need to add this action to `BuilderSession` if it doesn't exist yet).
   - For each event from the stream: `doc.applyMany(toMutations(event, doc.getState()))`.
   - On error: `sessionStore.failAgentWrite(err)`.
   - On completion: `sessionStore.endAgentWrite()`.
   - `beginAgentWrite` pauses zundo tracking; `endAgentWrite` resumes and captures the entire generation as a single undo entry.

3. **Delete generation lifecycle fields + actions from legacy store**:
   - Fields: `generationData`, `partialModules`, `partialScaffold`, `scaffold`, `progressCompleted`, `progressTotal`, `generationStage`, `generationError`, `statusMessage`.
   - Actions: `startGeneration`, `setSchema`, `setPartialScaffold`, `setScaffold`, `setModuleContent`, `setFormContent`, `advanceStage`, `setFixAttempt`, `completeGeneration`, `setGenerationError`, `scaffoldToMutations`.
   - These are replaced by the mutation stream. The SA's structure events (scaffold, moduleStart) become mutation batches; partial state doesn't exist — scaffold modules ARE the doc, they just start sparse and fill in.

4. **Delete replay machinery**:
   - `replayStages`, `replayDoneIndex`, `replayExitPath`, `replayMessages` fields from legacy store.
   - `loadReplay`, `setReplayMessages` actions.
   - `ReplayStage` class + `applyToBuilder` shim in `lib/services/logReplay.ts`.
   - `ReplayController.tsx` rewrites.
   - `inReplayMode` becomes `useAgentStatus().stage === 'replay'`.

5. **Move `agentActive`, `postBuildEdit`, `editMadeMutations` to BuilderSession**:
   - Add `agentStatus: { active, stage?, error?, postBuildEdit, editMadeMutations }` (or spread as individual fields — the spec shows an `agentStage` / `agentError` shape).
   - Actions: `beginAgentWrite(stage)`, `endAgentWrite()`, `failAgentWrite(err)`, `markEditMadeMutations()`.
   - Delete corresponding fields + actions from legacy store.
   - `useBuilderAgentActive()`, `useBuilderInReplayMode()`, `useBuilderPhase()` all migrate to session hooks.

6. **`phase` becomes derived, not stored**:
   - `useBuilderPhase()` returns a computed value: Idle when doc is empty + no agent → Idle; agent active → Generating; agent just finished → Completed (transient); otherwise → Ready.
   - Phase transitions happen automatically from session state + doc state. No more explicit `setPhase` calls.
   - At the end of Phase 4, the legacy store holds essentially nothing — `appId` + `_docStore` + `setDocStore` at most. Phase 6 deletes the file entirely.

**Phase 4 NON-GOALS (leave for later phases):**
- Spec Section 6 `VirtualFormList` — **Phase 5**.
- Full deletion of `lib/services/builderStore.ts`, `hooks/useBuilder.tsx`, `lib/services/builderSelectors.ts` — **Phase 6**.
- Full `noRestrictedImports` Biome enforcement — **Phase 6**.

━━━ WORKFLOW (READ CAREFULLY) ━━━

1. Read the spec + completed plans + relevant source directories first. Don't skip. Lineage matters.

2. Use the superpowers:writing-plans skill to author `docs/superpowers/plans/YYYY-MM-DD-phase-4-generation-stream.md`. Single plan document, likely 10-14 tasks. Each task specifies: files touched, code shape, success criteria, explicit commit message. Cite spec sections per task.

3. Pause for user approval before any code changes. Present a concise task sequencing summary.

4. On approval, create an isolated worktree via the superpowers:using-git-worktrees pattern:
   ```bash
   git worktree add -b phase-4-<slug> ../commcare-nova-phase4 main
   ```
   All work happens in `../commcare-nova-phase4`. Do not push the branch.

5. For each plan task, use the superpowers:subagent-driven-development pattern:
   (a) Dispatch a fresh Agent(general-purpose) with a self-contained briefing: context, files, success criteria, commit message. It doesn't see this thread.
   (b) After the task commits, IMMEDIATELY dispatch TWO review agents IN PARALLEL:
       • Agent(general-purpose) for spec-compliance review — verify the task's spec citations are met in code. Cross-check spec language against implementation.
       • Agent(code-reviewer) for adversarial code review — hunt for bugs, don't give benefit of the doubt, flag every uncertain code path.
   (c) Apply any blocker fixes from the reviews IN THE SAME TASK'S BRANCH before moving to the next task. Do not let review findings accumulate across tasks.
   (d) Use TaskCreate/TaskUpdate to track progress. Mark in_progress when starting, completed when the task's reviews are clean.

6. **Parallelize independent tasks in separate worktrees when possible.** Phase 3 ran T1–T5 in parallel worktrees branched from main, then merged them sequentially. Works well when tasks don't chain. For Phase 4, the translation layer (`toMutations`) is a pure-function task that can run in parallel with the session-store expansion task.

7. Pause before merge. Run final: `npx tsc --noEmit && npm run lint && npm test -- --run && npm run build`. Report commit list + diff stats + test count delta. Wait for user approval + manual smoke test.

8. On merge approval: `git checkout main && git merge --no-ff phase-4-<slug> -m "..." && git worktree remove ../commcare-nova-phase4 && git branch -d phase-4-<slug>`. Do NOT push.

━━━ WHAT WENT WRONG IN PHASE 3 — DO NOT REPEAT ━━━

These are fresh lessons from Phase 3, not recycled from Phase 2. Internalize them:

### 1. Plan's line numbers drift from reality

The Phase 3 plan cited specific line numbers for call sites (e.g. "line ~226 in FormRenderer.tsx"). Several were stale by the time implementers reached them — the file had shifted since the plan was written. Implementers correctly adapted by greping for the actual pattern, but it cost time.

**Rule:** In Phase 4's plan, cite file paths + grep patterns, NOT line numbers. Example: `lib/services/builder.ts` "the `case 'data-scaffold'` branch of `applyDataPart`". Line numbers are a trap.

### 2. Adversarial review caught 2 BLOCKERS in T11 and T13 that the implementer + spec reviewer both missed

**T11 blocker:** `data-blueprint-updated` (SA edit-tool emission path) was silently dropped after `completeGeneration(_blueprint)` stopped decomposing the blueprint. **Every post-build SA edit** (updateModule, createForm, removeForm, rename) was silently lost. The spec reviewer passed the task; the code reviewer caught it by tracing the edit-tool flow end-to-end.

**T13 blocker:** `BuilderFormEngineProvider` installed the doc store via `useEffect`, but React child effects fire before parent effects. `FormScreen → useFormEngine → activateForm` ran BEFORE the parent install effect, hit `!this.docStore`, and silently returned. **Every direct-link form URL load** showed a broken preview. Only caught because the code reviewer specifically hunted for "install timing" races.

**Rule:** When a task changes a signature, DELETION path, or lifecycle (provider install, context wiring, effect ordering), the code reviewer must trace end-to-end flows, not just local correctness. Write review prompts that demand "trace at least one realistic user flow from event → user-visible outcome."

### 3. Spec reviewers can be fooled by "semantically equivalent" variants

Phase 3's T1 had a PASS spec review, but the code reviewer caught that `useFulfillPendingScroll` silently dropped the `isSelected` guard — regressing within-form Tab/arrow navigation. The spec reviewer saw the hook existed, ticked the box, and moved on. The code reviewer verified actual behavior.

**Rule:** Spec compliance ≠ behavioral equivalence. When an engine method moves to a hook, verify the new hook re-fires on the same transitions the old method did. Spec reviews should include "trace the lifecycle transition" not just "the symbol exists."

### 4. Plan's "API design note" options can still be wrong

Phase 3's T10c said "Audit `setEditScope` call sites. Spec inventory said zero callers — maybe delete the whole concept." But the implementer found a real caller in SignalGrid.tsx. Kept `computeEditFocus` as a pure function. Good judgment call.

**Rule:** Never let the plan assume a grep result — the plan should tell the implementer to grep first AND provide both paths. "If zero callers, delete. If any caller, migrate to X." Both paths must be documented so the implementer doesn't improvise.

### 5. Dead code hooks need deletion, not preservation

Phase 3's T3 created `useSignalGridFrame` as a forward-compatible hook the plan specified. The reviewer correctly flagged it as dead code with a divergent timing constant vs the actual rAF owner. Deleted in review-fix.

**Rule:** Do not ship "forward-compatible" API surfaces that have zero consumers in the same PR. Either wire them up OR delete. The plan may specify them, but the implementer should push back if they're genuinely unused.

### 6. Pre-commit hooks can mask lint errors across merge boundaries

After merging T5 into phase-3-engine-dissolution, the pre-commit hook failed on a lint error in `useBuilderShortcuts.ts` that was technically pre-existing but had been masked because the file was edited in both branches. Had to manually fix before the merge commit would land.

**Rule:** Run `npx tsc --noEmit && npm run lint && npm test -- --run` AFTER each merge, not just after each task. Merges can surface issues that individual branches missed.

### 7. `useEffect` + cross-store refs = timing land mines

Multiple Phase 3 issues traced back to "install reference in useEffect, consume reference immediately elsewhere" patterns. T6 had a mild version (fixed during review-fix). T13 had the severe blocker (BL-1). The fix in both cases was: install synchronously via `useState`, NOT in an effect.

**Rule:** When a child context/hook depends on a reference being installed by a parent, the install MUST happen synchronously during render, or the child must be resilient to a null install (defensive no-op with retry). `useEffect` installs are asymmetric with child `useEffect` consumers.

### 8. Parallel worktrees work, but merge order matters

Phase 3 ran T1–T5 in parallel worktrees branched from main. They all touched `builderEngine.ts` (each deleting different members) and `hooks/useBuilder.tsx` (each adding different providers). Merges into the phase branch hit 5 conflicts. All were textually trivial to resolve, but took ~20 minutes of manual conflict resolution.

**Rule:** Parallelizing is worth it for 2x–3x throughput wins. Plan the merge order upfront (smallest first, biggest last). Expect conflicts in shared files — don't plan tasks that rewrite the same JSX block.

━━━ CHAIN FORWARD ━━━

When Phase 4 merges, before ending the session, write the Phase 5 session prompt by copying this template and updating:
- "Merged phases" — add Phase 4's merge commit hash and a one-paragraph summary of what landed
- "What Phase N owns" — fill in Phase 5's scope from spec Section 6 (VirtualFormList)
- "What went wrong" — honest retrospective with Phase 4's lessons (new ones, not recycled — Phase 3's lessons stay for reference but Phase 4 will have its own)

Save the Phase 5 prompt to `docs/superpowers/prompts/phase-5-session-prompt.md`. Commit it as part of the Phase 4 merge. Tell the user the exact path so they can paste it directly into the next fresh session.

Execute when the user gives you the go-ahead. Start by reading the spec.
