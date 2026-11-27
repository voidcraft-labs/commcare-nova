/**
 * `read_hq_changes` and `bring_in_hq_changes` through the real SDK client
 * and server, over real Postgres, with an app brought in through the
 * production create and CommCare HQ answering from its own retained reads at
 * a controlled peer, the stored key's decryption controlled at the KMS
 * boundary. The review and the bring-in are observed (never replaced) where
 * a test reads the stages they named or waits for a cancelled read to end.
 *
 * It would catch: a bring-in a client sent without the person's yes to the
 * list of their own changes it removes, or with a yes to a list that is
 * empty; a list a client can't read whole; a bring-in that acts on a review
 * CommCare HQ has since left; a client that sees no progress while CommCare
 * HQ is slow; a cancelled read that keeps reading CommCare HQ; a deployment
 * whose revision a client compares with the app's head and reads a brought-in
 * change as one waiting to be published.
 */

import type { Client } from "@modelcontextprotocol/client";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HqSaveCounter, withHqPeer } from "@/__tests__/helpers/hqSaveCounter";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	retainedBodyText,
} from "@/__tests__/helpers/retainedHqReads";
import { decrypt } from "@/lib/commcare/encryption";
import { applyBlueprintChangeProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { HqChangesReview } from "@/lib/deployment/hqChanges";
import {
	adoptFixtureApp,
	changedAnswer,
	counterOf,
	FIXTURE_DOMAIN,
	FIXTURE_HOST,
	FIXTURE_PATHS,
	FIXTURE_SERVER,
	fixtureResource,
	fixtureSource,
	fixtureSourceWithXml,
	seedFixtureConnection,
	serveAnswer,
	serveFixtureTables,
} from "@/lib/deployment/reading/__tests__/adoptionFixture";
import { readDeploymentNovaRevisions } from "@/lib/deployment/store";
import { log } from "@/lib/logger";
import { driftDate } from "@/lib/publish/driftReference";
import {
	broughtInLine,
	hqChangesLead,
	hqChangesMovedLine,
	hqChangesUnavailableLine,
	NEXT_PUBLISH_LEAD,
	nothingToBringInLine,
	sincePhrase,
} from "@/lib/publish/hqChangesCopy";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import {
	DISCARD_NOT_AGREED,
	NOTHING_TO_DISCARD,
	RECORDED_LINE,
	registerBringInHqChanges,
} from "../tools/bringInHqChanges";
import { registerGetDeployment } from "../tools/deploymentTools";
import {
	RECORD_NOTHING_NEXT,
	registerReadHqChanges,
} from "../tools/readHqChanges";
import { registerUploadAppToHq } from "../tools/uploadAppToHq";
import { withMcpClient } from "./client";
import { resultContentText } from "./resultText";

const observed = vi.hoisted(() => ({
	/** Each review the read tool started, to wait on once its call is cancelled. */
	reviews: [] as Promise<unknown>[],
	/** Each stage the reviews and bring-ins named, in order. */
	stages: [] as string[],
	/** The options each review and bring-in was handed, with their own sink. */
	reviewOptions: [] as Record<string, unknown>[],
	bringInOptions: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/deployment/hqChanges", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/deployment/hqChanges")>();
	const watched = <E extends { readonly type: string; stage?: string }>(
		onEvent: (event: E) => void,
	) => {
		return (event: E) => {
			if (event.type === "stage" && event.stage !== undefined)
				observed.stages.push(event.stage);
			onEvent(event);
		};
	};
	return {
		...actual,
		reviewHqChanges: (
			...[scope, target, options]: Parameters<typeof actual.reviewHqChanges>
		) => {
			observed.reviewOptions.push({ ...options });
			const review = actual.reviewHqChanges(scope, target, {
				...options,
				onEvent: watched(options.onEvent),
			});
			observed.reviews.push(review);
			return review;
		},
		bringInHqChanges: (
			...[scope, target, input, options]: Parameters<
				typeof actual.bringInHqChanges
			>
		) => {
			observed.bringInOptions.push({ ...options });
			return actual.bringInHqChanges(scope, target, input, {
				...options,
				onEvent: watched(options.onEvent),
			});
		},
	};
});
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
/* Passed through, so a test can make the read after a landed write fault. */
vi.mock("@/lib/deployment/store", async (importOriginal) => {
	const store = await importOriginal<typeof import("@/lib/deployment/store")>();
	return {
		...store,
		readDeploymentNovaRevisions: vi.fn(store.readDeploymentNovaRevisions),
	};
});

const h = setupAppStateTestDb("mcp_hq_changes_", {
	authSchema: "migrated",
	poolMax: 4,
});

const PROJECT = "hq-changes-project";
const MEMBER = "hq-changes-member";
const VIEWER = "hq-changes-viewer";
/* Every scope these tools need: reading and bringing in from CommCare HQ is `nova.hq.import`. */
const SCOPES = [
	"nova.read",
	"nova.write",
	"nova.hq.read",
	"nova.hq.write",
	"nova.hq.import",
];
const RENAMED = "Survey, renamed in CommCare HQ";
const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
	observed.reviews.length = 0;
	observed.stages.length = 0;
	observed.reviewOptions.length = 0;
	observed.bringInOptions.length = 0;
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});

