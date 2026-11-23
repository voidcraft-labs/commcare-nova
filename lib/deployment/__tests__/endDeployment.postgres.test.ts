/**
 * Ending a deployment, in real Postgres: who may stop publishing to a project
 * space, what the ending writes and keeps, the fence it raises against a
 * publish that read the deployment before it, and how a released claim is
 * settled.
 */

import { gzipSync } from "node:zlib";
import {
	type KyselyPlugin,
	type PluginTransformQueryArgs,
	type PluginTransformResultArgs,
	type QueryResult,
	type RootOperationNode,
	sql,
	type UnknownRow,
} from "kysely";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { getSession } from "@/lib/auth-utils";
import { seenByHq } from "@/lib/commcare/hq/appsSeen";
import { deploymentSession } from "@/__tests__/helpers/deploymentSession";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { changeUnderEachTry } from "@/lib/db/__tests__/heldAppRow";
import { restoreApp, softDeleteApp } from "@/lib/db/apps";
import { claimHqAppInTransaction } from "@/lib/db/hqAppClaims";
import { __setAppDbForTests, withAppTx } from "@/lib/db/pg";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { PUBLISH_CLAIMS_CHANGED } from "@/lib/publish/stopPublishing";
import { stopPublishingAction } from "../actions";
import { DeploymentEndedError } from "../errors";
import { normalizeHqAppSource } from "../hqSourceBaseline";
import {
	previewProjectSpaceFor,
	readPreviewDeploymentAnswer,
} from "../previewSpace";
import {
	deploymentEnding,
	leftBehindResources,
	nextPublishAction,
} from "../resources";
import { publishAppToHq, refreshDeployment } from "../service";
import {
	applyDeploymentObservation,
	beginDeploymentContentWrite,
	type DeploymentScope,
	endDeployment,
	finishDeploymentContentWrite,
	foldDeploymentAttempt,
	markResourceBaselinesUnread,
	readAppBaseline,
	readDeployment,
	readHqAppClaims,
	recordCreatedRemoteApp,
	recordPushedResources,
	recordRefreshedAppBaseline,
	recordRemoteResource,
	settleReleasedClaims,
} from "../store";
import type { AppBaselineWrite } from "../types";
import { type AdoptedBirth, appClaimOf, birthAdoptedApp } from "./adoptedBirth";
import { readable } from "./readableRecord";

vi.mock("@/lib/auth-utils", () => ({ getSession: vi.fn() }));

const h = setupAppStateTestDb("end_deployment_", {
	authSchema: "migrated",
	poolMax: 4,
});

const OWNER = "space-owner";
const PROJECT = "project-clinic";
const TARGET = { server: "production" as const, domain: "clinic" };
const HQ_APP = "d".repeat(32);
const APP = testUuid("ended-app");
const NOT_PERMITTED =
	"Only an admin or owner of this Project can stop publishing here. You can ask one of them to.";

async function born(): Promise<AdoptedBirth> {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	return birthAdoptedApp(h, {
		appId: APP,
		projectId: PROJECT,
		actorUserId: OWNER,
		target: TARGET,
		remoteAppId: HQ_APP,
	});
}

/** A member of the app's Project at `role`, as a scope. */
async function member(
	userId: string,
	role: "viewer" | "editor" | "admin" | "owner",
): Promise<DeploymentScope> {
	await h.seedProjectMember(userId, PROJECT, role);
	return { appId: APP, projectId: PROJECT, role, actorUserId: userId };
}

/** The record's rows; a birth writes five: two ids, a media path, a keyed prefix and a column word. */
async function heldRows(): Promise<number> {
	const db = h.db();
	const counts = await Promise.all(
		(
			[
				"app_deployment_identities",
				"app_deployment_media_paths",
				"app_deployment_keyed_case_ids",
				"app_deployment_column_field_words",
			] as const
		).map(async (table) => {
			const row = await db
				.selectFrom(table)
				.select((eb) => eb.fn.countAll<string>().as("n"))
				.executeTakeFirstOrThrow();
			return Number(row.n);
		}),
	);
	return counts.reduce((sum, n) => sum + n, 0);
}

