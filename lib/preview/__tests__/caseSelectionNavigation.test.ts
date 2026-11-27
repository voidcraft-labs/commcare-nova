/**
 * The selected-parent constraint a menu's list read carries. A menu emitted
 * advanced lists the children whose index of the chain's one name points at
 * the chosen parent (`index/<identifier>`, whatever the relationship), and a
 * menu emitted basic every child linked by a non-extension index; the store
 * reads the absent `index` as the basic constraint.
 *
 * The failure each case catches: an advanced menu's list read with the basic
 * constraint (Preview then hides an extension the device lists under its
 * host, or lists a child linked under another name), or a basic menu's read
 * narrowed to one name.
 */

import { describe, expect, it } from "vitest";
import {
	advancedFixture,
	chosen,
	HOUSEHOLDS,
	MEMBERS,
	OP,
	read,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { advancedLoadChain } from "@/lib/domain/advancedEntryDatums";
import {
	caseSelectionRouteCaseAction,
	parentCaseConstraint,
	parentCaseIndex,
} from "../caseSelectionNavigation";

const HOUSEHOLD_CHOICE = {
	caseType: "household",
	cases: [{ caseId: "h-1" }, { caseId: "h-2" }],
};

/** A follow-up of a member chosen under its household. With `identifier`,
 *  the form also makes a member linked to that household under the name. */
function members(options: {
	readonly heldKind: boolean;
	readonly identifier?: string;
}): BlueprintDoc {
	return advancedFixture({
		formType: "followup",
		menu: "members",
		heldKind: options.heldKind,
		operations: () =>
			options.identifier === undefined
				? []
				: [
						{
							uuid: OP("sibling"),
							id: "sibling",
							action: "create",
							caseType: "member",
							target: { kind: "new" },
							name: read("name"),
							links: [
								{
									identifier: options.identifier,
									targetType: "household",
									target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
									relationship: "child",
								},
							],
						} as CaseOperation,
					],
	}).doc;
}

describe("the index a parent selection follows", () => {
	it("follows the chain's one name where the menu is emitted advanced", () => {
		const doc = members({ heldKind: true, identifier: "household" });
		expect(emittedModuleKind(doc, MEMBERS)).toBe("advanced");
		expect(parentCaseIndex(doc, MEMBERS)).toBe("household");
		expect(parentCaseConstraint(doc, MEMBERS, HOUSEHOLD_CHOICE)).toEqual({
			caseType: "household",
			caseIds: ["h-1", "h-2"],
			index: "household",
		});
	});

	it("keeps the imported Advanced index when writers use another name", () => {
		const doc = members({ heldKind: true, identifier: "my-parent" });
		doc.modules[MEMBERS].parentCaseLink = {
			parentUuid: HOUSEHOLDS,
			identifier: "parent",
		};
		const formUuid = doc.formOrder[MEMBERS][0];
		expect(advancedLoadChain(doc, formUuid).at(-1)?.identifier).toBe("parent");
		expect(parentCaseConstraint(doc, MEMBERS, HOUSEHOLD_CHOICE)?.index).toBe(
			"parent",
		);
	});

	it("follows `parent` where no child link names the pair", () => {
		const doc = members({ heldKind: true });
		expect(emittedModuleKind(doc, MEMBERS)).toBe("advanced");
		expect(parentCaseIndex(doc, MEMBERS)).toBe("parent");
	});

	it("names no index where the menu is emitted basic", () => {
		const doc = members({ heldKind: false, identifier: "household" });
		expect(emittedModuleKind(doc, MEMBERS)).toBe("basic");
		expect(parentCaseIndex(doc, MEMBERS)).toBeUndefined();
		expect(parentCaseConstraint(doc, MEMBERS, HOUSEHOLD_CHOICE)).toEqual({
			caseType: "household",
			caseIds: ["h-1", "h-2"],
		});
	});

	it("carries no constraint without a parent choice, and no index on a root menu", () => {
		const doc = members({ heldKind: true });
		expect(parentCaseConstraint(doc, MEMBERS, undefined)).toBeUndefined();
		expect(parentCaseIndex(doc, HOUSEHOLDS)).toBeUndefined();
	});
});

/* A case a list's address names (`/cases/{caseId}`) follows the row's rule:
 * on a parent's list whose datum names no details screen the row goes on, so
 * the address goes on with its case and never shows details a device never
 * shows there; anywhere else it opens the case's details. */
describe("caseSelectionRouteCaseAction", () => {
	it.each([
		["a parent's list whose row goes on", "form", true, "continue"],
		["a parent's list whose datum names details", "detail", true, "detail"],
		["a list choosing its own case", "form", false, "detail"],
		["a list choosing its own case with details", "detail", false, "detail"],
		["an informational list", "none", false, "detail"],
	] as const)("%s", (_, rowAction, selectsForParentRequest, action) => {
		expect(
			caseSelectionRouteCaseAction({ rowAction, selectsForParentRequest }),
		).toBe(action);
	});
});
