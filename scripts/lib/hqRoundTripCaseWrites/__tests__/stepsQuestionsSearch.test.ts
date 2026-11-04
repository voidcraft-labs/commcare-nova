/**
 * The cutover's question and search steps (part 09 §7.7 to §7.11): what
 * each writes into a document read the way the cutover reads an app, and
 * the notice lines it plans.
 *
 * Every document starts as a pre-step fixture, the shape `main` stored,
 * laid out as the carriers the cutover reads (`rawFixture.ts`) and taken
 * through the production structure phase, head parse and
 * `writes-into-operations` step, so each step meets the document the
 * transform hands it. A planted document is a fixture's JSON changed in one
 * place before that, so it is still a document `main` could have stored.
 *
 * The plausible failures: a step that writes a starting value, a workflow,
 * a count or a flag `main`'s behaviour does not call for; one that names a
 * notice line for a change that did not happen, or misses one that did; and
 * search facts that no longer read a menu the way `main`'s emission did
 * (`facts.json`'s `searchShapes`).
 */

import { describe, expect, it } from "vitest";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { StoredSearchFacts } from "@/lib/doc/searchWorkflowPlan";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import {
	makeTranslationUnitId,
	translationSourceFingerprint,
} from "@/lib/domain/localization";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { migrationNoticeEntriesSchema } from "@/lib/notices/migrationNotice";
import { type RawDocument, readRawDocument } from "../oldShape";
import {
	explicitPreloadsStep,
	laterLoadTimeReaders,
} from "../steps/explicitPreloads";
import { fieldListFlagsStep } from "../steps/fieldListFlags";
import {
	countPlacedQueryRepeats,
	queryRepeatPlacementStep,
} from "../steps/queryRepeatPlacement";
import { removedCountNodes, repeatCountsStep } from "../steps/repeatCounts";
import { searchWorkflowStep, storedSearchFacts } from "../steps/searchWorkflow";
import { writesIntoOperations } from "../steps/writesIntoOperations";
import { parseHead, structurePhase } from "../structure";
import type { LiftedFacts, PublishedDeployment } from "../types";
import {
	carriersOfPersistedDoc,
	PRE_STEP_FIXTURE_IDS,
	rawFixture,
	readPreStepJson,
} from "./rawFixture";

type JsonObject = Record<string, unknown>;

/** A fixture's stored JSON, to plant a change in. */
function storedJson(id: string): JsonObject {
	return structuredClone(readPreStepJson(`${id}.json`)) as JsonObject;
}

function rawOf(doc: JsonObject): RawDocument {
	return readRawDocument(doc.appId as string, carriersOfPersistedDoc(doc));
}

interface SemanticInput {
	readonly doc: BlueprintDoc;
	readonly facts: LiftedFacts;
}

/** The document and lifted facts the transform hands step 9 onward. */
function semanticInput(raw: RawDocument, appId = "app"): SemanticInput {
	const structure = structurePhase(raw);
	expect(structure.blockers).toEqual([]);
	const head = parseHead(appId, structure.persisted);
	if (!head.ok)
		throw new Error(
			`The head parse refused the document: ${head.blocker.findingCodes.join(", ")}.`,
		);
	const written = writesIntoOperations(head.doc, structure.facts);
	expect(written.blockers).toEqual([]);
	return { doc: written.doc, facts: structure.facts };
}

/** The head document and lifted facts alone, before any semantic step. */
function headInput(raw: RawDocument, appId = "app"): SemanticInput {
	const structure = structurePhase(raw);
	const head = parseHead(appId, structure.persisted);
	if (!head.ok)
		throw new Error(
			`The head parse refused the document: ${head.blocker.findingCodes.join(", ")}.`,
		);
	return { doc: head.doc, facts: structure.facts };
}

function fixtureInput(id: string): SemanticInput {
	return semanticInput(rawFixture(id));
}

function fieldNamed(doc: BlueprintDoc, id: string): Field {
	const field = Object.values(doc.fields).find(
		(candidate) => candidate.id === id,
	);
	if (field === undefined) throw new Error(`No field ${id}.`);
	return field;
}

/** Each notice line as `reason entity-name detail`, for whole-list checks. */
function lines(notice: readonly MigrationNoticeEntry[]): string[] {
	return notice.map((entry) =>
		entry.kind === "document"
			? `${entry.reason} ${entry.entity.nameAtMigration} ${JSON.stringify(entry.detail ?? {})}`
			: entry.reason,
	);
}

