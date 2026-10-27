/**
 * When each platform re-evaluates a form's expressions.
 *
 * Formplayer asks the form for all of its work on every request
 * (`FormRecordProcessorHelper`'s `getAllWork` after each answer), so a
 * calculate over a clock and every condition reading that calculate move
 * with the clock the next time anything is answered. Android's engine
 * re-evaluates only what an answer touches. A starting value is set once on
 * both: when the form opens, and for a repeat entry when it is inserted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { createInProcessXPathWorkerFactory } from "../../xpath/inProcessWorkerClient";
import { XPathRuntime } from "../../xpath/workerClient";
import { deserializeXPathWorkerValue } from "../../xpath/workerProjection";
import { FormEngine, type FormEngineAsyncEvaluator } from "../formEngine";
import type { PreviewDevice } from "../previewDevice";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const ENTRY_KEY = "22222222-2222-4222-8222-222222222222";
const runtimes = new Set<XPathRuntime>();

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-05-06T12:00:00Z"));
});
afterEach(() => {
	for (const runtime of runtimes) runtime.dispose();
	runtimes.clear();
	vi.useRealTimers();
});

function engineOn(device: PreviewDevice, stagedAsync: boolean) {
	const input = engineFixtureInput(
		[
			{ id: "unrelated", kind: "text" },
			{ id: "day", kind: "hidden", calculate: "today()" },
			{
				id: "on_the_day",
				kind: "text",
				relevant: "#form/day = date('2026-05-06')",
			},
			{ id: "opened", kind: "hidden", default_value: "today()" },
			{
				id: "visits",
				kind: "repeat",
				children: [{ id: "started", kind: "hidden", default_value: "today()" }],
			},
		],
		{ formUuid: testUuid("recalculation-form"), formType: "survey" },
	);
	const engine = new FormEngine(
		input,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ stagedAsync, device },
	);
	const runtime = new XPathRuntime({
		workerFactory: createInProcessXPathWorkerFactory(),
	});
	runtimes.add(runtime);
	const world = engine.createWorkerWorld(`recalculation-${device.platform}`);
	const evaluateAsync = (async (source, path, resultMode = "scalar", state) => {
		const result = await runtime.request({
			dayNumberEpoch: engine.dayNumberEpoch,
			entryKey: ENTRY_KEY,
			revision: 0,
			profile: "form",
			source,
			resultMode,
			instances: engine.workerInstances(path, world, state),
		});
		if (!result.ok) throw new Error(result.error.code);
		if (result.nodesetValues !== undefined)
			return { kind: "nodeset-values" as const, values: result.nodesetValues };
		return deserializeXPathWorkerValue(result.value);
	}) as FormEngineAsyncEvaluator;
	return {
		engine,
		initialize: () =>
			stagedAsync ? engine.initializeAsync(evaluateAsync) : Promise.resolve(),
		answer: (path: string, value: string) =>
			stagedAsync
				? engine.setValueAsync(path, value, evaluateAsync)
				: Promise.resolve(engine.setValue(path, value)),
		addEntry: () =>
			stagedAsync
				? engine.addRepeatAsync("/data/visits", evaluateAsync)
				: Promise.resolve(engine.addRepeat("/data/visits")),
	};
}

describe.each([false, true])("recalculation (worker: %s)", (stagedAsync) => {
	it("re-evaluates a clock calculate and its condition on Web Apps after any answer, never a starting value", async () => {
		const run = engineOn(webAppsDevice(), stagedAsync);
		await run.initialize();
		expect(run.engine.getState("/data/day").value).toBe("2026-05-06");
		expect(run.engine.getState("/data/on_the_day").visible).toBe(true);
		vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
		await run.answer("/data/unrelated", "a");
		expect(run.engine.getState("/data/day").value).toBe("2026-05-08");
		expect(run.engine.getState("/data/on_the_day").visible).toBe(false);
		expect(run.engine.getState("/data/opened").value).toBe("2026-05-06");
	});

	it("leaves them as they were on Android, where an answer re-evaluates only what it touches", async () => {
		const run = engineOn(androidDevice(), stagedAsync);
		await run.initialize();
		vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
		await run.answer("/data/unrelated", "a");
		expect(run.engine.getState("/data/day").value).toBe("2026-05-06");
		expect(run.engine.getState("/data/on_the_day").visible).toBe(true);
		expect(run.engine.getState("/data/opened").value).toBe("2026-05-06");
	});

	it.each([
		["web-apps", webAppsDevice()],
		["android", androidDevice()],
	] as const)(
		"sets a repeat entry's starting value only on its insert (%s)",
		async (_platform, device) => {
			const run = engineOn(device, stagedAsync);
			await run.initialize();
			const opened = run.engine.getRepeatCount("/data/visits");
			await run.addEntry();
			const first = `/data/visits[${opened}]/started`;
			const second = `/data/visits[${opened + 1}]/started`;
			vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
			await run.answer("/data/unrelated", "a");
			expect(run.engine.getState(first).value).toBe("2026-05-06");
			await run.addEntry();
			expect(run.engine.getState(first).value).toBe("2026-05-06");
			expect(run.engine.getState(second).value).toBe("2026-05-08");
		},
	);
});