function unreadBaseline(remoteAppId: string): AppBaselineWrite {
	return {
		origin: "unread",
		remoteAppId,
		sourceGzip: null,
		sourceBytes: null,
		sourceDigest: null,
		ownership: null,
		observedAt: "2026-11-12T00:00:00.000Z",
		discard: null,
		novaRevision: null,
		mediaFiles: { kind: "set", files: null },
		firstPublish: { kind: "set", list: null },
	};
}

describe("endDeployment", () => {
	it("refuses an editor with the sentence that names who can, and finds nothing for a viewer", async () => {
		await born();
		const editor = await member("an-editor", "editor");
		const viewer = await member("a-viewer", "viewer");
		const before = await readDeployment(editor, TARGET);

		await expect(endDeployment(editor, TARGET, HQ_APP)).rejects.toMatchObject({
			name: "DeploymentError",
			code: "not_permitted",
			message: NOT_PERMITTED,
		});
		await expect(endDeployment(viewer, TARGET, HQ_APP)).rejects.toMatchObject({
			name: "DeploymentError",
			code: "not_found",
		});
		expect(await readDeployment(editor, TARGET)).toEqual(before);
		expect(await heldRows()).toBe(5);
	});

	async function stopsAs(role: "admin" | "owner"): Promise<void> {
		await born();
		const stopper = await member(`a-${role}`, role);
		expect(await previewProjectSpaceFor(stopper)).toBe("clinic");

		const view = await endDeployment(stopper, TARGET, HQ_APP);

		expect(view.deployment).toMatchObject({
			state: "ended",
			resumePhase: null,
			endings: 1,
			lastObservedAt: null,
			offeredLogoContentHash: null,
			targetEmptyCaseListText: null,
		});
		expect(Object.values(view.deployment.phases)).toEqual([
			null,
			null,
			null,
			null,
			null,
			null,
		]);
		expect(view.active).toEqual([]);
		expect(view.superseded).toEqual([
			expect.objectContaining({
				kind: "app",
				remoteId: HQ_APP,
				ownership: "adopted",
				releasedAt: null,
				endedReason: "stopped",
				endedByName: `a-${role}`,
			}),
		]);
		expect(deploymentEnding(view)).toEqual({
			at: view.superseded[0]?.supersededAt,
			byName: `a-${role}`,
			reason: "stopped",
			hqAppId: HQ_APP,
			heldByAnotherApp: false,
		});
		expect(nextPublishAction(view)).toBe("creates-beside");
		expect(view.confirmations).toEqual([
			expect.objectContaining({ kind: "plan-feature", subject: "web-apps" }),
		]);
		expect(await heldRows()).toBe(0);
		expect(await readAppBaseline(stopper, TARGET)).toMatchObject({
			origin: "read",
			remoteAppId: HQ_APP,
		});
		const row = await h
			.db()
			.selectFrom("app_deployments")
			.select(["content_generation", "entry_point_manifest"])
			.executeTakeFirstOrThrow();
		expect(row.content_generation).not.toBeNull();
		expect(row.entry_point_manifest).toBeNull();
		expect(await previewProjectSpaceFor(stopper)).toBeNull();
		expect(
			await readHqAppClaims({
				viewerUserId: OWNER,
				seen: seenByHq("production", "clinic", [HQ_APP]),
			}),
		).toEqual([]);
		await withAppTx((tx) =>
			claimHqAppInTransaction(tx, {
				server: "production",
				domain: "clinic",
				remoteAppId: HQ_APP,
			}),
		);
	}

	it.each(["admin", "owner"] as const)(
		"lets an %s stop publishing, keeping the baseline and the confirmations and freeing the HQ app",
		stopsAs,
	);

	it("answers a repeated stop as the stop that landed, writing nothing, and a target with no deployment that there is none", async () => {
		const birth = await born();
		const stopped = await endDeployment(birth.scope, TARGET, HQ_APP);
		const again = await endDeployment(birth.scope, TARGET, HQ_APP);
		expect(again).toEqual(stopped);
		expect(again.deployment.endings).toBe(1);
		await expect(
			endDeployment(birth.scope, { server: "india", domain: "clinic" }, HQ_APP),
		).rejects.toMatchObject({ name: "DeploymentError", code: "not_found" });
	});

	it("refuses a stop naming an HQ app the deployment does not publish to as stale, and changes nothing", async () => {
		const birth = await born();
		const before = await readDeployment(birth.scope, TARGET);
		await expect(
			endDeployment(birth.scope, TARGET, "f".repeat(32)),
		).rejects.toMatchObject({
			name: "DeploymentError",
			code: "stale",
			message:
				"This app publishes to a different app in “clinic” than the one you were looking at, so Nova didn't stop anything. Have another look, and stop it from there if you still want to.",
		});
		expect(await readDeployment(birth.scope, TARGET)).toEqual(before);
		expect(await heldRows()).toBe(5);
	});

	/* A stop decided over one HQ app, sent again after a teammate's stop and
	 * a republish made a new app there, ends the new app's mapping neither by
	 * mistake nor at all: the new app is a later decision. */
	it("leaves a later publish's new HQ app live when a stop of the earlier one arrives after it", async () => {
		const birth = await born();
		await endDeployment(birth.scope, TARGET, HQ_APP);
		const fresh = "e".repeat(32);
		await foldDeploymentAttempt(
			birth.scope,
			TARGET,
			"preflight",
			{ status: "succeeded", at: "2026-11-12T00:00:00.000Z" },
			{ expectedEndings: 1 },
		);
		await recordCreatedRemoteApp(birth.scope, TARGET, {
			expectedEndings: 1,
			remoteId: fresh,
			baseline: unreadBaseline(fresh),
		});
		const republished = await readDeployment(birth.scope, TARGET);

		expect(await endDeployment(birth.scope, TARGET, HQ_APP)).toEqual(
			republished,
		);
		expect((await readDeployment(birth.scope, TARGET))?.active).toEqual([
			expect.objectContaining({ kind: "app", remoteId: fresh }),
		]);

		const ended = await endDeployment(birth.scope, TARGET, fresh);
		expect(ended.active).toEqual([]);
		expect(ended.deployment.endings).toBe(2);
	});

	it("answers a deployment that never mapped an HQ app that there is nothing to stop", async () => {
		const birth = await born();
		const beta = { server: "production" as const, domain: "beta" };
		await foldDeploymentAttempt(
			birth.scope,
			beta,
			"preflight",
			{ status: "succeeded", at: "2026-11-12T00:00:00.000Z" },
			{ ensure: true, expectedEndings: 0 },
		);
		await expect(
			endDeployment(birth.scope, beta, HQ_APP),
		).rejects.toMatchObject({
			name: "DeploymentError",
			code: "invalid",
			message:
				"Nova isn't publishing this app to “beta”, so there's nothing to stop.",
		});
	});

	it("refuses every fenced write of a publish that read the deployment before it ended, writing nothing", async () => {
		const birth = await born();
		const { scope } = birth;
		const stored = await readAppBaseline(scope, TARGET);
		if (stored === null || stored.origin === "unread")
			throw new Error("Expected a read baseline");
		const generation = await beginDeploymentContentWrite(scope, TARGET, {
			expectedEndings: 0,
		});
		await endDeployment(scope, TARGET, HQ_APP);
		const before = await readDeployment(scope, TARGET);
		const baselineBefore = await readAppBaseline(scope, TARGET);
		const fence = { expectedEndings: 0 } as const;
		const text = JSON.stringify({ name: "Read again" });

		const writes: readonly (readonly [string, () => Promise<unknown>])[] = [
			[
				"foldDeploymentAttempt",
				() =>
					foldDeploymentAttempt(
						scope,
						TARGET,
						"preflight",
						{ status: "succeeded", at: "2026-11-12T00:00:00.000Z" },
						{
							...fence,
							confirmations: [
								{ kind: "plan-feature", subject: "lookup-tables" },
							],
						},
					),
			],
			[
				"beginDeploymentContentWrite",
				() => beginDeploymentContentWrite(scope, TARGET, fence),
			],
			[
				"recordCreatedRemoteApp",
				() =>
					recordCreatedRemoteApp(scope, TARGET, {
						...fence,
						remoteId: "e".repeat(32),
						baseline: unreadBaseline("e".repeat(32)),
					}),
			],
			[
				"recordPushedResources",
				() =>
					recordPushedResources(
						scope,
						TARGET,
						[
							{
								kind: "lookup-table",
								novaResourceId: testUuid("table"),
								remoteId: "hq-table",
								ownership: "nova-created",
								pushedIdentity: "districts",
								pushedRevision: null,
								remoteRevision: null,
							},
						],
						{ status: "partial" },
						fence,
					),
			],
			[
				"markResourceBaselinesUnread",
				() =>
					markResourceBaselinesUnread(
						scope,
						TARGET,
						[{ kind: "lookup-table", remoteId: "hq-table" }],
						fence,
					),
			],
			[
				"recordRemoteResource",
				() =>
					recordRemoteResource(scope, TARGET, {
						...fence,
						kind: "app",
						novaResourceId: scope.appId,
						remoteId: HQ_APP,
						ownership: "adopted",
						adoptedBy: OWNER,
						pushedRevision: 2,
						remoteRevision: 42,
						uploadedAt: "2026-11-12T00:00:00.000Z",
						baseline: unreadBaseline(HQ_APP),
					}),
			],
			[
				"recordRefreshedAppBaseline",
				() =>
					recordRefreshedAppBaseline(scope, TARGET, {
						...fence,
						remoteAppId: HQ_APP,
						reviewedPushToken: appClaimOf(birth),
						comparedDigest: stored.sourceDigest,
						read: {
							sourceGzip: gzipSync(Buffer.from(text)),
							sourceBytes: Buffer.byteLength(text),
							sourceDigest: stored.sourceDigest,
							observedAt: "2026-11-12T00:00:00.000Z",
						},
					}),
			],
		];
		for (const [name, write] of writes) {
			const refusal = await write().then(
				() => null,
				(error: unknown) => error,
			);
			expect(refusal, name).toBeInstanceOf(DeploymentEndedError);
			expect(refusal, name).toMatchObject({
				deploymentId: before?.deployment.id,
				expectedEndings: 0,
				endings: 1,
			});
		}
		expect(
			await finishDeploymentContentWrite(
				scope,
				TARGET,
				generation,
				null,
				fence,
			),
		).toBe(false);

		expect(await readDeployment(scope, TARGET)).toEqual(before);
		expect(await readAppBaseline(scope, TARGET)).toEqual(baselineBefore);
		const tables = await h
			.db()
			.selectFrom("project_space_resource_baselines")
			.select((eb) => eb.fn.countAll<string>().as("n"))
			.executeTakeFirstOrThrow();
		expect(Number(tables.n)).toBe(0);
	});

	it("lets a publish that read the ending go on as a first publish, the ending still standing", async () => {
		const birth = await born();
		await endDeployment(birth.scope, TARGET, HQ_APP);
		const passed = await foldDeploymentAttempt(
			birth.scope,
			TARGET,
			"preflight",
			{ status: "succeeded", at: "2026-11-12T00:00:00.000Z" },
			{ expectedEndings: 1 },
		);
		expect(passed.deployment.state).toBe("preflight");
		expect(deploymentEnding(passed)).toMatchObject({ reason: "stopped" });
		expect(nextPublishAction(passed)).toBe("creates-beside");
	});
});

