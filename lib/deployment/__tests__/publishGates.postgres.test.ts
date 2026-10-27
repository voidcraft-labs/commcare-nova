/**
 * The publish gates: what `publishAppToHq` asks a person to confirm, the
 * CommCare version it holds the target app to, when it asks before
 * changing the app's Web App setting and when HQ's create stops a first
 * publish, and what it does with the app's logo,
 * over real Postgres and a peer standing in for CommCare HQ.
 *
 * Every source read the peer serves is HQ's own answer, retained by the
 * proof lane (`proof/hq-reads/publish/`), or that answer with the one key a
 * case is about changed. Accepted imports and the lookup table answers are
 * written here in the shapes `lib/commcare/client.ts` and
 * `lib/commcare/hq/lookupTables.ts` read. These hold Nova's decisions (when
 * it refuses, what it sends, what it stores); what HQ does without a
 * privilege, below the floor or with each logo shape is the proof lane's.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readMultipartRequest,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import {
	type RetainedPublishRead,
	replyRetained,
	retainedBodyJson,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { connectWireFixtures } from "@/lib/commcare/__tests__/connectWireFixtures";
import { decrypt } from "@/lib/commcare/encryption";
import { locationOwnerFixture } from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitAppProjectMoveInTransaction } from "@/lib/db/apps";
import {
	asUuid,
	type BlueprintDoc,
	declaresWebApps,
	type MediaAssetId,
	type OrganizationLevel,
} from "@/lib/domain";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { createLookupTable, replaceLookupRows } from "@/lib/lookup/service";
import { createLocation } from "@/lib/organization/service";
import {
	CONNECT_FORWARDER,
	FLAT_LOCATION_FIXTURE,
	PLAN_FEATURES,
} from "@/lib/publish/planFeatures";
import {
	planLacksWebAppsMessage,
	webAppsChangeMessage,
} from "@/lib/publish/webApps";
import { downloadAssetBytes } from "@/lib/storage/media";
import { confirmationKeyOf } from "../confirmations";
import { DeploymentError } from "../errors";
import { narrowingTo } from "../platformNarrowing";
import { HQ_CHANGED_DURING_PUSH_MESSAGE } from "../remoteChanges";
import {
	type PublishOutcome,
	projectSpaceConfirmations,
	publishAppToHq,
} from "../service";
import { readDeployment } from "../store";
import type { DeploymentConfirmationKey } from "../types";
import { clinicVisitsDocument } from "./publishFixtures";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
/* The real boundary, spied on so one test can hand the publish a prepared
 * export the boundary would never give. */
vi.mock("@/lib/export/boundaryValidation", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/export/boundaryValidation")>();
	return {
		...actual,
		prepareExportBoundary: vi.fn(actual.prepareExportBoundary),
	};
});
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	vi.mocked(downloadAssetBytes).mockReset();
});
afterEach(() => vi.useRealTimers());

const h = setupAppStateTestDb("publish_gates_", { authSchema: "migrated" });
const APP = "gates-app",
	PROJECT = "program",
	ACTOR = "editor";
const TARGET = { server: "india" as const, domain: "clinic" };
const SCOPE = {
	appId: APP,
	projectId: PROJECT,
	actorUserId: ACTOR,
	role: "editor",
};
const HOST = "https://india.commcarehq.org";
const IMPORT = "/a/clinic/apps/api/import_app/";
const HQ_APP = "working-app";
const SOURCE = `/a/clinic/apps/source/${HQ_APP}/`;
const TABLES = "/a/clinic/api/lookup_table/v1/?limit=100";
const WORKBOOK = "/a/clinic/fixtures/fixapi/";
const ROWS = "/a/clinic/api/fixture/v1/?fixture_type_id=hq-table";
const MEDIA = `/a/clinic/apps/api/${HQ_APP}/multimedia/`;
const PROJECT_SPACES = "/api/user_domains/v1/?limit=100";
const HQ_APP_URL = `${HOST}/a/clinic/apps/view/${HQ_APP}/`;
const LOOKUP: DeploymentConfirmationKey = {
	kind: "plan-feature",
	subject: "lookup-tables",
};
const ORGANIZATION: DeploymentConfirmationKey = {
	kind: "plan-feature",
	subject: "organization",
};

async function seed(doc: BlueprintDoc = clinicVisitsDocument()) {
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		owner: "creator",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: ACTOR,
			commcare_username: "account",
			commcare_api_key: "ciphertext",
			commcare_server: "india",
			approved_domains: JSON.stringify([
				{ name: "clinic", displayName: "Clinic" },
			]),
			updated_at: new Date(),
		})
		.execute();
	return doc;
}

const WEB_APPS: DeploymentConfirmationKey = {
	kind: "plan-feature",
	subject: "web-apps",
};

/**
 * A publish of `doc`, confirming `confirm` and, for an app that declares Web
 * Apps, the `web-apps` plan feature every such app needs, unless the case
 * shows that confirmation being asked (`webApps: false`). `confirmWebApps` is
 * the answer to the Web Apps question.
 */
function publish(
	doc: BlueprintDoc,
	confirm: readonly DeploymentConfirmationKey[] = [],
	options: {
		readonly webApps?: boolean;
		readonly confirmWebApps?: boolean;
	} = {},
): Promise<PublishOutcome> {
	const withWebApps =
		declaresWebApps(doc) && options.webApps !== false ? [WEB_APPS] : [];
	return publishAppToHq({
		scope: SCOPE,
		...TARGET,
		doc,
		compiledAtSeq: 0,
		appName: doc.appName,
		confirm: [...withWebApps, ...confirm],
		...(options.confirmWebApps !== undefined && {
			confirmWebApps: options.confirmWebApps,
		}),
	});
}

