/**
 * `list_hq_apps`, `read_hq_app` and `bring_in_hq_app` through the real SDK
 * client and server, over real Postgres, with CommCare HQ answering from its
 * own retained answers at a controlled peer, the stored key's decryption
 * controlled at the KMS boundary and the bucket at its own. The birth is
 * wrapped where a test needs one of Nova's own checks to refuse, and the read
 * is observed (never replaced) where a test needs to wait for it to end.
 *
 * It would catch: a retry that makes a second app; a client that times out
 * on an app with many files because no progress reaches it; a cancelled call
 * that keeps reading CommCare HQ; a refusal with no bucket; and a stop of the
 * list that reaches a client as a bare message with no next step.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import type { MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	retainedBodyJson,
	retainedBodyText,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { decrypt } from "@/lib/commcare/encryption";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { GenesisGateRejectedError } from "@/lib/db/appGenesis";
import { softDeleteApp } from "@/lib/db/apps";
import {
	changedAnswer,
	counterOf,
	FIXTURE_DOMAIN,
	FIXTURE_HOST,
	FIXTURE_PATHS,
	FIXTURE_REMOTE_APP_ID,
	FIXTURE_SERVER,
	fixtureResource,
	fixtureSource,
	fixtureSourceWithXml,
	seedFixtureConnection,
	serveAnswer,
	serveFixtureApp,
	serveFixtureTables,
	withIcons,
} from "@/lib/deployment/reading/__tests__/adoptionFixture";
import type { ReadingAnswer } from "@/lib/deployment/reading/types";
import { AS_ORIGIN } from "@/lib/hostnames";
import { createLookupTable } from "@/lib/lookup/service";
import { circumstanceBlock } from "@/lib/publish/hqFindingCopy";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import {
	CREATE_ANSWER_LEADS,
	READING_REFUSAL_COPY,
} from "@/lib/publish/hqReadingCopy";
import { uploadAssetBytes } from "@/lib/storage/media";
import {
	BRING_IN_TOOL_LEADS,
	registerBringInHqApp,
} from "../tools/bringInHqApp";
import { registerListHqApps } from "../tools/listHqApps";
import { registerReadHqApp } from "../tools/readHqApp";
import { withMcpClient } from "./client";
import { resultContentText } from "./resultText";

const observed = vi.hoisted(() => ({
	/** Each read the tool started, to wait on once its call is cancelled. */
	reads: [] as Promise<ReadingAnswer>[],
	/** Each stage the reads and creates named, in order. */
	stages: [] as string[],
	/** Run inside the birth's transaction before it, where a test needs one. */
	beforeBirth: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/deployment/reading", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/deployment/reading")>();
	return {
		...actual,
		readHqAppForReview: (
			...[actor, key, options]: Parameters<typeof actual.readHqAppForReview>
		) => {
			const read = actual.readHqAppForReview(actor, key, {
				...options,
				onEvent: (event) => {
					if (event.type === "stage") observed.stages.push(event.stage);
					options.onEvent(event);
				},
			});
			observed.reads.push(read);
			return read;
		},
	};
});
vi.mock("@/lib/deployment/reading/birth", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/deployment/reading/birth")>();
	return {
		...actual,
		adoptHqAppInTransaction: async (
			...[tx, birth]: Parameters<typeof actual.adoptHqAppInTransaction>
		) => {
			await observed.beforeBirth?.();
			return actual.adoptHqAppInTransaction(tx, birth);
		},
	};
});
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: vi.fn(),
	deleteAsset: vi.fn(),
	downloadAssetBytes: vi.fn(),
}));

const h = setupAppStateTestDb("mcp_bring_in_", {
	authSchema: "migrated",
	poolMax: 4,
});

const PROJECT = "bring-in-project";
const ACTOR = "bring-in-editor";
const STRANGER = "bring-in-stranger";
const VIEWER = "bring-in-viewer";
/* Every scope these tools need: reading and bringing in from CommCare HQ is `nova.hq.import`. */
const SCOPES = [
	"nova.read",
	"nova.write",
	"nova.hq.read",
	"nova.hq.write",
	"nova.hq.import",
];
const LIST = `/a/${FIXTURE_DOMAIN}/apps/api/list_apps/`;
const PROBE = `/a/${FIXTURE_DOMAIN}/api/lookup_table/v1/?limit=1`;
const PNG = readFileSync(
	join(import.meta.dirname, "../../media/__tests__/fixtures/pattern.png"),
);

