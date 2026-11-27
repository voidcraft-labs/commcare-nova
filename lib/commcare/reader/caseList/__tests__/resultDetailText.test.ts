import { describe, expect, it } from "vitest";
import { resultDetailTextWire } from "../../../suite/case-list/resultDetailText";
import { serializeWire } from "../../../xpath/wire/serialize";
import { readResultDetailText } from "../resultDetailText";

const prompt =
	"instance('search-input:results')/input/field[@name = 'detail_marker']";
const roster = "count(current()/../../results) > 0";
const optional = `if(count(${prompt}) > 0, string(${prompt}), '')`;
const formula = `if(${roster}, concat('entered=[', ${optional}, ']'), 'local row')`;

describe("standalone Search result-detail text", () => {
	it("recovers the native witness and emits the same guarded read for HQ and the suite", () => {
		const parsed = readResultDetailText(formula);
		expect(parsed).toEqual({
			inputName: "detail_marker",
			prefix: "entered=[",
			suffix: "]",
			localText: "local row",
		});
		if (!parsed) throw new Error("The native witness was not read.");
		const suite = serializeWire(resultDetailTextWire(parsed), {
			target: "suite",
		});
		expect([...suite.instances].map((one) => one.id)).toEqual([
			"search-input:results",
		]);
		expect(readResultDetailText(suite.text)).toEqual(parsed);
		const hq = serializeWire(resultDetailTextWire(parsed), {
			target: "hq-json",
			interpolation: "no-dots",
		});
		expect(readResultDetailText(hq.text)).toEqual(parsed);
	});

	it.each([
		`if(${roster}, concat('entered=[', string(${prompt}), ']'), 'local row')`,
		formula.replace("../results", "../casedb"),
		formula.replace("search-input:results", "search-input:results:inline"),
		formula.replace(
			`count(${prompt})`,
			"count(instance('search-input:results')/input/field)",
		),
		formula.replace(
			`count(${prompt})`,
			`count(${prompt.replace("detail_marker", "different_prompt")})`,
		),
		formula.replace("'local row'", `string(${prompt})`),
	])("does not recover a different scope or unguarded read", (text) => {
		expect(readResultDetailText(text)).toBeUndefined();
	});
});
