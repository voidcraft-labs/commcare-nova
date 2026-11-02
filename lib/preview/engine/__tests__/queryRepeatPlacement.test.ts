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
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

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

/** A query repeat whose rows each read their own id, index and starting
 * value, and outside reads of its rows. `order` changes the result when the
 * query reads it (the count placement); a constant query takes model
 * iteration. */
function readsOfRows(
	idsQuery: string,
	device: ReturnType<typeof androidDevice>,
	relevant?: string,
	placement?: "model-iteration" | "count",
): FormEngine {
	return new FormEngine(
		input([
			{ id: "order", kind: "text", label: proseText("Order") },
			{
				id: "members",
				kind: "repeat",
				label: proseText("Member"),
				repeat_mode: "query_bound",
				data_source: { ids_query: idsQuery },
				...(relevant === undefined ? {} : { relevant }),
				...(placement === undefined ? {} : { placement }),
				children: [
					{
						id: "note",
						kind: "text",
						label: proseText("Note"),
						default_value: "concat('for ', current()/../@id)",
					},
					{ id: "record", kind: "hidden", calculate: "current()/../@id" },
					{ id: "ordinal", kind: "hidden", calculate: "current()/../@index" },
				],
			},
			{ id: "rows", kind: "hidden", calculate: "count(#form/members)" },
			{
				id: "records",
				kind: "hidden",
				calculate: "join(' ', #form/members/record)",
			},
			{
				id: "ordinals",
				kind: "hidden",
				calculate: "join(' ', #form/members/ordinal)",
			},
			{
				id: "notes",
				kind: "hidden",
				calculate: "join(' ', #form/members/note)",
			},
		]),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ device },
	);
}

const ORDERED_QUERY =
	"if(#form/order = 'reverse', 'c b a', if(#form/order = 'short', 'a', if(#form/order = 'two', 'a b', if(#form/order = 'full', 'a b c', ''))))";

const value = (engine: FormEngine, path: string) => engine.getState(path).value;

describe.each([
	["Web Apps", webAppsDevice()],
	["Android", androidDevice()],
])("what a form reads of query rows on %s", (_platform, device) => {
	it("gives a new count-placement row its id before its starting value is set", () => {
		// Core fires every `jr-insert` setvalue of a new row before any
		// calculate (`FormDef.java::createNewRepeat`), and the count placement
		// sets the row's id among them (`xform/countPlacementRow.ts`), so a
		// starting value reading the id finds it. The count is computed in the
		// cascade of the answer the query reads, before the row is made, so a
		// row made by growth is within the result while its value is set.
		const engine = readsOfRows(ORDERED_QUERY, device);
		engine.setValue("/data/order", "short");
		expect(engine.getRepeatCount("/data/members")).toBe(1);
		engine.setValue("/data/order", "two");
		expect(engine.getRepeatCount("/data/members")).toBe(2);
		expect(value(engine, "/data/members[0]/note")).toBe("for a");
		expect(value(engine, "/data/members[1]/note")).toBe("for b");
		// A starting value is set once, when its row is made; the row's id
		// and stored index follow the result by position.
		engine.setValue("/data/order", "reverse");
		expect(value(engine, "/data/records")).toBe("c b a");
		expect(value(engine, "/data/ordinals")).toBe("0 1 2");
		expect(value(engine, "/data/members[0]/note")).toBe("for a");
		expect(value(engine, "/data/members[2]/note")).toBe("for a");
	});

	it("counts and joins only the rows within the result, keeping a hidden row's answer", () => {
		// A row past the end of the result is not relevant, and Core drops a
		// node that is not relevant from every nodeset
		// (`XPathLazyNodeset.java::performEvaluation`), so `count()` reads the
		// relevant rows only. A value read in such a row reads blank
		// (`XPathPathExpr.java::getRefValue`), while the instance keeps it.
		const engine = readsOfRows(ORDERED_QUERY, device);
		expect(value(engine, "/data/rows")).toBe("0");
		engine.setValue("/data/order", "full");
		expect(value(engine, "/data/rows")).toBe("3");
		engine.setValue("/data/members[2]/note", "kept");
		engine.setValue("/data/order", "short");
		expect(engine.getRepeatCount("/data/members")).toBe(3);
		expect(value(engine, "/data/rows")).toBe("1");
		expect(value(engine, "/data/records")).toBe("a");
		expect(value(engine, "/data/ordinals")).toBe("0");
		expect(value(engine, "/data/notes")).toBe("for a");
		expect(value(engine, "/data/members[2]/note")).toBe("kept");

		engine.setValue("/data/order", "full");
		expect(value(engine, "/data/rows")).toBe("3");
		expect(value(engine, "/data/records")).toBe("a b c");
		expect(value(engine, "/data/ordinals")).toBe("0 1 2");
		expect(value(engine, "/data/notes")).toBe("for a for b kept");
	});

	it("gives each row of a repeat with a condition its own record, and counts only the rows the condition shows", () => {
		// A repeat with a condition takes the count placement
		// (`lib/domain/queryRepeatPlacement.ts`, need `row-condition`), whose
		// rows store their place from `position(..)`. The condition is on the
		// row, and a row it hides drops out of every nodeset
		// (`XPathLazyNodeset.java::performEvaluation`).
		const engine = readsOfRows("'a b c'", device, "position() != 1");
		expect(engine.getRepeatCount("/data/members")).toBe(3);
		expect(value(engine, "/data/members[0]/note")).toBe("for a");
		expect(value(engine, "/data/members[2]/note")).toBe("for c");
		expect(value(engine, "/data/rows")).toBe("2");
		expect(value(engine, "/data/records")).toBe("a c");
		expect(value(engine, "/data/ordinals")).toBe("0 2");
	});

	it("gives a held model iteration's row after a hidden one the hidden row's record, as Core does", () => {
		// Model iteration sets a new row's `@index` from
		// `int(@current_index)` at `jr-insert`, before `@current_index`
		// (`count(<rows>)`, the relevant rows only) is calculated again
		// (`FormDef.java::createNewRepeat`), and HQ's form builder writes that
		// setvalue on every save. The hidden second row leaves it one short,
		// so the third row takes index 1 and the record `b`, and `c` is in
		// no row (`ContainerRuntimeTest.
		// aHiddenRowShiftsModelIterationsLaterRowsButNotTheCountPlacements`).
		const engine = readsOfRows(
			"'a b c'",
			device,
			"position() != 1",
			"model-iteration",
		);
		expect(engine.getRepeatCount("/data/members")).toBe(3);
		expect(value(engine, "/data/members[1]/note")).toBe("for b");
		expect(value(engine, "/data/members[2]/note")).toBe("for b");
		expect(value(engine, "/data/records")).toBe("a b");
		expect(value(engine, "/data/ordinals")).toBe("0 1");
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
						// A condition gives the count placement unless a publish
						// holds model iteration.
						placement: "model-iteration",
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