beforeEach(async () => {
	observed.reads.length = 0;
	observed.stages.length = 0;
	observed.beforeBirth = null;
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	vi.mocked(uploadAssetBytes).mockReset();
	vi.mocked(uploadAssetBytes).mockResolvedValue(undefined);
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await seedFixtureConnection(ACTOR);
});

type Json = Record<string, unknown>;

/** The three tools, called as `userId`. */
function withTools<T>(
	run: (client: Client) => Promise<T>,
	userId = ACTOR,
	scopes = SCOPES,
): Promise<T> {
	return withMcpClient((server) => {
		const ctx = { userId, scopes, authKind: "api-key" as const };
		registerListHqApps(server, ctx);
		registerReadHqApp(server, ctx);
		registerBringInHqApp(server, ctx);
	}, run);
}

/** A tool's answer, parsed, and whether it was an error. */
async function call(
	client: Client,
	name: string,
	args: Json,
): Promise<{ readonly isError: boolean; readonly body: Json }> {
	const result = await client.callTool({ name, arguments: args });
	return {
		isError: result.isError === true,
		body: JSON.parse(resultContentText(result)) as Json,
	};
}

const READ_ARGS = {
	project_id: PROJECT,
	domain: FIXTURE_DOMAIN,
	hq_app_id: FIXTURE_REMOTE_APP_ID,
};

/** `read_hq_app`'s review, and the arguments that bring it in as offered. */
async function readReview(client: Client) {
	const { isError, body } = await call(client, "read_hq_app", READ_ARGS);
	expect(isError).toBe(false);
	if (body.state !== "review")
		throw new Error(`The fixture app read to ${JSON.stringify(body)}`);
	const review = body.review as Json & {
		runs_on: {
			runs_only_on: string | null;
			split_datetime: boolean;
			preselected: boolean;
		}[];
	};
	const preselected = review.runs_on.find((entry) => entry.preselected);
	if (preselected === undefined) throw new Error("none preselected");
	return {
		body,
		args: {
			...READ_ARGS,
			reading_id: body.reading_id as string,
			review_digest: review.review_digest as string,
			app_name: review.app_name as string,
			runs_only_on: preselected.runs_only_on,
			split_datetime: preselected.split_datetime,
			table_choices: {},
		},
	};
}

/** The Project's own `district`, made after or before a read as a test needs. */
async function seedProjectDistrict(): Promise<void> {
	await createLookupTable(
		{ projectId: PROJECT, actorId: ACTOR, role: "owner" },
		{
			name: "Districts",
			tag: "district",
			columns: [
				{ wireName: "code", label: "Code", dataType: "text" },
				{ wireName: "name", label: "Name", dataType: "text" },
			],
		},
	);
}

function servePng(peer: MockAgent, times: number): void {
	peer
		.get(FIXTURE_HOST)
		.intercept({ path: FIXTURE_PATHS.media("menuicon"), method: "GET" })
		.reply(200, PNG, { headers: { "content-type": "image/png" } })
		.times(times);
}

/** Every path the peer was asked for, in order. */
function requested(peer: MockAgent): readonly string[] {
	return (peer.getCallHistory()?.calls() ?? []).map((one) =>
		one.fullUrl.slice(FIXTURE_HOST.length),
	);
}

/** Answer the source read from the retained answer once `release` resolves. */
function serveSourceHeld(
	peer: MockAgent,
	reached: PromiseWithResolvers<void>,
	release: PromiseWithResolvers<void>,
): void {
	const source = fixtureSource();
	peer
		.get(FIXTURE_HOST)
		.intercept({ path: FIXTURE_PATHS.source, method: "GET" })
		.reply(async () => {
			reached.resolve();
			await release.promise;
			return {
				statusCode: source.status,
				data: retainedBodyText(source),
				responseOptions: { headers: { ...source.headers } },
			};
		});
}