type Json = Record<string, unknown>;

/** The fixture app brought in by the member, who owns the Project. */
async function broughtIn(): Promise<string> {
	await h.seedProjectMember(MEMBER, PROJECT, "owner");
	const { appId } = await adoptFixtureApp({
		projectId: PROJECT,
		actorUserId: MEMBER,
	});
	return appId;
}

/** The two tools and `get_deployment`, called as `userId`. */
function withTools<T>(
	run: (client: Client) => Promise<T>,
	userId = MEMBER,
): Promise<T> {
	return withMcpClient((server) => {
		const ctx = { userId, scopes: SCOPES, authKind: "api-key" as const };
		registerReadHqChanges(server, ctx);
		registerBringInHqChanges(server, ctx);
		registerGetDeployment(server, ctx);
		registerUploadAppToHq(server, ctx);
	}, run);
}

async function call(
	client: Client,
	name: string,
	args: Json,
): Promise<{ readonly isError: boolean; readonly body: Json }> {
	const result = await client.callTool({ name, arguments: args });
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(80_000);
	return {
		isError: result.isError === true,
		body: JSON.parse(resultContentText(result)) as Json,
	};
}

/** CommCare HQ's source with the app renamed there. */
function renamed(name = RENAMED): RetainedHqAnswer {
	return changedAnswer(fixtureSource(), (body) => ({ ...body, name }));
}

/** One read of the app as a review makes it, and the table reads where the source changed. */
function serveRead(
	peer: MockAgent,
	source: RetainedHqAnswer,
	options: { readonly tables: boolean; readonly times?: number },
): void {
	const times = options.times ?? 1;
	const resource = fixtureResource(source);
	serveAnswer(peer, FIXTURE_PATHS.application, resource, times);
	serveAnswer(peer, FIXTURE_PATHS.source, source, times);
	serveAnswer(peer, FIXTURE_PATHS.version, counterOf(resource), times);
	if (options.tables) serveFixtureTables(peer, times);
}

/** Every path the peer was asked for, in order. */
function requested(peer: MockAgent): readonly string[] {
	return (peer.getCallHistory()?.calls() ?? []).map((one) =>
		one.fullUrl.slice(FIXTURE_HOST.length),
	);
}

async function head(appId: string) {
	const row = await h
		.db()
		.selectFrom("apps")
		.select(["mutation_seq", "app_name"])
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	return { seq: Number(row.mutation_seq), name: row.app_name };
}

async function hqChangeRows(appId: string) {
	return h
		.db()
		.selectFrom("app_changes")
		.select("seq")
		.where("app_id", "=", appId)
		.where("kind", "=", "hq-changes")
		.execute();
}

/** A member's edit of the app's name, committed as an autosave is. */
function editName(appId: string, name: string) {
	return applyBlueprintChangeProposal({
		appId,
		userId: MEMBER,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: { mutations: [{ kind: "setAppName", name }] },
	});
}

