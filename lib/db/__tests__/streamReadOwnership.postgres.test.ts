import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { getSessionSafe, requireSession } from "@/lib/auth-utils";
import { appendStreamChunks } from "../streamChunks";
import {
	__setListenerConfigForTests,
	closeStreamListener,
	subscribeLookupProject,
} from "../streamListener";
import { setupAppStateTestDb } from "./appStateTestDb";

vi.mock("@/lib/auth-utils", () => ({
	requireSession: vi.fn(),
	getSessionSafe: vi.fn(),
}));
const h = setupAppStateTestDb("stream_owner_", { authSchema: "migrated" });
const APP = "stream-owned-app",
	ACTOR = "stream-owner",
	PROJECT = "stream-project",
	STREAM = "stream-owned-chat";
let appGET: typeof import("@/app/api/apps/[id]/stream/route").GET;
let chatGET: typeof import("@/app/api/chat/[streamId]/stream/route").GET;

beforeAll(async () => {
	vi.stubEnv("NOVA_STREAM_CADENCE_MS", "20");
	vi.stubEnv("NOVA_CHAT_STREAM_CADENCE_MS", "20");
	appGET = (await import("@/app/api/apps/[id]/stream/route")).GET;
	chatGET = (await import("@/app/api/chat/[streamId]/stream/route")).GET;
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(async () => {
	await h.seedApp({
		id: APP,
		owner: ACTOR,
		project_id: PROJECT,
		status: "generating",
		run_id: "run",
		run_holder_nonce: "00000000-0000-4000-8000-000000000001",
	});
	const now = new Date();
	const session = {
		user: {
			id: ACTOR,
			name: "Stream owner",
			email: "stream@dimagi.com",
			emailVerified: true,
			banned: false,
			createdAt: now,
			updatedAt: now,
		},
		session: {
			id: "session",
			token: "fixture-token",
			userId: ACTOR,
			expiresAt: new Date(now.getTime() + 60_000),
			createdAt: now,
			updatedAt: now,
		},
	};
	vi.mocked(requireSession).mockResolvedValue(session);
	vi.mocked(getSessionSafe).mockResolvedValue(session);
	__setListenerConfigForTests(h.uri());
	let connected = false;
	const unsubscribe = subscribeLookupProject(PROJECT, () => {
		connected = true;
	});
	try {
		await vi.waitFor(() => expect(connected).toBe(true));
	} finally {
		unsubscribe();
	}
});
afterEach(async () => {
	await closeStreamListener();
	__setListenerConfigForTests(null);
});

const lanes = [
	{
		name: "app mutation",
		route: "app",
		table: "app_changes",
		channel: "nova_app_stream",
		payload: { appId: APP, seq: 0 },
	},
	{
		name: "presence roster",
		route: "app",
		table: "presence",
		channel: "nova_presence",
		payload: { appId: APP },
	},
	{
		name: "lookup manifest",
		route: "app",
		table: "lookup_tables",
		channel: "nova_lookup_stream",
		payload: { projectId: PROJECT, revision: "0" },
	},
	{
		name: "deployment",
		route: "app",
		table: "app_deployments",
		channel: "nova_app_stream",
		payload: { appId: APP, deploymentChanged: true },
	},
	{
		name: "app cadence",
		route: "app",
		table: "auth_user",
		channel: null,
		payload: {},
	},
	{
		name: "chat replay",
		route: "chat",
		table: "chat_stream_chunks",
		channel: "nova_chat_stream",
		payload: { streamId: STREAM },
	},
	{
		name: "chat cadence",
		route: "chat",
		table: "auth_user",
		channel: null,
		payload: {},
	},
] as const;

describe("stream completion owns reads already in flight", () => {
	for (const lane of lanes) {
		it.each(["cancel", "abort"] as const)(
			`${lane.name}: %s waits for the real PostgreSQL read`,
			async (end) => {
				if (lane.route === "chat")
					await appendStreamChunks({
						streamId: STREAM,
						target: { kind: "app", appId: APP },
						runId: "run",
						firstIndex: 0,
						chunks: [{ type: "start", messageId: "message" }],
						terminal: false,
					});
				const controller = new AbortController();
				const request = new Request("http://localhost/api/stream", {
					signal: controller.signal,
				});
				const response =
					lane.route === "app"
						? await appGET(request, { params: Promise.resolve({ id: APP }) })
						: await chatGET(request, {
								params: Promise.resolve({ streamId: STREAM }),
							});
				expect(response.status).toBe(200);
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Missing stream response body");
				try {
					const decoder = new TextDecoder();
					let received = "";
					while (
						lane.route === "chat"
							? !received.includes('"type":"start"')
							: ![
									"event: presence",
									"event: lookup-revision",
									"event: preview-project-space",
								].every((frame) => received.includes(frame))
					) {
						const read = await reader.read();
						if (read.done) throw new Error("Stream ended before initial data");
						received += decoder.decode(read.value, { stream: true });
					}
					const stop = Promise.withResolvers<void>();
					let stopped = false;
					await whileBlocked(
						h,
						(pg) =>
							pg.query(`LOCK TABLE ${lane.table} IN ACCESS EXCLUSIVE MODE`),
						async () => {
							if (lane.channel !== null)
								await h
									.pool()
									.query("SELECT pg_notify($1, $2)", [
										lane.channel,
										JSON.stringify(lane.payload),
									]);
							await stop.promise;
							if (end === "cancel") await reader.cancel();
							else {
								controller.abort();
								while (!(await reader.read()).done) {
									/* Drain queued frames through actual EOF. */
								}
							}
							stopped = true;
						},
						async (_settled, pg) => {
							stop.resolve();
							await pg.query("SELECT 1");
							expect(stopped).toBe(false);
						},
						() => stop.resolve(),
					);
					expect(stopped).toBe(true);
					const active = await h
						.pool()
						.query(
							"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND state <> 'idle'",
						);
					expect(active.rows).toEqual([{ count: 0 }]);
				} finally {
					controller.abort();
					await reader.cancel();
				}
			},
		);
	}
});
