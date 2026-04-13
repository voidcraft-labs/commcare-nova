import type { Draft } from "immer";
import type { BlueprintDoc, Mutation, QuestionEntity } from "@/lib/doc/types";
import { rewriteXPathRefs } from "@/lib/preview/xpath/rewrite";
import {
	cascadeDeleteQuestion,
	computeQuestionPath,
	dedupeSiblingId,
	findQuestionParent,
} from "./helpers";

/**
 * Fields on a `QuestionEntity` that may contain XPath expressions referencing
 * other questions by path. When a question is renamed or moved, these fields
 * across ALL questions in the doc must be rewritten to point to the new path.
 *
 * Mirrors the set in the existing `lib/services/builderStore.ts` rename
 * handler; update both if CommCare adds new XPath-bearing fields.
 */
const XPATH_FIELDS = [
	"calculate",
	"relevant",
	"required",
	"validation",
	"validation_msg",
	"default_value",
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

			// Rewrite XPath refs (old path → new path).
			// rewriteXPathRefs matches the full oldPath as a path segment sequence
			// and replaces the LAST segment with newLeafId. To produce the correct
			// new absolute path, we pass the full newPath as the "leaf" value —
			// this causes /data/<oldPath> to become /data/<newPath>, regardless
			// of whether the id changed, the parent changed, or both.
			const newPath = computeQuestionPath(draft, mut.uuid);
			if (
				oldPath !== undefined &&
				newPath !== undefined &&
				oldPath !== newPath
			) {
				rewriteRefsAllQuestions(draft, oldPath, newPath);
			}
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
		case "duplicateQuestion":
			// Implemented in a later task.
			throw new Error(`applyQuestionMutation: ${mut.kind} not implemented`);
	}
}

/**
 * Walk every question in the doc and rewrite XPath references that point
 * to `oldPath`. The `newLeafId` replaces the last segment of matching
 * references; `rewriteXPathRefs` already knows how to produce the new
 * canonical form from this pair.
 *
 * Called by both `moveQuestion` (path changed due to re-parenting) and
 * `renameQuestion` (path changed due to id update).
 */
function rewriteRefsAllQuestions(
	draft: Draft<BlueprintDoc>,
	oldPath: string,
	newLeafId: string,
): void {
	for (const q of Object.values(draft.questions)) {
		for (const field of XPATH_FIELDS) {
			const expr = q[field];
			if (typeof expr === "string" && expr.length > 0) {
				q[field] = rewriteXPathRefs(expr, oldPath, newLeafId) as never;
			}
		}
	}
}
