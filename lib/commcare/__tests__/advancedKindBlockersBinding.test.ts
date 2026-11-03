/**
 * The domain's `case-list-menu-item-narrowed` blocker restates in domain
 * terms what the emitter shows of a basic menu's list: HQ's advanced menu
 * item lists every open case of the type (`entries.py::entry_for_module`),
 * so a menu whose list is narrowed (`case_details.short.filter` holds a
 * filter, or its case-list entry follows a case chosen before its own) must
 * not be advanced. Over every module of the fixture corpus, each also with
 * its case list as a menu item, the blocker holds exactly where the basic
 * projection narrows the list. Catches the reader the builder offers from
 * drifting from the wire.
 */
import { describe, expect, it } from "vitest";
import {
	entryDatumIds,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import { projectCaseListForHq } from "@/lib/commcare/hqJson/caseList";
import {
	advancedKindBlockers,
	type BlueprintDoc,
	type Uuid,
} from "@/lib/domain";
import { emissionFixtures } from "./emissionFixtures";

/** Whether the basic projection narrows `moduleUuid`'s list. */
function projectionNarrows(doc: BlueprintDoc, moduleUuid: Uuid): boolean {
	const module = doc.modules[moduleUuid];
	if (module === undefined) return false;
	if (projectCaseListForHq(module, doc).caseDetails.short.filter !== null)
		return true;
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	// The cases the entry's selections choose, by the menus whose lists
	// choose them: a root menu's case its child's list follows is one datum
	// holding both menus' selections.
	const chosen = new Set<Uuid>();
	for (const row of entryDatumIds(doc, ctx, moduleUuid))
		for (const ref of row.refs)
			if (ref.kind === "selected-case") chosen.add(ref.module);
	return chosen.size > 1;
}

function narrowedBlocker(doc: BlueprintDoc, moduleUuid: Uuid): boolean {
	return advancedKindBlockers(doc, moduleUuid).some(
		(blocker) => blocker.kind === "case-list-menu-item-narrowed",
	);
}

/** `doc` with `moduleUuid`'s case list a menu item. */
function asMenuItem(doc: BlueprintDoc, moduleUuid: Uuid): BlueprintDoc {
	const copy = structuredClone(doc);
	copy.modules[moduleUuid] = {
		...copy.modules[moduleUuid],
		caseListMenuItem: {},
	};
	return copy;
}

describe("case-list-menu-item-narrowed", () => {
	it("holds exactly where the basic projection narrows a menu item's list", () => {
		let menuItems = 0;
		let narrowed = 0;
		for (const { name, doc } of emissionFixtures())
			for (const moduleUuid of doc.moduleOrder) {
				if (!doc.modules[moduleUuid]?.caseType) continue;
				const shown = asMenuItem(doc, moduleUuid);
				const expected = projectionNarrows(shown, moduleUuid);
				expect(
					narrowedBlocker(shown, moduleUuid),
					`${name}: ${doc.modules[moduleUuid]?.name}`,
				).toBe(expected);
				menuItems++;
				if (expected) narrowed++;
				// A list that is no menu item narrows nothing an advanced menu
				// shows.
				if (doc.modules[moduleUuid]?.caseListMenuItem === undefined)
					expect(narrowedBlocker(doc, moduleUuid)).toBe(false);
			}
		// The corpus holds both kinds of menu item.
		expect(narrowed).toBeGreaterThan(0);
		expect(menuItems).toBeGreaterThan(narrowed);
	});
});
