/** The source tools must find library documents without conversation attachments,
 * isolate Projects, and keep paged evidence on one prepared revision. */
import { beforeEach, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	findSourceAssets,
	loadAssetById,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import {
	ASSET_KINDS,
	type AssetKind,
	asMediaAssetId,
	EXTRACTOR_VERSION,
	extractGcsObjectKeyFor,
} from "@/lib/domain/multimedia";
import {
	readSourceDocument,
	type SourceDocumentRuntime,
} from "../sourceDocuments";
import {
	listMediaAssetsInputSchema,
	listMediaAssetsTool,
} from "../tools/media/listMediaAssets";
import { makeCanonicalGenesisDoc, makeToolWorkspaceHarness } from "./fixtures";

const { objects, reads } = vi.hoisted(() => ({
	objects: new Map<string, string>(),
	reads: vi.fn(),
}));
vi.mock("@/lib/storage/media", () => ({
	readTextObject: async (
		key: string,
		_maxBytes: number,
		signal?: AbortSignal,
	) => {
		signal?.throwIfAborted();
		reads(key);
		return objects.get(key) ?? null;
	},
}));
const h = setupAppStateTestDb("source_documents_");
beforeEach(() => {
	objects.clear();
	reads.mockClear();
});

async function seed(
	opts: {
		name?: string;
		project?: string;
		kind?: AssetKind;
		text?: string;
		version?: number;
		status?: "ready" | "pending";
		extractStatus?: "ready" | "extracting" | "failed";
		createdAt?: Date;
	} = {},
): Promise<MediaAssetRecord> {
	const id = asMediaAssetId(crypto.randomUUID());
	const project = opts.project ?? "source-project";
	const hash = id.replaceAll("-", "").repeat(2);
	const extract =
		opts.text !== undefined || opts.extractStatus
			? {
					status: opts.extractStatus ?? "ready",
					version: opts.version ?? EXTRACTOR_VERSION,
					model: "recorded-extractor",
					truncated: false,
					charCount: opts.text?.length ?? 0,
					extractedAt: Date.now(),
					title: "Source requirements",
				}
			: undefined;
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: project,
			owner: "source-owner",
			content_hash: hash,
			mime_type: "text/plain",
			extension: ".md",
			size_bytes: 100,
			kind: opts.kind ?? "text",
			gcs_object_key: `projects/${project}/${hash}.md`,
			original_filename: opts.name ?? "Specification.md",
			status: opts.status ?? "ready",
			extract: extract ? JSON.stringify(extract) : null,
			created_at: opts.createdAt ?? new Date(),
		})
		.execute();
	if (opts.text !== undefined)
		objects.set(
			extractGcsObjectKeyFor(project, hash, opts.version ?? EXTRACTOR_VERSION),
			opts.text,
		);
	const asset = await loadAssetById(id);
	if (!asset) throw new Error("Missing source fixture");
	return asset;
}

function read(
	document: string,
	extra: { offset?: number; length?: number; revision?: string } = {},
	runtime?: SourceDocumentRuntime,
) {
	return readSourceDocument({
		projectId: "source-project",
		input: { document, ...extra },
		requestId: "source-read",
		runtime,
	});
}

it("finds unattached documents by exact name or id without revealing a foreign Project", async () => {
	const own = await seed({ text: "Collect a visit date." });
	const foreign = await seed({
		project: "another-project",
		text: "Private requirements",
	});
	expect(await read(own.originalFilename)).toMatchObject({
		status: "ready",
		assetId: own.id,
		text: "Collect a visit date.",
	});
	expect(await read(own.id)).toMatchObject({
		status: "ready",
		assetId: own.id,
	});
	reads.mockClear();
	expect(await read(foreign.id)).toMatchObject({ status: "not_found" });
	expect(await read(crypto.randomUUID())).toMatchObject({
		status: "not_found",
	});
	expect(reads).not.toHaveBeenCalled();
	const duplicate = await seed({ text: "A different specification" });
	const ambiguous = await read(own.originalFilename);
	expect(ambiguous).toMatchObject({ status: "ambiguous" });
	if (ambiguous.status !== "ambiguous")
		throw new Error("Expected ambiguous source");
	expect(
		ambiguous.candidates?.map((candidate) => candidate.assetId).sort(),
	).toEqual([own.id, duplicate.id].sort());
	expect(await read(duplicate.id)).toMatchObject({
		status: "ready",
		text: "A different specification",
	});
});

