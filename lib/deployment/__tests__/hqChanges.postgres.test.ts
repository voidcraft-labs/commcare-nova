/**
 * What a bring-in of changes made in CommCare HQ stores, in real Postgres:
 * `store.ts::recordHqChangesTaken` in a commit's own transaction and in a
 * short one of its own, and `recordRefreshedAppBaseline` for a read that
 * compared equal.
 *
 * Contract: the record moves the deployment's baseline and the Nova revision
 * it describes together, to CommCare HQ's source as read and the revision
 * that holds it, with origin `changes`, the ownership and media record the
 * caller computed; it writes an identity row for each menu and form whose
 * CommCare HQ id is not the derivation, deleting first a stored row the
 * reading contradicts, and a media path row for each file
 * CommCare HQ added or replaced, deleting the replaced file's row first; it
 * keeps the next publish's list by one rule; and it writes none of that
 * where the baseline, its revision or the live app mapping is not the one
 * the plan read, or where the commit it rides on fails. A refresh keeps the
 * origin and the revision a bring-in of changes left.
 *
 * Plausible failures: a publish that landed between the review and the take
 * written over by an older source; a pair that names a revision the source
 * does not describe; a form made in CommCare HQ that the next publish sends
 * under a derived id, and so as another form; a replaced file whose old row
 * still holds the path, so the next publish names the old file there; a
 * first-publish list lost, or a stale list of the next publish kept, after a
 * bring-in; the record kept where its commit rolled back.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { type Kysely, sql } from "kysely";
import sharp from "sharp";
import type { MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	HqSaveCounter,
	isSaveCounterPath,
	withHqPeer,
} from "@/__tests__/helpers/hqSaveCounter";
import {
	readHttpRequestBody,
	readMultipartRequest,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { withProjectContext } from "@/lib/case-store";
import type { Database as CaseDatabase } from "@/lib/case-store/sql/database";
import { decrypt } from "@/lib/commcare/encryption";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import { applyBlueprintChangeProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { ApplyBlueprintChangeArgs } from "@/lib/db/applyBlueprintChange";
import { loadApp, restoreApp, softDeleteApp } from "@/lib/db/apps";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/expression";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import type { Uuid } from "@/lib/domain/uuid";
import { log } from "@/lib/logger";
import { readManagedTableReview } from "@/lib/lookup/managed";
import { getLookupTable, updateLookupTableTag } from "@/lib/lookup/service";
import type { StoredFirstPublish } from "@/lib/publish/firstPublishChangeIds";
import { hqChangesPublishingStoppedLine } from "@/lib/publish/hqChangesCopy";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { TargetPeer } from "@/proof/corpus/targetPeer";
import { DeploymentEndedError } from "../errors";
import { bringInHqChanges } from "../hqChanges/bringIn";
import { reviewHqChanges } from "../hqChanges/review";
import type { HqChangesReview } from "../hqChanges/types";
import type { HqMediaRecord } from "../hqMedia";
import { normalizeHqAppSource } from "../hqSourceBaseline";
import { manageLookupTableInNova } from "../managedData";
import {
	adoptFixtureApp,
	changedAnswer,
	counterOf,
	createInputFor,
	FIXTURE_DOMAIN,
	FIXTURE_HOST,
	FIXTURE_PATHS,
	FIXTURE_REMOTE_APP_ID,
	FIXTURE_SERVER,
	fixtureKey,
	fixtureResource,
	fixtureSource,
	reviewOf,
	seedFixtureConnection,
	serveAnswer,
	serveFixtureApp,
	serveFixtureTables,
	withIcons,
} from "../reading/__tests__/adoptionFixture";
import {
	EMITTED_KEYED_PREFIX,
	keyedCreateApp,
	keyedPrefixIn,
	type ServedHqApp,
	servedHqApp,
	servedKeyedApp,
	serveHqApp,
	summarizeServedHqApp,
} from "../reading/__tests__/servedHqApp";
import { createFromReview } from "../reading/create";
import { authorizeBringIn, readHqAppForReview } from "../reading/read";
import {
	peekHqAppChanged,
	publishAppToHq,
	refreshKeptValues,
	setupArtifactFor,
} from "../service";
import * as deploymentStore from "../store";
import {
	admitAppWrite,
	HqChangesBaselineMovedError,
	type HqChangesRecordAt,
	type HqChangesTaken,
	readAppBaseline,
	readDeployment,
	readTargetIdentity,
	recordHqChangesTaken,
	recordRefreshedAppBaseline,
	recordRemoteResource,
	settleRemoteWrites,
} from "../store";
import {
	canonicalTargetIdentity,
	EMPTY_TARGET_IDENTITY,
	resolveTargetIdentity,
} from "../targetIdentity";
import type { AppBaselineWrite, AppOwnership } from "../types";
import {
	type AdoptedBirth,
	appMappingToken,
	birthAdoptedApp,
	HELD_FILE_ID,
	HELD_PATH,
	OWNERSHIP,
	SOURCE,
	seedAsset,
} from "./adoptedBirth";
import { certifyFold } from "./certifiedFold";
import { reloadHeadFor } from "./publishFixtures";
import { stopHere } from "./stopHere";

/** A moment between the bring-in's checks and its commit, which a test fills. */
const seam = vi.hoisted(() => ({
	beforeCommit: null as
		| null
		| ((args: ApplyBlueprintChangeArgs) => Promise<void>),
}));

vi.mock("@/lib/db/applyBlueprintChange", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/db/applyBlueprintChange")>();
	return {
		...actual,
		applyBlueprintChange: async (
			args: Parameters<typeof actual.applyBlueprintChange>[0],
		) => {
			if (args.kind === "hq-changes") await seam.beforeCommit?.(args);
			return actual.applyBlueprintChange(args);
		},
	};
});
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
/* The setup artifact a landed bring-in answers with, which a case makes fault. */
vi.mock("@/lib/deployment/service", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/deployment/service")>();
	return { ...actual, setupArtifactFor: vi.fn(actual.setupArtifactFor) };
});
/* The bucket, at its own boundary: an app brought in with a file publishes it there. */
vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: vi.fn(async () => undefined),
	deleteAsset: vi.fn(),
	downloadAssetBytes: vi.fn(),
}));
beforeEach(() => {
	seam.beforeCommit = null;
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});

const h = setupAppStateTestDb("hq_changes_", {
	authSchema: "migrated",
	poolMax: 4,
});

const ACTOR = "bringer";
const PROJECT = "project-clinic";
const TARGET = { server: "production" as const, domain: "clinic" };
const HQ_APP = "c".repeat(32);
const OTHER_HQ_APP = "d".repeat(32);
const APP = testUuid("hq-changes-app");

/** CommCare HQ's source after a person changed the app there. */
const CHANGED_SOURCE = { ...SOURCE, name: "Clinic visits, renamed in HQ" };
const CHANGED_AT = "2026-11-14T08:00:00.000Z";

/** The ownership the next publish's body gives over the changed source. */
const TAKEN_OWNERSHIP: AppOwnership = {
	...OWNERSHIP,
	addOns: ["display_conditions", "menu_mode"],
};

/** The born list, as `adoptedBirth.ts` stores it. */
const BORN_LIST: StoredFirstPublish = {
	ids: ["forms-and-settings-rewritten"],
	webAppsOnInHq: true,
	of: "first-publish",
};

