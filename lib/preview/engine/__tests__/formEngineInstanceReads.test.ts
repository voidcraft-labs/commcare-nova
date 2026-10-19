/**
 * Form logic and after-submit links reading every secondary instance a form
 * can read, through the production engine and link evaluator: each read is
 * printed by the device emitter at the Preview target and evaluated over the
 * instance Preview supplies, so a print and its instance that disagree (an
 * id, a path, an element name) show here as a wrong value.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	INSTANCE_READS,
	instanceReadFixture,
} from "@/lib/commcare/__tests__/instanceReadFixture";
import { LOCATION_LEVELS } from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import type { BlueprintDoc } from "@/lib/domain";
import type { LocationFixtureRow } from "@/lib/organization/footprint";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import { buildEngineInput } from "../engineInput";
import { entrySessionData } from "../entrySessionData";
import { FormEngine, type FormEngineAsyncEvaluator } from "../formEngine";
import { evaluateFormLinks } from "../formLinkEvaluation";
import { previewSessionValues } from "../identity";
import {
	formLogicLookupsCovered,
	previewLookupData,
} from "../lookupEvaluation";
import type {
	CaseDatabaseSnapshot,
	SearchResultRow,
	SearchResultsSnapshot,
} from "../xpathInstances";

const [region, district, clinic] = LOCATION_LEVELS;

const central: LocationFixtureRow = {
	id: "place-central",
	levelUuid: clinic.uuid,
	siteCode: "central",
	name: "Central",
	externalId: null,
	latitude: null,
	longitude: null,
	values: {},
	lineage: { [district.uuid]: "place-east", [region.uuid]: "place-top" },
};

function fixture() {
	const built = instanceReadFixture();
	const lookup = previewLookupData({
		projectRevision: "1",
		definitions: [built.table],
		rowsByTable: new Map([[built.table.id, built.rows]]),
	});
	return { ...built, lookup };
}

function engineFor(
	doc: BlueprintDoc,
	formUuid: string,
	options: {
		readonly lookup?: ReturnType<typeof previewLookupData>;
		readonly cases?: CaseDatabaseSnapshot;
		readonly runtime?: ConstructorParameters<typeof FormEngine>[6];
	} = {},
) {
	const input = buildEngineInput(doc, formUuid as never, null);
	if (input === undefined) throw new Error("The fixture form is missing.");
	return new FormEngine(
		input,
		"patient",
		undefined,
		null,
		options.lookup ?? null,
		options.cases ?? { rows: [], indices: [] },
		options.runtime ?? {},
	);
}

function searchResult(caseId: string): SearchResultRow {
	return {
		case_id: caseId,
		case_type: "patient",
		owner_id: "worker-1",
		case_name: caseId,
		opened_on: "2026-08-01T00:00:00.000Z",
		modified_on: "2026-08-02T00:00:00.000Z",
		external_id: null,
		properties: { district: "north" },
		indices: [],
	};
}

const runtimes: XPathRuntime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

describe("form logic reading secondary instances", () => {
	const visitCases: CaseDatabaseSnapshot = {
		rows: [],
		indices: [],
		locations: [central],
	};

	it("reads a table's first matching row, its rows and a column of them", () => {
		const { doc, lookup } = fixture();
		const engine = engineFor(doc, INSTANCE_READS.visitForm, {
			lookup,
			cases: visitCases,
		});
		expect(engine.getState("/data/region_label").value).toBe("Northland");
		expect(engine.getState("/data/region_count").value).toBe("2");
		expect(engine.getState("/data/region_labels").value).toBe(
			"Northland Southland",
		);
		expect(engine.lookupDataCoversForm()).toBe(true);
	});

	it("holds an entry whose logic reads a table until a snapshot covers it", () => {
		const { doc, lookup } = fixture();
		expect(
			formLogicLookupsCovered(doc, INSTANCE_READS.visitForm, undefined),
		).toBe(false);
		expect(formLogicLookupsCovered(doc, INSTANCE_READS.visitForm, lookup)).toBe(
			true,
		);
		// A snapshot taken before the table existed covers nothing of it.
		const other = previewLookupData({
			projectRevision: "1",
			definitions: [],
			rowsByTable: new Map(),
		});
		expect(formLogicLookupsCovered(doc, INSTANCE_READS.visitForm, other)).toBe(
			false,
		);
		// A form reading no table never waits.
		expect(
			formLogicLookupsCovered(doc, INSTANCE_READS.batchForm, undefined),
		).toBe(true);
	});

	it("reads the worker's places by level, with their ancestors' ids", () => {
		const { doc, lookup } = fixture();
		const engine = engineFor(doc, INSTANCE_READS.visitForm, {
			lookup,
			cases: visitCases,
		});
		expect(engine.getState("/data/clinic_name").value).toBe("Central");
		expect(engine.getState("/data/district_of_clinics").value).toBe(
			"place-east",
		);
	});

	it("reads a question's wording and a written choice's label", () => {
		const { doc, lookup } = fixture();
		const engine = engineFor(doc, INSTANCE_READS.visitForm, {
			lookup,
			cases: visitCases,
		});
		expect(engine.getState("/data/color_text").value).toBe("Color");
		expect(engine.getState("/data/color_label").value).toBe("");
		engine.setValue("/data/color", "blue");
		expect(engine.getState("/data/color_label").value).toBe("Blue");
	});

	it("reads the cases chosen for a several-case form, in the order chosen", () => {
		const { doc } = fixture();
		const session = entrySessionData(doc, INSTANCE_READS.batchForm, {
			appId: undefined,
			entryKey: "entry-batch",
			boundCases: [{ caseId: "p-3" }, { caseId: "p-1" }, { caseId: "p-2" }],
			menuSelections: {},
			caseDatabase: null,
			identity: null,
		});
		expect(Object.values(session.selectedCases)).toEqual([
			["p-3", "p-1", "p-2"],
		]);
		const engine = engineFor(doc, INSTANCE_READS.batchForm, {
			runtime: {
				sessionData: session.data,
				selectedCases: session.selectedCases,
			},
		});
		expect(engine.getState("/data/chosen").value).toBe("3");
	});

	it("reads what the entry's search found", () => {
		const { doc } = fixture();
		const searchResults: SearchResultsSnapshot = {
			rows: [searchResult("p-1"), searchResult("p-2"), searchResult("p-3")],
			totalMatches: 3,
		};
		const session = entrySessionData(doc, INSTANCE_READS.searchForm, {
			appId: undefined,
			entryKey: "entry-search",
			boundCases: [{ caseId: "p-1" }],
			menuSelections: {},
			searchResults,
			caseDatabase: null,
			identity: null,
		});
		expect(session.searchResults).toBe(searchResults);
		const engine = engineFor(doc, INSTANCE_READS.searchForm, {
			runtime: {
				sessionData: session.data,
				...(session.searchResults === undefined
					? {}
					: { searchResults: session.searchResults }),
			},
		});
		expect(engine.getState("/data/found").value).toBe("3");
	});

	it("reads the same values when the XPath worker evaluates them", async () => {
		const { doc, lookup } = fixture();
		const engine = engineFor(doc, INSTANCE_READS.visitForm, {
			lookup,
			cases: visitCases,
			runtime: { stagedAsync: true },
		});
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		runtimes.push(runtime);
		const world = engine.createWorkerWorld("instance-reads");
		const evaluateAsync = (async (
			source: string,
			path: string,
			resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
			stateOverrides,
		) => {
			const result = await runtime.request({
				entryKey: "entry-instance-reads",
				revision: 0,
				profile: "form",
				source,
				resultMode,
				instances: engine.workerInstances(path, world, stateOverrides),
			});
			if (!result.ok) throw new Error(result.error.code);
			if (result.nodesetValues !== undefined)
				return {
					kind: "nodeset-values" as const,
					values: result.nodesetValues,
				};
			return deserializeXPathWorkerValue(result.value);
		}) as FormEngineAsyncEvaluator;
		await engine.initializeAsync(evaluateAsync);
		expect(engine.getState("/data/region_label").value).toBe("Northland");
		expect(engine.getState("/data/clinic_name").value).toBe("Central");
		expect(engine.getState("/data/color_text").value).toBe("Color");
		await engine.setValueAsync("/data/color", "red", evaluateAsync);
		expect(engine.getState("/data/color_label").value).toBe("Red");
	});
});

describe("after-submit links reading secondary instances", () => {
	const linkInput = (
		doc: BlueprintDoc,
		formUuid: string,
		extra: {
			readonly lookupData?: ReturnType<typeof previewLookupData>;
			readonly caseDatabase?: CaseDatabaseSnapshot;
			readonly searchResults?: SearchResultsSnapshot;
		},
	) => ({
		doc,
		formUuid: formUuid as never,
		session: previewSessionValues(null),
		usercase: {},
		sessionDatums: new Map(),
		...extra,
	});

	it("reads a place's name from the source entry's places", () => {
		const { doc, table } = fixture();
		const form = doc.forms[INSTANCE_READS.visitForm];
		// No rows: the table link's count is zero, so the place link decides.
		const emptyTable = previewLookupData({
			projectRevision: "1",
			definitions: [table],
			rowsByTable: new Map([[table.id, []]]),
		});
		const choice = evaluateFormLinks({
			links: form.formLinks ?? [],
			fallback: "module",
			input: linkInput(doc, INSTANCE_READS.visitForm, {
				lookupData: emptyTable,
				caseDatabase: { rows: [], indices: [], locations: [central] },
			}),
		});
		expect(choice).toMatchObject({ kind: "link", index: 1 });
	});

	it("reads a table under its suite id", () => {
		const { doc, lookup } = fixture();
		const form = doc.forms[INSTANCE_READS.visitForm];
		const choice = evaluateFormLinks({
			links: form.formLinks ?? [],
			fallback: "module",
			input: linkInput(doc, INSTANCE_READS.visitForm, {
				lookupData: lookup,
				caseDatabase: { rows: [], indices: [], locations: [] },
			}),
		});
		expect(choice).toMatchObject({ kind: "link", index: 0 });
	});

	it("reads what the source entry's search found", () => {
		const { doc } = fixture();
		const form = doc.forms[INSTANCE_READS.searchForm];
		const evaluate = (rows: readonly SearchResultRow[]) =>
			evaluateFormLinks({
				links: form.formLinks ?? [],
				fallback: "module",
				input: linkInput(doc, INSTANCE_READS.searchForm, {
					caseDatabase: { rows: [], indices: [] },
					searchResults: { rows, totalMatches: rows.length },
				}),
			});
		expect(evaluate([searchResult("p-1"), searchResult("p-2")])).toMatchObject({
			kind: "link",
			index: 0,
		});
		expect(evaluate([searchResult("p-1")])).toMatchObject({
			kind: "fallback",
		});
	});
});
