/**
 * The check Nova makes when the builder opens an app, over real Postgres,
 * with CommCare HQ answering through a controlled peer from its own retained
 * source read (`proof/hq-reads/publish/source-live.json`) and the stored
 * key's decryption controlled at the KMS boundary.
 *
 * Contract: `checkHqChangesForApp` lists a deployment exactly where its copy
 * of the app changed in something Nova publishes, a file whose recorded id
 * moved included, among the deployments with a usable pair the member's own
 * key reaches; it reads each with no write of any kind, and a failed read
 * lists nothing and is logged at warn with the app's id alone. It asks about
 * one deployment at a time, reads each baseline once, and asks nothing more
 * once the request is cancelled.
 *
 * Plausible failures: a deployment listed that did not change, or one that
 * did left out; a deployment with no usable pair asked about, so the button
 * offers a review that can only answer `unavailable`; a key on another
 * server sent to this one; a failure thrown into the builder; a path with no
 * record read as a change; a baseline, a fold or a notification written by a
 * check that promises to write nothing; every deployment read at once on a
 * pool of three, each baseline unzipped twice, and reads that go on after the
 * tab that asked closed.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	replyRetained,
	retainedBodyJson,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { claimHqAppInTransaction } from "@/lib/db/hqAppClaims";
import { withAppTx } from "@/lib/db/pg";
import { log } from "@/lib/logger";
import {
	birthAdoptedApp,
	CONFIRMATIONS,
	OWNERSHIP,
	READ_AT,
} from "../../__tests__/adoptedBirth";
import type { HqMediaRecord } from "../../hqMedia";
import { normalizeHqAppSource } from "../../hqSourceBaseline";
import { peekReadDeploymentChanged } from "../../service";
import {
	type AdoptedDeploymentWrite,
	type DeploymentScope,
	readAppBaseline,
	recordAdoptedDeploymentInTransaction,
} from "../../store";
import { EMPTY_TARGET_IDENTITY } from "../../targetIdentity";
import { checkHqChangesForApp } from "../check";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
/* The comparison and the baseline read run as they are; the spies only record when each ran. */
vi.mock("../../service", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../service")>();
	return {
		...actual,
		peekReadDeploymentChanged: vi.fn(actual.peekReadDeploymentChanged),
	};
});
vi.mock("../../store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../store")>();
	return { ...actual, readAppBaseline: vi.fn(actual.readAppBaseline) };
});
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});
afterEach(() => {
	vi.restoreAllMocks();
});

const h = setupAppStateTestDb("hq_changes_check_", {
	authSchema: "migrated",
	poolMax: 4,
});

const ACTOR = "checker";
const PROJECT = "project-check";
const APP = testUuid("hq-changes-check-app");
const HOST = "https://india.commcarehq.org";
const CHANGED = { server: "india" as const, domain: "clinic" };
const QUIET = { server: "india" as const, domain: "quiet" };
const HQ_APP = "c".repeat(32);
const QUIET_HQ_APP = "d".repeat(32);
const PATH = "commcare/image/visit.png";

/** CommCare HQ's source as the peer serves it, `change` applied to its JSON. */
function sourceAnswer(
	change: (body: Record<string, unknown>) => void = () => {},
) {
	const answer = retainedPublishRead("source-live");
	const body = structuredClone(retainedBodyJson(answer));
	change(body);
	return { ...answer, body: JSON.stringify(body) };
}

/** A media map of one image at `PATH`, as CommCare HQ serves an `HQMediaMapItem`. */
function mapOf(id: string): Record<string, unknown> {
	return {
		[`jr://file/${PATH}`]: {
			multimedia_id: id,
			media_type: "CommCareImage",
			version: null,
			unique_id: createHash("md5").update(id).digest("hex"),
			upstream_media_id: null,
			doc_type: "HQMediaMapItem",
		},
	};
}

/** The baseline a bring-in leaves of the retained source: its normalized read. */
function baselineOf(
	remoteAppId: string,
	options: {
		readonly novaRevision?: number | null;
		readonly mediaFiles?: HqMediaRecord | null;
	} = {},
): AdoptedDeploymentWrite["baseline"] {
	const normalized = normalizeHqAppSource(retainedBodyJson(sourceAnswer()));
	if ("malformed" in normalized)
		throw new Error("The retained source does not normalize.");
	return {
		origin: "read",
		remoteAppId,
		sourceGzip: gzipSync(Buffer.from(normalized.text, "utf8")),
		sourceBytes: normalized.bytes,
		sourceDigest: normalized.digest,
		ownership: OWNERSHIP,
		observedAt: READ_AT,
		discard: null,
		novaRevision: options.novaRevision === undefined ? 1 : options.novaRevision,
		mediaFiles: { kind: "set", files: options.mediaFiles ?? {} },
		firstPublish: { kind: "set", list: null },
	};
}

