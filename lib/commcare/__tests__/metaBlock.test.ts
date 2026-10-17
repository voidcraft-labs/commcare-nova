/** The meta block's location capture and pollsensor, read through an XML parser. Pure. */
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildXForm } from "@/lib/commcare/xform/builder";
import { addMetaBlock } from "@/lib/commcare/xform/metaBlock";
import type { FieldKind } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { connectWireFixtures } from "./connectWireFixtures";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import {
	onlyXml,
	readXmlEvidence,
	type XmlEvidence,
	xmlChildren,
} from "./xmlEvidence";

const XFORMS = "http://www.w3.org/2002/xforms";
const ORX = "http://openrosa.org/jr/xforms";
const CC = "http://commcarehq.org/xforms";

/** A one-form survey whose only question is of `kind`, as its source XForm. */
function surveyForm(kind: FieldKind): string {
	const doc = buildDoc({
		appName: "Survey",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [f({ kind, id: "answer", label: proseText("Answer") })],
					},
				],
			},
		],
	});
	return buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], {
		xmlns: "http://openrosa.org/formdesigner/meta-block-evidence",
	});
}

function model(xml: string): XmlEvidence {
	const html = readXmlEvidence(xml);
	const head = html.children.find((node) => node.name === "head");
	if (head === undefined) throw new Error("The form has no head.");
	return onlyXml(
		head.children.filter(
			(node) => node.name === "model" && node.uri === XFORMS,
		),
	);
}

function meta(xml: string): XmlEvidence {
	const instance = onlyXml(
		xmlChildren(model(xml), "instance").filter((node) => !node.attributes.id),
	);
	return onlyXml(
		onlyXml(instance.children).children.filter(
			(node) => node.name === "meta" && node.uri === ORX,
		),
	);
}

function pollsensors(xml: string): XmlEvidence[] {
	return model(xml).children.filter(
		(node) => node.name === "pollsensor" && node.uri === ORX,
	);
}

describe("addMetaBlock's location capture", () => {
	it("captures the location as HQ's build does: the node last in meta, then the pollsensor and its bind last in the model", () => {
		for (const kind of ["text", "geopoint"] as const) {
			const xml = addMetaBlock(surveyForm(kind), { captureLocation: true });
			const location = meta(xml).children.at(-1);
			expect([location?.name, location?.uri]).toEqual(["location", CC]);
			expect(meta(xml).children.at(-2)?.name).toBe("drift");
			const tail = model(xml).children.slice(-2);
			expect(tail.map((node) => [node.name, node.attributes])).toEqual([
				["pollsensor", { event: "xforms-ready", ref: "/data/meta/location" }],
				["bind", { nodeset: "/data/meta/location", type: "geopoint" }],
			]);
			// One pollsensor, the capturing one, even beside a GPS question.
			expect(pollsensors(xml)).toHaveLength(1);
		}
	});

	it("starts a bare poll for a GPS question when capture is off, and none without one", () => {
		const gps = addMetaBlock(surveyForm("geopoint"));
		expect(model(gps).children.at(-1)?.name).toBe("pollsensor");
		expect(pollsensors(gps).map((node) => node.attributes)).toEqual([
			{ event: "xforms-ready" },
		]);
		expect(meta(gps).children.some((node) => node.name === "location")).toBe(
			false,
		);

		const text = addMetaBlock(surveyForm("text"));
		expect(pollsensors(text)).toEqual([]);
		expect(meta(text).children.some((node) => node.name === "location")).toBe(
			false,
		);
	});

	it("captures the location in a Connect app's local archive and in no other", () => {
		for (const { name, doc } of connectWireFixtures()) {
			const zip = new AdmZip(
				compileCcz(expandDoc(doc), doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			);
			const xml = zip.readAsText("modules-0/forms-0.xml");
			expect(
				pollsensors(xml).map((node) => node.attributes.ref),
				name,
			).toEqual(doc.connectType === null ? [] : ["/data/meta/location"]);
		}
	});
});
