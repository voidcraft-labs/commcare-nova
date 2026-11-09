/** Source admission through the real route, Postgres lifecycle and SDK.
 * Authentication, object storage and the provider HTTP destination are controlled. */
import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { withResponsesPeer } from "@/lib/agent/__tests__/responsesPeer";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import {
	incomingSourceReferences,
	removeRejectedSources,
	sourceAdmissionRejectionSchema,
} from "@/lib/chat/sourceAdmission";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { insertReadyAsset } from "@/lib/db/mediaAssets";
import { getCurrentPeriod } from "@/lib/db/period";
import { loadThread } from "@/lib/db/threads";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { ChatResponsesPeer } from "./chatResponsesPeer";

const {
	resolveOpenAIKey,
	requireSession,
	transport,
	readTextObject,
	writeTextObject,
	downloadAssetBytes,
} = vi.hoisted(() => ({
	resolveOpenAIKey: vi.fn(),
	requireSession: vi.fn(),
	writeTextObject: vi.fn(),
	transport: { current: undefined as typeof fetch | undefined },
	readTextObject: vi.fn(),
	downloadAssetBytes: vi.fn(),
}));
vi.mock("@/lib/auth-utils", () => ({ resolveOpenAIKey, requireSession }));
vi.mock("@/lib/storage/media", async (original) => ({
	...(await original<typeof import("@/lib/storage/media")>()),
	readTextObject,
	writeTextObject,
	deleteAsset: vi.fn(),
	downloadAssetBytes,
}));
vi.mock("@/lib/agent/openaiProvider", async (original) => {
	const actual = await original<typeof import("@/lib/agent/openaiProvider")>();
	return {
		...actual,
		createNovaOpenAI: (key: string, custom?: typeof fetch) => {
			const destination = custom ?? transport.current;
			if (!destination)
				throw new Error("Unexpected model call before source admission");
			return actual.createNovaOpenAI(key, destination);
		},
	};
});
const { POST } = await import("../route");
const { POST: prepareDocument } = await import(
	"../../media/[assetId]/extract/route"
);
const h = setupAppStateTestDb("source_admission_", {
	authSchema: "migrated",
	poolMax: 4,
});
const USER = "source-owner",
	PROJECT = "source-project",
	THREAD = "source-thread";
const ASSET = testMediaAssetId("unreadable-source");
const extract = {
	status: "failed" as "ready" | "failed" | "extracting",
	version: EXTRACTOR_VERSION,
	model: "offline",
	truncated: false,
	charCount: 14,
	extractedAt: 1,
};
const reference = {
	assetId: ASSET,
	kind: "text" as const,
	filename: "workflow.md",
	mimeType: "text/markdown",
	title: "Forged ready title",
};
const message: NovaUIMessage = {
	id: "new-request",
	role: "user",
	parts: [{ type: "text", text: "Use this workflow for household visits" }],
	metadata: { attachments: [reference] },
};