describe("read_hq_app", () => {
	it("returns the actionable Releases repair for a physical installation key that is empty", async () => {
		await withHttpPeer(async (peer) => {
			const source = changedAnswer(fixtureSource(), (body) => ({
				...body,
				build_profiles: { "": { name: "Visits", langs: ["en"] } },
			}));
			serveAnswer(peer, FIXTURE_PATHS.application, fixtureResource(source));
			serveAnswer(peer, FIXTURE_PATHS.source, source);
			const result = await withTools((client) =>
				call(client, "read_hq_app", READ_ARGS),
			);
			expect(JSON.stringify(result.body)).toMatch(
				/Releases.*Application Profiles/,
			);
			expect(
				await h.db().selectFrom("apps").select("id").execute(),
			).toHaveLength(0);
		});
	});
	it("continues a mixed installation and table review through real tool calls and restarts a changed disclosure", async () => {
		const count = 360;
		const sourceAt = (label: string) =>
			changedAnswer(fixtureSource(), (body) => ({
				...body,
				build_profiles: Object.fromEntries(
					Array.from({ length: count }, (_, i) => [
						`team-${i}`,
						{
							name: `${i === 0 ? label : "Team"} ${i} ${"visits ".repeat(30)}`,
							langs: ["en"],
							practice_mobile_worker_id: "regional-practice",
						},
					]),
				),
			}));
		await withHttpPeer(async (peer) => {
			const original = sourceAt("Original"),
				changed = sourceAt("Changed");
			await withTools(async (client) => {
				const readPage = async (
					source: ReturnType<typeof sourceAt>,
					page?: string,
				) => {
					serveFixtureApp(peer, { source });
					const response = await call(client, "read_hq_app", {
						...READ_ARGS,
						...(page && { page }),
					});
					expect(response.isError).toBe(false);
					const review = response.body.review as {
						installations: { profile_id: string }[];
						tables: { tag: string }[];
						next_page: string | null;
						review_digest: string | null;
					};
					expect(review).toBeDefined();
					return {
						id: response.body.reading_id,
						review,
						restarted: response.body.restarted,
					};
				};
				const first = await readPage(original);
				const cursor = first.review.next_page;
				if (!cursor) throw new Error("Expected multiple pages");
				expect(first.review.review_digest).toBeNull();
				expect(first.review.tables.length).toBeGreaterThan(0);
				const ids = first.review.installations.map((p) => p.profile_id);
				let page: string | null = cursor;
				while (page) {
					const next = await readPage(original, page);
					expect(next.id).toBe(first.id);
					expect(next.restarted).toBe(false);
					ids.push(...next.review.installations.map((p) => p.profile_id));
					page = next.review.next_page;
					if (!page)
						expect(next.review.review_digest).toMatch(/^[a-f0-9]{64}$/);
				}
				expect(new Set(ids).size).toBe(count);
				expect(ids).toHaveLength(count);
				const malformed = changedAnswer(original, (body) => ({
					...body,
					build_profiles: { visits: { name: "Visits", langs: [] } },
				}));
				serveFixtureApp(peer, { source: malformed });
				const account = await call(client, "read_hq_app", {
					...READ_ARGS,
					page: cursor,
				});
				expect(account.body).toMatchObject({
					state: "account",
					restarted: true,
				});
				const moved = await readPage(changed, cursor);
				expect(moved.restarted).toBe(true);
				expect(moved.review.review_digest).toBeNull();
				expect(moved.review.installations[0]?.profile_id).toBe(
					first.review.installations[0]?.profile_id,
				);
			});
		});
	});

	it("answers a review with its reading_id in one call", async () => {
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer);
			await withTools(async (client) => {
				const { body } = await readReview(client);
				expect(body).toMatchObject({
					project_id: PROJECT,
					server: FIXTURE_SERVER,
					domain: FIXTURE_DOMAIN,
					hq_app_id: READ_ARGS.hq_app_id,
					state: "review",
					restarted: false,
					message: null,
				});
				expect(body.reading_id).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				);
			});
		});
	});

	it("sends a notification for each stage while CommCare HQ is still answering, and none to a call with no progress token", async () => {
		await withHttpPeer(async (peer) => {
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const resource = fixtureResource();
			serveAnswer(peer, FIXTURE_PATHS.application, resource);
			serveSourceHeld(peer, reached, release);
			serveAnswer(peer, FIXTURE_PATHS.version, counterOf(resource));
			serveFixtureTables(peer);
			await withTools(async (client) => {
				const messages: string[] = [];
				const firstNotice = Promise.withResolvers<void>();
				const pending = client.callTool(
					{ name: "read_hq_app", arguments: READ_ARGS },
					{
						onprogress: (update) => {
							messages.push(update.message ?? "");
							firstNotice.resolve();
						},
					},
				);
				try {
					await Promise.all([reached.promise, firstNotice.promise]);
					/* Progress reached the client while CommCare HQ held its answer. */
					expect(messages.length).toBeGreaterThan(0);
				} finally {
					release.resolve();
				}
				const result = await pending;
				expect(result.isError).not.toBe(true);
				expect(messages.map((message) => message.split("]")[0])).toEqual(
					observed.stages.map((stage) => `[hq_${stage.replaceAll("-", "_")}`),
				);
				expect(observed.stages.length).toBeGreaterThan(2);
			});
		});

		observed.stages.length = 0;
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer);
			await withTools(async (client) => {
				const notices: unknown[] = [];
				client.setNotificationHandler("notifications/progress", (notice) => {
					notices.push(notice);
				});
				const { isError } = await call(client, "read_hq_app", READ_ARGS);
				expect(isError).toBe(false);
				expect(observed.stages.length).toBeGreaterThan(2);
				expect(notices).toEqual([]);
			});
		});
	});

	it("stops reading CommCare HQ when the client cancels the call", async () => {
		await withHttpPeer(async (peer) => {
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			serveAnswer(peer, FIXTURE_PATHS.application, fixtureResource());
			serveSourceHeld(peer, reached, release);
			await withTools(async (client) => {
				const cancel = new AbortController();
				const pending = client.callTool(
					{ name: "read_hq_app", arguments: READ_ARGS },
					{ signal: cancel.signal },
				);
				try {
					await reached.promise;
					cancel.abort();
					await expect(pending).rejects.toThrow();
				} finally {
					release.resolve();
				}
				const [read] = observed.reads;
				if (read === undefined) throw new Error("the tool started no read");
				expect((await read).kind).toBe("stop");
				expect(requested(peer)).toEqual([
					FIXTURE_PATHS.application,
					FIXTURE_PATHS.source,
				]);
			});
		});
	});
});

