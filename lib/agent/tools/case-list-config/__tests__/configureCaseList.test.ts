import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { eq, literal, prop } from "@/lib/domain/expression";
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
