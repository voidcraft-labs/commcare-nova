/**
 * A control finds its data node as Core finds it (`XFormParser.parseControl`, `parseGroup`): by
 * the bind its `bind` attribute names first, else a repeat by its `nodeset` and any other control
 * by its `ref`. A control or an attribute Core does not bind by is left for the close to report,
 * so the reading never holds a node Core does not bind.
 *
 * Plausible failures: a group holding only `nodeset`, which Core reads as a group with no node of
 * its own whose children resolve from its parent, read as bound to that path, its children
 * resolved under it and printed with a `ref`; a control holding `ref` and `bind` read by its
 * `ref` while Core reads the bind's node; a bind naming its node by `ref` alone, a form no device
 * loads, held.
 */

import { describe, expect, it } from "vitest";
import { type FormReading, readForm, xformSource } from "./formReading";

/** The names of every `unrecognized` finding at a question or the form. */
function unrecognized(reading: FormReading): string[] {
	return reading.closed.findings
		.filter(
			(finding) =>
				finding.code === "unrecognized" &&
				(finding.place.kind === "question" || finding.place.kind === "form"),
		)
		.map((finding) => finding.detail.name ?? "");
}

describe("the attribute a control binds by", () => {
	it("binds no node by a group's `nodeset`, so the group is reported", async () => {
		const reading = await readForm(
			xformSource({
				data: "<g><q/></g><q/>",
				model: `<bind nodeset="/data/g/q" type="xsd:string"/><bind nodeset="/data/q" type="xsd:string"/>`,
				body: `<group nodeset="/data/g"><label>G</label><input ref="q"><label>Q</label></input></group>`,
			}),
		);
		expect(unrecognized(reading)).toContain("xform:group");
	});

	it("binds no node by a question's `nodeset`, so the question is reported", async () => {
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: `<bind nodeset="/data/q" type="xsd:string"/>`,
				body: `<input nodeset="/data/q"><label>Q</label></input>`,
			}),
		);
		expect(unrecognized(reading)).toContain("xform:input");
	});

	it("binds a question holding `ref` and `bind` by its bind, and leaves the `ref` unread", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a/><b/>",
				model: `<bind nodeset="/data/a" type="xsd:string"/><bind id="b" nodeset="/data/b" type="xsd:string"/>`,
				body: `<input ref="/data/a" bind="b"><label>B</label></input>`,
			}),
		);
		const names = unrecognized(reading);
		expect(names).toContain("xform:input@ref");
		expect(names).not.toContain("xform:input@bind");
	});
});

describe("the attribute a bind names its node by", () => {
	it("leaves a bind holding `ref` and no `nodeset` unread", async () => {
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: `<bind ref="/data/q" type="xsd:string" relevant="true()"/>`,
				body: `<input ref="/data/q"><label>Q</label></input>`,
			}),
		);
		expect(unrecognized(reading)).toContain("xform:bind");
	});
});
