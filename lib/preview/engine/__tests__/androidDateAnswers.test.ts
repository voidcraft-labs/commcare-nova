import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { isoOfCalendarDay, localToday } from "../../workerCalendar";
import { evaluateFormSnapshot } from "../evaluateFormSnapshot";
import { FormEngine } from "../formEngine";
import type {
	FormEvaluationContext,
	FormEvaluationInput,
} from "../formEvaluationTypes";
import { previewAsMe } from "../identity";
import { engineFixtureInput } from "./fixtures/engineInput";
import { androidDevice, webAppsDevice } from "./fixtures/previewDevices";

const formUuid = testUuid("visit-calendar");
const fixture = () =>
	engineFixtureInput(
		[
			{
				kind: "group",
				id: "visit",
				label: "Visit",
				fieldList: true,
				children: [
					{ kind: "text", id: "show", label: "Include follow-up" },
					{ kind: "date", id: "arrival", label: "Arrival", calendar: "nepali" },
					{
						kind: "date",
						id: "rescheduled",
						label: "Rescheduled",
						calendar: "gregorian-with-clear",
						default_value: "date('2023-09-12')",
					},
					{
						kind: "date",
						id: "followup",
						label: "Follow-up",
						calendar: "gregorian-with-clear",
						relevant: "/data/visit/show = 'yes'",
					},
				],
			},
			{ kind: "date", id: "skipped", label: "Unvisited" },
			{ kind: "date", id: "last", label: "Closing day", calendar: "ethiopian" },
		],
		{ formUuid, formType: "survey" },
	);

it("only saves date widgets that were visible when the Android worker left", () => {
	const engine = new FormEngine(
		fixture(),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ device: androidDevice() },
	);
	const state = (name: string) => engine.getState(`/data/${name}`);
	const today = isoOfCalendarDay(localToday());
	expect(state("visit/arrival")).toMatchObject({
		value: "",
		androidPickerDay: today,
	});
	expect(state("visit/followup").androidPickerDay).toBeUndefined();
	engine.setValue("/data/visit/show", "yes");
	expect(state("visit/followup").androidPickerDay).toBe(today);
	engine.setValue("/data/visit/followup", "");
	expect(state("visit/followup").androidPickerDay).toBe("");
	engine.setValue("/data/visit/show", "no");
	expect(state("visit/followup").androidPickerDay).toBeUndefined();
	engine.setValue("/data/visit/show", "yes");
	expect(state("visit/followup").androidPickerDay).toBe(today);
	engine.setValue("/data/visit/show", "no");
	expect(state("visit/rescheduled").value).toBe("2023-09-12");
	engine.setValue("/data/visit/rescheduled", "");
	engine.saveScreenDates();
	engine.enterScreen("/data/last");
	expect(state("visit/arrival").value).toBe(today);
	expect(state("visit/rescheduled").value).toBe("");
	expect(state("visit/followup").value).toBe("");
	expect(state("skipped").value).toBe("");
	engine.enterScreen("/data/visit");
	expect(state("visit/rescheduled")).toMatchObject({
		value: "",
		androidPickerDay: today,
	});
});

it("keeps an inspected App Test date empty, skips intervening widgets and saves the last displayed date on submit", async () => {
	const { doc } = fixture();
	const identity = previewAsMe({ id: "member" }, doc);
	if (!identity) throw Error("Fixture needs a worker");
	const context: FormEvaluationContext = {
		device: androidDevice(),
		identity,
		cases: { rows: [], indices: [] },
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		captureEntry: true,
	};
	const run = (
		input: Partial<FormEvaluationInput>,
		options: Partial<FormEvaluationContext> = {},
	) =>
		evaluateFormSnapshot(
			doc,
			{ formUuid, answers: [], ...input },
			{ ...context, ...options },
		);
	const arrived = await run({});
	const open = arrived.fields.find((field) => field.path === "visit/arrival");
	const day = isoOfCalendarDay(localToday());
	expect(open).toMatchObject({ value: "", displayedDay: day });
	const last = await run(
		{ screenPath: "/data/last", answers: [] },
		{ entry: arrived.entry },
	);
	const answer = (result: typeof last, path: string) =>
		result.fields.find((field) => field.path === path)?.value;
	expect(answer(last, "visit/arrival")).toBe(day);
	expect(answer(last, "skipped")).toBe("");
	expect(answer(last, "last")).toBe("");
	const submitted = await run({}, { entry: last.entry, submitting: true });
	expect(submitted.submission).toMatchObject({ kind: "survey" });
	expect(submitted.valid).toBe(true);
	expect(answer(submitted, "last")).toBe(day);
	expect(answer(submitted, "skipped")).toBe("");
	const web = await run({}, { device: webAppsDevice(), captureEntry: false });
	expect(answer(web, "visit/arrival")).toBe("");
	expect(answer(web, "last")).toBe("");
});
