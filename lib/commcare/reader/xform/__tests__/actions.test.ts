/**
 * Actions the forms stage refuses where they stand: a `setvalue`,
 * `send` or `pollsensor` nested in a group or a repeat, as in any other
 * control, and a model `setvalue` on a node no reader holds, which stands
 * under the refusal of that node where the data tree refused it. Each is one
 * finding at its place and never `unrecognized`.
 */

import { describe, expect, it } from "vitest";
import {
	type FormReading,
	readFields,
	readForm,
	unrecognizedAt,
	xformSource,
} from "./formReading";

const Q = (id: string) => `questions/${id}`;

function codes(reading: FormReading): string[] {
	return reading.closed.findings
		.map((finding) => finding.code)
		.filter((code) => code !== "unrecognized");
}

function unrecognized(reading: FormReading): string[] {
	return reading.closed.findings
		.filter(
			(finding) =>
				finding.code === "unrecognized" &&
				(finding.place.kind === "question" || finding.place.kind === "form"),
		)
		.map((finding) => finding.detail.name ?? "");
}

describe("actions nested in a container", () => {
	it("refuses a setvalue nested in a group, and a send nested in a repeat", async () => {
		const reading = await readForm(
			xformSource({
				data: `<g><a/></g><r jr:template=""><b/></r>`,
				model: `<bind nodeset="/data/g/a" type="xsd:string"/><bind nodeset="/data/r/b" type="xsd:string"/>`,
				body: `<group ref="/data/g"><label>G</label>
						<setvalue event="xforms-value-changed" ref="/data/g/a" value="1"/>
						<input ref="/data/g/a"><label>A</label></input></group>
					<group><label>R</label><repeat nodeset="/data/r">
						<send submission="s"/>
						<input ref="/data/r/b"><label>B</label></input></repeat></group>`,
			}),
		);
		expect([...new Set(codes(reading))]).toEqual([
			Q("actions-nested-inside-controls"),
		]);
		const entryOf = (name: string) =>
			[...reading.closed.claims.records()]
				.filter((record) => record.where.includes(name))
				.map((record) => record.entry);
		expect(entryOf("setvalue")).toEqual([Q("actions-nested-inside-controls")]);
		expect(entryOf("send")).toEqual([Q("actions-nested-inside-controls")]);
		expect(unrecognizedAt(reading, "g")).toEqual([]);
		expect(unrecognizedAt(reading, "r")).toEqual([]);
	});
});

describe("a setvalue on a node no reader holds", () => {
	it("stands under the refusal of the node the data tree refused", async () => {
		const reading = await readForm(
			xformSource({
				data: "<x/><x/><y/>",
				model: `<bind nodeset="/data/y" type="xsd:string"/>
					<setvalue event="xforms-ready" ref="/data/x" value="'v'"/>`,
				body: `<input ref="/data/y"><label>Y</label></input>`,
			}),
		);
		expect([...new Set(codes(reading))]).toEqual([
			Q("two-sibling-data-nodes-with-one-name"),
		]);
		expect(unrecognized(reading)).toEqual([]);
		expect(
			[...reading.closed.claims.records()]
				.filter((record) => record.where.includes("setvalue"))
				.map((record) => record.entry),
		).toEqual([Q("two-sibling-data-nodes-with-one-name")]);
	});
});

/**
 * A setvalue is read as Core reads it (`XFormParser.parseSetValueAction`): a `bind` attribute
 * names its target in place of `ref`, a relative `ref` is resolved from the document's root `/`,
 * an attribute of the name in any namespace but the form builder's is the one read, and a
 * setvalue with no `value` sets its text. Nova writes none of these, so each is the one finding
 * of a load-time value Nova does not hold, and no question takes it as its default: a reading
 * from the data root would give `ref="data/q1"` beside a group named `data` to `/data/data/q1`.
 */
describe("a setvalue Core reads otherwise than Nova writes one", () => {
	const source = (setvalue: string) =>
		xformSource({
			data: "<data><q1/></data><q1/>",
			model: `<bind nodeset="/data/data/q1" type="xsd:string"/><bind id="q1" nodeset="/data/q1" type="xsd:string"/>${setvalue}`,
			body: `<group ref="/data/data"><label>Data</label><input ref="/data/data/q1"><label>Inner</label></input></group><input ref="/data/q1"><label>Outer</label></input>`,
		});
	const defaults = (reading: FormReading) =>
		reading.xform === null
			? []
			: readFields(reading.xform).flatMap((field) =>
					field.expressions
						.filter((expression) => expression.slot === "default_value")
						.map(() => field.id),
				);

	it("holds the absolute `ref` with a `value` Nova writes as its question's default", async () => {
		const reading = await readForm(
			source(
				`<setvalue event="xforms-ready" ref="/data/data/q1" value="'x'"/>`,
			),
		);
		expect(codes(reading)).toEqual([]);
		expect(defaults(reading)).toEqual(["q1"]);
	});

	it.each([
		[
			"a relative `ref` Core resolves from the root",
			`ref="data/q1" value="'x'"`,
		],
		["a relative `ref` naming no node from the root", `ref="q1" value="'x'"`],
		[
			"a `bind` Core reads in place of `ref`",
			`ref="/data/data/q1" bind="q1" value="'x'"`,
		],
		[
			"a `ref` in another namespace before the plain one",
			`odkx:ref="/data/q1" ref="/data/data/q1" value="'x'"`,
		],
	])("refuses %s", async (_, attributes) => {
		const reading = await readForm(
			source(`<setvalue event="xforms-ready" ${attributes}/>`),
		);
		expect([...new Set(codes(reading))]).toEqual([
			Q("setvalue-event-xforms-value-changed-authored-xforms-revalidate"),
		]);
		expect(defaults(reading)).toEqual([]);
	});

	it("refuses a setvalue with no `value`, whose text Core sets as a literal", async () => {
		const reading = await readForm(
			source(
				`<setvalue event="xforms-ready" ref="/data/data/q1">uuid()</setvalue>`,
			),
		);
		expect([...new Set(codes(reading))]).toEqual([
			Q("setvalue-event-xforms-value-changed-authored-xforms-revalidate"),
		]);
		expect(defaults(reading)).toEqual([]);
	});
});
