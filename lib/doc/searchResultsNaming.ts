import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { moduleFormsReadSearch } from "@/lib/domain";
import { parentSelectionChain } from "@/lib/domain/entryDatumSupplies";
import { searchResultsNameSchema } from "@/lib/domain/modules";
import { updateModuleMutation } from "./addModuleMutation";
import type { Mutation } from "./types";

/** Allocate only during an author's operation. Replay and read-back keep exactly the name
 * that was recorded, including the absence of a name on older documents. */
export function offeredSearchResultsName(
	doc: BlueprintDoc,
	menu: Module,
	change: {
		parentModuleUuid?: Uuid | null;
		parentCaseModuleUuid?: Uuid | null;
		turnsInline?: boolean;
	} = {},
): string | undefined {
	const nameInUse = menu.searchResultsName ?? "inline";
	const navigationParent =
		change.parentModuleUuid === undefined
			? menu.parentModuleUuid
			: change.parentModuleUuid;
	const selectionParent =
		change.parentCaseModuleUuid === undefined
			? menu.parentCaseModuleUuid
			: change.parentCaseModuleUuid;
	const inline = change.turnsInline === true || moduleFormsReadSearch(menu);
	const parents = [navigationParent, selectionParent];
	if (inline && selectionParent)
		parents.push(...parentSelectionChain(doc, selectionParent));
	const matchesParent = parents.some((id) => {
		const parent = id && doc.modules[id];
		return (
			parent &&
			moduleFormsReadSearch(parent) &&
			(parent.searchResultsName ?? "inline") === nameInUse
		);
	});
	const matchesChild =
		change.turnsInline === true &&
		Object.values(doc.modules).some(
			(child) =>
				(child.searchResultsName ?? "inline") === nameInUse &&
				(child.parentModuleUuid === menu.uuid ||
					child.parentCaseModuleUuid === menu.uuid ||
					(moduleFormsReadSearch(child) &&
						parentSelectionChain(doc, child.uuid).includes(menu.uuid))),
		);
	if (!matchesParent && !matchesChild) return undefined;
	const base =
		menu.searchResultsName ??
		(searchResultsNameSchema.safeParse(menu.id).success && menu.id !== "inline"
			? menu.id
			: "Search");
	const used = new Set(
		Object.values(doc.modules).map((mod) => mod.searchResultsName ?? "inline"),
	);
	let name = base;
	for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
	return name;
}

export function offerSearchNameMutations(
	doc: BlueprintDoc,
	menu: Uuid,
	change: Parameters<typeof offeredSearchResultsName>[2],
): Mutation[] {
	const current = doc.modules[menu];
	const name = current && offeredSearchResultsName(doc, current, change);
	return name === undefined
		? []
		: [updateModuleMutation(menu, { searchResultsName: name })];
}
