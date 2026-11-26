import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { AndroidAppAction } from "@/lib/domain/fields/androidApp";
import { type AndroidAppReturn, androidAppWrites } from "../androidAppReturn";

const invoking = testUuid("meter"),
	count = testUuid("count"),
	text = testUuid("text");
const action: AndroidAppAction = {
	kind: "open-app",
	action: "org.example.MEASURE",
	send: [],
	receive: [
		{ name: "measurement", question: text },
		{ name: "measurement", question: count },
	],
};
const messages = {
	registration: (outcome: string) => outcome,
	scanned: (count: number) => String(count),
};
function run(result: AndroidAppReturn | null, supplied = action) {
	return androidAppWrites(invoking, supplied, result, messages);
}
it("distinguishes cancellation, absent primary, empty primary, null mapping, and a bundle-only return", () => {
	const values = new Map([["measurement", { value: null }]]);
	expect(run(null)).toEqual({ writes: [], reportedSuccess: false });
	expect(run({ primary: "" })).toEqual({
		writes: [{ question: invoking, value: "" }],
		reportedSuccess: true,
	});
	const direct = run({ extras: values });
	expect(direct).toEqual({
		writes: [
			{ question: invoking, value: "" },
			{ question: text, value: "", capture: {} },
			{ question: count, value: "", capture: {} },
		],
		reportedSuccess: true,
	});
	expect(run({ bundle: values })).toEqual({
		...direct,
		reportedSuccess: false,
	});
	expect(run({ extras: values, bundle: new Map() }).writes).toEqual([
		{ question: invoking, value: "" },
	]);
	expect(
		run(
			{ primary: "3" },
			{ ...action, receive: [{ name: "odk_intent_data", question: count }] },
		).writes,
	).toEqual([
		{ question: invoking, value: "3" },
		{ question: count, value: "3", capture: {} },
	]);
});

it("dispatches by parcel and clears every unscanned Simprints finger with a mapped destination", () => {
	const app: AndroidAppAction = {
		...action,
		receive: [
			{ name: "RIGHT_THUMB", question: count },
			{ name: "LEFT_THUMB", question: text },
		],
	};
	const simulated = {
		guid: null,
		templates: new Map([["LEFT_THUMB", Uint8Array.of(1)]]),
	};
	expect(
		run({ simprintsRegistration: simulated, primary: "ignored" }, app),
	).toEqual({
		writes: [
			{ question: count, value: "" },
			{ question: text, value: "AQ==\n" },
			{ question: invoking, value: "1" },
		],
		reportedSuccess: true,
	});
	expect(
		run(
			{
				simprintsRegistration: simulated,
				registration: { guid: "other", templates: new Map() },
				primary: "ignored",
			},
			app,
		),
	).toEqual({
		writes: [{ question: invoking, value: "success" }],
		reportedSuccess: true,
	});
});

it("uses native response destinations in Android order when two returned names both fill one question", () => {
	const app: AndroidAppAction = {
		...action,
		receive: [
			{ name: "measurement", question: count },
			{ name: "correction", question: count },
			...[
				"photo",
				"guid",
				"match_guid",
				"match_confidence",
				"match_strength",
				"face_template",
				"RIGHT_THUMB",
				"LEFT_THUMB",
			].map((name) => ({ name, question: text })),
		],
	};
	const pairs = [
		["correction", { value: "9" }],
		["measurement", { value: "7" }],
	] as const;
	for (const entries of [pairs, [...pairs].reverse()]) {
		expect(
			run({ bundle: new Map<string, { value: string }>(entries) }, app)
				.writes.filter((write) => write.question === count)
				.map((write) => write.value),
		).toEqual(["7", "9"]);
	}
});
