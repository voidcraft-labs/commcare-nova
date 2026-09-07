import AdmZip from "adm-zip";
import { expect, it } from "vitest";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import { csqlQuoteFixture } from "./csqlQuoteFixture";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

// Artifact assembly only. CsqlQuoteRuntimeTest owns real input/guard execution;
// quote-payload-proof.py checks the resulting complete queries with native HQ.
it("carries all six guarded queries and their two error prompts into both export paths", () => {
	const doc = csqlQuoteFixture();
	const hq = expandDoc(doc);
	const archive = new AdmZip(compileCcz(hq, doc.appName, doc));
	const suite = readXmlEvidence(archive.readAsText("suite.xml"));
	const request = onlyXml(xmlChildren(suite, "remote-request"));
	const query = onlyXml(
		xmlChildren(onlyXml(xmlChildren(request, "session")), "query"),
	);
	const defaults = hq.modules[0].search_config.default_properties;
	expect(defaults).toHaveLength(6);
	expect(xmlChildren(query, "data").map((node) => node.attributes)).toEqual([
		{ key: "case_type", ref: "'patient'" },
		...defaults.map((property) => ({
			key: "_xpath_query",
			ref: property.defaultValue,
		})),
	]);
	const prompts = xmlChildren(query, "prompt");
	expect(prompts.map((node) => node.attributes)).toEqual([
		{ key: "query", exclude: "true()" },
		{ key: "suffix", exclude: "true()" },
	]);
	for (const [index, prompt] of prompts.entries()) {
		const property = hq.modules[0].search_config.properties[index];
		const rules = property.validations;
		if (!rules) throw new Error("Missing quote validation");
		expect(rules).toHaveLength(1);
		const validation = onlyXml(xmlChildren(prompt, "validation"));
		expect(validation.attributes).toEqual({
			test: rules[0].test,
		});
		const locale = onlyXml(
			xmlChildren(onlyXml(xmlChildren(validation, "text")), "locale"),
		);
		expect(locale.attributes).toEqual({
			id: `search_property.m0.${property.name}.validation.0.text`,
		});
		expect(archive.readAsText("default/app_strings.txt").split("\n")).toContain(
			`${locale.attributes.id}=This search can't use both single and double quotation marks. Remove one kind and try again`,
		);
	}
});
