import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import { proseWhitespaceFixture } from "./proseWhitespaceFixture";
import { onlyXml, readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

function descendants(node: XmlEvidence, name: string): XmlEvidence[] {
	return [
		...(node.name === name ? [node] : []),
		...node.children.flatMap((child) => descendants(child, name)),
	];
}

describe("exported prose whitespace", () => {
	it("keeps literal separators between reference outputs in every text form and language on both export paths", () => {
		const doc = proseWhitespaceFixture();
		const hq = expandDoc(doc);
		const source = Object.values(hq._attachments)[0];
		if (typeof source !== "string") throw new Error("Missing HQ form source.");
		const archive = new AdmZip(compileCcz(hq, doc.appName, doc));
		for (const [path, xml] of [
			["HQ source", source],
			["local CCZ", archive.readAsText("modules-0/forms-0.xml")],
		] as const) {
			const translations = descendants(readXmlEvidence(xml), "translation");
			expect(translations.map((entry) => entry.attributes.lang)).toEqual([
				"en",
				"es",
			]);
			for (const translation of translations) {
				for (const [id, values] of [
					[
						"delivery_context-label",
						["/data/meals", "'\n\n'", "/data/address"],
					],
					["space-label", ["/data/meals", "' '", "/data/address"]],
					[
						"xml_whitespace-label",
						["/data/meals", "'\t \r\n'", "/data/address"],
					],
					[
						"edge_whitespace-label",
						["' \t'", "/data/meals", "'\n '", "/data/address", "'\t '"],
					],
					["checked-hint", ["/data/meals", "'\n\n'", "/data/address"]],
					["checked-help", ["/data/meals", "' '", "/data/address"]],
					["checked-constraintMsg", ["/data/meals", "'\t'", "/data/address"]],
					["choose-opt0-label", ["/data/meals", "'\n\n'", "/data/address"]],
				] as const) {
					const entry = onlyXml(
						translation.children.filter((node) => node.attributes.id === id),
					);
					expect(entry.children.map((value) => value.attributes.form)).toEqual([
						undefined,
						"markdown",
					]);
					for (const value of entry.children) {
						expect(value.children.map((output) => output.name)).toEqual(
							values.map(() => "output"),
						);
						expect(
							value.children.map((output) => output.attributes.value),
						).toEqual(values);
						for (const output of value.children) {
							if (output.attributes.value.startsWith("'")) {
								expect(output.attributes).toEqual({
									value: output.attributes.value,
								});
							} else if (path === "HQ source") {
								expect(output.attributes["vellum:value"]).toBe(
									output.attributes.value.replace("/data/", "#form/"),
								);
							} else {
								expect(output.attributes).toEqual({
									value: output.attributes.value,
								});
							}
						}
						const prefix =
							id === "delivery_context-label"
								? translation.attributes.lang === "es"
									? "Comidas: "
									: "Meals: "
								: "";
						expect(value.text).toBe(prefix);
					}
				}
				for (const value of onlyXml(
					translation.children.filter(
						(node) => node.attributes.id === "unicode_spacing-label",
					),
				).children) {
					expect(value.text).toBe("\u00a0\u2003\u2028");
					expect(
						value.children.map((output) => output.attributes.value),
					).toEqual(["/data/meals", "/data/address"]);
				}
				for (const value of onlyXml(
					translation.children.filter(
						(node) => node.attributes.id === "escaped_markup-label",
					),
				).children) {
					expect(value.text).toBe(
						"Literal <output value=\"'x'\"/> & #form/meals",
					);
					expect(value.children).toEqual([]);
				}
			}
		}
	});
});
