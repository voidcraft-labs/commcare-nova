/** The form version stamp moves the data root's `version` and nothing else. Pure. */
import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { buildXForm } from "@/lib/commcare/xform/builder";
import { setFormVersion } from "@/lib/commcare/xform/formVersion";
import { proseText } from "@/lib/domain/prose";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

/** The form's primary data node: the first `data` element in document order. */
function dataRoot(node: XmlEvidence): XmlEvidence {
	const pending = [node];
	for (let next = pending.shift(); next; next = pending.shift()) {
		if (next.name === "data") return next;
		pending.unshift(...next.children);
	}
	throw new Error("The form has no data node.");
}

it("sets the data root's version and leaves the rest of the form as it was", () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	const xform = buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], {
		xmlns: "http://openrosa.org/formdesigner/form-version",
	});
	const before = readXmlEvidence(xform);
	expect(dataRoot(before).attributes.version).toBe("1");
	const after = readXmlEvidence(setFormVersion(xform, 42));
	expect(dataRoot(after).attributes.version).toBe("42");
	const { version: _before, ...restBefore } = dataRoot(before).attributes;
	const { version: _after, ...restAfter } = dataRoot(after).attributes;
	expect(restAfter).toEqual(restBefore);
	dataRoot(after).attributes.version = "1";
	expect(after).toEqual(before);
});
