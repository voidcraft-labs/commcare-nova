/**
 * The after-submit offered set and default (`lib/domain/postSubmit.ts`,
 * `forms.ts::defaultPostSubmit`): which destinations each menu shape offers
 * a form, the exemption a form with links has, and that the default is
 * always offered. What each destination does on a device is the proof
 * lane's; these prove Nova's own reading of the shapes.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	defaultPostSubmit,
	defaultPostSubmitOf,
	FORM_TYPES,
	type FormType,
	type Module,
	type PostSubmitDestination,
	postSubmitDestinationChoices,
	postSubmitDestinationsAdmitted,
	postSubmitDestinationsOffered,
	postSubmitNotOfferedReason,
} from "@/lib/domain";

const parent = testUuid("post-submit-parent");
const menu = testUuid("post-submit-menu");
const form = testUuid("post-submit-form");

interface Shape {
	readonly multiSelect?: boolean;
	readonly searchFirst?: boolean;
	readonly caseListOnly?: boolean;
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
		...(shape.caseListOnly && { caseListOnly: true }),
		...(shape.searchFirst && { caseSearchConfig: { searchFirst: true } }),
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

	it("withholds previous from a module that opens on Search", () => {
		expect(offered({ searchFirst: true })).toEqual([
			"app_home",
			"firstMenu",
			"module",
		]);
	});

	it("withholds module from a bare case list", () => {
		expect(offered({ caseListOnly: true })).toEqual([
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

describe("postSubmitDestinationsAdmitted", () => {
	it("admits a fallback beside links whatever the several-case reasons withhold", () => {
		const doc = docOf({
			multiSelect: true,
			links: true,
			postSubmit: "previous",
		});
		expect(postSubmitDestinationsAdmitted(doc, form)).toContain("previous");
		expect(postSubmitNotOfferedReason(doc, form, "previous")).toBeUndefined();
		expect(postSubmitDestinationChoices(doc, form)).toEqual([
			"app_home",
			"firstMenu",
			"module",
			"previous",
		]);
	});

	it("applies every other reason to a form with links", () => {
		const doc = docOf({ offTheMenu: true, links: true });
		expect(postSubmitDestinationsAdmitted(doc, form)).toEqual([
			"app_home",
			"firstMenu",
		]);
		expect(postSubmitNotOfferedReason(doc, form, "parentMenu")).toBe(
			"no-parent-menu",
		);
	});

	it("names the first reason that withholds a destination", () => {
		const doc = docOf({ multiSelect: true, searchFirst: true });
		expect(postSubmitNotOfferedReason(doc, form, "previous")).toBe(
			"menu-selects-several",
		);
		expect(postSubmitNotOfferedReason(doc, form, "module")).toBeUndefined();
	});
});

describe("defaultPostSubmit", () => {
	it("sends registration and survey home, and a case-loading form to the first offered of previous, module, firstMenu", () => {
		expect(defaultPostSubmit("registration", { multiSelect: true })).toBe(
			"app_home",
		);
		expect(defaultPostSubmit("survey")).toBe("app_home");
		expect(defaultPostSubmit("followup")).toBe("previous");
		expect(defaultPostSubmit("close", { searchFirst: true })).toBe("module");
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
				searchFirst: fc.boolean(),
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
				const doc = docOf(generated);
				const destination = defaultPostSubmitOf(doc, form);
				expect(destination).toBeDefined();
				expect(postSubmitDestinationsOffered(doc, form)).toContain(destination);
			}),
		);
	});
});
