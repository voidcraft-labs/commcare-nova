import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { mediaIds, mediaWireFixture } from "./mediaWireFixtures";
import { onlyXml, readXmlEvidence, xmlChildren } from "./xmlEvidence";

describe("admitted media app archive joins", () => {
	for (const enabled of [true, false])
		it(`resolves the complete media resource graph with media ${enabled ? "on" : "off"}`, () => {
			const { doc, assets } = mediaWireFixture();
			const hq = expandDoc(doc, enabled ? { assets } : {});
			const zip = new AdmZip(
				compileCcz(hq, doc.appName, doc, enabled ? { assets } : {}),
			);
			const media = readXmlEvidence(zip.readAsText("media_suite.xml"));
			const expected = enabled
				? new Map([...assets.values()].map((asset) => [asset.wirePath, asset]))
				: new Map();
			expect(
				zip
					.getEntries()
					.filter((e) => e.entryName.startsWith("commcare/"))
					.map((e) => e.entryName)
					.sort(),
			).toEqual([...expected.keys()].sort());
			const locations = xmlChildren(media, "media").map((block) => {
				expect(block.attributes.path).toBe("../../commcare");
				const resource = onlyXml(xmlChildren(block, "resource"));
				expect(resource.attributes.version).toBe("1");
				const location = onlyXml(xmlChildren(resource, "location"));
				expect(location.attributes.authority).toBe("local");
				const path = location.text.replace(/^\.\//, "");
				const asset = expected.get(path);
				if (!asset) throw new Error(`Unexpected media resource ${path}`);
				const bytes = zip.readFile(path);
				expect(bytes).toEqual(asset.bytes);
				expect(
					createHash("sha256")
						.update(bytes ?? Buffer.alloc(0))
						.digest("hex"),
				).toBe(asset.contentHash);
				return path;
			});
			expect(locations).toEqual([...expected.keys()].sort());
			expect(
				new Set(
					xmlChildren(media, "media").map(
						(block) => onlyXml(xmlChildren(block, "resource")).attributes.id,
					),
				).size,
			).toBe(expected.size);
			const profile = readXmlEvidence(zip.readAsText("profile.ccpr"));
			const logos = xmlChildren(profile, "property").filter(
				(p) => p.attributes.key === "brand-banner-web-apps",
			);
			expect(logos.map((p) => p.attributes)).toEqual(
				enabled
					? [
							{
								key: "brand-banner-web-apps",
								value: `jr://file/${assets.get(mediaIds.icon)?.wirePath}`,
								force: "true",
							},
						]
					: [],
			);
			const suite = readXmlEvidence(zip.readAsText("suite.xml"));
			const menu = onlyXml(xmlChildren(suite, "menu"));
			const displays = xmlChildren(menu, "display");
			const strings = new Map(
				zip
					.readAsText("default/app_strings.txt")
					.split("\n")
					.map((line) => {
						const eq = line.indexOf("=");
						return [line.slice(0, eq), line.slice(eq + 1)];
					}),
			);
			expect(displays).toHaveLength(enabled ? 1 : 0);
			if (enabled) {
				const mediaTexts = xmlChildren(displays[0], "text").filter(
					(text) => text.attributes.form,
				);
				expect(
					mediaTexts.map((text) => [
						text.attributes.form,
						strings.get(onlyXml(xmlChildren(text, "locale")).attributes.id),
					]),
				).toEqual([
					["image", `jr://file/${assets.get(mediaIds.icon)?.wirePath}`],
					["audio", `jr://file/${assets.get(mediaIds.audio)?.wirePath}`],
				]);
			}
		});
});
