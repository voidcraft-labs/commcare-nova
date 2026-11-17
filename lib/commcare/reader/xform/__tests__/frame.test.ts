/**
 * What a form's model holds beside its instances, binds, setvalues and itext,
 * read through the form's stages. A `send` and the submission it names
 * are refused together, and a `send` that names no submission of the model is
 * a model child no reader knows; only the OpenRosa `pollsensor` is the
 * authored one; text directly in the model is refused, never left
 * `unrecognized`. It would catch a construct of the model reported under
 * another entry than the one whose sentence names it, or left unclaimed.
 */

import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/publish/hqFindings";
import { formFindings, readForm, xformSource } from "./formReading";

const Q = (id: string) => `questions/${id}`;

/** The codes of the findings at the form itself. */
async function formCodes(model: string): Promise<string[]> {
	const reading = await readForm(
		xformSource({
			data: "<q/>",
			model: `<bind nodeset="/data/q" type="xsd:string"/>${model}`,
			body: '<input ref="/data/q"/>',
		}),
	);
	return formFindings(reading)
		.filter((finding: Finding) => finding.place.kind === "form")
		.map((finding) => finding.code);
}

describe("the model's other children", () => {
	it("refuses a send and the submission it names together", async () => {
		expect(
			await formCodes(
				'<submission id="out" resource="http://example.org" targetref="/data/q"/><send submission="out"/>',
			),
		).toEqual([Q("send-submission")]);
	});

	it("reads a send that names no submission of the model as a model child no reader knows", async () => {
		expect(await formCodes('<send submission="elsewhere"/>')).toEqual([
			Q("unknown-xforms-namespace-model-children-text-in-model"),
		]);
	});

	it("refuses the OpenRosa pollsensor as authored, and one in the XForms namespace as unknown", async () => {
		expect(await formCodes('<orx:pollsensor event="xforms-ready"/>')).toEqual([
			Q("authored-orx-pollsensor"),
		]);
		expect(await formCodes('<pollsensor event="xforms-ready"/>')).toEqual([
			Q("unknown-xforms-namespace-model-children-text-in-model"),
		]);
	});

	it("refuses text directly in the model, and leaves no part of it unrecognized", async () => {
		expect(await formCodes("stray words")).toEqual([
			Q("unknown-xforms-namespace-model-children-text-in-model"),
		]);
	});
});
