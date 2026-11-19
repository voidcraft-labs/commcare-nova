/**
 * The uses a search filter row's text makes, as the claim log records them.
 *
 * Contract: a row's read of the Search fields' answers is the class read while
 * the query is built, since the device works out every `_xpath_query` row with
 * the answers before it sends the search, beside each CSQL word the row sends.
 * The failure it catches: a row's `instance('search-input:results')` read left
 * out of the claim log, so the entry its class names is counted by no reading.
 *
 * Contract: the CSQL a row is used for is each text it can send HQ's search, as
 * Core's `xpathStrings` reads the row (`proof/core/.../Shapes.java::strings`,
 * the reading the proof lane's manifest check takes): every branch of each
 * `if()`, each `concat()` combination in Core's order cut at 256 texts, and no
 * other text; a key is a use in each class those texts give it. The failures it
 * catches: a key claimed from a text no device sends, a branch of the quote
 * cascade around a value left out, a key in a second class claimed in the first
 * alone, and a text past Core's cut claimed.
 */
import { describe, expect, it } from "vitest";
import { readFormSyntax } from "../../syntaxRead";
import { expressionSurfaceUses } from "../surfaceUses";
import { csqlVectorDoc, rowContext } from "./csqlVectors";

const QUERY_BUILD =
	"expressions-and-data/search-input-results-and-legacy-search-input-read-while-the";

function uses(text: string) {
	const read = readFormSyntax(text);
	if (!read.ok || read.node === undefined)
		throw new Error("The row's text did not read.");
	return expressionSurfaceUses(
		read.node,
		undefined,
		rowContext(csqlVectorDoc()),
		"csql",
	);
}

describe("a search filter row's uses", () => {
	it.each([
		"concat(\"village = '\", instance('search-input:results')/input/field[@name = 'region'], \"'\")",
		"concat(\"village = '\", instance('search-input')/input/field[@name = 'region'], \"'\")",
	])(
		"claims the read of the answers in %s as read while the query is built",
		(text) => {
			expect(uses(text)).toContainEqual({
				key: "instance-scheme:search-input",
				entryId: QUERY_BUILD,
			});
		},
	);

	it("claims no answers' read in a row that reads none", () => {
		expect(uses("\"village = 'north'\"").map((use) => use.key)).not.toContain(
			"instance-scheme:search-input",
		);
	});

	it("claims what every branch of the quote cascade around a value sends, `match-none()` included", () => {
		const value =
			"instance('search-input:results')/input/field[@name = 'region']";
		const keys = uses(
			`if(contains(${value}, '"'), if(contains(${value}, "'"), 'match-none()', concat("village = '", ${value}, "'")), concat('village = "', ${value}, '"'))`,
		).map((use) => use.key);
		expect(keys).toContain("csql-fn:match-none");
		expect(keys).toContain("csql-op:=");
	});

	it("claims a key in each class the row's texts use it in", () => {
		const ops = uses(
			"if(instance('commcaresession')/session/context/username = 'demo', \"village = ''\", \"village = 'north'\")",
		).filter((use) => use.key === "csql-op:=");
		expect(new Set(ops.map((use) => use.entryId)).size).toBe(2);
	});

	it("claims each key the first 256 texts send, in Core's order, and none only a later text sends", () => {
		// `age > …` is each text after the first half: the 129th to the 256th of 256 texts with
		// seven digits, and past the 256th of 512 with eight.
		const keys = (digits: number) =>
			uses(
				`concat(if(true(), 'age = ', 'age > '), ${Array.from({ length: digits }, () => "if(true(), '1', '2')").join(", ")})`,
			).map((use) => use.key);
		expect(keys(7)).toEqual(expect.arrayContaining(["csql-op:=", "csql-op:>"]));
		expect(keys(8)).toContain("csql-op:=");
		expect(keys(8)).not.toContain("csql-op:>");
	});
});