beforeEach(async () => {
	await h.seedProjectMember(USER, PROJECT, "owner");
	requireSession.mockResolvedValue({ user: { id: USER } });
	writeTextObject.mockReset();
	resolveOpenAIKey.mockResolvedValue({
		ok: true,
		apiKey: "local-only",
		session: { user: { id: USER } },
	});
	readTextObject.mockReset().mockResolvedValue("Visit workflow");
	downloadAssetBytes
		.mockReset()
		.mockRejectedValue(new Error("Object unavailable"));
	await h
		.db()
		.insertInto("credit_months")
		.values({
			user_id: USER,
			period: getCurrentPeriod(),
			allowance: 1000,
			consumed: 0,
			bonus: 0,
			updated_at: new Date().toISOString(),
		})
		.execute();
	await insertReadyAsset({
		assetId: ASSET,
		owner: USER,
		project_id: PROJECT,
		contentHash: "a".repeat(64),
		mimeType: "text/markdown",
		kind: "text",
		extension: ".md",
		sizeBytes: 14,
		gcsObjectKey: `projects/${PROJECT}/source.md`,
		originalFilename: reference.filename,
		extract,
	});
});
function request(
	messages: NovaUIMessage[],
	fields: Record<string, unknown> = {},
) {
	return new Request("http://localhost/api/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			threadId: THREAD,
			expectedProjectId: PROJECT,
			messages,
			...fields,
		}),
	});
}
async function consumed() {
	return (
		await h
			.db()
			.selectFrom("credit_months")
			.select("consumed")
			.where("user_id", "=", USER)
			.executeTakeFirstOrThrow()
	).consumed;
}
async function prepareSource(status: typeof extract.status = "ready") {
	await h
		.db()
		.updateTable("media_assets")
		.set({ extract: JSON.stringify({ ...extract, status }) })
		.where("id", "=", ASSET)
		.execute();
}
async function withPeer(run: (peer: ChatResponsesPeer) => Promise<void>) {
	const peer = new ChatResponsesPeer();
	try {
		await withResponsesPeer(peer.handle, async (_provider, fetch) => {
			transport.current = fetch;
			try {
				await run(peer);
				peer.assertHealthy();
			} finally {
				transport.current = undefined;
				peer.close();
			}
		});
	} finally {
		peer.close();
	}
}
function finalText(peer: ChatResponsesPeer) {
	const response = peer.response();
	response.text("Please confirm which team collects the visits.");
	response.finish();
}

it.each(["build", "edit"] as const)(
	"rejects failed new sources before %s claims and accepts the same request after explicit preparation",
	async (mode) => {
		const fields =
			mode === "edit"
				? {
						appId: await h.seedApp({
							owner: USER,
							project_id: PROJECT,
							status: "complete",
						}),
					}
				: {};
		await withPeer(async (peer) => {
			const refused = await POST(request([message], fields));
			expect(refused.status).toBe(409);
			const rejection = sourceAdmissionRejectionSchema.parse(
				await refused.json(),
			);
			expect(rejection.references).toEqual([
				{ messageId: message.id, assetId: ASSET },
			]);
			expect(peer.requests).toHaveLength(0);
			expect(readTextObject).not.toHaveBeenCalled();
			expect(await consumed()).toBe(0);
			expect(
				await h.db().selectFrom("threads").select("thread_id").execute(),
			).toEqual([]);
			expect(
				await h.db().selectFrom("design_sessions").select("id").execute(),
			).toEqual([]);
			if (fields.appId !== undefined)
				expect((await h.readAppRow(fields.appId))?.lock_run_id).toBeNull();

			await prepareSource();
			finalText(peer);
			const accepted = await POST(request([message], fields));
			const wire = await accepted.text();
			expect(accepted.status).toBe(200);
			expect(wire).toContain("Please confirm");
			expect(peer.requests).toHaveLength(1);
			// The admitted content is reused by both executors, even if a second
			// storage read would fail. One read proves the source was not re-resolved.
			expect(readTextObject).toHaveBeenCalledTimes(1);
			expect(
				await h.db().selectFrom("threads").select("thread_id").execute(),
			).toEqual([{ thread_id: THREAD }]);
		});
	},
);

it("refuses stale readiness, missing extract bytes and an image download failure without a run or model request", async () => {
	const appId = await h.seedApp({
		owner: USER,
		project_id: PROJECT,
		status: "complete",
	});
	await withPeer(async (peer) => {
		for (const status of ["extracting", "ready"] as const) {
			await prepareSource(status);
			readTextObject.mockResolvedValueOnce(null);
			const response = await POST(request([message], { appId }));
			expect(response.status).toBe(409);
			await response.json();
		}
		await h
			.db()
			.updateTable("media_assets")
			.set({
				kind: "image",
				mime_type: "image/png",
				extension: ".png",
				media_format: "png",
				extract: null,
			})
			.where("id", "=", ASSET)
			.execute();
		const imageMessage: NovaUIMessage = {
			...message,
			metadata: {
				attachments: [{ ...reference, kind: "image", mimeType: "image/png" }],
			},
		};
		const response = await POST(request([imageMessage], { appId }));
		expect(response.status).toBe(409);
		await response.json();
		expect(peer.requests).toHaveLength(0);
		expect(await consumed()).toBe(0);
		expect(
			await h.db().selectFrom("threads").select("thread_id").execute(),
		).toEqual([]);
	});
});

