/**
 * Whether a menu is emitted as an advanced module. A menu made advanced for
 * no create moves every path and session value its forms keep; one left
 * basic where a link carries a create that a basic form gives no datum
 * opens the link's target on an empty case. So each trigger and each
 * blocker is shown with a twin that differs only in it.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	advancedKindReasons,
	advancedModulesWithCaseListMenuItem,
	emittedModuleKind,
} from "@/lib/commcare/moduleKind";
import type {
	BlueprintDoc,
	CaseOperation,
	CaseOperationLink,
	FormLink,
	Module,
} from "@/lib/domain";
import { isBlank, prop } from "@/lib/domain/expression/builders";
import {
	type AdvancedFixtureOptions,
	advancedFixture,
	HOUSEHOLD_VISIT,
	HOUSEHOLDS,
	MEMBERS,
	OP,
	read,
	UNDER_TEST,
	VISIT_REVIEW,
	VISITS,
} from "./advancedPlacementFixture";

const OWN = OP("own");
const LINK = OP("link");

const toOwn = (
	relationship: CaseOperationLink["relationship"],
): CaseOperationLink => ({
	identifier: "parent",
	targetType: "household",
	target: { kind: "op", opUuid: OWN },
	relationship,
});
const own = (): CaseOperation =>
	({
		uuid: OWN,
		id: "own_case",
		action: "own",
		name: read("name"),
	}) as CaseOperation;
const visitCreate = (
	relationship: CaseOperationLink["relationship"],
): CaseOperation =>
	({
		uuid: OP("visit"),
		id: "visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: read("name"),
		links: [toOwn(relationship)],
	}) as CaseOperation;
const toReview: FormLink = {
	uuid: LINK,
	target: { type: "form", moduleUuid: VISITS, formUuid: VISIT_REVIEW },
};

/** A household registration creating a visit, linked to the visit's review
 *  form, which reads the visit as its case. */
function carriedDoc(
	relationship: CaseOperationLink["relationship"],
	extra: Partial<AdvancedFixtureOptions> = {},
): BlueprintDoc {
	return advancedFixture({
		formType: "registration",
		heldKind: false,
		operations: () => [own(), visitCreate(relationship)],
		...extra,
		configure: (doc) => {
			const form = doc.forms[UNDER_TEST];
			if (form !== undefined)
				doc.forms[UNDER_TEST] = { ...form, formLinks: [toReview] };
			extra.configure?.(doc);
		},
	}).doc;
}

function patchModule(
	doc: BlueprintDoc,
	uuid: typeof HOUSEHOLDS,
	patch: Partial<Module>,
): void {
	doc.modules[uuid] = { ...doc.modules[uuid], ...patch };
}

