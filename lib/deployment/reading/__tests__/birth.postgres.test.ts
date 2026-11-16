/**
 * The `hq-adoption` birth over real Postgres: one transaction in one lock
 * order, run from a reading the production functions gathered with CommCare
 * HQ answering through a controlled peer.
 *
 * It would catch: export readiness not seeing the tables the same
 * transaction wrote; places written where the tail's organization integrity
 * never reads them; a brought-in document that names a place; a birth whose
 * holds are no recordings; a birth that charges or holds; a partial birth;
 * Nova's defect shown as the app's, or an app's words reaching Sentry through
 * an error's message, a lookup store refusal's tag among them; a removed
 * file answered as Nova's defect, or a retry
 * that fails forever on a dead asset id; a table that changed under the birth
 * answered with a stale review; a claim that does not serialize births; the
 * cycle a Project-state-before-gate order closes; and a deleted app holding
 * its HQ app against a bring-in.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql, type Transaction } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	retainedBodyJson,
	retainedGroupRead,
} from "@/__tests__/helpers/retainedHqReads";
import { decrypt } from "@/lib/commcare/encryption";
import { sourceFromBody } from "@/lib/commcare/reader/__tests__/readerInput";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { levelsFromHq } from "@/lib/commcare/reader/worldEntities";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { resolveAuthorizedAppSnapshot } from "@/lib/db/appAccess";
import {
	GenesisGateRejectedError,
	prepareGenesisCandidate,
} from "@/lib/db/appGenesis";
import { softDeleteApp } from "@/lib/db/apps";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { claimHqAppInTransaction } from "@/lib/db/hqAppClaims";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { BlueprintDoc } from "@/lib/domain";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { LOOKUP_MAX_CELL_BYTES } from "@/lib/lookup/constants";
import { LookupError } from "@/lib/lookup/errors";
import { createLookupTable } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import { lockLookupProjectState } from "@/lib/lookup/writerTransaction";
import { publishReadyMedia } from "@/lib/media/publishReadyMedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";
import { extractLocationReferenceTargets } from "@/lib/organization/commitIntegrity";
import { deleteAsset, uploadAssetBytes } from "@/lib/storage/media";
import { birthAdoptedApp } from "../../__tests__/adoptedBirth";
import { broughtInAppId } from "../appId";
import {
	type AdoptionBirth,
	adoptedDeploymentWrite,
	adoptHqAppInTransaction,
} from "../birth";
import { createFromReview } from "../create";
import { type Gathered, gatherReading } from "../gather";
import {
	bornPlaces,
	type ReadingProjectData,
	readingProjectDataWrite,
} from "../projectData";
import { broughtInLookupTableId } from "../projectData/lookupIds";
import {
	postgresProjectSide,
	readReadingProjectData,
} from "../projectData/read";
import { authorizeBringIn, readHqAppForReview } from "../read";
import type { BringInInput, CreateAnswer } from "../types";
import {
	adoptFixtureApp,
	createInputFor,
	FIXTURE_DOMAIN,
	FIXTURE_HOST,
	FIXTURE_PATHS,
	FIXTURE_REMOTE_APP_ID,
	FIXTURE_SERVER,
	fixtureKey,
	fixtureSource,
	reviewOf,
	seedFixtureConnection,
	serveAnswer,
	serveFixtureApp,
	serveFixtureTables,
	withIcons,
} from "./adoptionFixture";

const seam = vi.hoisted(() => ({
	beforeBirth: null as
		| null
		| ((birth: AdoptionBirth) => Promise<AdoptionBirth | undefined>),
}));

vi.mock("../birth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../birth")>();
	return {
		...actual,
		adoptHqAppInTransaction: async (
			...[tx, birth]: Parameters<typeof actual.adoptHqAppInTransaction>
		) => {
			const changed = (await seam.beforeBirth?.(birth)) ?? birth;
			return actual.adoptHqAppInTransaction(tx, changed);
		},
	};
});
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: vi.fn(),
	deleteAsset: vi.fn(),
	downloadAssetBytes: vi.fn(),
}));
beforeEach(() => {
	seam.beforeBirth = null;
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	vi.mocked(uploadAssetBytes).mockReset();
	vi.mocked(uploadAssetBytes).mockResolvedValue(undefined);
	vi.mocked(deleteAsset).mockReset();
});

const h = setupAppStateTestDb("bring_in_birth_", {
	authSchema: "migrated",
	poolMax: 5,
});

const PROJECT = "bring-in-project";
const ACTOR = "bring-in-owner";
const KEY = fixtureKey(PROJECT);
const READING_ID = "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b";
const AT = new Date("2026-11-10T09:00:00.000Z");
const SCOPE: LookupScope = {
	projectId: PROJECT,
	actorId: ACTOR,
	role: "owner",
};
const PNG = readFileSync(
	join(import.meta.dirname, "../../../media/__tests__/fixtures/pattern.png"),
);

function servePng(peer: MockAgent, multimediaId: string, times = 1): void {
	peer
		.get(FIXTURE_HOST)
		.intercept({ path: FIXTURE_PATHS.media(multimediaId), method: "GET" })
		.reply(200, PNG, { headers: { "content-type": "image/png" } })
		.times(times);
}

/**
 * A clean gathering of the fixture app under the production `gatherReading`,
 * keeping its files' bytes, and the birth a create would make of it under the
 * preselected declaration with no publish: the candidate, the deployment's
 * write and the Project data's.
 */
