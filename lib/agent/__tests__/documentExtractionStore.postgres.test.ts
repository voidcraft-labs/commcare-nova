/** Real extraction-store transactions and content locks. Object storage is a
 * controlled byte boundary; the actual SDK talks to a local Responses peer.
 * This proves Nova's publication ordering, not GCS service behavior. */
import type { ServerResponse } from "node:http";
import type { LanguageModelUsage } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadAssetById, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	asMediaAssetId,
	EXTRACTOR_VERSION,
	extractObjectKeyForAsset,
} from "@/lib/domain/multimedia";
import { MODEL_ROLES } from "@/lib/models";
import type { AttachmentCondenser } from "../documentExtraction";
import { ensureStoredExtract } from "../documentExtractionStore";
import { runStructuredWith } from "../modelRunContext";
import type { createNovaOpenAI } from "../openaiProvider";
import {
	prepareEmbeddedSourceDocument,
	readSourceDocument,
} from "../sourceDocuments";
import { productionSourceMaterialDeps } from "../sources.server";
import { respondWithObject, withResponsesPeer } from "./responsesPeer";

const { objects, objectWrites } = vi.hoisted(() => ({
	objects: new Map<string, string>(),
	objectWrites: vi.fn(),
}));
vi.mock("@/lib/storage/media", () => ({
	readTextObject: async (key: string) => objects.get(key) ?? null,
	downloadAssetBytes: async () => Buffer.from("Visit date and outcome"),
	writeTextObject: async (key: string, text: string) => {
		objects.set(key, text);
		objectWrites(key, text);
	},
	deleteAsset: async (key: string) => {
		objects.delete(key);
	},
}));

const h = setupAppStateTestDb("extract_store_", { poolMax: 4 });
beforeEach(() => {
	objects.clear();
	objectWrites.mockClear();
});

async function seedAsset(extension = ".txt"): Promise<MediaAssetRecord> {
	const id = asMediaAssetId(crypto.randomUUID());
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			owner: "extractor-user",
			project_id: "extractor-project",
			content_hash: "a".repeat(64),
			mime_type: "text/plain",
			extension,
			size_bytes: 22,
			kind: "text",
			gcs_object_key: `projects/extractor-project/${"a".repeat(64)}${extension}`,
			original_filename: `notes${extension}`,
			status: "ready",
		})
		.execute();
	const asset = await loadAssetById(id);
	if (!asset) throw new Error("Seeded document missing");
	return asset;
}
function condenser(
	provider: ReturnType<typeof createNovaOpenAI>,
	signal = new AbortController().signal,
	track: (usage: LanguageModelUsage) => void = () => {},
): AttachmentCondenser {
	return {
		async extractDocumentStructured(opts) {
			if (opts.maxOutputTokens === undefined)
				throw new Error("Extraction must provide its output budget");
			const result = await runStructuredWith(
				provider(MODEL_ROLES.documentExtractor.modelId),
				{
					...opts,
					maxOutputTokens: opts.maxOutputTokens,
					modelId: opts.model,
					signal: opts.signal ? AbortSignal.any([opts.signal, signal]) : signal,
				},
				track,
			);
			return {
				object: result.object,
				truncated: result.finishReason === "length",
			};
		},
	};
}
function output(response: ServerResponse, extract = "FIRST EXTRACT") {
	respondWithObject(
		response,
		JSON.stringify({
			title: "Visit requirements",
			summary: "Collect visit data.",
			extract,
		}),
	);
}

it("prepares a library source through its injected run meter once and reuses it for external reads", async () => {
	const asset = await seedAsset();
	let calls = 0;
	await withResponsesPeer(
		(request, response) => {
			request.resume();
			calls++;
			output(response, "Visit date and outcome requirements");
		},
		async (provider) => {
			const usage: LanguageModelUsage[] = [];
			const authorize = vi.fn(async () => {});
			const selected = vi.fn(async () => {});
			const runtime = {
				prepare: (
					document: MediaAssetRecord,
					kind: "text" | "pdf" | "docx" | "xlsx",
					signal?: AbortSignal,
				) =>
					prepareEmbeddedSourceDocument({
						asset: document,
						documentKind: kind,
						condenser: condenser(provider, undefined, (entry) => {
							usage.push(entry);
						}),
						authorize,
						signal,
					}),
				selected,
			};
			const read = () =>
				readSourceDocument({
					projectId: asset.project_id,
					input: { document: asset.originalFilename },
					requestId: "library-read",
					runtime,
				});
			expect(await read()).toMatchObject({
				status: "ready",
				assetId: asset.id,
				text: "Visit date and outcome requirements",
			});
			expect(calls).toBe(1);
			expect(usage).toHaveLength(1);
			expect(usage[0]).toMatchObject({ inputTokens: 11, outputTokens: 7 });
			expect(authorize).toHaveBeenCalledOnce();
			expect(selected).toHaveBeenCalledOnce();
			expect(await read()).toMatchObject({ status: "ready" });
			// An external host has no preparation callback, but reads the same cache.
			expect(
				await readSourceDocument({
					projectId: asset.project_id,
					input: { document: asset.id },
					requestId: "external-read",
				}),
			).toMatchObject({ status: "ready" });
			expect(calls).toBe(1);
			expect(usage).toHaveLength(1);
		},
	);
});

