/**
 * `formRootReadPositions` reads a read of the form's root alone through
 * Nova's XPath grammar: a path whose steps are the one name `data` from the
 * root, wherever it stands, and never a path that goes on below the root.
 */

import { describe, expect, it } from "vitest";
import { formRootReadPositions } from "../dependencies";

describe("formRootReadPositions", () => {
	it.each([
		["count(/data)", [6]],
		["string(/data)", [7]],
		["/data", [0]],
		["/data[1]", [0]],
		["if(/data/a, /data, 2)", [12]],
		["/data/a[/data = 1]", [8]],
	])("reads %s as a read of the form's root", (expr, positions) => {
		expect(formRootReadPositions(expr)).toEqual(positions);
	});

	it.each([
		"/data/a",
		"/data/@name",
		"/data[1]/a",
		"/data//a",
		"//data",
		"../data",
		"current()/data",
		"#form/a",
		"/database",
		"/",
		"count(/data/rows)",
		"instance('casedb')/casedb/case/@case_id",
		"",
	])("does not read %s as a read of the form's root", (expr) => {
		expect(formRootReadPositions(expr)).toEqual([]);
	});

	it("names each read of the root once", () => {
		expect(formRootReadPositions("count(/data) + count(/data)")).toEqual([
			6, 21,
		]);
	});
});