async function preparedBirth(
	options: { readonly source?: ReturnType<typeof fixtureSource> } = {},
): Promise<{ readonly gathered: Gathered; readonly birth: AdoptionBirth }> {
	const actor = await authorizeBringIn(ACTOR, PROJECT);
	if (actor === null) throw new Error("no edit");
	const appId = broughtInAppId(ACTOR, KEY, READING_ID);
	const { result } = await withHttpPeer(async (peer) => {
		serveFixtureApp(peer, options.source ? { source: options.source } : {});
		if (options.source !== undefined) servePng(peer, "menuicon");
		return gatherReading({
			actor,
			key: KEY,
			readingId: READING_ID,
			appId,
			keepMedia: true,
			onEvent: () => {},
		});
	});
	if (result.kind !== "clean") throw new Error(JSON.stringify(result));
	const gathered = result.gathered;
	const chosen = gathered.accepted.declarations.find(
		(declaration) => declaration.preselected,
	);
	if (chosen === undefined) throw new Error("none preselected");
	const candidate = prepareGenesisCandidate({
		appId,
		projectId: PROJECT,
		mutations: [...gathered.draft.batch, ...chosen.mutations],
	});
	const deployment = adoptedDeploymentWrite({
		appId,
		key: KEY,
		actorUserId: ACTOR,
		gathered,
		chosen,
		candidate,
	});
	if (!deployment.ok) throw new Error("no real ids");
	return {
		gathered,
		birth: {
			actorUserId: ACTOR,
			runId: "6f1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
			candidate,
			hqApp: {
				server: FIXTURE_SERVER,
				domain: FIXTURE_DOMAIN,
				remoteAppId: FIXTURE_REMOTE_APP_ID,
			},
			projectData: readingProjectDataWrite(
				gathered.fetched.data,
				gathered.reads,
				gathered.draft.doc,
				mintingResolver(appId),
			),
			deployment: deployment.write,
			at: AT,
		},
	};
}

/** The birth with `doc` as its document, its batch the diff from the empty document. */
function withDocument(birth: AdoptionBirth, doc: BlueprintDoc): AdoptionBirth {
	const { appId, projectId } = birth.candidate;
	return {
		...birth,
		candidate: prepareGenesisCandidate({
			appId,
			projectId,
			mutations: diffDocsToMutations(emptyBlueprintDoc(appId), doc),
		}),
	};
}

/** CommCare HQ's levels (Region, then District under it) and the retained places, read as a
 *  bring-in reads them with places asked for always. */
