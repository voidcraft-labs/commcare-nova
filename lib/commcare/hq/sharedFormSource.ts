import type { HqAppSource, HqAppSourceForm } from "./appSource";

/** HQ stores one XForm per ordinary form. Each ShadowForm stores a reference to
 * that form using the form ids of the same app source. Build this index once
 * before visiting entries; a parent may follow its entries in another menu. */
type SourceForm = Record<string, unknown>;

function object(value: unknown): value is SourceForm {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function advancedFormParents(
	modules: readonly unknown[],
): ReadonlyMap<string, SourceForm> {
	const parents = new Map<string, SourceForm>();
	const occupied = new Set<string>();
	for (const module of modules) {
		if (!object(module) || !Array.isArray(module.forms)) continue;
		for (const form of module.forms) {
			if (
				!object(form) ||
				typeof form.unique_id !== "string" ||
				form.unique_id === ""
			)
				continue;
			const id = form.unique_id;
			if (occupied.has(id)) parents.delete(id);
			else if (
				module.doc_type === "AdvancedModule" &&
				form.doc_type === "AdvancedForm"
			)
				parents.set(id, form);
			occupied.add(id);
		}
	}
	return parents;
}

export function sharedFormParent(
	form: SourceForm,
	parents: ReadonlyMap<string, SourceForm>,
): SourceForm | undefined {
	return form.doc_type === "ShadowForm" &&
		typeof form.shadow_parent_form_id === "string"
		? parents.get(form.shadow_parent_form_id)
		: undefined;
}

/**
 * The `xmlns` the resource reports for each source form: its stored one, or
 * where that is null, its shadow parent's, followed for at most as many
 * steps as the app has forms. Null where there is none, the parent is not
 * among the read's forms, or the steps run out.
 */
export function expectedXmlnsOf(
	source: Pick<HqAppSource, "modules">,
): (form: HqAppSourceForm) => string | null {
	const forms = source.modules.flatMap((menu) => menu.forms);
	const byReadId = new Map(forms.map((form) => [form.readUniqueId, form]));
	return (form) => {
		let current: HqAppSourceForm | undefined = form;
		for (let step = 0; step <= forms.length && current !== undefined; step++) {
			if (current.xmlns !== null) return current.xmlns;
			if (current.shadowParentReadId === null) return null;
			current = byReadId.get(current.shadowParentReadId);
		}
		return null;
	};
}
