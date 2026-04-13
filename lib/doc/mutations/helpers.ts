/**
 * Shared helpers for builder-doc mutations.
 *
 * These helpers encapsulate the recurring patterns — cascade deletion,
 * sibling id deduplication, question path computation — that multiple
 * mutation kinds need. Keeping them in one place prevents subtle drift
 * (e.g. renameQuestion and moveQuestion both need consistent path logic).
 */

import type { Draft } from "immer";
import type { BlueprintDoc, QuestionEntity, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

/**
 * Remove a question and all of its descendants from the doc. Called by
 * `removeQuestion` and by `removeForm`/`removeModule` when they cascade.
 * Also strips the question from any ordering array; callers that delete
 * a question from a specific parent's order should do that themselves.
 */
export function cascadeDeleteQuestion(
	draft: Draft<BlueprintDoc>,
	uuid: Uuid,
): void {
	const children = draft.questionOrder[uuid];
	if (children) {
		// Snapshot the children list; recursive deletes mutate questionOrder.
		for (const childUuid of [...children]) {
			cascadeDeleteQuestion(draft, childUuid);
		}
		delete draft.questionOrder[uuid];
	}
	delete draft.questions[uuid];
}

/**
 * Remove a form from the doc, cascading to its question subtree. Does NOT
 * remove the form from its module's `formOrder[]` — that's the caller's
 * job, since `removeForm` knows the module uuid but a cascading
 * `removeModule` does not (the form order maps to the module directly).
 */
export function cascadeDeleteForm(
	draft: Draft<BlueprintDoc>,
	uuid: Uuid,
): void {
	const topLevelQuestions = draft.questionOrder[uuid] ?? [];
	for (const qUuid of [...topLevelQuestions]) {
		cascadeDeleteQuestion(draft, qUuid);
	}
	delete draft.questionOrder[uuid];
	delete draft.forms[uuid];
}

/**
 * Locate a question's parent (either a form or a group/repeat).
 * Returns the parent uuid and the question's current index within
 * that parent, or `undefined` if the question isn't in any order map.
 *
 * O(parents × siblings). Mutation code paths typically call this once
 * per mutation, so the cost is acceptable; if this ever shows up in
 * profiles we can maintain a reverse index on the doc.
 */
export function findQuestionParent(
	doc: BlueprintDoc,
	uuid: Uuid,
): { parentUuid: Uuid; index: number } | undefined {
	for (const [parentUuid, order] of Object.entries(doc.questionOrder)) {
		const index = order.indexOf(uuid);
		if (index !== -1) {
			return { parentUuid: parentUuid as Uuid, index };
		}
	}
	return undefined;
}

/**
 * Find the form uuid that contains a given question (direct child or any
 * nested descendant). Returns `undefined` if the question isn't reachable
 * from any form.
 *
 * Traverses up from the question through its parents until a form uuid is
 * found (form uuids appear as keys in both `formOrder[]` values and
 * `questionOrder` — but `draft.forms[uuid]` is the definitive check).
 */
export function findContainingForm(
	doc: BlueprintDoc,
	questionUuid: Uuid,
): Uuid | undefined {
	let cursor: Uuid | undefined = questionUuid;
	const visited = new Set<Uuid>();
	while (cursor !== undefined) {
		if (visited.has(cursor)) return undefined; // Defensive: cycle detection.
		visited.add(cursor);
		const parent = findQuestionParent(doc, cursor);
		if (!parent) return undefined;
		if (doc.forms[parent.parentUuid] !== undefined) {
			return parent.parentUuid;
		}
		cursor = parent.parentUuid;
	}
	return undefined;
}

/**
 * Deduplicate a question id against its siblings. If `desired` conflicts
 * with any existing sibling id, append `_2`, `_3`, ... until unique.
 *
 * CommCare requires unique question ids within each parent level — see
 * the "Sibling IDs must be unique" note in the root CLAUDE.md.
 */
export function dedupeSiblingId(
	draft: Draft<BlueprintDoc>,
	parentUuid: Uuid,
	desired: string,
	excludeUuid: Uuid | undefined,
): string {
	const siblings = draft.questionOrder[parentUuid] ?? [];
	const takenIds = new Set<string>();
	for (const sibUuid of siblings) {
		if (sibUuid === excludeUuid) continue;
		const sibId = draft.questions[sibUuid]?.id;
		if (sibId) takenIds.add(sibId);
	}
	if (!takenIds.has(desired)) return desired;
	for (let n = 2; n < 10_000; n++) {
		const candidate = `${desired}_${n}`;
		if (!takenIds.has(candidate)) return candidate;
	}
	throw new Error(
		`dedupeSiblingId: exhausted 9999 suffixes trying to dedupe "${desired}"`,
	);
}

/**
 * Compute the slash-delimited path from a form to a question, using its
 * CommCare ids (NOT UUIDs). Used by `rewriteXPathRefs` — XPath references
 * in the blueprint are path-based (`group_id/child_q`), not UUID-based.
 *
 * Returns `undefined` if the question isn't reachable from a form.
 */
export function computeQuestionPath(
	doc: BlueprintDoc,
	questionUuid: Uuid,
): string | undefined {
	const segments: string[] = [];
	let cursor: Uuid | undefined = questionUuid;
	const visited = new Set<Uuid>();
	while (cursor !== undefined) {
		if (visited.has(cursor)) return undefined;
		visited.add(cursor);
		if (doc.forms[cursor] !== undefined) {
			// Reached the form — path is complete.
			return segments.reverse().join("/");
		}
		const q = doc.questions[cursor];
		if (!q) return undefined;
		segments.push(q.id);
		const parent = findQuestionParent(doc, cursor);
		if (!parent) return undefined;
		cursor = parent.parentUuid;
	}
	return undefined;
}

/**
 * `never` assertion for exhaustive switch defaults. TypeScript flags
 * any missing mutation kinds as unassignable to `never` at compile time.
 */
export function assertNever(x: never): never {
	throw new Error(
		`unreachable: unexpected mutation kind: ${JSON.stringify(x)}`,
	);
}

/**
 * Deep-clone a question subtree with fresh UUIDs for every entity. The
 * returned object contains the new entities to insert into `questions`
 * and the `questionOrder` entries for the cloned subtree (keyed by the
 * new UUIDs).
 *
 * Field values (`id`, `label`, `calculate`, …) are preserved verbatim —
 * duplicated questions are intentionally identical to their source except
 * for identity. Sibling id deduplication is the caller's responsibility;
 * only the top-level duplicate typically needs deduping since nested
 * clones don't collide with sibling ids (they live under the newly-cloned
 * parent, which is a different context from the originals).
 *
 * Reads from `doc` (a plain BlueprintDoc or an Immer draft cast back to
 * read-only). Immer drafts read through the original, so this traversal
 * is safe even when called inside a `produce` callback.
 */
export function cloneQuestionSubtree(
	doc: BlueprintDoc,
	srcUuid: Uuid,
): {
	questions: Record<Uuid, QuestionEntity>;
	questionOrder: Record<Uuid, Uuid[]>;
	rootUuid: Uuid;
} {
	const clonedQuestions: Record<Uuid, QuestionEntity> = {};
	const clonedOrder: Record<Uuid, Uuid[]> = {};

	function cloneOne(uuid: Uuid): Uuid {
		const src = doc.questions[uuid];
		if (!src) {
			throw new Error(`cloneQuestionSubtree: missing question ${uuid}`);
		}
		const newUuid = asUuid(crypto.randomUUID());
		clonedQuestions[newUuid] = { ...src, uuid: newUuid };
		const childOrder = doc.questionOrder[uuid];
		if (childOrder !== undefined) {
			// Recursively clone each child and record the new child order
			// under the new parent UUID.
			clonedOrder[newUuid] = childOrder.map((childUuid) => cloneOne(childUuid));
		}
		return newUuid;
	}

	const rootUuid = cloneOne(srcUuid);
	return { questions: clonedQuestions, questionOrder: clonedOrder, rootUuid };
}
