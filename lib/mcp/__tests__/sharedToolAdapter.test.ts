/** Pure result projection; actual dispatch and persistence live in the Postgres suite. */
import { expect, it } from "vitest";
import { savedDataReview } from "@/lib/agent/toolResults";
import { projectResult } from "../resultProjection";

it("preserves read data, including keys also used by the chat UI", () => {
	for (const data of [
		null,
		"Text",
		[1, 2],
		{ summary: "a data field", message: "stored text" },
	]) {
		expect(projectResult({ kind: "read", data })).toEqual(data);
	}
});

it("removes write presentation while retaining identities, confirmation and errors", () => {
	for (const result of [
		{ ok: true },
		{ ok: true, uuid: "identity", options: [{ uuid: "option" }] },
		{ needsConfirmation: { confirmConversion: true } },
		{ error: "Choose a different name." },
	]) {
		expect(
			projectResult({
				kind: "mutate",
				mutations: [],
				result: { ...result, summary: { subject: "private UI" } },
			}),
		).toEqual(result);
	}
});

it("retains a saved-data consequence even when later tool reporting fails", () => {
	const dataReview = savedDataReview({
		parked: 2,
		failureReasons: ["a", "b", "c", "d"],
	});
	expect(dataReview).toEqual({
		values: 2,
		reasons: ["a", "b", "c"],
		additionalReasons: 1,
		location: "Case data",
	});
	for (const result of [
		{ ok: true, uuid: "field" },
		{ error: "Could not finish reporting the change." },
	]) {
		expect(
			projectResult({ kind: "mutate", mutations: [], result }, dataReview),
		).toEqual({ ...result, dataReview });
	}
});
