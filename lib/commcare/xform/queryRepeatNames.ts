import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type { Uuid } from "@/lib/domain/uuid";
import { Namespace } from "./namespace";

/** The generated nodes of one query repeat in the count placement: three in
 * its wrapper, two in each row. */
export interface QueryRepeatNames {
	/** The wrapper's child holding the query's ids, space-joined. */
	readonly ids: string;
	/** The wrapper's child holding how many ids the query found. */
	readonly count: string;
	/** The wrapper's child holding how many rows the repeat holds. */
	readonly position: string;
	/** The row's child holding its record id. */
	readonly id: string;
	/** The row's child holding its 0-based position. */
	readonly index: string;
}

/** The names a query repeat's generated nodes take beside no collision. */
export function queryRepeatBaseNames(repeatId: string): QueryRepeatNames {
	return {
		ids: `nova_query_ids_${repeatId}`,
		count: `nova_query_count_${repeatId}`,
		position: `nova_query_position_${repeatId}`,
		id: `nova_query_id_${repeatId}`,
		index: `nova_query_index_${repeatId}`,
	};
}

/** The one authored name of a query repeat's wrapper: its row. */
const ROW = "item";

const plans = new WeakMap<FormStructure, ReadonlyMap<Uuid, QueryRepeatNames>>();

/**
 * Reserve the generated names of every query repeat, whatever its placement,
 * from the form's structure alone and before any expression is read, so no
 * generated name of a form depends on what its expressions read or on which
 * placement a repeat takes. The wrapper's namespace holds `item` and then
 * `ids`, `count`, `position`; the row's holds the repeat's children and then
 * `id`, `index`. A taken base becomes `<base>_<n>`.
 */
export function planQueryRepeatNames(
	form: FormStructure,
): ReadonlyMap<Uuid, QueryRepeatNames> {
	const previous = plans.get(form);
	if (previous !== undefined) return previous;
	const names = new Map<Uuid, QueryRepeatNames>();
	const visited = new Set<Uuid>();
	const walk = (parent: Uuid): void => {
		if (visited.has(parent)) return;
		visited.add(parent);
		for (const uuid of form.fieldOrder.get(parent) ?? []) {
			const field = form.fields.get(uuid);
			if (field === undefined) continue;
			if (field.kind === "repeat" && field.repeatMode === "query_bound") {
				const base = queryRepeatBaseNames(field.id);
				const wrapper = new Namespace([ROW]);
				const row = new Namespace(
					(form.fieldOrder.get(uuid) ?? []).flatMap((child) => {
						const declared = form.fields.get(child);
						return declared === undefined ? [] : [declared.id];
					}),
				);
				names.set(uuid, {
					ids: wrapper.allocate(base.ids),
					count: wrapper.allocate(base.count),
					position: wrapper.allocate(base.position),
					id: row.allocate(base.id),
					index: row.allocate(base.index),
				});
			}
			if (form.fieldOrder.has(uuid)) walk(uuid);
		}
	};
	walk(form.formUuid);
	plans.set(form, names);
	return names;
}
