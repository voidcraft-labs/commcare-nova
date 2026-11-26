import {readBuildProfiles} from "@/lib/commcare/hq/appSource";
import { createHash as installationDigest } from "node:crypto";
import * as installationMigration from "@/lib/case-store/migrations/20261203040000_hq_installation_profiles";
import { scanInstallationProfileBaselines } from "@/scripts/lib/installationProfileBaselines";
import { admitAppWrite,settleRemoteWrites,readInstallationReview, writeInstallationReview, writeTargetIdentityInTransaction } from "../store";
/**
 * The adopted ledger in real Postgres: what one birth from CommCare HQ
 * records, in the transaction that births the app, and what every reader
 * makes of it. Also the picker's read of which HQ apps a Nova app already
 * publishes to (`readHqAppClaims`), which reads the claims these births take.
 */

import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { seenByHq } from "@/lib/commcare/hq/appsSeen";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { restoreApp, softDeleteApp } from "@/lib/db/apps";
import { HqAppAlreadyClaimedError } from "@/lib/db/hqAppClaims";
import { previewProjectSpaceFor } from "../previewSpace";
import { nextPublishAction, publishedRemoteApp } from "../resources";
import { deploymentIsObservable } from "../stateMachine";
import {
	foldDeploymentAttempt,
	readAppBaseline,
	readDeployment,readDeploymentsForApp,
	readHqAppClaims,
	readReachedDeploymentTargets,
	readTargetIdentity,
	recordRefreshedAppBaseline,
	recordRemoteResource,
} from "../store";
import { EMPTY_TARGET_IDENTITY } from "../targetIdentity";
import {
	BIRTH_AT,
	birthAdoptedApp,
	HELD_COLUMN,
	HELD_PATH,
	MEDIA_FILES,
	OWNERSHIP,
	READ_AT,
	SOURCE,
} from "./adoptedBirth";

const h = setupAppStateTestDb("adopted_ledger_", {
	authSchema: "migrated",
	poolMax: 4,
});

const ACTOR = "bringer";
const PROJECT = "project-clinic";
const TARGET = { server: "production" as const, domain: "clinic" };
const HQ_APP = "c".repeat(32);
const APP = testUuid("adopted-app");

async function born(
	options: Partial<Parameters<typeof birthAdoptedApp>[1]> = {},
) {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	return birthAdoptedApp(h, {
		appId: APP,
		projectId: PROJECT,
		actorUserId: ACTOR,
		target: TARGET,
		remoteAppId: HQ_APP,
		...options,
	});
}

async function installationClaim(scope: Parameters<typeof readDeployment>[0]) {
	const record = await readDeployment(scope, TARGET);
	const active = record?.active.find((r) => r.kind === "app");
	if (!active || !record) throw new Error("Missing adopted mapping");
	return { mapping: active.pushToken, endings: record.deployment.endings };
}

async function count(
	table:
		| "app_deployments"
		| "app_deployment_resources"
		| "app_deployment_baselines"
		| "app_deployment_identities"
		| "app_deployment_media_paths"
		| "app_deployment_keyed_case_ids"
		| "app_deployment_column_field_words"
		| "app_deployment_confirmations",
): Promise<number> {
	const row = await h
		.db()
		.selectFrom(table)
		.select((eb) => eb.fn.countAll<string>().as("n"))
		.executeTakeFirstOrThrow();
	return Number(row.n);
}