it("keeps a pending question round and its reservation intact when answer files fail; explicit removal resumes it", async () => {
	await withPeer(async (peer) => {
		const question = peer.response();
		question.tool(
			"askQuestions",
			{
				header: "Workflow",
				questions: [
					{ question: "Who collects visits?", options: [{ label: "Nurses" }] },
				],
			},
			{ callId: "team-question" },
		);
		question.finish();
		const opening: NovaUIMessage = { ...message, metadata: undefined };
		const first = await POST(request([opening]));
		await first.text();
		const session = await h
			.db()
			.selectFrom("design_sessions")
			.selectAll()
			.executeTakeFirstOrThrow();
		const target = {
			kind: "design-session" as const,
			designSessionId: session.id,
		};
		const paused = await loadThread(target, THREAD, USER);
		if (!paused?.input_round || !paused.holder_nonce)
			throw new Error("Expected an answer invitation");
		const answered = (paused.messages as NovaUIMessage[]).map((entry) => ({
			...entry,
			parts: entry.parts.map((part) =>
				part.type === "tool-askQuestions"
					? {
							type: "tool-askQuestions" as const,
							toolCallId: part.toolCallId,
							input: part.input,
							state: "output-available" as const,
							output: { "0": "Nurses" },
						}
					: part,
			),
		}));
		const reply: NovaUIMessage = {
			...message,
			id: "answer-files",
			parts: [{ type: "text", text: "Attached: workflow.md" }],
		};
		const messages = [...answered, reply];
		const fields = {
			designSessionId: session.id,
			runId: paused.run_id,
			holderNonce: paused.holder_nonce,
			inputRoundId: paused.input_round.id,
		};
		const beforeCredit = await consumed();
		const response = await POST(request(messages, fields));
		expect(response.status).toBe(409);
		const rejection = sourceAdmissionRejectionSchema.parse(
			await response.json(),
		);
		const stillPaused = await loadThread(target, THREAD, USER);
		expect(stillPaused?.input_round).toEqual(paused.input_round);
		expect(stillPaused?.holder_nonce).toBe(paused.holder_nonce);
		expect(stillPaused?.messages).toEqual(paused.messages);
		expect(await consumed()).toBe(beforeCredit);
		expect(peer.requests).toHaveLength(1);
		finalText(peer);
		const retry = await POST(
			request(removeRejectedSources(messages, rejection), fields),
		);
		const wire = await retry.text();
		expect(retry.status).toBe(200);
		expect(wire).toContain("Please confirm");
		expect(peer.requests).toHaveLength(2);
		expect(
			incomingSourceReferences(
				(await loadThread(target, THREAD, USER))?.messages as NovaUIMessage[],
				paused.messages as NovaUIMessage[],
			),
		).toEqual([]);
	});
});

it("does not re-admit an old unreadable source when an edit submits a new message without files", async () => {
	const appId = await h.seedApp({
		owner: USER,
		project_id: PROJECT,
		status: "complete",
	});
	await prepareSource();
	await withPeer(async (peer) => {
		finalText(peer);
		const first = await POST(request([message], { appId }));
		await first.text();
		const target = { kind: "app" as const, appId };
		const saved = await loadThread(target, THREAD, USER);
		if (!saved) throw new Error("Expected an admitted conversation");
		await prepareSource("failed");
		readTextObject.mockResolvedValue(null);
		const next: NovaUIMessage = {
			id: "unrelated-edit",
			role: "user",
			parts: [{ type: "text", text: "Rename the visit form" }],
		};
		finalText(peer);
		const second = await POST(
			request([...(saved.messages as NovaUIMessage[]), next], { appId }),
		);
		const wire = await second.text();
		expect(second.status).toBe(200);
		expect(wire).toContain("Please confirm");
		expect(peer.requests).toHaveLength(2);
		const history = JSON.stringify(peer.requests[1]);
		expect(history).toContain("couldn't be read");
		expect(history).toContain("Rename the visit form");
	});
});

