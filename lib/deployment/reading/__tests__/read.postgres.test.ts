/**
 * A bring-in's read over real Postgres, with CommCare HQ answering through a
 * controlled peer from its own retained answers, the stored key's decryption
 * controlled at the KMS boundary, and the bucket controlled at its own.
 *
 * It would catch: a wrong answer for a readable app or for one Nova cannot
 * hold; a circumstance answered as an account, or the reverse; a read that
 * leaves a row, a file or a byte behind; two versions of an app mixed, or a
 * read that stops at the first save; every file of an app that cannot come in
 * fetched; a review offered before its files were judged; a first finding
 * hiding the rest; an unbounded answer; a guessed flag, or a probe every read
 * pays for, or a flag's answer the reader never sees; a read that outlives a closed tab; a caller that authorizes one
 * Project and reads in another; a word of an app in a log line, its error
 * argument included; and a reader that throws logged with nothing that says
 * where it threw.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	replyRetained,
	retainedBodyJson,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { decrypt } from "@/lib/commcare/encryption";
import {
	LOCATION_LEVELS,
	locationOwnerFixture,
} from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { hqPrivateFeatureFlag } from "@/lib/commcare/projectSpaceCompatibility";
import { readHqAppSteps, STAGES } from "@/lib/commcare/reader";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { BlueprintDoc } from "@/lib/domain";
import {
	FIXTURE_MODULE,
	PLATFORM_FEATURE_FIXTURES,
} from "@/lib/domain/__tests__/platformFeatureFixtures";
import { log } from "@/lib/logger";
import {
	CIRCUMSTANCE_STANDINGS,
	READ_CIRCUMSTANCES,
	type ReadCircumstance,
} from "@/lib/publish/hqFindings";
import { deleteAsset, uploadAssetBytes } from "@/lib/storage/media";
import { birthAdoptedApp } from "../../__tests__/adoptedBirth";
import { createFromReview } from "../create";
import { sourceMayReadPlaces } from "../projectData/places";
import { authorizeBringIn, readHqAppForReview } from "../read";
import {
	type BringInInput,
	type CreateAnswer,
	READING_ID_PATTERN,
	type ReadingAnswer,
	type ReadingEvent,
	type ReadingKey,
} from "../types";
import {
	createInputFor,
	FIXTURE_PATHS,
	serveAnswer,
	serveFixtureApp,
} from "./adoptionFixture";
import { servedExport } from "./novaReading";
import { servedHqApp, serveHqApp } from "./servedHqApp";
import { hqPlace, serveHqPlaces, serveLocationLevels } from "./servedPlaces";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
/* The reader runs as it is, a stage at a time as a request runs it; the spy
 * only shows what each run was handed. */
vi.mock("@/lib/commcare/reader", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/commcare/reader")>();
	return { ...actual, readHqAppSteps: vi.fn(actual.readHqAppSteps) };
});
/* The source's test of places runs as it is; a case makes it miss a spelling once. */
vi.mock("../projectData/places", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../projectData/places")>();
	return {
		...actual,
		sourceMayReadPlaces: vi.fn(actual.sourceMayReadPlaces),
	};
});
vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: vi.fn(),
	deleteAsset: vi.fn(),
	downloadAssetBytes: vi.fn(),
}));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	vi.mocked(uploadAssetBytes).mockReset();
	vi.mocked(deleteAsset).mockReset();
});

const h = setupAppStateTestDb("bring_in_read_", { authSchema: "migrated" });

const PROJECT = "bring-in-project";
const OTHER_PROJECT = "bring-in-other-project";
const ACTOR = "bring-in-editor";
const DOMAIN = "clinic";
const HOST = "https://india.commcarehq.org";
const APP = retainedBodyJson(retainedReadingRead("application")).id as string;
const KEY: ReadingKey = {
	projectId: PROJECT,
	server: "india",
	domain: DOMAIN,
	remoteAppId: APP,
};

const PATHS = {
	application: `/a/${DOMAIN}/api/application/v1/${APP}/`,
	source: `/a/${DOMAIN}/apps/source/${APP}/`,
	version: `/a/${DOMAIN}/apps/view/${APP}/current_version/`,
	list: `/a/${DOMAIN}/apps/api/list_apps/`,
	tables: `/a/${DOMAIN}/api/lookup_table/v1/?limit=1000`,
	levels: `/a/${DOMAIN}/api/location_type/v1/?limit=1000`,
	places: `/a/${DOMAIN}/api/location/v2/?limit=5000`,
	spaces: "/api/user_domains/v1/?limit=100",
	flagged: `/api/user_domains/v1/?limit=100&feature_flag=${hqPrivateFeatureFlag("save-only-edited-answers").slug}`,
	media: (id: string) => `/hq/multimedia/file/CommCareImage/${id}/`,
};

const PNG = readFileSync(
	join(import.meta.dirname, "../../../media/__tests__/fixtures/pattern.png"),
);
const AVIF = readFileSync(
	join(import.meta.dirname, "../../../media/__tests__/fixtures/pattern.avif"),
);
const AAC = readFileSync(
	join(import.meta.dirname, "../../../media/__tests__/fixtures/tone.aac"),
);

async function seed(): Promise<void> {
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
				{ name: DOMAIN, displayName: "Clinic" },
			]),
			updated_at: new Date(),
		})
		.execute();
}

type Body = Record<string, unknown>;

/** A retained answer with its JSON body changed. */
function changed(answer: RetainedHqAnswer, change: (body: Body) => Body) {
	return {
		...answer,
		body: JSON.stringify(change(structuredClone(retainedBodyJson(answer)))),
	};
}

const application = () => retainedReadingRead("application");
const source = () => retainedGroupRead("navigation-base/app-source");

/** The counter answer of an application resource's own version. */
function counterOf(resource: RetainedHqAnswer): RetainedHqAnswer {
	const version = retainedBodyJson(resource).version as number;
	return {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			currentVersion: version,
			latestBuild: version,
			latestReleasedBuild: null,
		}),
	};
}

function serve(peer: MockAgent, path: string, answer: RetainedHqAnswer) {
	replyRetained(peer.get(HOST).intercept({ path, method: "GET" }), answer);
}

/** `navigation-base` as CommCare HQ holds it, the source changed where a case asks. */
function serveApp(
	peer: MockAgent,
	options: {
		readonly resource?: RetainedHqAnswer;
		readonly source?: RetainedHqAnswer;
		readonly tables?: boolean;
	} = {},
): void {
	const resource = options.resource ?? application();
	serve(peer, PATHS.application, resource);
	serve(peer, PATHS.source, options.source ?? source());
	serve(peer, PATHS.version, counterOf(resource));
	if (options.tables !== false)
		serve(peer, PATHS.tables, retainedGroupRead("lookups/lookup-tables"));
}

const requested = (peer: MockAgent): readonly string[] =>
	(peer.getCallHistory()?.calls() ?? []).map((call) =>
		call.fullUrl.slice(HOST.length),
	);

