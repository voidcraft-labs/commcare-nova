/**
 * Typed drag-and-drop payloads for the virtualized form editor.
 *
 * Pragmatic DnD stores arbitrary `Record<string | symbol, unknown>` on each
 * source + drop target. We wrap the read/write pair in these helpers so every
 * callsite sees strongly-typed data — losing the brand at the `getData`
 * boundary and recovering it at `monitor.onDrop` is where DnD bugs usually
 * live.
 *
 * Convention: every payload is tagged with a `kind` discriminator, mirroring
 * the pattern Atlassian uses in their Trello / tree examples. Factory
 * functions return `T & Record<string, unknown>` so the payload satisfies
 * the library's index-signature requirement without widening the nominal
 * type we expose to our own call sites.
 */

import type { Uuid } from "@/lib/doc/types";

/** Intersection helpers that satisfy pragmatic DnD's return-type
 *  requirements:
 *   - `draggable.getInitialData` expects `Record<string, unknown>`.
 *   - `dropTargetForElements.getData` expects
 *     `Record<string | symbol, unknown>` (the symbol allowance is used
 *     by `attachClosestEdge`, which stores the edge under a Symbol key). */
type DraggableRecord<T> = T & Record<string, unknown>;
type DropRecord<T> = T & Record<string | symbol, unknown>;

// ── Source (draggable) payloads ───────────────────────────────────────

/** Tag on a draggable row's `source.data`. The dragged thing is ALWAYS a
 *  question (leaf) or a group/repeat (container) — identified by uuid. */
export interface DraggableQuestionData {
	readonly kind: "draggable-question";
	readonly uuid: Uuid;
}

const DRAGGABLE_QUESTION_KIND: DraggableQuestionData["kind"] =
	"draggable-question";

export function makeDraggableQuestionData(
	uuid: Uuid,
): DraggableRecord<DraggableQuestionData> {
	return { kind: DRAGGABLE_QUESTION_KIND, uuid };
}

export function isDraggableQuestionData(
	data: Record<string, unknown>,
): data is Record<string, unknown> & DraggableQuestionData {
	return data.kind === DRAGGABLE_QUESTION_KIND;
}

// ── Drop target payloads ──────────────────────────────────────────────

/** A question row drop target — drop here with a top/bottom edge to place
 *  the dragged item before or after this question. */
export interface DropQuestionData {
	readonly kind: "drop-question";
	readonly uuid: Uuid;
	readonly parentUuid: Uuid;
	readonly siblingIndex: number;
}

/** A group header drop target — drop here to insert at position 0 inside
 *  the group. */
export interface DropGroupHeaderData {
	readonly kind: "drop-group-header";
	readonly uuid: Uuid;
	/** Nesting parent of the group itself (not the group's own children). */
	readonly parentUuid: Uuid;
	readonly siblingIndex: number;
}

/** An empty-container drop target — drop here to become the sole child of
 *  the empty group/repeat. */
export interface DropEmptyContainerData {
	readonly kind: "drop-empty-container";
	readonly parentUuid: Uuid;
}

export type DropTargetData =
	| DropQuestionData
	| DropGroupHeaderData
	| DropEmptyContainerData;

// Factory helpers — keep the `kind` discriminator in one place.
export function makeDropQuestionData(
	uuid: Uuid,
	parentUuid: Uuid,
	siblingIndex: number,
): DropRecord<DropQuestionData> {
	return { kind: "drop-question", uuid, parentUuid, siblingIndex };
}

export function makeDropGroupHeaderData(
	uuid: Uuid,
	parentUuid: Uuid,
	siblingIndex: number,
): DropRecord<DropGroupHeaderData> {
	return { kind: "drop-group-header", uuid, parentUuid, siblingIndex };
}

export function makeDropEmptyContainerData(
	parentUuid: Uuid,
): DropRecord<DropEmptyContainerData> {
	return { kind: "drop-empty-container", parentUuid };
}

/**
 * Narrow an arbitrary drop-target data bag (as received from
 * `location.current.dropTargets[i].data`) into our discriminated union.
 * Returns `null` when the data isn't one of ours — defensive against
 * concurrently-registered unrelated targets.
 */
export function readDropTargetData(
	data: Record<string | symbol, unknown>,
): DropTargetData | null {
	const kind = data.kind;
	if (
		kind === "drop-question" ||
		kind === "drop-group-header" ||
		kind === "drop-empty-container"
	) {
		return data as unknown as DropTargetData;
	}
	return null;
}

// ── Cycle protection ──────────────────────────────────────────────────

/**
 * Return `true` when `candidate` is `ancestor` or is in the subtree rooted
 * at `ancestor` (as defined by `questionOrder`). Used by drop-target
 * `canDrop` filters to block the user from dragging a group onto one of
 * its own descendants — such a drop would reparent the group under itself
 * and produce a cycle in `questionOrder`.
 *
 * Pure traversal with a visited set — safe against cyclic `questionOrder`
 * (which shouldn't happen but can during a mutation-replay race). Works
 * on the plain-object snapshot the doc store hands out via `getState()`.
 */
export function isUuidInSubtree(
	questionOrder: Record<string, readonly string[]>,
	ancestor: string,
	candidate: string,
): boolean {
	if (ancestor === candidate) return true;
	const visited = new Set<string>([ancestor]);
	const stack: string[] = [...(questionOrder[ancestor] ?? [])];
	while (stack.length > 0) {
		const uuid = stack.pop();
		if (uuid === undefined) break;
		if (uuid === candidate) return true;
		if (visited.has(uuid)) continue;
		visited.add(uuid);
		const children = questionOrder[uuid];
		if (children) stack.push(...children);
	}
	return false;
}

/**
 * Derive the parent uuid under which the dragged source would land if
 * dropped on the given target. Used with `isUuidInSubtree` to detect
 * cycle-creating drops without the drop-target rows needing to know the
 * full moveQuestion arg shape.
 *
 *   - `drop-question`        → target's parent (source becomes sibling)
 *   - `drop-group-header`    → the group uuid (source becomes child)
 *   - `drop-empty-container` → the empty container uuid (source becomes
 *                              sole child)
 */
export function targetContainerUuidFor(drop: DropTargetData): Uuid {
	switch (drop.kind) {
		case "drop-question":
			return drop.parentUuid;
		case "drop-group-header":
			return drop.uuid;
		case "drop-empty-container":
			return drop.parentUuid;
	}
}
