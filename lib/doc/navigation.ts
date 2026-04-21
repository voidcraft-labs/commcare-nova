/**
 * Domain-native navigation primitives for the builder's canvas layer.
 *
 * Everything here operates directly on the normalized `BlueprintDoc`
 * (the `fields` map + `fieldOrder` adjacency list) and identifies
 * positions by `Uuid` rather than slash-delimited id paths.
 *
 * Why uuid-first:
 *   - Uuids are stable across renames — a path-based identity breaks when
 *     a user edits a field id.
 *   - The mutation surface (`moveField`, `removeField`, etc.) already takes
 *     uuids, so path↔uuid translation adds a round-trip with no upside.
 *   - Walking the normalized doc directly avoids the need to reassemble a
 *     nested tree as an intermediate shape.
 *
 * Three operations cover the full keyboard / header surface:
 *   - `flattenFieldRefs(doc, formUuid)` — depth-first visual order,
 *     used for Tab/Shift-Tab navigation and neighbor-selection on delete.
 *   - `getFieldMoveTargets(doc, fieldUuid)` — the previous/next sibling
 *     at the same parent level (ArrowUp / ArrowDown reorder).
 *   - `getCrossLevelFieldMoveTargets(doc, fieldUuid)` — indent/outdent
 *     targets (Shift+ArrowUp / Shift+ArrowDown).
 */

import { type BlueprintDoc, isContainer, type Uuid } from "@/lib/domain";

/** A field's uuid paired with its owning container's uuid. The parent is
 *  the form uuid for root-level fields, or a group/repeat field uuid for
 *  nested ones. */
export interface FieldRef {
	uuid: Uuid;
	parentUuid: Uuid;
}

/**
 * A cross-level (indent/outdent) move target expressed in uuids.
 * `toParentUuid` is the destination container (form for root-level,
 * group/repeat field uuid otherwise). Either `beforeUuid` or `afterUuid`
 * pins the insertion position; both absent means append at the end of
 * the destination. `direction` is purely for UI labelling.
 */
export interface CrossLevelFieldMoveTarget {
	toParentUuid: Uuid;
	beforeUuid?: Uuid;
	afterUuid?: Uuid;
	direction: "into" | "out";
}

/**
 * Walk the field subtree rooted at `parentUuid` depth-first, collecting
 * `{ uuid, parentUuid }` pairs in visual render order. Hidden fields are
 * excluded — they have no rendered surface and are invisible to keyboard
 * navigation.
 *
 * Not exported: callers always start at a form root via `flattenFieldRefs`.
 */
function walkFieldRefs(
	doc: BlueprintDoc,
	parentUuid: Uuid,
	refs: FieldRef[],
): void {
	const order = doc.fieldOrder[parentUuid] ?? [];
	for (const uuid of order) {
		const field = doc.fields[uuid];
		if (!field) continue;
		if (field.kind === "hidden") continue;
		refs.push({ uuid: uuid as Uuid, parentUuid });
		// Containers (group/repeat) have an order entry; leaf fields don't.
		if (doc.fieldOrder[uuid] !== undefined) {
			walkFieldRefs(doc, uuid as Uuid, refs);
		}
	}
}

/**
 * Flatten a form's entire field subtree into visual render order.
 *
 * Used by `Tab`/`Shift+Tab` keyboard navigation (which crosses group
 * boundaries) and by delete-neighbor resolution (the adjacent field
 * in the flat list becomes the new selection after delete).
 *
 * Returns an empty array when the form uuid is unknown — consumers
 * off-form or holding a stale uuid get a silent no-op rather than a throw.
 */
