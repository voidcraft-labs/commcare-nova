/**
 * Exact Project-scoped media-reference projection helpers against Postgres.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, MediaAssetId } from "@/lib/domain";
import type { Platform } from "@/lib/domain/platforms";
import { proseText } from "@/lib/domain/prose";
import {
	prepareGenesisCandidate,
	writePreparedGenesisInTransaction,
} from "../appGenesis";
import { commitGuardedBatch } from "../apps";
import { BlueprintCommitRejectedError } from "../commitGuard";
import {
	deleteMediaReferenceEdges,
	insertMediaReferenceEdges,
	lockAndValidateMediaReferences,
	MediaReferenceProjectionError,
	replaceExactThreadMediaReferences,
} from "../mediaAssets";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("exact_media_refs_");
const PROJECT = "project-1";
const ASSET_A = testMediaAssetId("asset-a");
const ASSET_B = testMediaAssetId("asset-b");
const MISSING = testMediaAssetId("asset-missing");

async function seedAsset(id: MediaAssetId, kind = "image"): Promise<void> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: PROJECT,
			owner: "owner-1",
			content_hash: id.padEnd(64, "a").slice(0, 64),
			mime_type: kind === "image" ? "image/png" : "audio/mpeg",
			extension: kind === "image" ? ".png" : ".mp3",
			size_bytes: 1024,
			kind,
			gcs_object_key: `projects/${PROJECT}/${id}`,
			original_filename: `${id}`,
			status: "ready",
			media_format: kind === "image" ? "png" : "mp3",
		})
		.execute();
}

describe("exact media reference projection", () => {
	it("replaces the complete set, including removal to empty", async () => {
		const appId = await h.seedApp({ id: "app-exact", project_id: PROJECT });
		await seedAsset(ASSET_A);
		await seedAsset(ASSET_B);

		await h
			.db()
			.transaction()
			.execute(async (tx) => {
				const ids = await lockAndValidateMediaReferences(tx, PROJECT, [
					{ assetId: ASSET_A, expectedKind: "image" },
					{ assetId: ASSET_B, expectedKind: "image" },
					{ assetId: ASSET_A, expectedKind: "image" },
				]);
				await deleteMediaReferenceEdges(tx, appId);
				await insertMediaReferenceEdges(tx, {
					projectId: PROJECT,
					appId,
					assetIds: ids,
				});
			});
		expect(
			await h
				.db()
				.selectFrom("media_asset_refs")
				.select(["project_id", "app_id", "asset_id"])
				.where("app_id", "=", appId)
				.orderBy("asset_id")
				.execute(),
		).toEqual(
			[ASSET_A, ASSET_B].sort().map((assetId) => ({
				project_id: PROJECT,
				app_id: appId,
				asset_id: assetId,
			})),
		);

		await h
			.db()
			.transaction()
			.execute(async (tx) => {
				await deleteMediaReferenceEdges(tx, appId);
				await insertMediaReferenceEdges(tx, {
					projectId: PROJECT,
					appId,
					assetIds: [],
				});
			});
		expect(
			await h
				.db()
				.selectFrom("media_asset_refs")
				.selectAll()
				.where("app_id", "=", appId)
				.execute(),
		).toEqual([]);
	});

	it("fails the transaction for missing or wrong-kind assets", async () => {
		await seedAsset(ASSET_A);
		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					lockAndValidateMediaReferences(tx, PROJECT, [
						{ assetId: MISSING, expectedKind: "image" },
					]),
				),
		).rejects.toBeInstanceOf(MediaReferenceProjectionError);
		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					lockAndValidateMediaReferences(tx, PROJECT, [
						{ assetId: ASSET_A, expectedKind: "audio" },
					]),
				),
		).rejects.toBeInstanceOf(MediaReferenceProjectionError);
	});
});

const OWNER = "owner-1";
const AMR = testMediaAssetId("asset-amr");
const ICO = testMediaAssetId("asset-ico");

/** A ready row of a variant one platform plays. */
async function seedVariant(
	id: MediaAssetId,
	variant: "amr" | "ico",
): Promise<void> {
	const amr = variant === "amr";
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: PROJECT,
			owner: OWNER,
			content_hash: id.padEnd(64, "b").slice(0, 64),
			mime_type: amr ? "audio/amr" : "image/vnd.microsoft.icon",
			extension: amr ? ".amr" : ".ico",
			size_bytes: 1024,
			kind: amr ? "audio" : "image",
			gcs_object_key: `projects/${PROJECT}/${id}`,
			original_filename: `${id}`,
			status: "ready",
			media_format: variant,
		})
		.execute();
}

