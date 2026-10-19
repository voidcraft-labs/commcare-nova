/**
 * Each secondary instance a form's logic, Connect block or after-submit link
 * reads is declared where CommCare evaluates the read: on the form's XForm
 * for its questions and Connect block, and on the source entry of the suite
 * for a link, whose condition runs in the source session
 * (`CommCareSession.java::getEvaluationContext`, `entry.getInstances`).
 *
 * The emitted artifacts are read with an independent XML reader. HQ decides
 * that a form reads a data table by the literal text
 * `src="jr://fixture/item-list:` in its source (`FormBase.has_fixtures`), so
 * that check reads the source's bytes as HQ does.
 */

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqApplication } from "@/lib/commcare/types";
import { INSTANCE_READS, instanceReadFixture } from "./instanceReadFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

function* walk(node: XmlEvidence): Generator<XmlEvidence> {
	yield node;
	for (const child of node.children) yield* walk(child);
}

/** The `<instance id src>` declarations directly under one element. */
function declarations(node: XmlEvidence): Record<string, string> {
	return Object.fromEntries(
		node.children
			.filter((child) => child.name === "instance" && child.attributes.src)
			.map((child) => [child.attributes.id, child.attributes.src]),
	);
}

/** Each form's HQ source, by its form name. */
function sources(hq: HqApplication): Map<string, string> {
	const byName = new Map<string, string>();
	for (const module of hq.modules)
		for (const form of module.forms) {
			const source = hq._attachments[`${form.unique_id}.xml`];
			if (typeof source === "string")
				byName.set(Object.values(form.name)[0] ?? "", source);
		}
	return byName;
}

/** A form source's `<model>` secondary instances. */
function modelDeclarations(source: string): Record<string, string> {
	const model = [...walk(readXmlEvidence(source))].find(
		(node) => node.name === "model",
	);
	if (model === undefined) throw new Error("The form has no model.");
	return declarations(model);
}

/** The bind calculates of one form source, by node path. */
function calculates(source: string): Map<string, string> {
	return new Map(
		[...walk(readXmlEvidence(source))]
			.filter((node) => node.name === "bind" && node.attributes.calculate)
			.map((node) => [node.attributes.nodeset, node.attributes.calculate]),
	);
}

describe("form logic and Connect reads declare their instances in the XForm", () => {
	const { doc, naming } = instanceReadFixture();
	const forms = sources(expandDoc(doc, { lookupNaming: naming }));
	const visit = forms.get("Visit") ?? "";

	it("declares a data table by its tag and places by their fixture", () => {
		expect(modelDeclarations(visit)).toEqual({
			casedb: "jr://instance/casedb",
			commcaresession: "jr://instance/session",
			locations: "jr://fixture/locations",
			regions: "jr://fixture/item-list:regions",
		});
		expect(Object.fromEntries(calculates(visit))).toMatchObject(
			Object.fromEntries([
				[
					"/data/region_label",
					"instance('regions')/regions_list/regions[value = 'north'][1]/label",
				],
				[
					"/data/region_count",
					"count(instance('regions')/regions_list/regions)",
				],
				[
					"/data/region_labels",
					"join(' ', instance('regions')/regions_list/regions/label)",
				],
				[
					"/data/clinic_name",
					"instance('locations')/locations/location[@type = 'clinic']/name",
				],
				[
					"/data/district_of_clinics",
					"instance('locations')/locations/location/@district_id",
				],
				[
					"/data/visit/deliver/entity_name",
					"instance('regions')/regions_list/regions[value = 'south'][1]/label",
				],
			]),
		);
	});

	it("writes the table's source with the double quotes HQ's build check reads", () => {
		expect(visit).toContain('src="jr://fixture/item-list:regions"');
	});

	it("reads a question's own text and a choice's label with no instance", () => {
		const read = calculates(visit);
		expect(read.get("/data/color_label")).toBe(
			"jr:choice-name(/data/color, '/data/color')",
		);
		expect(read.get("/data/color_text")).toBe("jr:itext('color-label')");
		const itext = [...walk(readXmlEvidence(visit))].filter(
			(node) => node.name === "text" && node.attributes.id === "color-label",
		);
		expect(itext).toHaveLength(1);
	});

	it("declares the chosen cases under the several-case datum's own id", () => {
		const batch = forms.get("Batch note") ?? "";
		expect(modelDeclarations(batch)).toEqual({
			selected_cases: "jr://instance/selected-entities/selected_cases",
		});
		expect(calculates(batch).get("/data/chosen")).toBe(
			"count(instance('selected_cases')/results/value)",
		);
	});

	it("declares what the search found in a search-first module's form", () => {
		const checkIn = forms.get("Check in") ?? "";
		expect(modelDeclarations(checkIn)).toEqual({
			"results:inline": "jr://instance/remote/results:inline",
		});
		expect(calculates(checkIn).get("/data/found")).toBe(
			"count(instance('results:inline')/results/case[not(commcare_is_related_case = true())])",
		);
	});
});

describe("a link's reads are declared on its source entry", () => {
	function suite(withPlaceLink: boolean) {
		const { doc, naming, fixtures } = instanceReadFixture();
		const visit = doc.forms[INSTANCE_READS.visitForm];
		if (!withPlaceLink)
			visit.formLinks = visit.formLinks?.filter(
				(link) => link.uuid !== INSTANCE_READS.placeLink,
			);
		const hq = expandDoc(doc, { lookupNaming: naming });
		const zip = new AdmZip(
			compileCcz(hq, doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
				lookup: { naming, fixtures },
			}),
		);
		const formXmlns = new Map(
			[...sources(hq)].map(([name, source]) => [
				name,
				[...walk(readXmlEvidence(source))].find((node) => node.name === "data")
					?.attributes.xmlns,
			]),
		);
		const entries = [
			...walk(readXmlEvidence(zip.readAsText("suite.xml"))),
		].filter((node) => node.name === "entry");
		const entryOf = (name: string) => {
			const entry = entries.find((node) =>
				node.children.some(
					(child) =>
						child.name === "form" && child.text === formXmlns.get(name),
				),
			);
			if (entry === undefined) throw new Error(`No entry for ${name}`);
			return declarations(entry);
		};
		return { hq, entryOf };
	}

	it("prints a link's table read with the suite's fixture id", () => {
		const { hq, entryOf } = suite(false);
		const links = hq.modules
			.flatMap((module) => module.forms)
			.flatMap((form) => form.form_links.map((link) => link.xpath));
		expect(links).toEqual([
			"count(instance('item-list:regions')/regions_list/regions) > 0",
			"count(instance('results:inline')/results/case[not(commcare_is_related_case = true())]) > 1",
		]);
		expect(entryOf("Visit")).toMatchObject({
			"item-list:regions": "jr://fixture/item-list:regions",
		});
		expect(entryOf("Check in")).toMatchObject({
			"results:inline": "jr://instance/remote/results:inline",
		});
	});

	it("declares places on the source entry of a link that reads them", () => {
		const { entryOf } = suite(true);
		expect(entryOf("Visit")).toMatchObject({
			locations: "jr://fixture/locations",
		});
	});
});
