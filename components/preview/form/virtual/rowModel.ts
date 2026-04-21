/**
 * Flat row model for the virtualized form editor.
 *
 * The edit-mode form editor used to render a recursive `FormRenderer` — a
 * group/repeat rendered its own nested `FormRenderer`, creating an arbitrarily
 * deep React tree. A single form-open commit mounted hundreds of components at
 * once; see the Phase 5 motivation in
 * `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md`.
 *
 * The row model replaces the recursive tree with a flat, positional list of
 * typed rows. `buildFormRows` walks the blueprint exactly once and returns a
 * sequence that a virtualizer (see `VirtualFormList`) can mount piecewise:
 * only visible rows enter the React tree.
 *
 * Row semantics:
 *
 * - `field`          — a leaf field (text / select / label / hidden).
 * - `group-open`     — the opening bracket of a group or repeat container.
 * - `group-close`    — the closing bracket of that same container.
 * - `empty-container`— placeholder row inside a group/repeat that has no
 *                      children; carries the pragmatic-drag-and-drop drop
 *                      target so the user can drop a field into an
 *                      empty group.
 * - `insertion`      — the gap between two children of the SAME parent; the
 *                      row IS the gap (24px). Owning the gap as a sibling row
 *                      (rather than margins on field rows) makes it
 *                      structurally impossible to accidentally double up
 *                      vertical spacing.
 *
 * Depth is the nesting level (0 = root of the form; 1 = child of a group;
 * 2 = grandchild of a group; etc.). CSS uses `depth` to compute indentation
 * and the nested-bracket border stack.
 */

import type { Field, Uuid } from "@/lib/domain";

// ── Types ──────────────────────────────────────────────────────────────

/**
 * A single row in the flattened form editor. Discriminated by `kind` —
 * consumers `switch` on it to pick a row component.
 *
 * `id` is the React key + virtualizer measurement cache key. Each kind
 * produces a stable, unique id; that stability survives reorder
 * (fields keep their uuid-derived id regardless of position) so
 * measured heights and scroll offsets are preserved across edits.
 */
export type FormRow =
	| InsertionRow
	| FieldRow
	| GroupOpenRow
	| GroupCloseRow
	| EmptyContainerRow
	| DropPlaceholderRow;

/** Synthetic row injected during drag to open a visible gap at the
 *  drop position. The virtualizer gives it its own slot so it doesn't
 *  need to escape any overflow boundary. */
export interface DropPlaceholderRow {
	readonly kind: "drop-placeholder";
	readonly id: string;
	readonly depth: number;
}

/** Gap between two children of the same parent, at `beforeIndex`. */
export interface InsertionRow {
	readonly kind: "insertion";
	readonly id: string;
	/** UUID of the parent container (form uuid or group/repeat uuid). */
	readonly parentUuid: Uuid;
	/** Insertion index in the parent's child array. 0 = before first child. */
	readonly beforeIndex: number;
	readonly depth: number;
}

/**
 * A leaf field — any field kind other than `group` or `repeat`.
 * `parentUuid` + `siblingIndex` locate this row inside its parent's child
 * array so the drop-target `getData` and cycle checks can address it
 * without the row component having to walk the doc itself.
 */
export interface FieldRow {
	readonly kind: "field";
	readonly id: string;
	readonly uuid: Uuid;
	readonly parentUuid: Uuid;
	readonly siblingIndex: number;
	readonly depth: number;
}

/**
 * Opening bracket of a group or repeat container. Holds the collapsed flag.
 * Groups and repeats are themselves draggable (the whole container moves
 * when the user drags the bracket), so the row carries the same sortable
 * locator fields as a leaf field.
 */
export interface GroupOpenRow {
	readonly kind: "group-open";
	readonly id: string;
	readonly uuid: Uuid;
	readonly parentUuid: Uuid;
	readonly siblingIndex: number;
	readonly depth: number;
	readonly collapsed: boolean;
}

/** Closing bracket of a group or repeat container. */
export interface GroupCloseRow {
	readonly kind: "group-close";
	readonly id: string;
	readonly uuid: Uuid;
	readonly depth: number;
}

/** Placeholder row inside an empty group/repeat. Carries the drop target. */
export interface EmptyContainerRow {
	readonly kind: "empty-container";
	readonly id: string;
	readonly parentUuid: Uuid;
	readonly depth: number;
}

/** The set of group/repeat uuids currently collapsed. Use a `Set` for O(1)
 *  lookup and reference-stable dependencies in `useMemo`. */
export type CollapseState = ReadonlySet<Uuid>;

