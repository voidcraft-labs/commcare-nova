/**
 * A bring-in's create over real Postgres, with CommCare HQ answering through
 * a controlled peer from its own retained answers, the stored key's
 * decryption controlled at the KMS boundary, and the bucket controlled at
 * its own. The birth's own function is wrapped where a test needs a moment
 * between the create's checks and its transaction.
 *
 * It would catch: an adopted app that reads as an empty shell, or a writer
 * left outside the birth; a ledger write assembled from the wrong read; a
 * create from a state CommCare HQ has left, or files added for an app that
 * did not come in; a table meeting a Project table unseen; a person sent back
 * to a review that did not change; the create route as a way to put files in
 * a Project; an answer that changes the document after its digest was taken;
 * a digest that sees asset ids; a second copy of a file the Project holds; a
 * lost response making a second app; every overlap of two creates of one
 * reading answered as anything but that app; two Nova apps on one HQ app; a
 * stale receipt; media that is not idempotent by content; and a person who
 * lost edit in the Project putting files or an app in it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedBodyText,
} from "@/__tests__/helpers/retainedHqReads";
import { parseAppMaterializationReceipt } from "@/components/chat/chatLifecycle";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch, softDeleteApp } from "@/lib/db/apps";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { createLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import { publishReadyMedia } from "@/lib/media/publishReadyMedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";
import { deleteAsset, uploadAssetBytes } from "@/lib/storage/media";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import { birthAdoptedApp } from "../../__tests__/adoptedBirth";
import { nextPublishAction, publishedRemoteApp } from "../../resources";
import { readDeploymentsForApp } from "../../store";
import { broughtInAppId } from "../appId";
import type { AdoptionBirth } from "../birth";
import { createFromReview } from "../create";
import { broughtInLookupTableId } from "../projectData/lookupIds";
import { authorizeBringIn, readHqAppForReview } from "../read";
import type { BringInInput, CreateAnswer, ReadingEvent } from "../types";
import {
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
	fixtureSourceWithXml,
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

const h = setupAppStateTestDb("bring_in_create_", {
	authSchema: "migrated",
	poolMax: 4,
});

const PROJECT = "bring-in-project";
const OTHER_PROJECT = "bring-in-other-project";
const ACTOR = "bring-in-editor";
const KEY = fixtureKey(PROJECT);
const SCOPE: LookupScope = {
	projectId: PROJECT,
	actorId: ACTOR,
	role: "owner",
};
const PNG = readFileSync(
	join(import.meta.dirname, "../../../media/__tests__/fixtures/pattern.png"),
);

type Peer = MockAgent;

function servePng(peer: Peer, multimediaId: string, times = 1): void {
	peer
		.get(FIXTURE_HOST)
		.intercept({ path: FIXTURE_PATHS.media(multimediaId), method: "GET" })
		.reply(200, PNG, { headers: { "content-type": "image/png" } })
		.times(times);
}

const requested = (peer: Peer): readonly string[] =>
	(peer.getCallHistory()?.calls() ?? []).map((call) =>
		call.fullUrl.slice(FIXTURE_HOST.length),
	);

async function actorFor(userId = ACTOR) {
	const actor = await authorizeBringIn(userId, PROJECT);
	if (actor === null) throw new Error(`${userId} holds no edit.`);
	return actor;
}

async function read(userId = ACTOR) {
	return reviewOf(
		await readHqAppForReview(await actorFor(userId), KEY, {
			onEvent: () => {},
		}),
	);
}

async function create(
	input: BringInInput,
	userId = ACTOR,
	events: ReadingEvent[] = [],
): Promise<CreateAnswer> {
	return createFromReview(await actorFor(userId), input, {
		onEvent: (event) => events.push(event),
	});
}

function receiptOf(answer: CreateAnswer) {
	if (answer.kind !== "created")
		throw new Error(`The create answered ${JSON.stringify(answer)}`);
	return answer.receipt;
}

/** Each table of the database and its row count. */
async function rowCounts(): Promise<Record<string, number>> {
	const { rows: tables } = await sql<{ name: string }>`
		SELECT table_schema || '.' || table_name AS name
		FROM information_schema.tables
		WHERE table_type = 'BASE TABLE'
			AND table_schema NOT IN ('pg_catalog', 'information_schema')
		ORDER BY 1
	`.execute(h.db());
	const counts: Record<string, number> = {};
	for (const { name } of tables) {
		const [schema, table] = name.split(".");
		const { rows } = await sql<{ count: string }>`
			SELECT count(*)::text AS count FROM ${sql.table(`${schema}.${table}`)}
		`.execute(h.db());
		counts[name] = Number(rows[0]?.count);
	}
	return counts;
}

