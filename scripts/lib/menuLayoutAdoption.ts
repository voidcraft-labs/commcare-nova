import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { retainedMenuLayouts } from "@/lib/commcare/hq/menuLayout";
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";

import type { MenuLayoutDecision } from "../migrations/step7-menu-layouts";

interface MenuLayoutAdoption {
	readonly settings: MenuLayoutDecision["settings"];
	readonly gridMenus: MenuLayoutDecision["gridMenus"];
	readonly mutations: readonly Mutation[];
	readonly unresolved: readonly (
		| { readonly kind: "first-menu" | "form-menus" }
		| { readonly kind: "menu"; readonly position: number }
	)[];
}

/**
 * Keep choices from a verified live deployment of an app whose document still
 * predates layout authoring. The caller binds the source and identity to the
 * same deployment. A missing or unrecognized menu stays for publish review.
 */
export function planMenuLayoutAdoption(
	doc: BlueprintDoc,
	identity: Pick<WireIdentity, "moduleUniqueId">,
	source: HqAppSource,
): MenuLayoutAdoption {
	if (
		doc.appSettings.firstMenuLayout !== undefined ||
		doc.appSettings.formMenuLayout !== undefined ||
		doc.moduleOrder.some((uuid) => doc.modules[uuid]?.menuLayout !== undefined)
	) {
		return { settings: {}, gridMenus: [], mutations: [], unresolved: [] };
	}

	const held = retainedMenuLayouts(source);
	const settings = {
		...(held.firstMenuLayout === "grid" && {
			firstMenuLayout: held.firstMenuLayout,
		}),
		...((held.formMenuLayout === "grid" ||
			held.formMenuLayout === "individual") && {
			formMenuLayout: held.formMenuLayout,
		}),
	};
	const mutations: Mutation[] = [];
	if (Object.keys(settings).length > 0)
		mutations.push({ kind: "setAppSettings", settings });
	const unresolved: MenuLayoutAdoption["unresolved"][number][] = [];
	if (held.firstMenuLayout === "unreadable")
		unresolved.push({ kind: "first-menu" });
	if (held.formMenuLayout === "unreadable")
		unresolved.push({ kind: "form-menus" });

	const byId = new Map<string, (typeof doc.moduleOrder)[number] | null>();
	for (const uuid of doc.moduleOrder) {
		const id = identity.moduleUniqueId(uuid);
		byId.set(id, byId.has(id) ? null : uuid);
	}
	const counts = new Map<string, number>();
	for (const { uniqueId } of source.modules) {
		if (uniqueId !== null)
			counts.set(uniqueId, (counts.get(uniqueId) ?? 0) + 1);
	}
	const gridMenus: MenuLayoutDecision["gridMenus"][number][] = [];
	for (const { position, layout } of held.menus) {
		const id = source.modules[position]?.uniqueId;
		const uuid = id && counts.get(id) === 1 ? byId.get(id) : undefined;
		if (layout === "unreadable" || !uuid || doc.modules[uuid] === undefined) {
			unresolved.push({ kind: "menu", position });
			continue;
		}
		gridMenus.push(uuid);
		mutations.push({
			kind: "updateModule",
			uuid,
			patch: { menuLayout: "grid" },
		});
	}

	return { settings, gridMenus, mutations, unresolved };
}
