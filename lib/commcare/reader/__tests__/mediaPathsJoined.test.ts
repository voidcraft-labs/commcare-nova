/**
 * One file CommCare HQ holds under two paths, read as the one asset it is.
 *
 * Contract: where the media index answers one asset for two paths (HQ keeps
 * one media document per file content, so the same picture uploaded as two
 * menus' icons is two `multimedia_map` entries over one file), every slot
 * that names either path holds that asset, and the projection the reader compares with
 * prints the asset at the first of its paths in code-unit order, so the
 * reading is clean (`xform/__tests__/media.test.ts` holds a language map whose
 * languages name the two paths). The first publish keeps that path (`media-paths-joined`).
 * The plausible failure: the projection printing the asset at the first path
 * the reading met, so the second menu's icon or the second form's label
 * reads `unrecognized`, and a correct app is refused.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { proseText } from "@/lib/domain";
import { mediaManifest } from "../../__tests__/mediaWireFixtures";
import type { AssetManifest } from "../../multimedia/assetWirePath";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { matchingResolver } from "../identity";
import { externalIdentityMap } from "../identityMap";
import { readHqApp } from "../index";
import type { ReaderMediaResolution, ReadOutcome } from "../types";
import { exportedBody, inputFor } from "./novaExport";

const JR_FILE = "jr://file/";
const ICON = testMediaAssetId("wire-icon");
const LABEL = testMediaAssetId("wire-label");

/** Two menus of one form each, both menus showing one icon and both forms' questions one
 *  picture. */
function twoMenus() {
	const doc = buildDoc({
		appId: "app-1",
		modules: ["Patients", "Visits"].map((name) => ({
			name,
			forms: [
				{
					name: `${name} intake`,
					type: "survey" as const,
					fields: [
						f({
							kind: "text",
							id: "notes",
							label: proseText("Notes"),
							label_media: { image: LABEL },
						}),
					],
				},
			],
		})),
	});
	for (const uuid of doc.moduleOrder) {
		const module = doc.modules[uuid];
		if (module !== undefined) module.icon = ICON;
	}
	return doc;
}

/** The path the export writes for an asset. */
function exported(assets: AssetManifest, assetId: string): string {
	const asset = assets.get(assetId as never);
	if (asset === undefined) throw new Error("The manifest holds every asset.");
	return `${JR_FILE}${asset.wirePath}`;
}

async function read(
	edit: (
		body: Record<string, unknown>,
		paths: { icon: string; label: string },
	) => Record<string, string>,
): Promise<ReadOutcome> {
	const doc = twoMenus();
	const assets = mediaManifest();
	const body = exportedBody(doc, { expand: { assets } });
	const paths = {
		icon: exported(assets, ICON),
		label: exported(assets, LABEL),
	};
	/* Every path the edit added names the file of the path it stands beside. */
	const aliases = edit(body, paths);
	const assetOf = new Map<string, string>([
		[paths.icon, ICON],
		[paths.label, LABEL],
		...Object.entries(aliases).map(
			([alias, path]) =>
				[alias, path === paths.icon ? ICON : LABEL] as [string, string],
		),
	]);
	return readHqApp(
		await inputFor(body, {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
			media: {
				resolve: (path): ReaderMediaResolution => {
					const assetId = assetOf.get(path);
					return assetId === undefined
						? { kind: "no-entry" }
						: { kind: "asset", assetId, mediaKind: "image" };
				},
			},
		}),
	);
}

function clean(outcome: ReadOutcome) {
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(
			`The export read to an account: ${outcome.findings.map((one) => `${one.code} at ${one.place.kind} (${one.detail.name ?? ""})`).join(", ")}`,
		);
	return outcome.draft;
}

function modules(body: Record<string, unknown>): Record<string, unknown>[] {
	return body.modules as Record<string, unknown>[];
}

describe("one file under two paths", () => {
	it("reads the second menu's icon at another path as the same asset, at a path that sorts before or after", async () => {
		for (const alias of [
			"jr://file/commcare/image/module1_en.png",
			"jr://file/aaa/module1_en.png",
		]) {
			const draft = clean(
				await read((body, paths) => {
					const second = modules(body)[1];
					if (second !== undefined) second.media_image = { en: alias };
					return { [alias]: paths.icon };
				}),
			);
			expect(
				draft.doc.moduleOrder.map((uuid) => draft.doc.modules[uuid]?.icon),
			).toEqual([ICON, ICON]);
			expect(
				draft.facts.mediaReferences
					.filter((reference) => reference.assetId === ICON)
					.map((reference) => reference.path)
					.sort(),
			).toEqual([alias, exported(mediaManifest(), ICON)].sort());
		}
	});

	it("reads the second form's label picture at another path as the same asset", async () => {
		const alias = "jr://file/commcare/image/data/notes.png";
		const draft = clean(
			await read((body, paths) => {
				const attachments = body._attachments as Record<string, string>;
				const [, second] = Object.keys(attachments).sort();
				if (second === undefined) throw new Error("The app has two forms.");
				attachments[second] = (attachments[second] as string).replaceAll(
					paths.label,
					alias,
				);
				return { [alias]: paths.label };
			}),
		);
		const labels = Object.values(draft.doc.fields).map(
			(field) => (field as { label_media?: unknown }).label_media,
		);
		expect(labels).toEqual([{ image: LABEL }, { image: LABEL }]);
	});
});
