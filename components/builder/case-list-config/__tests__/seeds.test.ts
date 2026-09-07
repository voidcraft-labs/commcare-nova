import { describe, expect, it } from "vitest";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import type { CaseProperty, CaseType } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import { proseTemplateText, proseText } from "@/lib/domain/prose";
import {
	pickSeedProperty,
	representedColumnProperties,
	seedCalculatedColumn,
	seedColumnForProperty,
	seededColumnAddMutation,
	seedHiddenSearchInput,
	seedSearchInputForProperty,
	unrepresentedColumnProperties,
	xmlNameFromProperty,
} from "../seeds";
import { admittedWorkspace, commitWorkspace } from "./admittedWorkspace";

const properties: CaseProperty[] = [
	{ name: "case_name", label: proseText("Name"), data_type: "text" },
	{ name: "visit_count", label: proseText("Visits"), data_type: "int" },
	{ name: "visit_date", label: proseText("Date of visit"), data_type: "date" },
	{ name: "opened_at", label: proseText("Opened at"), data_type: "datetime" },
	{
		name: "referral_status",
		label: proseText("Status"),
		data_type: "single_select",
	},
	{ name: "tags", label: proseText("Tags"), data_type: "multi_select" },
];
const patient: CaseType = { name: "patient", properties };

describe("explicit case-list creation", () => {
	it.each([
		["case_name", "text", "fuzzy"],
		["visit_count", "text", undefined],
		["visit_date", "date", undefined],
		["opened_at", "date", undefined],
		["referral_status", "text", "fuzzy"],
		["tags", "text", "fuzzy"],
	] as const)(
		"commits the chosen %s search field with complete widget and matching defaults",
		(name, type, mode) => {
			const { doc, moduleUuid, config } = admittedWorkspace([patient]);
			const property = properties.find((p) => p.name === name);
			if (!property) throw new Error("missing chosen property");
			const seed = seedSearchInputForProperty(
				config,
				property,
				proseTemplateText,
			);
			const next = commitWorkspace(doc, [
				{ kind: "addSearchInput", moduleUuid, searchInput: seed },
			]);
			expect(next.modules[moduleUuid].caseListConfig?.searchInputs).toEqual([
				seed,
			]);
			expect(seed).toMatchObject({
				property: name,
				type,
				label: proseTemplateText(property.label),
			});
			expect(seed.mode?.kind).toBe(mode);
		},
	);
	it("keeps the selected property when it already appears in both Search and Cases available", () => {
		const initial = admittedWorkspace([patient]);
		const first = seedSearchInputForProperty(
			initial.config,
			properties[0],
			proseTemplateText,
		);
		const withFirst = commitWorkspace(initial.doc, [
			{
				kind: "addSearchInput",
				moduleUuid: initial.moduleUuid,
				searchInput: first,
			},
			{
				kind: "setCaseListMeta",
				uuid: initial.moduleUuid,
				patch: { filter: eq(prop("patient", "case_name"), literal("Alice")) },
			},
		]);
		const config = withFirst.modules[initial.moduleUuid].caseListConfig;
		if (!config) throw new Error("missing config");
		const second = seedSearchInputForProperty(
			config,
			properties[0],
			proseTemplateText,
		);
		const next = commitWorkspace(withFirst, [
			{
				kind: "addSearchInput",
				moduleUuid: initial.moduleUuid,
				searchInput: second,
			},
		]);
		expect(second).toMatchObject({
			property: "case_name",
			name: "case_name_2",
		});
		expect(
			next.modules[initial.moduleUuid].caseListConfig?.searchInputs.map(
				(x) => x.uuid,
			),
		).toEqual([first.uuid, second.uuid]);
	});
	it("creates hidden search times with independent identities and collision-free names", () => {
		const { doc, moduleUuid, config } = admittedWorkspace([patient]);
		const first = seedHiddenSearchInput(config);
		const next = commitWorkspace(doc, [
			{ kind: "addSearchInput", moduleUuid, searchInput: first },
		]);
		const current = next.modules[moduleUuid].caseListConfig;
		if (!current) throw new Error("missing config");
		const second = seedHiddenSearchInput(current);
		const final = commitWorkspace(next, [
			{ kind: "addSearchInput", moduleUuid, searchInput: second },
		]);
		expect(first).toMatchObject({
			kind: "hidden",
			name: "search_time",
			value: { kind: "now" },
		});
		expect(second.name).toBe("search_time_2");
		expect(second.uuid).not.toBe(first.uuid);
		expect(final.modules[moduleUuid].caseListConfig?.searchInputs).toHaveLength(
			2,
		);
	});
	it.each(["list", "detail"] as const)(
		"adds a chosen date at the end of each independent sequence from %s",
		(surface) => {
			const config = caseListConfig([
				{ field: "case_name", header: "Name" },
				{ field: "visit_count", header: "Visits" },
			]);
			config.detailColumnOrder.reverse();
			const { doc, moduleUuid } = admittedWorkspace([patient], config);
			const seed = seedColumnForProperty(
				properties[2],
				proseTemplateText,
				surface === "list"
					? { visibleInDetail: false }
					: { visibleInList: false },
			);
			const next = commitWorkspace(doc, [
				seededColumnAddMutation(moduleUuid, config, surface, seed),
			]);
			const stored = next.modules[moduleUuid].caseListConfig;
			expect(seed).toMatchObject({
				kind: "date",
				field: "visit_date",
				header: "Date of visit",
				pattern: "%Y-%m-%d",
			});
			expect(stored?.listColumnOrder).toEqual([
				...config.listColumnOrder,
				seed.uuid,
			]);
			expect(stored?.detailColumnOrder).toEqual([
				...config.detailColumnOrder,
				seed.uuid,
			]);
		},
	);
	it("admits an explicit calculated value without selecting a case property", () => {
		const { doc, moduleUuid, config } = admittedWorkspace([patient]);
		const seed = seedCalculatedColumn({ visibleInDetail: false });
		const next = commitWorkspace(doc, [
			seededColumnAddMutation(moduleUuid, config, "list", seed),
		]);
		expect(
			next.modules[moduleUuid].caseListConfig?.columns.at(-1),
		).toMatchObject({
			kind: "calculated",
			expression: { kind: "term", term: { kind: "literal", value: "" } },
			visibleInDetail: false,
		});
	});
	it("keeps existing hidden definitions represented and leaves unrelated properties available", () => {
		const config = caseListConfig([
			{ field: "case_name", header: "Name" },
			{ field: "visit_date", header: "Hidden date" },
		]);
		config.columns[1] = {
			...config.columns[1],
			visibleInList: false,
			visibleInDetail: false,
		};
		const { config: current } = admittedWorkspace([patient], config);
		expect(
			representedColumnProperties(current, patient).map((p) => p.name),
		).toEqual(["case_name", "visit_date"]);
		expect(
			unrepresentedColumnProperties(current, patient).map((p) => p.name),
		).toEqual(["visit_count", "opened_at", "referral_status", "tags"]);
	});
});
describe("custom-to-standard recovery fallback", () => {
	it("chooses unused name then unused information, and never invents an undeclared property", () => {
		expect(pickSeedProperty(patient, new Set())?.name).toBe("case_name");
		expect(pickSeedProperty(patient, new Set(["case_name"]))?.name).toBe(
			"visit_count",
		);
		expect(
			pickSeedProperty(patient, new Set(properties.map((p) => p.name)))?.name,
		).toBe("case_name");
		expect(
			pickSeedProperty({ name: "empty", properties: [] }, new Set()),
		).toBeUndefined();
	});
	it.each([
		["follow-up-date", "follow_up_date"],
		["2nd_visit", "_2nd_visit"],
		["", "_"],
	])(
		"normalizes lower-boundary name %s without assuming it is an admitted property",
		(source, expected) => {
			expect(xmlNameFromProperty(source)).toBe(expected);
		},
	);
});
