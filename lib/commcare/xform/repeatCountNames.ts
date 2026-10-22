import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type { Uuid } from "@/lib/domain/uuid";
import { Namespace } from "./namespace";

/** The name a count-bound repeat's count node takes beside no collision. */
export function repeatCountBaseName(repeatId: string): string {
	return `nova_count_${repeatId}`;
}

const plans = new WeakMap<FormStructure, ReadonlyMap<Uuid, string>>();

/** Reserve every potential count carrier before reading any expression. A
 * pending expression can therefore bind another count's identity without
 * asking whether that count will need its physical carrier. */
export function planRepeatCountNames(
	form: FormStructure,
): ReadonlyMap<Uuid, string> {
	const previous = plans.get(form);
	if (previous !== undefined) return previous;
	const names = new Map<Uuid, string>();
	const visited = new Set<Uuid>();
	const walk = (parent: Uuid): void => {
		if (visited.has(parent)) return;
		visited.add(parent);
		const children = (form.fieldOrder.get(parent) ?? []).flatMap((uuid) => {
			const field = form.fields.get(uuid);
			return field === undefined ? [] : [field];
		});
		const scope = new Namespace([
			...children.map((field) => field.id),
			...(parent === form.formUuid
				? Object.values(form.connect).map((block) => block.id)
				: []),
		]);
		for (const field of children) {
			if (field.kind === "repeat" && field.repeatMode === "count_bound")
				names.set(field.uuid, scope.allocate(repeatCountBaseName(field.id)));
		}
		for (const field of children) {
			if (form.fieldOrder.has(field.uuid)) walk(field.uuid);
		}
	};
	walk(form.formUuid);
	plans.set(form, names);
	return names;
}
