/**
 * What keeps a menu from being an advanced module, and the index name an
 * advanced form's chained loads follow. A blocker the domain misses would
 * let a held advanced kind stand over a menu HQ's advanced entry shows
 * differently (a filter dropped, a second index name lost); one it reports
 * for nothing would clear a published kind and move every path its forms
 * keep. So each blocker is shown with a twin that differs only in it.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type ModuleSpec } from "@/lib/__tests__/docHelpers";
import {
	advancedChainIndex,
	advancedKindBlockers,
	heldKindExpresses,
} from "@/lib/domain/advancedModule";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	isBlank,
	literal,
	matchAll,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import type { CaseOperation, CaseOperationLink } from "@/lib/domain/forms";

const HOUSEHOLDS = "advanced-households";
const MEMBERS = "advanced-members";
const VISITS = "advanced-visits";
const REGISTER = "advanced-register";
const FOLLOW_UP = "advanced-follow-up";

function link(
	identifier: string,
	targetType: string,
	relationship: CaseOperationLink["relationship"] = "child",
): CaseOperationLink {
	return {
		identifier,
		targetType,
		target: { kind: "session" },
		relationship,
	};
}

function create(
	label: string,
	caseType: string,
	links: CaseOperationLink[],
): CaseOperation {
	return {
		uuid: testUuid(`advanced-create-${label}`),
		id: label,
		action: "create",
		caseType,
		target: { kind: "new" },
		name: term(literal(label)),
		links,
	};
}

/**
 * Households, then members chosen under their household. `register` holds
 * the creates of a household's follow-up form; `ownLinks` the links of the
 * members' follow-up form's own case.
 */
function chainDoc(
	options: {
		readonly register?: CaseOperation[];
		readonly ownLinks?: CaseOperationLink[];
		readonly members?: Partial<ModuleSpec>;
	} = {},
): BlueprintDoc {
	return buildDoc(
		{
			modules: [
				{
					uuid: HOUSEHOLDS,
					name: "Households",
					caseType: "household",
					forms: [{ uuid: REGISTER, name: "Visit", type: "followup" }],
				},
				{
					uuid: MEMBERS,
					name: "Members",
					caseType: "member",
					parentCaseModuleUuid: HOUSEHOLDS,
					forms: [{ uuid: FOLLOW_UP, name: "Check in", type: "followup" }],
					...options.members,
				},
			],
		},
		(doc) => {
			if (options.register !== undefined)
				doc.forms[testUuid(REGISTER)].caseOperations = options.register;
			if (options.ownLinks !== undefined)
				doc.forms[testUuid(FOLLOW_UP)].caseOperations = [
					{
						uuid: testUuid("advanced-own-member"),
						id: "member",
						action: "own",
						links: options.ownLinks,
					},
				];
		},
	);
}

describe("advancedChainIndex", () => {
	it("follows `parent` where no link joins the two types", () => {
		expect(advancedChainIndex(chainDoc(), "member", "household")).toEqual({
			kind: "one",
			identifier: "parent",
		});
	});

	it("follows the one name the app's links use, counted once", () => {
		const doc = chainDoc({
			register: [
				create("first", "member", [link("household", "household")]),
				create("second", "member", [link("household", "household")]),
			],
		});
		expect(advancedChainIndex(doc, "member", "household")).toEqual({
			kind: "one",
			identifier: "household",
		});
	});

	it("finds several names in document order, a form's own case included", () => {
		const doc = chainDoc({
			register: [create("first", "member", [link("household", "household")])],
			ownLinks: [link("home", "household")],
		});
		expect(advancedChainIndex(doc, "member", "household")).toEqual({
			kind: "several",
			identifiers: ["household", "home"],
		});
	});

	it("reads only links from the child type to the parent type", () => {
		const doc = chainDoc({
			register: [
				create("visit", "visit", [link("visited", "household")]),
				create("member", "member", [link("guardian", "member")]),
			],
		});
		expect(advancedChainIndex(doc, "member", "household")).toEqual({
			kind: "one",
			identifier: "parent",
		});
		expect(advancedChainIndex(doc, "visit", "household")).toEqual({
			kind: "one",
			identifier: "visited",
		});
	});

	it("does not count extension links, which a parent selection never lists", () => {
		const doc = chainDoc({
			register: [
				create("first", "member", [link("household", "household")]),
				create("host", "member", [link("host", "household", "extension")]),
			],
		});
		expect(advancedChainIndex(doc, "member", "household")).toEqual({
			kind: "one",
			identifier: "household",
		});
	});
});

