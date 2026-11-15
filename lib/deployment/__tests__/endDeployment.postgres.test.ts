/**
 * Ending a deployment, in real Postgres: who may stop publishing to a project
 * space, what the ending writes and keeps, the fence it raises against a
 * publish that read the deployment before it, and how a released claim is
 * settled.
 */

import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { getSession } from "@/lib/auth-utils";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { claimHqAppInTransaction } from "@/lib/db/hqAppClaims";
import { withAppTx } from "@/lib/db/pg";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { stopPublishingAction } from "../actions";
import { DeploymentEndedError } from "../errors";
import { previewProjectSpaceFor } from "../previewSpace";
import { deploymentEnding, nextPublishAction } from "../resources";
import { refreshDeployment } from "../service";
import {
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
import { type AdoptedBirth, birthAdoptedApp } from "./adoptedBirth";

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

async function heldRows(): Promise<number> {
	const db = h.db();
	const counts = await Promise.all(
		(
			[
				"app_deployment_identities",
				"app_deployment_media_paths",
				"app_deployment_keyed_case_ids",
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

		await expect(endDeployment(editor, TARGET)).rejects.toMatchObject({
			name: "DeploymentError",
			code: "not_permitted",
			message: NOT_PERMITTED,
		});
		await expect(endDeployment(viewer, TARGET)).rejects.toMatchObject({
			name: "DeploymentError",
			code: "not_found",
		});
		expect(await readDeployment(editor, TARGET)).toEqual(before);
		expect(await heldRows()).toBe(4);
	});

	async function stopsAs(role: "admin" | "owner"): Promise<void> {
		await born();
		const stopper = await member(`a-${role}`, role);
		expect(await previewProjectSpaceFor(stopper)).toBe("clinic");

		const view = await endDeployment(stopper, TARGET);

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
				server: "production",
				domain: "clinic",
				remoteAppIds: [HQ_APP],
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

	it("answers a second stop that there is nothing to stop, and a target with no deployment that there is none", async () => {
		const birth = await born();
		await endDeployment(birth.scope, TARGET);
		await expect(endDeployment(birth.scope, TARGET)).rejects.toMatchObject({
			name: "DeploymentError",
			code: "invalid",
			message:
				"Nova isn't publishing this app to “clinic”, so there's nothing to stop.",
		});
		await expect(
			endDeployment(birth.scope, { server: "india", domain: "clinic" }),
		).rejects.toMatchObject({ name: "DeploymentError", code: "not_found" });
		const view = await readDeployment(birth.scope, TARGET);
		expect(view?.deployment.endings).toBe(1);
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
		await endDeployment(scope, TARGET);
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
		await endDeployment(birth.scope, TARGET);
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
		});

		expect(await previewProjectSpaceFor(birth.scope)).toBe("clinic");
		const view = await readDeployment(birth.scope, TARGET);
		expect(view?.active).toEqual([
			expect.objectContaining({ remoteId: HQ_APP, releasedAt: null }),
		]);
		expect(await heldRows()).toBe(4);
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
		});
		const view = await readDeployment(birth.scope, TARGET);
		expect(view?.deployment).toMatchObject({ state: "ended", endings: 1 });
		expect(view === null ? null : deploymentEnding(view)).toMatchObject({
			reason: "claimed-elsewhere",
			byName: OWNER,
			hqAppId: HQ_APP,
		});
	});

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
});

describe("stopPublishingAction", () => {
	function signedInAs(userId: string): void {
		vi.mocked(getSession).mockResolvedValue({ user: { id: userId } } as never);
	}
	const input = { appId: APP, server: "production", domain: "clinic" };

	it("answers an editor not_permitted with who can, a viewer not_found, and an admin the ended record", async () => {
		await born();
		await member("an-editor", "editor");
		await member("a-viewer", "viewer");
		await member("an-admin", "admin");

		signedInAs("an-editor");
		expect(await stopPublishingAction(input)).toEqual({
			success: false,
			code: "not_permitted",
			message: NOT_PERMITTED,
		});
		signedInAs("a-viewer");
		expect(await stopPublishingAction(input)).toMatchObject({
			success: false,
			code: "not_found",
		});
		expect(await heldRows()).toBe(4);

		signedInAs("an-admin");
		const stopped = await stopPublishingAction(input);
		if (!stopped.success) throw new Error(stopped.message);
		expect(stopped.data).toMatchObject({
			deployment: { deployment: { state: "ended", endings: 1 } },
			artifact: { server: "production", domain: "clinic", hqAppId: null },
			leftBehind: [],
			kept: null,
			previewProjectSpace: null,
		});
		expect(deploymentEnding(stopped.data.deployment)).toMatchObject({
			byName: "an-admin",
			reason: "stopped",
			hqAppId: HQ_APP,
		});

		expect(await stopPublishingAction(input)).toEqual({
			success: false,
			code: "invalid_input",
			message:
				"Nova isn't publishing this app to “clinic”, so there's nothing to stop.",
		});
	});
});

describe("readers of an ended deployment", () => {
	it("Check status says publishing stopped there instead of checking", async () => {
		const birth = await born();
		await endDeployment(birth.scope, TARGET);
		await expect(
			refreshDeployment(birth.scope, TARGET, emptyBlueprintDoc(APP)),
		).rejects.toMatchObject({
			name: "DeploymentError",
			code: "invalid",
			message:
				"Nova stopped publishing this app to “clinic”, so there's nothing there for it to check on. Publishing there again makes a new app.",
		});
	});
});
