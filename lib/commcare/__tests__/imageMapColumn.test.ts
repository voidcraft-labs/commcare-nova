import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { mediaIds, mediaWireFixture } from "./mediaWireFixtures";
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
			const zip = new AdmZip(compileCcz(hq, doc.appName, doc, options));
			const suite = readXmlEvidence(zip.readAsText("suite.xml"));
			const images = descend(suite).filter(
				(node) => node.name === "template" && node.attributes.form === "image",
			);
			expect(images).toHaveLength(enabled ? 2 : 0);
			// Executable matching, first-match order, punctuation and no-match behavior
			// are independently exercised by native Core over local + actual HQ suites.
		});
});