/** `read_hq_changes`' answer, which must be the review of kind `changes`. */
async function readChanges(client: Client, appId: string) {
	const { isError, body } = await call(client, "read_hq_changes", {
		app_id: appId,
	});
	expect(isError).toBe(false);
	if (body.kind !== "changes")
		throw new Error(`The review answered ${JSON.stringify(body)}`);
	return body as Json & {
		readonly since: { readonly kind: string; readonly at?: string };
		readonly reading_id: string;
		readonly review_digest: string;
		readonly nova_changes: readonly string[];
	};
}

describe("read_hq_changes and bring_in_hq_changes", () => {
	it("lists every line of what changed, brings it in, and a second read finds nothing", async () => {
		const appId = await broughtIn();
		const before = await head(appId);
		await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true, times: 2 });
			serveRead(peer, renamed(), { tables: false });
			await withTools(async (client) => {
				/* `domain` left out: the member's key reaches one project space. */
				const listed = await readChanges(client, appId);
				expect(listed).toEqual({
					app_id: appId,
					server: FIXTURE_SERVER,
					domain: FIXTURE_DOMAIN,
					kind: "changes",
					since: { kind: "brought-in", at: expect.any(String) },
					message: hqChangesLead(
						sincePhrase(
							listed.since as { kind: "brought-in"; at: string },
							FIXTURE_DOMAIN,
						),
						false,
					),
					hq_changes: ["The app's name"],
					nova_changes: [],
					hq_changes_total: 1,
					nova_changes_total: 0,
					renamed_in_nova_total: 0,
					tables_total: 0,
					made_by_total: 0,
					next_page: null,
					cut_line: null,
					restarted: false,
					restarted_message: null,
					made_by: [],
					made_by_line: null,
					case_data: [],
					publish_changes: listed.publish_changes,
					publish_changes_lead:
						(listed.publish_changes as readonly string[]).length > 0
							? NEXT_PUBLISH_LEAD
							: null,
					observed_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
					renamed_in_nova: [],
					renamed_in_nova_line: null,
					tables: [],
					reading_id: expect.stringMatching(UUID_V7),
					review_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
				});

				const brought = await call(client, "bring_in_hq_changes", {
					app_id: appId,
					domain: FIXTURE_DOMAIN,
					reading_id: listed.reading_id,
					review_digest: listed.review_digest,
					discard_nova_changes: false,
					table_choices: {},
				});
				expect(brought.isError).toBe(false);
				expect(brought.body).toMatchObject({
					kind: "brought-in",
					seq: before.seq + 1,
					discarded: false,
					message: broughtInLine(false),
					deployment: {
						server: FIXTURE_SERVER,
						domain: FIXTURE_DOMAIN,
						nova_revision: before.seq + 1,
						setup_artifact: expect.any(Object),
					},
				});
				const landed = brought.body.deployment as Json;
				expect(Object.hasOwn(landed, "first_publish")).toBe(true);
				expect(await head(appId)).toEqual({
					seq: before.seq + 1,
					name: RENAMED,
				});

				/* What CommCare HQ's copy matches now is the bring-in's revision,
				 * which no push made. */
				const report = await call(client, "get_deployment", { app_id: appId });
				const [deployment] = report.body.deployments as Json[];
				expect(deployment).toMatchObject({ nova_revision: before.seq + 1 });
				expect(deployment?.pushed_revision).not.toBe(before.seq + 1);

				const again = await call(client, "read_hq_changes", { app_id: appId });
				expect(again.body).toEqual({
					app_id: appId,
					server: FIXTURE_SERVER,
					domain: FIXTURE_DOMAIN,
					kind: "nothing",
					reason: "unchanged",
					since: { kind: "changes-brought-in" },
					message: nothingToBringInLine(
						"unchanged",
						sincePhrase({ kind: "changes-brought-in" }, FIXTURE_DOMAIN),
					),
					hq_changes: [],
					publish_changes: [],
					publish_changes_lead: null,
					reading_id: null,
					review_digest: null,
					next: null,
				});
			});
		});
	});

	/* A save that reads as the same app holds a digest, and until it is sent
	 * the next upload still stops: the client must be told what it is for.
	 * The revision read after the record faults here, so the answer to a
	 * record that committed is seen to stay `recorded`. */
	it("tells the client to send a save that reads as the same app, records it changing nothing, and answers recorded where a read after it faults", async () => {
		const appId = await broughtIn();
		const before = await head(appId);
		const saved = fixtureSourceWithXml((xml) =>
			xml.split("</h:head>").join("</h:head>\n  "),
		);
		await withHttpPeer(async (peer) => {
			serveRead(peer, saved, { tables: true, times: 2 });
			serveRead(peer, saved, { tables: false });
			await withTools(async (client) => {
				const listed = await call(client, "read_hq_changes", { app_id: appId });
				expect(listed.body).toMatchObject({
					kind: "nothing",
					reason: "reads-the-same",
					reading_id: expect.stringMatching(UUID_V7),
					review_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
					next: RECORD_NOTHING_NEXT,
				});

				const words = "Survey";
				vi.mocked(readDeploymentNovaRevisions).mockRejectedValueOnce(
					Object.assign(new Error(`could not read “${words}”`), {
						code: "57P01",
					}),
				);
				const recorded = await call(client, "bring_in_hq_changes", {
					app_id: appId,
					reading_id: listed.body.reading_id,
					review_digest: listed.body.review_digest,
					discard_nova_changes: false,
					table_choices: {},
				});
				expect(recorded.isError).toBe(false);
				expect(recorded.body).toMatchObject({
					kind: "recorded",
					message: RECORDED_LINE,
					deployment: { domain: FIXTURE_DOMAIN },
				});
				expect(recorded.body.deployment).not.toHaveProperty("nova_revision");
				expect(log.error).toHaveBeenCalledWith(
					"[deployment] matched revisions unavailable after a write landed",
					undefined,
					{
						appId,
						domain: FIXTURE_DOMAIN,
						after: "bring-in",
						errorName: "Error",
						errorCode: "57P01",
					},
				);
				expect(await head(appId)).toEqual(before);

				/* What CommCare HQ holds is the baseline now, so the next
				 * comparison finds nothing changed. */
				const again = await call(client, "read_hq_changes", { app_id: appId });
				expect(again.body).toMatchObject({
					kind: "nothing",
					reason: "unchanged",
					next: null,
				});
			});
		});
		expect(await hqChangeRows(appId)).toEqual([]);
	});

	it("refuses discard_nova_changes true where Nova's list is empty, and takes nothing", async () => {
		const appId = await broughtIn();
		const before = await head(appId);
		await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true, times: 2 });
			await withTools(async (client) => {
				const listed = await readChanges(client, appId);
				expect(listed.nova_changes).toEqual([]);
				expect(
					await call(client, "bring_in_hq_changes", {
						app_id: appId,
						reading_id: listed.reading_id,
						review_digest: listed.review_digest,
						discard_nova_changes: true,
						table_choices: {},
					}),
				).toEqual({
					isError: true,
					body: {
						error_type: "invalid_input",
						message: NOTHING_TO_DISCARD,
						app_id: appId,
					},
				});
			});
		});
		expect(await head(appId)).toEqual(before);
		expect(await hqChangeRows(appId)).toEqual([]);
	});

	it("refuses discard_nova_changes false where Nova's list holds changes, and takes them once it is true", async () => {
		const appId = await broughtIn();
		await editName(appId, "Survey, renamed in Nova");
		const edited = await head(appId);
		await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true, times: 3 });
			await withTools(async (client) => {
				const listed = await readChanges(client, appId);
				expect(listed.nova_changes).toEqual(["The app's name"]);
				const args = {
					app_id: appId,
					reading_id: listed.reading_id,
					review_digest: listed.review_digest,
					table_choices: {},
				};
				expect(
					await call(client, "bring_in_hq_changes", {
						...args,
						discard_nova_changes: false,
					}),
				).toEqual({
					isError: true,
					body: {
						error_type: "invalid_input",
						message: DISCARD_NOT_AGREED,
						app_id: appId,
					},
				});
				expect(await head(appId)).toEqual(edited);
				expect(await hqChangeRows(appId)).toEqual([]);

				// A long publication history grows independently of the app's size.
				const target = await h
					.db()
					.selectFrom("app_deployments")
					.select("id")
					.where("app_id", "=", appId)
					.executeTakeFirstOrThrow();
				await h
					.db()
					.insertInto("app_deployment_resources")
					.values(
						Array.from({ length: 1000 }, (_, index) => ({
							deployment_id: target.id,
							kind: "location",
							ownership: "nova-created",
							nova_resource_id: crypto.randomUUID(),
							remote_id: crypto.randomUUID(),
							pushed_identity: `retired-location-${index}`,
							superseded_at: new Date(),
						})),
					)
					.execute();

				const taken = await call(client, "bring_in_hq_changes", {
					...args,
					discard_nova_changes: true,
				});
				expect(taken.body).toMatchObject({
					kind: "brought-in",
					seq: edited.seq + 1,
					discarded: true,
					message: broughtInLine(true),
					deployment: null,
					next: expect.stringContaining("Publishing"),
				});
			});
		});
		expect(await head(appId)).toEqual({ seq: edited.seq + 1, name: RENAMED });
	});

	it("returns mixed rename recovery through the registered stale apply and read tools", async () => {
		const appId = await broughtIn();
		const moves = Array.from({ length: 355 }, (_, i) => ({
			caseType: "a".repeat(90),
			from: `p${i}`,
			to: `q${i}`,
		}));
		moves.push({ caseType: "b", from: "last", to: "newlast" });
		moves.push({ caseType: "b", from: '"'.repeat(28000), to: "newlast" });
		const review: Extract<HqChangesReview, { kind: "changes" }> = {
			kind: "changes",
			since: { kind: "published" },
			readingId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
			reviewDigest: "a".repeat(64),
			observedDigest: "b".repeat(64),
			requiresReview: true,
			hqChanges: [],
			novaChanges: [],
			caseData: [],
			publishChanges: [],
			madeBy: [],
			renamedInNova: moves,
			tables: [],
			projectName: "Field team",
		};
		// This adapter control starts with an exact review and stale write result.
		// The adjacent physical-file test obtains both from the real HQ reader.
		const service = await import("@/lib/deployment/hqChanges");
		const read = vi.spyOn(service, "reviewHqChanges").mockResolvedValue(review);
		const apply = vi
			.spyOn(service, "bringInHqChanges")
			.mockResolvedValue({ kind: "changed", now: review, editedBy: null });
		try {
			await withTools(async (client) => {
				const nested = await call(client, "bring_in_hq_changes", {
					app_id: appId,
					reading_id: review.readingId,
					review_digest: "e".repeat(64),
					discard_nova_changes: false,
					table_choices: {},
				});
				expect(nested.body).toMatchObject({
					kind: "changed",
					now: { kind: "changes", review_digest: null },
				});
				type Page = {
					renamed_in_nova: { case_type: string; from: string; to: string }[];
					rename_parts?: {
						item: number;
						part: number;
						parts: number;
						text: string;
					}[];
					renamed_in_nova_line: string;
					review_digest: string | null;
					observed_digest: string | null;
					next_page: string | null;
				};
				let page = nested.body.now as Page;
				const rows: Page["renamed_in_nova"] = [];
				let parts: string[] = [];
				for (;;) {
					expect(page.renamed_in_nova_line).toContain("wrong case values");
					rows.push(...page.renamed_in_nova);
					for (const part of page.rename_parts ?? []) {
						expect(part.part).toBe(parts.length + 1);
						parts.push(part.text);
						if (part.part === part.parts) {
							rows.push(JSON.parse(parts.join("")));
							parts = [];
						}
					}
					expect(page.observed_digest).toBeNull();
					if (!page.next_page) break;
					expect(page.review_digest).toBeNull();
					const result = await call(client, "read_hq_changes", {
						app_id: appId,
						page: page.next_page,
					});
					expect(result.isError).toBe(false);
					page = result.body as Page;
				}
				expect(parts).toHaveLength(0);
				expect(page.review_digest).toBe(review.reviewDigest);
				expect(rows).toEqual(
					moves.map(({ caseType, from, to }) => ({
						case_type: caseType,
						from,
						to,
					})),
				);
			});
		} finally {
			apply.mockRestore();
			read.mockRestore();
		}
	});

	it("shows all 600 quoted file removals through the changed apply receipt and the later-read SDK before accepting a decision", async () => {
		const appId = await broughtIn();
		const before = await head(appId);
		const files = Array.from(
			{ length: 600 },
			(_, i) =>
				[`jr://file/visits/${'"'.repeat(145)}${i}.png`, `remote${i}`] as const,
		);
		const source = changedAnswer(renamed(), (body) => ({
			...body,
			multimedia_map: {
				...(body.multimedia_map as object),
				...Object.fromEntries(
					files.map(([path, id]) => [
						path,
						{ media_type: "CommCareImage", multimedia_id: id },
					]),
				),
			},
		}));
		await withHttpPeer(async (peer) =>
			withTools(async (client) => {
				serveRead(peer, renamed(), { tables: true });
				const earlier = await readChanges(client, appId);
				const args = {
					app_id: appId,
					reading_id: earlier.reading_id,
					review_digest: earlier.review_digest,
					discard_nova_changes: false,
					table_choices: {},
				};
				type Changes = {
					kind: string;
					hq_changes: string[];
					reading_id: string;
					review_digest: string | null;
					observed_digest: string | null;
					requires_review?: true;
					next_page: string | null;
				};
				serveRead(peer, source, { tables: true });
				const nested = await call(client, "bring_in_hq_changes", args);
				expect(nested.isError).toBe(false);
				expect(nested.body).toMatchObject({
					kind: "changed",
					next: expect.any(String),
					now: { kind: "changes", review_digest: null, observed_digest: null },
				});
				let review = nested.body.now as Changes;
				if (!review.next_page)
					throw new Error("The first page did not name its continuation.");
				serveRead(peer, source, { tables: true });
				const attempt = await call(client, "bring_in_hq_changes", {
					...args,
					review_digest: review.next_page.split(":")[1],
				});
				expect(attempt.body).toMatchObject({
					kind: "changed",
					now: { review_digest: null, observed_digest: null },
				});
				await sql`UPDATE auth_organization SET name = ${"New field team"} WHERE id = ${PROJECT}`.execute(
					h.db(),
				);
				serveRead(peer, source, { tables: true });
				const restart = await call(client, "read_hq_changes", {
					app_id: appId,
					page: review.next_page,
				});
				expect(restart.body).toMatchObject({
					kind: "changes",
					restarted: true,
					review_digest: null,
					observed_digest: null,
				});
				expect((restart.body.hq_changes as string[])[0]).toBe(
					review.hq_changes[0],
				);
				review = restart.body as Changes;
				const lines: string[] = [];
				const seen = new Set<string>();
				for (;;) {
					lines.push(...review.hq_changes);
					// Taking and overwriting remove the very same 600 references. Both
					// decisions become available once every reference has been disclosed.
					expect(review.requires_review).toBeUndefined();
					if (!review.next_page) break;
					expect(review.observed_digest).toBeNull();
					expect(review.review_digest).toBeNull();
					expect(seen.has(review.next_page)).toBe(false);
					seen.add(review.next_page);
					serveRead(peer, source, { tables: true });
					const reply = await call(client, "read_hq_changes", {
						app_id: appId,
						page: review.next_page,
					});
					expect(reply.isError).toBe(false);
					expect(reply.body).toMatchObject({
						kind: "changes",
						restarted: false,
					});
					review = reply.body as Changes;
				}
				expect(review.review_digest).toMatch(/^[0-9a-f]{64}$/);
				expect(review.observed_digest).toMatch(/^[0-9a-f]{64}$/);
				expect(seen.size).toBeGreaterThan(1);
				const offered = lines.filter((line) =>
					line.includes(
						"from the app in CommCare HQ. This app doesn't use it.",
					),
				);
				expect(offered).toHaveLength(files.length);
				for (const [path] of files)
					expect(
						offered.filter((line) =>
							line.includes(`“${path.slice("jr://file/".length)}”`),
						),
					).toHaveLength(1);
			}),
		);
		expect(await head(appId)).toEqual(before);
		expect(await hqChangeRows(appId)).toEqual([]);
	}, 60_000);

	it("answers changed with the review as it now stands where CommCare HQ moved since the read, and takes nothing", async () => {
		const appId = await broughtIn();
		const before = await head(appId);
		await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true });
			await withTools(async (client) => {
				const listed = await readChanges(client, appId);
				serveRead(peer, renamed("Survey, renamed again in CommCare HQ"), {
					tables: true,
				});
				const { isError, body } = await call(client, "bring_in_hq_changes", {
					app_id: appId,
					reading_id: listed.reading_id,
					review_digest: listed.review_digest,
					discard_nova_changes: false,
					table_choices: {},
				});
				expect(isError).toBe(false);
				expect(body).toMatchObject({
					kind: "changed",
					message: hqChangesMovedLine(null),
					edited_by: null,
					next: null,
					now: {
						kind: "changes",
						hq_changes: ["The app's name"],
						nova_changes: [],
						reading_id: listed.reading_id,
					},
				});
				const now = body.now as Json;
				expect(now.review_digest).toMatch(/^[0-9a-f]{64}$/);
				expect(now.review_digest).not.toBe(listed.review_digest);
			});
		});
		expect(await head(appId)).toEqual(before);
		expect(await hqChangeRows(appId)).toEqual([]);
	});
});