async function placesRead(): Promise<ReadingProjectData> {
	const region = {
		id: 1,
		name: "Region",
		code: "region",
		parent: null,
		administrative: false,
		shares_cases: true,
		view_descendants: false,
	};
	const district = {
		...region,
		id: 2,
		name: "District",
		code: "district",
		parent: `/a/${FIXTURE_DOMAIN}/api/location_type/v1/1/`,
	};
	const places = retainedGroupRead("places/locations");
	const source = await sourceFromBody(retainedBodyJson(fixtureSource()));
	const answer = await withHttpPeer(async (peer) => {
		serveFixtureTables(peer);
		serveAnswer(peer, `/a/${FIXTURE_DOMAIN}/api/location_type/v1/?limit=1000`, {
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				meta: { next: null, total_count: 2 },
				objects: [region, district],
			}),
		});
		serveAnswer(
			peer,
			`/a/${FIXTURE_DOMAIN}/api/location/v2/?limit=1000`,
			places,
		);
		const appId = "0b4f6a52-7c55-4a35-9d1e-3c2f8a1b4e6d";
		return readReadingProjectData({
			creds: { username: "account", apiKey: "fixture-key", server: "india" },
			server: FIXTURE_SERVER,
			domain: FIXTURE_DOMAIN,
			appId,
			readingId: READING_ID,
			source,
			project: postgresProjectSide({
				projectId: PROJECT,
				actorUserId: ACTOR,
				appId,
				origin: { server: FIXTURE_SERVER, domain: FIXTURE_DOMAIN },
			}),
			places: "always",
		});
	});
	if (answer.kind !== "read") throw new Error("the places read failed");
	return answer.data;
}

/** The birth with CommCare HQ's levels in its document and a copy of its places; `misplaced`
 *  moves a top place under a place of the lower level. */
function withPlaces(
	birth: AdoptionBirth,
	data: ReadingProjectData,
	misplaced: boolean,
): AdoptionBirth {
	const { appId } = birth.candidate;
	const levels = levelsFromHq(
		data.gathered.hqLevels,
		mintingResolver(appId),
	).levels;
	const doc: BlueprintDoc = {
		...birth.candidate.prepared.nextDoc,
		organizationLevels: Object.fromEntries(
			levels.map((level) => [level.uuid, level]),
		),
		organizationLevelOrder: levels.map((level) => level.uuid),
	};
	const plan = bornPlaces(data, doc, mintingResolver(appId));
	return {
		...withDocument(birth, doc),
		projectData: {
			...birth.projectData,
			places: misplaced
				? {
						...plan,
						places: plan.places.map((place) =>
							place.siteCode === "south"
								? { ...place, parentSiteCode: "north_clinic" }
								: place,
						),
					}
				: plan,
		},
	};
}

async function count(query: ReturnType<typeof sql<{ count: string }>>) {
	const { rows } = await query.execute(h.db());
	return Number(rows[0]?.count);
}

/** Nothing of a birth of `appId` exists: no app, no table of its derived ids, no place, no
 *  deployment, no claim. */
async function expectNothingOf(appId: string): Promise<void> {
	expect(
		await count(
			sql`SELECT count(*)::text AS count FROM apps WHERE id = ${appId}`,
		),
	).toBe(0);
	expect(
		await count(
			sql`SELECT count(*)::text AS count FROM lookup_tables WHERE id = ${broughtInLookupTableId(appId, READING_ID, "district")}`,
		),
	).toBe(0);
	expect(
		await count(
			sql`SELECT count(*)::text AS count FROM app_locations WHERE app_id = ${appId}`,
		),
	).toBe(0);
	expect(
		await count(sql`SELECT count(*)::text AS count FROM app_deployments`),
	).toBe(0);
	expect(
		await count(
			sql`SELECT count(*)::text AS count FROM app_deployment_resources`,
		),
	).toBe(0);
}

async function bringIn(
	input: (key: typeof KEY, review: ReturnType<typeof reviewOf>) => BringInInput,
	serving: (peer: MockAgent) => void = (peer) =>
		serveFixtureApp(peer, { times: 2 }),
): Promise<CreateAnswer> {
	const actor = await authorizeBringIn(ACTOR, PROJECT);
	if (actor === null) throw new Error("no edit");
	return withHttpPeer(async (peer) => {
		serving(peer);
		const review = reviewOf(
			await readHqAppForReview(actor, KEY, { onEvent: () => {} }),
		);
		return createFromReview(actor, input(KEY, review), { onEvent: () => {} });
	});
}