it("checks every new message and refuses missing, foreign and mismatched references before reading bytes", async () => {
	const appId = await h.seedApp({
		owner: USER,
		project_id: PROJECT,
		status: "complete",
	});
	const last: NovaUIMessage = {
		id: "second-new-message",
		role: "user",
		parts: [{ type: "text", text: "Use the attached workflow" }],
	};
	await prepareSource();
	await withPeer(async (peer) => {
		// Moving the failed source earlier in a non-browser request cannot
		// turn it into historical evidence: neither message was admitted.
		await prepareSource("failed");
		const earlier = await POST(request([message, last], { appId }));
		expect(earlier.status).toBe(409);
		await earlier.json();
		await prepareSource();
		const missing = {
			...message,
			metadata: {
				attachments: [
					{ ...reference, assetId: testMediaAssetId("missing-source") },
				],
			},
		};
		const mismatch = {
			...message,
			metadata: { attachments: [{ ...reference, kind: "pdf" as const }] },
		};
		for (const input of [missing, mismatch]) {
			const response = await POST(request([input], { appId }));
			expect(response.status).toBe(409);
			await response.json();
		}
		await h.seedProjectMember("other-owner", "other-project", "owner");
		await h
			.db()
			.updateTable("media_assets")
			.set({ project_id: "other-project" })
			.where("id", "=", ASSET)
			.execute();
		const foreign = await POST(request([message], { appId }));
		expect(foreign.status).toBe(409);
		const body = await foreign.text();
		expect(body).not.toContain("other-project");
		expect(readTextObject).not.toHaveBeenCalled();
		expect(downloadAssetBytes).not.toHaveBeenCalled();
		expect(peer.requests).toHaveLength(0);
		expect(await consumed()).toBe(0);
	});
});

it("explicit preparation rebuilds a missing ready extract before the same rejected message can run", async () => {
	await prepareSource();
	const objects = new Map<string, string>();
	readTextObject.mockImplementation(
		async (key: string) => objects.get(key) ?? null,
	);
	writeTextObject.mockImplementation(async (key: string, text: string) => {
		objects.set(key, text);
	});
	downloadAssetBytes.mockResolvedValue(
		Buffer.from("Collect visit date and outcome"),
	);
	vi.stubEnv("OPENAI_API_KEY", "local-only");
	try {
		await withPeer(async (peer) => {
			const rejected = await POST(request([message]));
			expect(rejected.status).toBe(409);
			await rejected.json();
			expect(peer.requests).toHaveLength(0);
			expect(await consumed()).toBe(0);
			const extraction = peer.response();
			extraction.text(
				JSON.stringify({
					title: "Visit requirements",
					summary: "Collect visit data",
					extract: "Collect visit date and outcome",
				}),
			);
			extraction.finish();
			const prepared = await prepareDocument(
				new NextRequest(`http://localhost/api/media/${ASSET}/extract`, {
					method: "POST",
				}),
				{ params: Promise.resolve({ assetId: ASSET }) },
			);
			expect(prepared.status).toBe(200);
			expect(await prepared.text()).toContain('"status":"ready"');
			expect(writeTextObject).toHaveBeenCalledOnce();
			expect(peer.requests).toHaveLength(1);
			finalText(peer);
			const accepted = await POST(request([message]));
			expect(accepted.status).toBe(200);
			expect(await accepted.text()).toContain("Please confirm");
			expect(peer.requests).toHaveLength(2);
		});
	} finally {
		vi.unstubAllEnvs();
	}
});
