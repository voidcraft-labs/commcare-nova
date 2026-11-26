import type { HqAppSource } from "./appSource";

export function sourceModuleMenuLayout(
	value: unknown,
): "list" | "grid" | "unreadable" {
	if (value === undefined || value === "list") return "list";
	return value === "grid" ? "grid" : "unreadable";
}

/** Menu layout as held by an HQ source. A missing value has HQ's schema
 * default. Unknown spellings stay visible to review and cannot become a
 * silent list on a deployment created before Nova authored these settings. */
export function sourceMenuLayouts(source: Readonly<Record<string, unknown>>) {
	const first = source.use_grid_menus;
	const forms = source.grid_form_menus;
	return {
		firstMenuLayout:
			first === undefined || first === false
				? "list"
				: first === true
					? "grid"
					: "unreadable",
		formMenuLayout:
			forms === undefined || forms === "none"
				? "list"
				: forms === "all"
					? "grid"
					: forms === "some"
						? "individual"
						: "unreadable",
	} as const;
}

/** Read-only census of settings the previous authoring model could not
 * represent. A basic menu's dormant choice still belongs to its HQ editor.
 * An operator can report the ordinals without disclosing app content. */
export function retainedMenuLayouts(source: HqAppSource) {
	const menus: { position: number; layout: "grid" | "unreadable" }[] = [];
	const raw = source.raw.modules;
	for (const [position, menu] of source.modules.entries()) {
		if (menu.docType !== "Module") continue;
		const body: unknown = Array.isArray(raw) ? raw[position] : undefined;
		const layout =
			body && typeof body === "object" && "display_style" in body
				? sourceModuleMenuLayout(body.display_style)
				: "list";
		if (layout !== "list") menus.push({ position, layout });
	}
	return { ...sourceMenuLayouts(source.raw), menus };
}
