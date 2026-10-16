import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { imageMapColumn, plainColumn, proseText } from "@/lib/domain";
import { mediaIds, mediaWireFixture } from "./mediaWireFixtures";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

const descend = (node: XmlEvidence): XmlEvidence[] =>
	node.children.flatMap((child) => [child, ...descend(child)]);

describe("image mapping at both export boundaries", () => {
	for (const enabled of [true, false])
		it(`emits image semantics with media ${enabled ? "on" : "off"}`, () => {
			const { doc, assets } = mediaWireFixture();
			const options = enabled ? { assets } : {};
			const hq = expandDoc(doc, options);
			const column = hq.modules[0].case_details.short.columns[1];
			expect(column.format).toBe(enabled ? "enum-image" : "plain");
			if (enabled) {
				// HQ interprets plain enum-image keys as equality and punctuation as
				// expressions. Explicit predicates preserve token matching and literals.
				expect(column.enum).toEqual([
					{
						key: "selected(., 'active')",
						value: { en: `jr://file/${assets.get(mediaIds.label)?.wirePath}` },
					},
					{
						key: "selected(., 'closed')",
						value: { en: `jr://file/${assets.get(mediaIds.option)?.wirePath}` },
					},
					{
						key: `selected(., concat('a.', "'", '"/b'))`,
						value: { en: `jr://file/${assets.get(mediaIds.icon)?.wirePath}` },
					},
				]);
			}
			const zip = new AdmZip(
				compileCcz(hq, doc.appName, doc, {
					...options,
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			);
			const suite = readXmlEvidence(zip.readAsText("suite.xml"));
			const images = descend(suite).filter(
				(node) => node.name === "template" && node.attributes.form === "image",
			);
			expect(images).toHaveLength(enabled ? 2 : 0);
			// Every image-map field ends with HQ's alt text: an enum over the
			// same keys, each variable named as HQ names its key and reading a
			// locale every language holds blank.
			const fields = descend(suite).filter(
				(node) =>
					node.name === "field" &&
					node.children.some(
						(child) =>
							child.name === "template" && child.attributes.form === "image",
					),
			);
			for (const field of fields) {
				const altText = field.children.at(-1);
				expect(altText?.name).toBe("alt_text");
				const xpath = altText?.children[0]?.children[0];
				const names = [
					"selected(., 'active')",
					"selected(., 'closed')",
					`selected(., concat('a.', "'", '"/b'))`,
				].map(
					(key) =>
						`h${createHash("md5").update(key).digest("hex").slice(0, 8)}`,
				);
				expect(
					xpath?.children.map((variable) => variable.attributes.name),
				).toEqual(names);
				expect(xpath?.attributes.function).toBe(
					`if(selected(care_status, 'active'), $${names[0]}, if(selected(care_status, 'closed'), $${names[1]}, if(selected(care_status, concat('a.', "'", '"/b')), $${names[2]}, '')))`,
				);
				for (const variable of xpath?.children ?? []) {
					const id = variable.children[0]?.attributes.id ?? "";
					expect(id).toMatch(
						/^m0\.case_(short|long).case_care_status_\d+\.alt_text\.h[0-9a-f]{8}$/,
					);
					for (const dir of ["default", "en"])
						expect(
							zip.readAsText(`${dir}/app_strings.txt`).split("\n"),
						).toContain(`${id}=\u00a0`);
				}
			}
			expect(fields).toHaveLength(enabled ? 2 : 0);
			// Executable matching, first-match order, punctuation and no-match behavior
			// are independently exercised by native Core over local + actual HQ suites.
		});
});

describe("an image map with no entries", () => {
	/** A media-free app whose list is a Name column and an image map with no
	 *  entries, as the builder's Value images column is born. */
	function emptyImageMapDoc() {
		return buildDoc({
			appName: "Zones",
			modules: [
				{
					name: "Households",
					caseType: "household",
					caseListOnly: true,
					caseListConfig: resolveCaseListConfig({
						columns: [
							plainColumn(testUuid("empty-map-name"), "case_name", "Name"),
							imageMapColumn(testUuid("empty-map-zone"), "zone", "Zone", []),
						],
						searchInputs: [],
					}),
				},
			],
			caseTypes: [
				{
					name: "household",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "zone", label: proseText("Zone") },
					],
				},
			],
		});
	}

	function caseDetail(suite: XmlEvidence, id: string): XmlEvidence {
		const detail = descend(suite).find(
			(node) => node.name === "detail" && node.attributes.id === id,
		);
		if (detail === undefined) throw new Error(`Missing detail ${id}`);
		return detail;
	}

	it("is the same image column with no manifest and with an empty one", () => {
		const doc = emptyImageMapDoc();
		const exports = [{}, { assets: new Map() }].map((options) => {
			const hq = expandDoc(doc, options);
			const zip = new AdmZip(
				compileCcz(hq, doc.appName, doc, {
					...options,
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			);
			return {
				details: hq.modules[0].case_details,
				suite: readXmlEvidence(zip.readAsText("suite.xml")),
			};
		});
		const [manual, upload] = exports;
		expect(manual.details).toEqual(upload.details);
		for (const detail of [manual.details.short, manual.details.long]) {
			expect(detail.columns[1]).toMatchObject({
				field: "zone",
				format: "enum-image",
				enum: [],
			});
		}
		for (const id of ["m0_case_short", "m0_case_long"]) {
			const detail = caseDetail(manual.suite, id);
			expect(detail).toEqual(caseDetail(upload.suite, id));
			const image = descend(detail).find(
				(node) => node.name === "template" && node.attributes.form === "image",
			);
			expect(image?.attributes.width).toBe("13%");
		}
	});
});
