// Pins the smart-seed contract: a freshly-added search input or
// column must WORK the moment it lands — bound to a real property,
// labeled in human words, named legally and uniquely, widget matched
// to the property's data type, and (text search) matching forgivingly.

import { describe, expect, it } from "vitest";
import type {
	CaseListConfig,
	CaseProperty,
	CaseType,
	SearchInputDef,
} from "@/lib/domain";
import { simpleSearchInputDef } from "@/lib/domain";
import {
	labelFromProperty,
	seedColumn,
	seedSearchInput,
	uniqueInputName,
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

function config(
	overrides: Partial<Pick<CaseListConfig, "columns" | "searchInputs">> = {},
): CaseListConfig {
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
		expect(widgetTypeForProperty(prop("status", "single_select"))).toBe(
			"select",
		);
		expect(widgetTypeForProperty(prop("tags", "multi_select"))).toBe("select");
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

	it("seeds non-text widgets without a fuzzy mode", () => {
		const dateOnly = caseType("visit", [prop("visit_date", "date")]);
		const seed = seedSearchInput(config(), dateOnly);
		expect(seed?.type).toBe("date");
		expect(seed && "mode" in seed ? seed.mode : undefined).toBeUndefined();
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

	it("returns undefined for a propertyless case type", () => {
		expect(seedColumn(config(), caseType("empty", []))).toBeUndefined();
	});
});