describe("a released claim", () => {
	async function release(): Promise<void> {
		await sql`UPDATE app_deployment_resources SET released_at = now() WHERE kind = 'app'`.execute(
			h.db(),
		);
	}

	it("is not named by Preview until a settle takes the HQ app back", async () => {
		const birth = await born();
		await release();
		expect(await previewProjectSpaceFor(birth.scope)).toBeNull();

		const editor = await member("an-editor", "editor");
		expect(await settleReleasedClaims(editor)).toEqual({
			settled: true,
			stoppedPublishing: [],
			waiting: [],
		});

		expect(await previewProjectSpaceFor(birth.scope)).toBe("clinic");
		const view = await readDeployment(birth.scope, TARGET);
		expect(view?.active).toEqual([
			expect.objectContaining({ remoteId: HQ_APP, releasedAt: null }),
		]);
		expect(await heldRows()).toBe(5);
	});

	it("ends the deployment where a live Nova app publishes to the HQ app now, and names the project space", async () => {
		const birth = await born();
		await release();
		const other = testUuid("taker-app");
		await birthAdoptedApp(h, {
			appId: other,
			projectId: PROJECT,
			actorUserId: OWNER,
			target: TARGET,
			remoteAppId: HQ_APP,
		});

		expect(await settleReleasedClaims(birth.scope)).toEqual({
			settled: true,
			stoppedPublishing: [{ server: "production", domain: "clinic" }],
			waiting: [],
		});
		const view = await readDeployment(birth.scope, TARGET);
		expect(view?.deployment).toMatchObject({ state: "ended", endings: 1 });
		expect(view === null ? null : deploymentEnding(view)).toMatchObject({
			reason: "claimed-elsewhere",
			byName: OWNER,
			hqAppId: HQ_APP,
		});
	});

	/**
	 * A released claim whose holder, another live app of the Project, is
	 * deleted, restored and deleted again while the settle waits for the
	 * app's row under each of its three tries. The holder's id sorts after
	 * the app's, so every try waits for the app's row first.
	 */
	const TAKER = testUuid("taker-app");
	async function churned<T>(run: () => Promise<T>): Promise<T> {
		expect(TAKER > APP).toBe(true);
		return changeUnderEachTry({
			uri: h.uri(),
			appId: APP,
			run,
			changes: [
				() => softDeleteApp(TAKER, OWNER),
				() => restoreApp(TAKER, OWNER),
				() => softDeleteApp(TAKER, OWNER),
			],
		});
	}
	async function releasedToTaker(): Promise<AdoptedBirth> {
		const birth = await born();
		await release();
		await birthAdoptedApp(h, {
			appId: TAKER,
			projectId: PROJECT,
			actorUserId: OWNER,
			target: TARGET,
			remoteAppId: HQ_APP,
		});
		return birth;
	}

	it("answers settled false, having written nothing, when the claims change under each of three tries", async () => {
		const birth = await releasedToTaker();
		const before = await readDeployment(birth.scope, TARGET);

		expect(await churned(() => settleReleasedClaims(birth.scope))).toEqual({
			settled: false,
		});

		expect(await readDeployment(birth.scope, TARGET)).toEqual(before);
		expect(before?.active).toEqual([
			expect.objectContaining({
				remoteId: HQ_APP,
				releasedAt: expect.any(String),
			}),
		]);
	}, 15_000);

	it("stops a publish that meets the same before it asks CommCare HQ anything", async () => {
		const birth = await releasedToTaker();
		const before = await readDeployment(birth.scope, TARGET);

		const outcome = await churned(() =>
			publishAppToHq({
				requireHqImport: null,
				scope: birth.scope,
				...TARGET,
				doc: emptyBlueprintDoc(APP),
				compiledAtSeq: 1,
				reloadHead: () => {
					throw new Error("A publish stopped at its settle reads no head.");
				},
				appName: "Clinic visits",
			}),
		);

		expect(outcome).toMatchObject({
			landed: false,
			refusal: {
				phase: "preflight",
				failure: {
					code: "app_changed_while_publishing",
					message: PUBLISH_CLAIMS_CHANGED,
				},
			},
		});
		const after = await readDeployment(birth.scope, TARGET);
		expect(after?.active).toEqual(before?.active);
		expect(after?.deployment).toMatchObject({
			state: before?.deployment.state,
			endings: 0,
		});
	}, 15_000);

	it("is settled by no one who may not edit the app", async () => {
		await born();
		await release();
		const viewer = await member("a-viewer", "viewer");
		await expect(settleReleasedClaims(viewer)).rejects.toMatchObject({
			name: "DeploymentError",
			code: "not_found",
		});
		const row = await h
			.db()
			.selectFrom("app_deployment_resources")
			.select("released_at")
			.executeTakeFirstOrThrow();
		expect(row.released_at).not.toBeNull();
	});

	it("is not checked on: Check status says another app publishes there and writes nothing", async () => {
		const birth = await born();
		await release();
		const before = await readDeployment(birth.scope, TARGET);
		await expect(
			refreshDeployment(birth.scope, TARGET, emptyBlueprintDoc(APP)),
		).rejects.toMatchObject({
			name: "DeploymentError",
			code: "invalid",
			message:
				"Another Nova app publishes to this app's CommCare HQ app in “clinic” now, so Nova has nothing to check there for this one. You can publish there again. Nova updates that app if no other Nova app publishes to it by then, and makes a new one beside it otherwise.",
		});
		expect(await readDeployment(birth.scope, TARGET)).toEqual(before);
	});

	it("discards an observation of a mapping released while CommCare HQ was being asked", async () => {
		const birth = await born();
		const asked = await readDeployment(birth.scope, TARGET);
		const mapping = asked?.active.find((resource) => resource.kind === "app");
		if (mapping === undefined) throw new Error("Expected the live app mapping");
		await release();
		const before = await readDeployment(birth.scope, TARGET);

		const { applied, view } = await applyDeploymentObservation(
			birth.scope,
			TARGET,
			{
				observedRemoteId: mapping.remoteId,
				observedPushToken: mapping.pushToken,
				/* What CommCare HQ says of the app the taker now publishes to. */
				outcomes: [
					["upload", { status: "succeeded", at: "2026-11-12T00:00:00.000Z" }],
					["build", { status: "succeeded", at: "2026-11-12T00:00:00.000Z" }],
				],
				remoteRevision: 57,
			},
		);

		expect(applied).toBe(false);
		expect(view).toEqual(before);
		expect(await readDeployment(birth.scope, TARGET)).toEqual(before);
	});
});

