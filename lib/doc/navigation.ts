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
import { orderedFieldUuids } from "./fieldWalk";

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
	/** `into` / `out` are indent / outdent through a group or repeat; the
	 *  two section directions carry a question across a page boundary (the
	 *  root of a sectioned form holds sections only, so "out" of a section
	 *  can never land on the root). */
	direction: "into" | "out" | "out-to-previous-section" | "out-to-next-section";
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
	// `fieldOrder` is the display sequence, so Tab/Shift-Tab navigation and
	// delete-neighbor selection land on the visually adjacent field.
	const order = orderedFieldUuids(doc, parentUuid);
	for (const uuid of order) {
		const field = doc.fields[uuid];
		if (!field) continue;
		if (field.kind === "hidden") continue;
		refs.push({ uuid, parentUuid });
		// Containers (group/repeat) have an order entry; leaf fields don't —
		// a keyed EXISTENCE check, not a positional read.
		if (doc.fieldOrder[uuid] !== undefined) {
			walkFieldRefs(doc, uuid, refs);
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
	// `fieldOrder` is the display sequence, so arrow keys and inspector move
	// buttons target the adjacent array member.
	const siblings = orderedFieldUuids(doc, parentUuid);
	const idx = siblings.indexOf(fieldUuid);
	if (idx === -1) return { beforeUuid: undefined, afterUuid: undefined };
	return {
		beforeUuid: idx > 0 ? siblings[idx - 1] : undefined,
		afterUuid: idx < siblings.length - 1 ? siblings[idx + 1] : undefined,
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
	// A section is a page: it reorders among its siblings and never nests.
	if (doc.fields[fieldUuid]?.kind === "section") {
		return { up: undefined, down: undefined };
	}
	// Membership-array neighbors are the visually adjacent siblings.
	const siblings = orderedFieldUuids(doc, parentUuid);
	const idx = siblings.indexOf(fieldUuid);
	if (idx === -1) return { up: undefined, down: undefined };

	/* ── Inside a section, the edges cross to the neighbouring page. ── */
	if (doc.fields[parentUuid]?.kind === "section") {
		return crossSectionTargets(doc, parentUuid, siblings, idx);
	}

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
		const prevUuid = siblings[idx - 1];
		if (prevUuid === undefined) return { up, down };
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
		const nextUuid = siblings[idx + 1];
		if (nextUuid === undefined) return { up, down };
		const next = doc.fields[nextUuid];
		if (next && isContainer(next)) {
			const firstChild = orderedFieldUuids(doc, nextUuid)[0];
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

/**
 * The cross-level targets of a direct child of a section: the first child
 * may leave to the END of the previous page, the last child to the START
 * of the next; in between, the ordinary indent into a neighbouring
 * container applies. At the first / last page there is no page to cross
 * to, so that edge is `undefined` (never the form root).
 */
function crossSectionTargets(
	doc: BlueprintDoc,
	sectionUuid: Uuid,
	siblings: readonly Uuid[],
	idx: number,
): {
	up: CrossLevelFieldMoveTarget | undefined;
	down: CrossLevelFieldMoveTarget | undefined;
} {
	const formUuid = doc.fieldParent[sectionUuid];
	const pages =
		formUuid === undefined
			? []
			: orderedFieldUuids(doc, formUuid).filter(
					(uuid) => doc.fields[uuid]?.kind === "section",
				);
	const page = pages.indexOf(sectionUuid);

	let up: CrossLevelFieldMoveTarget | undefined;
	let down: CrossLevelFieldMoveTarget | undefined;

	if (idx === 0) {
		const previous = page > 0 ? pages[page - 1] : undefined;
		if (previous !== undefined) {
			up = { toParentUuid: previous, direction: "out-to-previous-section" };
		}
	} else {
		const prevUuid = siblings[idx - 1];
		const prev = prevUuid === undefined ? undefined : doc.fields[prevUuid];
		if (prevUuid !== undefined && prev && isContainer(prev)) {
			up = { toParentUuid: prevUuid, direction: "into" };
		}
	}

	if (idx === siblings.length - 1) {
		const next = page !== -1 ? pages[page + 1] : undefined;
		if (next !== undefined) {
			const firstChild = orderedFieldUuids(doc, next)[0];
			down = {
				toParentUuid: next,
				...(firstChild ? { beforeUuid: firstChild } : {}),
				direction: "out-to-next-section",
			};
		}
	} else {
		const nextUuid = siblings[idx + 1];
		const next = nextUuid === undefined ? undefined : doc.fields[nextUuid];
		if (nextUuid !== undefined && next && isContainer(next)) {
			const firstChild = orderedFieldUuids(doc, nextUuid)[0];
			down = {
				toParentUuid: nextUuid,
				...(firstChild ? { beforeUuid: firstChild } : {}),
				direction: "into",
			};
		}
	}

	return { up, down };
}
