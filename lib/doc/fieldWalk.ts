/**
 * Doc-walking utilities over `BlueprintDoc`.
 *
 * The doc stores everything flat — modules, forms, and fields keyed by
 * uuid — with structural order tracked separately (`doc.moduleOrder`,
 * `doc.formOrder[moduleUuid]`, `doc.fieldOrder[parentUuid]`). Most
 * callers that need "the forms in canonical order" or "the fields under
 * this container" don't want to assemble that shape themselves. Those
 * patterns live here so the agent, prompt renderer, and
 * CommCare-adjacent helpers don't reinvent them.
 *
 * Everything here is pure: takes a doc, returns derived data. No
 * mutations, no dependencies on the store's hooks.
 */

import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import { isContainer } from "@/lib/domain";

/**
 * One form's identity in canonical (module-then-form) order, alongside
 * its module's display name. The shape callers want when they walk the
 * whole app form-by-form (Connect-defaults derivation, suite emission
 * scaffolding, etc.). Module name is included because the most common
 * use of this iteration also needs a human-readable scope label, and a
 * second `doc.modules[moduleUuid]` lookup at every call site is
 * boilerplate.
 */
export interface FormIterEntry {
	moduleUuid: Uuid;
	moduleName: string;
	formUuid: Uuid;
}

/**
 * Iterate every form in the doc in canonical (module-then-form) order.
 * Defensive against a doc whose `moduleOrder` references a stale uuid:
 * the missing-module case yields an empty `moduleName` so the caller can
 * still emit / log against the form uuid without crashing.
 */
export function* iterForms(doc: BlueprintDoc): Generator<FormIterEntry> {
	for (const moduleUuid of doc.moduleOrder) {
		const moduleName = doc.modules[moduleUuid]?.name ?? "";
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			yield { moduleUuid, moduleName, formUuid };
		}
	}
}

/**
 * Count every field recursively under `parentUuid` (DFS, containers
 * included in the count). The parent itself is NOT counted — the count
 * is of the subtree's contents.
 *
 * Safe against dangling uuids in `fieldOrder`: entries whose field has
 * been removed are skipped rather than throwing.
 */
export function countFieldsUnder(doc: BlueprintDoc, parentUuid: Uuid): number {
	let total = 0;
	const stack: Uuid[] = [...(doc.fieldOrder[parentUuid] ?? [])];
	while (stack.length > 0) {
		const uuid = stack.pop() as Uuid;
		const field = doc.fields[uuid];
		if (!field) continue;
		total++;
		if (isContainer(field)) {
			for (const c of doc.fieldOrder[uuid] ?? []) stack.push(c);
		}
	}
	return total;
}

/**
 * A `Field` augmented with its ordered children. Only container kinds
 * (group, repeat) carry a `children` key; leaf fields have no such
 * property (intentionally absent rather than an empty array, so
 * `"children" in field` is a reliable container discriminant).
 */
export type FieldWithChildren = Field & {
	children?: FieldWithChildren[];
};

/**
 * Recursively assemble the ordered field tree under `parentUuid`.
 * Walks `doc.fieldOrder[parentUuid]` in order, descending into
 * containers. Entries whose uuid doesn't resolve to a field (stale
 * order arrays from partial reducer runs) are skipped rather than
 * crashing the walk.
 *
 * Returns an empty array for a parent with no children OR no order
 * entry at all.
 */
export function buildFieldTree(
	doc: BlueprintDoc,
	parentUuid: Uuid,
): FieldWithChildren[] {
	const ordered = doc.fieldOrder[parentUuid] ?? [];
	const out: FieldWithChildren[] = [];
	for (const uuid of ordered) {
		const field = doc.fields[uuid];
		if (!field) continue;
		if (isContainer(field)) {
			const children = buildFieldTree(doc, uuid);
			out.push(children.length > 0 ? { ...field, children } : field);
		} else {
			out.push(field);
		}
	}
	return out;
}
