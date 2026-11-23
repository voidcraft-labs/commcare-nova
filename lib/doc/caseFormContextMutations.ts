import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { Mutation } from "./types";

/** Removing a Results tile retires its own pull-down and selects the fallback
 * the worker could previously reach. A menu with no fallback keeps its
 * reference, so the gate asks which context to show before accepting the edit. */
export function retireCaseFormContextTile(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	removingMenu = false,
): Mutation[] {
	const updates: Mutation[] = [];
	for (const menu of Object.values(doc.modules)) {
		if (removingMenu && menu.uuid === moduleUuid) continue;
		const config = menu.caseListConfig;
		const source = config?.contextAboveForm;
		if (!source) continue;
		if (menu.uuid === moduleUuid && source.kind === "own-tile") {
			updates.push({
				kind: "setCaseListMeta",
				uuid: menu.uuid,
				patch: { contextAboveForm: null },
			});
		} else if (
			source.kind === "menu-tile" &&
			source.moduleUuid === moduleUuid
		) {
			if (config?.tile?.persistOnForms) {
				const expands =
					source.expandDetails &&
					config.columns.some((column) => column.visibleInDetail !== false);
				updates.push({
					kind: "setCaseListMeta",
					uuid: menu.uuid,
					patch: {
						contextAboveForm: expands
							? { kind: "own-tile", expandDetails: true }
							: null,
					},
				});
			} else if (source.expression) {
				updates.push({
					kind: "setCaseListMeta",
					uuid: menu.uuid,
					patch: {
						contextAboveForm: { kind: "line", expression: source.expression },
					},
				});
			}
		}
	}
	return updates;
}