describe("advancedKindBlockers", () => {
	/** A root menu of members with only its case list, or with a follow-up
	 *  form, as the twin's one difference asks. */
	function memberMenu(spec: Partial<ModuleSpec> = {}): BlueprintDoc {
		return buildDoc({
			modules: [
				{
					uuid: MEMBERS,
					name: "Members",
					caseType: "member",
					forms: [{ uuid: FOLLOW_UP, name: "Check in", type: "followup" }],
					...spec,
				},
			],
		});
	}
	const members = testUuid(MEMBERS);

	it("finds nothing on an ordinary one-case menu", () => {
		const doc = memberMenu({ caseListMenuItem: {}, forms: [] });
		expect(advancedKindBlockers(doc, members)).toEqual([]);
		expect(heldKindExpresses(doc, members)).toBe(true);
	});

	it("is blocked by a list that chooses several cases", () => {
		expect(
			advancedKindBlockers(
				memberMenu({
					caseListConfig: {
						columns: [],
						searchInputs: [],
						selection: { kind: "multiple", maximum: 5 },
					},
				}),
				members,
			),
		).toEqual([{ kind: "several-cases" }]);
		expect(
			advancedKindBlockers(
				memberMenu({ caseListConfig: { columns: [], searchInputs: [] } }),
				members,
			),
		).toEqual([]);
	});

	it("is blocked by a menu whose forms read the search", () => {
		const blocked = memberMenu({
			caseSearchConfig: { formsReadSearch: true },
		});
		expect(advancedKindBlockers(blocked, members)).toEqual([
			{ kind: "forms-read-search" },
		]);
		expect(heldKindExpresses(blocked, members)).toBe(false);
		// Search first and results first alone keep the menu's forms on the
		// case they open, which an advanced entry gives.
		expect(
			advancedKindBlockers(memberMenu({ caseSearchConfig: {} }), members),
		).toEqual([]);
		expect(
			advancedKindBlockers(
				memberMenu({ caseSearchConfig: { workflow: "skipToResults" } }),
				members,
			),
		).toEqual([]);
	});

	it("is blocked by a filtered case list shown as a menu item", () => {
		const filtered = {
			columns: [],
			searchInputs: [],
			filter: isBlank(prop("member", "status")),
		};
		expect(
			advancedKindBlockers(
				memberMenu({
					caseListMenuItem: {},
					forms: [],
					caseListConfig: filtered,
				}),
				members,
			),
		).toEqual([{ kind: "case-list-menu-item-narrowed", why: "filter" }]);
		// Beside the menu's forms the entry lists the same narrowed list.
		expect(
			advancedKindBlockers(
				memberMenu({ caseListMenuItem: {}, caseListConfig: filtered }),
				members,
			),
		).toEqual([{ kind: "case-list-menu-item-narrowed", why: "filter" }]);
		// The same filter where the list is no menu item narrows nothing an
		// advanced menu shows.
		expect(
			advancedKindBlockers(memberMenu({ caseListConfig: filtered }), members),
		).toEqual([]);
		// A filter that keeps every case is no filter on the wire.
		expect(
			advancedKindBlockers(
				memberMenu({
					caseListMenuItem: {},
					forms: [],
					caseListConfig: { ...filtered, filter: matchAll() },
				}),
				members,
			),
		).toEqual([]);
	});

	it("is blocked by a case list menu item that hides some owners' cases", () => {
		expect(
			advancedKindBlockers(
				memberMenu({
					caseListMenuItem: {},
					forms: [],
					caseSearchConfig: { excludedOwnerIds: term(literal("owner-a")) },
				}),
				members,
			),
		).toEqual([{ kind: "case-list-menu-item-narrowed", why: "hidden-owners" }]);
		expect(
			advancedKindBlockers(
				memberMenu({ caseListMenuItem: {}, forms: [], caseSearchConfig: {} }),
				members,
			),
		).toEqual([]);
	});

	it("is blocked by a case list menu item under a parent selection", () => {
		const doc = chainDoc({ members: { caseListMenuItem: {}, forms: [] } });
		expect(advancedKindBlockers(doc, members)).toEqual([
			{ kind: "case-list-menu-item-narrowed", why: "chosen-before" },
		]);
	});

	it("is blocked by a case list menu item that follows its containing menu's case", () => {
		function nested(parentType: string): BlueprintDoc {
			return buildDoc(
				{
					modules: [
						{
							uuid: HOUSEHOLDS,
							name: "Visits",
							caseType: parentType,
							forms: [{ uuid: REGISTER, name: "Visit", type: "followup" }],
						},
						{
							uuid: VISITS,
							name: "All members",
							caseType: "member",
							caseListMenuItem: {},
						},
					],
				},
				(doc) => {
					doc.modules[testUuid(VISITS)].parentModuleUuid = testUuid(HOUSEHOLDS);
				},
			);
		}
		expect(advancedKindBlockers(nested("member"), testUuid(VISITS))).toEqual([
			{ kind: "case-list-menu-item-narrowed", why: "chosen-before" },
		]);
		expect(advancedKindBlockers(nested("household"), testUuid(VISITS))).toEqual(
			[],
		);
	});

	it("is blocked by a parent selection whose types link under two names", () => {
		const blocked = chainDoc({
			register: [
				create("first", "member", [link("household", "household")]),
				create("second", "member", [link("home", "household")]),
			],
		});
		expect(advancedKindBlockers(blocked, members)).toEqual([
			{
				kind: "chain-index",
				childType: "member",
				parentType: "household",
				identifiers: ["household", "home"],
			},
		]);
		const twin = chainDoc({
			register: [
				create("first", "member", [link("household", "household")]),
				create("second", "member", [link("household", "household")]),
			],
		});
		expect(advancedKindBlockers(twin, members)).toEqual([]);
		// The root of the chain selects no parent, so it follows no index.
		expect(advancedKindBlockers(blocked, testUuid(HOUSEHOLDS))).toEqual([]);
	});
});