async function read(
	serving: (peer: MockAgent) => void,
	options: {
		readonly key?: Partial<ReadingKey>;
		readonly cancel?: AbortSignal;
	} = {},
): Promise<{
	readonly answer: ReadingAnswer;
	readonly events: readonly ReadingEvent[];
	readonly requests: readonly string[];
}> {
	const actor = await authorizeBringIn(ACTOR, PROJECT);
	if (actor === null) throw new Error("The editor holds no edit.");
	return withHttpPeer(async (peer) => {
		serving(peer);
		const events: ReadingEvent[] = [];
		const answer = await readHqAppForReview(
			actor,
			{ ...KEY, ...options.key },
			{
				onEvent: (event) => events.push(event),
				...(options.cancel !== undefined && { cancel: options.cancel }),
			},
		);
		return { answer, events, requests: requested(peer) };
	});
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

function codes(answer: ReadingAnswer): readonly string[] {
	if (answer.kind !== "account") throw new Error(`a ${answer.kind}`);
	return answer.findings.map((finding) => finding.code);
}

/** The source's second form's XML, changed. */
function withSecondFormXml(
	answer: RetainedHqAnswer,
	change: (xml: string) => string,
): RetainedHqAnswer {
	return changed(answer, (body) => {
		const [menu] = body.modules as Body[];
		const [, form] = menu.forms as Body[];
		const attachments = body._attachments as Record<string, string>;
		const key = `${form.unique_id as string}.xml`;
		attachments[key] = change(attachments[key] as string);
		return body;
	});
}

/** A source one of whose forms declares a document type: a finding of the app's own. */
const withDoctype = (answer: RetainedHqAnswer = source()) =>
	withSecondFormXml(answer, (xml) =>
		xml.replace("<h:html", "<!DOCTYPE html><h:html"),
	);

/** A source one of whose forms Nova's parser cannot read: an `unrecognized` finding, with the
 *  reader defect behind it. */
const withUnparsedForm = (answer: RetainedHqAnswer = source()) =>
	withSecondFormXml(answer, (xml) => xml.slice(0, xml.indexOf("<h:body>")));

/** The source's first form, changed. */
function withFirstForm(
	answer: RetainedHqAnswer,
	change: (form: Body, xml: string) => { form?: Body; xml?: string },
): RetainedHqAnswer {
	return changed(answer, (body) => {
		const [menu] = body.modules as Body[];
		const [form] = menu.forms as Body[];
		const attachments = body._attachments as Record<string, string>;
		const key = `${form.unique_id as string}.xml`;
		const next = change(form, attachments[key] as string);
		if (next.form !== undefined) Object.assign(form, next.form);
		if (next.xml !== undefined) attachments[key] = next.xml;
		return body;
	});
}

/**
 * `doc`'s export as CommCare HQ serves it, on HQ's own app shell, with an
 * application resource that summarizes each menu and form by its ids alone.
 * Every circumstance these serve stands before acceptance compares HQ's
 * question summary, so no question needs summarizing.
 */
function serveExport(
	peer: MockAgent,
	doc: BlueprintDoc,
	body = servedExport(doc).body,
): void {
	const menus = body.modules as Body[];
	serveApp(peer, {
		source: {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		resource: changed(application(), (resource) => ({
			...resource,
			modules: menus.map((menu) => ({
				case_properties: [],
				case_type: menu.case_type ?? null,
				name: menu.name,
				unique_id: menu.unique_id,
				forms: (menu.forms as Body[]).map((form) => ({
					name: form.name,
					unique_id: form.unique_id,
					xmlns: form.xmlns,
					questions: [],
				})),
			})),
		})),
	});
}

/**
 * `forms-read-search`'s app with `case-list-here`'s case list and no
 * declaration: content Nova never admits, and an app CommCare HQ holds.
 */
function runsNowhereWhole(): BlueprintDoc {
	const doc = PLATFORM_FEATURE_FIXTURES["forms-read-search"].with();
	const here = PLATFORM_FEATURE_FIXTURES["case-list-here"].with();
	const menu = doc.modules[FIXTURE_MODULE];
	const list = here.modules[FIXTURE_MODULE]?.caseListConfig;
	if (
		menu === undefined ||
		list === undefined ||
		menu.caseListConfig === undefined
	)
		throw new Error("Both fixtures hold the fixture menu's case list.");
	menu.caseListConfig = {
		...list,
		searchInputs: menu.caseListConfig.searchInputs,
	};
	delete doc.appSettings.runsOnlyOn;
	return doc;
}

/** `doc` with the question `external` given its sibling's id, `name`. */
function withSiblingId(doc: BlueprintDoc): BlueprintDoc {
	const field = Object.values(doc.fields).find((one) => one.id === "external");
	if (field === undefined) throw new Error("The document holds `external`.");
	return {
		...doc,
		fields: { ...doc.fields, [field.uuid]: { ...field, id: "name" } },
	};
}

/** The fixture's table list, the fields of `district` changed. */
function districtFields(
	change: (fields: readonly Body[]) => readonly Body[],
): RetainedHqAnswer {
	return changed(
		retainedGroupRead("targeted-hq-side-lookup/lookup-tables"),
		(body) => {
			const [district] = body.objects as Body[];
			if (district === undefined)
				throw new Error("The fixture's list holds the table district.");
			district.fields = change(district.fields as Body[]);
			return body;
		},
	);
}

/** A source whose first menu shows an image as its icon, and the map entry that names it. */
function withMenuIcon(answer: RetainedHqAnswer, multimediaId: string) {
	const path = `jr://file/commcare/image/${multimediaId}.png`;
	return changed(answer, (body) => {
		const [menu] = body.modules as Body[];
		menu.media_image = { en: path };
		body.multimedia_map = {
			[path]: {
				doc_type: "HQMediaMapItem",
				media_type: "CommCareImage",
				multimedia_id: multimediaId,
				unique_id: `${multimediaId}-map`,
				version: 1,
			},
		};
		return body;
	});
}

/** `answer` with its first menu's sound at a path whose map entry names `multimediaId`, in a
 *  project space that checks no media at install (`cc-content-valid` `yes`). */
function withMenuSound(answer: RetainedHqAnswer, multimediaId: string) {
	const path = `jr://file/commcare/audio/${multimediaId}.mp3`;
	return changed(answer, (body) => {
		const [menu] = body.modules as Body[];
		menu.media_audio = { en: path };
		body.multimedia_map = {
			[path]: {
				doc_type: "HQMediaMapItem",
				media_type: "CommCareAudio",
				multimedia_id: multimediaId,
				unique_id: `${multimediaId}-map`,
				version: 1,
			},
		};
		const profile = body.profile as Body;
		profile.properties = {
			...(profile.properties as Body),
			"cc-content-valid": "yes",
		};
		return body;
	});
}

describe("readHqAppForReview", () => {
	beforeEach(seed);

	it("reads a retained readable app to a review, and the same app with one key no class declares to an account", async () => {
		const clean = await read((peer) => serveApp(peer));
		if (clean.answer.kind !== "review")
			throw new Error(JSON.stringify(clean.answer));
		expect(clean.answer.readingId).toMatch(READING_ID_PATTERN);
		expect(clean.answer.reviewDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(clean.answer.review.creates.menus).toBe(1);
		expect(clean.answer.review.creates.forms).toBe(2);
		expect(
			clean.answer.review.runsOn.filter((one) => one.preselected),
		).toHaveLength(1);
		expect(clean.events).toEqual([
			{ type: "stage", stage: "connecting" },
			{ type: "stage", stage: "reading-app" },
			{ type: "stage", stage: "reading-project-data" },
			{ type: "stage", stage: "checking" },
		]);

		const variant = await read((peer) =>
			serveApp(peer, { source: withDoctype() }),
		);
		expect(variant.answer).toMatchObject({
			kind: "account",
			mediaChecked: false,
		});
	});

	it("leaves no row, file or byte behind, whatever the read answers", async () => {
		const before = await rowCounts();
		await read((peer) => serveApp(peer));
		await read((peer) => serveApp(peer, { source: withDoctype() }));
		await read((peer) =>
			serve(peer, PATHS.application, {
				status: 503,
				headers: {},
			}),
		);
		expect(await rowCounts()).toEqual(before);
		expect(uploadAssetBytes).not.toHaveBeenCalled();
		expect(deleteAsset).not.toHaveBeenCalled();
	});

	describe("each circumstance a read raises, as the standing its code holds", () => {
		const resourceRefused = (
			name: Parameters<typeof retainedReadingRead>[0],
			listed: RetainedHqAnswer | null,
		) => {
			return (peer: MockAgent) => {
				serve(peer, PATHS.application, retainedReadingRead(name));
				if (listed !== null) serve(peer, PATHS.list, listed);
			};
		};
		const cases: readonly {
			readonly code: ReadCircumstance;
			readonly serving: (peer: MockAgent) => void;
			readonly key?: Partial<ReadingKey>;
			readonly before?: () => Promise<void>;
		}[] = [
			{
				code: "not-connected",
				serving: () => {},
				before: async () => {
					await h.db().deleteFrom("user_settings").execute();
				},
			},
			{
				code: "key-cannot-reach-space",
				serving: () => {},
				key: { domain: "another-space" },
			},
			{
				/* Nova's claims are advice asked only once CommCare HQ answered with the app. */
				code: "already-in-nova",
				serving: (peer) => serveApp(peer, { tables: false }),
				before: async () => {
					await birthAdoptedApp(h, {
						appId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
						projectId: PROJECT,
						actorUserId: ACTOR,
						target: { server: "india", domain: DOMAIN },
						remoteAppId: APP,
					});
				},
			},
			{
				code: "key-not-accepted",
				serving: (peer) =>
					serve(peer, PATHS.application, {
						status: 401,
						headers: { "Content-Type": "application/json" },
						body: "{}",
					}),
			},
			{
				code: "app-unreadable-in-hq",
				serving: (peer) => {
					const resource = retainedReadingRead("application-error-module");
					const [errored] = retainedBodyJson(resource).modules as Body[];
					serveApp(peer, {
						resource: changed(resource, (body) => ({
							...body,
							id: APP,
							modules: [errored, errored],
						})),
						source: changed(source(), (body) => {
							const [first] = body.modules as Body[];
							(body.modules as Body[]).push({
								...first,
								unique_id: "second-menu",
							});
							return body;
						}),
						tables: false,
					});
				},
			},
			{
				code: "plan-lacks-api-access",
				serving: resourceRefused(
					"application-no-api-access",
					retainedReadingRead("list-apps"),
				),
			},
			{
				code: "api-cut-off",
				serving: resourceRefused("application-api-cut-off", null),
			},
			{
				code: "cannot-access-apis",
				serving: resourceRefused(
					"application-no-permission",
					retainedReadingRead("list-apps"),
				),
			},
			{
				code: "not-a-member",
				serving: resourceRefused(
					"application-no-permission",
					retainedReadingRead("application-no-permission"),
				),
			},
			{
				code: "app-gone",
				serving: (peer) =>
					serve(
						peer,
						PATHS.application,
						changed(retainedReadingRead("application-build"), (body) => ({
							...body,
							id: APP,
						})),
					),
			},
			{
				code: "remote-app",
				serving: (peer) => {
					serve(
						peer,
						PATHS.application,
						retainedReadingRead("application-remote"),
					);
					serve(peer, PATHS.list, retainedReadingRead("list-apps"));
				},
			},
			{
				code: "app-deleted",
				serving: (peer) => {
					serve(
						peer,
						PATHS.application,
						retainedReadingRead("application-deleted"),
					);
					serve(
						peer,
						PATHS.list,
						changed(retainedReadingRead("list-apps"), (body) => ({
							...body,
							applications: [],
						})),
					);
					serve(
						peer,
						PATHS.source,
						retainedGroupRead("publish/source-deleted"),
					);
				},
			},
			{
				code: "linked-app",
				serving: (peer) => {
					serve(peer, PATHS.application, application());
					serve(peer, PATHS.source, retainedGroupRead("publish/source-linked"));
				},
			},
			{
				code: "hq-unavailable",
				serving: (peer) =>
					serve(peer, PATHS.application, { status: 500, headers: {} }),
			},
			{
				code: "hq-gateway-refused",
				serving: (peer) =>
					serve(peer, PATHS.application, {
						status: 403,
						headers: { "Content-Type": "text/html" },
						body: "<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>",
					}),
			},
			{
				code: "browser-only",
				serving: (peer) =>
					serve(peer, PATHS.application, {
						status: 302,
						headers: { Location: `${HOST}/accounts/login/` },
					}),
			},
			{
				code: "cannot-edit-apps",
				serving: (peer) => {
					serve(peer, PATHS.application, application());
					serve(
						peer,
						PATHS.source,
						retainedReadingRead("application-no-permission"),
					);
				},
			},
			{
				/* An app that reads places, whose levels the key may not read. */
				code: "cannot-read-organization",
				serving: (peer) => {
					serveExport(peer, locationOwnerFixture("plain", { placeRead: true }));
					serve(peer, PATHS.levels, { status: 403, headers: {} });
				},
			},
			{
				code: "unrecognized",
				serving: (peer) => serveApp(peer, { source: withUnparsedForm() }),
			},
			{
				/* The form builder's shadow of a bind names another question than the bind. */
				code: "shadow-disagrees",
				serving: (peer) =>
					serveApp(peer, {
						source: withFirstForm(source(), (_form, xml) => ({
							xml: xml.replace(
								'vellum:nodeset="#form/answer"',
								'vellum:nodeset="#form/elsewhere"',
							),
						})),
					}),
			},
			{
				/* An icon only Web Apps shows beside a sound only Android plays: no
				 * declaration runs where both play. */
				code: "media-not-played-where-app-runs",
				serving: (peer) => {
					const sound = "jr://file/commcare/audio/menusound.aac";
					serveApp(peer, {
						source: changed(withMenuIcon(source(), "menuicon"), (body) => {
							const [menu] = body.modules as Body[];
							menu.media_image = {
								en: "jr://file/commcare/image/menuicon.avif",
							};
							const map = body.multimedia_map as Record<string, Body>;
							const icon = map["jr://file/commcare/image/menuicon.png"];
							delete map["jr://file/commcare/image/menuicon.png"];
							map["jr://file/commcare/image/menuicon.avif"] = icon as Body;
							menu.media_audio = { en: sound };
							map[sound] = {
								doc_type: "HQMediaMapItem",
								media_type: "CommCareAudio",
								multimedia_id: "menusound",
								unique_id: "menusound-map",
								version: 1,
							};
							return body;
						}),
					});
					peer
						.get(HOST)
						.intercept({ path: PATHS.media("menuicon"), method: "GET" })
						.reply(200, AVIF, { headers: { "content-type": "image/avif" } });
					peer
						.get(HOST)
						.intercept({
							path: "/hq/multimedia/file/CommCareAudio/menusound/",
							method: "GET",
						})
						.reply(200, AAC, { headers: { "content-type": "audio/aac" } });
				},
			},
			{
				/* A wait longer than a read waits out is the answer. */
				code: "rate-limited",
				serving: (peer) => {
					const limited = retainedReadingRead("application-429");
					serve(peer, PATHS.application, {
						...limited,
						headers: { ...limited.headers, "Retry-After": "3" },
					});
				},
			},
			{
				/* A menu's sound whose file CommCare HQ does not serve: Web Apps offers it with
				 * nothing to play. */
				code: "media-file-unreadable",
				serving: (peer) => {
					serveApp(peer, { source: withMenuSound(source(), "menusound") });
					peer
						.get(HOST)
						.intercept({
							path: "/hq/multimedia/file/CommCareAudio/menusound/",
							method: "GET",
						})
						.reply(404, "")
						.persist();
				},
			},
			{
				/* CommCare HQ fails the table's rows twice, as it does every time. */
				code: "table-rows-unreadable",
				serving: (peer) => {
					const failing = { status: 500, headers: {} };
					serveFixtureApp(peer, { rows: failing });
					serveAnswer(peer, FIXTURE_PATHS.rows, failing);
				},
			},
			{
				/* A menu whose forms read the search, which Web Apps alone runs, beside a case list
				 * column that reads where the device is, which Android alone runs. CommCare HQ holds
				 * both in one app; no declaration runs it whole. */
				code: "no-platform-runs-everything",
				serving: (peer) => serveExport(peer, runsNowhereWhole()),
			},
			{
				/* A place whose parent CommCare HQ's list does not hold. */
				code: "place-hierarchy-inconsistent",
				serving: (peer) => {
					serveExport(peer, locationOwnerFixture("plain", { placeRead: true }));
					for (let read = 0; read < 2; read++) {
						serveLocationLevels(peer);
						serveHqPlaces(peer, [
							hqPlace("north", "region", null),
							hqPlace("north_district", "district", "elsewhere"),
						]);
					}
				},
			},
			{
				/* Two rows of `district` hold one value, so no question can take them as its
				 * choices. */
				code: "table-choices-unusable",
				serving: (peer) =>
					serveFixtureApp(peer, {
						rows: changed(
							retainedGroupRead(
								"targeted-hq-side-lookup/fixture-rows-district",
							),
							(body) => {
								const [first, second] = body.objects as Body[];
								if (first === undefined || second === undefined)
									throw new Error("The district table holds two rows.");
								(second.fields as Body).code = (first.fields as Body).code;
								return body;
							},
						),
					}),
			},
			{
				/* What stands in for a reader defect: the reader's draft of `navigation-base`
				 * doctored as acceptance's own tests doctor one, a question given its sibling's id,
				 * which no source CommCare HQ serves can make the reader give. Acceptance alone
				 * sees it, and the read answers Nova's own failure. */
				code: "read-back-differs",
				serving: (peer) => serveApp(peer),
				before: async () => {
					const { readHqAppSteps: actual } = await vi.importActual<
						typeof import("@/lib/commcare/reader")
					>("@/lib/commcare/reader");
					vi.mocked(readHqAppSteps).mockImplementationOnce(
						function* (input, options) {
							const outcome = yield* actual(input, options);
							if (outcome.kind !== "read")
								throw new Error("navigation-base reads to an account.");
							const doc = withSiblingId(outcome.draft.doc);
							return {
								...outcome,
								draft: {
									...outcome.draft,
									doc,
								},
							};
						},
					);
				},
			},
			{
				/* CommCare HQ's Manage Tables page saves a table with no field. */
				code: "table-has-no-fields",
				serving: (peer) =>
					serveFixtureApp(peer, {
						tables: districtFields(() => []),
					}),
			},
			{
				/* CommCare HQ holds two fields of one name. */
				code: "table-field-repeated",
				serving: (peer) =>
					serveFixtureApp(peer, {
						tables: districtFields((fields) => [...fields, fields[0]]),
					}),
			},
			{
				code: "table-cell-unrepresentable",
				serving: (peer) =>
					serveFixtureApp(peer, {
						rows: changed(
							retainedGroupRead(
								"targeted-hq-side-lookup/fixture-rows-district",
							),
							(body) => {
								const [row] = body.objects as Body[];
								(row.fields as Body).name = "North\u0001district";
								return body;
							},
						),
					}),
			},
		];

		it.each(cases)("$code", async ({ code, serving, key, before }) => {
			await before?.();
			const counts = await rowCounts();
			const { answer } = await read(serving, key === undefined ? {} : { key });
			if (CIRCUMSTANCE_STANDINGS[code].standing === "stop") {
				expect(answer).toMatchObject({ kind: "stop", finding: { code } });
			} else {
				expect(answer.kind).toBe("account");
				expect(codes(answer)).toContain(code);
			}
			/* Whatever it answers, a read leaves no row, file or byte behind. */
			expect(await rowCounts()).toEqual(counts);
			expect(uploadAssetBytes).not.toHaveBeenCalled();
			expect(deleteAsset).not.toHaveBeenCalled();
		});

		it("drives every code a read can raise, here or where its source is built", () => {
			/* These codes are driven where their source is built: a source one byte over the
			 * bound in cap.test.ts, a reading past its work limit in the reader's
			 * readWorkMeter.test.ts, a process with no room for one more bring-in in
			 * room.test.ts, and below, an app saved twice during the read and a menu
			 * CommCare HQ could not summarize beside the form's own finding. The ordinary
			 * form reader in instanceSources.test.ts drives both data-source conflicts. A place field
			 * the app cannot carry and one whose worker text HQ's answer sorted are driven where the
			 * place plan is built, in projectData/places.test.ts and worldEntities.test.ts. A file past
			 * what Nova reads of one file (a gigabyte, or a picture past 64 MB) is driven where its
			 * verdict is worded, in projectData/media.test.ts. A new code with no case fails here. */
			const elsewhere: readonly ReadCircumstance[] = [
				"too-large",
				"too-intricate",
				"nova-busy",
				"changed-while-reading",
				"menu-unreadable-in-hq",
				"form-data-source-conflict",
				"unbuildable-data-source-name",
				"place-field-unusable",
				"place-value-order-unknown",
				"media-file-too-large",
			];
			const driven = new Set([...cases.map(({ code }) => code), ...elsewhere]);
			expect(READ_CIRCUMSTANCES.filter((code) => !driven.has(code))).toEqual(
				[],
			);
		});
	});

	describe("an owner rule the places cannot satisfy", () => {
		it("is a question of the review, named by its level and both places, and never a choice of one", async () => {
			const counts = await rowCounts();
			/* Two clinics below one district: the owner rule that gives a case to the clinic
			 * below its owner names no one place. */
			const { answer } = await read((peer) => {
				serveHqApp(peer, servedHqApp(locationOwnerFixture("direct"), 1));
				serveLocationLevels(peer);
				serveHqPlaces(peer, [
					hqPlace("north", "region", null),
					hqPlace("north_district", "district", "north"),
					hqPlace("first_clinic", "clinic", "north_district"),
					hqPlace("second_clinic", "clinic", "north_district"),
				]);
			});
			if (answer.kind !== "review")
				throw new Error(`The read answered ${answer.kind}, not a review`);
			expect(answer.review.ownerRules).toEqual([
				{
					level: "clinic",
					levelName: expect.any(String),
					conflict: {
						kind: "two-places",
						source: "north_district",
						places: ["first_clinic", "second_clinic"],
					},
					forms: ["Transfer"],
				},
			]);
			expect(await rowCounts()).toEqual(counts);
		});

		/** The two-clinic app, read and then created with `choices`, in one peer. */
		async function readThenCreate(
			choices: BringInInput["ownerRuleChoices"],
		): Promise<CreateAnswer> {
			const actor = await authorizeBringIn(ACTOR, PROJECT);
			if (actor === null) throw new Error("The editor holds no edit.");
			/* One emission, served to both reads: the export mints its CommCare HQ ids. */
			const app = servedHqApp(locationOwnerFixture("direct"), 1);
			const serving = (peer: MockAgent) => {
				serveHqApp(peer, app);
				serveLocationLevels(peer);
				serveHqPlaces(peer, [
					hqPlace("north", "region", null),
					hqPlace("north_district", "district", "north"),
					hqPlace("first_clinic", "clinic", "north_district"),
					hqPlace("second_clinic", "clinic", "north_district"),
				]);
			};
			return withHttpPeer(async (peer) => {
				serving(peer);
				const answer = await readHqAppForReview(actor, KEY, {
					onEvent: () => {},
				});
				if (answer.kind !== "review")
					throw new Error(`The read answered ${answer.kind}, not a review`);
				serving(peer);
				return createFromReview(
					actor,
					{
						...createInputFor(KEY, answer),
						...(choices !== undefined && { ownerRuleChoices: choices }),
					},
					{ onEvent: () => {} },
				);
			});
		}

		it("refuses a create that leaves the question unanswered, and creates nothing", async () => {
			const counts = await rowCounts();
			expect(await readThenCreate(undefined)).toEqual({
				kind: "refused",
				refusal: "choice_missing",
			});
			expect(await rowCounts()).toEqual(counts);
		});

		it("refuses an answer for a level the review does not ask about", async () => {
			expect(
				await readThenCreate({ clinic: "worker", region: "worker" }),
			).toEqual({ kind: "refused", refusal: "choice_not_offered" });
		});

		it("creates the app with the worker who fills in the form owning those cases", async () => {
			const answer = await readThenCreate({ clinic: "worker" });
			if (answer.kind !== "created")
				throw new Error(`The create answered ${JSON.stringify(answer)}`);
			const operations = Object.values(answer.receipt.blueprint.forms).flatMap(
				(form) => form.caseOperations ?? [],
			);
			expect(operations.length).toBeGreaterThan(0);
			/* Every case the rule gave to a place is the submitting worker's. */
			expect(
				operations.filter(
					(operation) =>
						operation.owner !== undefined &&
						operation.owner.kind !== "acting-user",
				),
			).toEqual([]);
			expect(
				operations.some((operation) => operation.owner?.kind === "acting-user"),
			).toBe(true);
			/* The first publish gives those cases to the worker in CommCare HQ too, and its list
			 * says so, though the reading's own list could not. */
			const baseline = await h
				.db()
				.selectFrom("app_deployment_baselines as baseline")
				.innerJoin(
					"app_deployments as deployment",
					"deployment.id",
					"baseline.deployment_id",
				)
				.select("baseline.first_publish_changes")
				.where("deployment.app_id", "=", answer.receipt.appId)
				.executeTakeFirstOrThrow();
			expect(baseline.first_publish_changes?.ids).toContain(
				"owner-rule-given-to-worker",
			);
		});
	});

	describe("who holds the app in Nova, told only on CommCare HQ's answer", () => {
		const HOLDER = "bring-in-other-owner";
		/** A live Nova app of a Project the reader is not in holds the HQ app. */
		const heldElsewhere = async () => {
			await h.seedProjectMember(HOLDER, OTHER_PROJECT, "owner");
			await birthAdoptedApp(h, {
				appId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
				projectId: OTHER_PROJECT,
				actorUserId: HOLDER,
				target: { server: "india", domain: DOMAIN },
				remoteAppId: APP,
			});
		};
		const refusals: readonly {
			readonly name: string;
			readonly serving: (peer: MockAgent) => void;
		}[] = [
			{
				name: "a key CommCare HQ no longer accepts",
				serving: (peer) =>
					serve(peer, PATHS.application, {
						status: 401,
						headers: { "Content-Type": "application/json" },
						body: "{}",
					}),
			},
			{
				name: "an account no longer a member of the project space",
				serving: (peer) => {
					serve(
						peer,
						PATHS.application,
						retainedReadingRead("application-no-permission"),
					);
					serve(
						peer,
						PATHS.list,
						retainedReadingRead("application-no-permission"),
					);
				},
			},
			{
				name: "an app the project space no longer holds",
				serving: (peer) => {
					serve(peer, PATHS.application, {
						status: 404,
						headers: { "Content-Type": "application/json" },
						body: "{}",
					});
					serve(
						peer,
						PATHS.list,
						changed(retainedReadingRead("list-apps"), (body) => ({
							...body,
							applications: [],
						})),
					);
					serve(peer, PATHS.source, {
						status: 404,
						headers: { "Content-Type": "application/json" },
						body: "{}",
					});
				},
			},
			{
				name: "an account that can't edit apps",
				serving: (peer) => {
					serve(peer, PATHS.application, application());
					serve(
						peer,
						PATHS.source,
						retainedReadingRead("application-no-permission"),
					);
				},
			},
		];

		it.each(refusals)(
			"answers $name the same for a held app as for a free one, naming no holder",
			async ({ serving }) => {
				const free = await read(serving);
				await heldElsewhere();
				const held = await read(serving);
				expect(held.answer).toEqual(free.answer);
				expect(held.requests).toEqual(free.requests);
				expect(held.answer.kind).toBe("stop");
				expect(JSON.stringify(held.answer)).not.toContain("claim");
			},
		);

		it("names the holder once CommCare HQ answers with the app, before reading anything else", async () => {
			await heldElsewhere();
			const { answer, requests } = await read((peer) =>
				serveApp(peer, { tables: false }),
			);
			expect(answer).toMatchObject({
				kind: "stop",
				finding: {
					code: "already-in-nova",
					detail: {
						claim: {
							kind: "elsewhere",
							contact: { role: "person", names: [expect.any(String)] },
						},
					},
				},
			});
			/* The bracketed read and nothing after it: no table, place or file. */
			expect([...requests].sort()).toEqual(
				[PATHS.application, PATHS.source, PATHS.version].sort(),
			);
		});
	});

	describe("the places a source's text asks for", () => {
		/** A source whose first form declares the list of places and reads none of it. */
		const declaresPlaces = () =>
			withFirstForm(source(), (_form, xml) => ({
				xml: xml.replace(
					'<instance src="jr://instance/casedb" id="casedb"/>',
					'<instance src="jr://instance/casedb" id="casedb"/><instance src="jr://fixture/locations" id="locations"/>',
				),
			}));
		const missedLines = () =>
			vi
				.mocked(log.error)
				.mock.calls.filter(
					([message]) => message === "[reading] places read missed",
				);
		const asked = (requests: readonly string[], path: string) =>
			requests.filter((request) => request === path).length;

		it("ends the reading of an app that reads places with the failed read of them, asking for them once", async () => {
			const { answer, requests } = await read((peer) => {
				serveExport(peer, locationOwnerFixture("plain", { placeRead: true }));
				serve(peer, PATHS.levels, { status: 403, headers: {} });
			});
			expect(answer).toMatchObject({
				kind: "stop",
				finding: { code: "cannot-read-organization" },
			});
			expect(asked(requests, PATHS.levels)).toBe(1);
			expect(asked(requests, PATHS.places)).toBe(0);
			expect(missedLines()).toEqual([]);
		});

		it("drops the failed read for an app whose text names places and that reads none, and reads it to a review", async () => {
			const { answer, requests } = await read((peer) => {
				serveApp(peer, { source: declaresPlaces() });
				serve(peer, PATHS.levels, { status: 403, headers: {} });
			});
			expect(answer.kind).toBe("review");
			expect(asked(requests, PATHS.levels)).toBe(1);
			expect(missedLines()).toEqual([]);
		});

		it("ends an account whose app reads places with the failed read of them, and drops it from one that reads none", async () => {
			/* A read of places at a level CommCare HQ's levels do not hold is refused: an
			 * account, whose reader still counts the read of places. */
			const reading = await read((peer) => {
				const doc = locationOwnerFixture("plain", { placeRead: true });
				const body = servedExport(doc).body;
				const [menu] = body.modules as Body[];
				const [form] = menu.forms as Body[];
				const attachments = body._attachments as Record<string, string>;
				const key = `${form.unique_id as string}.xml`;
				const list = "instance(&apos;locations&apos;)/locations/location";
				const xml = attachments[key] as string;
				if (!xml.includes(list))
					throw new Error("The form reads the list of places.");
				attachments[key] = xml
					.split(list)
					.join(`${list}[@location_type = &apos;nowhere&apos;]`);
				serveApp(peer, {
					source: {
						status: 200,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					},
					resource: changed(application(), (resource) => ({
						...resource,
						modules: (body.modules as Body[]).map((one) => ({
							case_properties: [],
							case_type: one.case_type ?? null,
							name: one.name,
							unique_id: one.unique_id,
							forms: (one.forms as Body[]).map((each) => ({
								name: each.name,
								unique_id: each.unique_id,
								xmlns: each.xmlns,
								questions: [],
							})),
						})),
					})),
				});
				serve(peer, PATHS.levels, { status: 403, headers: {} });
			});
			expect(reading.answer).toMatchObject({
				kind: "stop",
				finding: { code: "cannot-read-organization" },
			});
			expect(asked(reading.requests, PATHS.levels)).toBe(1);

			const unread = await read((peer) => {
				serveApp(peer, { source: withUnparsedForm(declaresPlaces()) });
				serve(peer, PATHS.levels, { status: 403, headers: {} });
			});
			expect(codes(unread.answer)).toContain("unrecognized");
			expect(codes(unread.answer)).not.toContain("cannot-read-organization");
			expect(missedLines()).toEqual([]);
		});

		it("keeps the verified working app for a places read found only after decoding the form", async () => {
			const doc = locationOwnerFixture("plain", { placeRead: true });
			const body = servedExport(doc).body;
			const attachments = body._attachments as Record<string, string>;
			const menu = (body.modules as Body[])[0];
			const form = (menu.forms as Body[])[0];
			const key = `${form.unique_id}.xml`;
			const declared =
				/<instance\b[^>]*src="jr:\/\/fixture\/locations"[^>]*\/>/;
			expect(attachments[key]).toMatch(declared);
			attachments[key] = attachments[key]
				.replace(declared, "")
				.replaceAll("locations", "locat&#105;ons");
			expect(sourceMayReadPlaces(JSON.stringify(body))).toBe(false);
			const built = `<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance><data xmlns="${form.xmlns}"/></instance><instance id="locations" src="jr://fixture/locations"/></model></h:head><h:body/></h:html>`;
			const resource = `/a/${DOMAIN}/apps/download/${APP}/modules-0/forms-0.xml`;
			const { requests } = await read((peer) => {
				serveExport(peer, doc, body);
				serve(peer, PATHS.tables, retainedGroupRead("lookups/lookup-tables"));
				const domains = {
					meta: { limit: 100, next: null, offset: 0, total_count: 1 },
					objects: [{ domain_name: DOMAIN, project_name: "Clinic" }],
				};
				for (let pass = 0; pass < 2; pass++) {
					for (const path of [
						PATHS.spaces,
						`${PATHS.spaces}&feature_flag=hierarchical_location_fixture`,
					])
						serve(peer, path, {
							status: 200,
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(domains),
						});
					peer
						.get(HOST)
						.intercept({ path: resource, method: "GET" })
						.reply(200, built);
					serve(peer, PATHS.source, {
						status: 200,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					});
				}
				serveLocationLevels(peer);
				serveHqPlaces(peer, []);
			});
			expect(asked(requests, resource)).toBe(2);
			expect(missedLines()).toHaveLength(1);
			expect(
				vi
					.mocked(readHqAppSteps)
					.mock.calls.slice(0, 2)
					.map(([input]) => [
						input.sourceProjectFactories?.locations,
						input.organization.levelCodes,
					]),
			).toEqual([
				["flat", []],
				["flat", LOCATION_LEVELS.map((level) => level.code)],
			]);
		});

		it("reads places once more, and the reader again, where the source's test missed a spelling", async () => {
			vi.mocked(sourceMayReadPlaces).mockReturnValueOnce(false);
			const { answer, requests } = await read((peer) => {
				serveExport(peer, locationOwnerFixture("plain", { placeRead: true }));
				/* The read once more asks for the tables again. */
				serve(peer, PATHS.tables, retainedGroupRead("lookups/lookup-tables"));
				serveLocationLevels(peer);
				serveHqPlaces(peer, [hqPlace("north", "region", null)]);
			});
			expect(answer.kind).not.toBe("stop");
			expect(asked(requests, PATHS.tables)).toBe(2);
			expect(asked(requests, PATHS.levels)).toBe(1);
			expect(asked(requests, PATHS.places)).toBe(1);
			expect(missedLines()).toHaveLength(1);
			/* The reader ran first with no level, then again with CommCare HQ's. */
			const levelCodes = vi
				.mocked(readHqAppSteps)
				.mock.calls.map(([input]) => input.organization.levelCodes);
			expect(levelCodes.slice(0, 2)).toEqual([
				[],
				LOCATION_LEVELS.map((level) => level.code),
			]);
		});
	});

	it("reads an app saved once during the read to a review, and an app saved twice to the stop changed-while-reading", async () => {
		const saved = changed(application(), (body) => ({ ...body, version: 3 }));
		const once = await read((peer) => {
			serve(peer, PATHS.application, application());
			serve(peer, PATHS.source, source());
			serve(peer, PATHS.version, counterOf(saved));
			serveApp(peer, { resource: saved });
		});
		expect(once.answer.kind).toBe("review");
		expect(
			once.requests.filter((path) => path === PATHS.application),
		).toHaveLength(2);

		const twice = await read((peer) => {
			serve(peer, PATHS.application, application());
			serve(peer, PATHS.source, source());
			serve(peer, PATHS.version, counterOf(saved));
			const again = changed(application(), (body) => ({ ...body, version: 4 }));
			serve(peer, PATHS.application, saved);
			serve(peer, PATHS.source, source());
			serve(peer, PATHS.version, counterOf(again));
		});
		expect(twice.answer).toMatchObject({
			kind: "stop",
			finding: { code: "changed-while-reading" },
		});
	});

	it("answers an app that references files and holds one finding having asked for no file", async () => {
		const { answer, requests } = await read((peer) =>
			serveApp(peer, {
				source: withDoctype(withMenuIcon(source(), "menuicon")),
			}),
		);
		if (answer.kind !== "account") throw new Error(answer.kind);
		expect(answer.mediaChecked).toBe(false);
		expect(requests.some((path) => path.startsWith("/hq/multimedia/"))).toBe(
			false,
		);
	});

	it("leaves out a menu's icon whose file CommCare HQ does not serve, and says the first publish removes it", async () => {
		const { answer } = await read((peer) => {
			serveApp(peer, { source: withMenuIcon(source(), "menuicon") });
			peer
				.get(HOST)
				.intercept({ path: PATHS.media("menuicon"), method: "GET" })
				.reply(404, "")
				.persist();
		});
		/* Web Apps showed it as an empty picture and Android not at all. */
		if (answer.kind !== "review") throw new Error(JSON.stringify(answer));
		expect(answer.review.mediaLeftOut).toBe(0);
		expect(answer.review.firstPublish.ids).toContain("broken-pictures-removed");
		expect(answer.review.firstPublish.ids).not.toContain(
			"media-references-with-no-file-removed",
		);
	});

	it("answers a review of an app that references files only once every file is judged", async () => {
		const { answer, events, requests } = await read((peer) => {
			serveApp(peer, { source: withMenuIcon(source(), "menuicon") });
			peer
				.get(HOST)
				.intercept({ path: PATHS.media("menuicon"), method: "GET" })
				.reply(200, PNG, { headers: { "content-type": "image/png" } });
		});
		if (answer.kind !== "review") throw new Error(JSON.stringify(answer));
		expect(answer.review.creates.mediaFiles).toBe(1);
		expect(requests).toContain(PATHS.media("menuicon"));
		const judged = events.findIndex(
			(event) =>
				event.type === "files" &&
				event.done === event.total &&
				event.total === 1,
		);
		expect(judged).toBeGreaterThan(-1);
		expect(events.slice(judged + 1)).toEqual([
			{ type: "stage", stage: "checking" },
		]);
	});

	/** The source with a second menu, the one the retained error answer summarizes. */
	const withAddedMenu = (answer: RetainedHqAnswer) => {
		const resource = retainedReadingRead("application-error-module");
		const [, whole] = retainedBodyJson(resource).modules as Body[];
		return changed(answer, (body) => {
			const [first] = body.modules as Body[];
			const [form] = first.forms as Body[];
			const attachments = body._attachments as Record<string, string>;
			const xml = attachments[`${form.unique_id as string}.xml`] as string;
			const xmlns = ((whole.forms as Body[])[0] as Body).xmlns as string;
			(body.modules as Body[]).push({
				...first,
				unique_id: whole.unique_id,
				forms: [{ ...form, unique_id: "added-in-hq-form", xmlns }],
			});
			attachments["added-in-hq-form.xml"] = xml
				.split(form.xmlns as string)
				.join(xmlns);
			return body;
		});
	};
	/** CommCare HQ's answer that it could not summarize the first menu. */
	const errorAtFirstMenu = () =>
		changed(retainedReadingRead("application-error-module"), (body) => ({
			...body,
			id: APP,
		}));

	it("names a menu CommCare HQ could not summarize where the reading names no cause of its own", async () => {
		const { answer } = await read((peer) =>
			serveApp(peer, {
				resource: errorAtFirstMenu(),
				source: withAddedMenu(source()),
			}),
		);
		if (answer.kind !== "account") throw new Error(answer.kind);
		expect(
			answer.findings.map((finding) => [finding.code, finding.place]),
		).toEqual([
			["menu-unreadable-in-hq", expect.objectContaining({ menu: 0 })],
		]);
	});

	it("names only the form's own finding where a form of the menu is one CommCare HQ will not build", async () => {
		const { answer } = await read((peer) =>
			serveApp(peer, {
				resource: errorAtFirstMenu(),
				source: withAddedMenu(withDoctype()),
			}),
		);
		/* One cause, one finding: the form's refusal covers HQ's failure to summarize its menu. */
		expect(codes(answer)).toEqual([
			"questions/dtd-declared-entity-references-predefined-ones-such-as-amp-are",
		]);
		if (answer.kind !== "account") throw new Error(answer.kind);
		expect(answer.findings[0]?.place).toMatchObject({
			kind: "form",
			menu: 0,
			form: 1,
		});
	});

	it("lists two thousand of 2,500 findings, says how many more, and counts every one", async () => {
		/* 2,500 untyped inputs whose appearance asks a numeric keypad: each is a finding. */
		const many = withFirstForm(source(), (_form, xml) => {
			let nodes = "";
			let controls = "";
			for (let index = 0; index < 2_500; index += 1) {
				nodes += `<n${index}/>`;
				controls += `<input ref="/data/n${index}" appearance="numeric"/>`;
			}
			return {
				xml: xml
					.replace("<answer/>", `<answer/>${nodes}`)
					.replace("</h:body>", `${controls}</h:body>`),
			};
		});
		const { answer } = await read((peer) => serveApp(peer, { source: many }));
		if (answer.kind !== "account") throw new Error(answer.kind);
		const total =
			answer.counts.notYet + answer.counts.never + answer.counts.fixInHq;
		expect(total).toBeGreaterThanOrEqual(2_500);
		expect(answer.findings).toHaveLength(2_000);
		expect(answer.more).toBe(total - 2_000);
	});

	it("asks for the flag once where the source holds a write saved only if changed, hands the reader its answer, and never asks where the source holds none", async () => {
		const spaces = (name: Parameters<typeof retainedReadingRead>[0]) =>
			changed(retainedReadingRead(name), (body) => ({
				...body,
				objects: (body.objects as Body[]).map((space) => ({
					...space,
					domain_name: DOMAIN,
				})),
			}));
		const editMode = withFirstForm(source(), (form) => {
			const actions = structuredClone(form.actions) as Body;
			const update = actions.update_case as Body;
			const notes = (update.update as Body).notes as Body;
			notes.update_mode = "edit";
			return { form: { actions } };
		});
		vi.mocked(readHqAppSteps).mockClear();
		const flagged = await read((peer) => {
			serveApp(peer, { source: editMode });
			serve(peer, PATHS.spaces, spaces("project-spaces"));
			serve(peer, PATHS.flagged, spaces("project-spaces-flag-on"));
		});
		expect(
			flagged.requests.filter((path) => path.startsWith("/api/user_domains/")),
		).toEqual([PATHS.spaces, PATHS.flagged]);
		expect(flagged.answer.kind).not.toBe("stop");
		const handed = () =>
			vi
				.mocked(readHqAppSteps)
				.mock.calls.map(([input]) => input.saveOnlyEditedApplied);
		expect(new Set(handed())).toEqual(new Set([true]));
		vi.mocked(readHqAppSteps).mockClear();

		const unflagged = await read((peer) => {
			serveApp(peer, { source: editMode });
			serve(peer, PATHS.spaces, spaces("project-spaces"));
			serve(peer, PATHS.flagged, spaces("project-spaces-flag-off"));
		});
		expect(unflagged.answer.kind).not.toBe("stop");
		expect(new Set(handed())).toEqual(new Set([false]));
		vi.mocked(readHqAppSteps).mockClear();

		const plain = await read((peer) => serveApp(peer));
		/* No flag read, so the reader is handed no answer and guesses none. */
		expect(new Set(handed())).toEqual(new Set([undefined]));
		expect(
			plain.requests.some((path) => path.startsWith("/api/user_domains/")),
		).toBe(false);
	});

	it("stops at the request in flight when the read is cancelled, and sends no later request", async () => {
		const actor = await authorizeBringIn(ACTOR, PROJECT);
		if (actor === null) throw new Error("The editor holds no edit.");
		const cancel = new AbortController();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const held = source();
		await withHttpPeer(async (peer) => {
			serve(peer, PATHS.application, application());
			peer
				.get(HOST)
				.intercept({ path: PATHS.source, method: "GET" })
				.reply(async () => {
					reached.resolve();
					await release.promise;
					return {
						statusCode: held.status,
						data: JSON.stringify(retainedBodyJson(held)),
						responseOptions: { headers: { ...held.headers } },
					};
				});
			const pending = readHqAppForReview(actor, KEY, {
				onEvent: () => {},
				cancel: cancel.signal,
			});
			try {
				await reached.promise;
				cancel.abort();
				const answer = await pending;
				expect(answer.kind).toBe("stop");
				expect(requested(peer)).toEqual([PATHS.application, PATHS.source]);
			} finally {
				release.resolve();
				await pending;
			}
		});
	});

	it("refuses a key that names a Project the actor was not authorized in, having asked CommCare HQ nothing and written nothing", async () => {
		await h.seedProjectMember(ACTOR, OTHER_PROJECT, "editor");
		const before = await rowCounts();
		const actor = await authorizeBringIn(ACTOR, PROJECT);
		if (actor === null) throw new Error("The editor holds no edit.");
		await withHttpPeer(async (peer) => {
			await expect(
				readHqAppForReview(
					actor,
					{ ...KEY, projectId: OTHER_PROJECT },
					{ onEvent: () => {} },
				),
			).rejects.toThrow(
				/authorized for one Project and asked to work in another/,
			);
			expect(requested(peer)).toEqual([]);
		});
		expect(await rowCounts()).toEqual(before);
	});

	it("logs a reader defect's why in its line's context, and no word of the app anywhere", async () => {
		const MARK = {
			menu: "Zqmarkmenu",
			form: "Zqmarkform",
			question: "zqmarkquestion",
			tag: "zqmarktag",
			path: "jr://file/commcare/zqmarkpath.png",
		};
		const marked = changed(source(), (body) => {
			const [menu] = body.modules as Body[];
			menu.name = { en: MARK.menu };
			menu.media_image = { en: MARK.path };
			const [first, second] = menu.forms as Body[];
			first.name = { en: MARK.form };
			second.name = { en: MARK.form };
			const attachments = body._attachments as Record<string, string>;
			const firstKey = `${first.unique_id as string}.xml`;
			attachments[firstKey] = (attachments[firstKey] as string)
				.split("answer")
				.join(MARK.question)
				.replace(
					'<instance src="jr://instance/casedb" id="casedb"/>',
					`<instance src="jr://instance/casedb" id="casedb"/><instance src="jr://fixture/item-list:${MARK.tag}" id="${MARK.tag}"/>`,
				);
			const secondKey = `${second.unique_id as string}.xml`;
			const xml = attachments[secondKey] as string;
			attachments[secondKey] = xml.slice(0, xml.indexOf("<h:body>"));
			return body;
		});
		const { answer } = await read((peer) => serveApp(peer, { source: marked }));
		expect(answer.kind).toBe("account");
		const calls = [
			...vi.mocked(log.info).mock.calls,
			...vi.mocked(log.warn).mock.calls,
			...vi.mocked(log.error).mock.calls,
		];
		const defectLine = vi
			.mocked(log.error)
			.mock.calls.find(
				([message, , context]) =>
					message.startsWith("[reading] unrecognized: ") &&
					Array.isArray((context as Body | undefined)?.defects),
			);
		if (defectLine === undefined) throw new Error("No line carries a defect.");
		const [message, , context] = defectLine;
		const whys = (context as { defects: string[] }).defects;
		expect(whys.length).toBeGreaterThan(0);
		for (const why of whys) expect(message).not.toContain(why);
		/* An error argument titles and groups its Sentry issue, so none is handed one; the
		 * serialization spells out an Error's message and stack, which JSON leaves out. */
		for (const [, error] of vi.mocked(log.error).mock.calls)
			expect(error).toBeUndefined();
		const logged = loggedText(calls);
		for (const word of Object.values(MARK))
			expect(logged.toLowerCase()).not.toContain(word.toLowerCase());
	});

	it("tells a caller each stage the reader runs, in order, then its close", async () => {
		const { readHqAppSteps: actual } = await vi.importActual<
			typeof import("@/lib/commcare/reader")
		>("@/lib/commcare/reader");
		const told: (number | "close")[] = [];
		vi.mocked(readHqAppSteps).mockImplementationOnce((input, options) =>
			actual(input, {
				...options,
				onStage: (at) => {
					told.push(at);
					options?.onStage?.(at);
				},
			}),
		);
		const { answer } = await read((peer) => serveApp(peer));
		expect(answer.kind).toBe("review");
		expect(told).toEqual([...STAGES.keys(), "close"]);
	});

	it("logs a reader that throws by the stage it threw in and what it threw, never by its message", async () => {
		const quoted = "zqmarkquestion";
		vi.mocked(readHqAppSteps).mockImplementationOnce(
			function* (_input, options) {
				options?.onStage?.(0);
				yield;
				options?.onStage?.(4);
				throw new TypeError(
					`Cannot read properties of undefined (reading '${quoted}')`,
				);
			},
		);
		const { answer } = await read((peer) => serveApp(peer));
		expect(answer).toMatchObject({
			kind: "account",
			findings: [{ code: "read-back-differs", detail: { name: "reader" } }],
		});
		const line = vi
			.mocked(log.error)
			.mock.calls.find(([message]) =>
				message.startsWith("[reading] read-back differs: reader"),
			);
		expect(line).toEqual([
			"[reading] read-back differs: reader: contract",
			undefined,
			expect.objectContaining({
				phase: "reader",
				signatures: ["reader/contract"],
				at: "stage/4",
				thrown: "TypeError",
			}),
		]);
		const calls = [
			...vi.mocked(log.info).mock.calls,
			...vi.mocked(log.warn).mock.calls,
			...vi.mocked(log.error).mock.calls,
		];
		expect(loggedText(calls)).not.toContain(quoted);
	});

	it("logs a reader that throws something no Error class names as other", async () => {
		vi.mocked(readHqAppSteps).mockImplementationOnce(function* () {
			yield;
			throw "zqmarkquestion";
		});
		const { answer } = await read((peer) => serveApp(peer));
		expect(answer.kind).toBe("account");
		const line = vi
			.mocked(log.error)
			.mock.calls.find(([message]) =>
				message.startsWith("[reading] read-back differs: reader"),
			);
		expect(line?.[2]).toMatchObject({ at: "input", thrown: "other" });
	});
});

/** Every log call's arguments as text, an Error spelled by its message and stack. */
function loggedText(calls: readonly unknown[]): string {
	return JSON.stringify(calls, (_key, value: unknown) =>
		value instanceof Error
			? { name: value.name, message: value.message, stack: value.stack }
			: value,
	);
}
