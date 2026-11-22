/**
 * Refresh from CommCare HQ over real Postgres and a peer standing in for
 * CommCare HQ: `refreshKeptValues` replaces the baseline only where the
 * fresh read compares equal to it, keeps what a read without a publish does
 * not change, and writes nothing on every other answer.
 *
 * The source reads the peer serves are HQ's own, retained by the proof lane
 * (`proof/hq-reads/publish/`), or edits of one, each case saying which. A
 * 401, a 403 and a 500 are bare statuses, and a timeout is the peer never
 * answering inside the read's deadline.
 *
 * Refresh from CommCare HQ as the card asks it (`refreshKeptValuesAction`)
 * answers a refresh whose write landed as landed when the kept list cannot
 * be read after it: the store's facts read is the one seam replaced.
 *
 * What a mocked test cannot show: the writer's two guards hold against a
 * publish's baseline or another refresh's that lands while HQ is answering,
 * because every write takes the same row lock; and the write reaches the
 * deployment lane's channel in its own transaction.
 */

import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { Client } from "pg";
import type { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedPublishRead,
	replyRetained,
	retainedBodyText,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { writeHqRoundTripHorizon } from "@/lib/agent/change-set/__tests__/foldHorizonFixture";
import { getSession } from "@/lib/auth-utils";
import { decrypt } from "@/lib/commcare/encryption";
import { commitGuardedBatchProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { log } from "@/lib/logger";
import { refreshKeptValuesAction } from "../actions";
import {
	downloadKeptAdvisoryFacts,
	resolveDownloadTarget,
} from "../downloadTarget";
import { DeploymentError } from "../errors";
import { normalizeHqAppSource } from "../hqSourceBaseline";
import { deploymentKept, refreshKeptValues } from "../service";
import {
	type DeploymentScope,
	foldDeploymentAttempt,
	holdTargetFacts,
	readAppBaseline,
	readDeployment,
	readTargetFacts,
	recordCreatedRemoteApp,
	recordRemoteResource,
} from "../store";
import type { AppBaselineWrite, AppOwnership } from "../types";
import { certifyFold } from "./certifiedFold";
import { stopHere } from "./stopHere";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/auth-utils", () => ({ getSession: vi.fn() }));
vi.mock("../store", async (original) => {
	const store = await original<typeof import("../store")>();
	return { ...store, holdTargetFacts: vi.fn(store.holdTargetFacts) };
});
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});
afterEach(() => vi.useRealTimers());

const h = setupAppStateTestDb("refresh_kept_", { authSchema: "migrated" });

const APP = "kept-app",
	PROJECT = "program",
	ACTOR = "editor";
const TARGET = { server: "india" as const, domain: "clinic" };
const SCOPE: DeploymentScope = {
	appId: APP,
	projectId: PROJECT,
	role: "editor",
	actorUserId: ACTOR,
};
const HOST = "https://india.commcarehq.org";
const HQ_APP = "working-app";
const SOURCE = `/a/clinic/apps/source/${HQ_APP}/`;
const PUBLISHED_AT = "2026-11-01T09:00:00.000Z";
const DISCARDED = "d".repeat(64);

/** What Nova's upload owned in the read: its two app settings. */
const OWNERSHIP: AppOwnership = {
	addOns: [],
	profileProperties: ["cc-show-saved", "cc-show-incomplete"],
	profileCustomProperties: [],
	autoGpsCapture: false,
};

async function seedApp(
	options: {
		readonly server?: "india" | "production";
		readonly domains?: readonly string[];
		readonly key?: boolean;
	} = {},
) {
	await h.seedApp({
		id: APP,
		owner: ACTOR,
		project_id: PROJECT,
		app_name: "Patients and visits",
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	if (options.key === false) return;
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: ACTOR,
			commcare_username: "account",
			commcare_api_key: "ciphertext",
			commcare_server: options.server ?? "india",
			approved_domains: JSON.stringify(
				(options.domains ?? ["clinic"]).map((name) => ({
					name,
					displayName: name,
				})),
			),
			updated_at: new Date(),
		})
		.execute();
}

/** HQ's retained source read of the published app, as JSON. */
function liveSource(): Record<string, unknown> {
	return JSON.parse(retainedBodyText(retainedPublishRead("source-live")));
}

/** The retained read with one kept setting moved: fuzzy search turned on in CommCare HQ. */
function fuzzyOnSource(): Record<string, unknown> {
	const source = liveSource();
	const profile = source.profile as { properties: Record<string, string> };
	profile.properties["cc-fuzzy-search-enabled"] = "yes";
	return source;
}

