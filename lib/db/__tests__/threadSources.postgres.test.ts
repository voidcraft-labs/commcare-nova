import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { insertThreadFixture } from "@/__tests__/helpers/threadFixture";
import type { RetainedSource } from "@/lib/chat/retainedSource";
import { __setAppDbForTests } from "../pg";
import {
	loadThreadRetainedSources,
	retainThreadSource,
} from "../threadSources";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("retained_source_reads_");

it("transfers a retained image once across repeated message references in an authorized snapshot", async () => {
	const appId = await h.seedApp({ owner: "owner", project_id: "project" });
	await insertThreadFixture(h.db(), {
		thread_id: "thread",
		app_id: appId,
		thread_type: "edit",
		run_id: "run",
		summary: "Repeated source",
		created_at: "2026-01-01",
		updated_at: "2026-01-01",
		messages: "[]",
	});
	const bytes = Buffer.alloc(128 * 1024, 97);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const source: RetainedSource = {
		kind: "image",
		filename: "figure.png",
		mimeType: "image/png",
		contentHash: digest,
		content: {
			kind: "image",
			mediaType: "image/png",
			dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
			bytesDigest: digest,
		},
	};
	await h
		.db()
		.transaction()
		.execute(async (tx) => {
			for (let i = 0; i < 20; i++)
				await retainThreadSource(tx, {
					threadId: "thread",
					messageId: `message-${i}`,
					assetId: "80000000-0000-4000-8000-000000000001",
					provenance: "admitted",
					source,
				});
		});
	let returnedBytes = 0;
	let queries = 0;
	__setAppDbForTests(
		h.db().withPlugin({
			transformQuery: (args) => args.node,
			transformResult: async (args) => {
				returnedBytes += Buffer.byteLength(JSON.stringify(args.result.rows));
				queries++;
				return args.result;
			},
		}),
	);
	try {
		const refs = await loadThreadRetainedSources(
			{ kind: "app", appId },
			"thread",
			"project",
		);
		expect(refs.size).toBe(20);
		for (const ref of refs.values()) expect(ref.source).toEqual(source);
		expect(queries).toBe(1);
		expect(returnedBytes).toBeLessThan(
			2 * Buffer.byteLength(JSON.stringify(source)),
		);
		expect(
			await loadThreadRetainedSources(
				{ kind: "app", appId },
				"thread",
				"other-project",
			),
		).toEqual(new Map());
	} finally {
		__setAppDbForTests(h.db());
	}
});
