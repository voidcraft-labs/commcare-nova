import type { Draft } from "immer";
import type {
	BlueprintDoc,
	Mutation,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import { transformBareHashtags } from "@/lib/preview/engine/labelRefs";
import { rewriteXPathRefs } from "@/lib/preview/xpath/rewrite";
import {
	cascadeDeleteQuestion,
	cloneQuestionSubtree,
	computeQuestionPath,
	dedupeSiblingId,
	findQuestionParent,
} from "./helpers";

/**
 * Fields on a `QuestionEntity` that carry XPath expressions directly —
 * these get rewritten via the Lezer-based `rewriteXPathRefs` parser when
 * a referenced question is renamed.
 *
 * Mirrors `xpathFields` in `lib/services/builderStore.ts` exactly so the
 * two rewrite paths behave identically until Phase 1b deletes the legacy
 * store. Notably excluded:
 *   - `validation_msg`: user-facing error text, not an XPath expression.
 *   - `label`, `hint`: prose fields that may embed bare hashtag refs
 *     (`#form/foo`), handled separately via DISPLAY_FIELDS below.
 *   - `required`: legacy store omits it; keeping parity to avoid scope creep.
 */
const XPATH_FIELDS = [
	"relevant",
	"calculate",
	"default_value",
	"validation",
] as const satisfies readonly (keyof QuestionEntity)[];

/**
 * Fields that contain prose text which may embed bare hashtag references
 * (`#form/question_id`, `#case/property`) inside otherwise-plain content.
 * These fields are rewritten via `transformBareHashtags` → `rewriteXPathRefs`
 * so only the hashtag substrings are parsed, not the entire field as XPath.
 */
const DISPLAY_FIELDS = [
	"label",
	"hint",
] as const satisfies readonly (keyof QuestionEntity)[];

/**
 * Question mutations. Six kinds:
 *   - addQuestion, updateQuestion: simple entity-level edits
 *   - removeQuestion: cascade delete subtree
 *   - moveQuestion: cross-parent reorder + xpath rewrite + sibling dedup
 *   - renameQuestion: id change + xpath rewrite of any referencing fields
 *   - duplicateQuestion: deep clone with new UUIDs, dedupe sibling id
 *
 * This task implements only addQuestion and updateQuestion. The cascade,
 * move, rename, and duplicate handlers land in Tasks 9–12.
 */
export function applyQuestionMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addQuestion"
				| "removeQuestion"
				| "moveQuestion"
				| "renameQuestion"
				| "duplicateQuestion"
				| "updateQuestion";
		}
	>,
): void {
	switch (mut.kind) {
		case "addQuestion": {
			// Parent must be a form or a group/repeat that already has an
			// order entry (groups/repeats are added via addQuestion + an
			// empty order slot, so we also allow parents that are registered
			// questions).
			const parentExists =
				draft.forms[mut.parentUuid] !== undefined ||
				draft.questions[mut.parentUuid] !== undefined;
			if (!parentExists) return;
			const order = draft.questionOrder[mut.parentUuid] ?? [];
			const index = mut.index ?? order.length;
			const clamped = Math.max(0, Math.min(index, order.length));
			order.splice(clamped, 0, mut.question.uuid);
			draft.questionOrder[mut.parentUuid] = order;
			draft.questions[mut.question.uuid] = mut.question;
			// If the new question is a group/repeat, pre-seed its order slot
			// so child insertions have a valid parent to target immediately.
			if (mut.question.type === "group" || mut.question.type === "repeat") {
				draft.questionOrder[mut.question.uuid] ??= [];
			}
			return;
		}
		case "updateQuestion": {
			const q = draft.questions[mut.uuid];
			if (!q) return;
			Object.assign(q, mut.patch);
			return;
		}
		case "removeQuestion": {
			// Guard: nothing to remove if the entity doesn't exist.
			if (draft.questions[mut.uuid] === undefined) return;
			// Splice the uuid out of its parent's order, if it's registered
			// in any order map. A question that exists but isn't in any order
			// map is an unusual state, but we still fall through to cascade.
			const parent = findQuestionParent(draft, mut.uuid);
			if (parent) {
				const order = draft.questionOrder[parent.parentUuid];
				if (order) {
					order.splice(parent.index, 1);
					draft.questionOrder[parent.parentUuid] = order;
				}
			}
			// Recursively delete the question entity and any descendants
			// (children of a group/repeat, their children, etc.).
			cascadeDeleteQuestion(draft, mut.uuid);
			return;
		}
		case "moveQuestion": {
			const q = draft.questions[mut.uuid];
			if (!q) return;
			// Destination parent must exist as either a form or a group/repeat.
			const destIsForm = draft.forms[mut.toParentUuid] !== undefined;
			const destQ = draft.questions[mut.toParentUuid];
			const destIsContainer =
				destQ && (destQ.type === "group" || destQ.type === "repeat");
			if (!destIsForm && !destIsContainer) return;

			const sourceParent = findQuestionParent(draft, mut.uuid);
			const oldPath = computeQuestionPath(draft, mut.uuid);
			const crossParent =
				sourceParent !== undefined &&
				sourceParent.parentUuid !== mut.toParentUuid;

			// Remove from source order.
			if (sourceParent) {
				const srcOrder = draft.questionOrder[sourceParent.parentUuid];
				if (srcOrder) {
					srcOrder.splice(sourceParent.index, 1);
					draft.questionOrder[sourceParent.parentUuid] = srcOrder;
				}
			}

			// Dedupe id against new siblings if we crossed a parent boundary.
			if (crossParent) {
				const deduped = dedupeSiblingId(
					draft,
					mut.toParentUuid,
					q.id,
					mut.uuid,
				);
				q.id = deduped;
			}

			// Insert at destination.
			const destOrder = draft.questionOrder[mut.toParentUuid] ?? [];
			const clamped = Math.max(0, Math.min(mut.toIndex, destOrder.length));
			destOrder.splice(clamped, 0, mut.uuid);
			draft.questionOrder[mut.toParentUuid] = destOrder;

			// Path change on move is NOT automatically rewritten in Phase 1a.
			//
			// `rewriteXPathRefs` is a leaf-replacement rewriter: it finds the
			// matching absolute path and replaces only the final NameTest
			// segment. That works when a question is RENAMED in place (the
			// last segment changes, surrounding segments stay the same) but
			// NOT when a question is MOVED to a different depth or branch
			// (the entire path prefix changes). Attempting to reuse this
			// helper for moves silently corrupts references: a `g1/source`→
			// `g2/source` move rewrites `/data/g1/source` to `/data/g1/g2/source`
			// (doubled path), a `grp/source`→`source` move is a no-op, and
			// hashtag refs only match for top-level ids.
			//
			// TODO(phase-1b): add a proper path-to-path rewriter (either extend
			// `lib/preview/xpath/rewrite.ts` with a prefix-swap mode or write a
			// new `lib/doc/mutations/pathRewrite.ts`). Until then, cross-level
			// moves leave referencing XPath fields stale — which is strictly
			// safer than rewriting them incorrectly.
			void oldPath;
			return;
		}
		case "renameQuestion": {
			const q = draft.questions[mut.uuid];
			if (!q) return;
			const oldPath = computeQuestionPath(draft, mut.uuid);
			q.id = mut.newId;
			if (oldPath !== undefined) {
				rewriteRefsAllQuestions(draft, oldPath, mut.newId);
			}
			return;
		}
		case "duplicateQuestion": {
			const src = draft.questions[mut.uuid];
			if (!src) return;
			const parent = findQuestionParent(draft, mut.uuid);
			if (!parent) return;

			// Clone the subtree off the current draft state. `cloneQuestionSubtree`
			// returns undefined if the source or a descendant is missing — we
			// already guarded on the source above, so undefined here means
			// something is structurally wrong with the doc. Skip the duplicate
			// rather than propagating a throw out of the reducer.
			const cloned = cloneQuestionSubtree(
				draft as unknown as BlueprintDoc,
				mut.uuid,
			);
			if (!cloned) return;
			const { questions: clonedQ, questionOrder: clonedO, rootUuid } = cloned;

			// Install all cloned entities into the draft.
			for (const [uuid, q] of Object.entries(clonedQ)) {
				draft.questions[uuid as Uuid] = q;
			}
			for (const [parentUuid, order] of Object.entries(clonedO)) {
				draft.questionOrder[parentUuid as Uuid] = order;
			}

			// Dedupe the top-level clone's id against existing siblings at this
			// parent level. Nested clones live under the new (cloned) parent and
			// therefore can't conflict with the originals — no dedup needed there.
			const clone = draft.questions[rootUuid];
			if (clone) {
				const deduped = dedupeSiblingId(
					draft,
					parent.parentUuid,
					clone.id,
					rootUuid,
				);
				clone.id = deduped;
			}

			// Splice the clone right after the source in the parent's order.
			const parentOrder = draft.questionOrder[parent.parentUuid];
			if (parentOrder) {
				parentOrder.splice(parent.index + 1, 0, rootUuid);
				draft.questionOrder[parent.parentUuid] = parentOrder;
			}
			return;
		}
	}
}

