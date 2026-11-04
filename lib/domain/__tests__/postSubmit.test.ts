/**
 * The after-submit offered set and default (`lib/domain/postSubmit.ts`,
 * `forms.ts::defaultPostSubmit`): which destinations each menu shape offers
 * a form, the built-in otherwise each offers a form with destinations, and
 * that the default is always offered. What each destination does on a device is the proof
 * lane's; these prove Nova's own reading of the shapes.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	defaultPostSubmit,
	defaultPostSubmitOf,
	effectivePostSubmit,
	FORM_TYPES,
	type FormType,
	type Module,
	OTHERWISE_DESTINATIONS,
	type OtherwiseDestination,
	otherwiseDestinationsOffered,
	type PostSubmitDestination,
	type PostSubmitNotOfferedReason,
	postSubmitDestinationChoices,
	postSubmitDestinationsOffered,
	postSubmitNotOfferedReason,
} from "@/lib/domain";

const parent = testUuid("post-submit-parent");
const menu = testUuid("post-submit-menu");
const form = testUuid("post-submit-form");

interface Shape {
	readonly multiSelect?: boolean;
	readonly formsReadSearch?: boolean;
	/** The search runs first without the forms reading it. */
	readonly searchFirst?: boolean;
	/** A case list menu entry, and the one form is its case list
	 *  registration form, so the menu holds no menu form. */
	readonly bareCaseList?: boolean;
	readonly offTheMenu?: boolean;
	readonly parent?: {
		readonly multiSelect?: boolean;
		readonly offTheMenu?: boolean;
	};
	readonly formType?: FormType;
	readonly postSubmit?: PostSubmitDestination;
	readonly links?: boolean;
}

function moduleOf(
	uuid: string,
	name: string,
	shape: { multiSelect?: boolean; offTheMenu?: boolean },
): Module {
	return {
		uuid: testUuid(uuid),
		id: name.toLowerCase(),
		name,
		caseType: "patient",
		caseListConfig: {
			columns: [],
			listColumnOrder: [],
			detailColumnOrder: [],
			searchInputs: [],
			...(shape.multiSelect && {
				selection: { kind: "multiple" as const, maximum: 5 },
			}),
		},
		...(shape.offTheMenu && { hiddenFromMenu: true as const }),
	};
}

/** A one-form document in the given menu shape, read only through the
 * fields the offered set reads. */
function docOf(
	shape: Shape,
): Pick<BlueprintDoc, "forms" | "modules" | "formOrder"> {
	const own: Module = {
		...moduleOf("post-submit-menu", "Visits", shape),
		...(shape.parent !== undefined && { parentModuleUuid: parent }),
		...(shape.bareCaseList && {
			caseListMenuItem: {},
			caseListRegistrationForm: {
				kind: "after-empty-search" as const,
				formUuid: form,
			},
		}),
		...(shape.formsReadSearch && {
			caseSearchConfig: { formsReadSearch: true as const },
		}),
		...(shape.searchFirst && { caseSearchConfig: {} }),
	};
	return {
		modules: {
			[menu]: own,
			...(shape.parent !== undefined && {
				[parent]: moduleOf("post-submit-parent", "Households", shape.parent),
			}),
		},
		formOrder: { [menu]: [form], ...(shape.parent && { [parent]: [] }) },
		forms: {
			[form]: {
				uuid: form,
				id: "visit",
				name: "Visit",
				type: shape.formType ?? "followup",
				...(shape.postSubmit !== undefined && { postSubmit: shape.postSubmit }),
				...(shape.links && {
					formLinks: [
						{
							uuid: testUuid("post-submit-link"),
							target: { type: "module" as const, moduleUuid: menu },
						},
					],
				}),
			},
		},
	};
}

const offered = (shape: Shape) =>
	postSubmitDestinationsOffered(docOf(shape), form);

describe("postSubmitDestinationsOffered", () => {
	it("offers every destination but parentMenu to a one-case top-level module", () => {
		expect(offered({})).toEqual([
			"app_home",
			"firstMenu",
			"module",
			"previous",
		]);
	});

	it("offers parentMenu under a parent that neither selects several nor is off the menu", () => {
		expect(offered({ parent: {} })).toEqual([
			"app_home",
			"firstMenu",
			"module",
			"parentMenu",
			"previous",
		]);
	});

	it("withholds previous from a module that selects several cases", () => {
		expect(offered({ multiSelect: true })).toEqual([
			"app_home",
			"firstMenu",
			"module",
		]);
	});

	it("withholds module, parentMenu and previous under a parent that selects several", () => {
		expect(offered({ parent: { multiSelect: true } })).toEqual([
			"app_home",
			"firstMenu",
		]);
	});

	it("withholds previous from a module whose forms read the search", () => {
		expect(offered({ formsReadSearch: true })).toEqual([
			"app_home",
			"firstMenu",
			"module",
		]);
	});

	it("offers previous in a module that searches first without its forms reading the search", () => {
		expect(offered({ searchFirst: true })).toEqual([
			"app_home",
			"firstMenu",
			"module",
			"previous",
		]);
	});

	it("withholds module from a bare case list", () => {
		expect(offered({ bareCaseList: true })).toEqual([
			"app_home",
			"firstMenu",
			"previous",
		]);
	});

	it("withholds module and previous from a module off the menu", () => {
		expect(offered({ offTheMenu: true, parent: {} })).toEqual([
			"app_home",
			"firstMenu",
			"parentMenu",
		]);
	});

	it("withholds parentMenu under a parent off the menu", () => {
		expect(offered({ parent: { offTheMenu: true } })).toEqual([
			"app_home",
			"firstMenu",
			"module",
			"previous",
		]);
	});
});