/** The member's stored connection, on `server`, reaching both project spaces. */
async function connect(server: "india" | "production" = "india") {
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: ACTOR,
			commcare_username: "account",
			commcare_api_key: "ciphertext",
			commcare_server: server,
			approved_domains: JSON.stringify([
				{ name: CHANGED.domain, displayName: "Clinic" },
				{ name: QUIET.domain, displayName: "Quiet" },
			]),
			updated_at: new Date(),
		})
		.execute();
}

/** The app brought in from `CHANGED`, and published to `QUIET` too, each with `baseline`. */
async function seed(
	baselines: {
		readonly changed?: AdoptedDeploymentWrite["baseline"];
		readonly quiet?: AdoptedDeploymentWrite["baseline"] | null;
	} = {},
): Promise<DeploymentScope> {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const birth = await birthAdoptedApp(h, {
		appId: APP,
		projectId: PROJECT,
		actorUserId: ACTOR,
		target: CHANGED,
		remoteAppId: HQ_APP,
		writeOverrides: {
			baseline: baselines.changed ?? baselineOf(HQ_APP),
			targetIdentity: EMPTY_TARGET_IDENTITY,
		},
	});
	if (baselines.quiet !== null)
		await withAppTx(async (tx) => {
			await claimHqAppInTransaction(tx, {
				server: QUIET.server,
				domain: QUIET.domain,
				remoteAppId: QUIET_HQ_APP,
			});
			await recordAdoptedDeploymentInTransaction(tx, {
				appId: APP,
				projectId: PROJECT,
				actorUserId: ACTOR,
				target: QUIET,
				remoteAppId: QUIET_HQ_APP,
				remoteRevision: 7,
				pushedRevision: 1,
				baseline: baselines.quiet ?? baselineOf(QUIET_HQ_APP),
				targetIdentity: EMPTY_TARGET_IDENTITY,
				confirmations: CONFIRMATIONS,
				at: new Date(READ_AT),
			});
		});
	return birth.scope;
}

function serveSource(
	peer: MockAgent,
	target: { readonly domain: string },
	remoteAppId: string,
	answer: ReturnType<typeof sourceAnswer> | { status: number; body: string },
) {
	const interceptor = peer.get(HOST).intercept({
		path: `/a/${target.domain}/apps/source/${remoteAppId}/`,
		method: "GET",
		headers: { authorization: "ApiKey account:fixture-key" },
	});
	if ("headers" in answer) replyRetained(interceptor, answer);
	else interceptor.reply(answer.status, answer.body);
}

function requested(peer: MockAgent): string[] {
	return (peer.getCallHistory()?.calls() ?? []).map((call) =>
		call.fullUrl.slice(HOST.length),
	);
}

/** Every row of every table a deployment of the app touches, to show nothing was written. */
async function everyRow() {
	const db = h.db();
	return {
		apps: await db
			.selectFrom("apps")
			.select(["id", "mutation_seq", "updated_at"])
			.execute(),
		changes: await db
			.selectFrom("app_changes")
			.select(["seq", "kind"])
			.execute(),
		deployments: await db.selectFrom("app_deployments").selectAll().execute(),
		resources: await db
			.selectFrom("app_deployment_resources")
			.selectAll()
			.execute(),
		baselines: await db
			.selectFrom("app_deployment_baselines")
			.selectAll()
			.execute(),
		identities: await db
			.selectFrom("app_deployment_identities")
			.selectAll()
			.execute(),
		mediaPaths: await db
			.selectFrom("app_deployment_media_paths")
			.selectAll()
			.execute(),
		confirmations: await db
			.selectFrom("app_deployment_confirmations")
			.selectAll()
			.execute(),
		foldBaselines: await db
			.selectFrom("app_change_fold_baselines")
			.select(["app_id", "seq"])
			.execute(),
	};
}

