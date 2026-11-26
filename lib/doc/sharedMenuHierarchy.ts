import {
	type BlueprintDoc,
	type Module,
	type Uuid,
	uniqueSlug,
} from "@/lib/domain";
import { initialSharedChild, sharedChildUuid } from "./sharedFormChildren";
import type { Mutation } from "./types";

/** Complete an ordinary menu hierarchy edit with the affected routes' explicit mutations.
 * A direct move or removal of a generated child cannot detach it from its source.
 * Replaying the planned mutations needs no minting or extra repair. */
export function withListedMenuHierarchy(
	doc: BlueprintDoc,
	authored: readonly Mutation[],
): Mutation[] {
	if (
		!authored.some(
			(m) =>
				m.kind === "addModule" ||
				m.kind === "removeModule" ||
				m.kind === "moveModule" ||
				(m.kind === "updateModule" && Object.hasOwn(m.patch, "formsFromMenu")),
		)
	)
		return [...authored];
	if (
		!Object.values(doc.modules).some((menu) => menu.formsFromMenu) &&
		!authored.some((m) => m.kind === "addModule" && m.module.formsFromMenu)
	)
		return [...authored];
	const menus = new Map(
		Object.values(doc.modules).map((menu) => [menu.uuid, menu]),
	);
	const changed = new Set<Uuid>();
	const removing = new Set<Uuid>();
	const explicit = new Set<Uuid>();
	for (const mutation of authored) {
		switch (mutation.kind) {
			case "addModule": {
				const menu = mutation.module;
				menus.set(menu.uuid, menu);
				explicit.add(menu.uuid);
				if (!menu.formsFromMenu && menu.parentModuleUuid)
					changed.add(menu.parentModuleUuid);
				break;
			}
			case "removeModule": {
				const menu = menus.get(mutation.uuid);
				if (!menu) break;
				removing.add(menu.uuid);
				explicit.add(menu.uuid);
				menus.delete(menu.uuid);
				if (!menu.formsFromMenu) {
					changed.add(menu.uuid);
					if (menu.parentModuleUuid) changed.add(menu.parentModuleUuid);
				}
				break;
			}
			case "moveModule": {
				const menu = menus.get(mutation.uuid);
				if (
					!menu ||
					!Object.hasOwn(mutation, "parentModuleUuid") ||
					(mutation.parentModuleUuid ?? undefined) === menu.parentModuleUuid
				)
					break;
				explicit.add(menu.uuid);
				if (!menu.formsFromMenu) {
					changed.add(menu.uuid);
					if (menu.parentModuleUuid) changed.add(menu.parentModuleUuid);
					if (mutation.parentModuleUuid) changed.add(mutation.parentModuleUuid);
				}
				menus.set(menu.uuid, {
					...menu,
					parentModuleUuid: mutation.parentModuleUuid ?? undefined,
				});
				break;
			}
			case "updateModule": {
				const menu = menus.get(mutation.uuid);
				if (!menu || !Object.hasOwn(mutation.patch, "formsFromMenu")) break;
				const source = mutation.patch.formsFromMenu;
				menus.set(menu.uuid, { ...menu, formsFromMenu: source ?? undefined });
				explicit.add(menu.uuid);
				if (source) changed.add(source.menuUuid);
				break;
			}
		}
	}
	const removed = new Map<Uuid, Module>();
	const moved: Mutation[] = [];
	const born: Mutation[] = [];
	const ids = new Set([...menus.values()].map((menu) => menu.id));
	const remove = (menu: Module) => {
		removed.set(menu.uuid, menu);
		menus.delete(menu.uuid);
	};
	// Remove old generated children before their parent and before the ordinary source moves.
	for (const menu of [...menus.values()]) {
		const from = menu.formsFromMenu;
		if (!from) continue;
		const oldParent =
			menu.parentModuleUuid && doc.modules[menu.parentModuleUuid];
		const parent = menu.parentModuleUuid && menus.get(menu.parentModuleUuid);
		const source = menus.get(from.menuUuid);
		if (
			(!source && removing.has(from.menuUuid)) ||
			(oldParent?.formsFromMenu &&
				(removing.has(oldParent.uuid) ||
					!source ||
					parent?.formsFromMenu?.menuUuid !== source.parentModuleUuid))
		) {
			remove(menu);
			continue;
		}
		if (
			source &&
			!parent?.formsFromMenu &&
			changed.has(source.uuid) &&
			!explicit.has(menu.uuid) &&
			menu.parentModuleUuid !== source.parentModuleUuid
		) {
			moved.push({
				kind: "moveModule",
				uuid: menu.uuid,
				parentModuleUuid: source.parentModuleUuid ?? null,
				after: null,
			});
		}
	}
	for (const route of menus.values()) {
		const owner =
			route.formsFromMenu && menus.get(route.formsFromMenu.menuUuid);
		if (!owner || owner.formsFromMenu || !changed.has(owner.uuid)) continue;
		const held = new Set(
			[...menus.values()]
				.filter((menu) => menu.parentModuleUuid === route.uuid)
				.map((menu) => menu.formsFromMenu?.menuUuid),
		);
		for (const source of menus.values()) {
			if (
				source.formsFromMenu ||
				source.parentModuleUuid !== owner.uuid ||
				held.has(source.uuid)
			)
				continue;
			const uuid = sharedChildUuid(route.uuid, source.uuid);
			if (menus.has(uuid) || explicit.has(uuid)) continue;
			const id = uniqueSlug(source.name, "module", ids);
			ids.add(id);
			const child: Module = {
				uuid,
				id,
				name: source.name,
				parentModuleUuid: route.uuid,
				formsFromMenu: { menuUuid: source.uuid },
			};
			const translations = initialSharedChild(doc, source, child);
			born.push({ kind: "addModule", module: child }, ...translations);
		}
	}
	const removals = [...removed.values()].sort(
		(a, b) =>
			Number(Boolean(b.parentModuleUuid)) - Number(Boolean(a.parentModuleUuid)),
	);
	return [
		...removals.map((menu) => ({
			kind: "removeModule" as const,
			uuid: menu.uuid,
		})),
		...authored,
		...moved,
		...born,
	];
}