describe("bring_in_hq_app", () => {
	it("requires a fresh installation adoption review if the exact HQ revision moved, even when the worker stayed", async () => {
		const source = changedAnswer(fixtureSource(), (body) => ({
			...body,
			build_profiles: {
				visits: {
					name: "Visits",
					langs: ["en"],
					practice_mobile_worker_id: "worker",
				},
			},
		}));
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, {
				source,
				resource: fixtureResource(source, { version: 3 }),
			});
			await withTools(async (client) => {
				const { args } = await readReview(client);
				serveFixtureApp(peer, {
					source,
					resource: fixtureResource(source, { version: 4 }),
				});
				const answer = await call(client, "bring_in_hq_app", args);
				expect(answer).toMatchObject({
					isError: false,
					body: { status: "changed" },
				});
				expect(
					await h.db().selectFrom("apps").select("id").execute(),
				).toHaveLength(0);
			});
		});
	});
	it.each([false, true])(
		"requires both grants for installation adoption and leaves plan evidence open (practice %s)",
		async (practice) => {
			const source = changedAnswer(fixtureSource(), (body) => ({
				...body,
				build_profiles: {
					visits: {
						name: "Visits",
						langs: ["en"],
						practice_mobile_worker_id: practice ? "training-user" : null,
					},
				},
			}));
			await withHttpPeer(async (peer) => {
				serveFixtureApp(peer, { source, times: 3 });
				const onlyImport = SCOPES.filter((s) => s !== "nova.hq.write");
				const { body, args } = await withTools(
					(client) => readReview(client),
					ACTOR,
					onlyImport,
				);
				expect((body.review as Json).installations).toEqual([
					{
						profile_id: "visits",
						name: "Visits",
						languages: ["eng"],
						practice_worker_id: practice ? "training-user" : null,
					},
				]);
				const choices = (body.review as Json).runs_on as Json[];
				for (const choice of choices) {
					expect(choice.confirm_before_first_upload).toEqual(
						practice
							? ["Build Profiles", "Practice mode for mobile workers"]
							: ["Build Profiles"],
					);
					expect(choice.recorded_features).not.toContain("Build Profiles");
					expect(choice.recorded_features).not.toContain(
						"Practice mode for mobile workers",
					);
				}
				const take = (scopes: string[]) =>
					withTools(
						(client) => call(client, "bring_in_hq_app", args),
						ACTOR,
						scopes,
					);
				for (const missing of ["nova.hq.import", "nova.hq.write"]) {
					expect(await take(SCOPES.filter((s) => s !== missing))).toMatchObject(
						{
							isError: true,
							body: { error_type: "scope_missing", required_scope: missing },
						},
					);
				}
				expect(
					await h.db().selectFrom("apps").select("id").execute(),
				).toHaveLength(0);
				expect(uploadAssetBytes).not.toHaveBeenCalled();
				expect(await take(SCOPES)).toMatchObject({
					isError: false,
					body: { status: "created" },
				});
				const confirmations = await h
					.db()
					.selectFrom("app_deployment_confirmations")
					.select("subject")
					.execute();
				expect(confirmations.map((row) => row.subject)).not.toContain(
					"installation-profiles",
				);
				expect(confirmations.map((row) => row.subject)).not.toContain(
					"practice-workers",
				);
				expect(await take(onlyImport)).toMatchObject({
					isError: false,
					body: { status: "created" },
				});
			});
		},
	);
	it("rechecks both installation grants at the birth after locking Project edit access", async () => {
		const source = changedAnswer(fixtureSource(), (body) => ({
			...body,
			build_profiles: { visits: { name: "Visits", langs: ["en"] } },
		}));
		const scopes = [...SCOPES];
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { source, times: 2 });
			const { args } = await withTools((client) => readReview(client));
			observed.beforeBirth = async () => {
				scopes.splice(scopes.indexOf("nova.hq.write"), 1);
			};
			expect(
				await withTools(
					(client) => call(client, "bring_in_hq_app", args),
					ACTOR,
					scopes,
				),
			).toMatchObject({
				isError: true,
				body: { error_type: "scope_missing", required_scope: "nova.hq.write" },
			});
			expect(
				await h.db().selectFrom("apps").select("id").execute(),
			).toHaveLength(0);
		});
	});

	it("answers created, and the same app again for the same arguments, at its builder address", async () => {
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 2 });
			await withTools(async (client) => {
				const { args } = await readReview(client);
				const first = await call(client, "bring_in_hq_app", args);
				expect(first.isError).toBe(false);
				const appId = first.body.app_id as string;
				expect(first.body).toEqual({
					status: "created",
					app_id: appId,
					project_id: PROJECT,
					app_name: args.app_name,
					url: `${AS_ORIGIN}/build/${appId}`,
					brought_in_from: {
						server: FIXTURE_SERVER,
						domain: FIXTURE_DOMAIN,
						hq_app_id: READ_ARGS.hq_app_id,
					},
					message: `${args.app_name} is in Nova. Nothing changed in CommCare HQ. Publishing from Nova updates the app it came from in ${FIXTURE_DOMAIN}.`,
				});
				const second = await call(client, "bring_in_hq_app", args);
				expect(second.body).toEqual(first.body);
			});
		});
	});

	it("answers changed with what stands now where the Project changed since the review", async () => {
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 2 });
			await withTools(async (client) => {
				const { args } = await readReview(client);
				await seedProjectDistrict();
				const { isError, body } = await call(client, "bring_in_hq_app", args);
				expect(isError).toBe(false);
				expect(body.status).toBe("changed");
				const reading = body.reading as Json;
				expect(reading).toMatchObject({
					project_id: PROJECT,
					restarted: false,
					message: null,
				});
				const state = reading.state as "review" | "account" | "stop";
				expect(body.message).toBe(CREATE_ANSWER_LEADS.changed[state]);
			});
		});
	});

	it("answers changed with the fresh reading where the app changed in CommCare HQ since the review", async () => {
		const relabelled = fixtureSourceWithXml((xml) =>
			xml.replaceAll(">Note<", ">Comment<"),
		);
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer);
			await withTools(async (client) => {
				const { args } = await readReview(client);
				serveFixtureApp(peer, {
					source: relabelled,
					resource: fixtureResource(relabelled, { noteLabel: "Comment" }),
				});
				const { isError, body } = await call(client, "bring_in_hq_app", args);
				expect(isError).toBe(false);
				expect(body.status).toBe("changed");
				expect(body.message).toBe(CREATE_ANSWER_LEADS.changed.review);
				const reading = body.reading as Json & { review: Json };
				expect(reading).toMatchObject({
					state: "review",
					reading_id: args.reading_id,
					restarted: false,
				});
				/* The fresh review is of the changed app: bringing it in needs its own digest. */
				expect(reading.review.review_digest).not.toBe(args.review_digest);
			});
		});
		expect(await h.db().selectFrom("apps").select("id").execute()).toEqual([]);
	});

	it("answers check_failed with the one finding where Nova's own check refuses the birth", async () => {
		observed.beforeBirth = async () => {
			throw new GenesisGateRejectedError("The gate refused the birth.", {
				check: "gate",
				findingCodes: ["form-has-no-questions"],
			});
		};
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 2 });
			await withTools(async (client) => {
				const { args } = await readReview(client);
				const { isError, body } = await call(client, "bring_in_hq_app", args);
				expect(isError).toBe(false);
				expect(body.status).toBe("check_failed");
				expect(body.message).toBe(CREATE_ANSWER_LEADS["check-failed"]);
				const reading = body.reading as Json & {
					account: { findings: Json[]; total: number };
				};
				expect(reading.state).toBe("account");
				expect(reading.account.total).toBe(1);
				expect(reading.account.findings).toEqual([
					expect.objectContaining({ code: "read-back-differs" }),
				]);
			});
		});
		expect(await h.db().selectFrom("apps").select("id").execute()).toEqual([]);
	});

	it("answers read_again where a table the app reads was made in the Project under the birth, and the next read asks its choice", async () => {
		observed.beforeBirth = seedProjectDistrict;
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 3 });
			await withTools(async (client) => {
				const { args } = await readReview(client);
				const { isError, body } = await call(client, "bring_in_hq_app", args);
				expect(isError).toBe(false);
				/* Over MCP nothing reads on its own: the sentence says what stands. */
				expect(body).toEqual({
					status: "read_again",
					message: BRING_IN_TOOL_LEADS.readAgain,
				});
				expect(body.message).not.toBe(CREATE_ANSWER_LEADS["read-again"]);
				observed.beforeBirth = null;
				const again = await readReview(client);
				expect((again.body.review as { tables: Json[] }).tables).toEqual([
					expect.objectContaining({ tag: "district", standing: "choice" }),
				]);
			});
		});
		expect(await h.db().selectFrom("apps").select("id").execute()).toEqual([]);
	});

	it("answers held with the stop where CommCare HQ is away on the create's read, and the same arguments create once it answers", async () => {
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer);
			await withTools(async (client) => {
				const { args } = await readReview(client);
				const resource = fixtureResource();
				serveAnswer(peer, FIXTURE_PATHS.application, resource);
				serveAnswer(peer, FIXTURE_PATHS.source, fixtureSource());
				serveAnswer(peer, FIXTURE_PATHS.version, { status: 503, headers: {} });
				const held = await call(client, "bring_in_hq_app", args);
				expect(held.isError).toBe(false);
				expect(held.body).toEqual({
					status: "held",
					message: BRING_IN_TOOL_LEADS.held,
					stop: {
						code: "hq-unavailable",
						title: expect.any(String),
						body: expect.any(String),
						next: expect.any(String),
					},
				});
				expect(await h.db().selectFrom("apps").select("id").execute()).toEqual(
					[],
				);
				/* The answers still apply: the same call creates once HQ answers. */
				serveFixtureApp(peer);
				const created = await call(client, "bring_in_hq_app", args);
				expect(created.body.status).toBe("created");
			});
		});
	});
});