describe("recordAdoptedDeploymentInTransaction", () => {
	it("records every column of an adopted deployment in the transaction that births its app", async () => {
		const birth = await born();
		const db = h.db();

		const deployment = await db
			.selectFrom("app_deployments")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(deployment).toMatchObject({
			app_id: APP,
			project_id: PROJECT,
			server: "production",
			domain: "clinic",
			state: "uploaded",
			resume_phase: null,
			phases: {
				preflight: null,
				resources: null,
				upload: null,
				build: null,
				release: null,
				probe: null,
			},
			created_by: ACTOR,
			last_observed_at: null,
			content_generation: null,
			entry_point_manifest: null,
			entry_point_observation: null,
			offered_logo_content_hash: null,
			target_empty_case_list_text: null,
			endings: 0,
		});

		const mapping = await db
			.selectFrom("app_deployment_resources")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(mapping).toMatchObject({
			deployment_id: deployment.id,
			kind: "app",
			nova_resource_id: APP,
			remote_id: HQ_APP,
			ownership: "adopted",
			adopted_at: BIRTH_AT,
			adopted_by: ACTOR,
			pushed_identity: null,
			pushed_at: BIRTH_AT,
			remote_observed_at: BIRTH_AT,
			superseded_at: null,
			remote_missing_at: null,
			released_at: null,
			ended_by: null,
			ended_reason: null,
			server: "production",
			domain: "clinic",
		});
		expect(Number(mapping.pushed_revision)).toBe(1);
		expect(Number(mapping.remote_revision)).toBe(41);
		expect(mapping.push_token).toMatch(/^[0-9a-f-]{36}$/);

		const baseline = await db
			.selectFrom("app_deployment_baselines")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(baseline).toMatchObject({
			deployment_id: deployment.id,
			remote_app_id: HQ_APP,
			origin: "read",
			ownership: OWNERSHIP,
			observed_at: new Date(READ_AT),
			observed_by: ACTOR,
			discarded_digest: null,
			discarded_by: null,
			discarded_at: null,
			media_files: MEDIA_FILES,
			first_publish_changes: {
				ids: ["forms-and-settings-rewritten"],
				webAppsOnInHq: true,
				of: "first-publish",
			},
		});
		expect(Number(baseline.nova_revision)).toBe(1);

		expect(
			await db
				.selectFrom("app_deployment_identities")
				.select(["entity_kind", "nova_entity_uuid", "unique_id", "xmlns"])
				.orderBy("entity_kind")
				.execute(),
		).toEqual([
			{
				entity_kind: "form",
				nova_entity_uuid: birth.formUuid,
				unique_id: "b".repeat(32),
				xmlns:
					"http://openrosa.org/formdesigner/5A2C1F0E-0000-4000-8000-000000000001",
			},
			{
				entity_kind: "module",
				nova_entity_uuid: birth.moduleUuid,
				unique_id: "a".repeat(32),
				xmlns: null,
			},
		]);
		expect(
			await db
				.selectFrom("app_deployment_media_paths")
				.select(["media_asset_id", "wire_path"])
				.execute(),
		).toEqual([{ media_asset_id: birth.assetId, wire_path: HELD_PATH }]);
		expect(
			await db
				.selectFrom("app_deployment_keyed_case_ids")
				.select(["nova_operation_uuid", "case_type", "case_id_prefix"])
				.execute(),
		).toEqual([
			{
				nova_operation_uuid: birth.operationUuid,
				case_type: "patient",
				case_id_prefix: birth.prefix,
			},
		]);
		expect(
			await db
				.selectFrom("app_deployment_confirmations")
				.select(["kind", "subject", "confirmed_by", "withdrawn_at"])
				.execute(),
		).toEqual([
			{
				kind: "plan-feature",
				subject: "web-apps",
				confirmed_by: ACTOR,
				withdrawn_at: null,
			},
		]);
	});

	it("is a published, reached and observable target from its first minute", async () => {
		const birth = await born();
		const view = await readDeployment(birth.scope, TARGET);
		if (view === null) throw new Error("Expected the adopted deployment");
		expect(birth.deployment).toEqual(view);
		expect(publishedRemoteApp(view)).toMatchObject({
			remoteId: HQ_APP,
			ownership: "adopted",
			adoptedBy: ACTOR,
			adoptedByName: ACTOR,
			pushedRevision: 1,
			remoteRevision: 41,
			releasedAt: null,
			endedReason: null,
			endedByName: null,
		});
		expect(nextPublishAction(view)).toBe("updates");
		expect(deploymentIsObservable(view.deployment)).toBe(true);
		expect(view.confirmations).toEqual([
			expect.objectContaining({
				kind: "plan-feature",
				subject: "web-apps",
				confirmedByName: ACTOR,
			}),
		]);
		expect(await readReachedDeploymentTargets(birth.scope)).toEqual([
			{
				server: "production",
				domain: "clinic",
				hqAppId: HQ_APP,
				emptyCaseListText: false,
				earlierHqApps: 0,
				adopted: true,
			},
		]);
		expect(await previewProjectSpaceFor(birth.scope)).toBe("clinic");
		expect(await readTargetIdentity(birth.scope, TARGET)).toEqual({
			entities: [
				{
					entityKind: "form",
					novaEntityUuid: birth.formUuid,
					uniqueId: "b".repeat(32),
					xmlns:
						"http://openrosa.org/formdesigner/5A2C1F0E-0000-4000-8000-000000000001",
				},
				{
					entityKind: "module",
					novaEntityUuid: birth.moduleUuid,
					uniqueId: "a".repeat(32),
					xmlns: null,
				},
			],
			keyedCaseIds: [
				{
					operationUuid: birth.operationUuid,
					caseType: "patient",
					prefix: birth.prefix,
				},
			],
			mediaPaths: [{ assetId: birth.assetId, wirePath: HELD_PATH }],
			columnWords: [
				{ columnUuid: HELD_COLUMN, screen: "short", word: "case_name" },
			],
		});
		const elsewhere = { server: "india" as const, domain: "clinic" };
		expect(await readTargetIdentity(birth.scope, elsewhere)).toEqual(
			EMPTY_TARGET_IDENTITY,
		);
	});

	it("reads the read baseline back with its ownership, revision, media record and size", async () => {
		const birth = await born();
		expect(await readAppBaseline(birth.scope, TARGET)).toEqual({
			origin: "read",
			remoteAppId: HQ_APP,
			observedAt: READ_AT,
			observedBy: ACTOR,
			novaRevision: 1,
			mediaFiles: MEDIA_FILES,
			source: SOURCE,
			sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			ownership: OWNERSHIP,
			sourceBytes: Buffer.byteLength(JSON.stringify(SOURCE), "utf8"),
		});
	});

	it("keeps installation choices off the shared phase and hides details in previously saved rows from a second member",async ()=>{
 const birth=await born();
 const viewer="review-viewer";
 await h.seedProjectMember(viewer,PROJECT,"viewer");
 const scope={...birth.scope,actorUserId:viewer,role:"viewer"};
 const detailed={code:"hq_installation_profile_review" as const,message:"Review private training worker",details:["physical-slot","practice-private"],installationProfileChoices:[{label:"worker-private",confirmation:"c".repeat(64)}],installationProfileConfirmation:"d".repeat(64)};
 const failure={status:"failed" as const,at:new Date().toISOString(),failure:detailed};
 // A new, incomplete target holds a preflight but no completed upload.
 const target={...TARGET,domain:"new-target"};
 await foldDeploymentAttempt(birth.scope,target,"preflight",{status:"succeeded",at:failure.at},{ensure:true,expectedEndings:0});
 await foldDeploymentAttempt(birth.scope,target,"resources",failure,{expectedEndings:0});
 const stored=await h.db().selectFrom("app_deployments").select(["id","phases"]).where("domain","=",target.domain).executeTakeFirstOrThrow();
 expect(JSON.stringify(stored.phases)).not.toContain("private");
 const list=()=>readDeploymentsForApp(scope);
 const visible=(await list()).find(r=>r.deployment.domain===target.domain);
 expect(visible?.deployment.phases.resources).toMatchObject({status:"failed",failure:{code:"hq_installation_profile_review",details:[]}});
 expect(JSON.stringify(visible)).not.toContain("private");
 await sql`UPDATE app_deployments SET phases=jsonb_set(phases,'{resources}',${JSON.stringify(failure)}::jsonb) WHERE id=${stored.id}`.execute(h.db());
 expect(JSON.stringify(await list())).not.toContain("private");
 });
 it("keeps long HQ keys, hash peers and more than one statement of profile bindings in one transaction", async () => {
 const birth=await born();
 const original=await readTargetIdentity(birth.scope,TARGET);
 const db=h.db();
 const deployment=await db.selectFrom("app_deployments").select("id").where("app_id","=",APP).executeTakeFirstOrThrow();
 const longKey=Array.from({length:200},(_,i)=>installationDigest("sha256").update(String(i)).digest("hex")).join("");
 // Ask this PostgreSQL version for two different, legitimate identifiers
 // whose index hash compares equal. Both full keys must survive the recheck.
 const pair=(await sql<{a:string;b:string}>`WITH candidates AS (
 SELECT 'site-' || i AS k FROM generate_series(1,250000) AS n(i)
 ) SELECT min(k) AS a,max(k) AS b FROM candidates GROUP BY hashtext(k) HAVING count(*)>1 LIMIT 1`.execute(db)).rows[0];
 expect(pair).toBeDefined();
 const keys=[longKey,pair.a,pair.b,...Array.from({length:13_105},(_,i)=>`region-${i}`)];
 const read=readBuildProfiles(Object.fromEntries(keys.map(id=>[id,{name:"Team",langs:["en"]}])),new Set(["en"]),1);
 expect(read?.length).toBe(keys.length);
 const bindings=(read??[]).map(({id},i)=>({uuid:testUuid(`kept-installation-${i}`),key:id}));
 const write=(prior:typeof original,rows:typeof bindings)=>db.transaction().execute(async tx=>{
  await tx.selectFrom("app_deployments").select("id").where("id","=",deployment.id).forUpdate().executeTakeFirstOrThrow();
  await writeTargetIdentityInTransaction(tx,deployment.id,{appId:APP,server:TARGET.server},{read:prior,next:{...prior,installationProfiles:rows}});
 });
 await write(original,bindings);
 const stored=await readTargetIdentity(birth.scope,TARGET);
 expect(new Map(stored.installationProfiles?.map(({uuid,key})=>[uuid,key]))).toEqual(new Map(bindings.map(({uuid,key})=>[uuid,key])));
 // A duplicate in a later batch rolls back all earlier additions/removals.
 const replacements=Array.from({length:1010},(_,i)=>({uuid:testUuid(`changed-installation-${i}`),key:i===1009 ? "second-key-0":`second-key-${i}`}));
 await expect(write(stored,replacements)).rejects.toMatchObject({code:"23P01"});
 expect(await readTargetIdentity(birth.scope,TARGET)).toEqual(stored);
},60_000);

 it("fences a signed installation receipt and binding under the current baseline, app revision and mapping generation", async () => {
		const birth = await born();
		const base = await readAppBaseline(birth.scope, TARGET);
		if (!base || base.origin === "unread")
			throw new Error("Expected an observed baseline.");
		const record = await readTargetIdentity(birth.scope, TARGET);
		const mapping = await h
			.db()
			.selectFrom("app_deployment_resources")
			.select("push_token")
			.where("kind", "=", "app")
			.executeTakeFirstOrThrow();
		const seq = Number((await h.readAppRow(APP))?.mutation_seq);
		const next = {
			...record,
			installationProfiles: [
				{
					uuid: testUuid("training-receipt"),
					key: "visits",
					practiceWorkerId: "changed-worker",
				},
			],
		};
		const digest = "7".repeat(64);
		const write = (
			headSeq: number,
			token: string,
			comparedDigest = base.sourceDigest,
		) =>
			recordRefreshedAppBaseline(birth.scope, TARGET, {
				expectedEndings: 0,
				remoteAppId: HQ_APP,
				comparedDigest,
				read: {
					sourceGzip: gzipSync(JSON.stringify(SOURCE)),
					sourceBytes: Buffer.byteLength(JSON.stringify(SOURCE)),
					sourceDigest: base.sourceDigest,
					observedAt: "2026-11-12T00:00:00.000Z",
				},
				targetIdentity: { read: record, next },
				installationReview: { digest, headSeq, mapping: token },
			});
		for (const [head, token, source] of [
			[seq + 1, mapping.push_token, base.sourceDigest],
			[seq, "stale-generation", base.sourceDigest],
			[seq, mapping.push_token, "3".repeat(64)],
		] as const) {
			expect((await write(head, token, source)).outcome).toBe("superseded");
			expect(await readTargetIdentity(birth.scope, TARGET)).toEqual(record);
			expect(
				(
					await h
						.db()
						.selectFrom("app_deployment_baselines")
						.select("installation_review")
						.executeTakeFirstOrThrow()
				).installation_review,
			).toBeNull();
		}
		expect((await write(seq, mapping.push_token)).outcome).toBe("current");
		expect(
			(
				await h
					.db()
					.selectFrom("app_deployment_baselines")
					.select("installation_review")
					.executeTakeFirstOrThrow()
			).installation_review,
		).toMatchObject({
			digest,
			actor: ACTOR,
			remoteAppId: HQ_APP,
			headSeq: seq,
			mapping: mapping.push_token,
		});
		expect(
			(await readTargetIdentity(birth.scope, TARGET)).installationProfiles,
		).toEqual(next.installationProfiles);
	});

	it("keeps the revision, the media record and the list through an upsert that names none of them", async () => {
		await born();
		const db = h.db();
		const before = await db
			.selectFrom("app_deployment_baselines")
			.select(["deployment_id", "nova_revision", "media_files"])
			.select("first_publish_changes")
			.executeTakeFirstOrThrow();
		/* The upsert the revision before these columns runs, which names none
		 * of the three. */
		const text = JSON.stringify({ name: "Clinic visits, read again" });
		await sql`
			INSERT INTO app_deployment_baselines AS existing (
				deployment_id, remote_app_id, origin, source_gzip, source_bytes,
				source_digest, ownership, observed_at, observed_by,
				discarded_digest, discarded_by, discarded_at
			) VALUES (
				${before.deployment_id}, ${HQ_APP}, 'read',
				${gzipSync(Buffer.from(text))}, ${Buffer.byteLength(text)},
				${"e".repeat(64)}, ${JSON.stringify(OWNERSHIP)}::jsonb,
				'2026-11-11T00:00:00.000Z'::timestamptz, ${ACTOR},
				NULL, NULL, NULL
			)
			ON CONFLICT (deployment_id) DO UPDATE SET
				remote_app_id = EXCLUDED.remote_app_id,
				origin = EXCLUDED.origin,
				source_gzip = EXCLUDED.source_gzip,
				source_bytes = EXCLUDED.source_bytes,
				source_digest = EXCLUDED.source_digest,
				ownership = EXCLUDED.ownership,
				observed_at = EXCLUDED.observed_at,
				observed_by = EXCLUDED.observed_by
			WHERE existing.remote_app_id <> EXCLUDED.remote_app_id
				OR existing.observed_at <= EXCLUDED.observed_at
		`.execute(db);
		const after = await db
			.selectFrom("app_deployment_baselines")
			.select([
				"deployment_id",
				"nova_revision",
				"media_files",
				"source_digest",
			])
			.select("first_publish_changes")
			.executeTakeFirstOrThrow();
		expect(after.source_digest).toBe("e".repeat(64));
		expect({
			nova_revision: after.nova_revision,
			media_files: after.media_files,
			first_publish_changes: after.first_publish_changes,
		}).toEqual({
			nova_revision: before.nova_revision,
			media_files: before.media_files,
			first_publish_changes: before.first_publish_changes,
		});
	});

	it("keeps the revision, the media record and the list through a refresh that compared equal", async () => {
		const birth = await born();
		const stored = await readAppBaseline(birth.scope, TARGET);
		if (stored === null || stored.origin === "unread")
			throw new Error("Expected a read baseline");
		const text = JSON.stringify(SOURCE);
		const written = await recordRefreshedAppBaseline(birth.scope, TARGET, {
			expectedEndings: 0,
			remoteAppId: HQ_APP,
			comparedDigest: stored.sourceDigest,
			read: {
				sourceGzip: gzipSync(Buffer.from(text, "utf8")),
				sourceBytes: Buffer.byteLength(text, "utf8"),
				sourceDigest: stored.sourceDigest,
				observedAt: "2026-11-12T00:00:00.000Z",
			},
		});
		expect(written.outcome).toBe("current");
		const row = await h
			.db()
			.selectFrom("app_deployment_baselines")
			.select([
				"origin",
				"observed_at",
				"nova_revision",
				"media_files",
				"first_publish_changes",
			])
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			origin: "read",
			observed_at: new Date("2026-11-12T00:00:00.000Z"),
			media_files: MEDIA_FILES,
			first_publish_changes: {
				ids: ["forms-and-settings-rewritten"],
				webAppsOnInHq: true,
				of: "first-publish",
			},
		});
		expect(Number(row.nova_revision)).toBe(1);
	});

	it("reads a read baseline whose stored bytes do not verify as unread, saying it was a read", async () => {
		const birth = await born();
		await h
			.db()
			.updateTable("app_deployment_baselines")
			.set({ source_gzip: gzipSync(Buffer.from('{"tampered":true}')) })
			.execute();
		expect(await readAppBaseline(birth.scope, TARGET)).toEqual({
			origin: "unread",
			storedOrigin: "read",
			remoteAppId: HQ_APP,
			observedAt: READ_AT,
			observedBy: ACTOR,
			novaRevision: 1,
			mediaFiles: MEDIA_FILES,
		});
	});

	it("leaves no row of any table when the birth's transaction throws after the writer", async () => {
		await expect(
			born({
				afterWrite: async () => {
					throw new Error("the rest of the birth failed");
				},
			}),
		).rejects.toThrow("the rest of the birth failed");
		expect(await h.readAppRow(APP)).toBeUndefined();
		for (const table of [
			"app_deployments",
			"app_deployment_resources",
			"app_deployment_baselines",
			"app_deployment_identities",
			"app_deployment_media_paths",
			"app_deployment_keyed_case_ids",
			"app_deployment_column_field_words",
			"app_deployment_confirmations",
		] as const) {
			expect(await count(table)).toBe(0);
		}
	});

	it("refuses to record where an app came from when the app row is not the born app", async () => {
		await expect(
			born({ writeOverrides: { projectId: "project-other" } }),
		).rejects.toThrow(
			`Nova tried to record where app ${APP} came from and found no such app in Project project-other. The app's birth and its deployment are written together, so this is Nova's fault to fix: check the order of the creation transaction.`,
		);
		expect(await h.readAppRow(APP)).toBeUndefined();
		expect(await count("app_deployments")).toBe(0);
	});

	it("answers the claim index with no holder when a birth meets it without the claim", async () => {
		await born();
		const second = testUuid("second-adopted-app");
		const refusal = await born({ appId: second, skipClaim: true }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(refusal).toBeInstanceOf(HqAppAlreadyClaimedError);
		expect(refusal).toMatchObject({
			key: { server: "production", domain: "clinic", remoteAppId: HQ_APP },
			holder: null,
		});
		expect(await h.readAppRow(second)).toBeUndefined();
		expect(await count("app_deployments")).toBe(1);
	});
});

