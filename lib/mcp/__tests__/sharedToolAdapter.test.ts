/** Pure result projection; actual dispatch and persistence live in the Postgres suite. */
import { expect, it } from "vitest";
import { projectResult } from "../resultProjection";

it("projects complete read values without interpreting their keys", () => {
	for (const data of [
		null,
		"Text",
		[1, 2],
		{ summary: "a data field", message: "stored text" },
	]) {
		expect(projectResult({ kind: "read", data })).toEqual(data);
	}
});
it("removes only chat presentation while retaining created identities and failure details", () => {
	for (const [result, expected] of [
		[{ message: "Saved.", summary: { subject: "private UI" } }, "Saved."],
		[
			{
				message: "Saved.",
				summary: { subject: "private UI" },
				uuid: "identity",
				options: [{ uuid: "option" }],
			},
			{ message: "Saved.", uuid: "identity", options: [{ uuid: "option" }] },
		],
		[
			{ error: "Choose a different name." },
			{ error: "Choose a different name." },
		],
		["Already removed.", "Already removed."],
		[null, null],
	]) {
		expect(projectResult({ kind: "mutate", mutations: [], result })).toEqual(
			expected,
		);
	}
});
it("preserves saved-data notes after message-only collapse and alongside structural receipts", () => {
	const note = "Data note: 2 saved values were kept for review.";
	for (const [result, expected] of [
		[
			{ message: "Converted.", summary: { subject: "field" } },
			`Converted.\n\n${note}`,
		],
		[
			{ message: "Converted.", summary: {}, uuid: "field" },
			{ message: `Converted.\n\n${note}`, uuid: "field" },
		],
		[{ error: "Refused." }, { error: "Refused." }],
	]) {
		expect(
			projectResult({ kind: "mutate", mutations: [], result }, note),
		).toEqual(expected);
	}
});