describe("each refusal a call can make arrives with its tag and refusal", () => {
	it("no_project_access, at read_hq_app, asking CommCare HQ nothing", async () => {
		await seedFixtureConnection(STRANGER);
		await withHttpPeer(async (peer) => {
			await withTools(async (client) => {
				const { isError, body } = await call(client, "read_hq_app", READ_ARGS);
				expect(isError).toBe(true);
				expect(body).toEqual({
					error_type: "permission_denied",
					message: READING_REFUSAL_COPY.no_project_access,
					project_id: PROJECT,
					refusal: "no_project_access",
				});
			}, STRANGER);
			expect(requested(peer)).toEqual([]);
		});
	});

	it.each([
		["read_hq_app", READ_ARGS],
		[
			"bring_in_hq_app",
			{
				...READ_ARGS,
				reading_id: "01936a52-7c00-7000-8000-000000000001",
				review_digest: "f".repeat(64),
				app_name: "Visits",
				runs_only_on: null,
				split_datetime: false,
				table_choices: {},
			},
		],
	] as const)(
		"no_project_access, at %s, for a member who may only view the Project, asking CommCare HQ nothing",
		async (tool, args) => {
			await h.seedProjectMember(VIEWER, PROJECT, "viewer");
			await seedFixtureConnection(VIEWER);
			await withHttpPeer(async (peer) => {
				await withTools(async (client) => {
					const { isError, body } = await call(client, tool, args);
					expect(isError).toBe(true);
					expect(body).toEqual({
						error_type: "permission_denied",
						message: READING_REFUSAL_COPY.no_project_access,
						project_id: PROJECT,
						refusal: "no_project_access",
					});
				}, VIEWER);
				expect(requested(peer)).toEqual([]);
			});
			expect(await h.db().selectFrom("apps").select("id").execute()).toEqual(
				[],
			);
		},
	);

	it("invalid_input, for a project space that is no slug, naming the spaces the key reaches at both tools", async () => {
		const notASpace = `“My Clinic” isn't the name of a CommCare HQ project space. Your stored CommCare HQ API key reaches: ${FIXTURE_DOMAIN}. You can pass one of those as \`domain\`: the \`name\` of one of get_hq_connection's \`available_domains\`, not its display name.`;
		await withHttpPeer(async (peer) => {
			await withTools(async (client) => {
				const read = await call(client, "read_hq_app", {
					...READ_ARGS,
					domain: "My Clinic",
				});
				const create = await call(client, "bring_in_hq_app", {
					...READ_ARGS,
					domain: "My Clinic",
					reading_id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
					review_digest: "a".repeat(64),
					app_name: "Clinic visits",
					runs_only_on: null,
					split_datetime: false,
					table_choices: {},
				});
				for (const answer of [read, create])
					expect(answer).toEqual({
						isError: true,
						body: { error_type: "invalid_input", message: notASpace },
					});
			});
			expect(requested(peer)).toEqual([]);
		});
	});

	it("choice_missing and choice_not_offered, at bring_in_hq_app", async () => {
		await seedProjectDistrict();
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 3 });
			await withTools(async (client) => {
				const { body, args } = await readReview(client);
				const tables = (body.review as { tables: Json[] }).tables;
				expect(tables).toEqual([
					expect.objectContaining({ tag: "district", standing: "choice" }),
				]);
				const missing = await call(client, "bring_in_hq_app", args);
				expect(missing).toEqual({
					isError: true,
					body: {
						error_type: "invalid_input",
						message: READING_REFUSAL_COPY.choice_missing,
						refusal: "choice_missing",
					},
				});
				const notOffered = await call(client, "bring_in_hq_app", {
					...args,
					split_datetime: !args.split_datetime,
					table_choices: { district: "use-project" },
				});
				expect(notOffered.body).toMatchObject({
					error_type: "invalid_input",
					refusal: "choice_not_offered",
				});
			});
		});
	});

	it("project_changed, where a published file left the Project before the birth", async () => {
		observed.beforeBirth = async () => {
			await h.db().deleteFrom("media_assets").execute();
		};
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, {
				source: withIcons(fixtureSource(), ["menuicon"]),
				times: 2,
			});
			servePng(peer, 2);
			await withTools(async (client) => {
				const { args } = await readReview(client);
				const { isError, body } = await call(client, "bring_in_hq_app", args);
				expect(isError).toBe(true);
				expect(body).toEqual({
					error_type: "bring_in_refused",
					message: READING_REFUSAL_COPY.project_changed,
					refusal: "project_changed",
				});
			});
		});
	});

	it("app_unavailable, for the same arguments once the app is in recently deleted", async () => {
		/* Deleting an app is an owner's. */
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 2 });
			await withTools(async (client) => {
				const { args } = await readReview(client);
				const created = await call(client, "bring_in_hq_app", args);
				await softDeleteApp(created.body.app_id as string, ACTOR);
				const { isError, body } = await call(client, "bring_in_hq_app", args);
				expect(isError).toBe(true);
				expect(body).toEqual({
					error_type: "bring_in_refused",
					message: READING_REFUSAL_COPY.app_unavailable,
					refusal: "app_unavailable",
				});
			});
		});
	});
});