describe("otherwiseDestinationsOffered", () => {
	const otherwise = (shape: Shape) =>
		otherwiseDestinationsOffered(docOf({ ...shape, links: true }), form);

	it("is the offered set less app_home, which an absent otherwise means", () => {
		expect(otherwise({})).toEqual(["firstMenu", "module", "previous"]);
		expect(otherwise({ parent: {} })).toEqual([
			"firstMenu",
			"module",
			"parentMenu",
			"previous",
		]);
	});

	it.each<[string, Shape, PostSubmitNotOfferedReason, OtherwiseDestination[]]>([
		[
			"a menu that selects several",
			{ multiSelect: true, parent: {} },
			"menu-selects-several",
			["firstMenu", "module", "parentMenu"],
		],
		[
			"a parent that selects several",
			{ parent: { multiSelect: true } },
			"parent-selects-several",
			["firstMenu"],
		],
		[
			"a menu whose forms read the search",
			{ formsReadSearch: true },
			"menu-forms-read-search",
			["firstMenu", "module"],
		],
		[
			"a bare case list",
			{ bareCaseList: true, formType: "registration" },
			"menu-is-bare-case-list",
			["firstMenu", "previous"],
		],
		[
			"a menu with no parent",
			{},
			"no-parent-menu",
			["firstMenu", "module", "previous"],
		],
		[
			"a menu off the menu",
			{ offTheMenu: true, parent: {} },
			"menu-off-the-menu",
			["firstMenu", "parentMenu"],
		],
		[
			"a parent off the menu",
			{ parent: { offTheMenu: true } },
			"parent-off-the-menu",
			["firstMenu", "module", "previous"],
		],
	])(
		"under %s withholds what its reason withholds",
		(_label, shape, reason, expected) => {
			expect(otherwise(shape)).toEqual(expected);
			const withheld = OTHERWISE_DESTINATIONS.filter(
				(destination) => !expected.includes(destination),
			);
			expect(withheld.length).toBeGreaterThan(0);
			expect(
				withheld.map((destination) =>
					postSubmitNotOfferedReason(
						docOf({ ...shape, links: true }),
						form,
						destination,
					),
				),
			).toContain(reason);
		},
	);

	it("waives no reason for a form with destinations", () => {
		const doc = docOf({ multiSelect: true, links: true });
		expect(otherwiseDestinationsOffered(doc, form)).not.toContain("previous");
		expect(postSubmitNotOfferedReason(doc, form, "previous")).toBe(
			"menu-selects-several",
		);
		expect(postSubmitDestinationChoices(doc, form)).toEqual(
			postSubmitDestinationsOffered(doc, form),
		);
	});

	it("names the first reason that withholds a destination", () => {
		const doc = docOf({ multiSelect: true, formsReadSearch: true });
		expect(postSubmitNotOfferedReason(doc, form, "previous")).toBe(
			"menu-selects-several",
		);
		expect(postSubmitNotOfferedReason(doc, form, "module")).toBeUndefined();
	});

	it("leaves the admitted set and its link exemption out of the domain's exports", async () => {
		const domain = await import("@/lib/domain");
		expect(Object.keys(domain)).not.toContain("postSubmitDestinationsAdmitted");
		expect(Object.keys(domain)).toContain("otherwiseDestinationsOffered");
	});
});

describe("effectivePostSubmit", () => {
	it("is the after-submit of a form without destinations only", () => {
		expect(effectivePostSubmit(docOf({}), form)).toBe("previous");
		expect(
			effectivePostSubmit(docOf({ links: true, postSubmit: "module" }), form),
		).toBeUndefined();
	});
});

describe("defaultPostSubmit", () => {
	it("sends registration and survey home, and a case-loading form to the first offered of previous, module, firstMenu", () => {
		expect(defaultPostSubmit("registration", { multiSelect: true })).toBe(
			"app_home",
		);
		expect(defaultPostSubmit("survey")).toBe("app_home");
		expect(defaultPostSubmit("followup")).toBe("previous");
		expect(defaultPostSubmit("close", { formsReadSearch: true })).toBe(
			"module",
		);
		expect(defaultPostSubmit("followup", { multiSelect: true })).toBe("module");
		expect(defaultPostSubmit("followup", { parentMultiSelect: true })).toBe(
			"firstMenu",
		);
		expect(defaultPostSubmit("followup", { offTheMenu: true })).toBe(
			"firstMenu",
		);
	});

	it("is always offered, for every menu shape and form type", () => {
		const shape = fc.record(
			{
				multiSelect: fc.boolean(),
				formsReadSearch: fc.boolean(),
				searchFirst: fc.boolean(),
				bareCaseList: fc.boolean(),
				offTheMenu: fc.boolean(),
				parent: fc.option(
					fc.record({ multiSelect: fc.boolean(), offTheMenu: fc.boolean() }),
					{ nil: undefined },
				),
				formType: fc.constantFrom(...FORM_TYPES),
				links: fc.boolean(),
			},
			{ requiredKeys: ["formType"] },
		);
		fc.assert(
			fc.property(shape, (generated) => {
				// A bare case list's one form is its case list registration form,
				// which registers.
				const doc = docOf(
					generated.bareCaseList === true
						? { ...generated, formType: "registration" }
						: generated,
				);
				const destination = defaultPostSubmitOf(doc, form);
				expect(destination).toBeDefined();
				expect(postSubmitDestinationsOffered(doc, form)).toContain(destination);
			}),
		);
	});
});
