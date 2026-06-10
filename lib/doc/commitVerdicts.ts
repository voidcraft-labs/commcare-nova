/**
 * Mutation-commit verdicts — the shared "may this batch commit?"
 * decision every write surface consults BEFORE persisting or
 * dispatching a mutation batch.
 *
 * The generalization of the `identifierVerdicts.ts` pattern from one
 * rule family (field ids) to the whole validator: apply the batch to a
 * candidate doc, run the introduced-error gate
 * (`lib/commcare/validator/gate.ts::evaluateCommit`) under the scope the
 * batch can affect (`scopeOfMutations`), and return a typed verdict.
 * One verdict, every caller — the SA/MCP tool layer
 * (`lib/agent/tools/common.ts::guardedMutate`) and the builder's
 * dispatch hook (`useBlueprintMutations`) consume the same function, so
 * "rejected here, accepted there" can't drift between surfaces.
 *
 * Semantics live entirely in `evaluateCommit` — introduced-error diffing,
 * the building-phase completeness deferral, and the complete-phase
 * ratchet are never re-derived here. Reducers stay total and never call
 * this: a degenerate historical event must still replay.
 *
 * Bypasses: undo/redo, hydration, the agent stream, and replay write
 * through the store directly — they replay already-committed states.
 * The session store's `switchConnectMode` is the one DELIBERATE
 * live-edit bypass (owner decision pending): enabling Connect
 * introduces `CONNECT_FORM_MISSING_BLOCK` on every form by construction
 * — no form carries a block before the mode exists — so gating that
 * dispatch would make Connect un-enableable on complete apps. The
 * export boundary rejects the incomplete state instead, until Connect's
 * enable flow seeds/restores every form's block in the enabling batch.
 *
 * Pure — the candidate `nextDoc` is computed via Immer `produce` over
 * the same `applyMutations` reducer every committed batch runs through.
 * Accepting callers commit the candidate itself (the builder's
 * `commitDoc`, the MCP transactional write), so the doc the gate
 * validated IS the doc that lands — one reducer run, no
 * candidate-vs-committed divergence even for the one nondeterministic
 * reducer (`duplicateField`'s minted clone uuid).
 */

import { produce } from "immer";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import {
	type CommitPhase,
	evaluateCommit,
} from "@/lib/commcare/validator/gate";
import { scopeOfMutations } from "@/lib/commcare/validator/scopeOfMutations";
import type { AppDoc } from "@/lib/db/types";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation, MutationResult } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";

export type { CommitPhase };

/**
 * Validity-gate phase from an app document's lifecycle status — the ONE
 * derivation every server surface shares (the chat route reads it off
 * the app doc it already loaded for ownership; the MCP adapter off the
 * doc it loaded for the tool call). A `generating` app is still under
 * construction (completeness deferred); everything else is `complete`
 * (the ratchet holds). The phase is never taken from a client-supplied
 * flag: the app doc is the authority on its own build window.
 */
export function commitPhaseForAppStatus(status: AppDoc["status"]): CommitPhase {
	return status === "generating" ? "building" : "complete";
}

/**
 * The verdict shape every commit surface consumes. `nextDoc` is always
 * present: an accepting caller commits/persists it; a rejecting caller
 * discards it and renders the `introduced` findings (each carries the
 * validator's person-to-person `message`). The accepting arm also
 * carries the reducers' per-mutation `results` (rename/move metadata)
 * from the candidate run, so a caller that commits `nextDoc` directly
 * never needs a second reducer pass to recover them.
 */
export type MutationCommitVerdict =
	| { ok: true; nextDoc: BlueprintDoc; results: MutationResult[] }
	| { ok: false; nextDoc: BlueprintDoc; introduced: ValidationError[] };

/**
 * Gate one mutation batch against the doc it would apply to. An empty
 * batch passes without running validation — there is nothing to
 * introduce.
 *
 * `phase` follows `evaluateCommit`'s contract: `"building"` while the
 * app is under construction (completeness deferred), `"complete"`
 * otherwise (the ratchet — an edit may never take a complete entity
 * incomplete).
 */
export function mutationCommitVerdict(
	prevDoc: BlueprintDoc,
	mutations: Mutation[],
	phase: CommitPhase,
): MutationCommitVerdict {
	if (mutations.length === 0) {
		return { ok: true, nextDoc: prevDoc, results: [] };
	}

	let results: MutationResult[] = [];
	const nextDoc = produce(prevDoc, (draft) => {
		results = applyMutations(draft, mutations);
	});
	const scope = scopeOfMutations(prevDoc, mutations);
	const verdict = evaluateCommit({ prevDoc, nextDoc, scope, phase });
	return verdict.ok
		? { ok: true, nextDoc, results }
		: { ok: false, nextDoc, introduced: verdict.introduced };
}

/**
 * Compose a rejection's findings into one person-to-person message — the
 * `{ error }` envelope the SA/MCP tool layer returns, and the prose the
 * builder's rejection notice shows. Each finding's `message` is already
 * a self-contained sentence naming what's wrong and where it lives; this
 * adds only the frame: nothing was changed, fix the edit and retry.
 */
export function describeIntroducedErrors(
	introduced: readonly ValidationError[],
): string {
	const lines = introduced.map((err) => `- ${err.message}`).join("\n");
	const plural = introduced.length === 1 ? "a new problem" : "new problems";
	return `This change wasn't applied — it would introduce ${plural}:\n${lines}\nNothing was changed. Adjust the edit so it doesn't create ${
		introduced.length === 1 ? "this problem" : "these problems"
	}, then try again.`;
}
