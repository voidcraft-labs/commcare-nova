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
 * Project and reads in another; and a word of an app in a log line.
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
import { hqPrivateFeatureFlag } from "@/lib/commcare/projectSpaceCompatibility";
import { readHqApp } from "@/lib/commcare/reader";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { log } from "@/lib/logger";
import {
	CIRCUMSTANCE_STANDINGS,
	type ReadCircumstance,
} from "@/lib/publish/hqFindings";
import { deleteAsset, uploadAssetBytes } from "@/lib/storage/media";
import { birthAdoptedApp } from "../../__tests__/adoptedBirth";
import { authorizeBringIn, readHqAppForReview } from "../read";
import {
	READING_ID_PATTERN,
	type ReadingAnswer,
	type ReadingEvent,
	type ReadingKey,
} from "../types";
import { FIXTURE_PATHS, serveAnswer, serveFixtureApp } from "./adoptionFixture";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
/* The reader runs as it is; the spy only shows what each run was handed. */
vi.mock("@/lib/commcare/reader", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/commcare/reader")>();
	return { ...actual, readHqApp: vi.fn(actual.readHqApp) };
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
	tables: `/a/${DOMAIN}/api/lookup_table/v1/?limit=100`,
	levels: `/a/${DOMAIN}/api/location_type/v1/?limit=1000`,
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
				code: "already-in-nova",
				serving: () => {},
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
				code: "cannot-read-organization",
				serving: (peer) => {
					serveApp(peer, {
						source: withFirstForm(source(), (_form, xml) => ({
							xml: xml.replace(
								'<instance src="jr://instance/casedb" id="casedb"/>',
								'<instance src="jr://instance/casedb" id="casedb"/><instance src="jr://fixture/locations" id="locations"/>',
							),
						})),
					});
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
				code: "media-file-unreadable",
				serving: (peer) => {
					serveApp(peer, { source: withMenuIcon(source(), "menuicon") });
					peer
						.get(HOST)
						.intercept({ path: PATHS.media("menuicon"), method: "GET" })
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

	it("names a menu CommCare HQ could not summarize beside the reader's other findings, in one account", async () => {
		const resource = retainedReadingRead("application-error-module");
		const [, whole] = retainedBodyJson(resource).modules as Body[];
		const twoMenus = changed(withDoctype(), (body) => {
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
		const { answer } = await read((peer) =>
			serveApp(peer, {
				resource: changed(resource, (body) => ({ ...body, id: APP })),
				source: twoMenus,
			}),
		);
		/* The menu's finding and the form's own, side by side. */
		expect(codes(answer)).toContain("menu-unreadable-in-hq");
		expect(codes(answer).length).toBeGreaterThanOrEqual(2);
		if (answer.kind !== "account") throw new Error(answer.kind);
		expect(
			answer.findings.find(
				(finding) => finding.code === "menu-unreadable-in-hq",
			)?.place,
		).toMatchObject({ kind: "menu", menu: 0 });
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
		vi.mocked(readHqApp).mockClear();
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
				.mocked(readHqApp)
				.mock.calls.map(([input]) => input.saveOnlyEditedApplied);
		expect(new Set(handed())).toEqual(new Set([true]));
		vi.mocked(readHqApp).mockClear();

		const unflagged = await read((peer) => {
			serveApp(peer, { source: editMode });
			serve(peer, PATHS.spaces, spaces("project-spaces"));
			serve(peer, PATHS.flagged, spaces("project-spaces-flag-off"));
		});
		expect(unflagged.answer.kind).not.toBe("stop");
		expect(new Set(handed())).toEqual(new Set([false]));
		vi.mocked(readHqApp).mockClear();

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
		const logged = JSON.stringify(calls);
		for (const word of Object.values(MARK))
			expect(logged.toLowerCase()).not.toContain(word.toLowerCase());
	});
});
