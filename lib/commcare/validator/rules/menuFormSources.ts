import {
	type BlueprintDoc,
	formLinkEntries,
	type Module,
	resolveFormLinkTarget,
	type Uuid,
} from "@/lib/domain";
import { listedMenuIsEmpty, menuFormUuidsOf } from "@/lib/domain/listedForms";
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
		// `reason` and the names it needs let the Builder say the same thing
		// in its own words (`lib/doc/userFacingErrors.ts`).
		const issue = (
			message: string,
			reason: string,
			names: Record<string, string> = {},
		) =>
			errors.push(
				validationError(
					"MENU_FORM_SOURCE_INVALID",
					"module",
					message,
					{ moduleUuid: route.uuid, moduleName: route.name },
					{ reason, ...names },
				),
			);
		if (!source) {
			if (parent?.formsFromMenu)
				issue(
					`Choose a parent for “${route.name}” that owns its forms.`,
					"parent-lists-forms",
				);
			continue;
		}
		const owner = doc.modules[source.menuUuid];
		if (!owner || owner.formsFromMenu) {
			issue(
				`Choose a menu that owns the forms to list in “${route.name}”.`,
				"source-owns-no-forms",
			);
			continue;
		}
		if ((doc.formOrder[route.uuid]?.length ?? 0) > 0)
			issue(
				`Move the forms “${route.name}” owns to a menu of their own before choosing a form source.`,
				"owns-forms",
			);
		if (
			route.caseType !== undefined ||
			route.caseListConfig?.selection !== undefined
		)
			issue(
				`Choose the case type and how many cases a worker can select in “${owner.name}”, which supplies the forms.`,
				"case-settings",
				{ owner: owner.name },
			);
		const ownerParent = owner.parentModuleUuid;
		if (
			(parent?.formsFromMenu?.menuUuid ?? route.parentModuleUuid) !==
			ownerParent
		)
			issue(
				`“${route.name}” needs the same parent as “${owner.name}”, or the menu that lists its parent's forms.`,
				"parent",
				{ owner: owner.name },
			);
		const expected = (children.get(owner.uuid) ?? []).filter(
			(child) => !child.formsFromMenu,
		);
		const actual = children.get(route.uuid) ?? [];
		const generated = new Set(
			actual.map((child) => child.formsFromMenu?.menuUuid),
		);
		const missing = expected.find((child) => !generated.has(child.uuid));
		if (
			generated.size !== actual.length ||
			actual.length !== expected.length ||
			missing
		)
			if (missing)
				issue(
					`“${missing.name}” appears in “${route.name}” because “${owner.name}” has it. Hide its forms in “${route.name}”, or remove “${missing.name}” from “${owner.name}”.`,
					"submenu-missing",
					{ owner: owner.name, child: missing.name },
				);
			else
				issue(
					`Update the child menus of “${route.name}” to match the children of “${owner.name}”.`,
					"submenus",
					{ owner: owner.name },
				);
		const available = new Set(menuFormUuidsOf(doc, owner.uuid));
		const excluded = source.excludedFormUuids ?? [];
		if (
			new Set(excluded).size !== excluded.length ||
			excluded.some((uuid) => !available.has(uuid))
		)
			issue(
				`Choose exclusions from the forms “${owner.name}” currently lists.`,
				"exclusions",
				{ owner: owner.name },
			);
		const visible = new Set(menuFormUuidsOf(doc, route.uuid));
		const links = (source.entryPoints ?? []).map((row) => row.formUuid);
		if (
			links.length !== new Set(links).size ||
			links.some((uuid) => !available.has(uuid))
		)
			issue(
				`Choose a different form from “${owner.name}” for each of this menu’s form links.`,
				"form-links",
				{ owner: owner.name },
			);
		// HQ's build writes no menu for a route without a command, so a
		// submenu that keeps its own screen under it has no way in.
		if (listedMenuIsEmpty(doc, route.uuid)) {
			const stranded = actual.find(
				(child) =>
					!child.formsInMenuAbove &&
					menuFormUuidsOf(doc, child.uuid).length > 0,
			);
			if (stranded)
				issue(
					`Show a form in “${route.name}” so workers can reach “${stranded.name}” inside it.`,
					"stranded-submenu",
					{ child: stranded.name },
				);
		}
		if (route.caseListMenuItem)
			issue(
				`Remove the separate case list item from “${route.name}”. Workers can open its case list by choosing a form.`,
				"case-list-item",
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
						"hidden-link-target",
						{
							target: doc.forms[target.formUuid]?.name ?? "",
							form: form.name,
						},
					);
			}
		}
	}
	for (const form of Object.values(doc.forms)) {
		for (const { link } of formLinkEntries(form)) {
			if (link.target.type !== "module") continue;
			const route = doc.modules[link.target.moduleUuid];
			if (!route || !listedMenuIsEmpty(doc, route.uuid)) continue;
			errors.push(
				validationError(
					"MENU_FORM_SOURCE_INVALID",
					"module",
					`Show a form in “${route.name}” so the link after “${form.name}” has a menu to open.`,
					{ moduleUuid: route.uuid, moduleName: route.name },
					{ reason: "empty-link-target", form: form.name },
				),
			);
		}
	}
	return errors;
}
