/**
 * Legacy-index / path → uuid resolvers.
 *
 * Phase 1b temporary bridge. The old builder store exposes a mutation
 * surface keyed by (mIdx, fIdx, QuestionPath); the new doc operates on
 * uuids. This module lets a call site dispatch to the doc without first
 * rewriting its own selection-tracking code to use uuids — the resolvers
 * do the lookup against the current doc snapshot at event-handler time.
 *
 * These helpers read from a `BlueprintDoc` snapshot (not via hooks). They
 * are called inside click/keyboard handlers, where React isn't rendering
 * and subscription isn't needed. `useBlueprintMutations()` in Task 3 wires
 * the snapshot through automatically.
 *
 * Phase 2 deletes this file: selection flows through the URL, so callers
 * will read the current uuid from `useLocation()` directly and the legacy
 * index arguments disappear.
 */

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";

/** Resolve a module uuid from a zero-based module index. */
export function resolveModuleUuid(
	doc: BlueprintDoc,
	mIdx: number,
): Uuid | undefined {
	if (mIdx < 0 || mIdx >= doc.moduleOrder.length) return undefined;
	return doc.moduleOrder[mIdx];
}

/** Resolve a form uuid from (mIdx, fIdx). */
export function resolveFormUuid(
	doc: BlueprintDoc,
	mIdx: number,
	fIdx: number,
): Uuid | undefined {
	const modUuid = resolveModuleUuid(doc, mIdx);
	if (!modUuid) return undefined;
	const formUuids = doc.formOrder[modUuid];
	if (!formUuids || fIdx < 0 || fIdx >= formUuids.length) return undefined;
	return formUuids[fIdx];
}

/**
 * Resolve a question uuid from (mIdx, fIdx, path).
 *
 * `path` is a slash-delimited string of semantic question ids, matching
 * the `QuestionPath` branded type from `lib/services/questionPath.ts`. The
 * walk descends through `questionOrder` segments, matching each id to the
 * questions in the current order slot at that depth.
 */
export function resolveQuestionUuid(
	doc: BlueprintDoc,
	mIdx: number,
	fIdx: number,
	path: string,
): Uuid | undefined {
	const formUuid = resolveFormUuid(doc, mIdx, fIdx);
	if (!formUuid) return undefined;

	const segments = path.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) return undefined;

	let parentUuid: Uuid = formUuid;
	let foundUuid: Uuid | undefined;

	for (const segment of segments) {
		const order = doc.questionOrder[parentUuid];
		if (!order) return undefined;
		foundUuid = order.find((uuid) => doc.questions[uuid]?.id === segment);
		if (!foundUuid) return undefined;
		parentUuid = foundUuid;
	}

	return foundUuid;
}
