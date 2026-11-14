/**
 * Actions the forms stage refuses where they stand (11.2): a `setvalue`,
 * `send` or `pollsensor` nested in a group or a repeat, as in any other
 * control, and a model `setvalue` on a node no reader holds, which stands
 * under the refusal of that node where the data tree refused it. Each is one
 * finding at its place and never `unrecognized`.
 */

import { describe, expect, it } from "vitest";
import {
	type FormReading,
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
