// Pins the creation contract: a freshly-added search field or display field
// must work immediately. Search gets a useful automatic seed; display creation
// builds from the exact property the author chose in the canvas.

import { describe, expect, it } from "vitest";
import type {
	CaseListConfig,
	CaseProperty,
	CaseType,
	SearchInputDef,
} from "@/lib/domain";
import { simpleSearchInputDef } from "@/lib/domain";
import { eq, literal, prop as propertyTerm } from "@/lib/domain/predicate";
import {
	labelFromProperty,
	representedColumnProperties,
	seedCalculatedColumn,
	seedColumn,
	seedColumnForProperty,
	seedSearchInput,
	uniqueInputName,
	unrepresentedColumnProperties,
	widgetTypeForProperty,
	xmlNameFromProperty,
} from "../seeds";
import { newUuid } from "../uuid";

function caseType(name: string, properties: readonly CaseProperty[]): CaseType {
	return { name, properties: [...properties] };
}

function prop(
	name: string,
	data_type?: CaseProperty["data_type"],
): CaseProperty {
	return { name, label: name, ...(data_type ? { data_type } : {}) };
}

function config(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return { columns: [], searchInputs: [], ...overrides };
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

	it.each([
		["name", "Case name"],
		["external-id", "External ID"],
		["date-opened", "Date opened"],
	])("uses the canonical label for legacy %s", (property, label) => {
		expect(labelFromProperty(property)).toBe(label);
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
		// Select-typed properties get `text`, not `select` — the wire
		// prompt carries no itemset slot, so `select` is gate-rejected
		// and can never be the widget an authoring path lands on.
		expect(widgetTypeForProperty(prop("status", "single_select"))).toBe("text");
		expect(widgetTypeForProperty(prop("tags", "multi_select"))).toBe("text");
		expect(widgetTypeForProperty(prop("age", "int"))).toBe("text");
	});
});

describe("seedSearchInput", () => {
	it("binds case_name first, fuzzy, with a human label", () => {
		const seed = seedSearchInput(config(), CLIENT);
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
		const first = seedSearchInput(config(), CLIENT);
		const second = seedSearchInput(
			config({ searchInputs: first ? [first] : [] }),
			CLIENT,
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
		);
		expect(seed && seed.kind === "simple" ? seed.property : "").toBe(
			"case_name",
		);
	});

	it("never seeds a second row from a CCHQ alias of an already-used value", () => {
		const withAliases = caseType("client", [
			prop("case_name"),
			prop("name"),
			prop("external_id"),
			prop("external-id"),
		]);
		const first = seedSearchInput(config(), withAliases);
		const second = seedSearchInput(
			config({ searchInputs: first ? [first] : [] }),
			withAliases,
		);
		expect(first && first.kind === "simple" ? first.property : "").toBe(
			"case_name",
		);
		expect(second && second.kind === "simple" ? second.property : "").toBe(
			"external_id",
		);
	});

	it.each([
		["name", "external_id"],
		["external-id", "case_name"],
		["date-opened", "case_name"],
	])("treats legacy search target %s as its canonical property when seeding", (legacy, expected) => {
		const properties = caseType("client", [
			prop("case_name"),
			prop("external_id"),
			prop("date_opened", "datetime"),
		]);
		const existing = simpleSearchInputDef(
			newUuid(),
			"legacy",
			"Legacy",
			"text",
			legacy,
		);
		const seed = seedSearchInput(
			config({ searchInputs: [existing] }),
			properties,
		);
		expect(seed && seed.kind === "simple" ? seed.property : "").toBe(expected);
	});

	it("seeds non-text widgets without a fuzzy mode", () => {
		const dateOnly = caseType("visit", [prop("visit_date", "date")]);
		const seed = seedSearchInput(config(), dateOnly);
		expect(seed?.type).toBe("date");
		expect(seed && "mode" in seed ? seed.mode : undefined).toBeUndefined();
	});

	it("seeds a text widget over select-typed properties — never `select`", () => {
		// The wire prompt carries no itemset slot, so a `select` search
		// input is gate-rejected outright — a seed that picked it would
		// turn the add affordance into a rejection toast.
		const selectOnly = caseType("referral", [
			prop("referral_status", "single_select"),
		]);
		const seed = seedSearchInput(config(), selectOnly);
		expect(seed?.type).toBe("text");
		// Fuzzy admits select-typed properties, so the forgiving default
		// still rides along.
		expect(seed && "mode" in seed ? seed.mode : undefined).toEqual({
			kind: "fuzzy",
		});
	});

	it("withholds fuzzy from text widgets over non-text properties", () => {
		// An int property renders as a text widget, but fuzzy is gated to
		// text-shaped data types — seeding it would land an invalid row.
		const intOnly = caseType("visit", [prop("visit_count", "int")]);
		const seed = seedSearchInput(config(), intOnly);
		expect(seed?.type).toBe("text");
		expect(seed && "mode" in seed ? seed.mode : undefined).toBeUndefined();
	});

	it("reuses a property rather than seeding unbound when all are taken", () => {
		const only = caseType("client", [prop("case_name")]);
		const first = seedSearchInput(config(), only);
		const second = seedSearchInput(
			config({ searchInputs: first ? [first] : [] }),
			only,
		);
		expect(second?.kind).toBe("simple");
		expect(second && second.kind === "simple" ? second.property : "").toBe(
			"case_name",
		);
		expect(second?.name).toBe("case_name_2");
	});

	it("returns undefined only for a propertyless case type", () => {
		expect(seedSearchInput(config(), caseType("empty", []))).toBeUndefined();
		expect(seedSearchInput(config(), undefined)).toBeUndefined();
	});
});