describe("stopPublishingAction", () => {
	async function signedInAs(userId: string) {
		vi.mocked(getSession).mockResolvedValue((await deploymentSession(h.db(), userId)) as never);
	}
	const input = {
		appId: APP,
		server: "production",
		domain: "clinic",
		hqAppId: HQ_APP,
	};

	it("answers an editor not_permitted with who can, a viewer not_found, and an admin the ended record", async () => {
		await born();
		await member("an-editor", "editor");
		await member("a-viewer", "viewer");
		await member("an-admin", "admin");

		await signedInAs("an-editor");
		expect(await stopPublishingAction(input)).toEqual({
			success: false,
			code: "not_permitted",
			message: NOT_PERMITTED,
		});
		await signedInAs("a-viewer");
		expect(await stopPublishingAction(input)).toMatchObject({
			success: false,
			code: "not_found",
		});
		expect(await heldRows()).toBe(5);

		await signedInAs("an-admin");
		const stopped = await stopPublishingAction(input);
		if (!stopped.success) throw new Error(stopped.message);
		expect(stopped.data).toMatchObject({
			view: {
				deployment: { deployment: { state: "ended", endings: 1 } },
				artifact: { server: "production", domain: "clinic", hqAppId: null },
				leftBehind: [],
				kept: null,
				firstPublish: null,
			},
			preview: { projectSpace: null, targetFacts: null },
		});
		if (stopped.data.view === null) throw new Error("Expected the record");
		expect(deploymentEnding(stopped.data.view.deployment)).toMatchObject({
			byName: "an-admin",
			reason: "stopped",
			hqAppId: HQ_APP,
		});

		/* A repeat, as a lost answer's retry sends, answers the same stop. */
		const repeated = await stopPublishingAction(input);
		if (!repeated.success) throw new Error(repeated.message);
		expect(repeated.data.view?.deployment.deployment.endings).toBe(1);

		/* A stop of an HQ app this deployment does not publish to stops
		 * nothing, and says to look again. */
		expect(
			await stopPublishingAction({ ...input, hqAppId: "f".repeat(32) }),
		).toEqual({
			success: false,
			code: "invalid_input",
			message:
				"This app publishes to a different app in “clinic” than the one you were looking at, so Nova didn't stop anything. Have another look, and stop it from there if you still want to.",
		});
		/* A request that names no HQ app is no stop. */
		expect(
			await stopPublishingAction({
				appId: APP,
				server: "production",
				domain: "clinic",
			}),
		).toMatchObject({ success: false, code: "invalid_input" });
	});

	/* With the app live on two project spaces Preview names neither. Stopping
	 * one leaves the other to name, with its settings: the answer carries both,
	 * read after the ending as the stream's deployment lane reads them, so the
	 * tab ends on the same values whichever of the two arrives last. An answer
	 * that named the space and left the settings out would wipe the settings
	 * the stream had just delivered, and the stream sends them only once. */
	it("answers what Preview names and plays now, the remaining project space's settings with it", async () => {
		const birth = await born();
		const beta = { server: "production" as const, domain: "beta" };
		const read = normalizeHqAppSource({
			doc_type: "Application",
			name: "Clinic visits",
			langs: ["en"],
			translations: { en: { en: "English" } },
			profile: { properties: { "cc-fuzzy-search-enabled": "yes" } },
			modules: [],
			_attachments: {},
		});
		if ("malformed" in read) throw new Error(read.malformed);
		await foldDeploymentAttempt(
			birth.scope,
			beta,
			"preflight",
			{ status: "succeeded", at: "2026-11-11T00:00:00.000Z" },
			{ ensure: true, expectedEndings: 0 },
		);
		await recordRemoteResource(birth.scope, beta, {
			expectedEndings: 0,
			kind: "app",
			novaResourceId: APP,
			remoteId: "b".repeat(32),
			ownership: "nova-created",
			adoptedBy: null,
			pushedRevision: 1,
			uploadedAt: "2026-11-11T00:00:00.000Z",
			remoteRevision: null,
			baseline: {
				origin: "push",
				remoteAppId: "b".repeat(32),
				sourceGzip: gzipSync(Buffer.from(read.text, "utf8")),
				sourceBytes: read.bytes,
				sourceDigest: read.digest,
				ownership: {
					addOns: [],
					profileProperties: [],
					profileCustomProperties: [],
					autoGpsCapture: false,
				},
				observedAt: "2026-11-11T00:00:00.000Z",
				discard: null,
				novaRevision: null,
				mediaFiles: { kind: "set", files: null },
				firstPublish: { kind: "set", list: null },
			},
		});
		expect(await readPreviewDeploymentAnswer(birth.scope)).toEqual({
			projectSpace: null,
			targetFacts: null,
		});

		await signedInAs(OWNER);
		const stopped = await stopPublishingAction(input);
		if (!stopped.success) throw new Error(stopped.message);

		const now = {
			projectSpace: "beta",
			targetFacts: { fuzzyListSearch: true, markRequiredQuestions: false },
		};
		expect(stopped.data.preview).toEqual(now);
		expect(await readPreviewDeploymentAnswer(birth.scope)).toEqual(now);
	});

	/* The ending commits before anything the answer shows is read. A fault
	 * reading it then must not answer "nothing was changed": the person would
	 * stop again and be told there is nothing to stop. */
	it("answers a stop whose reads after the ending fault as stopped, with no record", async () => {
		const birth = await born();
		const faulting: KyselyPlugin = {
			transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
				if (JSON.stringify(args.node).includes('"app_deployment_baselines"')) {
					throw Object.assign(new Error("terminating connection"), {
						code: "57P01",
					});
				}
				return args.node;
			},
			async transformResult(
				args: PluginTransformResultArgs,
			): Promise<QueryResult<UnknownRow>> {
				return args.result;
			},
		};
		await signedInAs(OWNER);
		__setAppDbForTests(h.db().withPlugin(faulting));
		let stopped: Awaited<ReturnType<typeof stopPublishingAction>>;
		try {
			stopped = await stopPublishingAction(input);
		} finally {
			__setAppDbForTests(h.db());
		}

		expect(stopped).toEqual({
			success: true,
			data: { view: null, preview: { projectSpace: null, targetFacts: null } },
		});
		const read = await readDeployment(birth.scope, TARGET);
		if (read === null) throw new Error("Expected the deployment");
		expect(read.deployment.state).toBe("ended");
		/* The retry the person makes answers the stop that landed. */
		expect(await stopPublishingAction(input)).toMatchObject({
			success: true,
		});
		expect(
			(await readDeployment(birth.scope, TARGET))?.deployment.endings,
		).toBe(1);
	});
});

