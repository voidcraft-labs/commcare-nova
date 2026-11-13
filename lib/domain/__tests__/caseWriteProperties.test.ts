/**
 * A case write's property takes the catalog's grammar: a letter first, then
 * letters, digits, underscores and hyphens, and `category` and `state` are
 * ordinary properties. `location_id` and `hq_user_id` stay refused, because
 * CommCare HQ stores each somewhere other than the property. A hyphenated
 * property is a leaf `FormPath` names in both places a write lands: the local
 * archive's basic case block and a Save to Case block of the source.
 */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { basicForm } from "@/lib/commcare/__tests__/hqBasicShape";
import {
	own,
	placementFixture,
	read,
} from "@/lib/commcare/__tests__/placementFixture";
import { TEST_RUNTIME_TARGET } from "@/lib/commcare/__tests__/runtimeTargetFixture";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation, Expression } from "@/lib/domain";
import { concat, literal, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";

const SAVED = ["first-name", "state", "category"] as const;

/** A follow-up whose own case saves `properties`, each from the `name`
 *  answer: as it stands, which Case Management keeps, or computed, which a
 *  Save to Case block keeps. */
function followup(
	properties: readonly string[],
	value: (property: string) => Expression,
): BlueprintDoc {
	const { doc } = placementFixture("followup", {
		operations: () => [
			own({
				writes: properties.map((property) => ({
					property,
					value: value(property),
				})),
			} as Partial<CaseOperation>),
		],
	});
	const patient = doc.caseTypes?.find((type) => type.name === "patient");
	if (patient === undefined) throw new Error("no patient type");
	for (const property of properties)
		patient.properties.push({ name: property, label: proseText(property) });
	return doc;
}

const asItStands = () => read("name");

/** The gate's codes, less the empty surveys the fixture's other menus hold. */
const codes = (doc: BlueprintDoc) =>
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)
		.map((finding) => finding.code)
		.filter((code) => code !== "EMPTY_FORM");
const computed = () => concat(read("name"), term(literal("!")));

function one(elements: Element[]): Element {
	expect(elements).toHaveLength(1);
	return elements[0] as Element;
}
function childNamed(element: Element, name: string): Element {
	return one(element.children.filter(isTag).filter((e) => e.name === name));
}
/** The data instance of a form's XML. */
function dataOf(xml: string): Element {
	new SaxesParser({ xmlns: true }).write(xml).close();
	const root = one(
		parseDocument(xml, { xmlMode: true }).children.filter(isTag),
	);
	const model = childNamed(childNamed(root, "h:head"), "model");
	return childNamed(
		one(
			model.children
				.filter(isTag)
				.filter((e) => e.name === "instance" && !e.attribs.src),
		),
		"data",
	);
}
/** Every element under `root` named `name`, at any depth. */
function descendants(root: Element, name: string): Element[] {
	const found: Element[] = [];
	const walk = (element: Element) => {
		for (const child of element.children.filter(isTag)) {
			if (child.name === name) found.push(child);
			walk(child);
		}
	};
	walk(root);
	return found;
}
const leaves = (update: Element) =>
	update.children.filter(isTag).map((leaf) => leaf.name);

describe("a case write's property", () => {
	it("admits hyphens, state and category at the gate", () => {
		expect(codes(followup(SAVED, asItStands))).toEqual([]);
		expect(codes(followup(SAVED, computed))).toEqual([]);
	});

	it.each(["location_id", "hq_user_id"])(
		"refuses %s at the gate",
		(property) => {
			expect(codes(followup([property], asItStands))).toContain(
				"CASE_OPERATION_RESERVED_PROPERTY",
			);
		},
	);

	it("names the leaf in Case Management's update and the local archive's case block", () => {
		const doc = followup(SAVED, asItStands);
		const hq = expandDoc(doc);
		const form = basicForm(hq, 0, 0);
		expect(Object.keys(form.actions.update_case.update).sort()).toEqual(
			[...SAVED].sort(),
		);
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
		);
		const update = childNamed(
			childNamed(dataOf(zip.readAsText("modules-0/forms-0.xml")), "case"),
			"update",
		);
		expect(leaves(update)).toEqual(["category", "first-name", "state"]);
	});

	it("names the leaf in a Save to Case block of the source", () => {
		const doc = followup(SAVED, computed);
		const hq = expandDoc(doc);
		const form = basicForm(hq, 0, 0);
		const source = hq._attachments[`${form.unique_id}.xml`];
		if (typeof source !== "string") throw new Error("no source");
		const updates = descendants(dataOf(source), "case").flatMap((block) =>
			block.children.filter(isTag).filter((e) => e.name === "update"),
		);
		expect(updates.map((update) => leaves(update).sort())).toEqual([
			[...SAVED].sort(),
		]);
	});
});