/** The retained read with its first form's title edited, which a publish writes. */
function formEditedSource(): Record<string, unknown> {
	const source = liveSource();
	const attachments = source._attachments as Record<string, string>;
	const [key] = Object.keys(attachments);
	attachments[key] = attachments[key].replace(
		"<h:title>Visit</h:title>",
		"<h:title>Visit, edited</h:title>",
	);
	return source;
}

/** `source` with one key of its first language's `translations` set to `value`. */
function withTranslation(
	source: Record<string, unknown>,
	key: string,
	value: string,
): Record<string, unknown> {
	const [lang] = source.langs as string[];
	if (lang === undefined) throw new Error("The retained read holds a language");
	const translations = (source.translations ?? {}) as Record<
		string,
		Record<string, string>
	>;
	source.translations = {
		...translations,
		[lang]: { ...translations[lang], [key]: value },
	};
	return source;
}

/** A baseline of `source` as a publish stores it. */
function baselineOf(
	source: Record<string, unknown>,
	options: {
		readonly origin?: "push" | "cutover";
		readonly remoteAppId?: string;
		readonly observedAt?: string;
		readonly discard?: string;
	} = {},
): AppBaselineWrite {
	const read = normalizeHqAppSource(source);
	if ("malformed" in read) throw new Error(read.malformed);
	return {
		origin: options.origin ?? "push",
		remoteAppId: options.remoteAppId ?? HQ_APP,
		sourceGzip: gzipSync(Buffer.from(read.text, "utf8")),
		sourceBytes: read.bytes,
		sourceDigest: read.digest,
		ownership: OWNERSHIP,
		observedAt: options.observedAt ?? PUBLISHED_AT,
		discard: options.discard === undefined ? null : { digest: options.discard },
		novaRevision: null,
		mediaFiles: { kind: "set", files: null },
		firstPublish: { kind: "set", list: null },
	};
}

/** Record a landed publish of the HQ app with `baseline`. */
async function published(baseline: AppBaselineWrite, remoteId = HQ_APP) {
	await foldDeploymentAttempt(
		SCOPE,
		TARGET,
		"preflight",
		{ status: "succeeded", at: PUBLISHED_AT },
		{ ensure: true, expectedEndings: 0 },
	);
	return recordRemoteResource(SCOPE, TARGET, {
		expectedEndings: 0,
		kind: "app",
		novaResourceId: APP,
		remoteId,
		ownership: "nova-created",
		adoptedBy: null,
		pushedRevision: baseline.novaRevision ?? 1,
		uploadedAt: PUBLISHED_AT,
		remoteRevision: null,
		baseline,
	});
}

