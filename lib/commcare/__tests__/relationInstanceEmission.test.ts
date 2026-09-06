import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import {
	relationInstanceFixture,
	relationInstanceScenarios,
} from "./relationInstanceFixture";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

// Assembly contract only. RelationInstanceRuntimeTest parses, opens and submits
// both carriers against native case data, including the retained pre-fix failure.
it.each(relationInstanceScenarios)(
	"declares the %s consumer's instances in both XForm sources",
	(scenario) => {
		const doc = relationInstanceFixture(scenario);
		const hq = expandDoc(doc);
		const source = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
		if (typeof source !== "string") throw new Error("Missing source XForm");
		const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
		for (const xml of [source, zip.readAsText("modules-0/forms-0.xml")]) {
			const root = readXmlEvidence(xml);
			const head = onlyXml(xmlChildren(root, "head"));
			const model = onlyXml(
				head.children.filter(
					(node) =>
						node.name === "model" &&
						node.uri === "http://www.w3.org/2002/xforms",
				),
			);
			expect(
				xmlChildren(model, "instance")
					.filter((node) => node.attributes.src)
					.map((node) => node.attributes),
			).toEqual([
				{ id: "casedb", src: "jr://instance/casedb" },
				{ id: "commcaresession", src: "jr://instance/session" },
			]);
		}
	},
);
