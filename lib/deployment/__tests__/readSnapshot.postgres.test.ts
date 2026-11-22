/**
 * The one authorized read snapshot every deployment read runs in, and the one
 * authorization it shares with every deployment write, over real Postgres.
 *
 * Contract: `withDeploymentReadSnapshot` answers from one moment, for a caller
 * who at that moment is a member of the app's Project with the capability the
 * read needs, and otherwise is the existing not-found. An app in recently
 * deleted is `DeploymentAppDeletedError` for such a member, and the plain
 * not-found for anyone else. A deployment's record,
 * its ledger (mappings, confirmations, who stopped publishing) and its names
 * read in it are one generation, whatever commits on another connection while
 * it reads.
 *
 * Plausible failures: a ledger loaded by a deployment id in a statement of its
 * own, after a move or a stop committed, so a record of one moment carries an
 * ending, a mapping or a person's name written at another (across a Project
 * move, a member of the Project the app moved to); a read authorized from a
 * scope resolved before the move, never checked again; a deletion told to a
 * caller who is no longer a member. A write (a confirmation withdrawn, a stop,
 * an admission of a write to CommCare HQ, the settle a publish starts with)
 * on an app deleted before its lock answers its member the plain not-found,
 * or tells a caller who may not write it that the app was deleted.
 */
