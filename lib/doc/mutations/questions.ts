import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

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
		case "removeQuestion":
		case "moveQuestion":
		case "renameQuestion":
		case "duplicateQuestion":
			// Implemented in later tasks.
			throw new Error(`applyQuestionMutation: ${mut.kind} not implemented`);
	}
}