function expectValidNotice(notice: readonly MigrationNoticeEntry[]): void {
	if (notice.length > 0)
		expect(migrationNoticeEntriesSchema.safeParse(notice).success).toBe(true);
}

const PUBLISHED: readonly PublishedDeployment[] = [
	{
		deploymentId: "0b1e7c3e-5d4a-4f6b-9e2a-1c3d5e7f9a0b",
		server: "production",
		domain: "planted-domain",
		baseline: { kind: "shell" },
		overrides: [],
		pushedRevision: null,
	},
];

// ─── explicit-preloads (C7) ───────────────────────────────────────────────

describe("explicit-preloads", () => {
	it("gives each loaded writer its case read and names a replaced starting value and its later reader", () => {
		const { doc, facts } = fixtureInput("targeted-migration-groups-preloads");
		const result = explicitPreloadsStep(doc, facts);
		expect(result.blockers).toEqual([]);
		const weight = fieldNamed(result.doc, "weight");
		expect("default_value" in weight && weight.default_value).toEqual({
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property: "weight" },
		});
		expect(lines(result.notice)).toEqual([
			'starting-value-reads-case weight {"form":"Check","property":"weight"}',
			'load-time-value-reads-case weight_seen {"form":"Check","reads":"weight"}',
		]);
		expect(result.changes).toEqual([
			{
				step: "explicit-preloads",
				kind: "starting-value-written",
				entityUuid: weight.uuid,
				detail: { replaced: 1 },
			},
		]);
		expectValidNotice(result.notice);
	});

	it("names a later reader through a starting value and through a query repeat's ids query", () => {
		const { doc, facts } = fixtureInput("pre-step-preload-readers");
		const result = explicitPreloadsStep(doc, facts);
		expect(result.blockers).toEqual([]);
		// Neither writer held a starting value, so none was replaced.
		expect(lines(result.notice)).toEqual([
			'load-time-value-reads-case weight_copy {"form":"Visit","reads":"weight"}',
			'load-time-value-reads-case households {"form":"Visit","reads":"household_ids"}',
		]);
		expect(result.changes.map((change) => change.detail)).toEqual([
			{ replaced: 0 },
			{ replaced: 0 },
		]);
		expectValidNotice(result.notice);
	});

	it("finds no later reader before the writer it reads", () => {
		const { doc } = fixtureInput("pre-step-preload-readers");
		const formUuid = Object.keys(doc.forms)[0] as Uuid;
		const copy = fieldNamed(doc, "weight_copy");
		// Listing only the reader itself: nothing earlier reads it.
		expect(laterLoadTimeReaders(doc, formUuid, [copy.uuid])).toEqual([]);
	});

	it("writes nothing a second time", () => {
		const { doc, facts } = fixtureInput("targeted-migration-groups-preloads");
		const once = explicitPreloadsStep(doc, facts);
		const twice = explicitPreloadsStep(once.doc, facts);
		expect(twice.changes).toEqual([]);
		expect(twice.doc).toBe(once.doc);
	});
});

// ─── search-workflow (part 05 M1) ─────────────────────────────────────────

type MainShape = "search-first" | "skip-to-results" | "list-first";

/** `main`'s `searchWireShape` over the facts it read. */
function mainShape(facts: StoredSearchFacts): MainShape {
	if (facts.searchFirst) return "search-first";
	return !facts.hasVisibleInput && facts.hasEffectiveFilter
		? "skip-to-results"
		: "list-first";
}

const SEARCH_SHAPES = (
	readPreStepJson("facts.json") as {
		readonly fixtures: Readonly<
			Record<
				string,
				{ readonly searchShapes: Readonly<Record<string, MainShape>> }
			>
		>;
	}
).fixtures;

function moduleNamed(doc: BlueprintDoc, name: string): Uuid {
	const found = Object.values(doc.modules).find(
		(module) => module.name === name,
	);
	if (found === undefined) throw new Error(`No module ${name}.`);
	return found.uuid;
}

function storedModule(doc: JsonObject, name: string): JsonObject {
	const found = Object.values(doc.modules as Record<string, JsonObject>).find(
		(module) => module.name === name,
	);
	if (found === undefined) throw new Error(`No module ${name}.`);
	return found;
}