it("cancels and joins a real provider request when preparation loses its run authority", async () => {
	const asset = await seedAsset();
	const received = Promise.withResolvers<void>();
	const disconnected = Promise.withResolvers<void>();
	await withResponsesPeer(
		(request, response) => {
			request.resume();
			response.once("close", () => disconnected.resolve());
			received.resolve();
		},
		async (provider) => {
			// Only the preparation owner's interval is virtual; HTTP/provider timers
			// remain real so cancellation must close the actual request.
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const controller = new AbortController();
			const stopped = new Error("The run was stopped.");
			const authorize = vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValue(stopped);
			const pending = prepareEmbeddedSourceDocument({
				asset,
				documentKind: "text",
				condenser: condenser(provider),
				authorize,
				signal: controller.signal,
			});
			const observed = pending.then(
				() => ({ error: null }),
				(error: unknown) => ({ error }),
			);
			try {
				await Promise.race([
					received.promise,
					pending.then(() => {
						throw new Error("Preparation completed before the request");
					}),
				]);
				await vi.advanceTimersByTimeAsync(60_000);
				expect((await observed).error).toBe(stopped);
				await disconnected.promise;
				expect((await loadAssetById(asset.id))?.extract?.status).toBe("failed");
				expect(objectWrites).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				controller.abort();
				await observed;
				vi.useRealTimers();
			}
		},
	);
});

it("does not rebill a failed extraction on repeated reads in one run, and permits a new turn to retry", async () => {
	const asset = await seedAsset();
	let calls = 0;
	await withResponsesPeer(
		(request, response) => {
			request.resume();
			calls++;
			respondWithObject(
				response,
				JSON.stringify({
					title: "Requirements",
					summary: "Visit requirements.",
					extract: "Visit date and outcome",
				}),
				{ incomplete: calls === 1 },
			);
		},
		async (provider) => {
			const makeRuntime = () => ({
				prepare: productionSourceMaterialDeps(condenser(provider), {
					authorize: async () => {},
				}).prepareDocument,
			});
			const runtime = makeRuntime();
			const args = {
				projectId: asset.project_id,
				input: { document: asset.id },
				requestId: "failed-read",
			};
			expect(await readSourceDocument({ ...args, runtime })).toMatchObject({
				status: "failed",
			});
			expect(await readSourceDocument({ ...args, runtime })).toMatchObject({
				status: "failed",
			});
			expect(calls).toBe(1);
			expect(
				await readSourceDocument({ ...args, runtime: makeRuntime() }),
			).toMatchObject({ status: "ready", text: "Visit date and outcome" });
			expect(calls).toBe(2);
			// Even the first run can use the newly published extract without billing.
			expect(await readSourceDocument({ ...args, runtime })).toMatchObject({
				status: "ready",
			});
			expect(calls).toBe(2);
		},
	);
});

it("does not claim or call the model when a preparation's initial authority check fails", async () => {
	const asset = await seedAsset();
	const forbidden = new Error("Project access was revoked.");
	const model = vi.fn();
	await expect(
		prepareEmbeddedSourceDocument({
			asset,
			documentKind: "text",
			condenser: { extractDocumentStructured: model },
			authorize: async () => {
				throw forbidden;
			},
		}),
	).rejects.toBe(forbidden);
	expect((await loadAssetById(asset.id))?.extract).toBeUndefined();
	expect(model).not.toHaveBeenCalled();
});

