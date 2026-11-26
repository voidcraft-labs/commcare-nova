/**
 * Contract: another menu's tile expanded above a menu's forms keeps that menu's own tile
 * persisting whether or not its switch is stored, because the wire switches the menu's
 * persistence on beside every such tile and HQ's build falls back to its own tile and Details
 * (`entries.py::get_detail_persistent_attr`, `get_detail_inline_attr`). So the author's choice
 * stores no switch there (`formContextPatch`), the inline Details fall back to the menu's own
 * (`resolveCaseFormContext`), and removing the source menu's tile keeps the menu's own tile above
 * its forms (`retireCaseFormContextTile`). The plausible failures: a document Nova exports
 * validly reads back without the switch and is refused for expandable context with no Details,
 * and removing the source's tile drops the context the worker had.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import { runValidation } from "@/lib/commcare/validator/runner";
import { retireCaseFormContextTile } from "@/lib/doc/caseFormContextMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	formContextPatch,
	resolveCaseFormContext,
} from "@/lib/domain/caseFormContext";

/** The fixture's menu that shows another menu's tile expanded above its forms, with no fallback
 *  line, and that source menu. */
function expandedMenuTile(sourceShowsNoDetail: boolean) {
	const doc = produce(tileFixture("persistent-external"), (draft) => {
		const context = Object.values(draft.modules).find(
			(module) => module.caseListConfig?.contextAboveForm?.kind === "menu-tile",
		)?.caseListConfig?.contextAboveForm;
		if (context?.kind !== "menu-tile")
			throw new Error("The fixture shows another menu's tile above forms.");
		delete context.expression;
		if (sourceShowsNoDetail)
			for (const column of draft.modules[context.moduleUuid]?.caseListConfig
				?.columns ?? [])
				column.visibleInDetail = false;
	});
	const menu = Object.values(doc.modules).find(
		(module) => module.caseListConfig?.contextAboveForm?.kind === "menu-tile",
	);
	const context = menu?.caseListConfig?.contextAboveForm;
	if (menu === undefined || context?.kind !== "menu-tile")
		throw new Error("The fixture shows another menu's tile above forms.");
	return { doc, menu: menu.uuid, source: context.moduleUuid };
}

function contextFindings(doc: BlueprintDoc) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) =>
		error.code.includes("CONTEXT"),
	);
}

describe("another menu's tile expanded above the forms", () => {
	it("stores no switch for the menu's own tile when the author chooses it", () => {
		const { doc, menu, source } = expandedMenuTile(false);
		const config = doc.modules[menu]?.caseListConfig;
		if (config?.tile === undefined) throw new Error("The menu has a tile.");
		const patch = formContextPatch(
			{ ...config, tile: { ...config.tile, persistOnForms: true } },
			{ kind: "menu-tile", moduleUuid: source, expandDetails: true },
		);
		if ("error" in patch) throw new Error(patch.error);
		// The fixture's own tile stores no switch, so the patch gives back exactly that tile.
		expect(config.tile.persistOnForms).toBeUndefined();
		expect(patch.patch.tile).toEqual(config.tile);
	});

	it("expands the menu's own Details where the source menu shows none", () => {
		const { doc, menu } = expandedMenuTile(true);
		expect(resolveCaseFormContext(doc.modules, menu)).toEqual({
			kind: "tile",
			sourceModuleUuid: expect.any(String),
			inlineModuleUuid: menu,
		});
		expect(contextFindings(doc)).toEqual([]);
	});

	it("keeps the menu's own tile expanded above its forms when the source's tile goes", () => {
		const { doc, menu, source } = expandedMenuTile(false);
		const retired = produce(doc, (draft) => {
			applyMutations(draft, [
				{
					kind: "setCaseListMeta",
					uuid: source as Uuid,
					patch: { tile: null },
				},
				...retireCaseFormContextTile(doc, source as Uuid),
			]);
		});
		const config = retired.modules[menu]?.caseListConfig;
		expect(config?.contextAboveForm).toEqual({
			kind: "own-tile",
			expandDetails: true,
		});
		expect(config?.tile?.persistOnForms).toBe(true);
		expect(resolveCaseFormContext(retired.modules, menu)).toMatchObject({
			sourceModuleUuid: menu,
			inlineModuleUuid: menu,
		});
	});
});