/** What the step stored in a menu's search settings. */
function workflowOf(doc: BlueprintDoc, name: string): unknown {
	const config = doc.modules[moduleNamed(doc, name)]?.caseSearchConfig;
	if (config === undefined || "searchActionEnabled" in config) return config;
	return {
		...(config.workflow !== undefined && { workflow: config.workflow }),
		...(config.formsReadSearch !== undefined && {
			formsReadSearch: config.formsReadSearch,
		}),
	};
}

describe("search-workflow", () => {
	it.each(PRE_STEP_FIXTURE_IDS)(
		"reads each searching menu of %s as main's emission did",
		(id) => {
			// The facts read only menus, so the head document serves every
			// fixture, one whose form `writes-into-operations` blocks included.
			const { doc, facts } = headInput(rawFixture(id));
			const derived = Object.fromEntries(
				[...storedSearchFacts(doc, facts)].map(([uuid, stored]) => [
					uuid,
					mainShape(stored),
				]),
			);
			expect(derived).toEqual(SEARCH_SHAPES[id]?.searchShapes);
		},
	);

	it("maps targeted-migration-search-workflow's menus by their rows", () => {
		const { doc, facts } = fixtureInput("targeted-migration-search-workflow");
		const result = searchWorkflowStep(doc, facts);
		expect(result.blockers).toEqual([]);
		// Row 1: search first with a visible field.
		expect(workflowOf(result.doc, "Clinics")).toEqual({
			formsReadSearch: true,
		});
		expect(workflowOf(result.doc, "Registry")).toEqual({
			formsReadSearch: true,
		});
		// Row 3: nothing to fill in, a filter that narrows.
		expect(workflowOf(result.doc, "Sites")).toEqual({
			workflow: "skipToResults",
		});
		// Row 6: list first with a visible field, Web Apps declared: nothing
		// stored, since absent is search first.
		expect(workflowOf(result.doc, "Visits")).toBeUndefined();
		expect(workflowOf(result.doc, "Reports")).toBeUndefined();
		expect(lines(result.notice)).toEqual([
			'menu-opens-on-search Visits {"opensOn":"search"}',
		]);
		expectValidNotice(result.notice);
	});

	it("opens pre-step-search-results' menu on its results in Web Apps", () => {
		// Row 7: no visible field, no filter, Web Apps declared.
		const { doc, facts } = fixtureInput("pre-step-search-results");
		const result = searchWorkflowStep(doc, facts);
		expect(result.blockers).toEqual([]);
		expect(workflowOf(result.doc, "Patients")).toEqual({
			workflow: "skipToResults",
		});
		expect(lines(result.notice)).toEqual([
			'menu-opens-on-search Patients {"opensOn":"results"}',
		]);
	});

	it("keeps list first in an app that runs only on Android", () => {
		// Row 4 (Visits) and row 5 (Patients), with row 3 (Sites) beside them.
		const workflow = storedJson("targeted-migration-search-workflow");
		(workflow.appSettings as JsonObject).runsOnlyOn = "android";
		const results = storedJson("pre-step-search-results");
		(results.appSettings as JsonObject).runsOnlyOn = "android";
		const first = semanticInput(rawOf(workflow));
		const second = semanticInput(rawOf(results));
		const mapped = searchWorkflowStep(first.doc, first.facts);
		const empty = searchWorkflowStep(second.doc, second.facts);
		expect(workflowOf(mapped.doc, "Visits")).toEqual({ workflow: "listFirst" });
		expect(workflowOf(mapped.doc, "Sites")).toEqual({
			workflow: "skipToResults",
		});
		expect(workflowOf(empty.doc, "Patients")).toEqual({
			workflow: "listFirst",
		});
		expect([...mapped.notice, ...empty.notice]).toEqual([]);
	});

	it("skips to results for a search-first menu with no visible field", () => {
		// Row 2.
		const stored = storedJson("targeted-migration-search-workflow");
		const clinics = storedModule(stored, "Clinics");
		(clinics.caseListConfig as JsonObject).searchInputs = [];
		const { doc, facts } = semanticInput(rawOf(stored));
		const result = searchWorkflowStep(doc, facts);
		expect(result.blockers).toEqual([]);
		expect(workflowOf(result.doc, "Clinics")).toEqual({
			workflow: "skipToResults",
			formsReadSearch: true,
		});
	});

	it("leaves an owner-only configuration untouched", () => {
		const stored = storedJson("targeted-migration-search-workflow");
		const reports = storedModule(stored, "Reports");
		reports.caseSearchConfig = {
			searchActionEnabled: false,
			excludedOwnerIds: {
				kind: "term",
				term: { kind: "literal", value: "nobody" },
			},
		};
		const { doc, facts } = semanticInput(rawOf(stored));
		const before = doc.modules[moduleNamed(doc, "Reports")]?.caseSearchConfig;
		expect(storedSearchFacts(doc, facts).has(moduleNamed(doc, "Reports"))).toBe(
			false,
		);
		const result = searchWorkflowStep(doc, facts);
		expect(
			result.doc.modules[moduleNamed(result.doc, "Reports")]?.caseSearchConfig,
		).toEqual(before);
	});

	it("maps nothing a second time over the workflows it wrote", () => {
		const { doc, facts } = fixtureInput("targeted-migration-search-workflow");
		const once = searchWorkflowStep(doc, facts);
		const twice = searchWorkflowStep(once.doc, facts);
		expect(twice.changes).toEqual([]);
		expect(twice.doc).toBe(once.doc);
	});
});

