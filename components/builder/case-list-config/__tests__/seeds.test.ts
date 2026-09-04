// Pins the creation contract: a freshly-added search field or display field
// must work immediately. Search gets a useful automatic seed; display creation
// builds from the exact property the author chose in the canvas.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { mutationSchema } from "@/lib/doc/types";
import type {
	CaseListConfig,
	CaseProperty,
	CaseType,
	SearchInputDef,
} from "@/lib/domain";
import { simpleSearchInputDef } from "@/lib/domain";
import { eq, literal, prop as propertyTerm } from "@/lib/domain/predicate";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
import {
	labelFromProperty,
	representedColumnProperties,
	seedCalculatedColumn,
	seedColumn,
	seedColumnForProperty,
	seededColumnAddMutation,
	seedSearchInput,
	uniqueInputName,
	unrepresentedColumnProperties,
	widgetTypeForProperty,
	xmlNameFromProperty,
} from "../seeds";
import { newUuid } from "../uuid";

/** Every fixture property below is labeled with literal prose, so a
 *  context-free projection spells exactly what a document-aware one would. */
const projectProse = proseTemplateText;

function caseType(name: string, properties: readonly CaseProperty[]): CaseType {
	return { name, properties: [...properties] };
}

function prop(
	name: string,
	data_type?: CaseProperty["data_type"],
): CaseProperty {
	return { name, label: proseText(name), ...(data_type ? { data_type } : {}) };
}

function config(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return resolveCaseListConfig({ columns: [], searchInputs: [], ...overrides });
}

const CLIENT = caseType("client", [
	prop("case_name"),
	prop("age", "int"),
	prop("dob", "date"),
	prop("status", "single_select"),
]);

describe("labelFromProperty", () => {
	it("humanizes snake_case into a sentence-cased label", () => {
		expect(labelFromProperty("rash_onset_date")).toBe("Rash onset date");
		expect(labelFromProperty("case_name")).toBe("Case name");
	});
});

describe("xmlNameFromProperty", () => {
	it("passes through already-legal names", () => {
		expect(xmlNameFromProperty("case_name")).toBe("case_name");
	});
	it("replaces hyphens (legal in properties, not in names)", () => {
		expect(xmlNameFromProperty("follow-up-date")).toBe("follow_up_date");
	});
	it("prefixes names that would start with a digit", () => {
		expect(xmlNameFromProperty("2nd_visit")).toBe("_2nd_visit");
	});
});

describe("uniqueInputName", () => {
	const sibling = (name: string): SearchInputDef =>
		simpleSearchInputDef(newUuid(), name, name, "text", "case_name");
	it("returns the base when free", () => {
		expect(uniqueInputName("age", [sibling("case_name")])).toBe("age");
	});
	it("suffixes past every taken candidate", () => {
		expect(uniqueInputName("age", [sibling("age"), sibling("age_2")])).toBe(
			"age_3",
		);
	});
});

describe("widgetTypeForProperty", () => {
	it("matches the widget to the property's data type", () => {
		expect(widgetTypeForProperty(prop("case_name"))).toBe("text");
		expect(widgetTypeForProperty(prop("dob", "date"))).toBe("date");
		expect(widgetTypeForProperty(prop("ts", "datetime"))).toBe("date");
		// Select-typed properties get `text`, not `select`: the wire
		// prompt carries no itemset slot, so `select` is gate-rejected
		// and can never be the widget an authoring path lands on.
		expect(widgetTypeForProperty(prop("status", "single_select"))).toBe("text");
		expect(widgetTypeForProperty(prop("tags", "multi_select"))).toBe("text");
		expect(widgetTypeForProperty(prop("age", "int"))).toBe("text");
	});
});