describe("checkHqChangesForApp", () => {
	it("lists the deployment whose copy changed in CommCare HQ and no other, and writes nothing", async () => {
		const scope = await seed();
		await connect();
		const before = await everyRow();
		const changed = await withHttpPeer(async (peer) => {
			serveSource(
				peer,
				CHANGED,
				HQ_APP,
				sourceAnswer((body) => {
					body.name = "Clinic visits, renamed in HQ";
				}),
			);
			serveSource(peer, QUIET, QUIET_HQ_APP, sourceAnswer());
			return checkHqChangesForApp(scope, {});
		});
		expect(changed).toEqual([CHANGED]);
		expect(await everyRow()).toEqual(before);
	});

	it("asks nothing about a deployment with no usable pair", async () => {
		const scope = await seed({
			quiet: baselineOf(QUIET_HQ_APP, { novaRevision: null }),
		});
		await connect();
		await withHttpPeer(async (peer) => {
			serveSource(peer, CHANGED, HQ_APP, sourceAnswer());
			expect(await checkHqChangesForApp(scope, {})).toEqual([]);
			expect(requested(peer)).toEqual([
				`/a/${CHANGED.domain}/apps/source/${HQ_APP}/`,
			]);
		});
	});

	it("lists nothing and asks nothing where the member holds no key", async () => {
		const scope = await seed();
		await withHttpPeer(async (peer) => {
			expect(await checkHqChangesForApp(scope, {})).toEqual([]);
			expect(requested(peer)).toEqual([]);
		});
	});

	it("lists nothing and asks nothing where the member's key is on another server", async () => {
		const scope = await seed();
		await connect("production");
		await withHttpPeer(async (peer) => {
			expect(await checkHqChangesForApp(scope, {})).toEqual([]);
			expect(requested(peer)).toEqual([]);
		});
	});

	it("lists nothing for a read that failed, and warns with the app's id alone", async () => {
		const scope = await seed({ quiet: null });
		await connect();
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		const changed = await withHttpPeer(async (peer) => {
			serveSource(peer, CHANGED, HQ_APP, { status: 500, body: "" });
			return checkHqChangesForApp(scope, {});
		});
		expect(changed).toEqual([]);
		expect(warn).toHaveBeenCalledWith("[hq-changes] check read failed", {
			appId: APP,
		});
	});

	it("lists a file whose recorded id moved, and not a file Nova's own upload recorded at its path", async () => {
		/* Both baselines are reads from before the file was mapped. In QUIET
		 * the entry HQ holds now is the one Nova's upload recorded there. */
		const scope = await seed({
			changed: baselineOf(HQ_APP, { mediaFiles: { [PATH]: "doc-nova" } }),
			quiet: baselineOf(QUIET_HQ_APP, {
				mediaFiles: { [PATH]: "doc-a-person-uploaded" },
			}),
		});
		await connect();
		const changed = await withHttpPeer(async (peer) => {
			serveSource(
				peer,
				CHANGED,
				HQ_APP,
				sourceAnswer((body) => {
					body.multimedia_map = mapOf("doc-a-person-uploaded");
				}),
			);
			serveSource(
				peer,
				QUIET,
				QUIET_HQ_APP,
				sourceAnswer((body) => {
					body.multimedia_map = mapOf("doc-a-person-uploaded");
				}),
			);
			return checkHqChangesForApp(scope, {});
		});
		expect(changed).toEqual([CHANGED]);
	});

	it("asks about one deployment at a time and reads each baseline once", async () => {
		const scope = await seed();
		await connect();
		const timeline: string[] = [];
		const actual = vi.mocked(peekReadDeploymentChanged).getMockImplementation();
		if (actual === undefined)
			throw new Error("The spy holds no implementation.");
		vi.mocked(peekReadDeploymentChanged).mockImplementation(async (...call) => {
			const domain = call[1].deployment.domain;
			timeline.push(`start ${domain}`);
			try {
				return await actual(...call);
			} finally {
				timeline.push(`end ${domain}`);
			}
		});
		vi.mocked(readAppBaseline).mockClear();
		await withHttpPeer(async (peer) => {
			serveSource(peer, CHANGED, HQ_APP, sourceAnswer());
			serveSource(peer, QUIET, QUIET_HQ_APP, sourceAnswer());
			await checkHqChangesForApp(scope, {});
		});
		expect(timeline).toHaveLength(4);
		expect(timeline[0]?.startsWith("start")).toBe(true);
		expect(timeline[1]).toBe(timeline[0]?.replace("start", "end"));
		expect(timeline[2]?.startsWith("start")).toBe(true);
		expect(timeline[3]).toBe(timeline[2]?.replace("start", "end"));
		expect(vi.mocked(readAppBaseline)).toHaveBeenCalledTimes(2);
	});

	it("asks CommCare HQ nothing more once the request is cancelled", async () => {
		const scope = await seed();
		await connect();
		const cancel = new AbortController();
		const actual = vi.mocked(peekReadDeploymentChanged).getMockImplementation();
		if (actual === undefined)
			throw new Error("The spy holds no implementation.");
		let compared = 0;
		await withHttpPeer(async (peer) => {
			/* Each deployment's source is served as its comparison starts, and the
			 * tab closes once CommCare HQ has answered the first. */
			vi.mocked(peekReadDeploymentChanged).mockImplementation(
				async (...call) => {
					compared += 1;
					const { domain } = call[1].deployment;
					serveSource(
						peer,
						{ domain },
						domain === CHANGED.domain ? HQ_APP : QUIET_HQ_APP,
						sourceAnswer(),
					);
					const answer = await actual(...call);
					cancel.abort();
					return answer;
				},
			);
			expect(
				await checkHqChangesForApp(scope, { cancel: cancel.signal }),
			).toEqual([]);
			expect(requested(peer)).toHaveLength(1);
		});
		expect(compared).toBe(1);
	});
});