// ─── query-repeat-placement (Q1) ──────────────────────────────────────────

describe("query-repeat-placement", () => {
	it("names each query repeat the rule gives the count placement, and writes nothing", () => {
		const { doc } = fixtureInput("targeted-migration-query-repeats");
		const result = queryRepeatPlacementStep(doc);
		expect(result.doc).toBe(doc);
		expect(result.changes).toEqual([]);
		// `visits` sits at the root and reads no answer: model iteration.
		// `members` is nested in a repeat; `later` sits under a group whose
		// condition reads an answer.
		expect(lines(result.notice)).toEqual([
			'repeat-rows-follow-query members {"form":"Census"}',
			'repeat-rows-follow-query later {"form":"Census"}',
		]);
		expect(
			countPlacedQueryRepeats(doc).map(
				({ repeatUuid }) => doc.fields[repeatUuid]?.id,
			),
		).toEqual(["members", "later"]);
		expectValidNotice(result.notice);
	});
});

// ─── repeat-counts (Q2, Q3) ───────────────────────────────────────────────

describe("repeat-counts", () => {
	it("wraps a count that is not a whole number in int(...)", () => {
		const { doc } = fixtureInput("targeted-migration-repeat-counts");
		const portions = fieldNamed(doc, "portions");
		const before =
			portions.kind === "repeat" && portions.repeat_mode === "count_bound"
				? portions.repeat_count
				: null;
		const result = repeatCountsStep(doc, {
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			deployments: [],
		});
		expect(result.blockers).toEqual([]);
		const after = fieldNamed(result.doc, "portions");
		expect(
			after.kind === "repeat" &&
				after.repeat_mode === "count_bound" &&
				after.repeat_count,
		).toEqual({
			kind: "call",
			fn: "int",
			args: [before],
		});
		expect(result.changes).toEqual([
			{
				step: "repeat-counts",
				kind: "count-wrapped",
				entityUuid: portions.uuid,
				detail: {},
			},
		]);
		// Unpublished: no line for the count node that leaves.
		expect(lines(result.notice)).toEqual([
			'repeat-count-whole-number portions {"form":"Counted rows"}',
		]);
	});

	it("names a count node that leaves the wire only in a published app", () => {
		const { doc } = fixtureInput("targeted-migration-repeat-counts");
		const result = repeatCountsStep(doc, {
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
			deployments: PUBLISHED,
		});
		expect(lines(result.notice)).toEqual([
			'repeat-count-whole-number portions {"form":"Counted rows"}',
			'repeat-count-node-removed visits {"form":"Counted rows","hidden":"planned"}',
		]);
		expect(
			removedCountNodes(result.doc).map(({ repeatUuid, hiddenUuid }) => [
				result.doc.fields[repeatUuid]?.id,
				result.doc.fields[hiddenUuid]?.id,
			]),
		).toEqual([["visits", "planned"]]);
		expectValidNotice(result.notice);
	});

	it("keeps the count node a read of the count's result needs", () => {
		const stored = storedJson("targeted-migration-repeat-counts");
		const fields = stored.fields as Record<string, JsonObject>;
		const visits = Object.values(fields).find((field) => field.id === "visits");
		const weight = Object.values(fields).find((field) => field.id === "weight");
		if (visits === undefined || weight === undefined)
			throw new Error("The fixture lost its fields.");
		weight.default_value = {
			kind: "term",
			term: {
				kind: "form-node",
				node: { kind: "repeat", repeat: visits.uuid, role: "count-result" },
				spelling: "current",
			},
		};
		const { doc } = semanticInput(rawOf(stored));
		expect(removedCountNodes(doc)).toEqual([]);
	});

	it("wraps nothing a second time", () => {
		const { doc } = fixtureInput("targeted-migration-repeat-counts");
		const ctx = { lookupContext: LOOKUP_CONTEXT_UNAVAILABLE, deployments: [] };
		const once = repeatCountsStep(doc, ctx);
		const twice = repeatCountsStep(once.doc, ctx);
		expect(twice.changes).toEqual([]);
		expect(twice.doc).toBe(once.doc);
	});
});

