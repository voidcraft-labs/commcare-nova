import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

const originalControl =
	'<upload mediatype="image/*" vellum:ref="#form/photo" ref="/data/photo">';

async function read(body: Record<string, unknown>): Promise<BlueprintDoc> {
	const outcome = readHqApp(await inputFor(body));
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read") throw new Error("HQ source did not read.");
	return outcome.draft.doc;
}

describe("an image's Android photo size", () => {
	it.each(["731px", "+731", "000731px"])(
		"keeps the pixels through HQ source, publish and read-back (%s)",
		async (spelling) => {
			const saved = JSON.parse(
				readFileSync("proof/hq-apps/hq-questions/app-source.json", "utf8"),
			);
			const body = JSON.parse(saved.body);
			const xmls = body._attachments as Record<string, string>;
			const xml = Object.entries(xmls).find(([, content]) =>
				content.includes(originalControl),
			);
			if (!xml)
				throw new Error("The retained Questions form has no photo control.");
			xmls[xml[0]] = xml[1].replace(
				originalControl,
				originalControl.slice(0, -1) +
					` jr:imageDimensionScaledMax="${spelling}">`,
			);
			const imported = await read(body);
			const photo = Object.values(imported.fields).find(
				(field) => field.id === "photo",
			);
			expect(photo).toMatchObject({ kind: "image", maxDimension: 731 });
			const emitted = exportedBody(imported);
			const attachments = Object.values(
				emitted._attachments as Record<string, string>,
			);
			expect(attachments.join("\n")).toContain(
				'jr:imageDimensionScaledMax="731px"',
			);
			const next = await read(emitted);
			expect(
				Object.values(next.fields).find((field) => field.id === "photo"),
			).toMatchObject({ kind: "image", maxDimension: 731 });
		},
	);
});