it("contending store requests block on the actual claim row and run one model call", async () => {
	const asset = await seedAsset();
	let calls = 0;
	await withResponsesPeer(
		(request, response) => {
			request.resume();
			calls++;
			output(response);
		},
		async (provider) => {
			const opts = {
				asset,
				documentKind: "text" as const,
				condenser: condenser(provider),
				onInflight: "report" as const,
			};
			const results = await whileBlocked(
				h,
				(pg) =>
					pg.query("SELECT id FROM media_assets WHERE id=$1 FOR UPDATE", [
						asset.id,
					]),
				() =>
					Promise.all([ensureStoredExtract(opts), ensureStoredExtract(opts)]),
				async (settled, pg) => {
					const deadline = Date.now() + 1000;
					for (;;) {
						await pg.query("SELECT pg_stat_clear_snapshot()");
						const result = await pg.query<{ count: number }>(
							"WITH RECURSIVE blocked(pid) AS (SELECT pg_backend_pid() UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT (count(*)-1)::int AS count FROM blocked",
						);
						if (result.rows[0].count === 2) break;
						if (Date.now() > deadline)
							throw new Error(
								"Both extraction claims did not reach the held row",
							);
						await new Promise<void>((resolve) => setImmediate(resolve));
					}
					expect(settled).toBe(false);
					expect(calls).toBe(0);
					expect(objectWrites).not.toHaveBeenCalled();
				},
			);
			expect(results.map((result) => result.status).sort()).toEqual([
				"extracting",
				"ready",
			]);
			expect(calls).toBe(1);
			expect(objectWrites).toHaveBeenCalledOnce();
			expect((await loadAssetById(asset.id))?.extract).toMatchObject({
				status: "ready",
				version: EXTRACTOR_VERSION,
				title: "Visit requirements",
				charCount: "FIRST EXTRACT".length,
			});
			expect(
				objects.get(extractObjectKeyForAsset(asset) ?? "missing-document-key"),
			).toBe("FIRST EXTRACT");
		},
	);
});

it("does not recreate extract bytes when deletion wins while the model is running", async () => {
	const asset = await seedAsset();
	const received = Promise.withResolvers<ServerResponse>();
	await withResponsesPeer(
		(request, response) => {
			request.resume();
			received.resolve(response);
		},
		async (provider) => {
			const controller = new AbortController();
			const pending = ensureStoredExtract({
				asset,
				documentKind: "text",
				condenser: condenser(provider, controller.signal),
				onInflight: "report",
			});
			let response: ServerResponse | undefined;
			try {
				response = await Promise.race([
					received.promise,
					pending.then(() => {
						throw new Error("Extraction ended before the model request");
					}),
				]);
				expect((await loadAssetById(asset.id))?.extract?.status).toBe(
					"extracting",
				);
				await h
					.db()
					.deleteFrom("media_assets")
					.where("id", "=", asset.id)
					.execute();
				output(response);
				expect(await pending).toMatchObject({
					status: "failed",
					reason: expect.stringContaining("deleted"),
				});
				expect(await loadAssetById(asset.id)).toBeNull();
				expect(objectWrites).not.toHaveBeenCalled();
				expect(objects.size).toBe(0);
			} finally {
				controller.abort();
				if (response && !response.writableEnded) output(response);
				await Promise.allSettled([pending]);
			}
		},
	);
});

it("keeps the first published content pair when duplicate rows finish in reverse order", async () => {
	const first = await seedAsset();
	const second = await seedAsset(".md");
	const responses: ServerResponse[] = [];
	const nextRequest = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	await withResponsesPeer(
		(request, response) => {
			request.resume();
			responses.push(response);
			nextRequest[responses.length - 1].resolve();
		},
		async (provider) => {
			const controller = new AbortController();
			const core = condenser(provider, controller.signal);
			const firstPending = ensureStoredExtract({
				asset: first,
				documentKind: "text",
				condenser: core,
				onInflight: "report",
			});
			let secondPending: ReturnType<typeof ensureStoredExtract> | undefined;
			try {
				await Promise.race([
					nextRequest[0].promise,
					firstPending.then(() => {
						throw new Error("First extraction ended before the request");
					}),
				]);
				secondPending = ensureStoredExtract({
					asset: second,
					documentKind: "text",
					condenser: core,
					onInflight: "report",
				});
				await Promise.race([
					nextRequest[1].promise,
					secondPending.then(() => {
						throw new Error("Second extraction ended before the request");
					}),
				]);
				output(responses[1], "SECOND FINISHED FIRST");
				expect(await secondPending).toMatchObject({
					status: "ready",
					text: "SECOND FINISHED FIRST",
				});
				output(responses[0], "STALE FIRST OUTPUT");
				expect(await firstPending).toMatchObject({
					status: "ready",
					text: "SECOND FINISHED FIRST",
				});
				const [firstRow, secondRow] = await Promise.all([
					loadAssetById(first.id),
					loadAssetById(second.id),
				]);
				expect(firstRow?.extract).toEqual(secondRow?.extract);
				expect(firstRow?.extract?.charCount).toBe(
					"SECOND FINISHED FIRST".length,
				);
				expect(objectWrites).toHaveBeenCalledOnce();
				expect(
					objects.get(
						extractObjectKeyForAsset(first) ?? "missing-document-key",
					),
				).toBe("SECOND FINISHED FIRST");
			} finally {
				controller.abort();
				for (const response of responses)
					if (!response.writableEnded) output(response);
				await Promise.allSettled([firstPending, secondPending]);
			}
		},
	);
});
