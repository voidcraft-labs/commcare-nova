/**
 * A default's form reads print relative to the question it sets, and a
 * registration form reads its own new case's id from its entry's datum.
 * Core's reading of each placement is `ContainerRuntimeTest.java`'s, on the
 * local form and on HQ's regenerated form; this suite holds Nova's output.
 */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { containerWireFixture } from "./containerWireFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

function forms(scenario: "init-add" | "registration"): [string, Element[]][] {
	const doc = containerWireFixture(scenario);
	const hq = expandDoc(doc);
	const source = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing form source");
	const local = new AdmZip(
		compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
	).readAsText("modules-0/forms-0.xml");
	return [
		["form source", source],
		["local form", local],
	].map(([name, xml]) => [
		name,
		findAll(() => true, parseDocument(xml, { xmlMode: true }).children),
	]);
}

const setvalue = (elements: Element[], ref: string) => {
	const found = elements.filter(
		(element) => element.name === "setvalue" && element.attribs.ref === ref,
	);
	expect(found).toHaveLength(1);
	return found[0].attribs;
};

describe.each(forms("init-add"))(
	"a default's form reads, %s",
	(_, elements) => {
		it.each([
			["at the root", "/data/root_read", "current()/../zone", "xforms-ready"],
			[
				"in a repeat row, reading an answer outside the repeat",
				"/data/visits/zone",
				"current()/../../zone",
				"jr-insert",
			],
			[
				"in a repeat row, reading a sibling in the row",
				"/data/visits/sibling_read",
				"current()/../zone",
				"jr-insert",
			],
			[
				"in a nested repeat row, reading the enclosing row's answer",
				"/data/visits/assets/item/enclosing_read",
				"current()/../../../zone",
				"jr-insert",
			],
		])(
			"%s print relative to the question with no shadow",
			(_, ref, value, event) => {
				const attribs = setvalue(elements, ref);
				expect(attribs.value).toBe(value);
				expect(attribs.event).toBe(event);
				expect(attribs["vellum:value"]).toBeUndefined();
			},
		);
	},
);

describe.each(forms("registration"))(
	"a registration form's reads of its new case's id, %s",
	(_, elements) => {
		const session =
			"instance('commcaresession')/session/data/case_id_new_patient_0";

		it("read the datum the entry mints the id into", () => {
			expect(setvalue(elements, "/data/page/own_id_read").value).toBe(session);
			const calculate = elements.filter(
				(element) =>
					element.name === "bind" &&
					element.attribs.nodeset === "/data/page/tracking_code",
			);
			expect(calculate.map((bind) => bind.attribs.calculate)).toEqual([
				`concat('P-', ${session})`,
			]);
		});

		it("declare the session and the case database", () => {
			const declared = elements
				.filter(
					(element) =>
						element.name === "instance" &&
						element.parent !== null &&
						isTag(element.parent) &&
						element.parent.name === "model",
				)
				.map((element) => element.attribs.id)
				.filter((id) => id !== undefined);
			expect(declared).toEqual(
				expect.arrayContaining(["casedb", "commcaresession"]),
			);
		});
	},
);