function digestOf(source: object): string {
	return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

/** A source as a baseline stores it: compressed, counted and digested. */
function stored(source: object, observedAt: string) {
	const text = JSON.stringify(source);
	return {
		sourceGzip: gzipSync(Buffer.from(text, "utf8")),
		sourceBytes: Buffer.byteLength(text, "utf8"),
		sourceDigest: digestOf(source),
		observedAt,
	};
}

async function born(): Promise<AdoptedBirth> {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	return birthAdoptedApp(h, {
		appId: APP,
		projectId: PROJECT,
		actorUserId: ACTOR,
		target: TARGET,
		remoteAppId: HQ_APP,
	});
}

/**
 * A take of `CHANGED_SOURCE` over the born baseline, which describes
 * `SOURCE` at revision 1. Every member can be replaced.
 */
function taken(
	birth: AdoptedBirth,
	overrides: Partial<HqChangesTaken> = {},
): HqChangesTaken {
	return {
		scope: birth.scope,
		target: TARGET,
		expectedEndings: 0,
		remoteAppId: HQ_APP,
		comparedPushToken: appMappingToken(birth.deployment),
		reviewedVersion: 42,
		read: { sourceDigest: digestOf(SOURCE), novaRevision: 1 },
		source: stored(CHANGED_SOURCE, CHANGED_AT),
		ownership: TAKEN_OWNERSHIP,
		mediaFiles: {
			read: { [HELD_PATH]: HELD_FILE_ID },
			next: { [HELD_PATH]: HELD_FILE_ID },
		},
		targetIdentity: { read: birth.targetIdentity, next: birth.targetIdentity },
		firstPublish: {
			accepted: {
				ids: ["forms-and-settings-rewritten", "web-apps-turned-off"],
				touchesWorkers: true,
				of: "first-publish",
			},
			publishChanges: [],
			webAppsOnInHq: false,
		},
		...overrides,
	};
}

/** The short transaction of a take whose batch is empty, at the head the plan read. */
const AT_HEAD: HqChangesRecordAt = { kind: "own", headSeq: 1 };

async function baselineRow() {
	const row = await h
		.db()
		.selectFrom("app_deployment_baselines")
		.select([
			"remote_app_id",
			"origin",
			"source_digest",
			"ownership",
			"observed_at",
			"observed_by",
			"nova_revision",
			"media_files",
			"first_publish_changes",
		])
		.executeTakeFirstOrThrow();
	return {
		...row,
		nova_revision:
			row.nova_revision === null ? null : Number(row.nova_revision),
		observed_at: row.observed_at.toISOString(),
	};
}

async function identityRows() {
	return h
		.db()
		.selectFrom("app_deployment_identities")
		.select(["entity_kind", "nova_entity_uuid", "unique_id", "xmlns"])
		.orderBy("entity_kind")
		.orderBy("nova_entity_uuid")
		.execute();
}

async function mediaPathRows() {
	return h
		.db()
		.selectFrom("app_deployment_media_paths")
		.select(["media_asset_id", "wire_path"])
		.orderBy("wire_path")
		.execute();
}

async function headOf(appId: string): Promise<number> {
	const row = await h
		.db()
		.selectFrom("apps")
		.select("mutation_seq")
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	return Number(row.mutation_seq);
}

/** Everything a take writes, to show that a refused one wrote none of it. */
async function ledger() {
	return {
		baseline: await baselineRow(),
		identities: await identityRows(),
		mediaPaths: await mediaPathRows(),
	};
}

/** A `push` baseline of `SOURCE` at revision 2, which holds no list. */
async function pushed(birth: AdoptedBirth): Promise<AdoptedBirth> {
	await applyBlueprintChangeProposal({
		appId: APP,
		userId: ACTOR,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: { mutations: [{ kind: "setAppName", name: "Published revision" }] },
	});
	const baseline: AppBaselineWrite = {
		origin: "push",
		remoteAppId: HQ_APP,
		...stored(SOURCE, "2026-11-12T00:00:00.000Z"),
		ownership: OWNERSHIP,
		discard: null,
		novaRevision: 2,
		mediaFiles: { kind: "keep" },
		firstPublish: { kind: "set", list: null },
	};
	const pushed = await recordRemoteResource(birth.scope, TARGET, {
		expectedEndings: 0,
		kind: "app",
		novaResourceId: APP,
		remoteId: HQ_APP,
		ownership: "adopted",
		adoptedBy: ACTOR,
		pushedRevision: 2,
		remoteRevision: 42,
		uploadedAt: baseline.observedAt,
		baseline,
	});
	if (!pushed.deployment) throw new Error("Expected a published app.");
	return { ...birth, deployment: pushed.deployment };
}

describe("recordHqChangesTaken", () => {
	it("moves the pair to CommCare HQ's source and the reviewed head, with the ownership and media record it is given", async () => {
		const birth = await born();
		const files: HqMediaRecord = { [HELD_PATH]: "hq-file-2" };
		const recorded = await recordHqChangesTaken(
			AT_HEAD,
			taken(birth, {
				mediaFiles: { read: { [HELD_PATH]: HELD_FILE_ID }, next: files },
			}),
		);
		expect(await baselineRow()).toEqual({
			remote_app_id: HQ_APP,
			origin: "changes",
			source_digest: digestOf(CHANGED_SOURCE),
			ownership: TAKEN_OWNERSHIP,
			observed_at: CHANGED_AT,
			observed_by: ACTOR,
			nova_revision: 1,
			media_files: files,
			first_publish_changes: {
				ids: ["forms-and-settings-rewritten"],
				webAppsOnInHq: false,
				of: "first-publish",
			},
		});
		const baseline = await readAppBaseline(birth.scope, TARGET);
		expect(baseline).toMatchObject({
			origin: "changes",
			source: CHANGED_SOURCE,
			novaRevision: 1,
		});
		/* Nothing was sent: the mapping's pushed revision and the state stay. */
		expect(recorded.deployment.state).toBe(birth.deployment.deployment.state);
		expect(recorded.active.map((one) => one.pushedRevision)).toEqual(
			birth.deployment.active.map((one) => one.pushedRevision),
		);
	});

	it("records the sequence of the commit it rides on, and nothing where that commit fails after it", async () => {
		const birth = await born();
		const head = await headOf(APP);
		const commit = (batchId: string, newForm: Uuid) =>
			applyBlueprintChangeProposal({
				appId: APP,
				userId: ACTOR,
				expectedProjectId: PROJECT,
				batchId,
				kind: "hq-changes",
				expectedHeadSeq: head,
				guard: {
					mutations: [{ kind: "setAppName", name: "Renamed in HQ" }],
				},
				inTransaction: ({ tx, seq }) =>
					recordHqChangesTaken(
						{ kind: "commit", tx, seq },
						taken(birth, {
							targetIdentity: {
								read: birth.targetIdentity,
								next: canonicalTargetIdentity({
									...birth.targetIdentity,
									entities: [
										...birth.targetIdentity.entities,
										{
											entityKind: "form",
											novaEntityUuid: newForm,
											uniqueId: "e".repeat(32),
											xmlns: "http://openrosa.org/formdesigner/made-in-hq",
										},
									],
								}),
							},
						}),
					).then(() => undefined),
			});

		await sql`
			CREATE FUNCTION hq_changes_refuse_batch() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.batch_id = 'refused-batch' THEN
					RAISE EXCEPTION 'the change log refused this batch';
				END IF;
				RETURN NEW;
			END
			$$
		`.execute(h.db());
		await sql`
			CREATE TRIGGER hq_changes_refuse_batch BEFORE INSERT ON app_changes
			FOR EACH ROW EXECUTE FUNCTION hq_changes_refuse_batch()
		`.execute(h.db());
		const before = await ledger();
		await expect(
			commit("refused-batch", testUuid("refused-form")),
		).rejects.toThrow("the change log refused this batch");
		expect(await ledger()).toEqual(before);

		const newForm = testUuid("form-made-in-hq");
		const committed = await commit(crypto.randomUUID(), newForm);
		expect(committed.seq).toBe(head + 1);
		expect(await baselineRow()).toMatchObject({
			origin: "changes",
			source_digest: digestOf(CHANGED_SOURCE),
			nova_revision: head + 1,
		});
		expect(await identityRows()).toContainEqual({
			entity_kind: "form",
			nova_entity_uuid: newForm,
			unique_id: "e".repeat(32),
			xmlns: "http://openrosa.org/formdesigner/made-in-hq",
		});
	});

	/* The rule that resolves a reading is `targetIdentity.ts`'s, held by its
	 * own pure suite; the record writes what it resolved, row for row. */
	it("writes the target-identity record the reading resolved, row for row, keeping the date of each row it keeps", async () => {
		const birth = await born();
		const replacement = await seedAsset(h, PROJECT, ACTOR, "replacement");
		const keptMenu = birth.targetIdentity.entities.find(
			(row) => row.entityKind === "module",
		);
		if (keptMenu === undefined)
			throw new Error("The birth holds a menu's row.");
		const before = await h
			.db()
			.selectFrom("app_deployment_identities")
			.select(["nova_entity_uuid", "recorded_at"])
			.where("nova_entity_uuid", "=", keptMenu.novaEntityUuid)
			.executeTakeFirstOrThrow();
		/* CommCare HQ holds the born form under its derivation now, made a
		 * menu, moved the born file and keyed the born create under another
		 * prefix; the born menu reads the same. */
		const madeInHq = testUuid("menu-made-in-hq");
		const next = resolveTargetIdentity(
			birth.targetIdentity,
			{
				entities: [
					keptMenu,
					{
						entityKind: "module",
						novaEntityUuid: madeInHq,
						uniqueId: "f".repeat(32),
						xmlns: null,
					},
					{
						entityKind: "form",
						novaEntityUuid: birth.formUuid,
						uniqueId: derivedUniqueId(birth.formUuid),
						xmlns: derivedFormXmlns(birth.formUuid),
					},
				],
				keyedCreates: [
					{
						operationUuid: birth.operationUuid,
						formUuid: birth.formUuid,
						caseType: "patient",
						prefix: `nova-case-v1:${testUuid("prefix-moved-in-hq")}:`,
					},
				],
				mediaPaths: [
					{
						assetId: replacement,
						wirePath: HELD_PATH,
						derivedPath: `commcare/${"1".repeat(64)}.png`,
						alsoAt: [],
					},
				],
				hqPaths: [HELD_PATH],
				columnWords: [],
			},
			{ appId: APP },
		);
		await recordHqChangesTaken(
			AT_HEAD,
			taken(birth, {
				targetIdentity: { read: birth.targetIdentity, next },
			}),
		);
		expect(await readTargetIdentity(birth.scope, TARGET)).toEqual(next);
		expect(next.entities.map((row) => row.novaEntityUuid).sort()).toEqual(
			[keptMenu.novaEntityUuid, madeInHq].sort(),
		);
		expect(next.mediaPaths).toEqual([
			{ assetId: replacement, wirePath: HELD_PATH },
		]);
		expect(next.keyedCaseIds).toEqual([
			{
				operationUuid: birth.operationUuid,
				caseType: "patient",
				prefix: `nova-case-v1:${testUuid("prefix-moved-in-hq")}:`,
			},
		]);
		/* The menu's row was kept, not written again. */
		expect(
			await h
				.db()
				.selectFrom("app_deployment_identities")
				.select(["nova_entity_uuid", "recorded_at"])
				.where("nova_entity_uuid", "=", keptMenu.novaEntityUuid)
				.executeTakeFirstOrThrow(),
		).toEqual(before);
	});

	it("writes nothing and answers the review again where the record moved since the reading resolved it", async () => {
		const birth = await born();
		/* Another write recorded a row after the review read the record. */
		await h
			.db()
			.insertInto("app_deployment_identities")
			.values({
				deployment_id: birth.deployment.deployment.id,
				entity_kind: "module",
				nova_entity_uuid: testUuid("written-meanwhile"),
				unique_id: "9".repeat(32),
				xmlns: null,
			})
			.execute();
		const before = await ledger();
		const refused = recordHqChangesTaken(
			AT_HEAD,
			taken(birth, {
				targetIdentity: {
					read: birth.targetIdentity,
					next: EMPTY_TARGET_IDENTITY,
				},
			}),
		);
		await expect(refused).rejects.toBeInstanceOf(HqChangesBaselineMovedError);
		await expect(refused).rejects.toMatchObject({ fence: "target-identity" });
		expect(await ledger()).toEqual(before);
	});

	describe("writes nothing and throws where the plan's baseline moved", () => {
		it.each([
			[
				"a moved source digest",
				{ read: { sourceDigest: "f".repeat(64), novaRevision: 1 } },
				"source-digest",
			],
			[
				"a moved Nova revision",
				{ read: { sourceDigest: digestOf(SOURCE), novaRevision: 2 } },
				"nova-revision",
			],
			["another CommCare HQ app", { remoteAppId: OTHER_HQ_APP }, "remote-app"],
			[
				"a read older than the stored one",
				{ source: stored(CHANGED_SOURCE, "2026-11-01T00:00:00.000Z") },
				"observed-at",
			],
		] as const)("for %s", async (_name, overrides, fence) => {
			const birth = await born();
			const before = await ledger();
			const refused = recordHqChangesTaken(
				AT_HEAD,
				taken(birth, {
					...overrides,
					targetIdentity: {
						read: birth.targetIdentity,
						next: canonicalTargetIdentity({
							...birth.targetIdentity,
							entities: [
								...birth.targetIdentity.entities,
								{
									entityKind: "module",
									novaEntityUuid: testUuid("never-written"),
									uniqueId: "9".repeat(32),
									xmlns: null,
								},
							],
						}),
					},
				}),
			);
			await expect(refused).rejects.toBeInstanceOf(HqChangesBaselineMovedError);
			await expect(refused).rejects.toMatchObject({ fence });
			expect(await ledger()).toEqual(before);
		});

		it("names the digests in the developer's sentence", () => {
			expect(
				new HqChangesBaselineMovedError("source-digest", "aa", "bb").message,
			).toBe(
				"The deployment's baseline is not the one this plan read (expected source digest aa, found bb), so nothing was recorded. Another write landed in between; the caller answers the review as it now stands.",
			);
		});

		it("for a deployment ended since the publish read its endings", async () => {
			const birth = await born();
			const before = await ledger();
			await expect(
				recordHqChangesTaken(AT_HEAD, taken(birth, { expectedEndings: 1 })),
			).rejects.toBeInstanceOf(DeploymentEndedError);
			expect(await ledger()).toEqual(before);
		});
	});

	describe("keeps the next publish's list by one rule", () => {
		it("takes this reading's list for an app not yet published, less the two Web App lines", async () => {
			const birth = await born();
			expect((await baselineRow()).first_publish_changes).toEqual(BORN_LIST);
			await recordHqChangesTaken(
				AT_HEAD,
				taken(birth, {
					firstPublish: {
						accepted: {
							ids: [
								"text-spaces-dropped",
								"web-apps-turned-on",
								"case-names-checked",
							],
							touchesWorkers: true,
							of: "first-publish",
						},
						publishChanges: ["case-settings-respelled"],
						webAppsOnInHq: false,
					},
				}),
			);
			expect((await baselineRow()).first_publish_changes).toEqual({
				ids: ["case-names-checked", "text-spaces-dropped"],
				webAppsOnInHq: false,
				of: "first-publish",
			});
		});

		it("takes the next publish's changes after a publish, with the setting the source holds", async () => {
			const birth = await pushed(await born());
			expect((await baselineRow()).first_publish_changes).toBeNull();
			await recordHqChangesTaken(
				{ kind: "own", headSeq: 2 },
				taken(birth, {
					read: { sourceDigest: digestOf(SOURCE), novaRevision: 2 },
					firstPublish: {
						accepted: {
							ids: ["forms-and-settings-rewritten"],
							touchesWorkers: false,
							of: "first-publish",
						},
						publishChanges: [
							"media-files-renamed",
							"web-apps-turned-on",
							"case-settings-respelled",
						],
						webAppsOnInHq: false,
					},
				}),
			);
			expect(await baselineRow()).toMatchObject({
				origin: "changes",
				nova_revision: 2,
				first_publish_changes: {
					ids: ["case-settings-respelled", "media-files-renamed"],
					webAppsOnInHq: false,
					of: "next-publish",
				},
			});
		});

		/** A first bring-in over a push whose plan names the location list setting. */
		async function settingBroughtIn(): Promise<AdoptedBirth> {
			const birth = await pushed(await born());
			await recordHqChangesTaken(
				{ kind: "own", headSeq: 2 },
				taken(birth, {
					read: { sourceDigest: digestOf(SOURCE), novaRevision: 2 },
					firstPublish: {
						accepted: {
							ids: ["location-list-setting-reset"],
							touchesWorkers: false,
							of: "first-publish",
						},
						publishChanges: ["location-list-setting-reset"],
						webAppsOnInHq: true,
					},
				}),
			);
			expect((await baselineRow()).first_publish_changes).toEqual({
				ids: ["location-list-setting-reset"],
				webAppsOnInHq: true,
				of: "next-publish",
			});
			await applyBlueprintChangeProposal({
				appId: APP,
				userId: ACTOR,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				kind: "autosave",
				guard: {
					mutations: [{ kind: "setAppName", name: "Next reviewed revision" }],
				},
			});
			return birth;
		}

		const SECOND = { ...CHANGED_SOURCE, name: "Renamed again" };

		it("keeps a change of the next publish's list that a later bring-in's reading still gives, beside the plan's own", async () => {
			const birth = await settingBroughtIn();
			/* A second change in CommCare HQ: its base already holds the
			 * setting, so the plan names only what is new. */
			await recordHqChangesTaken(
				{ kind: "own", headSeq: 3 },
				taken(birth, {
					read: { sourceDigest: digestOf(CHANGED_SOURCE), novaRevision: 2 },
					source: stored(SECOND, "2026-11-15T08:00:00.000Z"),
					firstPublish: {
						accepted: {
							ids: ["location-list-setting-reset", "case-settings-respelled"],
							touchesWorkers: false,
							of: "first-publish",
						},
						publishChanges: ["case-settings-respelled"],
						webAppsOnInHq: true,
					},
				}),
			);
			expect(await baselineRow()).toMatchObject({
				source_digest: digestOf(SECOND),
				nova_revision: 3,
				first_publish_changes: {
					ids: ["case-settings-respelled", "location-list-setting-reset"],
					webAppsOnInHq: true,
					of: "next-publish",
				},
			});
		});

		it("clears a list of the next publish whose changes the reading no longer gives and the plan names none", async () => {
			const birth = await settingBroughtIn();
			await recordHqChangesTaken(
				{ kind: "own", headSeq: 3 },
				taken(birth, {
					read: { sourceDigest: digestOf(CHANGED_SOURCE), novaRevision: 2 },
					source: stored(SECOND, "2026-11-15T08:00:00.000Z"),
				}),
			);
			expect(await baselineRow()).toMatchObject({
				origin: "changes",
				source_digest: digestOf(SECOND),
				nova_revision: 3,
				first_publish_changes: null,
			});
		});

		it("reads a baseline that holds no list as none, and says nothing of it", async () => {
			const birth = await pushed(await born());
			const errors = vi.spyOn(log, "error");
			try {
				await recordHqChangesTaken(
					{ kind: "own", headSeq: 2 },
					taken(birth, {
						read: { sourceDigest: digestOf(SOURCE), novaRevision: 2 },
					}),
				);
				expect(errors).not.toHaveBeenCalled();
			} finally {
				errors.mockRestore();
			}
			expect((await baselineRow()).first_publish_changes).toBeNull();
		});
	});
});

describe("recordRefreshedAppBaseline after a bring-in of changes", () => {
	const SAVED_AT = "2026-11-15T10:00:00.000Z";
	/** CommCare HQ saved the app again, and Nova reads it as the same app. */
	const SAVED_SOURCE = { ...CHANGED_SOURCE, last_modified: SAVED_AT };

	it("keeps the origin and the revision, and takes the media record and the next publish's list it is given", async () => {
		const birth = await pushed(await born());
		await recordHqChangesTaken(
			{ kind: "own", headSeq: 2 },
			taken(birth, {
				read: { sourceDigest: digestOf(SOURCE), novaRevision: 2 },
			}),
		);
		const files: HqMediaRecord = { [HELD_PATH]: "hq-file-learned" };
		const next: StoredFirstPublish = {
			ids: ["media-paths-joined"],
			webAppsOnInHq: true,
			of: "next-publish",
		};
		const refreshed = await recordRefreshedAppBaseline(birth.scope, TARGET, {
			expectedEndings: 0,
			remoteAppId: HQ_APP,
			comparedPushToken: appMappingToken(birth.deployment),
			comparedDigest: digestOf(CHANGED_SOURCE),
			read: stored(SAVED_SOURCE, SAVED_AT),
			nextPublish: {
				accepted: {
					ids: ["media-paths-joined"],
					touchesWorkers: false,
					of: "first-publish",
				},
				publishChanges: ["media-paths-joined"],
				webAppsOnInHq: true,
			},
			mediaFiles: { read: { [HELD_PATH]: HELD_FILE_ID }, next: files },
		});
		expect(refreshed.outcome).toBe("current");
		expect(await baselineRow()).toEqual({
			remote_app_id: HQ_APP,
			origin: "changes",
			source_digest: digestOf(SAVED_SOURCE),
			ownership: TAKEN_OWNERSHIP,
			observed_at: SAVED_AT,
			observed_by: ACTOR,
			nova_revision: 2,
			media_files: files,
			first_publish_changes: next,
		});
	});

	it("requires the complete accepted first-publish list to match when repeating a read", async () => {
		const birth = await born();
		const apply = (id: "media-paths-joined" | "forms-and-settings-rewritten") =>
			recordRefreshedAppBaseline(birth.scope, TARGET, {
				expectedEndings: 0,
				remoteAppId: HQ_APP,
				comparedPushToken: appMappingToken(birth.deployment),
				comparedDigest: digestOf(SOURCE),
				read: stored({ ...SOURCE, last_modified: SAVED_AT }, SAVED_AT),
				nextPublish: {
					accepted: {
						ids: [id],
						touchesWorkers: false,
						of: "first-publish",
					},
					publishChanges: [],
					webAppsOnInHq: true,
				},
			});
		expect((await apply("media-paths-joined")).outcome).toBe("current");
		const accepted = await baselineRow();
		expect((await apply("media-paths-joined")).outcome).toBe("current");
		expect((await apply("forms-and-settings-rewritten")).outcome).toBe(
			"superseded",
		);
		expect(await baselineRow()).toEqual(accepted);
		expect(accepted).toMatchObject({
			origin: "read",
			nova_revision: 1,
			observed_at: SAVED_AT,
			first_publish_changes: { ...BORN_LIST, ids: ["media-paths-joined"] },
		});
	});

	it("clears a change of the next publish's list that CommCare HQ's save undid", async () => {
		const birth = await pushed(await born());
		await recordHqChangesTaken(
			{ kind: "own", headSeq: 2 },
			taken(birth, {
				read: { sourceDigest: digestOf(SOURCE), novaRevision: 2 },
				firstPublish: {
					accepted: {
						ids: ["location-list-setting-reset"],
						touchesWorkers: false,
						of: "first-publish",
					},
					publishChanges: ["location-list-setting-reset"],
					webAppsOnInHq: true,
				},
			}),
		);
		/* CommCare HQ set the setting back: the app reads the same, and the
		 * reading now gives no change of it. */
		await recordRefreshedAppBaseline(birth.scope, TARGET, {
			expectedEndings: 0,
			remoteAppId: HQ_APP,
			comparedPushToken: appMappingToken(birth.deployment),
			comparedDigest: digestOf(CHANGED_SOURCE),
			read: stored(SAVED_SOURCE, SAVED_AT),
			nextPublish: {
				accepted: { ids: [], touchesWorkers: false, of: "first-publish" },
				publishChanges: [],
				webAppsOnInHq: true,
			},
		});
		expect(await baselineRow()).toMatchObject({
			origin: "changes",
			observed_at: SAVED_AT,
			first_publish_changes: null,
		});
	});
});

// ---------------------------------------------------------------------------
// The review and the bring-in, end to end
// ---------------------------------------------------------------------------

const UNUSED_PATH = "jr://file/commcare/logo/data/hq_logo_android_home.png";

function withUnusedImage(source: RetainedHqAnswer): RetainedHqAnswer {
	return changedAnswer(source, (body) => ({
		...body,
		multimedia_map: {
			...(body.multimedia_map as Record<string, unknown>),
			[UNUSED_PATH]: {
				doc_type: "HQMediaMapItem",
				media_type: "CommCareImage",
				multimedia_id: "unused-image",
				unique_id: "unused-map-entry",
				version: 1,
			},
		},
	}));
}

/**
 * The fixture app of a bring-in (`reading/__tests__/adoptionFixture.ts`),
 * brought in through the production create, then changed in CommCare HQ
 * and reviewed and brought in through the production functions, with
 * CommCare HQ answered by the controlled peer from its own retained reads.
 */
describe("a bring-in of changes made in CommCare HQ", () => {
	const MEMBER = "hq-changes-member";
	const OTHER = "hq-changes-other-member";
	const E2E_PROJECT = "project-hq-changes";
	const KEY_TARGET = {
		server: FIXTURE_SERVER,
		domain: FIXTURE_DOMAIN,
	} as const;
	const RENAMED = "Survey, renamed in CommCare HQ";

	/** The fixture app brought in, and the scope a member who may edit it reads it under. */
	async function broughtIn(member = MEMBER) {
		await h.seedProjectMember(MEMBER, E2E_PROJECT, "owner");
		await h.seedProjectMember(OTHER, E2E_PROJECT, "editor");
		const { appId } = await adoptFixtureApp({
			projectId: E2E_PROJECT,
			actorUserId: MEMBER,
		});
		await seedFixtureConnection(OTHER);
		return scopeOf(appId, member);
	}

	function scopeOf(appId: string, member: string) {
		return {
			appId,
			projectId: E2E_PROJECT,
			role: member === MEMBER ? "owner" : "editor",
			actorUserId: member,
		};
	}

	/** CommCare HQ's source with the app renamed there. */
	function renamed(name = RENAMED): RetainedHqAnswer {
		return changedAnswer(fixtureSource(), (body) => ({ ...body, name }));
	}

	/**
	 * One read of the app as a review makes it: the resource, the source and the
	 * counter, and where the source changed, the table list and the rows.
	 */
	function serveRead(
		peer: MockAgent,
		source: RetainedHqAnswer,
		options: { readonly tables: boolean; readonly times?: number },
	) {
		const times = options.times ?? 1;
		const resource = fixtureResource(source);
		serveAnswer(peer, FIXTURE_PATHS.application, resource, times);
		serveAnswer(peer, FIXTURE_PATHS.source, source, times);
		serveAnswer(peer, FIXTURE_PATHS.version, counterOf(resource), times);
		if (options.tables) serveFixtureTables(peer, times);
	}

	function review(
		scope: ReturnType<typeof scopeOf>,
		source: RetainedHqAnswer,
		tables = true,
	): Promise<HqChangesReview> {
		return withHttpPeer(async (peer) => {
			serveRead(peer, source, { tables });
			return reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} });
		});
	}

	function changesOf(answer: HqChangesReview) {
		if (answer.kind !== "changes")
			throw new Error(`The review answered ${JSON.stringify(answer)}`);
		return answer;
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
			.select(["seq", "actor_id", "run_id"])
			.where("app_id", "=", appId)
			.where("kind", "=", "hq-changes")
			.execute();
	}

	async function e2eBaseline() {
		const row = await h
			.db()
			.selectFrom("app_deployment_baselines")
			.select(["origin", "nova_revision", "source_digest", "observed_by"])
			.executeTakeFirstOrThrow();
		return {
			...row,
			nova_revision:
				row.nova_revision === null ? null : Number(row.nova_revision),
		};
	}

	it("lists what changed, commits it at the reviewed head with its record, and a second review finds nothing", async () => {
		const scope = await broughtIn();
		const before = await head(scope.appId);
		const listed = changesOf(await review(scope, renamed()));
		expect(listed.hqChanges).toEqual(["The app's name"]);
		expect(listed.novaChanges).toEqual([]);
		expect(listed.renamedInNova).toEqual([]);

		const outcome = await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true });
			return bringInHqChanges(
				scope,
				KEY_TARGET,
				{
					readingId: listed.readingId,
					reviewDigest: listed.reviewDigest,
					tableChoices: {},
				},
				{ onEvent: () => {} },
			);
		});
		expect(outcome).toMatchObject({
			kind: "brought-in",
			seq: before.seq + 1,
			discarded: false,
		});
		expect(await head(scope.appId)).toEqual({
			seq: before.seq + 1,
			name: RENAMED,
		});
		expect(await hqChangeRows(scope.appId)).toEqual([
			{ seq: String(before.seq + 1), actor_id: MEMBER, run_id: null },
		]);
		expect(await e2eBaseline()).toMatchObject({
			origin: "changes",
			nova_revision: before.seq + 1,
			observed_by: MEMBER,
		});

		const again = await review(scope, renamed(), false);
		expect(again).toMatchObject({ kind: "nothing", reason: "unchanged" });
	});

	/* A save that moves nothing but a form's id normalizes to the same source
	 * (the baseline keys forms by position), so only CommCare HQ's application
	 * resource tells it from no save. */
	it("records a new form id after a fold and reviews the next HQ edit against the original published revision", async () => {
		const scope = await broughtIn();
		await editName(scope.appId, OTHER, "My unpublished survey");
		const beforeConflict = changesOf(await review(scope, renamed()));
		expect(beforeConflict.novaChanges).toEqual(["The app's name"]);
		expect(await certifyFold(h.db(), scope.appId)).toMatchObject({ usable: 1 });
		const before = await readTargetIdentity(scope, KEY_TARGET);
		const NEW_FORM_ID = "f".repeat(32);
		const reidentified = changedAnswer(fixtureSource(), (body) => {
			const [menu] = body.modules as Record<string, unknown>[];
			const [form] = (menu?.forms ?? []) as Record<string, unknown>[];
			if (form === undefined) throw new Error("The fixture holds no form.");
			/* HQ keeps a form's source as the attachment its id names. */
			const attachments = body._attachments as Record<string, unknown>;
			attachments[`${NEW_FORM_ID}.xml`] = attachments[`${form.unique_id}.xml`];
			delete attachments[`${form.unique_id}.xml`];
			form.unique_id = NEW_FORM_ID;
			return body;
		});
		const listed = await review(scope, reidentified);
		expect(listed).toMatchObject({ kind: "nothing", reason: "reads-the-same" });
		if (listed.kind !== "nothing") throw new Error("A review of the same app.");
		expect(listed.hqChanges).toHaveLength(1);
		expect(listed.hqChanges[0]).toMatch(
			/has a new form id\. Nova follows it\.$/,
		);

		const outcome = await withHttpPeer(async (peer) => {
			serveRead(peer, reidentified, { tables: true });
			return bringInHqChanges(
				scope,
				KEY_TARGET,
				{
					readingId: listed.readingId ?? "",
					reviewDigest: listed.reviewDigest ?? "",
					tableChoices: {},
				},
				{ onEvent: () => {} },
			);
		});
		expect(outcome).toMatchObject({ kind: "recorded" });
		const after = await readTargetIdentity(scope, KEY_TARGET);
		const formRow = after.entities.find((row) => row.entityKind === "form");
		expect(formRow?.uniqueId).toBe(NEW_FORM_ID);
		/* The menu's row and every other part of the record stay as they were. */
		expect(after.entities.filter((row) => row.entityKind === "module")).toEqual(
			before.entities.filter((row) => row.entityKind === "module"),
		);
		expect(await review(scope, reidentified, false)).toMatchObject({
			kind: "nothing",
			reason: "unchanged",
		});
		const edited = changedAnswer(reidentified, (body) => ({
			...body,
			name: RENAMED,
		}));
		const afterConflict = changesOf(await review(scope, edited));
		expect(afterConflict.novaChanges).toEqual(beforeConflict.novaChanges);
		expect(afterConflict.hqChanges).toEqual(beforeConflict.hqChanges);
		expect(afterConflict.madeBy).toEqual(beforeConflict.madeBy);
	});

	const ICON = "menuicon";
	const WIRE_PATH = `commcare/image/${ICON}.png`;
	const ICON_PATH = `jr://file/${WIRE_PATH}`;
	const PNG = readFileSync(
		join(import.meta.dirname, "../../media/__tests__/fixtures/pattern.png"),
	);

	/** The fixture app, its menu showing `ICON`, brought in as a person does. */
	async function broughtInWithIcon() {
		await h.seedProjectMember(MEMBER, E2E_PROJECT, "owner");
		await seedFixtureConnection(MEMBER);
		const actor = await authorizeBringIn(MEMBER, E2E_PROJECT);
		if (actor === null) throw new Error(`${MEMBER} holds no edit.`);
		const key = fixtureKey(E2E_PROJECT);
		const answer = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, {
				source: withIcons(fixtureSource(), [ICON]),
				times: 2,
			});
			serveImage(peer, ICON, 2);
			const read = reviewOf(
				await readHqAppForReview(actor, key, { onEvent: () => {} }),
			);
			return createFromReview(actor, createInputFor(key, read), {
				onEvent: () => {},
			});
		});
		if (answer.kind !== "created")
			throw new Error(`The create answered ${JSON.stringify(answer)}`);
		return scopeOf(answer.receipt.appId, MEMBER);
	}

	/** CommCare HQ's bytes of the image `multimediaId`, `times` times: `bytes`, else the pattern. */
	function serveImage(
		peer: MockAgent,
		multimediaId: string,
		times: number,
		bytes: Buffer = PNG,
	) {
		peer
			.get(FIXTURE_HOST)
			.intercept({ path: FIXTURE_PATHS.media(multimediaId), method: "GET" })
			.reply(200, bytes, { headers: { "content-type": "image/png" } })
			.times(times);
	}

	it.each([
		["same-source", "replacement"],
		["already-here", "deletion"],
		["take", "replacement"],
		["take", "newly-resolved"],
		["take", "same"],
		["take", "disjoint"],
	] as const)(
		"checks reviewed media before a %s record when a concurrent upload reports %s",
		async (arm, change) => {
			const scope = await broughtInWithIcon();
			const original = withIcons(fixtureSource(), [ICON]);
			const source = changedAnswer(original, (body) => {
				if (arm !== "same-source") return { ...body, name: RENAMED };
				const form = (body.modules as { forms: { unique_id: string }[] }[])[0]
					.forms[0];
				const attachments = body._attachments as Record<string, unknown>;
				const id = "f".repeat(32);
				attachments[`${id}.xml`] = attachments[`${form.unique_id}.xml`];
				delete attachments[`${form.unique_id}.xml`];
				form.unique_id = id;
				return body;
			});
			if (arm === "already-here") await editName(scope.appId, MEMBER, RENAMED);
			const before = await head(scope.appId);
			const oldIdentity = await readTargetIdentity(scope, KEY_TARGET);
			const token = appMappingToken(await readDeployment(scope, KEY_TARGET));
			if (change === "newly-resolved") {
				const originalBaseline = await readAppBaseline(scope, KEY_TARGET);
				if (!originalBaseline || originalBaseline.origin === "unread")
					throw new Error("Expected the known image before clearing its id.");
				expect(
					await deploymentStore.recordDeploymentMediaFiles(scope, KEY_TARGET, {
						expectedEndings: 0,
						remoteAppId: originalBaseline.remoteAppId,
						sourceDigest: originalBaseline.sourceDigest,
						pushToken: token,
						novaRevision: originalBaseline.novaRevision,
						files: { read: originalBaseline.mediaFiles, next: {} },
					}),
				).toBe("recorded");
			}
			const listed =
				change === "newly-resolved"
					? await withHttpPeer(async (peer) => {
							serveRead(peer, source, { tables: true });
							serveImage(peer, ICON, 1);
							return reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} });
						})
					: await review(scope, source);
			if (
				(listed.kind !== "changes" && listed.kind !== "nothing") ||
				!listed.readingId ||
				!listed.reviewDigest
			)
				throw new Error(
					`Expected a reviewed ${arm}: ${JSON.stringify(listed)}`,
				);
			const sent = {
				readingId: listed.readingId,
				reviewDigest: listed.reviewDigest,
			};
			const baseline = await readAppBaseline(scope, KEY_TARGET);
			if (!baseline || baseline.origin === "unread")
				throw new Error("Expected an adopted baseline");
			const independent = "commcare/image/another.png";
			const files: Record<string, string> =
				change === "deletion"
					? {}
					: change === "disjoint"
						? { [WIRE_PATH]: ICON, [independent]: "other" }
						: {
								[WIRE_PATH]:
									change === "same" || change === "newly-resolved"
										? ICON
										: "replacement",
							};
			const changeMedia = async () => {
				expect(
					await deploymentStore.recordDeploymentMediaFiles(scope, KEY_TARGET, {
						expectedEndings: 0,
						remoteAppId: baseline.remoteAppId,
						sourceDigest: baseline.sourceDigest,
						pushToken: token,
						novaRevision: baseline.novaRevision,
						files: { read: baseline.mediaFiles, next: files },
					}),
				).toBe("recorded");
			};
			const refuse =
				change === "replacement" ||
				change === "deletion" ||
				change === "newly-resolved";
			const observed = async () =>
				h
					.db()
					.selectFrom("app_deployment_baselines")
					.selectAll()
					.select(sql<string>`xmin::text`.as("version"))
					.executeTakeFirstOrThrow();
			let afterMedia: Awaited<ReturnType<typeof observed>> | undefined;
			const interleave = async () => {
				await changeMedia();
				afterMedia = await observed();
			};
			if (arm === "take") seam.beforeCommit = interleave;
			const originalTake = deploymentStore.recordHqChangesTaken;
			const originalRefresh = deploymentStore.recordRefreshedAppBaseline;
			const take =
				arm === "already-here"
					? vi
							.spyOn(deploymentStore, "recordHqChangesTaken")
							.mockImplementationOnce(async (...args) => {
								await interleave();
								return originalTake(...args);
							})
					: null;
			const refresh =
				arm === "same-source"
					? vi
							.spyOn(deploymentStore, "recordRefreshedAppBaseline")
							.mockImplementationOnce(async (...args) => {
								await interleave();
								return originalRefresh(...args);
							})
					: null;
			try {
				await withHttpPeer(async (peer) => {
					serveRead(peer, source, { tables: true, times: refuse ? 2 : 1 });
					if (refuse) serveImage(peer, ICON, 1);
					const outcome = await bringIn(scope, sent);
					expect(outcome.kind).toBe(refuse ? "changed" : "brought-in");
				});
			} finally {
				take?.mockRestore();
				refresh?.mockRestore();
				seam.beforeCommit = null;
			}
			expect(afterMedia).toBeDefined();
			expect((await observed()).media_files).toEqual(files);
			if (refuse) {
				expect(await observed()).toEqual(afterMedia);
				expect(await readTargetIdentity(scope, KEY_TARGET)).toEqual(
					oldIdentity,
				);
				expect(await head(scope.appId)).toEqual(before);
				expect(await hqChangeRows(scope.appId)).toEqual([]);
			} else {
				expect((await head(scope.appId)).name).toBe(RENAMED);
				expect(await hqChangeRows(scope.appId)).toHaveLength(1);
			}
		},
	);

	describe("a file CommCare HQ added whose bytes the app already shows", () => {
		const SAME = "samebytes";

		it("names it by its content in both requests, so the bring-in takes what was reviewed", async () => {
			const scope = await broughtInWithIcon();
			const source = changedAnswer(
				withIcons(fixtureSource(), [ICON, SAME]),
				(body) => ({ ...body, name: RENAMED }),
			);
			const listed = changesOf(
				await withHttpPeer(async (peer) => {
					serveRead(peer, source, { tables: true });
					serveImage(peer, SAME, 1);
					return reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} });
				}),
			);
			const outcome = await withHttpPeer(async (peer) => {
				serveRead(peer, source, { tables: true });
				serveImage(peer, SAME, 1);
				return bringIn(scope, listed);
			});
			expect(outcome).toMatchObject({ kind: "brought-in" });
			const loaded = await loadApp(scope.appId);
			if (loaded === null) throw new Error("The app is gone.");
			const doc = hydratePersistedBlueprint(loaded.blueprint);
			/* The form shows the asset the menu already showed: one file, not two. */
			const assets = await h
				.db()
				.selectFrom("media_assets")
				.select("id")
				.where("project_id", "=", E2E_PROJECT)
				.execute();
			expect(assets).toHaveLength(1);
			expect([...collectAssetRefs(doc)]).toEqual([assets[0]?.id]);
			expect(
				await withHttpPeer(async (peer) => {
					serveRead(peer, source, { tables: false });
					return reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} });
				}),
			).toMatchObject({ kind: "nothing", reason: "unchanged" });
		});
	});

	describe("a file CommCare HQ replaced at a path the app holds", () => {
		const REPLACED = "replacedfile";

		it("takes the new file, moves the path's row to it, records its id, and a second review finds nothing", async () => {
			const scope = await broughtInWithIcon();
			const [held] = await mediaPathRows();
			expect(held?.wire_path).toBe(WIRE_PATH);
			/* Other bytes than the pattern's, so the file is a new one to the Project. */
			const other = await sharp({
				create: {
					width: 8,
					height: 13,
					channels: 3,
					background: { r: 12, g: 34, b: 56 },
				},
			})
				.png()
				.toBuffer();
			const source = changedAnswer(
				withIcons(fixtureSource(), [ICON]),
				(body) => {
					const map = body.multimedia_map as Record<
						string,
						Record<string, unknown>
					>;
					const entry = map[ICON_PATH];
					if (entry === undefined)
						throw new Error("The icon has no map entry.");
					entry.multimedia_id = REPLACED;
					return body;
				},
			);
			const listed = changesOf(
				await withHttpPeer(async (peer) => {
					serveRead(peer, source, { tables: true });
					/* Read once: settling the path by content keeps the bytes the
					 * reading then judges. */
					serveImage(peer, REPLACED, 1, other);
					return reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} });
				}),
			);
			const outcome = await withHttpPeer(async (peer) => {
				serveRead(peer, source, { tables: true });
				serveImage(peer, REPLACED, 1, other);
				return bringIn(scope, listed);
			});
			expect(outcome).toMatchObject({ kind: "brought-in" });

			const loaded = await loadApp(scope.appId);
			if (loaded === null) throw new Error("The app is gone.");
			const shown = [
				...collectAssetRefs(hydratePersistedBlueprint(loaded.blueprint)),
			];
			expect(shown).toHaveLength(1);
			expect(shown[0]).not.toBe(held?.media_asset_id);
			expect(await mediaPathRows()).toEqual([
				{ media_asset_id: shown[0], wire_path: WIRE_PATH },
			]);
			const files = await h
				.db()
				.selectFrom("app_deployment_baselines")
				.select("media_files")
				.executeTakeFirstOrThrow();
			expect(files.media_files).toEqual({ [WIRE_PATH]: REPLACED });
			expect(
				await withHttpPeer(async (peer) => {
					serveRead(peer, source, { tables: false });
					return reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} });
				}),
			).toMatchObject({ kind: "nothing", reason: "unchanged" });
		});
	});

	it("records a newly unused HQ mapping alongside an identical published image under a new file id", async () => {
		const scope = await broughtInWithIcon();
		const current = withUnusedImage(
			changedAnswer(withIcons(fixtureSource(), [ICON]), (body) => {
				const map = body.multimedia_map as Record<
					string,
					Record<string, unknown>
				>;
				const original = map[ICON_PATH];
				if (!original) throw new Error("The adopted menu image is missing.");
				original.multimedia_id = "same-image";
				return body;
			}),
		);
		const answer = <T>(request: () => Promise<T>) =>
			withHttpPeer(async (peer) => {
				serveRead(peer, current, { tables: true });
				serveImage(peer, "same-image", 1);
				return request();
			});
		const listed = await answer(() =>
			reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} }),
		);
		if (listed.kind !== "nothing" || !listed.readingId || !listed.reviewDigest)
			throw new Error(JSON.stringify(listed));
		expect(listed.publishChanges).not.toEqual([]);
		const approved = {
			readingId: listed.readingId,
			reviewDigest: listed.reviewDigest,
		};
		const recorded = await answer(() => bringIn(scope, approved));
		if (recorded.kind !== "recorded") throw new Error(JSON.stringify(recorded));
		expect(recorded.deployment?.firstPublish?.ids).toContain(
			"unused-media-entries-removed",
		);
		const baseline = await readAppBaseline(scope, KEY_TARGET);
		expect(baseline?.mediaFiles).toEqual({ [WIRE_PATH]: "same-image" });
	}, 30_000);

	describe("a recorded file whose new id CommCare HQ no longer serves", () => {
		const GONE = "gonefile";

		/** The source with the icon's map entry naming `GONE`, a file HQ answers 404 for. */
		function goneAt(
			change: (body: Record<string, unknown>) => Record<string, unknown> = (
				body,
			) => body,
		): RetainedHqAnswer {
			return changedAnswer(withIcons(fixtureSource(), [ICON]), (body) => {
				const map = body.multimedia_map as Record<
					string,
					Record<string, unknown>
				>;
				const entry = map[ICON_PATH];
				if (entry === undefined) throw new Error("The icon has no map entry.");
				entry.multimedia_id = GONE;
				return change(body);
			});
		}

		function serveGone(peer: MockAgent) {
			peer
				.get(FIXTURE_HOST)
				.intercept({ path: FIXTURE_PATHS.media(GONE), method: "GET" })
				.reply(404, "");
		}

		async function recordedFiles(): Promise<unknown> {
			const row = await h
				.db()
				.selectFrom("app_deployment_baselines")
				.select("media_files")
				.executeTakeFirstOrThrow();
			return row.media_files;
		}

		function peek(scope: ReturnType<typeof scopeOf>, source: RetainedHqAnswer) {
			return withHttpPeer(async (peer) => {
				serveAnswer(peer, FIXTURE_PATHS.source, source);
				return peekHqAppChanged(scope, KEY_TARGET, {});
			});
		}

		it("answers reads-the-same, forgets the id when recorded, and the check when the builder opens then finds nothing", async () => {
			const scope = await broughtInWithIcon();
			expect(await recordedFiles()).toEqual({ [WIRE_PATH]: ICON });
			const source = goneAt();
			expect(await peek(scope, source)).toBe("changed");

			const listed = await withHttpPeer(async (peer) => {
				serveRead(peer, source, { tables: false });
				serveGone(peer);
				return reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} });
			});
			expect(listed).toMatchObject({
				kind: "nothing",
				reason: "reads-the-same",
			});
			if (listed.kind !== "nothing" || listed.reviewDigest === null)
				throw new Error("The review gave no digest to send.");

			const outcome = await withHttpPeer(async (peer) => {
				serveRead(peer, source, { tables: false });
				serveGone(peer);
				return bringIn(scope, {
					readingId: listed.readingId ?? "",
					reviewDigest: listed.reviewDigest ?? "",
				});
			});
			expect(outcome.kind).toBe("recorded");
			expect(await recordedFiles()).toEqual({});
			expect(await peek(scope, source)).toBe("unchanged");

			const again = await withHttpPeer(async (peer) => {
				serveRead(peer, source, { tables: false });
				serveGone(peer);
				return reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} });
			});
			expect(again).toMatchObject({ kind: "nothing", reason: "unchanged" });
		});

		it("keeps no id for that path in the record a take writes", async () => {
			const scope = await broughtInWithIcon();
			const source = goneAt((body) => ({ ...body, name: RENAMED }));
			const listed = changesOf(
				await withHttpPeer(async (peer) => {
					serveRead(peer, source, { tables: true });
					serveGone(peer);
					return reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} });
				}),
			);
			expect(listed.hqChanges).toEqual(["The app's name"]);

			const outcome = await withHttpPeer(async (peer) => {
				serveRead(peer, source, { tables: true });
				serveGone(peer);
				return bringIn(scope, listed);
			});
			expect(outcome.kind).toBe("brought-in");
			expect(await recordedFiles()).toEqual({});
			expect(await peek(scope, source)).toBe("unchanged");
		});
	});

	/** The bring-in of `listed`, by `scope`'s member. */
	function bringIn(
		scope: ReturnType<typeof scopeOf>,
		listed: { readonly readingId: string; readonly reviewDigest: string },
	) {
		return bringInHqChanges(
			scope,
			KEY_TARGET,
			{
				readingId: listed.readingId,
				reviewDigest: listed.reviewDigest,
				tableChoices: {},
			},
			{ onEvent: () => {} },
		);
	}

	/** Holds each bring-in at its commit until `count` have reached it. */
	function meetAtCommit(count: number) {
		let arrived = 0;
		let release: () => void = () => {};
		const all = new Promise<void>((resolve) => {
			release = resolve;
		});
		seam.beforeCommit = async () => {
			arrived += 1;
			if (arrived === count) release();
			await all;
		};
	}

	/** A member's edit of the app's name, committed as an autosave is. */
	function editName(appId: string, member: string, name: string) {
		return applyBlueprintChangeProposal({
			appId,
			userId: member,
			expectedProjectId: E2E_PROJECT,
			batchId: crypto.randomUUID(),
			kind: "autosave",
			guard: { mutations: [{ kind: "setAppName", name }] },
		});
	}

	it("answers two requests of one member with one digest with one commit", async () => {
		const scope = await broughtIn();
		const before = await head(scope.appId);
		const listed = changesOf(await review(scope, renamed()));
		meetAtCommit(2);
		const [first, second] = await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true, times: 2 });
			return Promise.all([bringIn(scope, listed), bringIn(scope, listed)]);
		});
		expect(first).toMatchObject({ kind: "brought-in", seq: before.seq + 1 });
		expect(second).toMatchObject({ kind: "brought-in", seq: before.seq + 1 });
		expect(await hqChangeRows(scope.appId)).toHaveLength(1);
	});

	it("answers a second member's request that races the first as changed, naming who moved the app", async () => {
		const scope = await broughtIn();
		const before = await head(scope.appId);
		const listed = changesOf(await review(scope, renamed()));
		meetAtCommit(2);
		const outcomes = await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true, times: 2 });
			/* The one that lost reads CommCare HQ once more for the review as it stands. */
			serveRead(peer, renamed(), { tables: false });
			return Promise.all([
				bringIn(scope, listed),
				bringIn(scopeOf(scope.appId, OTHER), listed),
			]);
		});
		const won = outcomes.filter((outcome) => outcome.kind === "brought-in");
		const lost = outcomes.filter((outcome) => outcome.kind === "changed");
		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(1);
		/* Whichever press reached the kernel first, the other names its member. */
		const winner = outcomes[0]?.kind === "brought-in" ? MEMBER : OTHER;
		expect(lost[0]).toEqual({
			kind: "changed",
			now: expect.objectContaining({ kind: "nothing", reason: "unchanged" }),
			editedBy: winner,
		});
		expect(await hqChangeRows(scope.appId)).toHaveLength(1);
		expect((await head(scope.appId)).seq).toBe(before.seq + 1);
	});

	it("answers a retry sent after the commit as changed, with nothing left to bring in", async () => {
		const scope = await broughtIn();
		const listed = changesOf(await review(scope, renamed()));
		await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true });
			expect(await bringIn(scope, listed)).toMatchObject({
				kind: "brought-in",
			});
		});
		const retried = await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: false });
			return bringIn(scope, listed);
		});
		expect(retried).toEqual({
			kind: "changed",
			now: expect.objectContaining({ kind: "nothing", reason: "unchanged" }),
			editedBy: null,
		});
		expect(await hqChangeRows(scope.appId)).toHaveLength(1);
	});

	it("writes nothing where the head moved before the commit, and names who moved it", async () => {
		const scope = await broughtIn();
		const listed = changesOf(await review(scope, renamed()));
		const baselineBefore = await e2eBaseline();
		seam.beforeCommit = async () => {
			seam.beforeCommit = null;
			await editName(scope.appId, OTHER, "Survey, renamed in Nova");
		};
		const outcome = await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true, times: 2 });
			return bringIn(scope, listed);
		});
		expect(outcome).toMatchObject({
			kind: "changed",
			now: { kind: "changes", novaChanges: ["The app's name"] },
			editedBy: OTHER,
		});
		expect(await hqChangeRows(scope.appId)).toEqual([]);
		expect(await e2eBaseline()).toEqual(baselineBefore);
		expect((await head(scope.appId)).name).toBe("Survey, renamed in Nova");
	});

	it("writes nothing where a newer read of the app landed before the commit", async () => {
		const scope = await broughtIn();
		const before = await head(scope.appId);
		const listed = changesOf(await review(scope, renamed()));
		seam.beforeCommit = async () => {
			seam.beforeCommit = null;
			const current = await readAppBaseline(scope, KEY_TARGET);
			if (current === null || current.origin === "unread")
				throw new Error("The brought-in app holds a baseline.");
			/* Another read of the app recorded under the same pair, as far as
			 * the fences can tell a publish's read-back from it. */
			const moved = {
				...(current.source as Record<string, unknown>),
				name: "Survey, read again",
			};
			await recordRefreshedAppBaseline(scope, KEY_TARGET, {
				expectedEndings: 0,
				remoteAppId: current.remoteAppId,
				comparedPushToken: appMappingToken(
					await readDeployment(scope, KEY_TARGET),
				),
				comparedDigest: current.sourceDigest,
				read: stored(moved, new Date().toISOString()),
			});
		};
		const outcome = await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true, times: 2 });
			return bringIn(scope, listed);
		});
		expect(outcome).toMatchObject({
			kind: "changed",
			now: { kind: "changes" },
			editedBy: null,
		});
		expect(await hqChangeRows(scope.appId)).toEqual([]);
		expect(await head(scope.appId)).toEqual(before);
	});

	it("keeps a retired import from replacing a certified baseline before admission or after its hold expires", async () => {
		const scope = await broughtIn();
		const before = await head(scope.appId);
		const baseline = await readAppBaseline(scope, KEY_TARGET);
		if (!baseline || baseline.origin === "unread")
			throw new Error("Expected verified baseline");
		const token = appMappingToken(await readDeployment(scope, KEY_TARGET));
		const request = {
			compiledIdentity: await readTargetIdentity(scope, KEY_TARGET),
			expectedEndings: 0,
			remoteAppId: baseline.remoteAppId,
			observedPushToken: token,
			writeKind: "import" as const,
			compiledAtSeq: before.seq,
		};
		await editName(scope.appId, MEMBER, "Author’s later draft");
		const earlier = await admitAppWrite(scope, KEY_TARGET, request);
		if (earlier.kind !== "admitted")
			throw new Error(
				"An ordinary editor change should allow the compiled publish.",
			);
		await expect(certifyFold(h.db(), scope.appId)).rejects.toThrow(
			"An admitted app import is still open",
		);
		await h
			.db()
			.updateTable("hq_remote_writes")
			.set({
				opened_at: new Date("2026-01-01T00:00:00Z"),
				held_until: new Date("2026-01-01T00:06:00Z"),
			})
			.where("id", "=", earlier.writeId)
			.execute();
		await certifyFold(h.db(), scope.appId);
		const certified = await readAppBaseline(scope, KEY_TARGET);
		expect(certified).toMatchObject({
			foldBinding: { novaRevision: before.seq, foldSeq: before.seq + 2 },
		});
		await expect(admitAppWrite(scope, KEY_TARGET, request)).resolves.toEqual({
			kind: "fold-moved",
		});
		const at = new Date().toISOString();
		const result = await recordRemoteResource(
			scope,
			KEY_TARGET,
			{
				expectedEndings: 0,
				kind: "app",
				novaResourceId: scope.appId,
				remoteId: baseline.remoteAppId,
				ownership: "adopted",
				adoptedBy: MEMBER,
				pushedRevision: before.seq,
				remoteRevision: 53,
				uploadedAt: at,
				baseline: {
					origin: "push",
					remoteAppId: baseline.remoteAppId,
					...stored({ name: "delayed HQ import" }, at),
					novaRevision: before.seq,
					ownership: baseline.ownership,
					discard: null,
					mediaFiles: { kind: "keep" },
					firstPublish: { kind: "set", list: null },
				},
			},
			{
				writeIds: [earlier.writeId],
				settle: [{ writeIds: [earlier.writeId], how: { kind: "settled" } }],
			},
		);
		expect(result).toMatchObject({ pushToken: null, obsoleteFold: true });
		expect(await readAppBaseline(scope, KEY_TARGET)).toEqual(certified);
		expect(appMappingToken(await readDeployment(scope, KEY_TARGET))).toBe(
			token,
		);
		const next = await admitAppWrite(scope, KEY_TARGET, {
			...request,
			compiledAtSeq: (await head(scope.appId)).seq,
		});
		if (next.kind !== "admitted")
			throw new Error("The current publish should proceed");
		await settleRemoteWrites([next.writeId], { kind: "settled" });
	});

	it.each([false, true])(
		"rereads an already-here review when a fold lands after its head check, with a prior certificate = %s",
		async (prior) => {
			const scope = await broughtIn();
			await editName(scope.appId, MEMBER, RENAMED);
			if (prior) await certifyFold(h.db(), scope.appId);
			const before = await e2eBaseline();
			const at = await head(scope.appId);
			const list = async () => {
				const answer = await review(scope, renamed());
				if (
					answer.kind !== "nothing" ||
					answer.reason !== "already-here" ||
					!answer.readingId ||
					!answer.reviewDigest
				)
					throw new Error(
						"Expected a reviewed HQ rename already present in Nova",
					);
				return {
					readingId: answer.readingId,
					reviewDigest: answer.reviewDigest,
				};
			};
			const listed = await list();
			const record = deploymentStore.recordHqChangesTaken;
			const pass = vi
				.spyOn(deploymentStore, "recordHqChangesTaken")
				.mockImplementationOnce(async (...args) => {
					expect(args[0]).toEqual({ kind: "own", headSeq: at.seq });
					await certifyFold(
						h.db(),
						scope.appId,
						prior ? "hq-round-trip-case-writes" : "hq-round-trip-expressions",
					);
					return record(...args);
				});
			try {
				const changed = await withHttpPeer(async (peer) => {
					serveRead(peer, renamed(), { tables: true, times: 2 });
					return bringIn(scope, listed);
				});
				expect(changed).toMatchObject({
					kind: "changed",
					now: { kind: "nothing", reason: "already-here" },
				});
				expect(pass).toHaveBeenCalledOnce();
			} finally {
				pass.mockRestore();
			}
			expect(await e2eBaseline()).toEqual(before);
			expect(await readAppBaseline(scope, KEY_TARGET)).toMatchObject({
				foldBinding: {
					foldSeq: at.seq + 1,
					novaRevision: before.nova_revision,
					sourceDigest: before.source_digest,
				},
			});
			expect(await hqChangeRows(scope.appId)).toEqual([]);
			const fresh = await list();
			const recorded = await withHttpPeer(async (peer) => {
				serveRead(peer, renamed(), { tables: true });
				return bringIn(scope, fresh);
			});
			expect(recorded.kind).toBe("recorded");
			expect(await e2eBaseline()).toMatchObject({
				origin: "changes",
				nova_revision: at.seq + 1,
			});
			const accepted = await readAppBaseline(scope, KEY_TARGET);
			if (!accepted || accepted.origin === "unread")
				throw new Error("Missing accepted baseline");
			expect(accepted.foldBinding).toBeUndefined();
			expect(await hqChangeRows(scope.appId)).toEqual([]);
		},
	);

	it("records the pair at the reviewed head and writes no app change where the app already holds the change", async () => {
		const scope = await broughtIn();
		await editName(scope.appId, MEMBER, RENAMED);
		const at = await head(scope.appId);
		const listed = await review(scope, renamed());
		expect(listed).toMatchObject({ kind: "nothing", reason: "already-here" });
		if (listed.kind !== "nothing" || listed.reviewDigest === null)
			throw new Error("The review gave no digest to send.");
		const outcome = await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true });
			return bringIn(scope, {
				readingId: listed.readingId ?? "",
				reviewDigest: listed.reviewDigest ?? "",
			});
		});
		expect(outcome.kind).toBe("recorded");
		expect(await hqChangeRows(scope.appId)).toEqual([]);
		expect(await head(scope.appId)).toEqual(at);
		expect(await e2eBaseline()).toMatchObject({
			origin: "changes",
			nova_revision: at.seq,
		});
		expect(await review(scope, renamed(), false)).toMatchObject({
			kind: "nothing",
			reason: "unchanged",
		});
	});

	it("answers the review as it stands, the app in recently deleted, where the app was deleted while the bring-in read CommCare HQ, and records nothing", async () => {
		const scope = await broughtIn();
		await editName(scope.appId, MEMBER, RENAMED);
		const at = await head(scope.appId);
		const listed = await review(scope, renamed());
		if (listed.kind !== "nothing" || listed.reviewDigest === null)
			throw new Error("The review gave no digest to send.");
		const before = await e2eBaseline();
		const source = renamed();
		const outcome = await withHttpPeer(async (peer) => {
			const resource = fixtureResource(source);
			serveAnswer(peer, FIXTURE_PATHS.application, resource);
			serveAnswer(peer, FIXTURE_PATHS.version, counterOf(resource));
			/* The app goes to recently deleted while CommCare HQ answers, and
			 * nothing more is asked of it. */
			peer
				.get(FIXTURE_HOST)
				.intercept({ path: FIXTURE_PATHS.source, method: "GET" })
				.reply(async () => {
					await softDeleteApp(scope.appId, MEMBER);
					return {
						statusCode: source.status,
						data: retainedBodyText(source),
						responseOptions: { headers: { ...source.headers } },
					};
				});
			return bringIn(scope, {
				readingId: listed.readingId ?? "",
				reviewDigest: listed.reviewDigest ?? "",
			});
		});
		expect(outcome).toEqual({
			kind: "changed",
			now: { kind: "unavailable", reason: "app-deleted", since: null },
		});
		await restoreApp(scope.appId, MEMBER);
		expect(await head(scope.appId)).toEqual(at);
		expect(await e2eBaseline()).toEqual(before);
	});

	it("answers that nothing made in Nova was lost where Nova already holds part of CommCare HQ's change", async () => {
		const scope = await broughtIn();
		/* The same name in Nova and in CommCare HQ: Nova holds a change it has
		 * not published, and taking CommCare HQ's version loses none of it. */
		await editName(scope.appId, MEMBER, RENAMED);
		const source = changedAnswer(fixtureSource(), (body) => {
			const [menu] = body.modules as Record<string, unknown>[];
			if (menu === undefined) throw new Error("The fixture holds no menu.");
			menu.name = { en: "Visits, renamed in CommCare HQ" };
			return { ...body, name: RENAMED };
		});
		const listed = changesOf(await review(scope, source));
		expect(listed.novaChanges).toEqual([]);
		const before = await head(scope.appId);
		const outcome = await withHttpPeer(async (peer) => {
			serveRead(peer, source, { tables: true });
			return bringIn(scope, listed);
		});
		expect(outcome).toMatchObject({
			kind: "brought-in",
			seq: before.seq + 1,
			discarded: false,
		});
		expect(await head(scope.appId)).toEqual({
			seq: before.seq + 1,
			name: RENAMED,
		});
	});

	it("answers a bring-in that landed as brought in where the record cannot be read after it, with no record", async () => {
		const scope = await broughtIn();
		const listed = changesOf(await review(scope, renamed()));
		const words = "Survey, renamed in CommCare HQ";
		vi.mocked(setupArtifactFor).mockRejectedValueOnce(
			Object.assign(new Error(`could not read “${words}”`), {
				code: "57P01",
			}),
		);
		const errors = vi.spyOn(log, "error");
		try {
			const outcome = await withHttpPeer(async (peer) => {
				serveRead(peer, renamed(), { tables: true });
				return bringIn(scope, listed);
			});
			expect(outcome).toMatchObject({ kind: "brought-in", deployment: null });
			expect(await head(scope.appId)).toMatchObject({ name: RENAMED });
			expect(errors).toHaveBeenCalledWith(
				"[hq-changes] setup artifact unavailable after a bring-in",
				undefined,
				expect.objectContaining({ errorName: "Error" }),
			);
			expect(JSON.stringify(errors.mock.calls)).not.toContain(words);
		} finally {
			errors.mockRestore();
		}
	});

	it("answers a bring-in sent after publishing there stopped in its own words, and takes nothing", async () => {
		const scope = await broughtIn();
		const before = await head(scope.appId);
		const listed = changesOf(await review(scope, renamed()));
		await stopHere(scope, KEY_TARGET);
		const outcome = await bringIn(scope, listed);
		expect(outcome).toEqual({
			kind: "refused",
			message: hqChangesPublishingStoppedLine(FIXTURE_DOMAIN),
		});
		expect(await head(scope.appId)).toEqual(before);
		expect(await hqChangeRows(scope.appId)).toEqual([]);
	});

	it("brings a change in over a table whose tag was changed in Nova since the publish, keeping the table the app reads", async () => {
		const scope = await broughtIn();
		/* In Nova: the table the published app reads, managed in Nova and given another tag. */
		const lookupScope = {
			projectId: E2E_PROJECT,
			actorId: MEMBER,
			role: "owner",
		};
		const tables = await h
			.db()
			.selectFrom("lookup_tables")
			.select(["id", "tag"])
			.where("project_id", "=", E2E_PROJECT)
			.execute();
		expect(tables.map((table) => table.tag)).toEqual(["district"]);
		const tableId = lookupTableIdSchema.parse(tables[0]?.id);
		const tableReview = await readManagedTableReview(E2E_PROJECT, tableId);
		expect(
			await manageLookupTableInNova(
				lookupScope,
				tableId,
				tableReview?.reviewDigest ?? "",
			),
		).toMatchObject({ ok: true });
		const held = await getLookupTable(lookupScope, tableId);
		await updateLookupTableTag(lookupScope, {
			tableId,
			expectedTableRevision: held.tableRevision,
			tag: "region",
		});
		/* In CommCare HQ: the app renamed, still reading the table by the tag
		 * Nova published, which CommCare HQ still lists. Both readings read that
		 * table, so the base reads, and the new tag is no change of the app's:
		 * the document names the table by its id. */
		const listed = changesOf(await review(scope, renamed()));
		expect(listed.hqChanges).toEqual(["The app's name"]);
		expect(listed.novaChanges).toEqual([]);
		expect(listed.tables).toEqual([]);
		const outcome = await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true });
			return bringIn(scope, listed);
		});
		expect(outcome).toMatchObject({ kind: "brought-in" });
		expect(await head(scope.appId)).toMatchObject({ name: RENAMED });
		/* The app still reads the table under its new tag, and no table is added. */
		const loaded = await loadApp(scope.appId);
		if (loaded === null) throw new Error("The app is gone.");
		expect(JSON.stringify(loaded.blueprint)).toContain(tableId);
		expect(
			(
				await h
					.db()
					.selectFrom("lookup_tables")
					.select("tag")
					.where("project_id", "=", E2E_PROJECT)
					.execute()
			).map((table) => table.tag),
		).toEqual(["region"]);
	});

	it("answers a review where publishing there stopped, and one of a project space never published to, each in its own words, asking CommCare HQ nothing", async () => {
		const scope = await broughtIn();
		const elsewhere = { server: FIXTURE_SERVER, domain: "never-here" } as const;
		await withHttpPeer(async () => {
			expect(
				await reviewHqChanges(scope, elsewhere, { onEvent: () => {} }),
			).toEqual({ kind: "unavailable", reason: "not-published", since: null });
		});
		await stopHere(scope, KEY_TARGET);
		await withHttpPeer(async () => {
			expect(
				await reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} }),
			).toEqual({
				kind: "unavailable",
				reason: "publishing-stopped",
				since: null,
			});
		});
	});

	it("answers a review of an app deleted after it was authorized, whose CommCare HQ app another app's birth took, in its own words, asking CommCare HQ nothing, and the review once it is restored", async () => {
		/* The route and the tool authorize a live app first; the app goes to
		 * recently deleted and another app is born on its HQ app before the
		 * review reads the deployment. */
		const scope = await broughtIn();
		await softDeleteApp(scope.appId, MEMBER);
		const { appId: taker } = await adoptFixtureApp({
			projectId: E2E_PROJECT,
			actorUserId: MEMBER,
		});
		expect(taker).not.toBe(scope.appId);
		await withHttpPeer(async () => {
			expect(
				await reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} }),
			).toEqual({ kind: "unavailable", reason: "app-deleted", since: null });
		});
		/* Restored while the taker publishes there: the restore ends this
		 * deployment, and the review says publishing there stopped. */
		expect(await restoreApp(scope.appId, MEMBER)).toEqual({
			stoppedPublishing: [{ server: FIXTURE_SERVER, domain: FIXTURE_DOMAIN }],
		});
		await withHttpPeer(async () => {
			expect(
				await reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} }),
			).toEqual({
				kind: "unavailable",
				reason: "publishing-stopped",
				since: null,
			});
		});
	});

	it("answers a review of a restored app whose CommCare HQ app another app took while it was deleted, and still writes to, in its own words, asking CommCare HQ nothing", async () => {
		const scope = await broughtIn();
		await softDeleteApp(scope.appId, MEMBER);
		const { appId: taker } = await adoptFixtureApp({
			projectId: E2E_PROJECT,
			actorUserId: MEMBER,
		});
		const write = await admitAppWrite(scopeOf(taker, MEMBER), KEY_TARGET, {
			compiledIdentity: await readTargetIdentity(
				scopeOf(taker, MEMBER),
				KEY_TARGET,
			),
			observedPushToken: appMappingToken(
				await readDeployment(scopeOf(taker, MEMBER), KEY_TARGET),
			),
			expectedEndings: 0,
			remoteAppId: FIXTURE_REMOTE_APP_ID,
			writeKind: "media",
		});
		if (write.kind !== "admitted")
			throw new Error(`The taker's write was not admitted: ${write.kind}`);
		/* The taker goes to recently deleted with its write open, so the restore
		 * leaves this app's claim released. */
		await softDeleteApp(taker, MEMBER);
		expect(await restoreApp(scope.appId, MEMBER)).toEqual({
			stoppedPublishing: [],
		});
		await withHttpPeer(async () => {
			expect(
				await reviewHqChanges(scope, KEY_TARGET, { onEvent: () => {} }),
			).toEqual({ kind: "unavailable", reason: "hq-app-taken", since: null });
		});
		await settleRemoteWrites([write.writeId], { kind: "settled" });
	});

	it("measures a change in Nova against the document an earlier bring-in of changes left", async () => {
		const scope = await broughtIn();
		const listed = changesOf(await review(scope, renamed()));
		await withHttpPeer(async (peer) => {
			serveRead(peer, renamed(), { tables: true });
			expect(await bringIn(scope, listed)).toMatchObject({
				kind: "brought-in",
			});
		});
		await editName(scope.appId, OTHER, "Survey, renamed in Nova");
		const again = changesOf(
			await review(scope, renamed("Survey, renamed in CommCare HQ again")),
		);
		expect(again.hqChanges).toEqual(["The app's name"]);
		expect(again.novaChanges).toEqual(["The app's name"]);
		expect(again.madeBy).toEqual([OTHER]);
		expect(again.since).toEqual({ kind: "changes-brought-in" });
	});
});