/** Changing a route's source keeps the route itself and its independent configuration.
 * Named deep links must be reassigned or removed explicitly before their forms leave. */
export function changeListedMenuSource(
	doc: BlueprintDoc,
	routeUuid: Uuid,
	previousUuid: Uuid,
	nextUuid: Uuid,
): { ok: true; mutations: Mutation[] } | { ok: false; message: string } {
	const route = doc.modules[routeUuid],
		source = doc.modules[nextUuid];
	if (route?.formsFromMenu?.menuUuid !== previousUuid)
		return {
			ok: false,
			message: "This menu's source changed. Open its settings again.",
		};
	if (!source || source.formsFromMenu || nextUuid === routeUuid)
		return {
			ok: false,
			message: "Choose a menu that owns the forms to list here.",
		};
	if (
		route.parentModuleUuid &&
		doc.modules[route.parentModuleUuid]?.formsFromMenu
	)
		return {
			ok: false,
			message: "This submenu follows the source chosen in its parent menu.",
		};
	if (previousUuid === nextUuid) return { ok: true, mutations: [] };
	const links = route.formsFromMenu.entryPoints ?? [];
	if (links.length)
		return {
			ok: false,
			message: `Remove the form links ${links.map((row) => row.entryPoint.id).join(", ")} from “${route.name}” before choosing a different source.`,
		};
	const mutations: Mutation[] = [];
	if (route.parentModuleUuid !== source.parentModuleUuid)
		mutations.push({
			kind: "moveModule",
			uuid: route.uuid,
			parentModuleUuid: source.parentModuleUuid ?? null,
			after: null,
		});
	mutations.push({
		kind: "updateModule",
		uuid: routeUuid,
		patch: { formsFromMenu: { menuUuid: nextUuid } },
	});
	return { ok: true, mutations };
}