/** The digest a tab checks a receipt's blueprint against: SHA-256 over its canonical JSON text. */
function tabDigest(blueprint: unknown): string {
	return createHash("sha256")
		.update(canonicalJsonText(blueprint))
		.digest("hex");
}

async function count(query: ReturnType<typeof sql<{ count: string }>>) {
	const { rows } = await query.execute(h.db());
	return Number(rows[0]?.count);
}

/** The Project's own `district`, its rows other than CommCare HQ's. */
async function seedProjectDistrict() {
	const created = await createLookupTable(SCOPE, {
		name: "Districts",
		tag: "district",
		columns: [
			{ wireName: "code", label: "Code", dataType: "text" },
			{ wireName: "name", label: "Name", dataType: "text" },
		],
	});
	const [code, name] = created.columns;
	if (code === undefined || name === undefined) throw new Error("no columns");
	await replaceLookupRows(SCOPE, {
		tableId: created.id,
		expectedTableRevision: created.tableRevision,
		rows: [{ [code.id]: "east", [name.id]: "East district" }],
	});
	return created;
}

function iconSource(icons: readonly string[] = ["menuicon"]) {
	return withIcons(fixtureSource(), icons);
}

/** The Gate a test opens to let a held request go on. */
function gate() {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return { reached, release };
}

/** Answer `path` from `answer`, holding the `held`-th request until `hold.release`. */
function serveHeld(
	peer: Peer,
	path: string,
	answer: RetainedHqAnswer | { status: number; body: Buffer; type: string },
	times: number,
	held: number,
	hold: ReturnType<typeof gate>,
): void {
	let seen = 0;
	peer
		.get(FIXTURE_HOST)
		.intercept({ path, method: "GET" })
		.reply(async () => {
			seen += 1;
			if (seen === held) {
				hold.reached.resolve();
				await hold.release.promise;
			}
			return "type" in answer
				? {
						statusCode: answer.status,
						data: answer.body,
						responseOptions: { headers: { "content-type": answer.type } },
					}
				: {
						statusCode: answer.status,
						data: retainedBodyText(answer),
						responseOptions: { headers: { ...answer.headers } },
					};
		})
		.times(times);
}