/**
 * Minimal projection of `BlueprintDoc` used by the walker. Keeping the
 * walker's input narrow makes it easy to test against plain fixtures and
 * makes the subscription shape in `useFormRows` obvious.
 *
 * Keys are typed as the branded `Uuid` so the walker preserves brand
 * safety end-to-end — the store's `fieldOrder` values are
 * `Uuid[]`, not bare strings, and we want that invariant to reach the
 * row output.
 */
export interface RowSource {
	readonly fields: Readonly<Record<Uuid, Field>>;
	readonly fieldOrder: Readonly<Record<Uuid, readonly Uuid[]>>;
}

export interface BuildFormRowsOptions {
	/**
	 * Include `insertion` rows between/before/after fields. Edit mode
	 * sets this to `true`; pointer/interactive mode never calls the walker.
	 */
	readonly includeInsertionPoints: boolean;
	/** Collapsed group uuids. Children of a collapsed group are skipped. */
	readonly collapsed: CollapseState;
}

// ── Walker ─────────────────────────────────────────────────────────────

/**
 * Walk the blueprint rooted at `rootParentUuid` (the form's uuid) and
 * produce the flat row sequence. Pure, synchronous — no React hooks, no
 * store subscriptions. Safe to call from a `useMemo` and from unit tests.
 *
 * Ordering contract: within a parent, rows appear in the order
 *
 *   insertion(0), child0, insertion(1), child1, insertion(2), …, childN, insertion(N+1)
 *
 * so every child has an insertion point both before and after it (edit mode).
 * For group/repeat children, `childK` expands to a `group-open` row, the
 * flattened children of that group, and a `group-close` row. If the group is
 * collapsed, the children are omitted but the `group-close` still emits so
 * the visual bracket stays balanced.
 *
 * An empty group/repeat (depth > 0, no children) emits a single
 * `empty-container` row between its `group-open` and `group-close` — this row
 * owns the drop target so the drop-handling monitor can route drops
 * into empty containers.
 */
export function buildFormRows(
	src: RowSource,
	rootParentUuid: Uuid,
	options: BuildFormRowsOptions,
): FormRow[] {
	const rows: FormRow[] = [];
	walk(src, rootParentUuid, 0, rows, options);
	return rows;
}

function walk(
	src: RowSource,
	parentUuid: Uuid,
	depth: number,
	rows: FormRow[],
	options: BuildFormRowsOptions,
): void {
	const childUuids = src.fieldOrder[parentUuid] ?? [];

	// Leading insertion point (edit mode only).
	if (options.includeInsertionPoints) {
		rows.push({
			kind: "insertion",
			id: `ins:${parentUuid}:0`,
			parentUuid,
			beforeIndex: 0,
			depth,
		});
	}

	// An empty container (depth > 0 means we're inside a group/repeat, not
	// at the form root) gets a single placeholder row that owns the drop
	// target. The form root is allowed to be empty without a placeholder —
	// there's nothing to render if the form has no fields.
	if (childUuids.length === 0) {
		if (depth > 0) {
			rows.push({
				kind: "empty-container",
				id: `empty:${parentUuid}`,
				parentUuid,
				depth,
			});
		}
		return;
	}

	for (let i = 0; i < childUuids.length; i++) {
		const uuid = childUuids[i];
		const q = src.fields[uuid];
		// Defensive: skip dangling order entries AND their trailing
		// insertion point. The store guarantees `fieldOrder` values
		// reference existing fields, but a race during mutation replay
		// could briefly violate that — better to elide a row than crash
		// the virtualizer. `beforeIndex` values remain array positions
		// (may have gaps when dangling entries are skipped); consumers
		// must not assume contiguous sequence.
		if (!q) continue;

		if (q.kind === "group" || q.kind === "repeat") {
			const collapsed = options.collapsed.has(uuid);
			rows.push({
				kind: "group-open",
				id: `open:${uuid}`,
				uuid,
				parentUuid,
				siblingIndex: i,
				depth,
				collapsed,
			});
			if (!collapsed) {
				walk(src, uuid, depth + 1, rows, options);
			}
			rows.push({
				kind: "group-close",
				id: `close:${uuid}`,
				uuid,
				depth,
			});
		} else {
			rows.push({
				kind: "field",
				id: `q:${uuid}`,
				uuid,
				parentUuid,
				siblingIndex: i,
				depth,
			});
		}

		// Trailing insertion point after this child. Indexed by the
		// position AFTER this child — so `beforeIndex=i+1` means
		// "insert between child[i] and child[i+1]".
		if (options.includeInsertionPoints) {
			rows.push({
				kind: "insertion",
				id: `ins:${parentUuid}:${i + 1}`,
				parentUuid,
				beforeIndex: i + 1,
				depth,
			});
		}
	}
}