describe("emittedModuleKind", () => {
	it("is advanced where the kind is held, and basic otherwise", () => {
		const held = advancedFixture({ formType: "followup" }).doc;
		expect(emittedModuleKind(held, HOUSEHOLDS)).toBe("advanced");
		expect(advancedKindReasons(held, HOUSEHOLDS)).toEqual([{ kind: "held" }]);
		const twin = advancedFixture({ formType: "followup", heldKind: false }).doc;
		expect(emittedModuleKind(twin, HOUSEHOLDS)).toBe("basic");
		expect(advancedKindReasons(twin, HOUSEHOLDS)).toEqual([]);
	});

	it("is advanced where a link carries a create a basic form gives no datum", () => {
		const doc = carriedDoc("extension");
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		expect(advancedKindReasons(doc, HOUSEHOLDS)).toEqual([
			{
				kind: "carried-create",
				formUuid: UNDER_TEST,
				operationUuid: OP("visit"),
				linkUuid: LINK,
			},
		]);
		// The target's menu carries nothing and stays basic.
		expect(emittedModuleKind(doc, VISITS)).toBe("basic");
	});

	it("stays basic where a basic subcase already gives the carried create its datum", () => {
		const doc = carriedDoc("child");
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("basic");
		expect(advancedKindReasons(doc, HOUSEHOLDS)).toEqual([]);
	});

	const blockers: ReadonlyArray<{
		readonly name: string;
		readonly menu: "households" | "members";
		readonly block: (doc: BlueprintDoc) => void;
		readonly twin: (doc: BlueprintDoc) => void;
	}> = [
		{
			name: "several cases",
			menu: "households",
			block: (doc) => {
				const config = doc.modules[HOUSEHOLDS].caseListConfig;
				if (config !== undefined)
					patchModule(doc, HOUSEHOLDS, {
						caseListConfig: {
							...config,
							selection: { kind: "multiple", maximum: 5 },
						},
					});
			},
			twin: () => {},
		},
		{
			name: "forms reading the search",
			menu: "households",
			block: (doc) =>
				patchModule(doc, HOUSEHOLDS, {
					caseSearchConfig: { formsReadSearch: true },
				}),
			twin: (doc) => patchModule(doc, HOUSEHOLDS, { caseSearchConfig: {} }),
		},
		{
			name: "a narrowed case list menu item",
			menu: "households",
			block: (doc) => {
				const config = doc.modules[HOUSEHOLDS].caseListConfig;
				if (config !== undefined)
					patchModule(doc, HOUSEHOLDS, {
						caseListMenuItem: {},
						caseListConfig: {
							...config,
							filter: isBlank(prop("household", "case_name")),
						},
					});
			},
			twin: (doc) => patchModule(doc, HOUSEHOLDS, { caseListMenuItem: {} }),
		},
		{
			name: "a chain whose types link under two names",
			menu: "members",
			block: (doc) => {
				const form = doc.forms[HOUSEHOLD_VISIT];
				doc.forms[HOUSEHOLD_VISIT] = {
					...form,
					caseOperations: (["household", "home"] as const).map(
						(identifier) =>
							({
								uuid: OP(`member-${identifier}`),
								id: `member_${identifier}`,
								action: "create",
								caseType: "member",
								target: { kind: "new" },
								name: read("name"),
								links: [
									{
										identifier,
										targetType: "household",
										target: { kind: "session" },
										relationship: "child",
									},
								],
							}) as CaseOperation,
					),
				};
			},
			twin: () => {},
		},
	];

	for (const blocker of blockers)
		it(`keeps a held kind basic under ${blocker.name}, and its twin advanced`, () => {
			const module = blocker.menu === "households" ? HOUSEHOLDS : MEMBERS;
			const blocked = advancedFixture({
				formType: "followup",
				menu: blocker.menu,
				configure: blocker.block,
			}).doc;
			expect(emittedModuleKind(blocked, module)).toBe("basic");
			expect(advancedKindReasons(blocked, module)).toEqual([]);
			const twin = advancedFixture({
				formType: "followup",
				menu: blocker.menu,
				configure: blocker.twin,
			}).doc;
			expect(emittedModuleKind(twin, module)).toBe("advanced");
		});

	it("keeps a menu basic where a blocker meets the create a link carries", () => {
		const doc = carriedDoc("extension", {
			configure: (d) =>
				patchModule(d, HOUSEHOLDS, {
					caseSearchConfig: { formsReadSearch: true },
				}),
		});
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("basic");
	});

	it("is the same whichever of two menus that link to each other is asked first", () => {
		const linked = () =>
			carriedDoc("extension", {
				configure: (d) => {
					// The visit's review creates a household extension and links
					// back to the household's visit form.
					const review = d.forms[VISIT_REVIEW];
					d.forms[VISIT_REVIEW] = {
						...review,
						caseOperations: [
							{
								uuid: OP("back"),
								id: "back",
								action: "create",
								caseType: "household",
								target: { kind: "new" },
								name: read("name"),
								links: [
									{
										identifier: "host",
										targetType: "visit",
										target: { kind: "session" },
										relationship: "extension",
									},
								],
							} as CaseOperation,
						],
						formLinks: [
							{
								uuid: OP("back-link"),
								target: {
									type: "form",
									moduleUuid: HOUSEHOLDS,
									formUuid: HOUSEHOLD_VISIT,
								},
							},
						],
					};
				},
			});
		const first = linked();
		const householdsFirst = [
			emittedModuleKind(first, HOUSEHOLDS),
			emittedModuleKind(first, VISITS),
		];
		const second = linked();
		const visitsFirst = [
			emittedModuleKind(second, VISITS),
			emittedModuleKind(second, HOUSEHOLDS),
		].reverse();
		expect(householdsFirst).toEqual(["advanced", "advanced"]);
		expect(visitsFirst).toEqual(householdsFirst);
	});
});

describe("advancedModulesWithCaseListMenuItem", () => {
	const BROWSE = testUuid("kind-browse");
	/** Households whose only content is its case list as a menu item, beside
	 *  a menu with a form. */
	const browseDoc = (held: boolean): BlueprintDoc =>
		buildDoc(
			{
				caseTypes: [
					{
						name: "household",
						properties: [{ name: "case_name", label: "Name" }],
					},
				],
				modules: [
					{
						uuid: "kind-browse",
						name: "Households",
						caseType: "household",
						caseListMenuItem: {},
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
					},
					{
						name: "Visits",
						caseType: "household",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Visit",
								type: "followup",
								fields: [f({ kind: "text", id: "remark" })],
							},
						],
					},
				],
			},
			(doc) => {
				if (held)
					doc.modules[BROWSE] = {
						...doc.modules[BROWSE],
						heldKind: "advanced",
					};
			},
		);

	it("returns a menu whose kind is held advanced and whose case list menu item is its only content", () => {
		const doc = browseDoc(true);
		expect(emittedModuleKind(doc, BROWSE)).toBe("advanced");
		expect(advancedModulesWithCaseListMenuItem(doc)).toEqual([BROWSE]);
	});

	it("returns nothing for the same menu without the hold", () => {
		const doc = browseDoc(false);
		expect(emittedModuleKind(doc, BROWSE)).toBe("basic");
		expect(advancedModulesWithCaseListMenuItem(doc)).toEqual([]);
	});

	it("returns nothing for an advanced menu with forms and no menu item", () => {
		const doc = advancedFixture({ formType: "followup" }).doc;
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		expect(advancedModulesWithCaseListMenuItem(doc)).toEqual([]);
	});

	it("returns an advanced menu whose case list menu item sits beside its forms", () => {
		const base = advancedFixture({ formType: "followup" }).doc;
		const doc = {
			...base,
			modules: {
				...base.modules,
				[HOUSEHOLDS]: { ...base.modules[HOUSEHOLDS], caseListMenuItem: {} },
			},
		};
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		expect(advancedModulesWithCaseListMenuItem(doc)).toEqual([HOUSEHOLDS]);
	});
});