it("reads every page of one extract and refuses mixed revisions before selecting new evidence", async () => {
	const text = "abcdef".repeat(4001);
	const asset = await seed({ text });
	const selected = vi.fn(async () => {});
	const first = await read(asset.id, { length: 24_000 }, { selected });
	if (first.status !== "ready") throw new Error("Expected source page");
	expect(first).toMatchObject({
		representation: "requirements-extract",
		text: text.slice(0, 24_000),
		offset: 0,
		nextOffset: 24_000,
		totalCharacters: text.length,
		extractVersion: EXTRACTOR_VERSION,
	});
	expect(await read(asset.id, { offset: 24_000 })).toMatchObject({
		status: "revision_required",
	});
	expect(
		await read(asset.id, { offset: 24_000, revision: first.revision }),
	).toMatchObject({
		status: "ready",
		text: text.slice(24_000),
		nextOffset: null,
	});
	expect(
		await read(asset.id, { offset: text.length + 1, revision: first.revision }),
	).toMatchObject({ status: "invalid_offset" });
	objects.set(
		extractGcsObjectKeyFor(
			asset.project_id,
			asset.contentHash,
			EXTRACTOR_VERSION,
		),
		"Updated requirements",
	);
	expect(
		await read(
			asset.id,
			{ offset: 24_000, revision: first.revision },
			{ selected },
		),
	).toMatchObject({ status: "source_changed" });
	expect(selected).toHaveBeenCalledOnce();
	const reopened = await read(asset.id, {}, { selected });
	if (reopened.status !== "ready") throw new Error("Expected refreshed page");
	expect(reopened.revision).not.toBe(first.revision);
	expect(selected).toHaveBeenCalledTimes(2);
});

it("returns actionable preparation status without starting model work on a read-only host", async () => {
	const stale = await seed({
		text: "Old extract",
		version: EXTRACTOR_VERSION - 1,
	});
	const missing = await seed();
	const failed = await seed({ extractStatus: "failed" });
	const inflight = await seed({ extractStatus: "extracting" });
	const uploading = await seed({ status: "pending" });
	const image = await seed({ kind: "image" });
	const brokenObject = await seed({ text: "Missing object" });
	objects.delete(
		extractGcsObjectKeyFor(
			brokenObject.project_id,
			brokenObject.contentHash,
			EXTRACTOR_VERSION,
		),
	);
	for (const asset of [stale, missing, brokenObject])
		expect(await read(asset.id)).toMatchObject({
			status: "preparation_required",
		});
	expect(await read(failed.id)).toMatchObject({ status: "failed" });
	expect(await read(inflight.id)).toMatchObject({ status: "extracting" });
	expect(await read(uploading.id)).toMatchObject({ status: "uploading" });
	expect(await read(image.id)).toMatchObject({ status: "unsupported" });
});

it("exposes whole-Project search and every file kind through the existing shared list tool", async () => {
	const newest = Date.now();
	for (let index = 0; index < 51; index++)
		await seed({
			name: `Recent ${index}.md`,
			createdAt: new Date(newest - index),
		});
	const match = await seed({
		name: "SDD 20%_requirements.md",
		createdAt: new Date(newest - 1000),
	});
	await h
		.db()
		.updateTable("media_assets")
		.set({ display_name: "Current requirements" })
		.where("id", "=", match.id)
		.execute();
	await seed({ name: "SDD 20%_requirements.md", project: "another-project" });
	const workspace = makeToolWorkspaceHarness(makeCanonicalGenesisDoc(), {
		projectId: "source-project",
	}).workspace;
	const result = await workspace.invoke({
		toolName: "listMediaAssets",
		execute: (ctx) =>
			listMediaAssetsTool.execute(
				listMediaAssetsInputSchema.parse({
					kind: "text",
					query: "20%_requirements",
				}),
				{ ...ctx, appId: null },
			),
	});
	expect(result.data.assets.map((asset) => asset.id)).toEqual([match.id]);
	expect(result.data.nextCursor).toBeNull();
	expect(reads).not.toHaveBeenCalled();
	for (const kind of ASSET_KINDS)
		expect(listMediaAssetsInputSchema.parse({ kind }).kind).toBe(kind);
	expect(await findSourceAssets("another-project", match.id)).toEqual([]);
});