describe("a publish over a change made in CommCare HQ", () => {
	/* The offer to bring the change in rides the publish's own stop: an app
	 * brought in holds a usable pair, so the app's change carries
	 * `can_bring_in` true, and what the change is reads through
	 * `read_hq_changes`. */
	it("stops with hq_changed whose app change can be brought in, sending nothing", async () => {
		const appId = await broughtIn();
		const before = await head(appId);
		/* The publish reads HQ's save counter before the app's source. */
		await withHqPeer(new HqSaveCounter(), FIXTURE_HOST, async (peer) => {
			serveAnswer(peer, FIXTURE_PATHS.source, renamed());
			serveFixtureTables(peer);
			await withTools(async (client) => {
				const stopped = await call(client, "upload_app_to_hq", {
					app_id: appId,
					domain: FIXTURE_DOMAIN,
					confirm_plan_features: [...PLAN_FEATURE_IDS],
					confirm_flat_location_fixture: true,
					confirm_connect_forwarder: true,
					confirm_form_entry_sync_off: true,
					confirm_commtrack_off: true,
				});
				expect(stopped.isError, JSON.stringify(stopped.body)).toBe(true);
				expect(stopped.body).toMatchObject({
					error_type: "hq_changed",
					remote_changes: [
						{
							kind: "app",
							nova_resource_id: appId,
							parts: ["The app's name"],
							baseline_known: true,
							can_bring_in: true,
						},
					],
				});
			});
			expect(
				requested(peer).filter((path) => path.includes("import_app")),
			).toEqual([]);
		});
		expect(await head(appId)).toEqual(before);
	});
});