function request(peer: MockAgent) {
	return peer.get(HOST).intercept({
		path: SOURCE,
		method: "GET",
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}
function serveRetained(peer: MockAgent, name: RetainedPublishRead) {
	replyRetained(request(peer), retainedPublishRead(name));
}
function serveSource(peer: MockAgent, source: Record<string, unknown>) {
	request(peer).reply(200, JSON.stringify(source), {
		headers: { "content-type": "application/json" },
	});
}
function sent(peer: MockAgent): number {
	return peer.getCallHistory()?.calls().length ?? 0;
}

/** The stored baseline row, whole. */
async function baselineRow() {
	return h
		.db()
		.selectFrom("app_deployment_baselines")
		.selectAll()
		.select(sql<string>`xmin::text`.as("written_by_transaction"))
		.executeTakeFirst();
}

describe("refreshKeptValues", () => {
	it("refreshes a kept setting across a fold while an editor’s later change stays unpublished", async () => {
		await seedApp();
		const publishedSeq = await writeHqRoundTripHorizon(
			h.db(),
			APP,
			"Published survey",
		);
		await published({
			...baselineOf(liveSource()),
			novaRevision: publishedSeq,
		});
		await commitGuardedBatchProposal({
			appId: APP,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name: "My unpublished survey" }],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		expect(await certifyFold(h.db(), APP)).toMatchObject({ usable: 1 });
		await withHttpPeer(async (peer) => {
			serveSource(peer, fuzzyOnSource());
			expect((await refreshKeptValues(SCOPE, TARGET)).kind).toBe("refreshed");
		});
		expect(await readAppBaseline(SCOPE, TARGET)).toMatchObject({
			novaRevision: publishedSeq,
			foldBinding: {
				novaRevision: publishedSeq,
				sourceDigest: baselineOf(fuzzyOnSource()).sourceDigest,
			},
		});
	});
	it.each(["push", "cutover"] as const)(
		"rewrites a %s baseline's source, digest and date from the read, and keeps its origin, ownership and discard",
		async (origin) => {
			await seedApp();
			await published(baselineOf(liveSource(), { origin, discard: DISCARDED }));
			const before = await baselineRow();
			const listener = new Client({ connectionString: h.uri() });
			const payloads: unknown[] = [];
			const onNotification = (message: {
				channel: string;
				payload?: string;
			}) => {
				if (message.channel === "nova_app_stream")
					payloads.push(JSON.parse(message.payload ?? "null"));
			};
			try {
				await listener.connect();
				listener.on("notification", onNotification);
				await listener.query("LISTEN nova_app_stream");
				await withHttpPeer(async (peer) => {
					let askedAt = 0;
					request(peer).reply(() => {
						askedAt = Date.now();
						return {
							statusCode: 200,
							data: JSON.stringify(fuzzyOnSource()),
						};
					});
					const startedAt = Date.now();
					const outcome = await refreshKeptValues(SCOPE, TARGET);
					expect(outcome.kind).toBe("refreshed");

					const after = await baselineRow();
					const expected = baselineOf(fuzzyOnSource());
					expect(after?.source_digest).toBe(expected.sourceDigest);
					expect(after?.source_digest).not.toBe(before?.source_digest);
					expect(after?.source_bytes).toBe(expected.sourceBytes);
					/* The date is the instant taken before the request was sent. */
					const observedAt = after?.observed_at.getTime() ?? 0;
					expect(observedAt).toBeGreaterThanOrEqual(startedAt);
					expect(observedAt).toBeLessThanOrEqual(askedAt);
					expect(after).toMatchObject({
						origin,
						remote_app_id: HQ_APP,
						ownership: OWNERSHIP,
						discarded_digest: DISCARDED,
						discarded_by: ACTOR,
					});
					expect(after?.discarded_at).toEqual(before?.discarded_at);
				});
				await vi.waitFor(() => {
					expect(payloads).toContainEqual({
						appId: APP,
						deploymentChanged: true,
					});
				});
			} finally {
				listener.off("notification", onNotification);
				await listener.end();
			}

			/* What every surface reads next follows the fresh read. */
			const facts = await readTargetFacts(SCOPE, TARGET);
			expect(facts?.profileProperties["cc-fuzzy-search-enabled"]).toBe("yes");
			const deployment = await readDeployment(SCOPE, TARGET);
			if (deployment === null) throw new Error("Expected the deployment");
			expect((await deploymentKept(SCOPE, deployment))?.labels).toContain(
				"fuzzy-search",
			);
		},
	);

	it("answers changed-in-hq for a form edited in CommCare HQ and writes nothing", async () => {
		await seedApp();
		await published(baselineOf(liveSource()));
		const before = await baselineRow();
		await withHttpPeer(async (peer) => {
			serveSource(peer, formEditedSource());
			expect(await refreshKeptValues(SCOPE, TARGET)).toEqual({
				kind: "changed-in-hq",
			});
		});
		expect(await baselineRow()).toEqual(before);
	});

	/* A key HQ's build writes as another string than its own name is no
	 * publish's to carry, so one stored in CommCare HQ is a change. */
	it("answers changed-in-hq for a stored key that sets another string than its own name, and writes nothing", async () => {
		await seedApp();
		await published(baselineOf(liveSource()));
		const before = await baselineRow();
		await withHttpPeer(async (peer) => {
			serveSource(peer, withTranslation(liveSource(), " modules.m0", "Other"));
			expect(await refreshKeptValues(SCOPE, TARGET)).toEqual({
				kind: "changed-in-hq",
			});
		});
		expect(await baselineRow()).toEqual(before);
	});

	it("answers changed-in-hq for a file replaced at a path the record holds, and nothing for a path it holds no record of", async () => {
		const path = "commcare/image/visit.png";
		const withFile = (id: string) => {
			const source = liveSource();
			source.multimedia_map = {
				[`jr://file/${path}`]: {
					multimedia_id: id,
					media_type: "CommCareImage",
					version: null,
					unique_id: "52946998b4756538f0430bb5a67b6939",
					upstream_media_id: null,
					doc_type: "HQMediaMapItem",
				},
			};
			return source;
		};
		await seedApp();
		await published({
			...baselineOf(liveSource()),
			mediaFiles: { kind: "set", files: { [path]: "doc-nova" } },
		});
		const before = await baselineRow();
		await withHttpPeer(async (peer) => {
			serveSource(peer, withFile("doc-person"));
			expect(await refreshKeptValues(SCOPE, TARGET)).toEqual({
				kind: "changed-in-hq",
			});
			/* A file was never fetched: the ids alone say it moved. */
			expect(sent(peer)).toBe(1);
		});
		expect(await baselineRow()).toEqual(before);

		await h
			.db()
			.updateTable("app_deployment_baselines")
			.set({ media_files: JSON.stringify({}) })
			.execute();
		await withHttpPeer(async (peer) => {
			serveSource(peer, withFile("doc-person"));
			expect((await refreshKeptValues(SCOPE, TARGET)).kind).toBe("refreshed");
			expect(sent(peer)).toBe(1);
		});
	});

	describe("answers no-baseline and asks CommCare HQ nothing", () => {
		it("for an app with no deployment there", async () => {
			await seedApp();
			await withHttpPeer(async (peer) => {
				expect(await refreshKeptValues(SCOPE, TARGET)).toEqual({
					kind: "no-baseline",
				});
				expect(sent(peer)).toBe(0);
			});
		});

		it("for a deployment with no live app mapping", async () => {
			await seedApp();
			await foldDeploymentAttempt(
				SCOPE,
				TARGET,
				"preflight",
				{ status: "succeeded", at: PUBLISHED_AT },
				{ ensure: true, expectedEndings: 0 },
			);
			await withHttpPeer(async (peer) => {
				expect(await refreshKeptValues(SCOPE, TARGET)).toEqual({
					kind: "no-baseline",
				});
				expect(sent(peer)).toBe(0);
			});
		});

		it("for an unread baseline", async () => {
			await seedApp();
			await published({
				origin: "unread",
				remoteAppId: HQ_APP,
				sourceGzip: null,
				sourceBytes: null,
				sourceDigest: null,
				ownership: null,
				observedAt: PUBLISHED_AT,
				discard: null,
				novaRevision: null,
				mediaFiles: { kind: "set", files: null },
				firstPublish: { kind: "set", list: null },
			});
			const before = await baselineRow();
			await withHttpPeer(async (peer) => {
				expect(await refreshKeptValues(SCOPE, TARGET)).toEqual({
					kind: "no-baseline",
				});
				expect(sent(peer)).toBe(0);
			});
			expect(await baselineRow()).toEqual(before);
		});

		it("for the baseline of the empty app a first publish made", async () => {
			await seedApp();
			await foldDeploymentAttempt(
				SCOPE,
				TARGET,
				"preflight",
				{ status: "succeeded", at: PUBLISHED_AT },
				{ ensure: true, expectedEndings: 0 },
			);
			const shell = baselineOf(liveSource());
			await recordCreatedRemoteApp(SCOPE, TARGET, {
				expectedEndings: 0,
				remoteId: HQ_APP,
				baseline: { ...shell, origin: "create" },
			});
			const before = await baselineRow();
			await withHttpPeer(async (peer) => {
				expect(await refreshKeptValues(SCOPE, TARGET)).toEqual({
					kind: "no-baseline",
				});
				expect(sent(peer)).toBe(0);
			});
			expect(await baselineRow()).toEqual(before);
		});

		it("for a baseline of another HQ app than the live mapping", async () => {
			await seedApp();
			await published(baselineOf(liveSource(), { remoteAppId: "earlier-app" }));
			await withHttpPeer(async (peer) => {
				expect(await refreshKeptValues(SCOPE, TARGET)).toEqual({
					kind: "no-baseline",
				});
				expect(sent(peer)).toBe(0);
			});
		});
	});

	describe("over a deployment someone stopped, one whose HQ app another Nova app took, and one Nova brought in", () => {
		it("says publishing stopped there and asks CommCare HQ nothing", async () => {
			await seedApp();
			await published(baselineOf(liveSource()));
			await h.seedProjectMember("an-admin", PROJECT, "admin");
			await stopHere(
				{ ...SCOPE, role: "admin", actorUserId: "an-admin" },
				TARGET,
			);
			await withHttpPeer(async (peer) => {
				await expect(refreshKeptValues(SCOPE, TARGET)).rejects.toMatchObject({
					name: "DeploymentError",
					code: "invalid",
					message:
						"Nova stopped publishing this app to “clinic”, so there's nothing there for it to check on. Publishing there again makes a new app.",
				});
				expect(sent(peer)).toBe(0);
			});
		});

		it("says publishing stopped there when someone stops it while CommCare HQ is answering, and writes nothing", async () => {
			await seedApp();
			await published(baselineOf(liveSource()));
			await h.seedProjectMember("an-admin", PROJECT, "admin");
			const before = await baselineRow();
			await withHttpPeer(async (peer) => {
				/* The read compares equal, so only the ending stops the write. */
				request(peer).reply(async () => {
					await stopHere(
						{ ...SCOPE, role: "admin", actorUserId: "an-admin" },
						TARGET,
					);
					return { statusCode: 200, data: JSON.stringify(liveSource()) };
				});
				await expect(refreshKeptValues(SCOPE, TARGET)).rejects.toMatchObject({
					name: "DeploymentError",
					code: "invalid",
					message:
						"Nova stopped publishing this app to “clinic”, so there's nothing there for it to check on. Publishing there again makes a new app.",
				});
			});
			expect(await baselineRow()).toEqual(before);
		});

		it("answers no-baseline for a live mapping that is released, and asks CommCare HQ nothing", async () => {
			await seedApp();
			await published(baselineOf(liveSource()));
			await h
				.db()
				.updateTable("app_deployment_resources")
				.set({ released_at: new Date() })
				.where("kind", "=", "app")
				.execute();
			const before = await baselineRow();
			await withHttpPeer(async (peer) => {
				expect(await refreshKeptValues(SCOPE, TARGET)).toEqual({
					kind: "no-baseline",
				});
				expect(sent(peer)).toBe(0);
			});
			expect(await baselineRow()).toEqual(before);
		});

		it("refreshes a read baseline and keeps its revision, its HQ files and the first publish's list", async () => {
			await seedApp();
			const files = { "commcare/image/logo.png": "hq-file-1" };
			const list = {
				ids: ["forms-and-settings-rewritten"],
				webAppsOnInHq: true,
				of: "first-publish",
			} as const;
			await foldDeploymentAttempt(
				SCOPE,
				TARGET,
				"preflight",
				{ status: "succeeded", at: PUBLISHED_AT },
				{ ensure: true, expectedEndings: 0 },
			);
			await recordRemoteResource(SCOPE, TARGET, {
				expectedEndings: 0,
				kind: "app",
				novaResourceId: APP,
				remoteId: HQ_APP,
				ownership: "adopted",
				adoptedBy: ACTOR,
				pushedRevision: 1,
				uploadedAt: PUBLISHED_AT,
				remoteRevision: null,
				baseline: {
					...baselineOf(liveSource()),
					origin: "read",
					novaRevision: 1,
					mediaFiles: { kind: "set", files },
					firstPublish: { kind: "set", list },
				},
			});
			await withHttpPeer(async (peer) => {
				serveSource(peer, fuzzyOnSource());
				expect((await refreshKeptValues(SCOPE, TARGET)).kind).toBe("refreshed");
			});
			const after = await baselineRow();
			expect(after?.source_digest).toBe(
				baselineOf(fuzzyOnSource()).sourceDigest,
			);
			expect(after).toMatchObject({
				origin: "read",
				media_files: files,
				first_publish_changes: list,
			});
			expect(Number(after?.nova_revision)).toBe(1);
		});
	});

	describe("writes nothing where CommCare HQ's answer is no app Nova can compare", () => {
		async function answered(serve: (peer: MockAgent) => void): Promise<string> {
			await seedApp();
			await published(baselineOf(liveSource()));
			const before = await baselineRow();
			const kind = await withHttpPeer(async (peer) => {
				serve(peer);
				return (await refreshKeptValues(SCOPE, TARGET)).kind;
			});
			expect(await baselineRow()).toEqual(before);
			return kind;
		}

		it.each(["source-missing", "source-deleted"] as const)(
			"answers app-gone for HQ's %s",
			async (name) => {
				expect(await answered((peer) => serveRetained(peer, name))).toBe(
					"app-gone",
				);
			},
		);

		it("answers unreadable for a linked app", async () => {
			expect(
				await answered((peer) => serveRetained(peer, "source-linked")),
			).toBe("unreadable");
		});

		it("answers unreadable for an app source with no menus", async () => {
			const source = liveSource();
			delete source.modules;
			expect(await answered((peer) => serveSource(peer, source))).toBe(
				"unreadable",
			);
		});

		it("answers key-not-accepted for a 401", async () => {
			expect(await answered((peer) => request(peer).reply(401, ""))).toBe(
				"key-not-accepted",
			);
		});

		it("answers no-permission for a 403", async () => {
			expect(await answered((peer) => request(peer).reply(403, ""))).toBe(
				"no-permission",
			);
		});

		it("answers browser-only for a page meant for a person where the app's source was asked", async () => {
			expect(
				await answered((peer) =>
					request(peer).reply(
						200,
						"<!DOCTYPE html><html><body>Sign in</body></html>",
						{ headers: { "content-type": "text/html" } },
					),
				),
			).toBe("browser-only");
		});

		it("answers unavailable for a 500", async () => {
			expect(await answered((peer) => request(peer).reply(500, ""))).toBe(
				"unavailable",
			);
		});
	});

	it("answers unavailable when CommCare HQ never answers inside the read's deadline, and writes nothing", async () => {
		await seedApp();
		await published(baselineOf(liveSource()));
		const before = await baselineRow();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			const asked = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			request(peer).reply(async () => {
				asked.resolve();
				await release.promise;
				return { statusCode: 200, data: JSON.stringify(liveSource()) };
			});
			const pending = refreshKeptValues(SCOPE, TARGET);
			try {
				await asked.promise;
				await vi.advanceTimersByTimeAsync(60_000);
				expect(await pending).toEqual({ kind: "unavailable" });
			} finally {
				release.resolve();
				await pending.catch(() => undefined);
			}
		});
		vi.useRealTimers();
		expect(await baselineRow()).toEqual(before);
	});

	it("keeps a publish's baseline written while CommCare HQ was answering, and answers superseded with the deployment as that publish left it", async () => {
		await seedApp();
		await published(baselineOf(liveSource()));
		const publishedAgain = baselineOf(fuzzyOnSource(), {
			observedAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await withHttpPeer(async (peer) => {
			request(peer).reply(async () => {
				await published(publishedAgain);
				return { statusCode: 200, data: JSON.stringify(liveSource()) };
			});
			const outcome = await refreshKeptValues(SCOPE, TARGET);
			expect(outcome.kind).toBe("superseded");
			if (outcome.kind !== "superseded") return;
			expect(outcome.deployment).toEqual(await readDeployment(SCOPE, TARGET));
		});
		expect(await baselineRow()).toMatchObject({
			source_digest: publishedAgain.sourceDigest,
			observed_at: new Date(publishedAgain.observedAt),
		});
	});

	it("keeps a publish's read-back that equals the read, when the refresh was asked before it, and answers refreshed", async () => {
		await seedApp();
		await published(baselineOf(liveSource()));
		/* The publish imported after the refresh's request was sent, so its
		 * read-back carries the later date, byte for byte the same source:
		 * what the refresh read is what the baseline holds. */
		const readBack = baselineOf(liveSource(), {
			observedAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await withHttpPeer(async (peer) => {
			request(peer).reply(async () => {
				await published(readBack);
				return { statusCode: 200, data: JSON.stringify(liveSource()) };
			});
			expect((await refreshKeptValues(SCOPE, TARGET)).kind).toBe("refreshed");
		});
		expect((await baselineRow())?.observed_at).toEqual(
			new Date(readBack.observedAt),
		);
	});

	it.each([
		"verified",
		"unread",
		"corrupt",
		"media moved",
		"folded again",
	] as const)(
		"checks the later publish's %s read-back after it replaces a certified baseline, without writing",
		async (readBack) => {
			await seedApp();
			const path = "commcare/image/facility.png";
			const source = liveSource();
			source.multimedia_map = {
				[`jr://file/${path}`]: {
					multimedia_id: "original",
					media_type: "CommCareImage",
				},
			};
			const first = await writeHqRoundTripHorizon(
				h.db(),
				APP,
				"Published survey",
			);
			await published({ ...baselineOf(source), novaRevision: first });
			await certifyFold(h.db(), APP);
			const before = await readAppBaseline(SCOPE, TARGET);
			if (!before || before.origin === "unread" || !before.foldBinding)
				throw new Error("Expected a certified comparison");
			const latest = before.foldBinding.foldSeq;
			let afterPublish: Awaited<ReturnType<typeof baselineRow>>;
			await withHttpPeer(async (peer) => {
				request(peer).reply(async () => {
					const next = baselineOf(source, {
						observedAt: new Date().toISOString(),
					});
					await published({
						...next,
						novaRevision: latest,
						...(readBack === "unread" && {
							origin: "unread",
							ownership: null,
							sourceGzip: null,
							sourceDigest: null,
							sourceBytes: null,
							novaRevision: null,
						}),
						...(readBack === "corrupt" && {
							sourceGzip: gzipSync(Buffer.from("{}")),
						}),
						...(readBack === "media moved" && {
							mediaFiles: { kind: "set", files: { [path]: "replacement" } },
						}),
					});
					if (readBack === "folded again")
						await certifyFold(h.db(), APP, "hq-round-trip-case-writes");
					afterPublish = await baselineRow();
					expect(afterPublish?.reference_fold_seq === null).toBe(
						readBack !== "folded again",
					);
					return { statusCode: 200, data: JSON.stringify(source) };
				});
				const outcome = await refreshKeptValues(SCOPE, TARGET);
				expect(outcome).toEqual({
					kind: readBack === "verified" ? "refreshed" : "superseded",
					deployment: await readDeployment(SCOPE, TARGET),
				});
			});
			expect(await baselineRow()).toEqual(afterPublish);
		},
	);

	it.each(["released", "reclaimed"] as const)(
		"leaves the same source untouched if the claim was %s without a new push during refresh",
		async (claim) => {
			await seedApp();
			await published(
				baselineOf(liveSource(), {
					observedAt: new Date(Date.now() + 60_000).toISOString(),
				}),
			);
			const before = await baselineRow();
			await withHttpPeer(async (peer) => {
				request(peer).reply(async () => {
					const mapping = h
						.db()
						.updateTable("app_deployment_resources")
						.where("kind", "=", "app");
					await mapping.set({ released_at: new Date() }).execute();
					if (claim === "reclaimed")
						await mapping.set({ released_at: null }).execute();
					return { statusCode: 200, data: JSON.stringify(liveSource()) };
				});
				expect((await refreshKeptValues(SCOPE, TARGET)).kind).toBe(
					"superseded",
				);
			});
			expect(await baselineRow()).toEqual(before);
		},
	);

	it.each([
		["an unchanged project space", liveSource],
		["a kept setting turned on in CommCare HQ", fuzzyOnSource],
	] as const)(
		"answers refreshed to two refreshes of %s, the one asked later landing first, and keeps the later read",
		async (_name, current) => {
			await seedApp();
			await published(baselineOf(liveSource()));
			const answer = { statusCode: 200, data: JSON.stringify(current()) };
			const kinds = await withHttpPeer(async (peer) => {
				const later: { kind?: string } = {};
				/* The first refresh's request is answered only after a second
				 * refresh, asked while the first waits, has read and landed. */
				request(peer).reply(async () => {
					later.kind = (await refreshKeptValues(SCOPE, TARGET)).kind;
					return answer;
				});
				request(peer).reply(() => answer);
				const earlier = await refreshKeptValues(SCOPE, TARGET);
				return [earlier.kind, later.kind];
			});
			expect(kinds).toEqual(["refreshed", "refreshed"]);
			const stored = baselineOf(current());
			const row = await baselineRow();
			expect(row?.source_digest).toBe(stored.sourceDigest);
			/* The later read's date stands: the earlier one does not move it back. */
			expect(row?.observed_at.getTime()).toBeGreaterThan(
				Date.parse(PUBLISHED_AT),
			);
			const deployment = await readDeployment(SCOPE, TARGET);
			if (deployment === null) throw new Error("Expected the deployment");
			expect((await deploymentKept(SCOPE, deployment))?.observedAt).toBe(
				row?.observed_at.toISOString(),
			);
		},
	);

	it("answers superseded where another refresh landed a different read while CommCare HQ was answering", async () => {
		await seedApp();
		await published(baselineOf(liveSource()));
		await withHttpPeer(async (peer) => {
			/* The second refresh reads fuzzy search turned on; the first,
			 * asked before it, is answered with the app as it was. */
			request(peer).reply(async () => {
				expect((await refreshKeptValues(SCOPE, TARGET)).kind).toBe("refreshed");
				return { statusCode: 200, data: JSON.stringify(liveSource()) };
			});
			serveSource(peer, fuzzyOnSource());
			expect((await refreshKeptValues(SCOPE, TARGET)).kind).toBe("superseded");
		});
		expect((await baselineRow())?.source_digest).toBe(
			baselineOf(fuzzyOnSource()).sourceDigest,
		);
	});

	describe("raises what the caller's connection cannot do, writes nothing and asks nothing", () => {
		async function raised(
			options: Parameters<typeof seedApp>[0],
		): Promise<DeploymentError> {
			await seedApp(options);
			await published(baselineOf(liveSource()));
			const before = await baselineRow();
			const error = await withHttpPeer(async (peer) => {
				const thrown = await refreshKeptValues(SCOPE, TARGET).then(
					() => null,
					(caught: unknown) => caught,
				);
				expect(sent(peer)).toBe(0);
				return thrown;
			});
			expect(await baselineRow()).toEqual(before);
			if (!(error instanceof DeploymentError))
				throw new Error("Expected a DeploymentError");
			return error;
		}

		it("with no key", async () => {
			const error = await raised({ key: false });
			expect(error.code).toBe("hq_not_connected");
			expect(error.message).toBe(
				"CommCare HQ isn't connected on your account, so Nova can't read these again. You can add your API key in Settings, then refresh.",
			);
		});

		it("with a key that cannot reach the project space", async () => {
			const error = await raised({ domains: ["elsewhere"] });
			expect(error.code).toBe("domain_not_authorized");
			expect(error.message).toBe(
				"Your CommCare HQ API key can't reach “clinic”, so Nova can't read these again. What you see is the last thing Nova saw.",
			);
		});

		it("with a key on another CommCare server", async () => {
			const error = await raised({ server: "production" });
			expect(error.code).toBe("invalid");
			expect(error.message).toContain("separate installations");
		});
	});

	it("refuses a viewer before reading anything", async () => {
		await seedApp();
		await published(baselineOf(liveSource()));
		await h.seedProjectMember("viewer", PROJECT, "viewer");
		await withHttpPeer(async (peer) => {
			await expect(
				refreshKeptValues(
					{ ...SCOPE, role: "viewer", actorUserId: "viewer" },
					TARGET,
				),
			).rejects.toMatchObject({ code: "not_found" });
			expect(sent(peer)).toBe(0);
		});
	});
});

/* Every route into a baseline reaches a `.ccz` only through the facts'
 * projection: a Refresh's read and a publish's read-back (the writer
 * `recordRemoteResource` takes with a baseline) alike. */
describe("what a CCZ made after a read follows", () => {
	const doc = buildDoc({ appName: "Patients and visits" });

	it("makes the CCZ before a Refresh reads a custom base URL elsewhere, and refuses it after, naming the host alone", async () => {
		await seedApp();
		await published(baselineOf(liveSource()));
		const before = await resolveDownloadTarget(SCOPE, {
			format: "ccz",
			...TARGET,
			doc,
		});
		expect(before).toMatchObject({ format: "ccz" });
		await withHttpPeer(async (peer) => {
			serveSource(peer, {
				...liveSource(),
				custom_base_url: "https://relay:s3cret@elsewhere.example.org/hq/",
			});
			expect((await refreshKeptValues(SCOPE, TARGET)).kind).toBe("refreshed");
		});
		const after = await resolveDownloadTarget(SCOPE, {
			format: "ccz",
			...TARGET,
			doc,
		});
		expect(after).toMatchObject({
			kind: "refused",
			reason: "workers-sent-elsewhere",
		});
		if (!("kind" in after)) throw new Error("Expected the refusal");
		expect(after.message).toContain("elsewhere.example.org");
		expect(after.message).not.toContain("s3cret");
	});

	it("leaves out the text a publish's read-back holds under a key that sets another string, and the download says so", async () => {
		await seedApp();
		const source = withTranslation(
			withTranslation(liveSource(), " modules.m0", "Smuggled"),
			"home.start",
			"Begin",
		);
		await published(baselineOf(source));
		const [lang] = source.langs as string[];
		const facts = await readTargetFacts(SCOPE, TARGET);
		expect(facts?.uiText[lang ?? ""]).toEqual({ "home.start": "Begin" });
		expect(facts?.uiTextNotCarried).toEqual([lang]);
		const download = await resolveDownloadTarget(SCOPE, {
			format: "ccz",
			...TARGET,
			doc,
		});
		if ("kind" in download) throw new Error(download.message);
		expect(downloadKeptAdvisoryFacts(download, doc)).toMatchObject({
			uiTextNotCarried: true,
			profileNotCarried: false,
		});
	});
});

describe("refreshKeptValuesAction", () => {
	it("answers a refresh whose write landed as landed when its kept list cannot be read after it, and logs the fault by its class and code alone", async () => {
		await seedApp();
		await published(baselineOf(liveSource()));
		vi.mocked(getSession).mockResolvedValue({ user: { id: ACTOR } } as never);
		/* A fault whose message quotes what it was reading: no log line may
		 * carry it. */
		const words = "Mother's Visit Checklist";
		vi.mocked(holdTargetFacts).mockRejectedValueOnce(
			Object.assign(new Error(`could not read “${words}”`), {
				code: "57P01",
			}),
		);
		await withHttpPeer(async (peer) => {
			serveSource(peer, fuzzyOnSource());
			const result = await refreshKeptValuesAction({ appId: APP, ...TARGET });
			if (!result.success) throw new Error(result.message);
			expect(result.data.kind).toBe("refreshed");
			if (result.data.kind !== "refreshed") return;
			expect(result.data.deployment.kept).toBe("unread");
		});
		/* The write the answer reports did land. */
		expect(
			(await readTargetFacts(SCOPE, TARGET))?.profileProperties[
				"cc-fuzzy-search-enabled"
			],
		).toBe("yes");
		expect(log.error).toHaveBeenCalledWith(
			"[deployment] kept list unavailable after a write landed",
			undefined,
			{
				appId: APP,
				domain: TARGET.domain,
				after: "kept-refresh",
				errorName: "Error",
				errorCode: "57P01",
			},
		);
		expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(
			words,
		);
	});
});
