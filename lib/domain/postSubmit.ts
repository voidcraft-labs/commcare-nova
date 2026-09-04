// lib/domain/postSubmit.ts
//
// Where a form goes after submit, resolved against its module. The stored
// slot is optional; the default depends on the form type AND on whether
// the owning module opens on Search, so every consumer reads it here
// rather than pairing `form.postSubmit ?? defaultPostSubmit(form.type)`
// by hand.

import type { BlueprintDoc } from "./blueprint";
import { defaultPostSubmit, type PostSubmitDestination } from "./forms";
import { moduleOpensOnSearch } from "./modules";
import type { Uuid } from "./uuid";

/** The module that owns `formUuid`, or `undefined` for an unknown form. */
export function moduleUuidOfForm(
	doc: Pick<BlueprintDoc, "formOrder">,
	formUuid: Uuid,
): Uuid | undefined {
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (formUuids.includes(formUuid)) return moduleUuid as Uuid;
	}
	return undefined;
}

/** The after-submit default of `formUuid`, given its type and module. */
export function defaultPostSubmitOf(
	doc: Pick<BlueprintDoc, "forms" | "modules" | "formOrder">,
	formUuid: Uuid,
): PostSubmitDestination | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	return defaultPostSubmit(form.type, {
		searchFirst: mod !== undefined && moduleOpensOnSearch(mod),
	});
}

/** Where `formUuid` goes after submit: its stored slot, else its default. */
export function effectivePostSubmit(
	doc: Pick<BlueprintDoc, "forms" | "modules" | "formOrder">,
	formUuid: Uuid,
): PostSubmitDestination | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	return form.postSubmit ?? defaultPostSubmitOf(doc, formUuid);
}
