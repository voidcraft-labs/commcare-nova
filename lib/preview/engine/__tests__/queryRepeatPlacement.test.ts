/**
 * Preview plays a query repeat in the placement its export writes
 * (`lib/domain/queryRepeatPlacement.ts`). Model iteration takes its rows
 * when the form opens; the count placement follows its query as the form is
 * filled in, and a row past the end of the current result is not relevant:
 * hidden, not submitted, with no case-operation iteration, its answers kept.
 * Every case runs the production engine, and the cycle case the production
 * dependency graph the validator reads.
 */

import { afterEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FieldSpec } from "@/lib/__tests__/docHelpers";
import type { CaseOperation } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import { buildFieldTree } from "../fieldTree";
import {
	FormEngine,
	type FormEngineAsyncEvaluator,
	type FormEngineInput,
} from "../formEngine";
import { TriggerDag } from "../triggerDag";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice } from "./fixtures/previewDevices";

const FORM = testUuid("query-placement-form");
const u = (path: string) => testUuid(`form.${path}`);

const runtimes = new Set<XPathRuntime>();
afterEach(() => {
	for (const runtime of runtimes) runtime.dispose();
	runtimes.clear();
});

function input(
	fields: FieldSpec[],
	caseOperations?: CaseOperation[],
): FormEngineInput {
	return engineFixtureInput(fields, {
		formUuid: FORM,
		formType: "survey",
		form: caseOperations === undefined ? {} : { caseOperations },
	});
}

/** A query that reads an answer of its own form takes the count placement. */
const LIVE_QUERY =
	"if(#form/size = 'two', 'a b', if(#form/size = 'one', 'a', if(#form/size = 'reversed', 'b a', '')))";

function liveRows(): FormEngine {
	return new FormEngine(
		input(
			[
				{ id: "size", kind: "text", label: proseText("How many") },
				{
					id: "items",
					kind: "repeat",
					label: proseText("Item"),
					repeat_mode: "query_bound",
					data_source: { ids_query: LIVE_QUERY },
					children: [
						{ id: "note", kind: "text", label: proseText("Note") },
						{ id: "row_id", kind: "hidden", calculate: "current()/../@id" },
					],
				},
			],
			[
				{
					uuid: testUuid("op.per-item"),
					id: "per_item",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
					forEach: { repeat: u("items") },
				},
			],
		),
	);
}

function iterationsOf(engine: FormEngine): number | undefined {
	return engine
		.computeOperationAnswers()
		?.repeats.find((scope) => scope.repeat === u("items"))?.iterations.length;
}

describe("a count-placement query repeat", () => {
	it("grows its rows as the answer its query reads changes", () => {
		const engine = liveRows();
		expect(engine.getRepeatCount("/data/items")).toBe(0);
		engine.setValue("/data/size", "two");
		expect(engine.getRepeatCount("/data/items")).toBe(2);
		expect(engine.getState("/data/items[0]/row_id").value).toBe("a");
		expect(engine.getState("/data/items[1]/row_id").value).toBe("b");
		expect(engine.getState("/data/items").queryResultCount).toBe(2);
		expect(iterationsOf(engine)).toBe(2);
	});

	it("hides a row past the end of a shrunken result, keeping its answer, and restores it", () => {
		const engine = liveRows();
		engine.setValue("/data/size", "two");
		engine.setValue("/data/items[0]/note", "first");
		engine.setValue("/data/items[1]/note", "second");

		engine.setValue("/data/size", "one");
		expect(engine.getRepeatCount("/data/items")).toBe(2);
		expect(engine.queryRowBeyondResult("/data/items[0]")).toBe(false);
		expect(engine.queryRowBeyondResult("/data/items[1]")).toBe(true);
		const visible = engine.effectivelyVisiblePaths();
		expect(visible.has("/data/items[0]/note")).toBe(true);
		expect(visible.has("/data/items[1]/note")).toBe(false);
		expect(engine.getState("/data/items[1]/note").value).toBe("second");
		expect(engine.getState("/data/items").queryResultCount).toBe(1);
		expect(iterationsOf(engine)).toBe(1);

		engine.setValue("/data/size", "two");
		expect(engine.queryRowBeyondResult("/data/items[1]")).toBe(false);
		expect(engine.effectivelyVisiblePaths().has("/data/items[1]/note")).toBe(
			true,
		);
		expect(engine.getState("/data/items[1]/note").value).toBe("second");
		expect(iterationsOf(engine)).toBe(2);
	});

	it("gives each row the id at its position when the result reorders", () => {
		const engine = liveRows();
		engine.setValue("/data/size", "two");
		engine.setValue("/data/items[0]/note", "kept at the first position");
		engine.setValue("/data/size", "reversed");
		expect(engine.getRepeatCount("/data/items")).toBe(2);
		expect(engine.getState("/data/items[0]/row_id").value).toBe("b");
		expect(engine.getState("/data/items[1]/row_id").value).toBe("a");
		expect(engine.getState("/data/items[0]/note").value).toBe(
			"kept at the first position",
		);
	});

	it("waits for its root section's page before its rows grow", () => {
		const engine = new FormEngine(
			input([
				{
					id: "first",
					kind: "section",
					label: proseText("Choose"),
					children: [{ id: "zone", kind: "text", label: proseText("Zone") }],
				},
				{
					id: "second",
					kind: "section",
					label: proseText("Assets"),
					children: [
						{
							id: "assets",
							kind: "repeat",
							label: proseText("Asset"),
							repeat_mode: "query_bound",
							data_source: {
								ids_query: "if(#form/first/zone = 'north', 'pump tap', '')",
							},
							children: [
								{
									id: "asset_id",
									kind: "hidden",
									calculate: "current()/../@id",
								},
							],
						},
					],
				},
			]),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			// Android pages a sectioned form one section at a time.
			{ device: androidDevice() },
		);
		const [first, second] = engine.sectionScreens();
		if (first === undefined || second === undefined)
			throw new Error("The form has two pages.");
		engine.enterSection(first.uuid);
		engine.setValue("/data/first/zone", "north");
		expect(engine.getRepeatCount("/data/second/assets")).toBe(0);
		expect(engine.hasPendingSectionInitialization()).toBe(false);
		engine.enterSection(second.uuid);
		expect(engine.getRepeatCount("/data/second/assets")).toBe(2);
		expect(engine.getState("/data/second/assets[1]/asset_id").value).toBe(
			"tap",
		);
	});
});