describe("seedColumn", () => {
	it("binds an unused property with a humanized header", () => {
		const seed = seedColumn(config(), CLIENT);
		expect(seed).toMatchObject({
			kind: "plain",
			field: "case_name",
			header: "Case name",
		});
	});

	it("date-formats date-shaped properties", () => {
		const dateOnly = caseType("visit", [prop("visit_date", "date")]);
		const seed = seedColumn(config(), dateOnly);
		expect(seed).toMatchObject({ kind: "date", field: "visit_date" });
	});

	it("threads visibility slots through", () => {
		const seed = seedColumn(config(), CLIENT, { visibleInList: false });
		expect(seed?.visibleInList).toBe(false);
	});

	it.each([
		["name", "external_id"],
		["external-id", "case_name"],
		["date-opened", "case_name"],
	])("treats legacy column field %s as its canonical property when seeding", (legacy, expected) => {
		const properties = caseType("client", [
			prop("case_name"),
			prop("external_id"),
			prop("date_opened", "datetime"),
		]);
		const seed = seedColumn(
			config({
				columns: [
					{
						uuid: newUuid(),
						kind: "plain",
						field: legacy,
						header: "Legacy",
					},
				],
			}),
			properties,
		);
		expect(seed && seed.kind !== "calculated" ? seed.field : "").toBe(expected);
	});

	it("returns undefined for a propertyless case type", () => {
		expect(seedColumn(config(), caseType("empty", []))).toBeUndefined();
	});
});

describe("chooser-first display fields", () => {
	it("builds the exact property selected by the author", () => {
		const selected = prop("visit_date", "datetime");
		expect(
			seedColumnForProperty(selected, { visibleInList: false }),
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
						field: "name",
						header: "Client",
					},
				],
			}),
			caseType("client", [
				prop("name"),
				prop("case_name"),
				prop("phone_number"),
			]),
		);
		expect(result.map((property) => property.name)).toEqual(["phone_number"]);
	});

	it("offers represented properties only through the second-view path", () => {
		const appCaseType = caseType("client", [
			prop("name"),
			prop("case_name"),
			prop("phone_number"),
		]);
		const current = config({
			columns: [
				{
					uuid: newUuid(),
					kind: "plain",
					field: "name",
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
