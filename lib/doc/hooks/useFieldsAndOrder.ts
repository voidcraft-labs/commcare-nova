/**
 * Named hook — return the field entity map + fieldOrder map as a
 * shallow-stable pair.
 *
 * Primary consumer is CloseConditionSection's recursive id lookup: the
 * editor walks a subtree (`fieldOrder` for descendants) and resolves
 * each descendant's id via `fields[uuid].id`. Both slices are needed
 * simultaneously — an inline pair selector would allocate a new object
 * each store tick and re-render on every unrelated doc change.
 *
 * `useBlueprintDocShallow` compares the output object field-by-field;
 * if neither map changed reference (Immer structural sharing guarantees
 * this when no mutation touched either), the caller gets the same
 * object back and skips the re-render.
 *
 * Consumers should NOT wrap the return value in `useMemo` — it is
 * already reference-stable.
 */

import type { Uuid } from "@/lib/doc/types";
import type { Field } from "@/lib/domain";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

/** Shape of `useFieldsAndOrder()` output. */
export interface FieldsAndOrder {
	fields: Readonly<Record<Uuid, Field>>;
	fieldOrder: Readonly<Record<Uuid, readonly Uuid[]>>;
}

export function useFieldsAndOrder(): FieldsAndOrder {
	return useBlueprintDocShallow((s) => ({
		fields: s.fields,
		fieldOrder: s.fieldOrder,
	}));
}