describe("list_hq_apps", () => {
	const block = (
		code: "plan-lacks-api-access" | "not-a-member" | "key-cannot-reach-space",
	) =>
		circumstanceBlock(circumstanceFinding(code, { kind: "app" }, {}), {
			server: COMMCARE_SERVERS[FIXTURE_SERVER].label,
			space: code === "key-cannot-reach-space" ? "training" : FIXTURE_DOMAIN,
			app: null,
			formatDate: (iso) => iso.slice(0, 10),
		});

	it("lists the project space's apps, each free to bring in", async () => {
		await withHttpPeer(async (peer) => {
			serveAnswer(peer, LIST, retainedReadingRead("list-apps"));
			serveAnswer(peer, PROBE, retainedReadingRead("api-access"));
			await withTools(async (client) => {
				const { isError, body } = await call(client, "list_hq_apps", {
					domain: FIXTURE_DOMAIN,
				});
				expect(isError).toBe(false);
				const listed = retainedBodyJson(retainedReadingRead("list-apps"))
					.applications as { app_id: string; name: string }[];
				expect(body).toEqual({
					server: FIXTURE_SERVER,
					server_url: COMMCARE_SERVERS[FIXTURE_SERVER].baseUrl,
					domain: FIXTURE_DOMAIN,
					apps: listed.map((row) => ({
						hq_app_id: row.app_id,
						name: row.name,
						in_nova: null,
					})),
				});
			});
		});
	});

	it("answers a stop as hq_read_stopped with the circumstance's code, title and next step", async () => {
		await withHttpPeer(async (peer) => {
			serveAnswer(peer, LIST, retainedReadingRead("list-apps"));
			serveAnswer(peer, PROBE, retainedReadingRead("api-access-no-plan"));
			await withTools(async (client) => {
				const { isError, body } = await call(client, "list_hq_apps", {
					domain: FIXTURE_DOMAIN,
				});
				expect(isError).toBe(true);
				const expected = block("plan-lacks-api-access");
				expect(body).toEqual({
					error_type: "hq_read_stopped",
					message: expected.body,
					circumstance: "plan-lacks-api-access",
					title: expected.title,
					next: expected.next,
				});
			});
		});
	});

	it("answers a key that does not list the project space and an account HQ turned away both as domain_not_authorized, each in its own words", async () => {
		const unreachable = await withHttpPeer(async (peer) => {
			const answer = await withTools((client) =>
				call(client, "list_hq_apps", { domain: "training" }),
			);
			expect(requested(peer)).toEqual([]);
			return answer;
		});
		const turnedAway = await withHttpPeer(async (peer) => {
			serveAnswer(peer, LIST, retainedReadingRead("api-access-no-permission"));
			return withTools((client) =>
				call(client, "list_hq_apps", { domain: FIXTURE_DOMAIN }),
			);
		});
		const reach = block("key-cannot-reach-space");
		expect(unreachable).toEqual({
			isError: true,
			body: {
				error_type: "domain_not_authorized",
				message: `Your stored CommCare HQ API key can't reach the “training” project space. It reaches: ${FIXTURE_DOMAIN}. Pass one of those as \`domain\`, or update your key in Settings.`,
				circumstance: "key-cannot-reach-space",
				title: reach.title,
				next: reach.next,
			},
		});
		const member = block("not-a-member");
		expect(turnedAway).toEqual({
			isError: true,
			body: {
				error_type: "domain_not_authorized",
				message: member.body,
				circumstance: "not-a-member",
				title: member.title,
				next: member.next,
			},
		});
		expect(unreachable.body.message).not.toBe(turnedAway.body.message);
	});
});