describe("readHqAppClaims", () => {
	const VIEWER = "picker";
	const OWNER = "project-owner";

	async function claims(viewerUserId: string, remoteAppIds: string[]) {
		return readHqAppClaims({
			viewerUserId,
			seen: seenByHq("production", "clinic", remoteAppIds),
		});
	}

	it("answers open to a member of the holding Project and leaves a free HQ app out", async () => {
		await born();
		await h.seedProjectMember(VIEWER, PROJECT, "viewer");
		const app = await h.readAppRow(APP);
		expect(await claims(VIEWER, [HQ_APP, "f".repeat(32)])).toEqual([
			{
				remoteAppId: HQ_APP,
				kind: "open",
				appId: APP,
				appName: app?.app_name,
			},
		]);
	});

	it("answers elsewhere to a non-member, naming the person while they are a member and no app or Project", async () => {
		await born();
		await h.seedProjectMember(VIEWER, "project-viewer", "owner");
		expect(await claims(VIEWER, [HQ_APP])).toEqual([
			{
				remoteAppId: HQ_APP,
				kind: "elsewhere",
				at: BIRTH_AT.toISOString(),
				contact: { role: "person", names: [ACTOR] },
			},
		]);
	});

	it("names the Project's owners where the person who brought the app in has left it", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await h.seedProjectMember(ACTOR, PROJECT, "admin");
		await birthAdoptedApp(h, {
			appId: APP,
			projectId: PROJECT,
			actorUserId: ACTOR,
			target: TARGET,
			remoteAppId: HQ_APP,
		});
		await sql`DELETE FROM auth_member WHERE "userId" = ${ACTOR}`.execute(
			h.db(),
		);
		expect(await claims(VIEWER, [HQ_APP])).toEqual([
			{
				remoteAppId: HQ_APP,
				kind: "elsewhere",
				at: BIRTH_AT.toISOString(),
				contact: { role: "owners", names: [OWNER] },
			},
		]);
	});

	it("never returns a holder in recently deleted", async () => {
		await born();
		await softDeleteApp(APP, ACTOR);
		expect(await claims(VIEWER, [HQ_APP])).toEqual([]);
	});

	it("gives an HQ app Nova created the date its mapping began, with nothing that says how", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const appId = await h.seedApp({
			id: testUuid("created-app"),
			owner: ACTOR,
			project_id: PROJECT,
		});
		const scope = {
			appId,
			projectId: PROJECT,
			role: "owner",
			actorUserId: ACTOR,
		};
		await foldDeploymentAttempt(
			scope,
			TARGET,
			"preflight",
			{ status: "succeeded", at: READ_AT },
			{ ensure: true, expectedEndings: 0 },
		);
		await recordRemoteResource(scope, TARGET, {
			expectedEndings: 0,
			kind: "app",
			novaResourceId: appId,
			remoteId: HQ_APP,
			ownership: "nova-created",
			pushedRevision: 1,
			remoteRevision: null,
			uploadedAt: READ_AT,
			baseline: {
				origin: "unread",
				remoteAppId: HQ_APP,
				sourceGzip: null,
				sourceBytes: null,
				sourceDigest: null,
				ownership: null,
				observedAt: READ_AT,
				discard: null,
				novaRevision: null,
				mediaFiles: { kind: "set", files: null },
				firstPublish: { kind: "set", list: null },
			},
		});
		const mapping = await h
			.db()
			.selectFrom("app_deployment_resources")
			.select("created_at")
			.executeTakeFirstOrThrow();
		expect(await claims(VIEWER, [HQ_APP])).toEqual([
			{
				remoteAppId: HQ_APP,
				kind: "elsewhere",
				at: mapping.created_at.toISOString(),
				contact: { role: "person", names: [ACTOR] },
			},
		]);
	});
});