/** A survey form "Visit" in a module "Visits", with a text field "note". */
function visitDoc(runsOnlyOn?: Platform): BlueprintDoc {
	return buildDoc({
		appName: "Visits",
		appSettings: {
			showSavedForms: false,
			showIncompleteForms: false,
			...(runsOnlyOn && { runsOnlyOn }),
		},
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
}

function noteUuid(doc: BlueprintDoc) {
	const field = Object.values(doc.fields).find((fl) => fl.id === "note");
	if (!field) throw new Error("The fixture holds the note field.");
	return field.uuid;
}

function commit(appId: string, mutations: Mutation[]) {
	return commitGuardedBatch({
		appId,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		mutations: admitMutationBatch(mutations),
		actorUserId: OWNER,
		kind: "autosave",
	});
}

describe("media acceptance by the platforms an app runs on, through the commit kernel", () => {
	it("admits an AMR label where the app runs only on Android, and refuses widening it to both, naming the file", async () => {
		await seedVariant(AMR, "amr");
		const doc = visitDoc("android");
		const appId = await h.seedAppWithBlueprint(doc, {
			owner: OWNER,
			projectId: PROJECT,
		});
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await commit(appId, [
			{
				kind: "setFieldMedia",
				fieldUuid: noteUuid(doc),
				slot: "label",
				media: { audio: AMR },
			},
		]);
		const refused = commit(appId, [
			{ kind: "setAppSettings", settings: { runsOnlyOn: null } },
		]);
		await expect(refused).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		await expect(refused).rejects.toThrow(
			'Web Apps can\'t play a file this app uses: the audio on field "note"\'s label (form "Visit") in AMR. You can replace it or remove it, then try again.',
		);
	});

	it("refuses the genesis of an app that runs on both platforms holding an ICO", async () => {
		await seedVariant(ICO, "ico");
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		const doc = { ...visitDoc(), logo: ICO };
		const candidate = prepareGenesisCandidate({
			appId: doc.appId,
			projectId: PROJECT,
			mutations: diffDocsToMutations(emptyBlueprintDoc(doc.appId), doc),
		});
		await expect(
			h.withTransaction((tx) =>
				writePreparedGenesisInTransaction(tx, {
					candidate,
					actorUserId: OWNER,
					runId: crypto.randomUUID(),
					status: "complete",
				}),
			),
		).rejects.toThrow(
			"the attached image is ICO, which Android can't play, and this app runs on Android.",
		);
	});

	it("holds no thread attachment to a platform: an ICO rides an Android-only app's thread", async () => {
		await seedVariant(ICO, "ico");
		const appId = await h.seedAppWithBlueprint(visitDoc("android"), {
			owner: OWNER,
			projectId: PROJECT,
		});
		const threadId = crypto.randomUUID();
		await h
			.db()
			.insertInto("threads")
			.values({
				thread_id: threadId,
				app_id: appId,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				thread_type: "chat",
				summary: "Attachments",
				run_id: crypto.randomUUID(),
				messages: JSON.stringify([]),
			} as never)
			.execute();
		await h.withTransaction((tx) =>
			replaceExactThreadMediaReferences(tx, {
				threadId,
				projectId: PROJECT,
				candidateMessages: [
					{
						id: "m1",
						role: "user",
						parts: [{ type: "text", text: "Look at this" }],
						metadata: {
							attachments: [
								{
									assetId: ICO,
									kind: "image",
									filename: "icon.ico",
									mimeType: "image/vnd.microsoft.icon",
								},
							],
						},
					},
				],
			}),
		);
		const refs = await h
			.db()
			.selectFrom("thread_media_refs")
			.select("asset_id")
			.where("thread_id", "=", threadId)
			.execute();
		expect(refs.map((ref) => ref.asset_id)).toEqual([ICO]);
	});
});
