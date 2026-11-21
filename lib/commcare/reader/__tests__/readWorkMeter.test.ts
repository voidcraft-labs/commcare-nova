/**
 * A reading stops where its work passes its limit, or where its request is
 * cancelled, and a request's pieces stop with it.
 *
 * Contract: `readHqApp` counts its work on the work meter (`workMeter.ts`)
 * and, past the reading's limit, ends as an account of one finding at the
 * app, `too-intricate`, at the same place on every run, since the count is a
 * function of the input alone; a reading whose signal has aborted throws
 * `WorkCancelled` at its next charge, which no stage's `catch` keeps; a
 * request's `Pieces` runs no piece once its signal has aborted; and the text a
 * map shows in each of many languages is worked out once a map, each language
 * examined once.
 *
 * Plausible failure: a limit read off a clock, so the verdict moves with the
 * machine; a stop a stage's `catch` swallows, so the reading goes on and
 * answers as though it had finished; a cancelled request whose reading runs
 * to its end; a language fallback that walks every language once a language.
 */

import { expect, it } from "vitest";
import { Pieces } from "@/lib/deployment/reading/gather";
import { underMeter, WorkCancelled, WorkMeter } from "../../workMeter";
import { shownText } from "../hqText";
import { readHqApp } from "../index";
import { inputFor } from "./novaExport";
import { retainedSourceBody } from "./readerInput";

it("ends a reading past its limit as one too-intricate finding, at the same place on every run", async () => {
	const read = async (workLimit: number) =>
		readHqApp(
			await inputFor(retainedSourceBody("navigation-base/app-source")),
			{
				workLimit,
			},
		);
	const whole = await read(Number.POSITIVE_INFINITY);
	expect(whole.kind).toBe("read");
	const limit = Math.floor(whole.work.units / 2);
	const first = await read(limit);
	const second = await read(limit);
	expect(first.kind === "account" ? first.findings : []).toEqual([
		{
			code: "too-intricate",
			standing: "not-yet",
			place: { kind: "app" },
			subject: null,
			detail: {},
		},
	]);
	expect(first.work.limit).toBe(limit);
	expect(first.work.units).toBeGreaterThan(limit);
	expect(first.work.units).toBeLessThan(whole.work.units);
	expect(second.work).toEqual(first.work);
	expect(second.kind === "account" ? second.findings : []).toEqual(
		first.kind === "account" ? first.findings : [],
	);
});

it("reports a work limit reached during the final accounting pass", async () => {
	const input = await inputFor({
		...retainedSourceBody("navigation-base/app-source"),
		build_spec: { version: "2.1" },
	});
	const whole = readHqApp(input);
	expect(whole.kind).toBe("account");
	const stopped = readHqApp(input, { workLimit: whole.work.units - 1 });
	expect(stopped).toMatchObject({
		kind: "account",
		findings: [{ code: "too-intricate" }],
	});
	expect(stopped.work.nodes).toBeLessThan(whole.work.nodes);
});

it("stops a reading whose request was cancelled, whatever a stage catches", async () => {
	const input = await inputFor(
		retainedSourceBody("navigation-base/app-source"),
	);
	const cancel = new AbortController();
	cancel.abort();
	expect(() => readHqApp(input, { signal: cancel.signal })).toThrow(
		WorkCancelled,
	);
});

it("runs no piece of a request once its signal has aborted", async () => {
	const cancel = new AbortController();
	const pieces = new Pieces(cancel.signal);
	let ran = 0;
	await pieces.run(() => {
		ran += 1;
	});
	cancel.abort();
	await expect(
		pieces.run(() => {
			ran += 1;
		}),
	).rejects.toThrow(WorkCancelled);
	expect(ran).toBe(1);
});

it("examines each language of a map once, however many languages show its text", () => {
	const visitsFor = (count: number) => {
		const langs = Array.from({ length: count }, (_, at) => `l${at}`);
		// Only the last language holds a text, and it is blank: every language falls back.
		const map = { [`l${count - 1}`]: "" };
		const meter = new WorkMeter({ limit: Number.POSITIVE_INFINITY });
		const shown = underMeter(meter, () =>
			langs.map((lang) => shownText(map, lang, langs)),
		);
		expect(shown.every((one) => one.ok && one.text === "")).toBe(true);
		return meter.byKind.visit;
	};
	const small = visitsFor(250);
	const large = visitsFor(500);
	expect(large).toBeLessThanOrEqual(2 * small + 2);
	expect(large).toBeLessThan(2_000);
});
