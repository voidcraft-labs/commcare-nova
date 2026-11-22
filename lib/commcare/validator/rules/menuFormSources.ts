import {
	type BlueprintDoc,
	formLinkEntries,
	type Module,
	resolveFormLinkTarget,
	type Uuid,
} from "@/lib/domain";
import { menuFormUuidsOf } from "@/lib/domain/listedForms";
import { type ValidationError, validationError } from "../errors";

/** The same source form can have several routes. Changes to its list, its links or its
 * module hierarchy can affect each route, including one outside the edited menu. */
export function menuFormSources(doc: BlueprintDoc): ValidationError[] {
	const menus = doc.moduleOrder
		.map((uuid) => doc.modules[uuid])
		.filter((m): m is Module => m !== undefined);
	if (!menus.some((menu) => menu.formsFromMenu)) return [];
	const errors: ValidationError[] = [];
	const children = new Map<Uuid, Module[]>();
	for (const menu of menus) {
		if (!menu.parentModuleUuid) continue;
		const list = children.get(menu.parentModuleUuid);
		if (list) list.push(menu);
		else children.set(menu.parentModuleUuid, [menu]);
	}
	for (const route of menus) {
		const source = route.formsFromMenu;
		const parent =
			route.parentModuleUuid && doc.modules[route.parentModuleUuid];
		const issue = (message: string) =>
			errors.push(
				validationError("MENU_FORM_SOURCE_INVALID", "module", message, {
					moduleUuid: route.uuid,
					moduleName: route.name,
				}),
			);
		if (!source) {
			if (parent?.formsFromMenu)
				issue(`Choose a parent for “${route.name}” that owns its forms.`);
			continue;
		}
		const owner = doc.modules[source.menuUuid];
		if (!owner || owner.formsFromMenu) {
			issue(`Choose a menu that owns the forms to list in “${route.name}”.`);
			continue;
		}
		if ((doc.formOrder[route.uuid]?.length ?? 0) > 0)
			issue(
				`Move the forms “${route.name}” owns to a menu of their own before choosing a form source.`,
			);
		if (
			route.caseType !== undefined ||
			route.caseListConfig?.selection !== undefined
		)
			issue(
				`Choose the case type and how many cases a worker can select in “${owner.name}”, which supplies the forms.`,
			);
		const ownerParent = owner.parentModuleUuid;
		if (
			(parent?.formsFromMenu?.menuUuid ?? route.parentModuleUuid) !==
			ownerParent
		)
			issue(
				`“${route.name}” needs the same parent as “${owner.name}”, or the menu that lists its parent's forms.`,
			);
		const expected = (children.get(owner.uuid) ?? []).filter(
			(child) => !child.formsFromMenu,
		);
		const actual = children.get(route.uuid) ?? [];
		const generated = new Set(
			actual.map((child) => child.formsFromMenu?.menuUuid),
		);
		if (
			generated.size !== actual.length ||
			actual.length !== expected.length ||
			expected.some((child) => !generated.has(child.uuid))
		)
			issue(
				`Update the child menus of “${route.name}” to match the children of “${owner.name}”.`,
			);
		const available = new Set(menuFormUuidsOf(doc, owner.uuid));
		const excluded = source.excludedFormUuids ?? [];
		if (
			new Set(excluded).size !== excluded.length ||
			excluded.some((uuid) => !available.has(uuid))
		)
			issue(
				`Choose exclusions from the forms “${owner.name}” currently lists.`,
			);
		const visible = new Set(menuFormUuidsOf(doc, route.uuid));
		const links = (source.entryPoints ?? []).map((row) => row.formUuid);
		if (
			links.length !== new Set(links).size ||
			links.some((uuid) => !available.has(uuid))
		)
			issue(
				`Choose a different form from “${owner.name}” for each of this menu’s form links.`,
			);
		if (route.caseListMenuItem)
			issue(
				`Remove the separate case list item from “${route.name}”. Workers can open its case list by choosing a form.`,
			);
		for (const uuid of visible) {
			const form = doc.forms[uuid];
			for (const { link } of formLinkEntries(form)) {
				const target = resolveFormLinkTarget(
					doc,
					uuid,
					link.target,
					route.uuid,
				);
				if (
					target?.type === "form" &&
					target.moduleUuid === route.uuid &&
					!visible.has(target.formUuid)
				)
					issue(
						`Include “${doc.forms[target.formUuid]?.name ?? "the linked form"}” in “${route.name}” so workers can follow the link after “${form.name}”.`,
					);
			}
		}
	}
	return errors;
}