function request(peer: MockAgent, path: string, method = "GET") {
	return peer.get(HOST).intercept({
		path,
		method,
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}
function serve(
	peer: MockAgent,
	name: RetainedPublishRead,
	edit?: (source: Record<string, unknown>) => void,
) {
	const answer = retainedPublishRead(name);
	if (edit === undefined) {
		replyRetained(request(peer, SOURCE), answer);
		return;
	}
	const source = retainedBodyJson(answer);
	edit(source);
	replyRetained(request(peer, SOURCE), {
		...answer,
		body: JSON.stringify(source),
	});
}
const version =
	(value: string | undefined) => (source: Record<string, unknown>) => {
		if (value === undefined) delete source.build_spec;
		else
			source.build_spec = {
				...(source.build_spec as Record<string, unknown>),
				version: value,
			};
	};
const webApps = (enabled: boolean) => (source: Record<string, unknown>) => {
	source.cloudcare_enabled = enabled;
};

type ImportBody = { appId: unknown; app: Record<string, unknown> };
/** An accepted import, written here: 201 for a create, 200 for an update. */
function accepted(peer: MockAgent, status: 200 | 201, bodies?: ImportBody[]) {
	request(peer, IMPORT, "POST").reply(async (opts) => {
		if (bodies !== undefined) {
			const form = await readMultipartRequest(opts);
			const file = form.get("app_file");
			if (!(file instanceof Blob)) throw new Error("Expected app JSON");
			bodies.push({
				appId: form.get("app_id"),
				app: JSON.parse(await file.text()),
			});
		}
		return {
			statusCode: status,
			data: JSON.stringify({
				success: true,
				app_id: HQ_APP,
				version: status === 201 ? 1 : 2,
			}),
		};
	});
}

/** Every request but the project-space list reads of the compatibility check. */
function requests(peer: MockAgent): string[] {
	return allRequests(peer).filter(
		(line) => !line.startsWith(`GET ${PROJECT_SPACES}`),
	);
}
function allRequests(peer: MockAgent): string[] {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map(({ method, fullUrl }) => `${method} ${fullUrl.replace(HOST, "")}`) ??
		[]
	);
}
function refusal(outcome: PublishOutcome) {
	if (outcome.landed) throw new Error("Expected the publish to stop");
	return outcome.refusal;
}
function landed(outcome: PublishOutcome) {
	if (!outcome.landed) {
		throw new Error(
			`Expected the publish to land: ${JSON.stringify(outcome.refusal.failure)}`,
		);
	}
	return outcome;
}
function confirmationRows() {
	return h
		.db()
		.selectFrom("app_deployment_confirmations")
		.select(["kind", "subject", "confirmed_by"])
		.where("withdrawn_at", "is", null)
		.orderBy("confirmed_at")
		.orderBy("id")
		.execute();
}

/** The profile properties an import body sends. */
function propertiesOf(body: ImportBody | undefined): Record<string, unknown> {
	if (body === undefined) throw new Error("Expected the import's body");
	return (body.app.profile as { properties: Record<string, unknown> })
		.properties;
}

/** A first publish of an app with no Project data, sending `confirm`, landed. */
async function firstPublishConfirming(
	peer: MockAgent,
	doc: BlueprintDoc,
	confirm: readonly DeploymentConfirmationKey[],
) {
	accepted(peer, 201);
	serve(peer, "source-shell");
	accepted(peer, 200);
	serve(peer, "source-live");
	return landed(await publish(doc, confirm));
}

/** A first publish of an app with no Project data, landed with the given read back. */
async function firstPublish(
	peer: MockAgent,
	doc: BlueprintDoc,
	readBack: (source: Record<string, unknown>) => void = () => {},
	bodies?: ImportBody[],
) {
	accepted(peer, 201, bodies);
	serve(peer, "source-shell");
	accepted(peer, 200, bodies);
	serve(peer, "source-live", readBack);
	return landed(await publish(doc));
}

// ── Documents with a lookup table ───────────────────────────────────────

const remoteTable = {
	id: "hq-table",
	tag: "facilities",
	is_global: true,
	fields: [{ field_name: "code" }, { field_name: "name" }],
};
async function lookupDocument(): Promise<BlueprintDoc> {
	const scope = { projectId: PROJECT, actorId: ACTOR, role: "editor" };
	const table = await createLookupTable(scope, {
		name: "Facilities",
		tag: "facilities",
		columns: [
			{ wireName: "code", label: "Code", dataType: "text" },
			{ wireName: "name", label: "Name", dataType: "text" },
		],
	});
	const [code, name] = table.columns;
	await replaceLookupRows(scope, {
		tableId: table.id,
		expectedTableRevision: table.tableRevision,
		rows: [{ [code.id]: "001", [name.id]: "Clinic" }],
	});
	return buildDoc({
		appName: "Facility visits",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							{
								id: "facility",
								kind: "single_select",
								optionsSource: {
									kind: "lookup",
									tableId: table.id,
									valueColumnId: code.id,
									labelColumnId: name.id,
								},
							},
						],
					},
				],
			},
		],
	});
}
function emptyTables(peer: MockAgent) {
	request(peer, TABLES).reply(200, { objects: [], meta: { next: null } });
}
function tablesWithOurs(peer: MockAgent) {
	request(peer, TABLES).reply(200, {
		objects: [remoteTable],
		meta: { next: null },
	});
}
function tableRows(peer: MockAgent) {
	request(peer, ROWS).reply(200, {
		meta: { next: null, total_count: 1 },
		objects: [
			{
				id: "hq-row",
				fixture_type: "facilities",
				fields: { code: "001", name: "Clinic" },
			},
		],
	});
}
function workbookTaken(peer: MockAgent) {
	request(peer, WORKBOOK, "POST").reply(200, { code: 200, message: "Done" });
}