describe("readers of an ended deployment", () => {
	it("Check status says publishing stopped there instead of checking", async () => {
		const birth = await born();
		await endDeployment(birth.scope, TARGET, HQ_APP);
		await expect(
			refreshDeployment(birth.scope, TARGET, emptyBlueprintDoc(APP)),
		).rejects.toMatchObject({
			name: "DeploymentError",
			code: "invalid",
			message:
				"Nova stopped publishing this app to “clinic”, so there's nothing there for it to check on. Publishing there again makes a new app.",
		});
	});

	/* The stop's own copy invites both steps: a teammate brings the HQ app in
	 * as a new Nova app, and this app publishes there again, which records a
	 * new HQ app and ends the ending. The stopped HQ app is then the other
	 * app's live one, and no surface may tell anyone to remove it. */
	it("never names as left behind a stopped HQ app another Nova app brought in, until that app stops too", async () => {
		const birth = await born();
		await endDeployment(birth.scope, TARGET, HQ_APP);
		const taker = await birthAdoptedApp(h, {
			appId: testUuid("bringer-app"),
			projectId: PROJECT,
			actorUserId: OWNER,
			target: TARGET,
			remoteAppId: HQ_APP,
		});
		/* The card of the stopped deployment learns the HQ app is another's
		 * now, so it names no way back to it. */
		const stoppedThere = await readDeployment(birth.scope, TARGET);
		if (stoppedThere === null) throw new Error("Expected the deployment");
		expect(deploymentEnding(stoppedThere)).toMatchObject({
			hqAppId: HQ_APP,
			reason: "stopped",
			heldByAnotherApp: true,
		});
		await foldDeploymentAttempt(
			birth.scope,
			TARGET,
			"preflight",
			{ status: "succeeded", at: "2026-11-12T00:00:00.000Z" },
			{ expectedEndings: 1 },
		);
		const NEW_APP = "e".repeat(32);
		const republished = await recordCreatedRemoteApp(birth.scope, TARGET, {
			expectedEndings: 1,
			remoteId: NEW_APP,
			baseline: unreadBaseline(NEW_APP),
		}).then(readable);
		expect(deploymentEnding(republished)).toBeNull();
		expect(republished.superseded).toEqual([
			expect.objectContaining({
				remoteId: HQ_APP,
				endedReason: "stopped",
				heldByAnotherApp: true,
			}),
		]);
		expect(leftBehindResources(republished, new Map())).toEqual([]);
		const read = await readDeployment(birth.scope, TARGET);
		if (read === null) throw new Error("Expected the deployment");
		expect(leftBehindResources(read, null)).toEqual([]);

		/* Once no Nova app publishes to it, it is left behind here. */
		await endDeployment(taker.scope, TARGET, HQ_APP);
		const freed = await readDeployment(birth.scope, TARGET);
		if (freed === null) throw new Error("Expected the deployment");
		expect(leftBehindResources(freed, new Map())).toEqual([
			expect.objectContaining({
				remoteId: HQ_APP,
				endedReason: "stopped",
				heldByAnotherApp: false,
			}),
		]);
	});
});
