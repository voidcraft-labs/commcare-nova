import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { arith, eq, literal, prop, term } from "@/lib/domain/expression";
import {
	configureCaseListInputSchema,
	configureCaseListTool,
} from "../configureCaseList";
import {
	BASE_COLUMN,
	FORM_A,
	MOD_A,
	makeCaseListDoc,
	makeCaseListFixture,
} from "./fixtures";

const PHONE_COLUMN = testUuid("configure-case-list-phone-column");
const NAME_SEARCH = testUuid("configure-case-list-name-search");

describe("configureCaseList", () => {
	it("commits the Android lookup as one setting and leaves invalid drafts out", async () => {
		const h = makeCaseListFixture();
		const deviceLookup = {
			action: "org.nova.proof.CASE_LOOKUP",
			label: "Find a visit",
			extras: [
				{ name: "mode", value: "followup" },
				{
					name: "worker",
					expression: {
						kind: "term",
						term: { kind: "session-context", field: "username" },
					},
				},
				{
					name: "limit",
					expression: arith("+", term(literal(1)), term(literal(2))),
				},
			],
			responses: ["primary", "backup"],
		};
		const before = h.currentDoc().modules[MOD_A].caseListConfig;
		const added = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			deviceLookup,
		});
		expect(added.mutations).toEqual([
			{ kind: "setCaseListMeta", uuid: MOD_A, patch: { deviceLookup } },
		]);
		expect(h.currentDoc().modules[MOD_A].caseListConfig?.deviceLookup).toEqual(
			deviceLookup,
		);
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				deviceLookup: { ...deviceLookup, responses: [] },
			}).success,
		).toBe(false);
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				deviceLookup: {
					...deviceLookup,
					extras: [
						{
							name: "unsupported",
							expression: {
								kind: "term",
								term: { kind: "session-context", field: "deviceid" },
							},
						},
					],
				},
			}).success,
		).toBe(false);
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				deviceLookup: {
					...deviceLookup,
					extras: [
						{
							name: "limit",
							expression: arith(
								"+",
								term(literal(2_147_483_647)),
								term(literal(1)),
							),
						},
					],
				},
			}).success,
		).toBe(false);
		await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			deviceLookup: null,
		});
		expect(h.currentDoc().modules[MOD_A].caseListConfig).toEqual(before);
	});

	it("keeps an independent order calculation out of Results and preserves its identity across edits", async () => {
		const h = makeCaseListFixture();
		const original = h.currentDoc().modules[MOD_A].caseListConfig;
		const expression = term(prop("patient", "case_name"));
		const first = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			calculatedSorts: [
				{
					expression,
					priority: 0,
					direction: "asc",
					comparator: "integer",
					blanks: "last",
					label: "Visit number",
				},
			],
		});
		if ("error" in first.result) throw new Error(first.result.error);
		const uuid = first.result.calculatedSortUuids?.[0];
		if (!uuid) throw new Error("Missing calculation identity");
		expect(first.mutations.map((m) => m.kind)).toEqual(["addCalculatedSort"]);
		expect(h.currentDoc().modules[MOD_A].caseListConfig?.columns).toEqual(
			original?.columns,
		);

		const invalid = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			removeCalculatedSorts: [BASE_COLUMN],
			calculatedSorts: [
				{
					sortUuid: uuid,
					expression,
					priority: 0,
					direction: "desc",
					label: "Changed",
				},
			],
		});
		expect(invalid.result).toHaveProperty("error");
		expect(
			h.currentDoc().modules[MOD_A].caseListConfig?.calculatedSorts?.[0]?.label,
		).toBe("Visit number");

		const changed = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			calculatedSorts: [
				{
					sortUuid: uuid,
					expression,
					priority: 0,
					direction: "desc",
					blanks: "last",
					label: "Latest visit",
				},
			],
		});
		if ("error" in changed.result) throw new Error(changed.result.error);
		expect(changed.result.calculatedSortUuids).toEqual([uuid]);
		expect(
			h.currentDoc().modules[MOD_A].caseListConfig?.calculatedSorts,
		).toEqual([
			{
				uuid,
				expression,
				priority: 0,
				direction: "desc",
				label: "Latest visit",
			},
		]);
		const removed = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			removeCalculatedSorts: [uuid],
		});
		if ("error" in removed.result) throw new Error(removed.result.error);
		expect(h.currentDoc().modules[MOD_A].caseListConfig).toEqual(original);
	});

	it("sets the list's own words, and takes the ordinary words or null as none", async () => {
		const h = makeCaseListFixture();
		const set = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			emptyText: " No patients yet ",
			selectButtonText: "Visit these patients",
		});
		if ("error" in set.result) throw new Error(set.result.error);
		expect(set.mutations).toEqual([
			{
				kind: "setCaseListMeta",
				uuid: MOD_A,
				patch: {
					emptyText: "No patients yet",
					selectButtonText: "Visit these patients",
				},
			},
		]);
		const list = () => h.currentDoc().modules[MOD_A].caseListConfig;
		expect(list()?.emptyText).toBe("No patients yet");

		const cleared = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			emptyText: "List is empty.",
			selectButtonText: null,
		});
		if ("error" in cleared.result) throw new Error(cleared.result.error);
		expect(list()?.emptyText).toBeUndefined();
		expect(list()?.selectButtonText).toBeUndefined();
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				emptyText: "  ",
			}).success,
		).toBe(false);
	});

	it("turns faster loading on for a calculation's choice, and off with every choice in one batch", async () => {
		const h = makeCaseListFixture();
		const list = () => h.currentDoc().modules[MOD_A].caseListConfig;
		const added = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			optimizations: true,
			columns: [
				{
					kind: "calculated",
					header: "Visits",
					expression: term(prop("patient", "case_name")),
					loadBehavior: "cache",
				},
			],
		});
		if ("error" in added.result) throw new Error(added.result.error);
		expect(list()?.optimizations).toBe(true);
		expect(
			list()?.columns.map((one) =>
				"loadBehavior" in one ? one.loadBehavior : undefined,
			),
		).toEqual([undefined, "cache"]);

		const off = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			optimizations: false,
		});
		if ("error" in off.result) throw new Error(off.result.error);
		expect(list()?.optimizations).toBeUndefined();
		expect(list()?.columns.some((one) => "loadBehavior" in one)).toBe(false);
	});

	it("commits Search headings, moves their fields, and removes the grouping without removing answers", async () => {
		const h = makeCaseListFixture();
		const group = "87a78526-307d-4739-906f-b65bae608863";
		const other = "e464ccdc-b2d2-4abf-891b-f687232c3e6a";
		const result = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			searchInputs: [
				{
					searchInputUuid: NAME_SEARCH,
					kind: "simple",
					name: "patient_name",
					label: "Name",
					type: "text",
					property: "case_name",
				},
			],
			searchGroups: [
				{
					groupUuid: group,
					label: "Personal details",
					searchInputUuids: [NAME_SEARCH],
				},
				{ groupUuid: other, label: "Other details", searchInputUuids: [] },
			],
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.searchGroupUuids).toEqual([group, other]);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		const layout = () => h.currentDoc().modules[MOD_A].caseListConfig;
		expect(layout()?.searchInputs[0]?.group).toBe(group);
		const moved = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			searchGroups: [
				{
					groupUuid: other,
					label: "Other details",
					searchInputUuids: [NAME_SEARCH],
				},
			],
		});
		if ("error" in moved.result) throw new Error(moved.result.error);
		expect(layout()?.searchInputs[0]?.group).toBe(other);
		expect(layout()?.searchInputGroups).toEqual([
			{ uuid: other, label: "Other details" },
		]);
		const flat = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			searchGroups: [],
		});
		if ("error" in flat.result) throw new Error(flat.result.error);
		expect(layout()?.searchInputGroups).toBeUndefined();
		expect(layout()?.searchInputs[0]).toMatchObject({
			uuid: NAME_SEARCH,
			name: "patient_name",
		});
		expect(layout()?.searchInputs[0]?.group).toBeUndefined();
	});

	it("lands one coherent configuration as granular mutations", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			columns: [
				{
					columnUuid: PHONE_COLUMN,
					kind: "phone",
					field: "phone",
					header: "Phone",
				},
			],
			searchInputs: [
				{
					searchInputUuid: NAME_SEARCH,
					kind: "simple",
					name: "patient_name",
					label: "Patient name",
					type: "text",
					property: "case_name",
				},
			],
			filter: eq(prop("patient", "case_name"), literal("Ada")),
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Search by the name on the record.",
			searchButtonDisplayCondition: null,
			resultsColumnOrder: [PHONE_COLUMN, BASE_COLUMN],
			detailsColumnOrder: [BASE_COLUMN, PHONE_COLUMN],
			searchInputOrder: [NAME_SEARCH],
		});

		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.columnUuids).toEqual([PHONE_COLUMN]);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(result.result.searchInputUuids).toEqual([NAME_SEARCH]);

		expect(result.result.summary).toEqual({ location: "Patient" });

		const config = h.currentDoc().modules[MOD_A].caseListConfig;
		expect(config?.columns.map((column) => column.uuid)).toEqual([
			BASE_COLUMN,
			PHONE_COLUMN,
		]);
		expect(config?.listColumnOrder).toEqual([PHONE_COLUMN, BASE_COLUMN]);
		expect(config?.detailColumnOrder).toEqual([BASE_COLUMN, PHONE_COLUMN]);
		expect(config?.searchInputs.map((input) => input.uuid)).toEqual([
			NAME_SEARCH,
		]);
		expect(config?.filter).toEqual(
			eq(prop("patient", "case_name"), literal("Ada")),
		);
		expect(h.currentDoc().modules[MOD_A].caseSearchConfig).toMatchObject({
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Search by the name on the record.",
		});
		expect(result.mutations.map((mutation) => mutation.kind)).toEqual(
			expect.arrayContaining([
				"addColumn",
				"addSearchInput",
				"setCaseListMeta",
				"moveColumn",
				"updateModule",
			]),
		);
	});

	it("stores blanks only where it differs from the direction's own, and a search with no title", async () => {
		const h = makeCaseListFixture();
		const first = testUuid("configure-case-list-blanks-first");
		const last = testUuid("configure-case-list-blanks-last");
		const result = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			columns: [
				{
					columnUuid: first,
					kind: "plain",
					field: "phone",
					header: "Phone",
					// The direction's own side: stored as its absence, not refused.
					sort: { direction: "asc", priority: 0, blanks: "first" },
				},
				{
					columnUuid: last,
					kind: "plain",
					field: "case_name",
					header: "Name again",
					sort: { direction: "asc", priority: 1, blanks: "last" },
				},
			],
			searchScreenTitle: { kind: "none" },
			searchScreenSubtitle: null,
			searchButtonDisplayCondition: null,
		});

		if ("error" in result.result) throw new Error(result.result.error);
		const columns = h.currentDoc().modules[MOD_A].caseListConfig?.columns;
		expect(columns?.find((column) => column.uuid === first)?.sort).toEqual({
			direction: "asc",
			priority: 0,
		});
		expect(columns?.find((column) => column.uuid === last)?.sort).toEqual({
			direction: "asc",
			priority: 1,
			blanks: "last",
		});
		expect(h.currentDoc().modules[MOD_A].caseSearchConfig).toMatchObject({
			searchScreenTitle: { kind: "none" },
		});
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				searchScreenTitle: { kind: "untitled" },
			}).success,
		).toBe(false);
	});

	it("sets and clears Forms read the search as the only requested resource", async () => {
		const doc = makeCaseListDoc();
		const form = doc.forms[FORM_A];
		if (!form) throw new Error("Missing form");
		form.type = "followup";
		doc.modules[MOD_A].caseSearchConfig = {
			searchScreenTitle: "Find a patient",
		};
		// Forms that read the search run in Web Apps alone.
		doc.appSettings = { ...doc.appSettings, runsOnlyOn: "web-apps" };
		const h = makeCaseListFixture(doc);
		const enabled = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			formsReadSearch: true,
		});
		expect(enabled.result).not.toHaveProperty("error");
		expect(enabled.result).toHaveProperty("ok", true);
		expect(h.currentDoc().modules[MOD_A].caseSearchConfig).toEqual({
			searchScreenTitle: "Find a patient",
			formsReadSearch: true,
		});
		const disabled = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			formsReadSearch: null,
		});
		expect(disabled.result).not.toHaveProperty("error");
		expect(disabled.result).toHaveProperty("ok", true);
		// Turning Forms read the search off preserves the after-submit
		// destination the worker saw while it was on; the reducer pins that
		// default explicitly.
		expect(toPersistableDoc(h.currentDoc())).toEqual(
			toPersistableDoc({
				...doc,
				forms: {
					...doc.forms,
					[FORM_A]: { ...doc.forms[FORM_A], postSubmit: "module" },
				},
			}),
		);
		expect(h.recordMutations).toHaveBeenCalledTimes(2);
	});

	it("stores each workflow, with search first as the absent value", async () => {
		const cases = [
			["skipToResults", "web-apps", "skipToResults"],
			["listFirst", "android", "listFirst"],
			["searchFirst", "web-apps", undefined],
		] as const;
		for (const [searchWorkflow, runsOnlyOn, stored] of cases) {
			const doc = makeCaseListDoc();
			const form = doc.forms[FORM_A];
			if (!form) throw new Error("Missing form");
			form.type = "followup";
			doc.modules[MOD_A].caseSearchConfig = {
				searchScreenTitle: "Find a patient",
				workflow: "skipToResults",
			};
			doc.appSettings = { ...doc.appSettings, runsOnlyOn };
			const h = makeCaseListFixture(doc);
			const result = await h.runTool(configureCaseListTool, {
				moduleUuid: MOD_A,
				searchWorkflow,
			});
			expect(result.result).toHaveProperty("ok", true);
			expect(h.currentDoc().modules[MOD_A].caseSearchConfig).toEqual({
				searchScreenTitle: "Find a patient",
				...(stored !== undefined && { workflow: stored }),
			});
		}
	});

	it("refuses a menu that opens on its case list while its forms read the search", async () => {
		const doc = makeCaseListDoc();
		const form = doc.forms[FORM_A];
		if (!form) throw new Error("Missing form");
		form.type = "followup";
		doc.modules[MOD_A].caseSearchConfig = { formsReadSearch: true };
		doc.appSettings = { ...doc.appSettings, runsOnlyOn: "web-apps" };
		const h = makeCaseListFixture(doc);
		for (const input of [
			{ searchWorkflow: "listFirst", formsReadSearch: true },
			{ searchWorkflow: "listFirst" },
		] as const) {
			const result = await h.runTool(configureCaseListTool, {
				moduleUuid: MOD_A,
				...input,
			});
			expect(result.result).toHaveProperty("error");
			expect(result.mutations).toEqual([]);
		}
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("refuses the retired searchFirst key at the schema", () => {
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				searchFirst: true,
			}).success,
		).toBe(false);
	});

	it("uses the targeted display tool's root field shape", () => {
		const display = {
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "Search by the name on the record.",
			searchButtonDisplayCondition: null,
		};
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				...display,
			}).success,
		).toBe(true);
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				searchDisplay: display,
			}).success,
		).toBe(false);
		expect(
			configureCaseListInputSchema.safeParse({
				moduleUuid: MOD_A,
				searchScreenTitle: "Find a patient",
			}).success,
		).toBe(false);
	});

	it("returns no mutations when a requested order is not complete", async () => {
		const h = makeCaseListFixture();
		const before = structuredClone(h.currentDoc());
		const result = await h.runTool(configureCaseListTool, {
			moduleUuid: MOD_A,
			columns: [
				{
					columnUuid: PHONE_COLUMN,
					kind: "phone",
					field: "phone",
					header: "Phone",
				},
			],
			resultsColumnOrder: [PHONE_COLUMN],
		});

		expect(result.mutations).toEqual([]);
		expect(h.currentDoc()).toEqual(before);
		expect(h.recordMutations).not.toHaveBeenCalled();
		if (!("error" in result.result)) throw new Error("expected error");
		expect(result.result.error).toContain("2 entries");
	});
});