describe("seedSearchInput", () => {
	it("binds case_name first, fuzzy, with a human label", () => {
		const seed = seedSearchInput(config(), CLIENT, projectProse);
		expect(seed).toMatchObject({
			kind: "simple",
			property: "case_name",
			label: "Case name",
			name: "case_name",
			type: "text",
			mode: { kind: "fuzzy" },
		});
	});

	it("moves to the next unused property on repeat adds", () => {
		const first = seedSearchInput(config(), CLIENT, projectProse);
		const second = seedSearchInput(
			config({ searchInputs: first ? [first] : [] }),
			CLIENT,
			projectProse,
		);
		expect(second?.kind).toBe("simple");
		expect(second && second.kind === "simple" ? second.property : "").not.toBe(
			"case_name",
		);
	});

	it("does not treat the always-on rule as occupying a search field", () => {
		const seed = seedSearchInput(
			config({
				filter: eq(propertyTerm("client", "case_name"), literal("Alice")),
			}),
			CLIENT,
			projectProse,
		);
		expect(seed && seed.kind === "simple" ? seed.property : "").toBe(
			"case_name",
		);
	});

	it("seeds non-text widgets without a fuzzy mode", () => {
		const dateOnly = caseType("visit", [prop("visit_date", "date")]);
		const seed = seedSearchInput(config(), dateOnly, projectProse);
		expect(seed?.type).toBe("date");
		expect(seed && "mode" in seed ? seed.mode : undefined).toBeUndefined();
	});

	it("seeds a text widget over select-typed properties, never `select`", () => {
		// A choice widget reads its options from a Project data table the
		// author owns, and Nova never creates Project data implicitly, so the
		// seed stays a text box; the inspector offers the choice widgets once a
		// table exists.
		const selectOnly = caseType("referral", [
			prop("referral_status", "single_select"),
		]);
		const seed = seedSearchInput(config(), selectOnly, projectProse);
		expect(seed?.type).toBe("text");
		// Fuzzy admits select-typed properties, so the forgiving default
		// still rides along.
		expect(seed && "mode" in seed ? seed.mode : undefined).toEqual({
			kind: "fuzzy",
		});
	});

	it("withholds fuzzy from text widgets over non-text properties", () => {
		// An int property renders as a text widget, but fuzzy is gated to
		// text-shaped data types: seeding it would land an invalid row.
		const intOnly = caseType("visit", [prop("visit_count", "int")]);
		const seed = seedSearchInput(config(), intOnly, projectProse);
		expect(seed?.type).toBe("text");
		expect(seed && "mode" in seed ? seed.mode : undefined).toBeUndefined();
	});

	it("reuses a property rather than seeding unbound when all are taken", () => {
		const only = caseType("client", [prop("case_name")]);
		const first = seedSearchInput(config(), only, projectProse);
		const second = seedSearchInput(
			config({ searchInputs: first ? [first] : [] }),
			only,
			projectProse,
		);
		expect(second?.kind).toBe("simple");
		expect(second && second.kind === "simple" ? second.property : "").toBe(
			"case_name",
		);
		expect(second?.name).toBe("case_name_2");
	});

	it("returns undefined only for a propertyless case type", () => {
		expect(
			seedSearchInput(config(), caseType("empty", []), projectProse),
		).toBeUndefined();
		expect(seedSearchInput(config(), undefined, projectProse)).toBeUndefined();
	});
});

describe("seedColumn", () => {
	it("binds an unused property with a humanized header", () => {
		const seed = seedColumn(config(), CLIENT, projectProse);
		expect(seed).toMatchObject({
			kind: "plain",
			field: "case_name",
			header: "Case name",
		});
	});

	it("date-formats date-shaped properties", () => {
		const dateOnly = caseType("visit", [prop("visit_date", "date")]);
		const seed = seedColumn(config(), dateOnly, projectProse);
		expect(seed).toMatchObject({ kind: "date", field: "visit_date" });
	});

	it("threads visibility slots through", () => {
		const seed = seedColumn(config(), CLIENT, projectProse, {
			visibleInList: false,
		});
		expect(seed?.visibleInList).toBe(false);
	});

	it("returns undefined for a propertyless case type", () => {
		expect(
			seedColumn(config(), caseType("empty", []), projectProse),
		).toBeUndefined();
	});
});

describe("chooser-first display fields", () => {
	it.each(["list", "detail"] as const)(
		"places a center-canvas %s add at the end of that screen",
		(surface) => {
			const moduleUuid = testUuid("10000000-0000-4000-8000-000000000000");
			const seed = seedColumnForProperty(prop("case_name"), projectProse);
			const mutation = seededColumnAddMutation(
				moduleUuid,
				config({
					columns: [
						{
							uuid: testUuid("20000000-0000-4000-8000-000000000000"),
							kind: "plain",
							field: "external_id",
							header: "External ID",
						},
					],
				}),
				surface,
				seed,
			);

			const existing = testUuid("20000000-0000-4000-8000-000000000000");
			// The add lands after the column already on that screen, and joins
			// the other screen at its end too: a column belongs to both from
			// birth whatever surface the author was looking at.
			expect(mutation.afterInList).toBe(existing);
			expect(mutation.afterInDetail).toBe(existing);
			expect(mutationSchema.safeParse(mutation).success).toBe(true);
		},
	);

	it("builds the exact property selected by the author", () => {
		const selected = prop("visit_date", "datetime");
		expect(
			seedColumnForProperty(selected, projectProse, { visibleInList: false }),
		).toMatchObject({
			kind: "date",
			field: "visit_date",
			header: "Visit date",
			visibleInList: false,
		});
	});

	it("builds a valid calculated starting point without guessing a property", () => {
		expect(seedCalculatedColumn({ visibleInDetail: false })).toMatchObject({
			kind: "calculated",
			header: "Calculated value",
			expression: { kind: "term", term: { kind: "literal", value: "" } },
			visibleInDetail: false,
		});
	});

	it("offers only properties without an existing display definition", () => {
		const result = unrepresentedColumnProperties(
			config({
				columns: [
					{
						uuid: newUuid(),
						kind: "plain",
						field: "case_name",
						header: "Client",
					},
				],
			}),
			caseType("client", [prop("case_name"), prop("phone_number")]),
		);
		expect(result.map((property) => property.name)).toEqual(["phone_number"]);
	});

	it("offers represented properties only through the second-view path", () => {
		const appCaseType = caseType("client", [
			prop("case_name"),
			prop("phone_number"),
		]);
		const current = config({
			columns: [
				{
					uuid: newUuid(),
					kind: "plain",
					field: "case_name",
					header: "Client",
				},
			],
		});
		expect(
			representedColumnProperties(current, appCaseType).map(
				(property) => property.name,
			),
		).toEqual(["case_name"]);
	});
});
