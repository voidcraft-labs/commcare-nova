/**
 * What a row's calculation reads when rows are made and removed, on each
 * platform Preview plays. Core evaluates every triggerable a change reaches
 * at the instances its context names once narrowed to the change
 * (`FormDef.java::evaluateTriggerable`, `Triggerable.java::narrowContextBy`):
 * a new row runs what it triggers and what it roots in that row alone
 * (`FormDef.java::createNewRepeat`), so a row calculation reading a value
 * outside the repeat keeps, in every older row, what it read when that row
 * was made. Android shows that. Formplayer loads the form session again at
 * the start of every request and runs every triggerable before the
 * request's own change (`session/FormSession.java` →
 * `FormDef.initialize(false, …)` → `initAllTriggerables`), so Web Apps shows
 * the narrowed values in the response that made the rows and current values
 * from the next request on. The plausible failure is a cascade that runs
 * every row (each older row reads the newest total), or one that leaves a
 * value outside the repeat behind its rows.
 */

import { afterEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FieldSpec } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import { FormEngine, type FormEngineAsyncEvaluator } from "../formEngine";
import type { PreviewDevice } from "../previewDevice";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const FORM = testUuid("repeat-cascade-form");

const runtimes = new Set<XPathRuntime>();
afterEach(() => {
	for (const runtime of runtimes) runtime.dispose();
	runtimes.clear();
});

function engineOf(
	fields: FieldSpec[],
	device: PreviewDevice,
	stagedAsync = false,
): FormEngine {
	return new FormEngine(
		engineFixtureInput(fields, { formUuid: FORM, formType: "survey" }),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ device, stagedAsync },
	);
}