/**
 * Walk every question in the doc and rewrite references to a question
 * whose path ended in `oldLeafId` and now ends in `newLeafId`. This is a
 * leaf-rename operation: the question stays at the same tree position,
 * only its final `id` segment changes.
 *
 * Two passes:
 *   1. `XPATH_FIELDS` (calculate/relevant/validation/default_value) run
 *      through the Lezer-based `rewriteXPathRefs`, which surgically edits
 *      matching absolute paths (`/data/.../old_id` → `/data/.../new_id`).
 *   2. `DISPLAY_FIELDS` (label/hint) run through `transformBareHashtags`
 *      so only the embedded `#form/...` references are rewritten, not the
 *      surrounding prose.
 *
 * Called by `renameQuestion` only — `moveQuestion` cannot use this path
 * because it has to rewrite path PREFIXES, not leaf segments.
 */
function rewriteRefsAllQuestions(
	draft: Draft<BlueprintDoc>,
	oldPath: string,
	newLeafId: string,
): void {
	const xpathRewriter = (expr: string) =>
		rewriteXPathRefs(expr, oldPath, newLeafId);
	for (const q of Object.values(draft.questions)) {
		for (const field of XPATH_FIELDS) {
			const expr = q[field];
			if (typeof expr === "string" && expr.length > 0) {
				const rewritten = xpathRewriter(expr);
				if (rewritten !== expr) {
					q[field] = rewritten as never;
				}
			}
		}
		for (const field of DISPLAY_FIELDS) {
			const text = q[field];
			if (typeof text === "string" && text.length > 0) {
				const rewritten = transformBareHashtags(text, xpathRewriter);
				if (rewritten !== text) {
					q[field] = rewritten as never;
				}
			}
		}
	}
}