describe("createFromReview", () => {
	beforeEach(async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		await seedFixtureConnection(ACTOR);
	});

	it("creates the app whole: its entities, baseline, case schemas, table, media edge and deployment, at sequence 1", async () => {
		const events: ReadingEvent[] = [];
		const { review, answer } = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { source: iconSource(), times: 2 });
			servePng(peer, "menuicon", 2);
			const review = await read();
			return {
				review,
				answer: await create(createInputFor(KEY, review), ACTOR, events),
			};
		});
		const receipt = receiptOf(answer);
		const appId = broughtInAppId(ACTOR, KEY, review.readingId);
		expect(receipt.appId).toBe(appId);
		expect(receipt.seq).toBe(1);
		expect(receipt.adoption).toEqual({
			server: FIXTURE_SERVER,
			domain: FIXTURE_DOMAIN,
			remoteAppId: FIXTURE_REMOTE_APP_ID,
		});
		expect(parseAppMaterializationReceipt({ ...receipt })).not.toBeNull();
		expect(
			events.map((event) => event.type === "stage" && event.stage),
		).toEqual(expect.arrayContaining(["bringing-in-media", "creating"]));

		const app = await h.readAppRow(appId);
		expect(Number(app?.mutation_seq)).toBe(1);
		expect(app).toMatchObject({
			status: "complete",
			project_id: PROJECT,
			owner: ACTOR,
		});
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM blueprint_entities WHERE app_id = ${appId}`,
			),
		).toBeGreaterThan(2);
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM app_change_fold_baselines WHERE app_id = ${appId}`,
			),
		).toBe(1);
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM case_type_schemas WHERE app_id = ${appId}`,
			),
		).toBeGreaterThan(0);

		const tableId = broughtInLookupTableId(appId, review.readingId, "district");
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM lookup_tables WHERE id = ${tableId} AND project_id = ${PROJECT}`,
			),
		).toBe(1);
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM lookup_table_references WHERE app_id = ${appId} AND table_id = ${tableId}`,
			),
		).toBe(1);
		const [asset] = [
			...walkAssetRefs(hydratePersistedBlueprint(receipt.blueprint)),
		].map((ref) => ref.assetId);
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM media_asset_refs WHERE app_id = ${appId} AND asset_id = ${asset}`,
			),
		).toBeGreaterThan(0);

		const [deployment] = await readDeploymentsForApp({
			appId,
			projectId: PROJECT,
			role: "editor",
			actorUserId: ACTOR,
		});
		if (deployment === undefined) throw new Error("no deployment");
		expect(publishedRemoteApp(deployment)).toMatchObject({
			remoteId: FIXTURE_REMOTE_APP_ID,
			ownership: "adopted",
		});
		expect(nextPublishAction(deployment)).toBe("updates");
	});

	it("records the deployment the person reviewed: the target, the HQ app, the read baseline, the identities, the kept paths and the chosen declaration's confirmations", async () => {
		const { review, answer } = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { source: iconSource(), times: 2 });
			servePng(peer, "menuicon", 2);
			const review = await read();
			return { review, answer: await create(createInputFor(KEY, review)) };
		});
		const appId = receiptOf(answer).appId;
		const chosen = review.review.runsOn.find((choice) => choice.preselected);
		const deployment = await h
			.db()
			.selectFrom("app_deployments")
			.selectAll()
			.where("app_id", "=", appId)
			.executeTakeFirstOrThrow();
		expect(deployment).toMatchObject({
			project_id: PROJECT,
			server: FIXTURE_SERVER,
			domain: FIXTURE_DOMAIN,
			state: "uploaded",
			created_by: ACTOR,
		});
		const mapping = await h
			.db()
			.selectFrom("app_deployment_resources")
			.selectAll()
			.where("deployment_id", "=", deployment.id)
			.where("kind", "=", "app")
			.executeTakeFirstOrThrow();
		expect(mapping).toMatchObject({
			remote_id: FIXTURE_REMOTE_APP_ID,
			ownership: "adopted",
			adopted_by: ACTOR,
		});
		expect(Number(mapping.pushed_revision)).toBe(1);
		const baseline = await h
			.db()
			.selectFrom("app_deployment_baselines")
			.selectAll()
			.where("deployment_id", "=", deployment.id)
			.executeTakeFirstOrThrow();
		expect(baseline.origin).toBe("read");
		expect(Number(baseline.nova_revision)).toBe(1);
		expect(baseline.first_publish_changes).toEqual({
			ids: chosen?.firstPublish.ids.filter(
				(id) => id !== "web-apps-turned-off" && id !== "web-apps-turned-on",
			),
			webAppsOnInHq: review.review.webAppsOnInHq,
			of: "first-publish",
		});
		expect(baseline.media_files).toEqual({
			"commcare/image/menuicon.png": "menuicon",
		});

		const source = retainedBodyJson(iconSource());
		const [menu] = source.modules as Record<string, unknown>[];
		const [form] = (menu?.forms ?? []) as Record<string, unknown>[];
		const identities = await h
			.db()
			.selectFrom("app_deployment_identities")
			.select(["entity_kind", "unique_id", "xmlns"])
			.where("deployment_id", "=", deployment.id)
			.orderBy("entity_kind")
			.execute();
		expect(identities).toEqual([
			{ entity_kind: "form", unique_id: form?.unique_id, xmlns: form?.xmlns },
			{ entity_kind: "module", unique_id: menu?.unique_id, xmlns: null },
		]);
		const paths = await h
			.db()
			.selectFrom("app_deployment_media_paths")
			.select(["wire_path"])
			.where("deployment_id", "=", deployment.id)
			.execute();
		expect(paths).toEqual([{ wire_path: "commcare/image/menuicon.png" }]);
		const confirmations = await h
			.db()
			.selectFrom("app_deployment_confirmations")
			.select(["kind", "subject"])
			.where("deployment_id", "=", deployment.id)
			.execute();
		const asText = (rows: readonly object[]) =>
			rows.map((row) => JSON.stringify(row)).sort();
		expect(asText(confirmations)).toEqual(
			asText(chosen?.recordedFeatures ?? []),
		);
	});

	it("answers changed with the fresh review where a label changed in CommCare HQ, and writes nothing", async () => {
		const relabelled = fixtureSourceWithXml(
			(xml) => xml.replaceAll(">Note<", ">Comment<"),
			iconSource(),
		);
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { source: iconSource() });
			servePng(peer, "menuicon", 2);
			const review = await read();
			serveFixtureApp(peer, {
				source: relabelled,
				resource: fixtureResource(relabelled, { noteLabel: "Comment" }),
			});
			const before = await rowCounts();
			const answer = await create(createInputFor(KEY, review));
			if (answer.kind !== "changed" || answer.now.kind !== "review")
				throw new Error(JSON.stringify(answer));
			expect(answer.now.readingId).toBe(review.readingId);
			expect(answer.now.reviewDigest).not.toBe(review.reviewDigest);
			expect(await rowCounts()).toEqual(before);
			expect(uploadAssetBytes).not.toHaveBeenCalled();
		});
	});

	it("answers changed where a Project table of a tag the app reads was made since the review", async () => {
		await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 2 });
			const review = await read();
			await seedProjectDistrict();
			const answer = await create(createInputFor(KEY, review));
			expect(answer.kind).toBe("changed");
		});
	});

	it("creates where CommCare HQ's save counter alone moved, and records the create's counter", async () => {
		const resource = fixtureResource(fixtureSource(), { version: 7 });
		const answer = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer);
			const review = await read();
			serveFixtureApp(peer, { resource });
			return create(createInputFor(KEY, review));
		});
		const appId = receiptOf(answer).appId;
		const mapping = await h
			.db()
			.selectFrom("app_deployment_resources as r")
			.innerJoin("app_deployments as d", "d.id", "r.deployment_id")
			.select(["r.remote_revision"])
			.where("d.app_id", "=", appId)
			.where("r.kind", "=", "app")
			.executeTakeFirstOrThrow();
		expect(Number(mapping.remote_revision)).toBe(7);
	});

	describe("a create turned back before it publishes writes no row and adds no file", () => {
		const cases: readonly {
			readonly name: string;
			readonly before?: () => Promise<void>;
			readonly serving: (peer: Peer) => void;
			readonly input: (
				review: ReturnType<typeof createInputFor>,
			) => BringInInput;
			readonly answer: Partial<CreateAnswer>;
			readonly asksHq?: false;
		}[] = [
			{
				name: "CommCare HQ answers 503 on the counter: held",
				serving: (peer) => {
					const resource = fixtureResource(iconSource());
					serveAnswer(peer, FIXTURE_PATHS.application, resource);
					serveAnswer(peer, FIXTURE_PATHS.source, iconSource());
					serveAnswer(peer, FIXTURE_PATHS.version, {
						status: 503,
						headers: {},
					});
				},
				input: (input) => input,
				answer: { kind: "held" },
			},
			{
				name: "a reading id no read minted: changed",
				serving: (peer) => {
					serveFixtureApp(peer, { source: iconSource() });
					servePng(peer, "menuicon");
				},
				input: (input) => ({ ...input, readingId: uuidv7() }),
				answer: { kind: "changed" },
			},
			{
				name: "a declaration the review does not offer: choice_not_offered",
				serving: (peer) => {
					serveFixtureApp(peer, { source: iconSource() });
					servePng(peer, "menuicon");
				},
				input: (input) => ({ ...input, splitDatetime: true }),
				answer: { kind: "refused", refusal: "choice_not_offered" },
			},
			{
				name: "a table's choice left unanswered: choice_missing",
				before: async () => {
					await seedProjectDistrict();
				},
				serving: (peer) => {
					serveFixtureApp(peer, { source: iconSource() });
					servePng(peer, "menuicon");
				},
				input: (input) => input,
				answer: { kind: "refused", refusal: "choice_missing" },
			},
			{
				name: "an empty name: name_missing, asking CommCare HQ nothing",
				serving: () => {},
				input: (input) => ({ ...input, appName: "   " }),
				answer: { kind: "refused", refusal: "name_missing" },
				asksHq: false,
			},
		];

		it.each(cases)(
			"$name",
			async ({ before, serving, input, answer, asksHq }) => {
				await before?.();
				const review = await withHttpPeer(async (peer) => {
					serveFixtureApp(peer, { source: iconSource() });
					servePng(peer, "menuicon");
					return read();
				});
				const counts = await rowCounts();
				const result = await withHttpPeer(async (peer) => {
					serving(peer);
					const result = await create(input(createInputFor(KEY, review)));
					if (asksHq === false) expect(requested(peer)).toEqual([]);
					return result;
				});
				expect(result).toMatchObject(answer);
				expect(await rowCounts()).toEqual(counts);
				expect(uploadAssetBytes).not.toHaveBeenCalled();
			},
		);
	});

	describe("a table that asks a choice, whose Project table holds other rows", () => {
		it.each(["use-commcare-hq", "use-project"] as const)(
			"creates under %s, naming the Project table, with no further request to CommCare HQ",
			async (choice) => {
				await h.seedProjectMember(ACTOR, PROJECT, "owner");
				const project = await seedProjectDistrict();
				const answer = await withHttpPeer(async (peer) => {
					serveFixtureApp(peer, { times: 2 });
					const review = await read();
					const table = review.review.tables.find(
						(one) => one.tag === "district",
					);
					expect(table?.choice).not.toBeNull();
					const answer = await create(
						createInputFor(KEY, review, { tableChoices: { district: choice } }),
					);
					expect(
						requested(peer).filter(
							(path) => path === FIXTURE_PATHS.application,
						),
					).toHaveLength(2);
					return answer;
				});
				const receipt = receiptOf(answer);
				const reads = Object.values(receipt.blueprint.fields).flatMap(
					(field) =>
						"optionsSource" in field && field.optionsSource?.kind === "lookup"
							? [field.optionsSource.tableId]
							: [],
				);
				expect(reads).toEqual([project.id]);
				const stored = await h
					.db()
					.selectFrom("lookup_tables")
					.selectAll()
					.where("id", "=", project.id)
					.executeTakeFirstOrThrow();
				const rows = await count(
					sql`SELECT count(*)::text AS count FROM lookup_rows WHERE table_id = ${project.id}`,
				);
				if (choice === "use-project") {
					expect(String(stored.definition_revision)).toBe(
						String(project.definitionRevision),
					);
					expect(stored.hq_domain).toBeNull();
					expect(rows).toBe(1);
				} else {
					expect(stored.hq_domain).toBe(FIXTURE_DOMAIN);
					expect(stored.hq_taken_over_at).toBeNull();
					expect(rows).toBe(2);
				}
			},
		);

		it("refuses an answer whose offer is not offered", async () => {
			await seedProjectDistrict();
			await withHttpPeer(async (peer) => {
				serveFixtureApp(peer, { times: 2 });
				const review = await read();
				const table = review.review.tables.find(
					(one) => one.tag === "district",
				);
				expect(table?.choice?.options["use-commcare-hq"].offered).toBe(false);
				const answer = await create(
					createInputFor(KEY, review, {
						tableChoices: { district: "use-commcare-hq" },
					}),
				);
				expect(answer).toEqual({
					kind: "refused",
					refusal: "choice_not_offered",
				});
			});
		});
	});

	it("names one published file for two files of the same bytes, with the digest the review gave", async () => {
		const answer = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, {
				source: iconSource(["menuicon", "formicon"]),
				times: 2,
			});
			servePng(peer, "menuicon", 2);
			servePng(peer, "formicon", 2);
			const review = await read();
			return create(createInputFor(KEY, review));
		});
		const receipt = receiptOf(answer);
		const assets = new Set(
			[...walkAssetRefs(hydratePersistedBlueprint(receipt.blueprint))].map(
				(ref) => ref.assetId,
			),
		);
		expect(assets.size).toBe(1);
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM media_assets WHERE project_id = ${PROJECT}`,
			),
		).toBe(1);
	});

	it("names the file the Project already holds where it holds the same bytes", async () => {
		const validated = await validateSniffedMediaBytes(PNG);
		if (!validated.ok) throw new Error("the fixture image is refused");
		const held = await publishReadyMedia({
			actorUserId: ACTOR,
			projectId: PROJECT,
			bytes: PNG,
			validated: validated.validated,
			originalFilename: "pattern.png",
			assetId: "0a6f2c1e-3b4d-4e5f-8a9b-1c2d3e4f5a6b" as MediaAssetId,
		});
		vi.mocked(uploadAssetBytes).mockClear();
		const answer = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { source: iconSource(), times: 2 });
			servePng(peer, "menuicon", 2);
			return create(createInputFor(KEY, await read()));
		});
		const assets = [
			...walkAssetRefs(hydratePersistedBlueprint(receiptOf(answer).blueprint)),
		].map((ref) => ref.assetId);
		expect(assets).toEqual([held.assetId]);
		expect(uploadAssetBytes).not.toHaveBeenCalled();
	});

	it("answers the same create sent twice in turn with the same app, asking CommCare HQ nothing the second time", async () => {
		const { input, first } = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 2 });
			const input = createInputFor(KEY, await read());
			return { input, first: await create(input) };
		});
		const appId = receiptOf(first).appId;
		const changes = await count(
			sql`SELECT count(*)::text AS count FROM app_changes WHERE app_id = ${appId}`,
		);
		const second = await withHttpPeer(async (peer) => {
			const answer = await create(input);
			expect(requested(peer)).toEqual([]);
			return answer;
		});
		expect(second).toEqual(first);
		expect(
			parseAppMaterializationReceipt({ ...receiptOf(second) }),
		).not.toBeNull();
		expect(
			await count(
				sql`SELECT count(*)::text AS count FROM app_changes WHERE app_id = ${appId}`,
			),
		).toBe(changes);
	});

	describe("two creates of one reading at once answer one app", () => {
		it("one held at its stored key's decryption, before its claim advice, answers the app the other made", async () => {
			const hold = gate();
			let decrypted = 0;
			vi.mocked(decrypt).mockImplementation(async () => {
				decrypted += 1;
				if (decrypted === 2) {
					hold.reached.resolve();
					await hold.release.promise;
				}
				return "fixture-key";
			});
			await withHttpPeer(async (peer) => {
				serveFixtureApp(peer, { times: 2 });
				const input = createInputFor(KEY, await read());
				const held = create(input);
				try {
					await hold.reached.promise;
					const first = await create(input);
					hold.release.resolve();
					expect(await held).toEqual(first);
				} finally {
					hold.release.resolve();
					await held.catch(() => {});
				}
			});
			expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(
				1,
			);
		});

		it("one held at CommCare HQ's first media answer answers the app the other made", async () => {
			const hold = gate();
			await withHttpPeer(async (peer) => {
				serveFixtureApp(peer, { source: iconSource(), times: 3 });
				serveHeld(
					peer,
					FIXTURE_PATHS.media("menuicon"),
					{ status: 200, body: PNG, type: "image/png" },
					3,
					2,
					hold,
				);
				const input = createInputFor(KEY, await read());
				const held = create(input);
				try {
					await hold.reached.promise;
					const first = await create(input);
					hold.release.resolve();
					expect(await held).toEqual(first);
				} finally {
					hold.release.resolve();
					await held.catch(() => {});
				}
			});
			expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(
				1,
			);
		});

		it("one held at CommCare HQ's answer for the app, whose own read then meets the other's table, answers the app the other made", async () => {
			const hold = gate();
			const source = fixtureSource();
			const resource = fixtureResource(source);
			await withHttpPeer(async (peer) => {
				serveHeld(peer, FIXTURE_PATHS.application, resource, 3, 2, hold);
				serveAnswer(peer, FIXTURE_PATHS.source, source, 3);
				serveAnswer(peer, FIXTURE_PATHS.version, counterOf(resource), 3);
				serveFixtureTables(peer, 3);
				const input = createInputFor(KEY, await read());
				const held = create(input);
				try {
					await hold.reached.promise;
					const first = await create(input);
					hold.release.resolve();
					expect(await held).toEqual(first);
				} finally {
					hold.release.resolve();
					await held.catch(() => {});
				}
			});
			expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(
				1,
			);
		});
	});

	it("brings one HQ app in once for two people: the other create answers already-in-nova and leaves nothing", async () => {
		const SECOND = "bring-in-second-editor";
		await h.seedProjectMember(SECOND, PROJECT, "editor");
		await seedFixtureConnection(SECOND);
		const { first, second } = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 3 });
			const mine = createInputFor(KEY, await read());
			const theirs = createInputFor(KEY, await read(SECOND));
			const first = await create(mine);
			const second = await create(theirs, SECOND);
			return { first, second };
		});
		receiptOf(first);
		expect(second).toMatchObject({
			kind: "changed",
			now: { kind: "stop", finding: { code: "already-in-nova" } },
		});
		expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(1);
		expect(
			await count(sql`SELECT count(*)::text AS count FROM app_deployments`),
		).toBe(1);
		expect(
			await count(sql`SELECT count(*)::text AS count FROM lookup_tables`),
		).toBe(1);
	});

	it("answers already-in-nova where another person's create of the HQ app commits between this one's claim advice and its birth, and keeps nothing of its own", async () => {
		/* Both creates pass the claim advice of gatherReading, so the birth's own claim decides
		 * the race: this one's claim meets the other's app. */
		const SECOND = "bring-in-second-editor";
		await h.seedProjectMember(SECOND, PROJECT, "editor");
		await seedFixtureConnection(SECOND);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let holding = true;
		let heldAtBirth = false;
		seam.beforeBirth = async () => {
			if (!holding) return undefined;
			holding = false;
			heldAtBirth = true;
			reached.resolve();
			await release.promise;
			return undefined;
		};
		const { mine, theirs } = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { times: 4 });
			const myInput = createInputFor(KEY, await read());
			const theirInput = createInputFor(KEY, await read(SECOND));
			/* Mine waits at its birth, its claim advice already read. */
			const waiting = create(myInput).finally(() => {
				holding = false;
				reached.resolve();
			});
			let theirs: CreateAnswer;
			try {
				await reached.promise;
				theirs = await create(theirInput, SECOND);
			} finally {
				release.resolve();
			}
			return { mine: await waiting, theirs };
		});
		expect(heldAtBirth).toBe(true);
		receiptOf(theirs);
		expect(mine).toEqual({
			kind: "changed",
			now: expect.objectContaining({
				kind: "stop",
				finding: expect.objectContaining({ code: "already-in-nova" }),
			}),
		});
		expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(1);
		expect(
			await count(sql`SELECT count(*)::text AS count FROM app_deployments`),
		).toBe(1);
		expect(
			await count(sql`SELECT count(*)::text AS count FROM lookup_tables`),
		).toBe(1);
	});

	it("answers already-in-nova where another Nova app holds the HQ app, having added no file", async () => {
		const review = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { source: iconSource() });
			servePng(peer, "menuicon");
			return read();
		});
		await birthAdoptedApp(h, {
			appId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
			projectId: PROJECT,
			actorUserId: ACTOR,
			target: { server: FIXTURE_SERVER, domain: FIXTURE_DOMAIN },
			remoteAppId: FIXTURE_REMOTE_APP_ID,
		});
		const assets = await count(
			sql`SELECT count(*)::text AS count FROM media_assets`,
		);
		const answer = await withHttpPeer(async () =>
			create(createInputFor(KEY, review)),
		);
		expect(answer).toMatchObject({
			kind: "changed",
			now: { kind: "stop", finding: { code: "already-in-nova" } },
		});
		expect(
			await count(sql`SELECT count(*)::text AS count FROM media_assets`),
		).toBe(assets);
		expect(uploadAssetBytes).not.toHaveBeenCalled();
	});

	it("refuses an input that names a Project the actor was not authorized in, having asked CommCare HQ nothing and written nothing", async () => {
		await h.seedProjectMember(ACTOR, OTHER_PROJECT, "editor");
		const review = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer);
			return read();
		});
		const input = createInputFor(fixtureKey(OTHER_PROJECT), review);
		const before = await rowCounts();
		await withHttpPeer(async (peer) => {
			await expect(create(input)).rejects.toThrow(
				/authorized for one Project and asked to work in another/,
			);
			expect(requested(peer)).toEqual([]);
		});
		expect(await rowCounts()).toEqual(before);
		expect(uploadAssetBytes).not.toHaveBeenCalled();
	});

	it("answers a repeated create from the app as it stands: edited, moved, and in recently deleted", async () => {
		const { input, first } = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { app: "navigation", times: 2 });
			const input = createInputFor(KEY, await read());
			return { input, first: await create(input) };
		});
		const appId = receiptOf(first).appId;

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT,
			batchId: crypto.randomUUID(),
			mutations: admitMutationBatch([
				{ kind: "setAppName", name: "Renamed in Nova" },
			]),
			actorUserId: ACTOR,
			kind: "autosave",
		});
		const edited = receiptOf(await create(input));
		expect(edited.seq).toBe(2);
		expect(edited.blueprint.appName).toBe("Renamed in Nova");
		expect(parseAppMaterializationReceipt({ ...edited })).not.toBeNull();
		/* The digest a tab verifies the receipt by is the edited app's. */
		expect(edited.snapshotDigest).toBe(tabDigest(edited.blueprint));
		expect(edited.snapshotDigest).not.toBe(receiptOf(first).snapshotDigest);

		await h.seedProjectMember(ACTOR, OTHER_PROJECT, "owner");
		await h.moveAppToProject(appId, OTHER_PROJECT, ACTOR);
		const moved = receiptOf(await create(input));
		expect(moved.projectId).toBe(OTHER_PROJECT);
		expect(moved.snapshotDigest).toBe(tabDigest(moved.blueprint));

		await softDeleteApp(appId, ACTOR);
		expect(await create(input)).toEqual({
			kind: "refused",
			refusal: "app_unavailable",
		});
	});

	it("creates once and copies no file twice where a create that published failed and is sent again", async () => {
		seam.beforeBirth = async () => {
			throw new Error("The test stops this create after its publish.");
		};
		const input = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { source: iconSource(), times: 2 });
			servePng(peer, "menuicon", 2);
			const input = createInputFor(KEY, await read());
			await expect(create(input)).rejects.toThrow(/after its publish/);
			return input;
		});
		expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(0);
		expect(uploadAssetBytes).toHaveBeenCalledTimes(1);
		seam.beforeBirth = null;
		const answer = await withHttpPeer(async (peer) => {
			serveFixtureApp(peer, { source: iconSource() });
			servePng(peer, "menuicon");
			return create(input);
		});
		receiptOf(answer);
		expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(1);
		expect(
			await count(sql`SELECT count(*)::text AS count FROM media_assets`),
		).toBe(1);
		expect(uploadAssetBytes).toHaveBeenCalledTimes(1);
	});

	describe("a person who may only view the Project by the time the create acts brings nothing in", () => {
		it("answers no_project_access at the publish, having added no file and written no app", async () => {
			const review = await withHttpPeer(async (peer) => {
				serveFixtureApp(peer, { source: iconSource() });
				servePng(peer, "menuicon");
				return read();
			});
			/* Authorized as an editor, as the route does before its stream opens. */
			const actor = await actorFor();
			await h.seedProjectMember(ACTOR, PROJECT, "viewer");
			const before = await rowCounts();
			const answer = await withHttpPeer(async (peer) => {
				serveFixtureApp(peer, { source: iconSource() });
				servePng(peer, "menuicon");
				return createFromReview(actor, createInputFor(KEY, review), {
					onEvent: () => {},
				});
			});
			expect(answer).toEqual({
				kind: "refused",
				refusal: "no_project_access",
			});
			expect(await rowCounts()).toEqual(before);
			expect(uploadAssetBytes).not.toHaveBeenCalled();
		});

		it("answers no_project_access at the birth, having written no app", async () => {
			seam.beforeBirth = async () => {
				await h.seedProjectMember(ACTOR, PROJECT, "viewer");
				return undefined;
			};
			const answer = await withHttpPeer(async (peer) => {
				serveFixtureApp(peer, { source: iconSource(), times: 2 });
				servePng(peer, "menuicon", 2);
				return create(createInputFor(KEY, await read()));
			});
			expect(answer).toEqual({
				kind: "refused",
				refusal: "no_project_access",
			});
			/* The file reached the Project's library while its publisher could still edit. */
			expect(uploadAssetBytes).toHaveBeenCalledTimes(1);
			expect(await count(sql`SELECT count(*)::text AS count FROM apps`)).toBe(
				0,
			);
			expect(
				await count(sql`SELECT count(*)::text AS count FROM app_deployments`),
			).toBe(0);
			expect(
				await count(
					sql`SELECT count(*)::text AS count FROM app_deployment_resources`,
				),
			).toBe(0);
		});
	});
});