/** The real worker seam, owned by the test that starts it. */
function workerEvaluator(engine: FormEngine): FormEngineAsyncEvaluator {
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	runtimes.add(runtime);
	const world = engine.createWorkerWorld("repeat-cascade");
	return (async (
		source: string,
		path: string,
		resultMode: "scalar" | "nodeset-values-or-scalar" = "scalar",
		stateOverrides?: Parameters<FormEngineAsyncEvaluator>[3],
	) => {
		const result = await runtime.request({
			dayNumberEpoch: engine.dayNumberEpoch,
			entryKey: "22222222-2222-4222-8222-222222222222",
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

const values = (engine: FormEngine, repeat: string, child: string) =>
	Array.from(
		{ length: engine.getRepeatCount(repeat) },
		(_, index) => engine.getState(`${repeat}[${index}]/${child}`).value,
	).join(" ");

const note = (): FieldSpec => ({
	id: "note",
	kind: "text",
	label: proseText("Note"),
});

/** Rows that each read the total outside the repeat, which counts them. */
function totalReaders(repeat: Partial<FieldSpec>): FieldSpec[] {
	return [
		note(),
		{ id: "n", kind: "int", label: proseText("How many") },
		{
			id: "members",
			kind: "repeat",
			label: proseText("Member"),
			children: [{ id: "x", kind: "hidden", calculate: "#form/total" }],
			...repeat,
		} as FieldSpec,
		{ id: "total", kind: "hidden", calculate: "count(#form/members)" },
	];
}

describe("a row reading a total outside its repeat", () => {
	it("keeps, on Android, the total each row read when it was made", () => {
		const engine = engineOf(
			totalReaders({ repeat_mode: "user_controlled" }),
			androidDevice(),
		);
		expect(values(engine, "/data/members", "x")).toBe("1");
		engine.addRepeat("/data/members");
		engine.addRepeat("/data/members");
		expect(values(engine, "/data/members", "x")).toBe("1 2 3");
		// The total is triggered by the new row and runs in the same cascade
		// (`createNewRepeat` → `triggerTriggerables(row)`).
		expect(engine.getState("/data/total").value).toBe("3");
		// A later answer reaches neither.
		engine.setValue("/data/note", "unrelated");
		expect(values(engine, "/data/members", "x")).toBe("1 2 3");
	});

	it("shows, on Web Apps, the narrowed rows in each response and every row current from the next", () => {
		const engine = engineOf(
			totalReaders({ repeat_mode: "user_controlled" }),
			webAppsDevice(),
		);
		engine.addRepeat("/data/members");
		expect(values(engine, "/data/members", "x")).toBe("1 2");
		// The request's opening pass runs every row with two rows, then the
		// new row reads three.
		engine.addRepeat("/data/members");
		expect(values(engine, "/data/members", "x")).toBe("2 2 3");
		expect(engine.getState("/data/total").value).toBe("3");
		engine.setValue("/data/note", "unrelated");
		expect(values(engine, "/data/members", "x")).toBe("3 3 3");
	});

	it.each([
		["Android", androidDevice(), "1 2 3"],
		["Web Apps", webAppsDevice(), "3 3 3"],
	] as const)(
		"narrows each row a count makes to that row on %s",
		(_platform, device, afterNextRequest) => {
			const engine = engineOf(
				totalReaders({ repeat_mode: "count_bound", repeat_count: "#form/n" }),
				device,
			);
			engine.setValue("/data/n", "3");
			// Core makes each row up to the count with `createNewRepeat`.
			expect(values(engine, "/data/members", "x")).toBe("1 2 3");
			expect(engine.getState("/data/total").value).toBe("3");
			engine.setValue("/data/note", "unrelated");
			expect(values(engine, "/data/members", "x")).toBe(afterNextRequest);
		},
	);

	it.each([
		["Android", androidDevice()],
		["Web Apps", webAppsDevice()],
	] as const)(
		"runs, on %s, what reads the repeat at the removed row's place alone",
		(_platform, device) => {
			// `FormDef.java::deleteRepeat` cascades from the removed row's
			// reference, which now names the row after it.
			const engine = engineOf(
				totalReaders({ repeat_mode: "user_controlled" }),
				device,
			);
			engine.addRepeat("/data/members");
			engine.addRepeat("/data/members");
			engine.removeRepeat("/data/members", 0);
			expect(values(engine, "/data/members", "x")).toBe("2 3");
			expect(engine.getState("/data/total").value).toBe("2");
		},
	);

	it.each([
		["Android", androidDevice(), "1 2 3"],
		["Web Apps", webAppsDevice(), "2 2 3"],
	] as const)(
		"plays the same rows through the worker on %s",
		async (_platform, device, afterThirdRow) => {
			const engine = engineOf(
				totalReaders({ repeat_mode: "user_controlled" }),
				device,
				true,
			);
			const evaluate = workerEvaluator(engine);
			await engine.initializeAsync(evaluate);
			await engine.addRepeatAsync("/data/members", evaluate);
			await engine.addRepeatAsync("/data/members", evaluate);
			expect(values(engine, "/data/members", "x")).toBe(afterThirdRow);
			expect(engine.getState("/data/total").value).toBe("3");
		},
	);
});

describe("a row reading its own repeat through a filter", () => {
	it.each([
		["Android", androidDevice()],
		["Web Apps", webAppsDevice()],
	] as const)(
		"runs in every row when one row's answer changes on %s",
		(_platform, device) => {
			// A read that filters the repeat's own step stops Core narrowing the
			// calculation to the changed row at that step
			// (`Triggerable.java::widenContextToAndClearPredicates`,
			// `narrowContextBy` → `genericizeAfter`), so every row counts again.
			const engine = engineOf(
				[
					{
						id: "members",
						kind: "repeat",
						label: proseText("Member"),
						repeat_mode: "user_controlled",
						children: [
							{ id: "v", kind: "text", label: proseText("Yes or no") },
							{
								id: "yes",
								kind: "hidden",
								calculate: "count(#form/members[v = 'yes'])",
							},
						],
					} as FieldSpec,
				],
				device,
			);
			engine.addRepeat("/data/members");
			engine.addRepeat("/data/members");
			engine.setValue("/data/members[0]/v", "yes");
			expect(values(engine, "/data/members", "yes")).toBe("1 1 1");
		},
	);
});

/** A query repeat whose rows read the wrapper's `@current_index` (the rows
 * made so far), and outside reads of the wrapper. */
function wrapperReaders(idsQuery: string): FieldSpec[] {
	return [
		{ id: "order", kind: "text", label: proseText("Order") },
		note(),
		{
			id: "members",
			kind: "repeat",
			label: proseText("Member"),
			repeat_mode: "query_bound",
			data_source: { ids_query: idsQuery },
			children: [
				{
					id: "made",
					kind: "hidden",
					calculate: "current()/../../@current_index",
				},
			],
		},
		{ id: "ids", kind: "hidden", calculate: "current()/../members/@ids" },
		{ id: "count", kind: "hidden", calculate: "current()/../members/@count" },
		{
			id: "made_so_far",
			kind: "hidden",
			calculate: "current()/../members/@current_index",
		},
	];
}

const FOLLOWED_QUERY =
	"if(#form/order = 'short', 'a', if(#form/order = 'full', 'a b c', ''))";

describe("a query repeat's wrapper", () => {
	it.each([
		["Android", androidDevice(), "1 2 3"],
		["Web Apps", webAppsDevice(), "3 3 3"],
	] as const)(
		"gives model iteration's rows the rows made so far on %s",
		(_platform, device, afterNextRequest) => {
			// Model iteration's `@current_index` is `count(/data/r/item)`,
			// recalculated as each row is made; each row reads it narrowed to
			// itself.
			const engine = engineOf(wrapperReaders("'a b c'"), device);
			expect(values(engine, "/data/members", "made")).toBe("1 2 3");
			expect(engine.getState("/data/ids").value).toBe("a b c");
			expect(engine.getState("/data/count").value).toBe("3");
			expect(engine.getState("/data/made_so_far").value).toBe("3");
			engine.setValue("/data/note", "unrelated");
			expect(values(engine, "/data/members", "made")).toBe(afterNextRequest);
		},
	);

	it.each([
		["Android", androidDevice(), "1 2 3"],
		["Web Apps", webAppsDevice(), "3 3 3"],
	] as const)(
		"gives the count placement's rows the rows made so far on %s, counting only the relevant ones",
		(_platform, device, afterNextRequest) => {
			// The count placement's position node is `count(../item)`, and a
			// row past the end of the result is not relevant, so Core leaves
			// it out of that nodeset (`XPathLazyNodeset.java::performEvaluation`).
			const engine = engineOf(wrapperReaders(FOLLOWED_QUERY), device);
			expect(engine.getState("/data/made_so_far").value).toBe("0");
			engine.setValue("/data/order", "full");
			expect(values(engine, "/data/members", "made")).toBe("1 2 3");
			expect(engine.getState("/data/ids").value).toBe("a b c");
			expect(engine.getState("/data/count").value).toBe("3");
			expect(engine.getState("/data/made_so_far").value).toBe("3");
			engine.setValue("/data/note", "unrelated");
			expect(values(engine, "/data/members", "made")).toBe(afterNextRequest);
			engine.setValue("/data/order", "short");
			expect(engine.getRepeatCount("/data/members")).toBe(3);
			expect(engine.getState("/data/count").value).toBe("1");
			expect(engine.getState("/data/made_so_far").value).toBe("1");
		},
	);

	it("reads the same wrapper through the worker", async () => {
		const engine = engineOf(
			wrapperReaders(FOLLOWED_QUERY),
			androidDevice(),
			true,
		);
		const evaluate = workerEvaluator(engine);
		await engine.initializeAsync(evaluate);
		await engine.setValueAsync("/data/order", "full", evaluate);
		expect(values(engine, "/data/members", "made")).toBe("1 2 3");
		expect(engine.getState("/data/made_so_far").value).toBe("3");
		await engine.setValueAsync("/data/order", "short", evaluate);
		expect(engine.getState("/data/made_so_far").value).toBe("1");
	});
});
