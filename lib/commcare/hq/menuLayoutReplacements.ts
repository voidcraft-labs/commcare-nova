import type { BlueprintDoc } from "@/lib/domain";
import type { WireIdentity } from "../wireIdentity";
import type { HqAppSource } from "./appSource";
import { retainedMenuLayouts } from "./menuLayout";

type Layout = "list" | "grid" | "individual" | "unreadable";

/** The most menus one line names before it counts the rest. */
const NAMED_MENUS = 10;

const LAYOUT_NAMES: Readonly<Record<Layout, string>> = {
	list: "a list",
	grid: "a grid",
	individual: "individual menu layouts",
	unreadable: "a layout Nova can't read",
};

/** "“Visits” (menu 2), “Clinic” (menu 4) and 3 more menus" */
function namedMenus(menus: readonly string[]): string {
	const named = menus.slice(0, NAMED_MENUS);
	const rest = menus.length - named.length;
	if (rest > 0)
		return `${named.join(", ")} and ${rest} more ${rest === 1 ? "menu" : "menus"}`;
	if (named.length === 1) return named[0] ?? "";
	return `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

/**
 * Choices the HQ app holds that this document would replace when its
 * settings are written, in Nova's voice. Menus are matched by their wire
 * ids on this project space, so a dormant grid on a menu and a menu the
 * document no longer has are both found. One line per kind of change keeps
 * the list short however many menus share it: at most two app lines and
 * four menu lines.
 */
export function replacedMenuLayouts(
	doc: BlueprintDoc,
	identity: WireIdentity,
	source: HqAppSource,
): readonly string[] {
	const held = retainedMenuLayouts(source);
	const lines: string[] = [];
	function changed(subject: string, before: Layout, after: Layout) {
		if (before !== "list" && before !== after)
			lines.push(
				`${subject} would change from ${LAYOUT_NAMES[before]} to ${LAYOUT_NAMES[after]}.`,
			);
	}
	changed(
		"The first menu",
		held.firstMenuLayout,
		doc.appSettings.firstMenuLayout ?? "list",
	);
	changed(
		"The layout for the other menus",
		held.formMenuLayout,
		doc.appSettings.formMenuLayout ?? "list",
	);
	if (held.menus.length === 0) return lines;
	const byId = new Map(
		doc.moduleOrder.map((uuid) => [
			identity.moduleUniqueId(uuid),
			doc.modules[uuid],
		]),
	);
	const changedMenus = new Map<string, string[]>();
	const removedMenus = new Map<Layout, string[]>();
	for (const { position, layout } of held.menus) {
		const id = source.modules[position]?.uniqueId;
		const destination = id ? byId.get(id) : undefined;
		const name = heldMenuName(source, position) ?? destination?.name;
		const menu = name
			? `“${name}” (menu ${position + 1})`
			: `menu ${position + 1}`;
		if (!destination) {
			removedMenus.set(layout, [...(removedMenus.get(layout) ?? []), menu]);
			continue;
		}
		const after = destination.menuLayout ?? "list";
		if (after === layout) continue;
		const key = `${layout}>${after}`;
		changedMenus.set(key, [...(changedMenus.get(key) ?? []), menu]);
	}
	for (const [key, menus] of changedMenus) {
		const [before, after] = key.split(">") as [Layout, Layout];
		lines.push(
			`The layout chosen for ${namedMenus(menus)} would change from ${LAYOUT_NAMES[before]} to ${LAYOUT_NAMES[after]}.`,
		);
	}
	for (const [layout, menus] of removedMenus)
		lines.push(
			`Publishing would remove ${namedMenus(menus)}, including the ${layout === "grid" ? "grid" : "layout Nova can't read"} chosen there.`,
		);
	return lines;
}

/** The menu's name as HQ holds it, in the app's first language where it has one. */
function heldMenuName(source: HqAppSource, position: number): string | null {
	const rawMenu: unknown = Array.isArray(source.raw.modules)
		? source.raw.modules[position]
		: undefined;
	const names =
		rawMenu && typeof rawMenu === "object" && "name" in rawMenu
			? rawMenu.name
			: null;
	if (!names || typeof names !== "object") return null;
	const entries = Object.entries(names);
	const first = entries.find(
		([lang, value]) => lang === source.langs[0] && typeof value === "string",
	)?.[1];
	const any =
		first ?? entries.find(([, value]) => typeof value === "string")?.[1];
	return typeof any === "string" && any !== "" ? any : null;
}
