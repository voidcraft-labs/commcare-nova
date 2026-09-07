/** Actual media lookup, stored-extract adapter and persisted package replay.
 * Only GCS bytes are controlled; no provider or storage-service claim. */
import { beforeEach, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { extractObjectKeyForAsset } from "@/lib/domain/multimedia";
import { insertDesignSourcePackage } from "../artifactStore";
import { rebuildPackageForDigest } from "../loop/packageRebuild";
import {
	buildDesignSourcePackage,
	MAX_IMAGE_BYTES,
	SourcePackageError,
} from "../sourcePackage";
import { productionSourcePackageDeps } from "../sourcePackageDeps";
import {
	OTHER_SOURCE_PNG,
	SOURCE_DOCUMENT,
	SOURCE_IMAGE,
	SOURCE_PNG,
	SOURCE_PROJECT,
	SOURCE_SESSION,
	SOURCE_TEXT,
	SOURCE_THREAD,
	sourceAsset,
	sourceDigest,
	sourceMessage,
	sourceRef,
} from "./sourcePackageFixtures";

const { objects, downloads, reads } = vi.hoisted(() => ({
	objects: new Map<string, Buffer>(),
	downloads: vi.fn(),
	reads: vi.fn(),
}));
vi.mock("@/lib/storage/media", () => ({
	downloadAssetBytes: async (key: string, max: number) => {
		downloads(key, max);
		const bytes = objects.get(key);
		if (!bytes) throw new Error("Object missing");
		if (bytes.length > max) throw new Error("Object exceeds limit");
		return bytes;
	},
	readTextObject: async (key: string, max: number) => {
		reads(key, max);
		return objects.get(key)?.toString("utf8") ?? null;
	},
	writeTextObject: async () => {
		throw new Error("Unexpected extraction write");
	},
	deleteAsset: async () => {
		throw new Error("Unexpected extraction delete");
	},
}));
const h = setupAppStateTestDb("source_package_", { authSchema: "migrated" });
const authority = {
	actorUserId: "source-user",
	runId: "source-run",
	holderNonce: "00000000-0000-4000-8000-000000000899",
	expectedProjectId: SOURCE_PROJECT,
};
const deps = productionSourcePackageDeps({
	async extractDocumentStructured() {
		throw new Error("Unexpected provider call");
	},
});
const originalMessages = () => [
	sourceMessage("m1", "Build patient visits.", [
		sourceRef(SOURCE_DOCUMENT),
		sourceRef(SOURCE_IMAGE),
	]),
];
const args = (messages = originalMessages()) => ({
	designSessionId: SOURCE_SESSION,
	projectId: SOURCE_PROJECT,
	threadId: SOURCE_THREAD,
	messages,
	deps,
});

beforeEach(async () => {
	objects.clear();
	downloads.mockClear();
	reads.mockClear();
	await h.seedDesignSession({
		id: SOURCE_SESSION,
		owner_user_id: authority.actorUserId,
		project_id: SOURCE_PROJECT,
		run_id: authority.runId,
		run_holder_nonce: authority.holderNonce,
		run_actor_user_id: authority.actorUserId,
		run_lease_expires_at: new Date(Date.now() + 60_000),
		reservation: {
			period: "2026-09",
			reserved: 1,
			settled: false,
			userId: authority.actorUserId,
			runId: authority.runId,
		},
	});
	for (const id of [SOURCE_DOCUMENT, SOURCE_IMAGE]) {
		const a = sourceAsset(id);
		await h
			.db()
			.insertInto("media_assets")
			.values({
				id: a.id,
				owner: a.owner,
				project_id: a.project_id,
				content_hash: a.contentHash,
				mime_type: a.mimeType,
				extension: a.extension,
				size_bytes: a.sizeBytes,
				kind: a.kind,
				gcs_object_key: a.gcsObjectKey,
				original_filename: a.originalFilename,
				status: a.status,
				extract: a.extract ? JSON.stringify(a.extract) : null,
				dimensions: a.dimensions ? JSON.stringify(a.dimensions) : null,
			})
			.execute();
		objects.set(
			a.gcsObjectKey,
			id === SOURCE_IMAGE ? SOURCE_PNG : Buffer.from(SOURCE_TEXT),
		);
		const key = extractObjectKeyForAsset(a);
		if (key) objects.set(key, Buffer.from(SOURCE_TEXT));
	}
});

it("projects real stored extracts and hashes the downloaded image bytes", async () => {
	const pkg = await buildDesignSourcePackage(args());
	expect(pkg.attachments[0]).toEqual({
		assetId: SOURCE_DOCUMENT,
		extractorVersion: sourceAsset(SOURCE_DOCUMENT).extract?.version,
		filename: "requirements.txt",
		title: "Program requirements",
		summary: "Patient visits.",
		extract: SOURCE_TEXT,
		truncated: false,
	});
	expect(pkg.images).toEqual([
		{
			assetId: SOURCE_IMAGE,
			filename: "mockup.png",
			mediaType: "image/png",
			bytesDigest: sourceDigest(SOURCE_PNG),
			dataUrl: `data:image/png;base64,${SOURCE_PNG.toString("base64")}`,
		},
	]);
	expect(downloads.mock.calls).toEqual([
		[sourceAsset(SOURCE_IMAGE).gcsObjectKey, MAX_IMAGE_BYTES],
	]);
	expect(reads).toHaveBeenCalledOnce();
});

it.each(["foreign", "deleted", "pending", "wrong-kind"] as const)(
	"refuses %s image metadata before downloading it",
	async (scenario) => {
		if (scenario === "deleted")
			await h
				.db()
				.deleteFrom("media_assets")
				.where("id", "=", SOURCE_IMAGE)
				.execute();
		else
			await h
				.db()
				.updateTable("media_assets")
				.set(
					scenario === "foreign"
						? { project_id: "foreign-project" }
						: scenario === "pending"
							? { status: "pending" }
							: { kind: "text", mime_type: "text/plain" },
				)
				.where("id", "=", SOURCE_IMAGE)
				.execute();
		await expect(buildDesignSourcePackage(args())).rejects.toBeInstanceOf(
			SourcePackageError,
		);
		expect(downloads).not.toHaveBeenCalled();
	},
);

it("rebuilds the accepted prefix when a later message reattaches the same assets", async () => {
	const pkg = await buildDesignSourcePackage(args());
	await insertDesignSourcePackage({ pkg, authority });
	const messages = [
		...originalMessages(),
		sourceMessage("m2", "Add a new supervisor workflow.", [
			sourceRef(SOURCE_DOCUMENT),
			sourceRef(SOURCE_IMAGE),
		]),
	];
	expect(
		await rebuildPackageForDigest({
			...args(messages),
			digest: pkg.packageDigest,
		}),
	).toEqual(pkg);
});

it.each([
	"text",
	"extract",
	"image",
	"missing-message",
	"missing-asset",
] as const)(
	"refuses replay when original %s evidence changes",
	async (scenario) => {
		const pkg = await buildDesignSourcePackage(args());
		await insertDesignSourcePackage({ pkg, authority });
		const messages = originalMessages();
		if (scenario === "text")
			messages[0].parts = [{ type: "text", text: "A changed request" }];
		if (scenario === "extract")
			objects.set(
				extractObjectKeyForAsset(sourceAsset(SOURCE_DOCUMENT)) ?? "missing",
				Buffer.from("Changed requirements"),
			);
		if (scenario === "image")
			objects.set(sourceAsset(SOURCE_IMAGE).gcsObjectKey, OTHER_SOURCE_PNG);
		if (scenario === "missing-message") messages.splice(0, 1);
		if (scenario === "missing-asset")
			await h
				.db()
				.deleteFrom("media_assets")
				.where("id", "=", SOURCE_IMAGE)
				.execute();
		expect(
			await rebuildPackageForDigest({
				...args(messages),
				digest: pkg.packageDigest,
			}),
		).toBeNull();
	},
);

it("includes a trailing attachment-only message and excludes a later duplicate", async () => {
	const messages = [
		sourceMessage("m1", "Build patient visits."),
		sourceMessage("m2", "", [
			sourceRef(SOURCE_DOCUMENT),
			sourceRef(SOURCE_IMAGE),
		]),
	];
	const pkg = await buildDesignSourcePackage(args(messages));
	await insertDesignSourcePackage({ pkg, authority });
	expect(
		await rebuildPackageForDigest({
			...args([
				...messages,
				sourceMessage("m3", "Later request", [sourceRef(SOURCE_IMAGE)]),
			]),
			digest: pkg.packageDigest,
		}),
	).toEqual(pkg);
});