/** The real worker seam, owned by the test that starts it. */
function workerEvaluator(engine: FormEngine, worldKey: string) {
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	runtimes.add(runtime);
	const world = engine.createWorkerWorld(worldKey);
	return (async (
		source: string,
		path: string,
		resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
		stateOverrides?: Parameters<FormEngineAsyncEvaluator>[3],
	) => {
		const result = await runtime.request({
			dayNumberEpoch: engine.dayNumberEpoch,
			entryKey: "11111111-1111-4111-8111-111111111111",
			revision: 0,
			profile: "form",
			source,
			resultMode,
			instances: engine.workerInstances(path, world, stateOverrides),
		});
		if (!result.ok) throw new Error(result.error.code);
		if (result.nodesetValues !== undefined)
			return { kind: "nodeset-values" as const, values: result.nodesetValues };
		return deserializeXPathWorkerValue(result.value);
	}) as FormEngineAsyncEvaluator;
}

describe("a model-iteration query repeat", () => {
	it.each([false, true])(
		"evaluates its condition at each row (worker %s)",
		async (stagedAsync) => {
			const engine = new FormEngine(
				input([
					{
						id: "assets",
						kind: "repeat",
						label: proseText("Asset"),
						repeat_mode: "query_bound",
						data_source: { ids_query: "'pump tap'" },
						relevant: "current()/@id != 'tap'",
						children: [{ id: "note", kind: "text", label: proseText("Note") }],
					},
				]),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ stagedAsync },
			);
			if (stagedAsync)
				await engine.initializeAsync(
					workerEvaluator(engine, "model-iteration-condition"),
				);
			expect(engine.getRepeatCount("/data/assets")).toBe(2);
			expect(engine.getState("/data/assets").rowConditions).toEqual([
				true,
				false,
			]);
			const visible = engine.effectivelyVisiblePaths();
			expect(visible.has("/data/assets[0]/note")).toBe(true);
			expect(visible.has("/data/assets[1]/note")).toBe(false);
			expect(engine.queryRowBeyondResult("/data/assets[1]")).toBe(false);
		},
	);
});

describe("the dependency graph", () => {
	it("refuses a query that reads answers inside its own rows", () => {
		const doc = input([
			{
				id: "items",
				kind: "repeat",
				label: proseText("Item"),
				repeat_mode: "query_bound",
				data_source: { ids_query: "join(' ', #form/items/pick)" },
				children: [{ id: "pick", kind: "text", label: proseText("Pick") }],
			},
		]).doc;
		const cycles = new TriggerDag().reportCycles(
			buildFieldTree(FORM, doc.fields, doc.fieldOrder),
			doc,
			FORM,
		);
		expect(cycles.length).toBeGreaterThan(0);
		expect(
			cycles.some(({ path }) => path.includes("/data/items/item/pick")),
		).toBe(true);
	});
});
