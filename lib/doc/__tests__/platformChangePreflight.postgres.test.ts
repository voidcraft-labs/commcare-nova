/**
 * The platform change preflight against real Postgres, through the action's
 * body (`readPlatformChangePreflight`) under its session wrapper.
 *
 * Contract: asked for a declaration that adds a platform, it reads the
 * committed app and the Project's media rows from one snapshot and returns
 * every use and every file the new declaration can't run, each with the
 * builder's line and where it is, and the `mutation_seq` it read; an app
 * with neither is `ok`; only a member who can edit may ask.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { BlueprintDoc, MediaAssetId } from "@/lib/domain";
import { NEW_APP_SETTINGS } from "@/lib/domain";
import { walkAuthoredAssetRefs } from "@/lib/domain/mediaRefs";
import { describeUnplayableReferences } from "@/lib/media/platformPlayback";
import { readPlatformChangePreflight } from "../platformChangePreflightRead";

const h = setupAppStateTestDb("platform_change_preflight_");
const PROJECT = "project-platforms";
const OWNER = "owner-platforms";
const MODULE = testUuid("preflight-module");
const FORM = testUuid("preflight-form");
const VISIT_AT = testUuid("preflight-visit-at");
const NOTE = testUuid("preflight-note");
const AMR = testMediaAssetId("preflight-amr");
const MP3 = testMediaAssetId("preflight-mp3");

function androidApp(options: {
	readonly datetime?: boolean;
	readonly labelAudio?: MediaAssetId;
}): BlueprintDoc {
	return buildDoc({
		appName: "Visits",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							{
								uuid: NOTE,
								kind: "text",
								id: "note",
								label: "Note",
								...(options.labelAudio !== undefined && {
									label_media: { audio: options.labelAudio },
								}),
							},
							...(options.datetime === true
								? [
										{
											uuid: VISIT_AT,
											kind: "datetime" as const,
											id: "visit_at",
											label: "Visit time",
										},
									]
								: []),
						],
					},
				],
			},
		],
	});
}

async function seedAudio(
	id: MediaAssetId,
	format: { mime: string; extension: string; mediaFormat: string },
): Promise<void> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: PROJECT,
			owner: OWNER,
			content_hash: id.padEnd(64, "a").slice(0, 64),
			mime_type: format.mime,
			extension: format.extension,
			size_bytes: 1024,
			kind: "audio",
			gcs_object_key: `projects/${PROJECT}/${id}`,
			original_filename: `${id}${format.extension}`,
			status: "ready",
			media_format: format.mediaFormat,
		})
		.execute();
}

async function seed(doc: BlueprintDoc): Promise<string> {
	return h.seedAppWithBlueprint(doc, { owner: OWNER, projectId: PROJECT });
}

describe("the platform change preflight", () => {
	it("lists a date-and-time question that Web Apps can't run, at the question, with its builder line", async () => {
		const appId = await seed(androidApp({ datetime: true }));

		const result = await readPlatformChangePreflight(
			{ appId, runsOnlyOn: null },
			OWNER,
		);

		expect(result.kind).toBe("refused");
		if (result.kind !== "refused") return;
		expect(result.media).toEqual([]);
		expect(result.findings).toHaveLength(1);
		const [row] = result.findings;
		expect(row?.finding.code).toBe("PLATFORM_FEATURE_UNAVAILABLE");
		expect(row?.finding.location.fieldUuid).toBe(VISIT_AT);
		expect(row?.finding.details?.feature).toBe("datetime-question");
		expect(row?.line).toMatch(/Web Apps/);
		expect(result.mutationSeq).toBe(
			Number((await h.readAppRow(appId))?.mutation_seq),
		);
	});

	it("lists a file only Android plays, at its carrier, in the kernel's words", async () => {
		await seedAudio(AMR, {
			mime: "audio/amr",
			extension: ".amr",
			mediaFormat: "amr",
		});
		const doc = androidApp({ labelAudio: AMR });
		const appId = await seed(doc);

		const result = await readPlatformChangePreflight(
			{ appId, runsOnlyOn: null },
			OWNER,
		);

		expect(result.kind).toBe("refused");
		if (result.kind !== "refused") return;
		expect(result.findings).toEqual([]);
		const [ref] = [...walkAuthoredAssetRefs(doc)];
		if (ref === undefined) throw new Error("The fixture references no file.");
		expect(result.media).toEqual([
			{
				line: describeUnplayableReferences([
					{
						ref,
						mediaFormat: "amr",
						label: "AMR",
						missing: ["web-apps"],
					},
				]),
				location: ref.location,
			},
		]);
	});

	it("is ok for an app holding nothing the new declaration refuses", async () => {
		await seedAudio(MP3, {
			mime: "audio/mpeg",
			extension: ".mp3",
			mediaFormat: "mp3",
		});
		const appId = await seed(androidApp({ labelAudio: MP3 }));

		expect(
			await readPlatformChangePreflight({ appId, runsOnlyOn: null }, OWNER),
		).toEqual({
			kind: "ok",
			mutationSeq: Number((await h.readAppRow(appId))?.mutation_seq),
		});
	});

	it("answers not-found to a non-member and forbidden to a viewer", async () => {
		const appId = await seed(androidApp({ datetime: true }));
		await h.seedProjectMember("viewer-platforms", PROJECT, "viewer");

		expect(
			await readPlatformChangePreflight(
				{ appId, runsOnlyOn: null },
				"stranger-platforms",
			),
		).toEqual({ kind: "not-found" });
		expect(
			await readPlatformChangePreflight(
				{ appId, runsOnlyOn: null },
				"viewer-platforms",
			),
		).toEqual({ kind: "forbidden" });
	});
});