/** Wait, by asking Postgres, until some backend waits on a lock. */
async function untilSomeoneWaits(waiting: number): Promise<void> {
	for (;;) {
		const waiters = await count(
			sql`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
		);
		if (waiters >= waiting) return;
	}
}

/** What the one backend waiting on a lock asks for, and whether it holds a transaction id. */
async function waiterLocks(): Promise<{
	readonly waitingFor: readonly string[];
	readonly holdsTransactionId: boolean;
}> {
	const { rows } = await sql<{ locktype: string; granted: boolean }>`
		SELECT l.locktype, l.granted
		FROM pg_locks l
		JOIN pg_stat_activity a ON a.pid = l.pid
		WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
	`.execute(h.db());
	return {
		waitingFor: rows.filter((row) => !row.granted).map((row) => row.locktype),
		holdsTransactionId: rows.some(
			(row) => row.granted && row.locktype === "transactionid",
		),
	};
}

describe("adoptHqAppInTransaction", () => {
	beforeEach(async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		await seedFixtureConnection(ACTOR);
	});

	it("passes a select that reads a table the same transaction wrote, and refuses it with that writer left out", async () => {
		const { birth } = await preparedBirth();
		await expect(
			withAppTx((tx) =>
				adoptHqAppInTransaction(tx, {
					...birth,
					projectData: { ...birth.projectData, tables: [] },
				}),
			),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		await expectNothingOf(birth.candidate.appId);
		const outcome = await withAppTx((tx) => adoptHqAppInTransaction(tx, birth));
		expect(outcome).toEqual({ kind: "born", role: "owner" });
	});

	it("proves the places it copies inside the tail: a misplaced copy rolls the birth back, and a sound one commits", async () => {
		const { birth } = await preparedBirth();
		const data = await placesRead();
		await expect(
			withAppTx((tx) =>
				adoptHqAppInTransaction(tx, withPlaces(birth, data, true)),
			),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		await expectNothingOf(birth.candidate.appId);
		await withAppTx((tx) =>
			adoptHqAppInTransaction(tx, withPlaces(birth, data, false)),
		);
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM app_locations WHERE app_id = ${birth.candidate.appId}`,
			),
		).toBe(3);
	});

	it("answers a create whose copy of the places the tail refuses check-failed, birth-integrity", async () => {
		const data = await placesRead();
		seam.beforeBirth = async (birth) => withPlaces(birth, data, true);
		const answer = await bringIn((key, review) => createInputFor(key, review));
		expect(answer).toMatchObject({
			kind: "check-failed",
			finding: {
				code: "read-back-differs",
				detail: { name: "birth-integrity" },
			},
		});
		expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(0);
	});

	it("births a document that names no place", async () => {
		const { appId, receipt } = await adoptFixtureApp({
			projectId: PROJECT,
			actorUserId: ACTOR,
		});
		expect(
			extractLocationReferenceTargets(
				hydratePersistedBlueprint(receipt.blueprint),
			),
		).toEqual([]);
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM app_location_references WHERE app_id = ${appId}`,
			),
		).toBe(0);
	});

	it("records the holds its batch carries", async () => {
		const answer = await bringIn(
			(key, review) => createInputFor(key, review),
			(peer) => serveFixtureApp(peer, { app: "navigation", times: 2 }),
		);
		if (answer.kind !== "created") throw new Error(JSON.stringify(answer));
		const held = [
			...readPlacementHolds(
				hydratePersistedBlueprint(answer.receipt.blueprint),
			).values(),
		];
		expect(held.length).toBeGreaterThan(0);
		const snapshot = await resolveAuthorizedAppSnapshot(
			answer.receipt.appId,
			ACTOR,
		);
		expect(snapshot.recordedHolds).toEqual(held);
	});

	it("charges nothing and holds nothing", async () => {
		const { appId } = await adoptFixtureApp({
			projectId: PROJECT,
			actorUserId: ACTOR,
		});
		for (const table of [
			"design_sessions",
			"authoring_sessions",
			"threads",
			"credit_months",
			"usage_months",
		])
			expect(
				await count(
					sql`SELECT count(*)::text AS count FROM ${sql.table(table)}`,
				),
			).toBe(0);
		expect(await h.readAppRow(appId)).toMatchObject({
			run_holder_nonce: null,
			res_run_id: null,
			res_reserved: null,
			lock_run_id: null,
		});
	});

	describe("rolls a birth back whole, wherever it fails", () => {
		const cases: readonly {
			readonly seam: string;
			readonly source?: "icons";
			readonly change?: (birth: AdoptionBirth) => Promise<AdoptionBirth>;
			readonly after?: true;
			/** What the refusal is, where a verdict of the tail makes it. */
			readonly refusal?: Partial<GenesisGateRejectedError>;
		}[] = [
			{
				seam: "a candidate the gate refuses",
				change: async (birth) =>
					withDocument(birth, {
						...birth.candidate.prepared.nextDoc,
						appName: "",
					}),
				refusal: { check: "gate", findingCodes: ["EMPTY_APP_NAME"] },
			},
			{
				seam: "a candidate export readiness refuses",
				source: "icons",
				refusal: { check: "export" },
			},
			{
				seam: "a lookup writer that throws",
				change: async (birth) => {
					await createLookupTable(SCOPE, {
						name: "Districts",
						tag: "district",
						columns: [{ wireName: "code", label: "Code", dataType: "text" }],
					});
					return birth;
				},
			},
			{
				seam: "a place writer that throws",
				change: async (birth) => ({
					...birth,
					projectData: {
						...birth.projectData,
						places: {
							places: [
								{
									hqLocationId: "834a246164014b729dae962085b8894c",
									siteCode: "north",
									name: "North",
									levelUuid: "no-such-level",
									parentSiteCode: "nowhere",
									latitude: null,
									longitude: null,
									values: {},
								},
							],
							digest: "0".repeat(64),
							leftOut: {},
							leftOutHqLocationIds: [],
							findings: [],
						},
					},
				}),
			},
			{
				seam: "a duplicate identity row",
				change: async (birth) => ({
					...birth,
					deployment: {
						...birth.deployment,
						identities: [
							...birth.deployment.identities,
							...birth.deployment.identities,
						],
					},
				}),
			},
			{ seam: "a throw after the deployment is recorded", after: true },
		];

		it.each(cases)("$seam", async ({ source, change, after, refusal }) => {
			const validated = await validateSniffedMediaBytes(PNG);
			if (!validated.ok) throw new Error("the image is refused");
			await publishReadyMedia({
				actorUserId: ACTOR,
				projectId: PROJECT,
				bytes: PNG,
				validated: validated.validated,
				originalFilename: "kept.png",
				assetId: "0a6f2c1e-3b4d-4e5f-8a9b-1c2d3e4f5a6b" as MediaAssetId,
			});
			const assets = await count(
				sql`SELECT count(*)::text AS count FROM media_assets WHERE status = 'ready'`,
			);
			const { birth: prepared } = await preparedBirth(
				source === "icons"
					? { source: withIcons(fixtureSource(), ["menuicon"]) }
					: {},
			);
			const birth = change === undefined ? prepared : await change(prepared);
			const thrown = await h
				.withTransaction(async (tx) => {
					await adoptHqAppInTransaction(tx, birth);
					if (after === true)
						throw new Error(
							"The test throws after the deployment is recorded.",
						);
				})
				.then(
					() => null,
					(error: unknown) => error,
				);
			expect(thrown).toBeInstanceOf(Error);
			if (refusal !== undefined) {
				expect(thrown).toBeInstanceOf(GenesisGateRejectedError);
				expect(thrown).toMatchObject(refusal);
			}
			await expectNothingOf(birth.candidate.appId);
			expect(
				await count(
					sql`SELECT count(*)::text AS count FROM media_assets WHERE status = 'ready'`,
				),
			).toBe(assets);
		});
	});

	it("answers a gate refusal check-failed, birth-gate, and logs its codes with no word of the app", async () => {
		const SENTINEL = "Zqsentinelform";
		const refusedOf = (birth: AdoptionBirth): AdoptionBirth => {
			const doc = structuredClone(birth.candidate.prepared.nextDoc);
			for (const form of Object.values(doc.forms)) {
				form.name = SENTINEL;
				form.type = "close";
			}
			return withDocument(birth, doc);
		};
		const { birth } = await preparedBirth();
		const thrown = await withAppTx((tx) =>
			adoptHqAppInTransaction(tx, refusedOf(birth)),
		).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(GenesisGateRejectedError);
		const refusal = thrown as GenesisGateRejectedError;
		expect(refusal.check).toBe("gate");
		expect(refusal.findingCodes.length).toBeGreaterThan(0);
		expect(refusal.message).toContain(SENTINEL);

		seam.beforeBirth = async (created) => refusedOf(created);
		vi.mocked(log.error).mockClear();
		const answer = await bringIn((key, review) => createInputFor(key, review));
		expect(answer).toMatchObject({
			kind: "check-failed",
			finding: { code: "read-back-differs", detail: { name: "birth-gate" } },
		});
		const line = vi
			.mocked(log.error)
			.mock.calls.find(
				([message]) => message === "[reading] could not create: gate",
			);
		expect(line?.[1]).toBeUndefined();
		expect(line?.[2]).toMatchObject({ findingCodes: refusal.findingCodes });
		expect(loggedText(vi.mocked(log.error).mock.calls)).not.toContain(SENTINEL);
	});

	it("answers project_changed where a published file left the Project before the birth, and the next create publishes it again", async () => {
		seam.beforeBirth = async (birth) => {
			await h.db().deleteFrom("media_assets").execute();
			return birth;
		};
		let input: BringInInput | null = null;
		const serving = (peer: MockAgent) => {
			serveFixtureApp(peer, {
				source: withIcons(fixtureSource(), ["menuicon"]),
				times: 2,
			});
			servePng(peer, "menuicon", 2);
		};
		const answer = await bringIn((key, review) => {
			input = createInputFor(key, review);
			return input;
		}, serving);
		expect(answer).toEqual({ kind: "refused", refusal: "project_changed" });
		seam.beforeBirth = null;
		const actor = await authorizeBringIn(ACTOR, PROJECT);
		if (actor === null || input === null) throw new Error("no create");
		const again = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, {
				source: withIcons(fixtureSource(), ["menuicon"]),
			});
			servePng(peer, "menuicon");
			return createFromReview(actor, input as BringInInput, {
				onEvent: () => {},
			});
		});
		expect(again.kind).toBe("created");
		expect(uploadAssetBytes).toHaveBeenCalledTimes(2);
	});

	it("answers read-again where a table of a tag the app reads was made after the create's read, and the next review asks its choice", async () => {
		seam.beforeBirth = async (birth) => {
			await createLookupTable(SCOPE, {
				name: "Districts",
				tag: "district",
				columns: [
					{ wireName: "code", label: "Code", dataType: "text" },
					{ wireName: "name", label: "Name", dataType: "text" },
				],
			});
			return birth;
		};
		const answer = await bringIn((key, review) => createInputFor(key, review));
		expect(answer).toEqual({ kind: "read-again" });
		const actor = await authorizeBringIn(ACTOR, PROJECT);
		if (actor === null) throw new Error("no edit");
		const next = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer);
			return reviewOf(
				await readHqAppForReview(actor, KEY, { onEvent: () => {} }),
			);
		});
		expect(
			next.review.tables.find((table) => table.tag === "district")?.choice,
		).not.toBeNull();
	});

	it("answers a lookup write the store refuses check-failed, birth-integrity, and logs its code with no word of the app", async () => {
		/* Every cell one byte over what Nova holds in a cell: the store refuses the write
		 * `storage_limit`, in a sentence that names the table by its tag. */
		const withOverlongCells = (birth: AdoptionBirth): AdoptionBirth => ({
			...birth,
			projectData: {
				...birth.projectData,
				tables: birth.projectData.tables.map((table) => ({
					...table,
					read: {
						...table.read,
						rows: table.read.rows.map((row) => ({
							...row,
							fields: Object.fromEntries(
								Object.keys(row.fields).map((field) => [
									field,
									"x".repeat(LOOKUP_MAX_CELL_BYTES + 1),
								]),
							),
						})),
					},
				})),
			},
		});
		/* The store's refusal names the table by its tag, so a log that carried the error
		 * would spell it. */
		const { birth } = await preparedBirth();
		const thrown = await withAppTx((tx) =>
			adoptHqAppInTransaction(tx, withOverlongCells(birth)),
		).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(LookupError);
		expect((thrown as LookupError).code).toBe("storage_limit");
		expect((thrown as LookupError).message).toContain("district");

		seam.beforeBirth = async (created) => withOverlongCells(created);
		vi.mocked(log.error).mockClear();
		const answer = await bringIn((key, review) => createInputFor(key, review));
		expect(answer).toMatchObject({
			kind: "check-failed",
			finding: {
				code: "read-back-differs",
				detail: { name: "birth-integrity" },
			},
		});
		expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(0);
		const line = vi
			.mocked(log.error)
			.mock.calls.find(
				([message]) => message === "[reading] could not create: integrity",
			);
		expect(line).toBeDefined();
		expect(line?.[1]).toBeUndefined();
		expect(line?.[2]).toMatchObject({
			findingCodes: [],
			why: expect.stringContaining("storage_limit"),
		});
		expect(loggedText(vi.mocked(log.error).mock.calls)).not.toContain(
			"district",
		);
	});

	it("waits for another transaction holding the HQ app's claim lock, and commits once it lets go", async () => {
		const { birth } = await preparedBirth();
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holder = withAppTx(async (tx) => {
			await claimHqAppInTransaction(tx, birth.hqApp);
			held.resolve();
			await release.promise;
		});
		let born: Promise<unknown> | null = null;
		try {
			await held.promise;
			born = withAppTx((tx) => adoptHqAppInTransaction(tx, birth));
			await untilSomeoneWaits(1);
			/* The waiting birth asks for an advisory lock, the claim's, and holds no transaction
			 * id: a backend that had written a row would hold its own. Another connection's count
			 * of `apps` cannot tell, since an uncommitted insert is invisible to it. */
			expect(await waiterLocks()).toEqual({
				waitingFor: ["advisory"],
				holdsTransactionId: false,
			});
		} finally {
			release.resolve();
			await holder;
		}
		await expect(born).resolves.toEqual({ kind: "born", role: "owner" });
	});

	it("holds no Project state while it waits for the membership gate behind a membership write, so a lookup writer holding the gate finishes beside it", async () => {
		const { birth } = await preparedBirth();
		const OTHER = "bring-in-other-member";
		await h.seedProjectMember(OTHER, PROJECT, "viewer");
		/* The Project's state row exists before anyone waits, so a birth that had taken it
		 * would hold a lock another connection's NOWAIT meets. */
		await withAppTx((tx) => lockLookupProjectState(tx, PROJECT));
		const gated = Promise.withResolvers<void>();
		const birthWaits = Promise.withResolvers<void>();
		/* The lookup writer of the cycle: it holds the shared membership gate, and asks for
		 * Project state only once the birth is waiting. A birth that took Project state
		 * before the gate would close the cycle, and Postgres would end one transaction as
		 * deadlocked. */
		const writer = withAppTx(async (tx: Transaction<AppDatabase>) => {
			await projectRoleForInTransaction(tx, ACTOR, PROJECT);
			gated.resolve();
			await birthWaits.promise;
			await lockLookupProjectState(tx, PROJECT);
		});
		let membership: Promise<unknown> | null = null;
		let born: Promise<unknown> | null = null;
		try {
			await gated.promise;
			membership =
				sql`UPDATE auth_member SET role = 'editor' WHERE "userId" = ${OTHER}`.execute(
					h.db(),
				);
			await untilSomeoneWaits(1);
			born = withAppTx((tx) => adoptHqAppInTransaction(tx, birth));
			await untilSomeoneWaits(2);
			await expect(
				withAppTx(async (tx) => {
					await sql`SELECT 1 FROM lookup_project_state WHERE project_id = ${PROJECT} FOR UPDATE NOWAIT`.execute(
						tx,
					);
				}),
			).resolves.toBeUndefined();
		} finally {
			birthWaits.resolve();
			await writer;
		}
		await expect(membership).resolves.toBeDefined();
		await expect(born).resolves.toEqual({ kind: "born", role: "owner" });
	});

	it("takes its HQ app from an app in recently deleted, whose mapping it releases", async () => {
		const DELETED = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
		await birthAdoptedApp(h, {
			appId: DELETED,
			projectId: PROJECT,
			actorUserId: ACTOR,
			target: { server: FIXTURE_SERVER, domain: FIXTURE_DOMAIN },
			remoteAppId: FIXTURE_REMOTE_APP_ID,
		});
		await softDeleteApp(DELETED, ACTOR);
		await adoptFixtureApp({ projectId: PROJECT, actorUserId: ACTOR });
		const released = await h
			.db()
			.selectFrom("app_deployment_resources as r")
			.innerJoin("app_deployments as d", "d.id", "r.deployment_id")
			.select(["r.released_at"])
			.where("d.app_id", "=", DELETED)
			.where("r.kind", "=", "app")
			.executeTakeFirstOrThrow();
		expect(released.released_at).not.toBeNull();
	});
});

/** Every log call's arguments as text, an Error spelled by its message and stack, which
 *  JSON leaves out. */
function loggedText(calls: readonly unknown[]): string {
	return JSON.stringify(calls, (_key, value: unknown) =>
		value instanceof Error
			? { name: value.name, message: value.message, stack: value.stack }
			: value,
	);
}