// ─── field-list-flags (Q4) ────────────────────────────────────────────────

function fieldListOf(doc: BlueprintDoc, id: string): unknown {
	const field = fieldNamed(doc, id);
	return field.kind === "group" ? field.fieldList : "not a group";
}

describe("field-list-flags", () => {
	it("flags a labelled group and names one that holds a repeat workers grow", () => {
		const { doc, facts } = fixtureInput("targeted-migration-groups-preloads");
		const result = fieldListFlagsStep(doc, facts);
		expect(result.blockers).toEqual([]);
		expect(fieldListOf(result.doc, "vitals")).toBe(true);
		expect(fieldListOf(result.doc, "household")).toBeUndefined();
		expect("fieldList" in fieldNamed(result.doc, "household")).toBe(false);
		expect(lines(result.notice)).toEqual([
			'group-shows-one-per-screen household {"form":"Check"}',
		]);
		expectValidNotice(result.notice);
	});

	it("flags a group whose label shows only in a translation, and not one with a user repeat two levels down", () => {
		const stored = storedJson("targeted-migration-groups-preloads");
		const fields = stored.fields as Record<string, JsonObject>;
		const fieldOrder = stored.fieldOrder as Record<string, string[]>;
		const byId = (id: string): JsonObject => {
			const found = Object.values(fields).find((field) => field.id === id);
			if (found === undefined) throw new Error(`No field ${id}.`);
			return found;
		};
		// `vitals`: a blank source label with a current French translation.
		const vitals = byId("vitals");
		const blank = { parts: [] };
		vitals.label = blank;
		stored.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "fra"],
			translations: {
				fra: {
					[makeTranslationUnitId("field", vitals.uuid as string, "label")]: {
						value: { parts: [{ kind: "text", text: "Signes vitaux" }] },
						sourceFingerprint: translationSourceFingerprint("prose", blank),
						origin: "human",
						review: "reviewed",
						translatedFrom: "eng",
					},
				},
			},
			wireCodes: { eng: "en", fra: "fra" },
		};
		// `household` > `roster` (labelled) > `members`, a repeat workers grow.
		const household = byId("household");
		const members = byId("members");
		const rosterUuid = "6f0c2a8e-3b1d-4e5f-9a7b-2c4d6e8f0a1b";
		fields[rosterUuid] = {
			uuid: rosterUuid,
			kind: "group",
			id: "roster",
			label: { parts: [{ kind: "text", text: "Roster" }] },
		};
		fieldOrder[household.uuid as string] = [rosterUuid];
		fieldOrder[rosterUuid] = [members.uuid as string];

		const { doc, facts } = semanticInput(rawOf(stored));
		expect(
			[...facts.labelledGroups].map((uuid) => doc.fields[uuid]?.id),
		).toEqual(expect.arrayContaining(["vitals", "household", "roster"]));
		const result = fieldListFlagsStep(doc, facts);
		expect(result.blockers).toEqual([]);
		expect(fieldListOf(result.doc, "vitals")).toBe(true);
		expect(fieldListOf(result.doc, "household")).toBeUndefined();
		expect(fieldListOf(result.doc, "roster")).toBeUndefined();
		expect(lines(result.notice)).toEqual([
			'group-shows-one-per-screen household {"form":"Check"}',
			'group-shows-one-per-screen roster {"form":"Check"}',
		]);
	});

	it("flags nothing a second time", () => {
		const { doc, facts } = fixtureInput("targeted-migration-groups-preloads");
		const once = fieldListFlagsStep(doc, facts);
		const twice = fieldListFlagsStep(once.doc, facts);
		expect(twice.changes).toEqual([]);
		expect(twice.doc).toBe(once.doc);
	});
});