export function flattenFieldRefs(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FieldRef[] {
	if (doc.forms[formUuid] === undefined) return [];
	const refs: FieldRef[] = [];
	walkFieldRefs(doc, formUuid, refs);
	return refs;
}

/**
 * Find the previous/next sibling uuid for a field within its immediate
 * parent's order. Returns `undefined` for either side when the field is
 * at that boundary (first child → `beforeUuid: undefined`; last child →
 * `afterUuid: undefined`).
 *
 * Operates at the sibling level to match `moveField`'s same-parent
 * reorder semantics. Hidden siblings are included in the ordering because
 * they occupy real positions in `fieldOrder`.
 */
export function getFieldMoveTargets(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): { beforeUuid: Uuid | undefined; afterUuid: Uuid | undefined } {
	const parentUuid = doc.fieldParent[fieldUuid];
	if (!parentUuid) return { beforeUuid: undefined, afterUuid: undefined };
	const siblings = doc.fieldOrder[parentUuid] ?? [];
	const idx = siblings.indexOf(fieldUuid);
	if (idx === -1) return { beforeUuid: undefined, afterUuid: undefined };
	return {
		beforeUuid: idx > 0 ? (siblings[idx - 1] as Uuid) : undefined,
		afterUuid:
			idx < siblings.length - 1 ? (siblings[idx + 1] as Uuid) : undefined,
	};
}

/**
 * Compute indent/outdent move targets for a field.
 *
 * **Up (Shift+↑):**
 *  - First child in a container → outdent: land in the grandparent,
 *    positioned before the container.
 *  - Previous sibling is a container → indent: land as the last child of
 *    that container.
 *
 * **Down (Shift+↓):**
 *  - Last child in a container → outdent: land in the grandparent,
 *    positioned after the container.
 *  - Next sibling is a container → indent: land as the first child of
 *    that container.
 *
 * Returns `undefined` for a direction when no cross-level move is
 * possible (e.g. first child at the form root, no neighbouring group).
 */
export function getCrossLevelFieldMoveTargets(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
): {
	up: CrossLevelFieldMoveTarget | undefined;
	down: CrossLevelFieldMoveTarget | undefined;
} {
	const parentUuid = doc.fieldParent[fieldUuid];
	if (!parentUuid) return { up: undefined, down: undefined };
	const siblings = doc.fieldOrder[parentUuid] ?? [];
	const idx = siblings.indexOf(fieldUuid);
	if (idx === -1) return { up: undefined, down: undefined };

	// Outdent is only meaningful when the parent is itself a field (i.e.
	// a group/repeat). At the form root, `fieldParent` points at the form
	// uuid which has no grandparent — there's nowhere to outdent to.
	const grandparentUuid = doc.fields[parentUuid]
		? doc.fieldParent[parentUuid]
		: undefined;

	let up: CrossLevelFieldMoveTarget | undefined;
	let down: CrossLevelFieldMoveTarget | undefined;

	/* ── Up: outdent if first child of a container, else indent into
	 * previous container sibling. ── */
	if (idx === 0 && grandparentUuid) {
		up = {
			toParentUuid: grandparentUuid,
			// Land just before the group in the grandparent's order.
			beforeUuid: parentUuid,
			direction: "out",
		};
	} else if (idx > 0) {
		const prevUuid = siblings[idx - 1] as Uuid;
		const prev = doc.fields[prevUuid];
		if (prev && isContainer(prev)) {
			up = { toParentUuid: prevUuid, direction: "into" };
		}
	}

	/* ── Down: outdent if last child of a container, else indent into
	 * next container sibling. ── */
	if (idx === siblings.length - 1 && grandparentUuid) {
		down = {
			toParentUuid: grandparentUuid,
			afterUuid: parentUuid,
			direction: "out",
		};
	} else if (idx < siblings.length - 1) {
		const nextUuid = siblings[idx + 1] as Uuid;
		const next = doc.fields[nextUuid];
		if (next && isContainer(next)) {
			const firstChild = doc.fieldOrder[nextUuid]?.[0] as Uuid | undefined;
			down = {
				toParentUuid: nextUuid,
				// Land as the first child (before any existing head). When the
				// container is empty, omit `beforeUuid` so the mutation appends.
				...(firstChild ? { beforeUuid: firstChild } : {}),
				direction: "into",
			};
		}
	}

	return { up, down };
}