describe("a review Nova cannot make", () => {
	it("says so against the day the app was brought in, where Nova can't read its own record, asking CommCare HQ nothing", async () => {
		const appId = await broughtIn();
		/* A stored source that no longer verifies is no read Nova can compare with. */
		await h
			.db()
			.updateTable("app_deployment_baselines")
			.set({ source_digest: "f".repeat(64) })
			.execute();
		const [mapping] = await h
			.db()
			.selectFrom("app_deployment_resources")
			.select("adopted_at")
			.where("kind", "=", "app")
			.execute();
		const at = mapping?.adopted_at?.toISOString();
		if (at === undefined)
			throw new Error("The brought-in app holds no adoption.");
		await withHttpPeer(async (peer) => {
			const { isError, body } = await withTools((client) =>
				call(client, "read_hq_changes", { app_id: appId }),
			);
			expect(isError).toBe(false);
			const since = { kind: "brought-in", at } as const;
			expect(body).toEqual({
				app_id: appId,
				server: FIXTURE_SERVER,
				domain: FIXTURE_DOMAIN,
				kind: "unavailable",
				reason: "baseline-unread",
				since,
				message: hqChangesUnavailableLine("baseline-unread", {
					domain: FIXTURE_DOMAIN,
					since,
				}),
			});
			/* The day the app was brought in, as every MCP sentence spells one. */
			expect(body.message).toContain(` on ${driftDate(at)},`);
			expect(requested(peer)).toEqual([]);
		});
	});
});

