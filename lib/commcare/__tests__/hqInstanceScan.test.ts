/**
 * The two readings of CommCare HQ's instance pattern Nova makes, as functions
 * of their input, and the two writers that cut a literal where the pattern
 * could start.
 *
 * `instanceScanRead` is held to `proof/hq/fixtures/hq-instance-scan-vectors.json`,
 * whose `hqReads` column the lane holds to HQ's own `get_instance_names`
 * (`proof/hq/test_instance_text.py`): Nova refuses exactly the rows marked
 * refused, and every row HQ reads a name in is one. `instanceScanCuts` is held
 * to its offsets, and the XForm writers to leaving no `instance(` followed by
 * a quote mark in the decoded source, for a label's text and a literal in a
 * formula alike. This file restates no HQ behavior; what HQ's build does with
 * the result is the lane's. Plausible failures: a text HQ reads that Nova
 * admits; the offered spelling refused; text typed as `&apos;` refused; a cut
 * at the wrong offset; a writer that skips a cut.
 */
import { isTag, isText } from "domhandler";
import { decodeHTML } from "entities";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import vectors from "../../../proof/hq/fixtures/hq-instance-scan-vectors.json";
import { expandDoc } from "../expander";
import { instanceScanCuts, instanceScanRead } from "../hqInstanceScan";
import { runValidation } from "../validator/runner";
import { DERIVED_WIRE_IDENTITY } from "../wireIdentity";
import { parseXml } from "../xmlParse";

describe("instanceScanRead", () => {
	it.each(vectors.rows)(
		"answers $text exactly where Nova refuses it",
		(row) => {
			expect(instanceScanRead(row.text) !== undefined).toBe(row.refused);
		},
	);

	it("refuses every row HQ reads a name in", () => {
		for (const row of vectors.rows)
			if (row.hqReads.length > 0) expect(row.refused, row.text).toBe(true);
	});

	it("answers the first text HQ's pattern reads, from instance( to the bracket", () => {
		expect(instanceScanRead("Read instance('a') and instance('b')")).toBe(
			"instance('a')",
		);
		expect(instanceScanRead('x instance( "b-c:d"\u0085) y')).toBe(
			'instance( "b-c:d"\u0085)',
		);
		expect(instanceScanRead("plain text")).toBeUndefined();
	});
});

describe("instanceScanCuts", () => {
	it.each([
		["instance('a')", [8]],
		['instance("a', [8]],
		["instance( \t'a')", [8]],
		["instance(\u001c'a')", [8]],
		["instance(\u0085'a')", [8]],
		["instance( 'a')", [8]],
		["Read instance('a') and instance(\"b\")", [13, 31]],
		["instance ('a')", []],
		["Instance('a')", []],
		["instance(a)", []],
		["instance(&apos;a&apos;)", []],
		["", []],
	])("cuts %j at %j", (value, cuts) => {
		expect(instanceScanCuts(value)).toEqual(cuts);
	});

	it("cuts wherever the whole pattern could match", () => {
		for (const row of vectors.rows)
			if (instanceScanRead(row.text) !== undefined)
				expect(instanceScanCuts(row.text).length, row.text).toBeGreaterThan(0);
	});
});

describe("the XForm writers", () => {
	const FORM = testUuid("instance-scan-form");
	const TEXT = "Ask instance('nova_absent') and instance( \"casedb\")";
	/* A form literal holds one kind of quote mark. */
	const LITERAL = "Copy instance('nova_absent') and instance( 'casedb')";
	const doc = buildDoc({
		appName: "Instance scan",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						uuid: "instance-scan-form",
						name: "Practice",
						type: "survey",
						fields: [
							{ kind: "text", id: "notes", label: proseText(TEXT) },
							{
								kind: "hidden",
								id: "copy",
								calculate: term(literal(LITERAL)),
							},
						],
					},
				],
			},
		],
	});
	const source = expandDoc(doc, { attachmentTarget: null })._attachments[
		`${DERIVED_WIRE_IDENTITY.formUniqueId(FORM)}.xml`
	];

	it("admits the label and the literal", () => {
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("leaves no instance( before a quote mark in the decoded source", () => {
		expect(source).toBeDefined();
		const decoded = decodeHTML(source ?? "");
		expect(instanceScanCuts(decoded)).toEqual([]);
		expect(instanceScanRead(decoded)).toBeUndefined();
	});

	it("writes a label's bracket as a literal output after the word, and keeps every other character", () => {
		const values: string[][] = [];
		const walk = (node: ReturnType<typeof parseXml>["children"][number]) => {
			if (!isTag(node)) return;
			if (
				node.name === "value" &&
				node.attribs.form === undefined &&
				node.children.some(
					(child) => isText(child) && child.data.includes("nova_absent"),
				)
			)
				values.push(
					node.children.map((child) =>
						isText(child)
							? child.data
							: isTag(child) && child.name === "output"
								? `<output value=${child.attribs.value}>`
								: "?",
					),
				);
			for (const child of node.children) walk(child);
		};
		for (const child of parseXml(source ?? "").children) walk(child);
		expect(values).toEqual([
			[
				"Ask instance",
				"<output value='('>",
				"'nova_absent') and instance",
				"<output value='('>",
				' "casedb")',
			],
		]);
	});
});