// ---------------------------------------------------------------------------
// The review and the bring-in over Nova's own emission
// ---------------------------------------------------------------------------

/**
 * A case app brought in from CommCare HQ, where CommCare HQ serves Nova's own
 * emission of a document (`servedHqApp.ts`), and then serves the emission of
 * an edited document as the change a person made there. The application
 * resource summarizes each form from the source it serves, as
 * `ApplicationResource.dehydrate_module` does (`proof/corpus/hqSummary.ts`),
 * so acceptance's agreement with CommCare HQ's summary holds of both.
 */
describe("a bring-in of changes made in CommCare HQ to a case app", () => {
	const MEMBER = "hq-emission-member";
	const E2E_PROJECT = "project-hq-emission";
	const KEY_TARGET = {
		server: FIXTURE_SERVER,
		domain: FIXTURE_DOMAIN,
	} as const;
	const NAME = f({
		uuid: "emission-name",
		kind: "text",
		id: "name",
		label: "Name",
		caseWrite: { caseType: "patient", property: "case_name" },
	});
	const WEIGHT = f({
		uuid: "emission-weight",
		kind: "text",
		id: "weight",
		label: "Weight",
		caseWrite: { caseType: "patient", property: "weight" },
	});
	const NOTE = f({
		uuid: "emission-note",
		kind: "text",
		id: "note",
		label: "Note",
		caseWrite: { caseType: "patient", property: "note" },
	});

	/**
	 * The clinic: patients registered with a weight and visited with a note,
	 * `households` where given, and where `village` is given, the patients'
	 * menu shown only to a worker of the village that names, a worker
	 * property the app declares.
	 */
	function clinic(options: {
		readonly weight?: boolean;
		readonly declaresWeight?: boolean;
		readonly households?: boolean;
		readonly village?: string;
		readonly appName?: string;
	}): BlueprintDoc {
		return buildDoc({
			appId: "emission-app",
			appName: options.appName ?? "Clinic",
			...(options.village !== undefined && { workerProperties: ["village"] }),
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "note", label: "Note" },
						...(options.declaresWeight === true
							? [{ name: "weight", label: "Weight" }]
							: []),
					],
				},
				...(options.households === true
					? [{ name: "household", properties: [] }]
					: []),
			],
			modules: [
				{
					uuid: "emission-patients",
					name: "Patients",
					caseType: "patient",
					...(options.village !== undefined && {
						displayCondition: eq(
							sessionUser("village"),
							literal(options.village),
						),
					}),
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "emission-register",
							name: "Register",
							type: "registration",
							fields: options.weight === false ? [NAME] : [NAME, WEIGHT],
						},
						{
							uuid: "emission-visit",
							name: "Visit",
							type: "followup",
							fields: [NOTE],
						},
					],
				},
				...(options.households === true
					? [
							{
								uuid: "emission-households",
								name: "Households",
								caseType: "household",
								caseListConfig: caseListConfig([
									{ field: "case_name", header: "Name" },
								]),
								forms: [
									{
										uuid: "emission-household-register",
										name: "Register household",
										type: "registration" as const,
										fields: [
											f({
												uuid: "emission-household-name",
												kind: "text",
												id: "household_name",
												label: "Household",
												caseWrite: {
													caseType: "household",
													property: "case_name",
												},
											}),
										],
									},
								],
							},
						]
					: []),
			],
		});
	}

	/** CommCare HQ's source and application resource for `doc`'s emission at save counter `version`. */
	const emission = (doc: BlueprintDoc, version: number) =>
		servedHqApp(doc, version);
	const serveEmission = serveHqApp;

	const scope = (appId: string) => ({
		appId,
		projectId: E2E_PROJECT,
		role: "owner",
		actorUserId: MEMBER,
	});

	/** `doc`'s emission (as `served` where given) brought in through the production read and create. */
	async function broughtIn(
		doc: BlueprintDoc,
		served = emission(doc, 2),
	): Promise<string> {
		await h.seedProjectMember(MEMBER, E2E_PROJECT, "owner");
		await seedFixtureConnection(MEMBER);
		const actor = await authorizeBringIn(MEMBER, E2E_PROJECT);
		if (actor === null) throw new Error("The member may edit the Project.");
		const key = fixtureKey(E2E_PROJECT);
		return withHttpPeer(async (peer) => {
			serveEmission(peer, served, 2);
			const read = reviewOf(
				await readHqAppForReview(actor, key, { onEvent: () => {} }),
			);
			const created = await createFromReview(actor, createInputFor(key, read), {
				onEvent: () => {},
			});
			if (created.kind !== "created")
				throw new Error(`The create answered ${JSON.stringify(created)}`);
			return created.receipt.appId;
		});
	}

	/** The review of CommCare HQ serving `changed` (as `served` where given), and the bring-in of what it lists. */
	async function reviewAndBringIn(
		appId: string,
		changed: BlueprintDoc,
		served: ReturnType<typeof emission> = emission(changed, 3),
	) {
		const listed = await withHttpPeer(async (peer) => {
			serveEmission(peer, served);
			return reviewHqChanges(scope(appId), KEY_TARGET, {
				onEvent: () => {},
			});
		});
		if (listed.kind !== "changes")
			throw new Error(`The review answered ${JSON.stringify(listed)}`);
		const outcome = await withHttpPeer(async (peer) => {
			serveEmission(peer, served);
			return bringInHqChanges(
				scope(appId),
				KEY_TARGET,
				{
					readingId: listed.readingId,
					reviewDigest: listed.reviewDigest,
					tableChoices: {},
				},
				{ onEvent: () => {} },
			);
		});
		return { listed, outcome };
	}

	/** The case store's tables, which the app database's type does not name. */
	const caseDb = () => h.db() as unknown as Kysely<CaseDatabase>;

	async function schemaRow(appId: string, caseType: string) {
		return caseDb()
			.selectFrom("case_type_schemas")
			.select(["is_active", "synced_seq", "retired_seq"])
			.where("app_id", "=", appId)
			.where("case_type", "=", caseType)
			.executeTakeFirst();
	}

	async function casesOf(appId: string, caseType: string) {
		return caseDb()
			.selectFrom("cases")
			.select(["case_id", "properties"])
			.where("app_id", "=", appId)
			.where("case_type", "=", caseType)
			.execute();
	}

	async function savedCase(
		appId: string,
		caseType: string,
		properties: Record<string, string>,
	) {
		const store = await withProjectContext(E2E_PROJECT, MEMBER, MEMBER);
		await store.insert({
			appId,
			row: {
				case_id: `${caseType}-one`,
				case_type: caseType,
				case_name: "One",
				status: "open",
				properties,
			},
		});
	}

	async function headDocOf(appId: string): Promise<BlueprintDoc> {
		const loaded = await loadApp(appId);
		if (loaded === null) throw new Error(`No app ${appId}.`);
		return hydratePersistedBlueprint(loaded.blueprint);
	}

	it("brings in a case type CommCare HQ added, and leaves its schema synced at the commit", async () => {
		const appId = await broughtIn(clinic({}));
		expect(await schemaRow(appId, "household")).toBeUndefined();
		const { outcome } = await reviewAndBringIn(
			appId,
			clinic({ households: true }),
		);
		if (outcome.kind !== "brought-in")
			throw new Error(`The bring-in answered ${JSON.stringify(outcome)}`);
		expect(
			(await headDocOf(appId)).caseTypes?.map((type) => type.name),
		).toContain("household");
		expect(await schemaRow(appId, "household")).toEqual({
			is_active: true,
			synced_seq: String(outcome.seq),
			retired_seq: null,
		});
	});

	it("leaves the schema of a case type CommCare HQ dropped inactive, and its saved cases in place", async () => {
		const appId = await broughtIn(clinic({ households: true }));
		await savedCase(appId, "household", {});
		expect(await schemaRow(appId, "household")).toMatchObject({
			is_active: true,
		});
		const { listed, outcome } = await reviewAndBringIn(appId, clinic({}));
		expect(listed.caseData).toHaveLength(1);
		if (outcome.kind !== "brought-in")
			throw new Error(`The bring-in answered ${JSON.stringify(outcome)}`);
		expect(await schemaRow(appId, "household")).toMatchObject({
			is_active: false,
			retired_seq: String(outcome.seq),
		});
		expect(await casesOf(appId, "household")).toHaveLength(1);
	});

	it("commits a change that stops naming a declared property over cases that hold a value for it", async () => {
		const appId = await broughtIn(clinic({ declaresWeight: true }));
		await savedCase(appId, "patient", { weight: "61" });
		const { outcome } = await reviewAndBringIn(
			appId,
			clinic({ declaresWeight: true, weight: false }),
		);
		expect(outcome).toMatchObject({ kind: "brought-in", discarded: false });
		const patient = (await headDocOf(appId)).caseTypes?.find(
			(type) => type.name === "patient",
		);
		expect(patient?.properties.map((property) => property.name)).toContain(
			"weight",
		);
		expect(await casesOf(appId, "patient")).toEqual([
			{ case_id: "patient-one", properties: { weight: "61" } },
		]);
	});

	/** Every row a take writes, and the app's head, to show a refused take wrote none of it. */
	async function everythingTaken(appId: string) {
		const db = h.db();
		return {
			head: await db
				.selectFrom("apps")
				.select("mutation_seq")
				.where("id", "=", appId)
				.executeTakeFirstOrThrow(),
			doc: toPersistableDoc(await headDocOf(appId)),
			changes: await db
				.selectFrom("app_changes")
				.select(["seq", "kind"])
				.where("app_id", "=", appId)
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
			schemas: await caseDb()
				.selectFrom("case_type_schemas")
				.selectAll()
				.where("app_id", "=", appId)
				.execute(),
		};
	}

	it("answers the gate's refusal with each finding's own sentence, and writes nothing", async () => {
		const appId = await broughtIn(clinic({ households: true }));
		/* An automation, which CommCare HQ's app never carries, works on the
		 * case type CommCare HQ's change stops using. */
		await applyBlueprintChangeProposal({
			appId,
			userId: MEMBER,
			expectedProjectId: E2E_PROJECT,
			batchId: crypto.randomUUID(),
			kind: "autosave",
			guard: {
				mutations: [
					{
						kind: "addAutomation",
						automation: {
							uuid: testUuid("emission-automation"),
							kind: "case-update",
							name: "Close named households",
							caseType: "household",
							criteriaOperator: "all",
							criteria: [
								{
									uuid: testUuid("emission-criterion"),
									kind: "match-property",
									scope: "case",
									property: "case_name",
									matchType: "equal",
									value: "Gone",
								},
							],
							setupOnlyCriteria: [],
							updates: [],
							closeCase: true,
						},
					},
				],
			},
		});
		const before = await everythingTaken(appId);
		const { listed, outcome } = await reviewAndBringIn(appId, clinic({}));
		expect(listed.novaChanges).toEqual([]);
		if (outcome.kind !== "gate")
			throw new Error(`The bring-in answered ${JSON.stringify(outcome)}`);
		/* One finding, in the builder's voice for the panel (`userFacingError`,
		 * as the publish dialog's preflight says the same finding) and the
		 * validator's own sentence for MCP. */
		expect(outcome).toEqual({
			kind: "gate",
			findings: [
				"This automation no longer fits the app. Open it and replace any case, form, place, or worker information that has changed.",
			],
			details: [
				"Automation “Close named households” is not valid. Case type “household” does not exist.",
			],
		});
		expect(await everythingTaken(appId)).toEqual(before);
	});

	it("answers the gate with the slug's own finding where a property made in Nova took a published slug, and writes nothing", async () => {
		const appId = await broughtIn(clinic({ village: "north" }));
		const published = Object.values(
			(await headDocOf(appId)).userProperties ?? {},
		);
		expect(published.map((property) => property.slug)).toEqual(["village"]);
		const [village] = published;
		if (village === undefined) throw new Error("The app reads no village.");
		/* In Nova: the published property renamed, and a new one under its old slug. */
		await applyBlueprintChangeProposal({
			appId,
			userId: MEMBER,
			expectedProjectId: E2E_PROJECT,
			batchId: crypto.randomUUID(),
			kind: "autosave",
			guard: {
				mutations: [
					{
						kind: "updateUserProperty",
						uuid: village.uuid,
						patch: { slug: "home" },
					},
					{
						kind: "addUserProperty",
						property: {
							uuid: testUuid("emission-village-again"),
							slug: "village",
							label: "Village again",
						},
						after: village.uuid,
					},
				],
			},
		});
		const before = await everythingTaken(appId);
		/* In CommCare HQ: the app renamed, its menu still read by the published slug. */
		const { listed, outcome } = await reviewAndBringIn(
			appId,
			clinic({ village: "north", appName: "Clinic, renamed in HQ" }),
		);
		expect(listed.hqChanges).toEqual(["The app's name"]);
		if (outcome.kind !== "gate")
			throw new Error(`The bring-in answered ${JSON.stringify(outcome)}`);
		/* The slug binds to the property the published document held, so the
		 * target holds both under it: the builder says the slug once, and MCP
		 * names each property. */
		expect(outcome).toEqual({
			kind: "gate",
			findings: [
				'Two pieces of worker information both save under "village". CommCare treats names as the same whatever their capitalization, so give one of them a different name.',
			],
			details: [
				'"village" saves under the name "village", which is also used by another piece of worker information. CommCare treats capitalization as the same, so give each one a different name.',
				'"Village again" saves under the name "village", which is also used by another piece of worker information. CommCare treats capitalization as the same, so give each one a different name.',
			],
		});
		expect(await everythingTaken(appId)).toEqual(before);
	});

	async function baselineOfApp() {
		const row = await h
			.db()
			.selectFrom("app_deployment_baselines")
			.select([
				"origin",
				"nova_revision",
				"source_digest",
				"first_publish_changes",
			])
			.executeTakeFirstOrThrow();
		return { ...row, nova_revision: Number(row.nova_revision) };
	}

	/** `served` with every form's XML re-spelled as CommCare HQ's form builder may save it. */
	function respelled(
		served: ReturnType<typeof emission>,
	): ReturnType<typeof emission> {
		return {
			...served,
			source: changedAnswer(served.source, (body) => {
				const attachments = body._attachments as Record<string, string>;
				for (const name of Object.keys(attachments))
					attachments[name] = (attachments[name] as string)
						.split("</h:head>")
						.join("</h:head>\n  ");
				return body;
			}),
		};
	}

	it("records a save that reads as the same app, keeping the origin, the revision and the first publish's list", async () => {
		const doc = clinic({});
		const appId = await broughtIn(doc);
		const before = await baselineOfApp();
		const saved = respelled(emission(doc, 3));
		const listed = await withHttpPeer(async (peer) => {
			serveEmission(peer, saved);
			return reviewHqChanges(scope(appId), KEY_TARGET, { onEvent: () => {} });
		});
		expect(listed).toMatchObject({ kind: "nothing", reason: "reads-the-same" });
		if (listed.kind !== "nothing" || listed.reviewDigest === null)
			throw new Error("The review gave no digest to send.");
		const headBefore = (await loadApp(appId))?.mutation_seq;
		const outcome = await withHttpPeer(async (peer) => {
			serveEmission(peer, saved);
			return bringInHqChanges(
				scope(appId),
				KEY_TARGET,
				{
					readingId: listed.readingId ?? "",
					reviewDigest: listed.reviewDigest ?? "",
					tableChoices: {},
				},
				{ onEvent: () => {} },
			);
		});
		expect(outcome.kind).toBe("recorded");
		expect((await loadApp(appId))?.mutation_seq).toBe(headBefore);
		const after = await baselineOfApp();
		expect(after).toEqual({
			...before,
			source_digest: expect.any(String),
		});
		expect(after.source_digest).not.toBe(before.source_digest);
		expect(
			await withHttpPeer(async (peer) => {
				serveEmission(peer, saved, 1, false);
				return reviewHqChanges(scope(appId), KEY_TARGET, {
					onEvent: () => {},
				});
			}),
		).toMatchObject({ kind: "nothing", reason: "unchanged" });
	});

	/** The add-ons the baseline's ownership holds. */
	async function ownedAddOns(): Promise<readonly string[]> {
		const row = await h
			.db()
			.selectFrom("app_deployment_baselines")
			.select("ownership")
			.executeTakeFirstOrThrow();
		const addOns = row.ownership?.addOns;
		if (!Array.isArray(addOns))
			throw new Error("The baseline holds no ownership with add-ons.");
		return addOns.filter((addOn) => typeof addOn === "string");
	}

	/** Every confirmation a publish can ask for: these cases are about what it compares. */
	const CONFIRM_ALL = PLAN_FEATURE_IDS.map((subject) => ({
		kind: "plan-feature" as const,
		subject,
	}));
	const IMPORT_PATH = `/a/${FIXTURE_DOMAIN}/apps/api/import_app/`;
	const PROJECT_SPACES = "/api/user_domains/v1/?limit=100";

	/**
	 * The app's head published to the project space through the one publish
	 * lifecycle, over a CommCare HQ that serves `source` for every read of
	 * the app and, where `accepts`, takes the update. The project-space list
	 * every preflight reads names the project space, so the account is still a
	 * member there, and every list filtered by a flag names none, so the
	 * target writes no empty-list text. Where it accepts, the read back is
	 * `readBack` (else `source`).
	 * Answers the outcome, the app's own requests in order, and the app JSON
	 * each import carried.
	 */
	async function publishOver(
		appId: string,
		source: RetainedHqAnswer,
		accepts: boolean,
		readBack: RetainedHqAnswer | TargetPeer = source,
		versionBefore = 3,
	) {
		const loaded = await loadApp(appId);
		if (loaded === null) throw new Error(`No app ${appId}.`);
		const doc = hydratePersistedBlueprint(loaded.blueprint);
		const saves = new HqSaveCounter();
		saves.standAt(FIXTURE_REMOTE_APP_ID, versionBefore);
		/** The app JSON each import carried. */
		const imported: Record<string, unknown>[] = [];
		return withHqPeer(saves, FIXTURE_HOST, async (peer) => {
			peer
				.get(FIXTURE_HOST)
				.intercept({
					path: (path) => path.startsWith(PROJECT_SPACES),
					method: "GET",
				})
				.reply((request) => {
					const objects =
						request.path === PROJECT_SPACES
							? [{ domain_name: FIXTURE_DOMAIN, project_name: "Clinic" }]
							: [];
					return {
						statusCode: 200,
						data: JSON.stringify({
							meta: { next: null, total_count: objects.length },
							objects,
						}),
					};
				})
				.persist();
			serveAnswer(peer, FIXTURE_PATHS.source, source);
			if (accepts && !(readBack instanceof TargetPeer))
				serveAnswer(peer, FIXTURE_PATHS.source, readBack);
			if (accepts)
				peer
					.get(FIXTURE_HOST)
					.intercept({ path: IMPORT_PATH, method: "POST" })
					.reply(async (request) => {
						const body = await readHttpRequestBody(request);
						const file = (await readMultipartRequest({ ...request, body })).get(
							"app_file",
						);
						if (!(file instanceof Blob))
							throw new Error("The import carried no app file.");
						imported.push(JSON.parse(await file.text()));
						if (readBack instanceof TargetPeer) {
							const answer = await readBack.answer({
								method: request.method,
								path: request.path,
								contentType:
									new Headers(request.headers as Record<string, string>).get(
										"content-type",
									) ?? undefined,
								body,
							});
							const updated = readBack.snapshot().source;
							const counter = readBack.saveCounter();
							if (
								!updated ||
								counter === null ||
								answer.status !== 200 ||
								typeof answer.body !== "string"
							)
								throw new Error(
									`The HQ peer refused the update: ${answer.body}`,
								);
							saves.standAt(FIXTURE_REMOTE_APP_ID, counter);
							serveAnswer(
								peer,
								FIXTURE_PATHS.source,
								changedAnswer(source, () => updated),
							);
							return { statusCode: answer.status, data: answer.body };
						}
						return {
							statusCode: 200,
							data: JSON.stringify({
								success: true,
								app_id: FIXTURE_REMOTE_APP_ID,
								version: saves.save(FIXTURE_REMOTE_APP_ID),
							}),
						};
					});
			const outcome = await publishAppToHq({
				requireHqImport: null,
				scope: scope(appId),
				...KEY_TARGET,
				doc,
				compiledAtSeq: Number(loaded.mutation_seq),
				reloadHead: reloadHeadFor(appId, MEMBER),
				appName: doc.appName,
				confirm: CONFIRM_ALL,
			});
			const requests = (peer.getCallHistory()?.calls() ?? [])
				.map(
					({ method, fullUrl }) =>
						`${method} ${fullUrl.replace(FIXTURE_HOST, "")}`,
				)
				.filter(
					(line) =>
						!line.startsWith(`GET ${PROJECT_SPACES}`) &&
						!isSaveCounterPath(line.slice("GET ".length)),
				);
			return { outcome, requests, imported };
		});
	}

	function movedFormIds(
		doc: BlueprintDoc,
		first: string | undefined,
		second?: string,
		cosmetic = false,
	) {
		const held = retainedBodyJson(emission(doc, 2).source);

		const body = structuredClone(held);
		const [menu] = body.modules as { forms: { unique_id: string }[] }[];
		const attachments = body._attachments as Record<string, string>;
		for (const [i, id] of [first, second].entries()) {
			if (!id) continue;
			const form = menu?.forms[i];
			if (!form) throw new Error("Expected two forms in one clinic menu.");
			attachments[`${id}.xml`] = attachments[`${form.unique_id}.xml`];
			delete attachments[`${form.unique_id}.xml`];
			form.unique_id = id;
		}
		if (cosmetic) body.admin_password = "another transient salted hash";
		return summarizeServedHqApp(body);
	}
	it.each([
		"different-id",
		"another-form",
		"stored-row",
		"same-id",
		"cosmetic-read",
		"open-v2",
	] as const)(
		"binds approval to the reviewed target when the second reading has %s",
		async (scenario) => {
			const doc = clinic({});
			const appId = await broughtIn(doc);
			await certifyFold(h.db(), appId);
			const actor = scope(appId);

			const id = "b".repeat(32),
				another = "c".repeat(32);
			const reviewed = movedFormIds(doc, id);
			const later =
				scenario === "different-id"
					? movedFormIds(doc, another)
					: scenario === "another-form"
						? movedFormIds(doc, id, another)
						: movedFormIds(doc, id, undefined, scenario === "cosmetic-read");
			const first = await withHttpPeer(async (peer) => {
				serveEmission(peer, reviewed);
				return reviewHqChanges(actor, KEY_TARGET, { onEvent: () => {} });
			});
			if (first.kind !== "nothing" || !first.readingId || !first.reviewDigest)
				throw new Error("Expected a recordable form identity change.");
			const approval = {
				readingId: first.readingId,
				reviewDigest: first.reviewDigest,
				tableChoices: {},
			};
			if (scenario === "open-v2") {
				const baseline = await readAppBaseline(actor, KEY_TARGET);
				const normalized = normalizeHqAppSource(
					retainedBodyJson(reviewed.source),
				);
				if (
					!baseline ||
					baseline.origin === "unread" ||
					"malformed" in normalized
				)
					throw new Error("Expected original review evidence.");
				approval.reviewDigest = canonicalJsonDigest({
					v: 2,
					mappingToken: appMappingToken(
						await readDeployment(actor, KEY_TARGET),
					),
					baselineDigest: baseline.sourceDigest,
					sourceDigest: normalized.digest,
					headSeq: (await loadApp(appId))?.mutation_seq,
					media: [],
					target: null,
					tables: [],
				});
			}
			const take = () =>
				withHttpPeer(async (peer) => {
					serveEmission(peer, later);
					return bringInHqChanges(actor, KEY_TARGET, approval, {
						onEvent: () => {},
					});
				});
			if (scenario === "stored-row") {
				// Another already-reviewed take changes only the second form. Both
				// reads for the outstanding review return exactly the same bytes.
				const other = movedFormIds(doc, undefined, another);
				const competing = await withHttpPeer(async (peer) => {
					serveEmission(peer, other);
					return reviewHqChanges(actor, KEY_TARGET, { onEvent: () => {} });
				});
				if (
					competing.kind !== "nothing" ||
					!competing.readingId ||
					!competing.reviewDigest
				)
					throw new Error("Expected the independent form edit.");
				const itsApproval = {
					readingId: competing.readingId,
					reviewDigest: competing.reviewDigest,
					tableChoices: {},
				};
				expect(
					(
						await withHttpPeer(async (peer) => {
							serveEmission(peer, other);
							return bringInHqChanges(actor, KEY_TARGET, itsApproval, {
								onEvent: () => {},
							});
						})
					).kind,
				).toBe("recorded");
			}
			const baselineAtApply = await readAppBaseline(actor, KEY_TARGET);
			const identityAtApply = await readTargetIdentity(actor, KEY_TARGET);
			if (
				scenario === "different-id" ||
				scenario === "another-form" ||
				scenario === "stored-row" ||
				scenario === "open-v2"
			) {
				for (let i = 0; i < 2; i++) {
					const result = await take();
					expect(result.kind).toBe("changed");
					if (result.kind === "changed") {
						expect(result.now).toMatchObject({
							kind: "nothing",
							reason: "reads-the-same",
						});
						expect(result.now).not.toMatchObject({
							reviewDigest: approval.reviewDigest,
						});
					}
				}
				expect(await readAppBaseline(actor, KEY_TARGET)).toEqual(
					baselineAtApply,
				);
				expect(await readTargetIdentity(actor, KEY_TARGET)).toEqual(
					identityAtApply,
				);
			} else {
				expect((await take()).kind).toBe("recorded");
				expect(
					(await readTargetIdentity(actor, KEY_TARGET)).entities.some(
						(row) => row.uniqueId === id,
					),
				).toBe(true);
			}
		},
	);

	it.each([
		"take-before-admission",
		"take-after-admission",
		"take-after-expiry",
	] as const)(
		"fences the compiled target when the second operation is %s",
		async (order) => {
			const doc = clinic({});
			const appId = await broughtIn(doc);
			const actor = scope(appId);
			const originalToken = appMappingToken(
				await readDeployment(actor, KEY_TARGET),
			);
			const moved = movedFormIds(doc, "b".repeat(32));
			const first = await withHttpPeer(async (peer) => {
				serveEmission(peer, moved);
				return reviewHqChanges(actor, KEY_TARGET, { onEvent: () => {} });
			});
			if (first.kind !== "nothing" || !first.readingId || !first.reviewDigest)
				throw new Error("Expected an identity-only review.");
			const approval = {
				readingId: first.readingId,
				reviewDigest: first.reviewDigest,
				tableChoices: {},
			};
			const take = () =>
				withHttpPeer(async (peer) => {
					serveEmission(peer, moved);
					return bringInHqChanges(actor, KEY_TARGET, approval, {
						onEvent: () => {},
					});
				});
			let taken: Awaited<ReturnType<typeof take>> | undefined;
			const admit = deploymentStore.admitAppWrite,
				record = deploymentStore.recordRemoteResource;
			const hook =
				order === "take-before-admission"
					? vi
							.spyOn(deploymentStore, "admitAppWrite")
							.mockImplementationOnce(async (...args) => {
								taken = await take();
								return admit(...args);
							})
					: vi
							.spyOn(deploymentStore, "recordRemoteResource")
							.mockImplementationOnce(async (...args) => {
								if (order === "take-after-expiry")
									await h
										.db()
										.updateTable("hq_remote_writes")
										.set((eb) => ({ held_until: eb.ref("opened_at") }))
										.where("app_id", "=", appId)
										.where("write_kind", "=", "import")
										.where("settled_at", "is", null)
										.execute();
								taken = await take();
								return record(...args);
							});
			try {
				const result = await publishOver(
					appId,
					emission(doc, 2).source,
					order !== "take-before-admission",
				);
				if (order === "take-after-admission") {
					expect(taken).toMatchObject({ kind: "refused" });
					expect(result.outcome.landed).toBe(true);
				} else {
					expect(taken).toMatchObject({ kind: "recorded" });
					expect(
						(await readTargetIdentity(actor, KEY_TARGET)).entities.some(
							(r) => r.uniqueId === "b".repeat(32),
						),
					).toBe(true);
					if (order === "take-before-admission") {
						expect(result.outcome.landed).toBe(false);
						expect(result.requests).not.toContain(`POST ${IMPORT_PATH}`);
					} else {
						expect((await readAppBaseline(actor, KEY_TARGET))?.origin).toBe(
							"read",
						);
						expect(
							appMappingToken(await readDeployment(actor, KEY_TARGET)),
						).toBe(originalToken);
					}
				}
			} finally {
				hook.mockRestore();
			}
		},
	);

	it.each([
		["before admission", "content"],
		["before admission", "pending setting"],
		["after admission", "content"],
		["after admission", "pending setting"],
		["before admission", "unchanged"],
		["after admission", "unchanged"],
	] as const)(
		"orders the HQ take %s for %s",
		async (order, change) => {
			const doc = clinic({});
			const appId = await broughtIn(doc);
			const actor = scope(appId);
			const base = emission(doc, 2).source;
			expect(
				(await publishOver(appId, base, true, base, 2)).outcome.landed,
			).toBe(true);
			const next =
				change === "content" ? clinic({ appName: "Name chosen in HQ" }) : doc;
			const saved =
				change === "pending setting"
					? withLocationList(emission(next, 4), "both_fixtures")
					: emission(next, change === "unchanged" ? 3 : 4);
			const review = await withHttpPeer(async (peer) => {
				serveEmission(peer, saved, 1, change !== "unchanged");
				return reviewHqChanges(actor, KEY_TARGET, { onEvent: () => {} });
			});
			if (change === "unchanged")
				expect(review).toMatchObject({
					kind: "nothing",
					readingId: null,
					reviewDigest: null,
				});
			const take = () =>
				withHttpPeer(async (peer) => {
					serveEmission(peer, saved, 1, change !== "unchanged");
					if (change === "unchanged") {
						const same = await reviewHqChanges(actor, KEY_TARGET, {
							onEvent: () => {},
						});
						expect(same).toMatchObject({
							kind: "nothing",
							readingId: null,
							reviewDigest: null,
						});
						return same;
					}
					if (
						(review.kind !== "changes" && review.kind !== "nothing") ||
						!review.readingId ||
						!review.reviewDigest
					)
						throw new Error("Expected a review of the editor’s save.");
					const approval = {
						readingId: review.readingId,
						reviewDigest: review.reviewDigest,
						tableChoices: {},
					};
					return bringInHqChanges(actor, KEY_TARGET, approval, {
						onEvent: () => {},
					});
				});
			const admit = deploymentStore.admitAppWrite;
			let taken: Awaited<ReturnType<typeof take>> | undefined;
			const hook = vi
				.spyOn(deploymentStore, "admitAppWrite")
				.mockImplementationOnce(async (...args) => {
					if (order === "before admission") {
						taken = await take();
						return admit(...args);
					}
					const held = await admit(...args);
					expect(held.kind).toBe("admitted");
					taken = await take();
					return held;
				});
			try {
				const stale = order === "before admission" && change !== "unchanged";
				const result = await publishOver(appId, base, !stale, base, 3);
				expect(taken?.kind).toBe(
					change === "unchanged"
						? "nothing"
						: order === "after admission"
							? "refused"
							: change === "content"
								? "brought-in"
								: "recorded",
				);
				expect(
					result.requests.filter(
						(request) => request === `POST ${IMPORT_PATH}`,
					),
				).toHaveLength(stale ? 0 : 1);
				expect(result.imported).toHaveLength(stale ? 0 : 1);
				expect(result.outcome.landed).toBe(!stale);
				expect(await headDocOf(appId)).toMatchObject({
					appName: stale ? next.appName : doc.appName,
				});
				if (stale) {
					if (change === "pending setting")
						expect((await baselineOfApp()).first_publish_changes).toMatchObject(
							{ ids: ["location-list-setting-reset"] },
						);
					const fresh = await publishOver(
						appId,
						saved.source,
						true,
						emission(next, 5).source,
						4,
					);
					expect(fresh.outcome.refusal).toBeNull();
					expect(fresh.imported).toHaveLength(1);
					expect(fresh.imported[0]).toMatchObject({ name: next.appName });
				}
			} finally {
				hook.mockRestore();
			}
		},
		30_000,
	);

	it.each([
		"newer take",
		"same app with a pending setting",
		"same save",
		"unconfirmed publish",
		"subsequent publish",
	] as const)(
		"preserves an accepted HQ take at its own save counter for %s",
		async (order) => {
			const doc = clinic({});
			const appId = await broughtIn(doc);
			const actor = scope(appId);
			const base = emission(doc, 2).source;
			const initial = await publishOver(appId, base, true, base, 2);
			expect(initial.outcome.landed).toBe(true);
			const settingOnly = order === "same app with a pending setting";
			const laterDoc = settingOnly
				? doc
				: clinic({ appName: "Label the editor took from HQ" });
			const reviewedHq =
				order === "same save"
					? emission(laterDoc, 4)
					: withLocationList(emission(laterDoc, 5), "both_fixtures");
			if (order === "same save")
				await applyBlueprintChangeProposal({
					appId,
					userId: MEMBER,
					expectedProjectId: E2E_PROJECT,
					batchId: crypto.randomUUID(),
					kind: "autosave",
					guard: {
						mutations: [{ kind: "setAppName", name: laterDoc.appName }],
					},
				});
			const take = async () => {
				if (order === "same save" || settingOnly) {
					// This is the name Nova just sent. HQ and the local head
					// agree on it while the publisher still awaits its record.
					const listed = await withHttpPeer(async (peer) => {
						serveEmission(peer, reviewedHq);
						return reviewHqChanges(actor, KEY_TARGET, { onEvent: () => {} });
					});
					if (
						listed.kind !== "nothing" ||
						listed.reason !==
							(settingOnly ? "reads-the-same" : "already-here") ||
						!listed.readingId ||
						!listed.reviewDigest
					)
						throw new Error(
							"Expected an HQ save the review can record without a document change.",
						);
					const approval = {
						readingId: listed.readingId,
						reviewDigest: listed.reviewDigest,
						tableChoices: {},
					};
					const outcome = await withHttpPeer(async (peer) => {
						serveEmission(peer, reviewedHq);
						return bringInHqChanges(actor, KEY_TARGET, approval, {
							onEvent: () => {},
						});
					});
					expect(outcome.kind).toBe("recorded");
					const row = await baselineOfApp();
					if (settingOnly)
						expect(row.first_publish_changes).toMatchObject({
							of: "next-publish",
							ids: ["location-list-setting-reset"],
						});
					return row;
				}
				const moved = await reviewAndBringIn(appId, laterDoc, reviewedHq);
				expect(moved.outcome.kind).toBe("brought-in");
				const row = await baselineOfApp();
				expect(row).toMatchObject({
					origin: "changes",
					first_publish_changes: {
						of: "next-publish",
						ids: ["location-list-setting-reset"],
					},
				});
				return row;
			};
			if (order === "subsequent publish" || order === "unconfirmed publish") {
				const taken = await take();
				const readBack =
					order === "unconfirmed publish"
						? { status: 503, headers: {}, body: "busy" }
						: emission(laterDoc, 6).source;
				const published = await publishOver(
					appId,
					reviewedHq.source,
					true,
					readBack,
					5,
				);
				expect(published.outcome.landed).toBe(true);
				if (order === "unconfirmed publish")
					expect(await baselineOfApp()).toEqual(taken);
				else
					expect(await baselineOfApp()).toMatchObject({
						origin: "push",
						first_publish_changes: null,
					});
				return;
			}
			const original = deploymentStore.recordRemoteResource;
			let taken: Awaited<ReturnType<typeof take>> | undefined;
			let reviewedBaseline: Awaited<ReturnType<typeof readAppBaseline>> = null;
			const hook = vi
				.spyOn(deploymentStore, "recordRemoteResource")
				.mockImplementationOnce(async (...args) => {
					// The peer acknowledged import 4 and Nova read back its version
					// before the editor saw, took and recorded HQ save 5.
					expect(args[2].remoteRevision).toBe(4);
					taken = await take();
					reviewedBaseline = await readAppBaseline(actor, KEY_TARGET);
					return original(...args);
				});
			try {
				const published = await publishOver(
					appId,
					base,
					true,
					order === "same save" ? reviewedHq.source : base,
				);
				expect(published.outcome.landed).toBe(true);
				expect(await baselineOfApp()).toEqual(taken);
				expect(await readAppBaseline(actor, KEY_TARGET)).toEqual(
					reviewedBaseline,
				);
				expect((await headDocOf(appId)).appName).toBe(laterDoc.appName);
				expect(await certifyFold(h.db(), appId)).toMatchObject({ usable: 1 });
				const nextDoc = clinic({ appName: "HQ's next edit" });
				const next = await reviewAndBringIn(
					appId,
					nextDoc,
					withLocationList(emission(nextDoc, 6), "both_fixtures"),
				);
				expect(next.outcome.kind).toBe("brought-in");
				expect((await headDocOf(appId)).appName).toBe(nextDoc.appName);
				expect((await baselineOfApp()).first_publish_changes).toMatchObject({
					of: "next-publish",
					ids: ["location-list-setting-reset"],
				});
			} finally {
				hook.mockRestore();
			}
		},
		30_000,
	);

	it("reviews, takes and publishes both targets through their own HQ endpoints after a fold", async () => {
		const doc = clinic({});
		const appId = await broughtIn(doc);
		const north = {
			domain: FIXTURE_DOMAIN,
			id: FIXTURE_REMOTE_APP_ID,
			name: "Northern clinic",
		};
		const south = {
			domain: "south-clinic",
			id: "b".repeat(32),
			name: "Southern clinic",
		};
		const targets = [north, south];
		await h
			.db()
			.updateTable("user_settings")
			.set({
				approved_domains: JSON.stringify(
					targets.map(({ domain, name }) => ({
						name: domain,
						displayName: name,
					})),
				),
			})
			.where("user_id", "=", MEMBER)
			.execute();
		const actor = scope(appId);
		const key = (domain: string) =>
			({ server: FIXTURE_SERVER, domain }) as const;
		const baseline = async (domain: string) => {
			const row = await readAppBaseline(actor, key(domain));
			if (!row || row.origin === "unread")
				throw new Error(`Missing verified source for ${domain}.`);
			return row;
		};
		const counter = new HqSaveCounter();
		counter.standAt(north.id, 2);
		const sources = new Map<string, Record<string, unknown>>([
			[north.id, retainedBodyJson(emission(doc, 2).source)],
			[south.id, retainedBodyJson(retainedGroupRead("shell/app-source"))],
		]);
		const body = (id: string) => {
			const held = sources.get(id);
			if (!held) throw new Error("Unknown synthetic HQ app.");
			return held;
		};
		const requests: {
			id: string;
			action: "create" | "update" | "read";
			name: unknown;
		}[] = [];
		await withHqPeer(counter, FIXTURE_HOST, async (peer) => {
			const host = peer.get(FIXTURE_HOST);
			const headers = { authorization: "ApiKey account:fixture-key" };
			host
				.intercept({
					method: "GET",
					headers,
					path: (p) => p.startsWith(PROJECT_SPACES),
				})
				.reply((request) => {
					const objects =
						request.path === PROJECT_SPACES
							? targets.map(({ domain, name }) => ({
									domain_name: domain,
									project_name: name,
								}))
							: [];
					return {
						statusCode: 200,
						data: JSON.stringify({
							meta: { next: null, total_count: objects.length },
							objects,
						}),
					};
				})
				.persist();
			for (const { id, domain } of targets) {
				const route = (path: string) => `/a/${domain}/${path}`;
				host
					.intercept({
						path: route(`apps/source/${id}/`),
						method: "GET",
						headers,
					})
					.reply(() => {
						requests.push({ id, action: "read", name: body(id).name });
						return { statusCode: 200, data: JSON.stringify(body(id)) };
					})
					.persist();
				host
					.intercept({
						path: route(`api/application/v1/${id}/`),
						method: "GET",
						headers,
					})
					.reply(() => ({
						statusCode: 200,
						data: retainedBodyText(summarizeServedHqApp(body(id), id).resource),
					}))
					.persist();
				host
					.intercept({
						path: route("api/lookup_table/v1/?limit=1000"),
						method: "GET",
						headers,
					})
					.reply(
						200,
						retainedBodyText(retainedGroupRead("lookups/lookup-tables")),
					)
					.persist();
				host
					.intercept({
						path: route("apps/api/import_app/"),
						method: "POST",
						headers,
					})
					.reply(async (request) => {
						const parts = await readMultipartRequest(request);
						const update = parts.get("app_id");
						const file = parts.get("app_file");
						if (
							!(file instanceof Blob) ||
							(update !== null && update !== id) ||
							(update === null && counter.at(id) !== 0)
						)
							return { statusCode: 400, data: "Wrong target or payload" };
						const sent = JSON.parse(await file.text()) as Record<
							string,
							unknown
						>;
						const version = counter.save(id);
						sources.set(id, { ...body(id), ...sent, version });
						requests.push({
							id,
							action: update === null ? "create" : "update",
							name: sent.name,
						});
						return {
							statusCode: update === null ? 201 : 200,
							data: JSON.stringify({ success: true, app_id: id, version }),
						};
					})
					.persist();
			}
			const publish = async (domain: string) => {
				const loaded = await loadApp(appId);
				if (!loaded) throw new Error("Missing saved clinic.");
				const head = hydratePersistedBlueprint(loaded.blueprint);
				const outcome = await publishAppToHq({
					requireHqImport: null,
					scope: actor,
					...key(domain),
					doc: head,
					compiledAtSeq: Number(loaded.mutation_seq),
					reloadHead: reloadHeadFor(appId, MEMBER),
					appName: head.appName,
					confirm: CONFIRM_ALL,
				});
				expect(outcome.refusal).toBeNull();
				expect(outcome.landed).toBe(true);
			};
			// The first target was actually adopted. A first publish creates
			// an independent HQ app and fills it in the second project space.
			await publish(south.domain);
			expect(
				requests
					.filter((r) => r.action !== "read")
					.map((r) => [r.id, r.action]),
			).toEqual([
				[south.id, "create"],
				[south.id, "update"],
			]);
			const cert = await certifyFold(h.db(), appId);
			expect(cert).toMatchObject({ usable: 2, unavailable: 0 });
			for (const { domain, id, name } of targets) {
				expect((await baseline(domain)).foldBinding).toBeDefined();
				sources.set(id, { ...body(id), name, version: counter.save(id) });
			}
			const list = (domain: string) =>
				reviewHqChanges(actor, key(domain), { onEvent: () => {} });
			for (const { domain, name, id } of targets) {
				const review = await list(domain);
				if (review.kind !== "changes")
					throw new Error(
						`Expected to review ${domain}: ${JSON.stringify(review)}`,
					);
				expect(review.hqChanges).toContain("The app's name");
				const taken = await bringInHqChanges(
					actor,
					key(domain),
					{
						readingId: review.readingId,
						reviewDigest: review.reviewDigest,
						tableChoices: {},
						discardNovaChanges: review.novaChanges.length > 0,
					},
					{ onEvent: () => {} },
				);
				expect(taken.kind).toBe("brought-in");
				expect((await loadApp(appId))?.app_name).toBe(name);
				expect(await readAppBaseline(actor, key(domain))).toMatchObject({
					origin: "changes",
					remoteAppId: id,
				});
				if (id === north.id)
					expect((await baseline(south.domain)).foldBinding).toBeDefined();
				const from = requests.length;
				await publish(domain);
				expect(requests.slice(from)).toEqual([
					{ id, action: "read", name },
					{ id, action: "update", name },
					{ id, action: "read", name },
				]);
				const pushed = await baseline(domain);
				expect(pushed).toMatchObject({
					origin: "push",
					remoteAppId: id,
					novaRevision: Number((await loadApp(appId))?.mutation_seq),
				});
				expect(pushed?.foldBinding).toBeUndefined();
				expect(await list(domain)).toMatchObject({
					kind: "nothing",
					reason: "unchanged",
				});
			}
			expect(targets.map((t) => body(t.id).name)).toEqual([
				north.name,
				south.name,
			]);
		});
	});

	it("writes an ownership that holds the add-on what it took needs, so turning it off in CommCare HQ stops the next publish", async () => {
		const appId = await broughtIn(clinic({}));
		expect(await ownedAddOns()).not.toContain("display_conditions");
		/* In CommCare HQ: the patients' menu shown only to a worker of one village. */
		const changed = clinic({ village: "north" });
		const served = emission(changed, 3);
		const { outcome } = await reviewAndBringIn(appId, changed, served);
		expect(outcome.kind).toBe("brought-in");
		expect(await ownedAddOns()).toContain("display_conditions");

		/* In CommCare HQ: the add-on turned off. The publish stops on the app's
		 * change before it sends anything. */
		const turnedOff = changedAnswer(served.source, (body) => ({
			...body,
			add_ons: {
				...(body.add_ons as Record<string, unknown>),
				display_conditions: false,
			},
		}));
		const stopped = await publishOver(appId, turnedOff, false);
		expect(stopped.outcome.landed).toBe(false);
		expect(stopped.outcome.refusal).toMatchObject({
			phase: "preflight",
			failure: { code: "hq_changed" },
			remoteChanges: [
				expect.objectContaining({ kind: "app", canBringIn: true }),
			],
		});
		expect(stopped.requests).toEqual([`GET ${FIXTURE_PATHS.source}`]);

		/* Over CommCare HQ's source as the bring-in recorded it, the same
		 * publish goes through. */
		const published = await publishOver(appId, served.source, true);
		expect(published.outcome.landed).toBe(true);
		expect(published.requests).toEqual([
			`GET ${FIXTURE_PATHS.source}`,
			`POST ${IMPORT_PATH}`,
			`GET ${FIXTURE_PATHS.source}`,
		]);
	});

	/** `served` with CommCare HQ's setting of which location list devices get. */
	function withLocationList(
		served: ReturnType<typeof emission>,
		setting: string,
	): ReturnType<typeof emission> {
		return {
			...served,
			source: changedAnswer(served.source, (body) => ({
				...body,
				location_fixture_restore: setting,
			})),
		};
	}

	it.each(["adds", "removes"] as const)(
		"updates the adopted app’s Publishing card when an HQ save %s a first-publish change without changing its document",
		async (direction) => {
			const birth = clinic({});
			const appId = await broughtIn(birth);
			const other = { ...KEY_TARGET, domain: "other-clinic" };
			const otherView = await deploymentStore.foldDeploymentAttempt(
				scope(appId),
				other,
				"preflight",
				{ status: "succeeded", at: new Date().toISOString() },
				{ ensure: true, expectedEndings: 0 },
			);
			const app =
				direction === "adds"
					? birth
					: clinic({ appName: "Clinic, renamed in HQ" });
			const prior =
				direction === "adds"
					? emission(app, 2)
					: withLocationList(emission(app, 3), "both_fixtures");
			if (direction === "removes") {
				const changed = await reviewAndBringIn(appId, app, prior);
				expect(changed.outcome.kind).toBe("brought-in");
			}
			const saved =
				direction === "adds"
					? withLocationList(emission(app, 4), "both_fixtures")
					: emission(app, 4);
			const read = () =>
				withHttpPeer(async (peer) => {
					serveEmission(peer, saved);
					return reviewHqChanges(scope(appId), KEY_TARGET, {
						onEvent: () => {},
					});
				});
			const before = await baselineOfApp();
			const beforeHead = (await loadApp(appId))?.mutation_seq;
			const reviewed = await read();
			expect(await baselineOfApp()).toEqual(before);
			if (
				reviewed.kind !== "nothing" ||
				reviewed.reason !== "reads-the-same" ||
				!reviewed.readingId ||
				!reviewed.reviewDigest
			)
				throw new Error(
					"Expected a recordable save with the same document: " +
						JSON.stringify(reviewed),
				);
			const approval = {
				readingId: reviewed.readingId,
				reviewDigest: reviewed.reviewDigest,
				tableChoices: {},
			};
			const id = "location-list-setting-reset";
			expect(reviewed.publishChanges.length > 0).toBe(direction === "adds");
			const apply = () =>
				withHttpPeer(async (peer) => {
					serveEmission(peer, saved);
					return bringInHqChanges(scope(appId), KEY_TARGET, approval, {
						onEvent: () => {},
					});
				});
			const admit = deploymentStore.admitAppWrite;
			const hook = vi
				.spyOn(deploymentStore, "admitAppWrite")
				.mockImplementationOnce(async (...args) => {
					const recorded = await apply();
					if (recorded.kind !== "recorded")
						throw new Error(JSON.stringify(recorded));
					expect(recorded.deployment?.deployment.deployment.domain).toBe(
						KEY_TARGET.domain,
					);
					const card = recorded.deployment?.firstPublish;
					expect(card?.of).toBe("first-publish");
					expect(card?.ids.includes(id)).toBe(direction === "adds");
					return admit(...args);
				});
			try {
				const stale = await publishOver(appId, prior.source, false);
				expect(stale.outcome.landed).toBe(false);
				expect(stale.requests).not.toContain(`POST ${IMPORT_PATH}`);
				expect(hook).toHaveBeenCalledOnce();
			} finally {
				hook.mockRestore();
			}
			expect(await readDeployment(scope(appId), other)).toEqual(otherView);
			const after = await baselineOfApp();
			expect(after.source_digest).not.toBe(before.source_digest);
			expect(after).toMatchObject({
				origin: before.origin,
				nova_revision: before.nova_revision,
			});
			expect((await loadApp(appId))?.mutation_seq).toEqual(beforeHead);
			// Applying the same approval again makes no change to the accepted source or card.
			const repeated = await withHttpPeer(async (peer) => {
				serveEmission(peer, saved, 1, false);
				return bringInHqChanges(scope(appId), KEY_TARGET, approval, {
					onEvent: () => {},
				});
			});
			expect(repeated.kind).toBe("changed");
			expect(await baselineOfApp()).toEqual(after);
			const pushed = await publishOver(
				appId,
				saved.source,
				true,
				emission(app, 5).source,
				4,
			);
			expect(pushed.outcome.landed).toBe(true);
			expect(pushed.imported).toEqual([
				expect.objectContaining({
					location_fixture_restore: "project_default",
				}),
			]);
			expect((await baselineOfApp()).first_publish_changes).toBeNull();
		},
		30_000,
	);

	it.each(["adds", "removes", "keeps as a logo"] as const)(
		"keeps the accepted source through Refresh when HQ %s an unused file before first publish",
		async (direction) => {
			const doc = clinic({});
			const original = emission(doc, 2);
			const now = emission(doc, 3);
			const withLogo = (source: RetainedHqAnswer) =>
				changedAnswer(withUnusedImage(source), (body) => ({
					...body,
					logo_refs: {
						hq_logo_android_home: { path: UNUSED_PATH, m_id: "unused-image" },
					},
				}));
			const saved =
				direction === "adds"
					? { ...now, source: withUnusedImage(now.source) }
					: direction === "removes"
						? now
						: { ...now, source: withLogo(now.source) };
			const appId = await broughtIn(
				doc,
				direction === "adds"
					? original
					: { ...original, source: withUnusedImage(original.source) },
			);
			const before = await baselineOfApp();
			if (direction === "adds") {
				const stopped = await publishOver(appId, saved.source, false);
				expect(stopped.outcome).toMatchObject({
					landed: false,
					refusal: { phase: "preflight", failure: { code: "hq_changed" } },
				});
				expect(stopped.requests).not.toContain(`POST ${IMPORT_PATH}`);
				expect(await baselineOfApp()).toEqual(before);
			}
			expect(
				before.first_publish_changes?.ids.includes(
					"unused-media-entries-removed",
				),
			).toBe(direction !== "adds");
			const refreshed = await withHttpPeer(async (peer) => {
				serveAnswer(peer, FIXTURE_PATHS.source, saved.source);
				return refreshKeptValues(scope(appId), KEY_TARGET);
			});
			expect(refreshed.kind).toBe("changed-in-hq");
			expect(await baselineOfApp()).toEqual(before);
			const answer = <T>(request: () => Promise<T>) =>
				withHttpPeer(async (peer) => {
					serveEmission(peer, saved);
					return request();
				});
			const review = await answer(() =>
				reviewHqChanges(scope(appId), KEY_TARGET, { onEvent: () => {} }),
			);
			if (
				review.kind !== "nothing" ||
				!review.readingId ||
				!review.reviewDigest
			)
				throw new Error(JSON.stringify(review));
			expect(review.reason).toBe("reads-the-same");
			expect(review.publishChanges.length > 0).toBe(direction === "adds");
			const approval = {
				readingId: review.readingId,
				reviewDigest: review.reviewDigest,
				tableChoices: {},
			};
			const taken = await answer(() =>
				bringInHqChanges(scope(appId), KEY_TARGET, approval, {
					onEvent: () => {},
				}),
			);
			if (taken.kind !== "recorded") throw new Error(JSON.stringify(taken));
			expect(
				taken.deployment?.firstPublish?.ids.includes(
					"unused-media-entries-removed",
				),
			).toBe(direction === "adds");
			expect((await baselineOfApp()).nova_revision).toBe(before.nova_revision);
			const model = new TargetPeer({
				credentials: {
					username: "account",
					apiKey: "fixture-key",
					server: FIXTURE_SERVER,
				},
				domain: FIXTURE_DOMAIN,
				flags: new Set(),
				caseSearchEnabled: false,
				appId: FIXTURE_REMOTE_APP_ID,
				commcareVersion: "2.60.0",
				cloudcareGranted: true,
			});
			model.holdSource(retainedBodyJson(saved.source));
			const pushed = await publishOver(appId, saved.source, true, model, 3);
			expect(pushed.outcome.landed).toBe(true);
			expect(pushed.imported).toHaveLength(1);
			const kept = Object.keys(model.snapshot().source?.multimedia_map ?? {});
			expect(kept.includes(UNUSED_PATH)).toBe(direction === "keeps as a logo");
			expect(model.saveCounter()).toBe(direction === "adds" ? 5 : 4);
			const after = await readAppBaseline(scope(appId), KEY_TARGET);
			// An actual prune costs an extra HQ save. Nova keeps that observation
			// for target settings, and asks again before attributing it to this push.
			expect(after?.origin).toBe(direction === "adds" ? "unread" : "push");
			const observed = await h
				.db()
				.selectFrom("app_deployment_baselines")
				.select("source_gzip")
				.executeTakeFirstOrThrow();
			if (!observed.source_gzip)
				throw new Error("The first publish retained no target observation.");
			expect(
				JSON.parse(gunzipSync(observed.source_gzip).toString("utf8"))
					.multimedia_map ?? {},
			).toEqual(model.snapshot().source?.multimedia_map ?? {});
			expect((await baselineOfApp()).first_publish_changes).toBeNull();
		},
		30_000,
	);

	it("refreshes ordinary kept values and records the changed Web Apps card without confirming the target switch", async () => {
		const doc = clinic({});
		const appId = await broughtIn(doc);
		const kept = changedAnswer(emission(doc, 3).source, (body) => {
			const profile = body.profile as { properties: Record<string, string> };
			profile.properties["cc-fuzzy-search-enabled"] = "yes";
			const translations = body.translations as Record<
				string,
				Record<string, string>
			>;
			translations.en = {
				...translations.en,
				"home.start": "Begin visit",
				en: "Local English",
			};
			return body;
		});
		const refresh = (source: RetainedHqAnswer) =>
			withHttpPeer(async (peer) => {
				serveAnswer(peer, FIXTURE_PATHS.source, source);
				return refreshKeptValues(scope(appId), KEY_TARGET);
			});
		const before = await baselineOfApp();
		expect((await refresh(kept)).kind).toBe("refreshed");
		const refreshed = await baselineOfApp();
		expect(refreshed.first_publish_changes).toEqual(
			before.first_publish_changes,
		);
		expect(refreshed.source_digest).not.toBe(before.source_digest);
		const saved = {
			...emission(doc, 4),
			source: changedAnswer(kept, (body) => ({
				...body,
				version: 4,
				cloudcare_enabled: false,
			})),
		};
		expect((await refresh(saved.source)).kind).toBe("changed-in-hq");
		expect(await baselineOfApp()).toEqual(refreshed);
		const withSaved = <T>(request: () => Promise<T>) =>
			withHttpPeer(async (peer) => {
				serveEmission(peer, saved);
				return request();
			});
		const review = await withSaved(() =>
			reviewHqChanges(scope(appId), KEY_TARGET, { onEvent: () => {} }),
		);
		if (review.kind !== "nothing" || !review.readingId || !review.reviewDigest)
			throw new Error(JSON.stringify(review));
		const approval = {
			readingId: review.readingId,
			reviewDigest: review.reviewDigest,
			tableChoices: {},
		};
		const result = await withSaved(() =>
			bringInHqChanges(scope(appId), KEY_TARGET, approval, {
				onEvent: () => {},
			}),
		);
		if (result.kind !== "recorded") throw new Error(JSON.stringify(result));
		expect(result.deployment?.firstPublish?.ids).toContain(
			"web-apps-turned-on",
		);
		const refused = await publishOver(appId, saved.source, false);
		expect(refused.outcome).toMatchObject({
			landed: false,
			refusal: {
				failure: { code: "hq_web_apps_change" },
				webAppsChange: { from: false, to: true, changedInHq: false },
			},
		});
		expect(refused.imported).toEqual([]);
	}, 30_000);

	it("writes the next publish's list after a publish, keeps it over a second change, and clears it where CommCare HQ's save undid it", async () => {
		const doc = clinic({});
		const appId = await broughtIn(doc);
		/* The first publish over the brought-in app, which ends its list. */
		const published = await publishOver(
			appId,
			emission(doc, 2).source,
			true,
			emission(doc, 3).source,
		);
		expect(published.outcome.landed).toBe(true);
		expect(await baselineOfApp()).toMatchObject({
			origin: "push",
			first_publish_changes: null,
		});

		/* In CommCare HQ: the app renamed, and the location list setting changed. */
		const renamed = clinic({ appName: "Clinic, renamed in HQ" });
		const first = await reviewAndBringIn(
			appId,
			renamed,
			withLocationList(emission(renamed, 4), "both_fixtures"),
		);
		expect(first.outcome.kind).toBe("brought-in");
		expect((await baselineOfApp()).first_publish_changes).toMatchObject({
			ids: ["location-list-setting-reset"],
			of: "next-publish",
		});

		/* A second change there, over a base that already holds the setting. */
		const again = clinic({ appName: "Clinic, renamed in HQ again" });
		const second = await reviewAndBringIn(
			appId,
			again,
			withLocationList(emission(again, 5), "both_fixtures"),
		);
		expect(second.outcome.kind).toBe("brought-in");
		expect((await baselineOfApp()).first_publish_changes).toMatchObject({
			ids: ["location-list-setting-reset"],
			of: "next-publish",
		});

		/* The setting put back there, and nothing else: the same app, recorded. */
		const undone = emission(again, 6);
		const listed = await withHttpPeer(async (peer) => {
			serveEmission(peer, undone);
			return reviewHqChanges(scope(appId), KEY_TARGET, { onEvent: () => {} });
		});
		expect(listed).toMatchObject({ kind: "nothing", reason: "reads-the-same" });
		if (listed.kind !== "nothing" || listed.reviewDigest === null)
			throw new Error("The review gave no digest to send.");
		const recorded = await withHttpPeer(async (peer) => {
			serveEmission(peer, undone);
			return bringInHqChanges(
				scope(appId),
				KEY_TARGET,
				{
					readingId: listed.readingId ?? "",
					reviewDigest: listed.reviewDigest ?? "",
					tableChoices: {},
				},
				{ onEvent: () => {} },
			);
		});
		expect(recorded.kind).toBe("recorded");
		expect((await baselineOfApp()).first_publish_changes).toBeNull();
	});

	/* A person edits a keyed create's case id calculation in CommCare HQ's
	 * form builder: the form's source holds the create's cases under another
	 * prefix, and nothing else moved. A worker who enters a key again must
	 * reach the case CommCare HQ holds for it, so the next publish prints the
	 * prefix CommCare HQ now holds. */
	it("follows a keyed create's prefix changed in CommCare HQ, from the review through the next publish's body", async () => {
		const appId = await broughtIn(keyedCreateApp(), servedKeyedApp(2));
		const heldPrefixes = async () =>
			(await readTargetIdentity(scope(appId), KEY_TARGET)).keyedCaseIds.map(
				(row) => row.prefix,
			);
		expect(await heldPrefixes()).toEqual([EMITTED_KEYED_PREFIX]);

		const EDITED = keyedPrefixIn("prefix-edited-in-hq");
		const edited = servedKeyedApp(3, EDITED);
		const review = (served: ServedHqApp, tables = true) =>
			withHttpPeer(async (peer) => {
				serveEmission(peer, served, 1, tables);
				return reviewHqChanges(scope(appId), KEY_TARGET, {
					onEvent: () => {},
				});
			});
		const listed = await review(edited);
		expect(listed).toMatchObject({ kind: "nothing", reason: "reads-the-same" });
		if (listed.kind !== "nothing" || listed.reviewDigest === null)
			throw new Error("The review gave no digest to send.");
		expect(listed.hqChanges).toEqual([
			expect.stringMatching(
				/^In CommCare HQ, “Register” now files the cases it makes from an answer under a new case id\. /,
			),
		]);
		const bringIn = (served: ServedHqApp) =>
			withHttpPeer(async (peer) => {
				serveEmission(peer, served);
				return bringInHqChanges(
					scope(appId),
					KEY_TARGET,
					{
						readingId: listed.readingId ?? "",
						reviewDigest: listed.reviewDigest ?? "",
						tableChoices: {},
					},
					{ onEvent: () => {} },
				);
			});

		/* Edited once more in CommCare HQ before the bring-in: what the person
		 * reviewed is no longer there, so nothing is taken. */
		const again = await bringIn(
			servedKeyedApp(4, keyedPrefixIn("prefix-edited-again")),
		);
		expect(again.kind).toBe("changed");
		expect(await heldPrefixes()).toEqual([EMITTED_KEYED_PREFIX]);

		expect((await bringIn(edited)).kind).toBe("recorded");
		expect(await heldPrefixes()).toEqual([EDITED]);
		expect(await review(edited, false)).toMatchObject({
			kind: "nothing",
			reason: "unchanged",
		});

		const published = await publishOver(appId, edited.source, true);
		expect(published.outcome.landed).toBe(true);
		const [update] = published.imported;
		const forms = Object.values(
			(update?._attachments ?? {}) as Record<string, unknown>,
		)
			.filter((text): text is string => typeof text === "string")
			.join("\n");
		expect(forms).toContain(EDITED);
		expect(forms).not.toContain(EMITTED_KEYED_PREFIX);
	});

	/* A person typed `case_name` for the patients' name column in CommCare HQ's
	 * Case List page, where Nova writes `name`: HQ's build names the column's
	 * app strings by that word, so a publish over the app keeps it. Then the
	 * person changes the detail's column back to `name` there, and Nova
	 * follows that too. */
	it("keeps a column's field word CommCare HQ stores from the reading through the next publish's body, and follows the word changed there", async () => {
		const doc = clinic({});
		type Details = Record<"short" | "long", { columns: { field: unknown }[] }>;
		const storedAs = (
			served: ServedHqApp,
			words: Readonly<Record<"short" | "long", string>>,
		): ServedHqApp => ({
			...served,
			source: changedAnswer(served.source, (body) => {
				const [patients] = body.modules as { case_details: Details }[];
				for (const screen of ["short", "long"] as const) {
					const [column] = patients?.case_details[screen].columns ?? [];
					if (column === undefined || column.field !== "name")
						throw new Error("The list's first column is the name column.");
					column.field = words[screen];
				}
				return body;
			}),
		});
		const appId = await broughtIn(
			doc,
			storedAs(emission(doc, 2), { short: "case_name", long: "case_name" }),
		);
		const head = await headDocOf(appId);
		const [nameColumn] =
			head.modules[head.moduleOrder[0] ?? ""]?.caseListConfig?.columns ?? [];
		if (nameColumn === undefined) throw new Error("The list holds its column.");
		expect(nameColumn).toMatchObject({ kind: "plain", field: "case_name" });
		const heldWords = async () =>
			(await readTargetIdentity(scope(appId), KEY_TARGET)).columnWords;
		expect(await heldWords()).toEqual([
			{ columnUuid: nameColumn.uuid, screen: "long", word: "case_name" },
			{ columnUuid: nameColumn.uuid, screen: "short", word: "case_name" },
		]);

		const moved = storedAs(emission(doc, 3), {
			short: "case_name",
			long: "name",
		});
		const listed = await withHttpPeer(async (peer) => {
			serveEmission(peer, moved);
			return reviewHqChanges(scope(appId), KEY_TARGET, { onEvent: () => {} });
		});
		expect(listed).toMatchObject({ kind: "nothing", reason: "reads-the-same" });
		if (listed.kind !== "nothing" || listed.reviewDigest === null)
			throw new Error("The review gave no digest to send.");
		expect(listed.hqChanges).toEqual([
			expect.stringMatching(
				/^In CommCare HQ, the case list of “Patients” now names a column's property another way\. /,
			),
		]);
		const recorded = await withHttpPeer(async (peer) => {
			serveEmission(peer, moved);
			return bringInHqChanges(
				scope(appId),
				KEY_TARGET,
				{
					readingId: listed.readingId ?? "",
					reviewDigest: listed.reviewDigest ?? "",
					tableChoices: {},
				},
				{ onEvent: () => {} },
			);
		});
		expect(recorded.kind).toBe("recorded");
		expect(await heldWords()).toEqual([
			{ columnUuid: nameColumn.uuid, screen: "short", word: "case_name" },
		]);

		const published = await publishOver(appId, moved.source, true);
		expect(published.outcome.landed).toBe(true);
		const [update] = published.imported;
		const [patients] = (update?.modules ?? []) as { case_details: Details }[];
		expect(patients?.case_details.short.columns[0]?.field).toBe("case_name");
		expect(patients?.case_details.long.columns[0]?.field).toBe("name");
	});
});
