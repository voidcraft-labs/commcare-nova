// lib/doc/order/columnSurface.ts
//
// Fractional-order planning for one direct Results / Details row move.
// A gesture changes ONE column's surface-specific key; it never resequences
// the rest of the screen. That narrow write is what lets two collaborators
// move different rows without either gesture overwriting the other's keys.

import type { Mutation, Uuid } from "@/lib/doc/types";
import type { Column } from "@/lib/domain";
import { byDetailColumnOrder, byListColumnOrder } from "./compare";
import { plannedMoveSlotKey } from "./keys";

export type ColumnSurface = "list" | "detail";

/** The effective key a surface comparator reads (legacy `order` fallback). */
export function resolvedColumnSurfaceOrder(
	column: Column,
	surface: ColumnSurface,
): string | undefined {
	return surface === "list"
		? (column.listOrder ?? column.order)
		: (column.detailOrder ?? column.order);
}

function isVisibleOnSurface(column: Column, surface: ColumnSurface): boolean {
	return surface === "list"
		? column.visibleInList !== false
		: column.visibleInDetail !== false;
}

/** Visible columns in the exact order the named screen consumes. */
export function orderedColumnsOnSurface(
	columns: readonly Column[],
	surface: ColumnSurface,
): Column[] {
	return columns
		.filter((column) => isVisibleOnSurface(column, surface))
		.sort(surface === "list" ? byListColumnOrder : byDetailColumnOrder);
}

/**
 * Encode a surface-key write on the pre-deploy `moveColumn` discriminator.
 *
 * `order` is the semantic surface value (`null` clears the override). The
 * top-level `order` is a legacy fallback in an origin/main-known slot: old
 * parsers strip `surfaceOrderPatch` and old reducers move the shared generic
 * sequence instead of throwing. New reducers ignore that fallback and touch
 * only the named surface. Hydration guarantees every column has the generic
 * key needed to represent a clear to an old receiver.
 */
export function columnSurfaceOrderMutation(args: {
	readonly moduleUuid: Uuid;
	readonly column: Column;
	readonly surface: ColumnSurface;
	readonly order: string | null;
}): Mutation {
	const fallbackOrder = args.order ?? args.column.order;
	if (fallbackOrder === undefined) {
		throw new Error(
			"Cannot clear a column surface order before generic order-key hydration.",
		);
	}
	return {
		kind: "moveColumn",
		moduleUuid: args.moduleUuid,
		uuid: args.column.uuid,
		order: fallbackOrder,
		surfaceOrderPatch: { surface: args.surface, order: args.order },
	};
}

/**
 * Plan one direct-manipulation row move as one granular mutation.
 *
 * `toIndex` is the row's desired FINAL index in the visible surface sequence.
 * The moved row is removed before neighbor bounds are read, matching the
 * post-splice semantics used by the field-tree move API. The key is minted
 * through `keysForSlot`, so equal-key collisions widen through the same shared
 * contract as every other builder move. Returns `undefined` for an unknown,
 * omitted, or already-in-place row.
 */
export function columnSurfaceMoveMutation(args: {
	readonly moduleUuid: Uuid;
	readonly columns: readonly Column[];
	readonly surface: ColumnSurface;
	readonly uuid: Uuid;
	readonly toIndex: number;
}): Mutation | undefined {
	const { moduleUuid, columns, surface, uuid } = args;
	const ordered = orderedColumnsOnSurface(columns, surface);
	const fromIndex = ordered.findIndex((column) => column.uuid === uuid);
	if (fromIndex < 0) return undefined;

	const siblings = ordered.filter((column) => column.uuid !== uuid);
	const toIndex = Math.max(0, Math.min(args.toIndex, siblings.length));
	if (toIndex === fromIndex) return undefined;

	const order = plannedMoveSlotKey(
		siblings.map((column) => resolvedColumnSurfaceOrder(column, surface)),
		toIndex,
	);

	const moved = ordered[fromIndex];
	if (moved === undefined) {
		throw new Error("Column surface move lost its resolved source row.");
	}
	return columnSurfaceOrderMutation({
		moduleUuid,
		column: moved,
		surface,
		order,
	});
}