import { afterEach, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { softDeleteApp } from "@/lib/db/apps";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { resolveDownloadTarget } from "../downloadTarget";
import {
	APP_DELETED_READ,
	APP_DELETED_WRITE,
	DeploymentAppDeletedError,
} from "../errors";
import {
	admitAppWrite,
	type DeploymentScope,
	endDeployment,
	readDeployment,
	readDeploymentsForApp,
	settleReleasedClaims,
	withDeploymentReadSnapshot,
	withdrawDeploymentConfirmation,
} from "../store";
import {
	appMappingToken,
	birthAdoptedApp,
	CONFIRMATIONS,
} from "./adoptedBirth";

vi.mock("@/lib/auth-utils", () => ({ getSession: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const h = setupAppStateTestDb("deployment_read_snapshot_", {
	authSchema: "migrated",
	poolMax: 4,
});

const OWNER = "snapshot-owner";
const PROJECT = "project-snapshot";
const TARGET = { server: "production" as const, domain: "clinic" };
const HQ_APP = "e".repeat(32);
const APP = testUuid("snapshot-app");

async function born() {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	return birthAdoptedApp(h, {
		appId: APP,
		projectId: PROJECT,
		actorUserId: OWNER,
		target: TARGET,
		remoteAppId: HQ_APP,
	});
}

it("answers a deployment and its ledger as they stood when it began, though a stop commits while it reads", async () => {
	const birth = await born();
	const seen = await withDeploymentReadSnapshot(
		birth.scope,
		"view",
		async (snapshot) => {
			/* The stop commits on another connection after the snapshot authorized. */
			await endDeployment(birth.scope, TARGET, HQ_APP);
			return {
				one: await readDeployment(snapshot, TARGET),
				all: await readDeploymentsForApp(snapshot),
			};
		},
	);
	for (const view of [seen.one, seen.all[0]]) {
		expect(view?.deployment.state).not.toBe("ended");
		expect(
			view?.active.filter((resource) => resource.kind === "app"),
		).toHaveLength(1);
		expect(
			view?.superseded.some((resource) => resource.endedReason !== null),
		).toBe(false);
	}
	/* A read that begins after it sees the ending. */
	const after = await readDeployment(birth.scope, TARGET);
	expect(
		after?.superseded.some((resource) => resource.endedByName !== null),
	).toBe(true);
});

it("refuses a scope whose Project the app is no longer in, and a caller no longer a member", async () => {
	const birth = await born();
	await expect(
		readDeploymentsForApp({ ...birth.scope, projectId: "project-elsewhere" }),
	).rejects.toMatchObject({ code: "not_found" });
	await expect(
		resolveDownloadTarget(
			{ ...birth.scope, projectId: "project-elsewhere" },
			{ format: "json", doc: emptyBlueprintDoc(APP) },
		),
	).rejects.toMatchObject({ code: "not_found" });
	await h.pool().query(`DELETE FROM auth_member WHERE "userId" = $1`, [OWNER]);
	await expect(readDeployment(birth.scope, TARGET)).rejects.toMatchObject({
		code: "not_found",
	});
});

it("tells a member the app was deleted, and anyone else only that nothing is found", async () => {
	const birth = await born();
	await softDeleteApp(APP, OWNER);
	const deleted = readDeployment(birth.scope, TARGET);
	await expect(deleted).rejects.toBeInstanceOf(DeploymentAppDeletedError);
	await expect(deleted).rejects.toMatchObject({
		code: "not_found",
		message: APP_DELETED_READ,
	});
	const elsewhere = readDeploymentsForApp({
		...birth.scope,
		projectId: "project-elsewhere",
	});
	await expect(elsewhere).rejects.toMatchObject({ code: "not_found" });
	await expect(elsewhere).rejects.not.toBeInstanceOf(DeploymentAppDeletedError);
	await h.pool().query(`DELETE FROM auth_member WHERE "userId" = $1`, [OWNER]);
	const removed = readDeployment(birth.scope, TARGET);
	await expect(removed).rejects.toMatchObject({ code: "not_found" });
	await expect(removed).rejects.not.toBeInstanceOf(DeploymentAppDeletedError);
});

/* Every write takes the app row through the authorization the snapshot makes,
 * so each answers a deletion that committed before its lock as a read does,
 * in a write's words. */
const WRITES: Record<
	string,
	(scope: DeploymentScope, token: string) => Promise<unknown>
> = {
	"a confirmation withdrawn": (scope) =>
		withdrawDeploymentConfirmation(
			scope,
			TARGET,
			CONFIRMATIONS[0] ?? fail("Expected a confirmation"),
		),
	"a stop": (scope) => endDeployment(scope, TARGET, HQ_APP),
	"an import admitted": (scope, token) =>
		admitAppWrite(scope, TARGET, {
			observedPushToken: token,
			expectedEndings: 0,
			remoteAppId: HQ_APP,
			writeKind: "import",
			compiledAtSeq: 1,
		}),
	"the settle a publish starts with": (scope) => settleReleasedClaims(scope),
};

function fail(message: string): never {
	throw new Error(message);
}

async function writesState() {
	return {
		deployments: await h
			.db()
			.selectFrom("app_deployments")
			.selectAll()
			.execute(),
		confirmations: await h
			.db()
			.selectFrom("app_deployment_confirmations")
			.selectAll()
			.execute(),
		resources: await h
			.db()
			.selectFrom("app_deployment_resources")
			.selectAll()
			.execute(),
		writes: await h.db().selectFrom("hq_remote_writes").selectAll().execute(),
	};
}

it.each(Object.keys(WRITES))(
	"tells a member who may make %s that the app was deleted, writing nothing, and tells nobody else",
	async (write) => {
		const writeAs = WRITES[write] ?? fail(`No write named ${write}`);
		const birth = await born();
		const run = (scope: DeploymentScope) =>
			writeAs(scope, appMappingToken(birth.deployment));
		await softDeleteApp(APP, OWNER);
		const before = await writesState();

		const deleted = run(birth.scope);
		await expect(deleted).rejects.toBeInstanceOf(DeploymentAppDeletedError);
		await expect(deleted).rejects.toMatchObject({
			code: "not_found",
			message: APP_DELETED_WRITE,
		});

		/* Another Project's scope, a member made a viewer, a member removed. */
		const elsewhere = run({ ...birth.scope, projectId: "project-elsewhere" });
		await expect(elsewhere).rejects.toMatchObject({ code: "not_found" });
		await expect(elsewhere).rejects.not.toBeInstanceOf(
			DeploymentAppDeletedError,
		);
		await h.seedProjectMember(OWNER, PROJECT, "viewer");
		const demoted = run(birth.scope);
		await expect(demoted).rejects.toMatchObject({ code: "not_found" });
		await expect(demoted).rejects.not.toBeInstanceOf(DeploymentAppDeletedError);
		await h
			.pool()
			.query(`DELETE FROM auth_member WHERE "userId" = $1`, [OWNER]);
		const removed = run(birth.scope);
		await expect(removed).rejects.toMatchObject({ code: "not_found" });
		await expect(removed).rejects.not.toBeInstanceOf(DeploymentAppDeletedError);
		expect(await writesState()).toEqual(before);
	},
);

it("tells an editor who may not stop publishing that the app was deleted, as the write a stop is", async () => {
	const birth = await born();
	await h.seedProjectMember("snapshot-editor", PROJECT, "editor");
	await softDeleteApp(APP, OWNER);
	await expect(
		endDeployment(
			{ ...birth.scope, actorUserId: "snapshot-editor", role: "editor" },
			TARGET,
			HQ_APP,
		),
	).rejects.toMatchObject({ code: "not_found", message: APP_DELETED_WRITE });
});
