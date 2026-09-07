import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { mediaIds, mediaWireFixture } from "./mediaWireFixtures";
import {
	onlyXml,
	readXmlEvidence,
	type XmlEvidence,
	xmlChildren,
} from "./xmlEvidence";

function descendants(node: XmlEvidence, name: string): XmlEvidence[] {
	return node.children.flatMap((child) => [
		...(child.name === name ? [child] : []),
		...descendants(child, name),
	]);
}

describe("admitted XForm media references", () => {
	for (const mediaOnly of [false, true])
		for (const enabled of [false, true])
			it(`${mediaOnly ? "media-only" : "text and media"} optional content, emission ${enabled ? "on" : "off"}`, () => {
				const { doc, assets } = mediaWireFixture(mediaOnly);
				const options = enabled ? { assets } : {};
				const hq = expandDoc(doc, options);
				const zip = new AdmZip(compileCcz(hq, doc.appName, doc, options));
				const source =
					hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
				if (typeof source !== "string")
					throw new Error("Missing actual source form");
				const ref = (key: keyof typeof mediaIds) =>
					`jr://file/${assets.get(mediaIds[key])?.wirePath}`;
				for (const xml of [source, zip.readAsText("modules-0/forms-0.xml")]) {
					const root = readXmlEvidence(xml);
					const translation = onlyXml(descendants(root, "translation"));
					const itext = new Map(
						xmlChildren(translation, "text").map((text) => [
							text.attributes.id,
							new Map(
								xmlChildren(text, "value").map((value) => [
									value.attributes.form ?? "plain",
									value.text,
								]),
							),
						]),
					);
					const answer = onlyXml(
						descendants(root, "input").filter(
							(input) => input.attributes.ref === "/data/answer",
						),
					);
					const bound = onlyXml(
						descendants(root, "bind").filter(
							(bind) => bind.attributes.nodeset === "/data/answer",
						),
					);
					expect(onlyXml(xmlChildren(answer, "label")).attributes.ref).toBe(
						"jr:itext('answer-label')",
					);
					const expectedLabel = new Map<string, string>([
						["plain", "Answer 雪"],
						["markdown", "Answer 雪"],
					]);
					if (enabled)
						for (const [slot, key] of [
							["image", "label"],
							["audio", "audio"],
							["video", "video"],
						] as const)
							expectedLabel.set(slot, ref(key));
					expect(itext.get("answer-label")).toEqual(expectedLabel);
					for (const [slot, key] of [
						["hint", "option"],
						["help", "audio"],
						["constraintMsg", "icon"],
					] as const) {
						const present = !mediaOnly || enabled;
						const reference =
							slot === "constraintMsg"
								? bound.attributes["jr:constraintMsg"]
								: xmlChildren(answer, slot)[0]?.attributes.ref;
						expect(reference).toBe(
							present ? `jr:itext('answer-${slot}')` : undefined,
						);
						const values = itext.get(`answer-${slot}`);
						if (!present) {
							expect(values).toBeUndefined();
							continue;
						}
						expect(values?.get("plain")).toBe(
							mediaOnly
								? ""
								: slot === "hint"
									? "A hint"
									: slot === "help"
										? "Some help"
										: "Use ok",
						);
						expect(values?.get(key === "audio" ? "audio" : "image")).toBe(
							enabled ? ref(key) : undefined,
						);
					}
					const select = onlyXml(descendants(root, "select1"));
					const items = xmlChildren(select, "item");
					expect(
						items.map((item) => onlyXml(xmlChildren(item, "value")).text),
					).toEqual(["one", "two"]);
					const optionRef = onlyXml(xmlChildren(items[0], "label")).attributes
						.ref;
					expect(optionRef).toBe("jr:itext('choice-opt0-label')");
					expect(itext.get("choice-opt0-label")?.get("image")).toBe(
						enabled ? ref("option") : undefined,
					);
					expect(itext.get("choice-opt0-label")?.get("audio")).toBe(
						enabled ? ref("audio") : undefined,
					);
					expect(itext.get("choice-opt0-label")?.get("video")).toBe(
						enabled ? ref("video") : undefined,
					);
					expect(itext.get("choice-opt1-label")?.get("image")).toBeUndefined();
				}
				expect(hq.modules[0].media_image).toEqual(
					enabled ? { en: ref("icon") } : {},
				);
				expect(hq.modules[0].forms[0].media_image).toEqual(
					enabled ? { en: ref("alias") } : {},
				);
				expect(hq.logo_refs).toEqual(
					enabled ? { hq_logo_web_apps: { path: ref("icon") } } : undefined,
				);
				expect(Object.keys(hq.multimedia_map).sort()).toEqual(
					enabled
						? [
								...new Set(
									[...assets.values()].map(
										(asset) => `jr://file/${asset.wirePath}`,
									),
								),
							].sort()
						: [],
				);
			});
});