describe("what a call is handed", () => {
	it("sends a notification for each stage of the read and of the bring-in, the read with the call's signal and the bring-in with none", async () => {
		const appId = await broughtIn();
		await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true, times: 2 });
			await withTools(async (client) => {
				const tags = async (name: string, args: Json) => {
					const messages: string[] = [];
					const result = await client.callTool(
						{ name, arguments: args },
						{ onprogress: (update) => messages.push(update.message ?? "") },
					);
					expect(result.isError).not.toBe(true);
					return {
						body: JSON.parse(resultContentText(result)) as Json,
						tags: [
							...new Set(messages.map((message) => message.split("]")[0])),
						],
					};
				};
				const read = await tags("read_hq_changes", { app_id: appId });
				const readStages = [...new Set(observed.stages)];
				expect(readStages.length).toBeGreaterThan(1);
				expect(read.tags).toEqual(
					readStages.map(
						(stage) => `[hq_changes_${stage.replaceAll("-", "_")}`,
					),
				);
				expect(observed.reviewOptions[0]?.cancel).toBeInstanceOf(AbortSignal);

				observed.stages.length = 0;
				const brought = await tags("bring_in_hq_changes", {
					app_id: appId,
					reading_id: read.body.reading_id,
					review_digest: read.body.review_digest,
					discard_nova_changes: false,
					table_choices: {},
				});
				expect(brought.body.kind).toBe("brought-in");
				expect(observed.stages).toContain("bringing-in");
				expect(brought.tags).toEqual(
					[...new Set(observed.stages)].map(
						(stage) => `[hq_changes_${stage.replaceAll("-", "_")}`,
					),
				);
				expect(Object.keys(observed.bringInOptions[0] ?? {})).toEqual([
					"onEvent",
				]);
			});
		});
	});

	it("stops reading CommCare HQ when the client cancels the read", async () => {
		const appId = await broughtIn();
		await withHttpPeer(async (peer) => {
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const source = renamed();
			const resource = fixtureResource(source);
			serveAnswer(peer, FIXTURE_PATHS.application, resource);
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
			await withTools(async (client) => {
				const cancel = new AbortController();
				const pending = client.callTool(
					{ name: "read_hq_changes", arguments: { app_id: appId } },
					{ signal: cancel.signal },
				);
				try {
					await reached.promise;
					cancel.abort();
					await expect(pending).rejects.toThrow();
				} finally {
					release.resolve();
				}
				const [review] = observed.reviews;
				if (review === undefined) throw new Error("the tool started no review");
				const answered = (await review) as HqChangesReview;
				expect(answered.kind).not.toBe("changes");
				/* Nothing past the held read: no counter, no table, no file. */
				expect(requested(peer)).toEqual([
					FIXTURE_PATHS.application,
					FIXTURE_PATHS.source,
				]);
			});
		});
	});

	it("refuses a member who can't edit the app as not found, and a project space the key can't reach, asking CommCare HQ nothing", async () => {
		const appId = await broughtIn();
		await h.seedProjectMember(VIEWER, PROJECT, "viewer");
		await seedFixtureConnection(VIEWER);
		await withHttpPeer(async (peer) => {
			const viewer = await withTools(
				(client) => call(client, "read_hq_changes", { app_id: appId }),
				VIEWER,
			);
			expect(viewer.isError).toBe(true);
			expect(viewer.body).toMatchObject({
				error_type: "not_found",
				app_id: appId,
			});
			const elsewhere = await withTools((client) =>
				call(client, "bring_in_hq_changes", {
					app_id: appId,
					domain: "training",
					reading_id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
					review_digest: "ab".repeat(32),
					discard_nova_changes: false,
					table_choices: {},
				}),
			);
			expect(elsewhere).toEqual({
				isError: true,
				body: {
					error_type: "domain_not_authorized",
					message: `Your stored CommCare HQ API key can't reach the “training” project space. It reaches: ${FIXTURE_DOMAIN}. Pass one of those as \`domain\`, or update your key in Settings.`,
					app_id: appId,
				},
			});
			expect(requested(peer)).toEqual([]);
		});
	});
});
