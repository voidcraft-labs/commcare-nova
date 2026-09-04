import { describe, expect, it } from "vitest";
import { joinMultiSelectSearchAnswer } from "@/lib/domain";
import { choiceKeysForAnswer } from "../multiSelectChoiceKeys";

const rows = [
	{ key: "r1", value: "open", label: "Open" },
	{ key: "r2", value: "closed", label: "Closed" },
	{ key: "r3", value: "closed", label: "Closed (archived)" },
	{ key: "r4", value: "", label: "Blank" },
];

describe("choiceKeysForAnswer", () => {
	it("ticks one row per token, the first unclaimed row of that value", () => {
		expect([...choiceKeysForAnswer("closed", rows)]).toEqual(["r2"]);
		expect([
			...choiceKeysForAnswer(
				joinMultiSelectSearchAnswer(["closed", "closed"]),
				rows,
			),
		]).toEqual(["r2", "r3"]);
		expect([
			...choiceKeysForAnswer(
				joinMultiSelectSearchAnswer(["open", "closed"]),
				rows,
			),
		]).toEqual(["r1", "r2"]);
	});

	it("ignores tokens no row carries and never ticks a blank row", () => {
		expect([...choiceKeysForAnswer("missing", rows)]).toEqual([]);
		expect([...choiceKeysForAnswer("", rows)]).toEqual([]);
	});

	it("ticks nothing while the rows are still loading", () => {
		expect([...choiceKeysForAnswer("open", undefined)]).toEqual([]);
	});
});