// ── Documents with a place ──────────────────────────────────────────────

const LEVELS = "/a/clinic/api/location_type/v1/?limit=1000";
const PLACES = "/a/clinic/api/location/v2/?limit=1000";
const PLACE_PUSH = "/a/clinic/api/location/v2/";
const REGION = asUuid("11111111-1111-4111-8111-111111111111");
const remoteLevels = [
	{
		id: 1,
		name: "Region",
		code: "region",
		parent: null,
		administrative: false,
		shares_cases: true,
		view_descendants: false,
	},
];
const remotePlace = {
	location_id: "hq-north",
	name: "North",
	site_code: "north",
	location_type_code: "region",
	parent_location_id: "",
	latitude: null,
	longitude: null,
	location_data: {},
};

/** The lookup document with one organization level and one stored place. */
async function lookupAndPlaceDocument(): Promise<BlueprintDoc> {
	const level: OrganizationLevel = {
		uuid: REGION,
		code: "region",
		name: "Region",
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
	const doc = await lookupDocument();
	return {
		...doc,
		organizationLevels: { [REGION]: level },
		organizationLevelOrder: [REGION],
	};
}
async function seedPlace() {
	await createLocation(SCOPE, {
		levelUuid: REGION,
		name: "North",
		siteCode: "north",
		parentId: null,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
	});
}
/** The levels, and the places the project space holds. */
function inventory(peer: MockAgent, withNorth: boolean) {
	request(peer, LEVELS).reply(200, {
		meta: { next: null },
		objects: remoteLevels,
	});
	request(peer, PLACES).reply(200, {
		meta: { next: null },
		objects: withNorth ? [remotePlace] : [],
	});
}
/** The place batch taken, and the inventory read that reads it back. */
function placeTaken(peer: MockAgent) {
	request(peer, PLACE_PUSH, "PATCH").reply(202, JSON.stringify(["hq-north"]));
	request(peer, PLACES).reply(200, {
		meta: { next: null },
		objects: [remotePlace],
	});
}

/** A first publish of the lookup document, landed. */
async function firstLookupPublish(peer: MockAgent, doc: BlueprintDoc) {
	emptyTables(peer);
	accepted(peer, 201);
	serve(peer, "source-shell");
	workbookTaken(peer);
	tablesWithOurs(peer);
	tableRows(peer);
	serve(peer, "source-shell");
	accepted(peer, 200);
	serve(peer, "source-live");
	return landed(await publish(doc, [LOOKUP]));
}

/**
 * A republish of the lookup document over its first publish: preflight
 * compares the table and reads the app, the push reads the table back, and
 * the second read comes before the update.
 */
function republishLookup(
	peer: MockAgent,
	reads: {
		readonly target: (source: Record<string, unknown>) => void;
		readonly second: (source: Record<string, unknown>) => void;
	},
	bodies?: ImportBody[],
) {
	tablesWithOurs(peer);
	tableRows(peer);
	serve(peer, "source-live", reads.target);
	workbookTaken(peer);
	tablesWithOurs(peer);
	tableRows(peer);
	serve(peer, "source-live", reads.second);
	accepted(peer, 200, bodies);
	serve(peer, "source-live");
}

// ── C1. The version floor ───────────────────────────────────────────────

describe("the version floor", () => {
	it("refuses an app that is there below 2.57 before any write, with the app's address", async () => {
		const doc = await seed();
		await withHttpPeer(async (peer) => {
			await firstPublish(peer, doc);
			const before = requests(peer).length;
			serve(peer, "source-live", version("2.53.0"));
			const outcome = await publish(doc);
			expect(refusal(outcome)).toMatchObject({
				phase: "preflight",
				failure: {
					code: "hq_app_version_below_floor",
					message:
						"The app on “clinic” is set to CommCare 2.53.0, and Nova's apps need 2.57 or later. You can raise the CommCare version in that app's settings in CommCare HQ, then publish again. Phones on an older CommCare can no longer install or update the app after that. Saving that page can also set the app's other settings there, so Nova may show you what changed before it publishes.",
				},
			});
			expect(outcome.hqAppUrl).toBe(HQ_APP_URL);
			expect(requests(peer).slice(before)).toEqual([`GET ${SOURCE}`]);
		});
	});

	it.each([
		["no build_spec", undefined],
		["a version that reads latest", "latest"],
	] as const)(
		"refuses a source with %s as an app Nova cannot read",
		async (_, value) => {
			const doc = await seed();
			await withHttpPeer(async (peer) => {
				await firstPublish(peer, doc);
				serve(peer, "source-live", version(value));
				expect(refusal(await publish(doc))).toMatchObject({
					phase: "preflight",
					failure: { code: "hq_app_state_unknown" },
				});
			});
		},
	);

	it("stops a new app below the floor after its create and before any table or place, and the next publish fills that same app", async () => {
		const doc = await seed(await lookupAndPlaceDocument());
		await seedPlace();
		const confirm = [LOOKUP, ORGANIZATION];
		const bodies: ImportBody[] = [];
		await withHttpPeer(async (peer) => {
			emptyTables(peer);
			inventory(peer, false);
			accepted(peer, 201, bodies);
			serve(peer, "source-shell", version("2.53.0"));
			const stopped = await publish(doc, confirm);
			expect(refusal(stopped)).toMatchObject({
				phase: "resources",
				failure: {
					code: "hq_app_version_below_floor",
					message:
						"The app on “clinic” is set to CommCare 2.53.0, and Nova's apps need 2.57 or later. You can raise the CommCare version in that app's settings in CommCare HQ, then publish again. Phones on an older CommCare can no longer install or update the app after that. Nova created the app there and will fill it in on the next publish.",
				},
			});
			expect(stopped.hqAppUrl).toBe(HQ_APP_URL);
			expect(requests(peer)).toEqual([
				`GET ${TABLES}`,
				`GET ${LEVELS}`,
				`GET ${PLACES}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
			const kept = await readDeployment(SCOPE, TARGET);
			expect(kept?.active).toEqual([
				expect.objectContaining({ kind: "app", remoteId: HQ_APP }),
			]);

			/* Raised on HQ's settings page, whose save also writes the page's
			 * own value for each setting it shows. */
			const raised = (source: Record<string, unknown>) => {
				version("2.57.0")(source);
				source.profile = {
					properties: {
						"cc-show-saved": "no",
						"cc-fuzzy-search-enabled": "yes",
						log_prop_daily: "on",
					},
				};
			};
			emptyTables(peer);
			inventory(peer, false);
			serve(peer, "source-shell", raised);
			workbookTaken(peer);
			tablesWithOurs(peer);
			tableRows(peer);
			placeTaken(peer);
			serve(peer, "source-shell", raised);
			accepted(peer, 200, bodies);
			serve(peer, "source-live");
			expect(landed(await publish(doc, confirm)).hqAppAction).toBe("created");

			/* Its baseline is now `push`, so the next update reads the
			 * target's profile: a seeded setting someone changed in HQ keeps
			 * the target's value, one the target holds no value for takes
			 * Nova's, and a key Nova does not write stays. */
			const edited = (source: Record<string, unknown>) => {
				const { "cc-autoup-freq": _, ...properties } = propertiesOf(bodies[1]);
				source.profile = {
					properties: {
						...properties,
						"cc-fuzzy-search-enabled": "yes",
						log_prop_daily: "on",
					},
				};
			};
			tablesWithOurs(peer);
			tableRows(peer);
			inventory(peer, true);
			serve(peer, "source-live", edited);
			workbookTaken(peer);
			tablesWithOurs(peer);
			tableRows(peer);
			placeTaken(peer);
			serve(peer, "source-live", edited);
			accepted(peer, 200, bodies);
			serve(peer, "source-live");
			expect(landed(await publish(doc)).hqAppAction).toBe("updated");
		});
		expect(bodies.map((body) => body.appId)).toEqual([null, HQ_APP, HQ_APP]);
		/* The fill takes no setting from the shell: the profile holds Nova's
		 * seventeen, none of the page's values. */
		const filled = propertiesOf(bodies[1]);
		expect(Object.keys(filled)).toHaveLength(17);
		expect(filled).not.toHaveProperty("log_prop_daily");
		expect(filled["cc-fuzzy-search-enabled"]).not.toBe("yes");
		const updated = propertiesOf(bodies[2]);
		expect(updated).toEqual({
			...filled,
			"cc-fuzzy-search-enabled": "yes",
			log_prop_daily: "on",
		});
	});

	it("stops the next publish to a raised shell that someone gave a menu in HQ", async () => {
		const doc = await seed(await lookupDocument());
		const { modules } = retainedBodyJson(retainedPublishRead("source-live"));
		await withHttpPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			serve(peer, "source-shell", version("2.53.0"));
			refusal(await publish(doc, [LOOKUP]));

			const before = requests(peer).length;
			emptyTables(peer);
			serve(peer, "source-shell", (source) => {
				version("2.57.0")(source);
				source.modules = modules;
			});
			expect(refusal(await publish(doc, [LOOKUP])).failure.code).toBe(
				"hq_changed",
			);
			const after = requests(peer).slice(before);
			expect(after).not.toContain(`POST ${WORKBOOK}`);
			expect(after).not.toContain(`POST ${IMPORT}`);
		});
	});

	it("keeps the mapping of a new app whose version is unreadable, and sends no table", async () => {
		const doc = await seed(await lookupDocument());
		await withHttpPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			serve(peer, "source-shell", version("latest"));
			expect(refusal(await publish(doc, [LOOKUP]))).toMatchObject({
				phase: "resources",
				failure: { code: "hq_app_state_unknown" },
			});
			expect(requests(peer)).not.toContain(`POST ${WORKBOOK}`);
		});
		expect((await readDeployment(SCOPE, TARGET))?.active).toEqual([
			expect.objectContaining({ kind: "app", remoteId: HQ_APP }),
		]);
	});

	it("reads the publish's first read alone: a version lowered during the push lands, and the next publish stops", async () => {
		const doc = await seed(await lookupDocument());
		await withHttpPeer(async (peer) => {
			await firstLookupPublish(peer, doc);
			republishLookup(peer, { target: () => {}, second: version("2.53.0") });
			expect(landed(await publish(doc, [LOOKUP])).hqAppAction).toBe("updated");

			const before = requests(peer).length;
			tablesWithOurs(peer);
			tableRows(peer);
			serve(peer, "source-live", version("2.53.0"));
			expect(refusal(await publish(doc, [LOOKUP])).failure.code).toBe(
				"hq_app_version_below_floor",
			);
			const after = requests(peer).slice(before);
			expect(after).not.toContain(`POST ${WORKBOOK}`);
			expect(after).not.toContain(`POST ${IMPORT}`);
		});
	});
});

// ── C2 and C8. What a person confirms ───────────────────────────────────

describe("confirmations", () => {
	it("refuse a publish that needs one before any request, store nothing, and land once it is sent", async () => {
		const doc = await seed(await lookupDocument());
		await withHttpPeer(async (peer) => {
			const asked = await publish(doc);
			expect(refusal(asked)).toMatchObject({
				phase: "preflight",
				failure: { code: "hq_confirmation_needed" },
				confirmationsNeeded: [
					{
						kind: "plan-feature",
						subject: "lookup-tables",
						label: PLAN_FEATURES["lookup-tables"].label,
						plans: PLAN_FEATURES["lookup-tables"].plans,
						consequence: PLAN_FEATURES["lookup-tables"].consequence,
						reasons: ["The app reads data from a lookup table."],
					},
				],
			});
			expect(asked.deployment).toBeNull();
			expect(allRequests(peer)).toEqual([]);
			expect(await confirmationRows()).toEqual([]);

			await firstLookupPublish(peer, doc);
		});
		expect(await confirmationRows()).toEqual([
			{ kind: "plan-feature", subject: "web-apps", confirmed_by: ACTOR },
			{ kind: "plan-feature", subject: "lookup-tables", confirmed_by: ACTOR },
		]);
	});

	it("keep only what the app needs", async () => {
		const doc = await seed(await lookupDocument());
		await withHttpPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			serve(peer, "source-shell");
			workbookTaken(peer);
			tablesWithOurs(peer);
			tableRows(peer);
			serve(peer, "source-shell");
			accepted(peer, 200);
			serve(peer, "source-live");
			landed(
				await publish(doc, [
					LOOKUP,
					{ kind: "plan-feature", subject: "organization" },
					{ kind: "connect-forwarder" },
				]),
			);
			/* The confirmation stands: the next publish asks nothing. */
			republishLookup(peer, { target: () => {}, second: () => {} });
			landed(await publish(doc));
		});
		expect(await confirmationRows()).toEqual([
			{ kind: "plan-feature", subject: "web-apps", confirmed_by: ACTOR },
			{ kind: "plan-feature", subject: "lookup-tables", confirmed_by: ACTOR },
		]);
	});

	it("ask a Connect app for Data Forwarding and a Connect forwarder, and ask an app with no block for neither", async () => {
		const connect = connectWireFixtures().find(
			(fixture) => fixture.name === "deliver-default",
		)?.doc;
		if (connect === undefined) throw new Error("No Connect fixture");
		await seed(connect);
		await withHttpPeer(async (peer) => {
			const needed = refusal(await publish(connect)).confirmationsNeeded;
			expect(needed.map(({ kind, subject }) => ({ kind, subject }))).toEqual([
				{ kind: "plan-feature", subject: "worker-records" },
				{ kind: "plan-feature", subject: "data-forwarding" },
				{ kind: "connect-forwarder", subject: "connect-forwarder" },
			]);
			expect(needed[2]).toEqual({
				kind: "connect-forwarder",
				subject: "connect-forwarder",
				label: CONNECT_FORWARDER.label,
				plans: "",
				consequence: CONNECT_FORWARDER.consequence,
				reasons: [
					"Activity sends a deliver unit to CommCare Connect.",
					"Record & review sends a task to CommCare Connect.",
				],
				whereMissing: CONNECT_FORWARDER.whereMissing,
			});
			expect(needed[1]?.reasons).toEqual(needed[2]?.reasons);
			expect(allRequests(peer)).toEqual([]);
		});
		const plain = connectWireFixtures().find(
			(fixture) => fixture.name === "absent",
		)?.doc;
		if (plain === undefined) throw new Error("No plain fixture");
		await withHttpPeer(async (peer) => {
			accepted(peer, 201);
			serve(peer, "source-shell");
			accepted(peer, 200);
			serve(peer, "source-live");
			landed(await publish(plain));
		});
	});
});

describe("the pre-publish check's confirmations", () => {
	it("lists what a publish there asks, from the app's places, with nothing asked of a check with no project space", async () => {
		const doc = await seed(await lookupAndPlaceDocument());
		await seedPlace();
		const checks = await projectSpaceConfirmations(SCOPE, doc, TARGET);
		expect(checks.plan_features.map((feature) => feature.id)).toEqual([
			"web-apps",
			"lookup-tables",
			"organization",
		]);
		expect(
			checks.plan_features.find((feature) => feature.id === "organization")
				?.reasons,
		).toEqual(["This publish sends the places in your organization."]);
		expect(await projectSpaceConfirmations(SCOPE, doc, null)).toEqual({
			plan_features: [],
			flat_location_fixture: null,
			connect_forwarder: null,
		});
	});

	it("says the app is not there when its organization can no longer be read through the caller's Project", async () => {
		const doc = await seed(await lookupAndPlaceDocument());
		const elsewhere = { ...SCOPE, projectId: "another-program" };
		const refused = projectSpaceConfirmations(elsewhere, doc, TARGET);
		await expect(refused).rejects.toBeInstanceOf(DeploymentError);
		await expect(refused).rejects.toMatchObject({ code: "not_found" });
		/* With no project space chosen there is nothing to read. */
		await expect(
			projectSpaceConfirmations(elsewhere, doc, null),
		).resolves.toMatchObject({ plan_features: [] });
	});
});

// ── C5. The flat location list ──────────────────────────────────────────

describe("the flat location list", () => {
	it("is asked for an app whose form sets an owner from a place, and lands once confirmed", async () => {
		const doc = await seed(locationOwnerFixture("direct"));
		await withHttpPeer(async (peer) => {
			const needed = refusal(await publish(doc)).confirmationsNeeded;
			expect(needed).toContainEqual({
				kind: "flat-location-fixture",
				subject: "flat-location-fixture",
				label: FLAT_LOCATION_FIXTURE.label,
				plans: "",
				consequence: FLAT_LOCATION_FIXTURE.consequence,
				reasons: [
					"Transfer sets a case's owner from a place in your organization.",
				],
				whereMissing: FLAT_LOCATION_FIXTURE.whereMissing,
			});
			expect(allRequests(peer)).toEqual([]);
			await firstPublishConfirming(
				peer,
				doc,
				needed.map((need) => confirmationKeyOf(need)),
			);
		});
		expect(await confirmationRows()).toContainEqual({
			kind: "flat-location-fixture",
			subject: "flat-location-fixture",
			confirmed_by: ACTOR,
		});
	});

	it("is not asked for an app whose owners come from no place", async () => {
		const doc = await seed(locationOwnerFixture("plain"));
		await withHttpPeer(async (peer) => {
			const needed = refusal(await publish(doc)).confirmationsNeeded;
			expect(needed.map((need) => need.kind)).not.toContain(
				"flat-location-fixture",
			);
			await firstPublishConfirming(
				peer,
				doc,
				needed.map((need) => confirmationKeyOf(need)),
			);
		});
		expect((await confirmationRows()).map((row) => row.kind)).not.toContain(
			"flat-location-fixture",
		);
	});
});

// ── C2. The Web Apps question ──────────────────────────────────────────

/** `doc` declared to run on Android only. */
function androidOnly(doc: BlueprintDoc): BlueprintDoc {
	return {
		...doc,
		appSettings: { ...doc.appSettings, runsOnlyOn: "android" },
	};
}

/** The Web App setting an import body writes. */
function webAppsWritten(body: ImportBody | undefined): unknown {
	if (body === undefined) throw new Error("Expected the import's body");
	return body.app.cloudcare_enabled;
}

describe("the Web Apps question", () => {
	it("asks before turning Web Apps on for an app that holds content, sends nothing, and lands once the person answers with the declaration", async () => {
		const doc = await seed();
		const bodies: ImportBody[] = [];
		await withHttpPeer(async (peer) => {
			/* The last push read the setting off, so it is the declaration that
			 * moved, not a save in HQ. */
			await firstPublish(peer, doc, webApps(false));
			const before = requests(peer).length;
			serve(peer, "source-live", webApps(false));
			const asked = refusal(await publish(doc));
			expect(asked).toMatchObject({
				phase: "preflight",
				failure: {
					code: "hq_web_apps_change",
					message: webAppsChangeMessage("clinic", {
						from: false,
						to: true,
						changedInHq: false,
					}),
				},
				webAppsChange: { from: false, to: true, changedInHq: false },
			});
			expect(requests(peer).slice(before)).toEqual([`GET ${SOURCE}`]);

			serve(peer, "source-live", webApps(false));
			accepted(peer, 200, bodies);
			serve(peer, "source-live");
			landed(await publish(doc, [], { confirmWebApps: true }));
		});
		expect(bodies.map(webAppsWritten)).toEqual([true]);
	});

	it("says someone changed it in CommCare HQ when the baseline held the other value", async () => {
		const doc = await seed();
		await withHttpPeer(async (peer) => {
			await firstPublish(peer, doc);
			serve(peer, "source-live", webApps(false));
			const asked = refusal(await publish(doc));
			expect(asked.webAppsChange).toEqual({
				from: false,
				to: true,
				changedInHq: true,
			});
			expect(asked.failure.message).toMatch(
				/^Someone turned this app's Web App setting off in CommCare HQ since Nova last published it to “clinic”\./,
			);
		});
	});

	it("never asks over the empty app an earlier try made", async () => {
		const doc = await seed();
		const bodies: ImportBody[] = [];
		await withHttpPeer(async (peer) => {
			accepted(peer, 201, bodies);
			serve(peer, "source-shell", version("2.53.0"));
			expect(refusal(await publish(doc)).failure.code).toBe(
				"hq_app_version_below_floor",
			);
			/* Someone raised the version and, saving the settings page on a
			 * plan without Web Apps, turned the setting off: the shell holds no
			 * content, so the fill writes the declaration with no question. */
			const raisedOff = (source: Record<string, unknown>) => {
				version("2.57.0")(source);
				webApps(false)(source);
			};
			serve(peer, "source-shell", raisedOff);
			accepted(peer, 200, bodies);
			serve(peer, "source-live");
			const filled = landed(await publish(doc));
			expect(
				filled.checks.find((check) => check.id === "web-apps"),
			).toMatchObject({ status: "passed" });
		});
		expect(bodies.map((body) => body.appId)).toEqual([null, HQ_APP]);
		expect(webAppsWritten(bodies[1])).toBe(true);
		expect(Object.hasOwn(bodies[0]?.app ?? {}, "cloudcare_enabled")).toBe(
			false,
		);
	});

	it("asks again on the next publish whose read differs, storing no answer", async () => {
		const doc = await seed();
		await withHttpPeer(async (peer) => {
			await firstPublish(peer, doc);
			serve(peer, "source-live", webApps(false));
			accepted(peer, 200);
			serve(peer, "source-live");
			landed(await publish(doc, [], { confirmWebApps: true }));

			serve(peer, "source-live", webApps(false));
			expect(refusal(await publish(doc)).failure.code).toBe(
				"hq_web_apps_change",
			);
		});
		expect(await confirmationRows()).toEqual([
			{ kind: "plan-feature", subject: "web-apps", confirmed_by: ACTOR },
		]);
	});

	it("answers for the value it agreed to: an answer for the old value still asks", async () => {
		const doc = await seed();
		await withHttpPeer(async (peer) => {
			await firstPublish(peer, doc);
			serve(peer, "source-live", webApps(false));
			expect(
				refusal(await publish(doc, [], { confirmWebApps: false })).failure.code,
			).toBe("hq_web_apps_change");
		});
	});

	it("stops at the upload with hq_changed when the setting moved while a table was pushed", async () => {
		const doc = await seed(await lookupDocument());
		await withHttpPeer(async (peer) => {
			await firstLookupPublish(peer, doc);
			const before = requests(peer).length;
			tablesWithOurs(peer);
			tableRows(peer);
			serve(peer, "source-live");
			workbookTaken(peer);
			tablesWithOurs(peer);
			tableRows(peer);
			serve(peer, "source-live", webApps(false));
			const stopped = refusal(await publish(doc, [LOOKUP]));
			expect(stopped).toMatchObject({
				phase: "upload",
				failure: {
					code: "hq_changed",
					message: HQ_CHANGED_DURING_PUSH_MESSAGE,
				},
			});
			expect(requests(peer).slice(before)).not.toContain(`POST ${IMPORT}`);
		});
	});
});

describe("a first publish to a plan without Web Apps", () => {
	it("stops at resources when the new app reads Web Apps off, keeps the mapping, sends no table, and withdraws the web-apps confirmation in the same fold", async () => {
		const doc = await seed(await lookupDocument());
		await withHttpPeer(async (peer) => {
			emptyTables(peer);
			accepted(peer, 201);
			serve(peer, "source-shell", webApps(false));
			const stopped = await publish(doc, [LOOKUP]);
			expect(refusal(stopped)).toMatchObject({
				phase: "resources",
				failure: {
					code: "hq_plan_lacks_web_apps",
					message: planLacksWebAppsMessage(
						"clinic",
						narrowingTo(doc, "android"),
					),
				},
				webAppsChange: null,
			});
			expect(requests(peer)).toEqual([
				`GET ${TABLES}`,
				`POST ${IMPORT}`,
				`GET ${SOURCE}`,
			]);
			const kept = await readDeployment(SCOPE, TARGET);
			expect(kept?.active).toEqual([
				expect.objectContaining({ kind: "app", remoteId: HQ_APP }),
			]);
			expect(kept?.confirmations.map((row) => row.subject)).toEqual([
				"lookup-tables",
			]);

			/* The next publish asks the plan question again. */
			const asked = refusal(await publish(doc, [], { webApps: false }));
			expect(asked.confirmationsNeeded.map((need) => need.subject)).toEqual([
				"web-apps",
			]);
		});
		expect(await confirmationRows()).toEqual([
			{ kind: "plan-feature", subject: "lookup-tables", confirmed_by: ACTOR },
		]);
	});

	it("fills the same app on the retry once the person narrows the app to Android only, writing the setting off", async () => {
		const doc = await seed();
		const bodies: ImportBody[] = [];
		await withHttpPeer(async (peer) => {
			accepted(peer, 201, bodies);
			serve(peer, "source-shell", webApps(false));
			expect(refusal(await publish(doc)).failure.code).toBe(
				"hq_plan_lacks_web_apps",
			);
			const narrowed = androidOnly(doc);
			serve(peer, "source-shell", webApps(false));
			accepted(peer, 200, bodies);
			serve(peer, "source-live", webApps(false));
			expect(landed(await publish(narrowed)).hqAppAction).toBe("created");
		});
		expect(bodies.map((body) => body.appId)).toEqual([null, HQ_APP]);
		expect(webAppsWritten(bodies[1])).toBe(false);
	});

	it("fills the same app on the retry once the person confirms the plan again, writing the setting on", async () => {
		const doc = await seed();
		const bodies: ImportBody[] = [];
		await withHttpPeer(async (peer) => {
			accepted(peer, 201, bodies);
			serve(peer, "source-shell", webApps(false));
			refusal(await publish(doc));
			serve(peer, "source-shell", webApps(false));
			accepted(peer, 200, bodies);
			serve(peer, "source-live");
			landed(await publish(doc));
		});
		expect(bodies.map((body) => body.appId)).toEqual([null, HQ_APP]);
		expect(webAppsWritten(bodies[1])).toBe(true);
	});

	it("does not stop an Android-only app whose new app reads Web Apps on", async () => {
		const doc = androidOnly(await seed());
		const bodies: ImportBody[] = [];
		await withHttpPeer(async (peer) => {
			accepted(peer, 201, bodies);
			serve(peer, "source-shell");
			accepted(peer, 200, bodies);
			serve(peer, "source-live", webApps(false));
			landed(await publish(doc));
		});
		expect(webAppsWritten(bodies[1])).toBe(false);
	});
});

// ── C6. Logos ───────────────────────────────────────────────────────────

const pathOnly = { path: "jr://file/commcare/abc.png" };
const uploaded = (path: string) => ({
	path,
	uid: "a1b2c3",
	m_id: "e9f8d7c6b5a4",
	url: "/hq/multimedia/file/CommCareImage/e9f8d7c6b5a4/logo.png",
	updated: true,
	original_path: "logo.png",
	icon_class: "fa fa-picture-o",
	media_type: "CommCareImage",
	humanized_content_length: "4.2 KB",
	image_size: "64 x 64",
});
const logoRefs =
	(refs: unknown) =>
	(source: Record<string, unknown>): void => {
		source.logo_refs = refs;
	};

async function seedImage(id: MediaAssetId, file: string, project = PROJECT) {
	const bytes = readFileSync(file);
	const hash = createHash("sha256").update(bytes).digest("hex");
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id,
			project_id: project,
			owner: "creator",
			kind: "image",
			content_hash: hash,
			mime_type: "image/png",
			extension: ".png",
			size_bytes: bytes.length,
			gcs_object_key: `projects/${project}/${hash}.png`,
			original_filename: "logo.png",
			display_name: "Logo",
			status: "ready",
		})
		.execute();
	return bytes;
}
function mediaTaken(peer: MockAgent) {
	request(peer, MEDIA, "POST").reply(200, {
		success: true,
		processing_id: "media-job",
	});
	request(peer, `${MEDIA}status/media-job/`).reply(200, {
		success: true,
		processing_id: "media-job",
		complete: true,
		matched_count: 1,
		unmatched_count: 0,
		unmatched_files: [],
		errors: [],
	});
}

describe("logos", () => {
	it("offer the logo once per content, never upload a logo only the logo uses, and upload an image it shares", async () => {
		const logo = testMediaAssetId("gates-logo");
		const other = testMediaAssetId("gates-other-logo");
		const doc = clinicVisitsDocument();
		doc.logo = logo;
		await seed(doc);
		const first = await seedImage(logo, "public/nova-icons/household.png");
		const second = await seedImage(other, "public/nova-icons/checklist.png");
		vi.mocked(downloadAssetBytes).mockImplementation(async (key) =>
			key.includes(createHash("sha256").update(first).digest("hex"))
				? first
				: second,
		);
		await withHttpPeer(async (peer) => {
			const offered = await firstPublish(peer, doc);
			expect(offered.logoStep).toEqual({
				assetId: logo,
				fileName: "logo.png",
				changed: true,
			});
			expect(requests(peer).some((line) => line.includes(MEDIA))).toBe(false);

			serve(peer, "source-live");
			accepted(peer, 200);
			serve(peer, "source-live");
			expect(landed(await publish(doc)).logoStep?.changed).toBe(false);

			/* The same image on a question uploads for that question. */
			const field = Object.values(doc.fields)[0];
			if (field.kind !== "text") throw new Error("Expected a text field");
			field.label_media = { image: logo };
			doc.logo = other;
			serve(peer, "source-live");
			accepted(peer, 200);
			serve(peer, "source-live");
			mediaTaken(peer);
			const changed = landed(await publish(doc));
			expect(changed.logoStep?.changed).toBe(true);
			expect(requests(peer)).toContain(`POST ${MEDIA}`);
		});
	});

	it("offer the same logo as unchanged after the app moves Project", async () => {
		const DESTINATION = "program-destination";
		const logo = testMediaAssetId("gates-moving-logo");
		const moved = testMediaAssetId("gates-moved-logo");
		const doc = clinicVisitsDocument();
		doc.logo = logo;
		await seed(doc);
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await seedImage(logo, "public/nova-icons/household.png");
		await seedImage(moved, "public/nova-icons/household.png", DESTINATION);
		await withHttpPeer(async (peer) => {
			expect((await firstPublish(peer, doc)).logoStep?.changed).toBe(true);
			const result = await h
				.db()
				.transaction()
				.execute((tx) =>
					commitAppProjectMoveInTransaction(
						tx,
						{
							appId: APP,
							expectedFromProjectId: PROJECT,
							toProjectId: DESTINATION,
							actorUserId: ACTOR,
							assetIdMap: new Map([[logo, moved]]),
						},
						{ batchId: crypto.randomUUID() },
					),
				);
			expect(result).toEqual({ kind: "moved" });

			serve(peer, "source-live");
			accepted(peer, 200);
			serve(peer, "source-live");
			const after = landed(
				await publishAppToHq({
					scope: { ...SCOPE, projectId: DESTINATION, role: "owner" },
					...TARGET,
					doc: { ...doc, logo: moved },
					compiledAtSeq: 0,
					appName: doc.appName,
					confirm: [],
				}),
			);
			expect(after.logoStep).toEqual({
				assetId: moved,
				fileName: "logo.png",
				changed: false,
			});
		});
	});

	it("refuse a source whose logo_refs is not an object, and publish one with no logo_refs key", async () => {
		const doc = await seed();
		await withHttpPeer(async (peer) => {
			await firstPublish(peer, doc);
			serve(peer, "source-live", logoRefs(["hq_logo_web_apps"]));
			expect(refusal(await publish(doc)).failure.code).toBe(
				"hq_app_state_unknown",
			);
			serve(peer, "source-live", (source) => {
				delete source.logo_refs;
			});
			accepted(peer, 200);
			serve(peer, "source-live");
			landed(await publish(doc));
		});
	});

	it("work out the logo step before sending anything, so a logo the publish cannot offer stops it before HQ has an app to forget", async () => {
		const logo = testMediaAssetId("gates-lost-logo");
		const doc = clinicVisitsDocument();
		doc.logo = logo;
		await seed(doc);
		const bytes = await seedImage(logo, "public/nova-icons/household.png");
		vi.mocked(downloadAssetBytes).mockResolvedValue(bytes);
		const boundary = vi.mocked(prepareExportBoundary);
		const actual = boundary.getMockImplementation();
		if (actual === undefined) throw new Error("Expected the real boundary");
		boundary.mockImplementationOnce(async (input) => {
			const result = await actual(input);
			if (!result.ok) return result;
			const assets = new Map(result.prepared.assets);
			assets.delete(logo);
			return { ...result, prepared: { ...result.prepared, assets } };
		});
		await withHttpPeer(async (peer) => {
			await expect(publish(doc)).rejects.toThrow(
				/is not among the assets this publish resolved/,
			);
			expect(requests(peer)).toEqual([]);
		});
		expect(await readDeployment(SCOPE, TARGET)).toBeNull();
	});

	it("build the cleanup on the last read before the import, and stop for neither difference", async () => {
		const doc = await seed(await lookupDocument());
		const bodies: ImportBody[] = [];
		await withHttpPeer(async (peer) => {
			await firstLookupPublish(peer, doc);

			republishLookup(
				peer,
				{
					target: logoRefs({ hq_logo_web_apps: pathOnly }),
					second: logoRefs({
						hq_logo_web_apps: uploaded("jr://file/commcare/web.png"),
					}),
				},
				bodies,
			);
			landed(await publish(doc));

			const home = uploaded("jr://file/commcare/home.png");
			republishLookup(
				peer,
				{
					target: logoRefs({
						hq_logo_web_apps: pathOnly,
						hq_logo_android_home: home,
					}),
					second: logoRefs({ hq_logo_web_apps: pathOnly }),
				},
				bodies,
			);
			landed(await publish(doc));
		});
		expect(bodies[0]?.app).not.toHaveProperty("logo_refs");
		expect(bodies[1]?.app.logo_refs).toEqual({});
	});
});