describe("existing adoptions and installation reviews", () => {
	it("counts a verified empty map, an unobserved baseline and a real binding separately before DDL and after restore", async () => {
		const birth = await born();
		const database = h.db();
		const baseline = await database
			.selectFrom("app_deployment_baselines")
			.selectAll()
			.executeTakeFirstOrThrow();
		const admitted=await admitAppWrite(birth.scope,TARGET,{expectedEndings:0,remoteAppId:HQ_APP,writeKind:"import"});
   if(admitted.kind!=="admitted")throw new Error("Expected a durable import admission");
   await settleRemoteWrites([admitted.writeId],{kind:"settled"});
   const oldReceipt=await database.selectFrom("hq_remote_writes").select(["id","resource_id","settled_at"]).where("id","=",admitted.writeId).executeTakeFirstOrThrow();
   // This isolated database has an authentic adoption and its immutable source.
		// Down/up simulates the exact previous schema and the operator's DDL recovery.
		await installationMigration.down(database);
		try {
			for (const [kind, shape] of [
				["empty", { langs: ["en"], build_profiles: {} }],
				["unobserved", { langs: ["en"] }],
				[
					"named",
					{
						langs: ["en"],
						build_profiles: {
							field: {
								name: "Field",
								langs: ["en"],
								practice_mobile_worker_id: "local-worker",
							},
						},
					},
				],
			] as const) {
				const text = JSON.stringify(shape);
				await database
					.updateTable("app_deployment_baselines")
					.set({
						source_gzip: gzipSync(text),
						source_bytes: Buffer.byteLength(text),
						source_digest: installationDigest("sha256")
							.update(text)
							.digest("hex"),
					})
					.where("deployment_id", "=", baseline.deployment_id)
					.execute();
				expect(await scanInstallationProfileBaselines(database)).toMatchObject({
					[kind]: 1,
					privateWorkers: kind === "named" ? 1 : 0,
				});
			}
			await database
				.updateTable("app_deployment_baselines")
				.set({
					source_gzip: baseline.source_gzip,
					source_digest: baseline.source_digest,
					source_bytes: baseline.source_bytes,
				})
				.where("deployment_id", "=", baseline.deployment_id)
				.execute();
		} finally {
			await installationMigration.up(database);
		}
  expect(await database.selectFrom("hq_remote_writes").select(["id","resource_id","settled_at","import_acknowledged_at","import_acknowledged_version"]).where("id","=",admitted.writeId).executeTakeFirstOrThrow()).toEqual({...oldReceipt,import_acknowledged_at:null,import_acknowledged_version:null});

		expect(
			await database
				.selectFrom("app_deployment_baselines")
				.selectAll()
				.executeTakeFirstOrThrow(),
		).toEqual(baseline);
		expect(
			(await readTargetIdentity(birth.scope, TARGET)).installationProfiles,
		).toBeUndefined();
	});
	it("rechecks Project membership and the caller’s HQ grants before promoting any destination key and worker", async () => {
		const birth = await born();
		const identity = await readTargetIdentity(birth.scope, TARGET);
		const sequence = Number(
			(
				await h
					.db()
					.selectFrom("apps")
					.select("mutation_seq")
					.where("id", "=", APP)
					.executeTakeFirstOrThrow()
			).mutation_seq,
		);
		const claim = await installationClaim(birth.scope);
		const checkpoint = {
			claim,
			workingVersion: 1,
			phase: "confirm-workers" as const,
			sequence,
			appId: HQ_APP,
			sourceDigest: "read",
			unrelatedDigest: "rest",
			review: { requested: [], previousKeys: ["field"] },
		};
		const input = {
			claim,
			sequence,
			remoteAppId: HQ_APP,
			identity,
			previous: undefined,
			next: checkpoint,
			requireHqImport: null,
		};
		expect(await writeInstallationReview(birth.scope, TARGET, input)).toBe(
			true,
		);
		const binding = {
			uuid: testUuid("field-team"),
			key: "field",
			practiceWorkerId: "worker-here",
		};
		const promote = {
			...input,
			next: undefined,
			previous: checkpoint,
			bindings: [binding],
		};
		await expect(
			writeInstallationReview(birth.scope, TARGET, {
				...promote,
				requireHqImport: () => {
					throw new Error("Missing HQ Import");
				},
			}),
		).rejects.toThrow("Missing HQ Import");
		expect(await readInstallationReview(birth.scope, TARGET)).toEqual(
			checkpoint,
		);
		expect(
			await writeInstallationReview(birth.scope, TARGET, {
				...promote,
				remoteAppId: "other-app",
			}),
		).toBe(false);
		await sql`UPDATE auth_member SET role = ${"viewer"} WHERE "userId" = ${ACTOR} AND "organizationId" = ${PROJECT}`.execute(
			h.db(),
		);
		await expect(
			writeInstallationReview(birth.scope, TARGET, promote),
		).rejects.toThrow();
		expect(
			(await readTargetIdentity(birth.scope, TARGET)).installationProfiles,
		).toBeUndefined();
		await sql`UPDATE auth_member SET role = ${"editor"} WHERE "userId" = ${ACTOR} AND "organizationId" = ${PROJECT}`.execute(
			h.db(),
		);
		expect(await writeInstallationReview(birth.scope, TARGET, promote)).toBe(
			true,
		);
		expect(
			(await readTargetIdentity(birth.scope, TARGET)).installationProfiles,
		).toEqual([binding]);
		expect(
			(await readTargetIdentity(birth.scope, { ...TARGET, domain: "another" }))
				.installationProfiles,
		).toBeUndefined();
		expect(await readInstallationReview(birth.scope, TARGET)).toBeUndefined();
	});
	it("requires fresh agreement after the same deployment loses and reclaims the same HQ app", async () => {
		const birth = await born();
		const scope = birth.scope;
		const identity = await readTargetIdentity(scope, TARGET);
		const claim = await installationClaim(scope);
		const sequence = Number(
			(
				await h
					.db()
					.selectFrom("apps")
					.select("mutation_seq")
					.where("id", "=", APP)
					.executeTakeFirstOrThrow()
			).mutation_seq,
		);
		const next = {
			phase: "replace-profile" as const,
			claim,
			workingVersion: 7,
			sequence,
			appId: HQ_APP,
			sourceDigest: "a",
			unrelatedDigest: "b",
			review: { previousKeys: [], requested: [] },
		};
		const input = {
			sequence,
			claim,
			identity,
			remoteAppId: HQ_APP,
			previous: undefined,
			next,
			requireHqImport: null,
		};
		expect(await writeInstallationReview(scope, TARGET, input)).toBe(true);
		await softDeleteApp(APP, ACTOR);
		const taker = testUuid("second-owner");
		await birthAdoptedApp(h, {
			appId: taker,
			projectId: PROJECT,
			actorUserId: ACTOR,
			target: TARGET,
			remoteAppId: HQ_APP,
		});
		await softDeleteApp(taker, ACTOR);
		await restoreApp(APP, ACTOR);
		const current = await installationClaim(scope);
		expect(current.mapping).not.toBe(claim.mapping);
		const bind = {
			...input,
			previous: next,
			next: undefined,
			bindings: [{ uuid: testUuid("selected"), key: "field" }],
		};
		expect(await writeInstallationReview(scope, TARGET, bind)).toBe(false);
		expect(
			(await readTargetIdentity(scope, TARGET)).installationProfiles,
		).toBeUndefined();
		const fresh = { ...next, claim: current };
		expect(
			await writeInstallationReview(scope, TARGET, {
				...input,
				claim: current,
				previous: next,
				next: fresh,
			}),
		).toBe(true);
		expect(
			await writeInstallationReview(scope, TARGET, {
				...bind,
				claim: current,
				previous: fresh,
			}),
		).toBe(true);
	});
	it("rejects a review or binding from an earlier live mapping replaced at the same Nova revision", async () => {
		const birth = await born();
		const identity = await readTargetIdentity(birth.scope, TARGET);
		const seq = Number(
			(
				await h
					.db()
					.selectFrom("apps")
					.select("mutation_seq")
					.where("id", "=", APP)
					.executeTakeFirstOrThrow()
			).mutation_seq,
		);
		const claim = await installationClaim(birth.scope);
		const next = {
			claim,
			workingVersion: 1,
			phase: "edit-profiles" as const,
			sequence: seq,
			appId: HQ_APP,
			sourceDigest: "a",
			unrelatedDigest: "b",
			review: { previousKeys: [], requested: [] },
		};
		const stale = {
			claim,
			sequence: seq,
			remoteAppId: HQ_APP,
			previous: undefined,
			identity,
			requireHqImport: null,
		};
		await recordRemoteResource(birth.scope, TARGET, {
			expectedEndings: 0,
			kind: "app",
			novaResourceId: APP,
			remoteId: "replacement-app",
			ownership: "nova-created",
			pushedRevision: seq,
			remoteRevision: 2,
			uploadedAt: READ_AT,
			baseline: {
				origin: "unread",
				remoteAppId: "replacement-app",
				sourceGzip: null,
				sourceBytes: null,
				sourceDigest: null,
				ownership: null,
				observedAt: READ_AT,
				discard: null,
				novaRevision: null,
				mediaFiles: { kind: "set", files: null },
				firstPublish: { kind: "set", list: null },
			},
		});
		expect(
			await writeInstallationReview(birth.scope, TARGET, { ...stale, next }),
		).toBe(false);
		expect(
			await writeInstallationReview(birth.scope, TARGET, {
				...stale,
				bindings: [
					{
						uuid: testUuid("stale-worker"),
						key: "old-key",
						practiceWorkerId: "old-worker",
					},
				],
			}),
		).toBe(false);
		expect(await readInstallationReview(birth.scope, TARGET)).toBeUndefined();
		expect(
			(await readTargetIdentity(birth.scope, TARGET)).installationProfiles,
		).toBeUndefined();
	});
});
