/**
 * `readReadingProjectData` over a Project side that holds nothing, with
 * CommCare HQ answering through a controlled peer. It would catch: a table
 * whose tag is an object's prototype key measured into nowhere, so its rows
 * pass both byte caps unjudged; and a failed read of the levels and places
 * that only the source's text asked for ending a bring-in whose app may read
 * no place.
 */

import type { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { seenByHq } from "@/lib/commcare/hq/appsSeen";
import { exportedBody } from "@/lib/commcare/reader/__tests__/novaExport";
import {
	retainedSourceBody,
	sourceFromBody,
} from "@/lib/commcare/reader/__tests__/readerInput";
import {
	patients,
	uuid,
} from "@/lib/commcare/reader/caseList/__tests__/fixtures";
import { plainColumn } from "@/lib/domain";
import {
	LOOKUP_MAX_CHANGE_BYTES,
	LOOKUP_MAX_ROW_BYTES,
} from "@/lib/lookup/constants";
import {
	type LookupRowsMeasure,
	lookupInlineCopyExcess,
} from "@/lib/lookup/managedRules";
import type { LookupRevision } from "@/lib/lookup/types";
import { managedLookupContentOf } from "../lookupTables";
import { type ReadingProjectSide, readReadingProjectData } from "../read";

const DOMAIN = "clinic";
const HOST = "https://india.commcarehq.org";
const LIST = `/a/${DOMAIN}/api/lookup_table/v1/?limit=1000`;
const LEVELS = `/a/${DOMAIN}/api/location_type/v1/?limit=1000`;
const PROTO_ID = "5c1e0f4a9b8d4c7e8f6a5b4c3d2e1f00";

/** A Project side that holds no table, measuring every candidate's rows as `measure`. */
function emptyProject(measure: LookupRowsMeasure): ReadingProjectSide {
	return {
		tables: async () => ({
			projectId: "project-1",
			projectRevision: "0" as LookupRevision,
			definitions: [],
			rowsByTable: {},
			keptColumns: {},
		}),
		referencingApps: async () => ({}),
		siblings: async () => [],
		mayAdminister: async () => true,
		measureRows: async () => measure,
	};
}

function serveJson(peer: MockAgent, requestPath: string, body: unknown): void {
	peer
		.get(HOST)
		.intercept({ path: requestPath, method: "GET" })
		.reply(200, JSON.stringify(body), {
			headers: { "content-type": "application/json" },
		});
}

/** A retained source CommCare HQ served, with `note` added to its body. */
async function sourceNoting(
	note: string,
	condition?: string,
	declarations = "",
): Promise<HqAppSource> {
	const body = retainedSourceBody(
		"navigation-base/app-source-after-form-settings-save",
	);
	const forms = body._attachments as Record<string, string>;
	const [first] = Object.keys(forms);
	return sourceFromBody({
		...body,
		note,
		_attachments: {
			...forms,
			[first]:
				condition === undefined
					? forms[first]
					: forms[first].replace(
							"<bind ",
							`${declarations}<bind relevant="${condition}" `,
						),
		},
	});
}

function read(
	source: HqAppSource,
	project: ReadingProjectSide,
	places: "when-source-reads" | "always" = "when-source-reads",
	builtFromAppId: string | null = null,
) {
	return readReadingProjectData({
		creds: { username: "account", apiKey: "fixture-key", server: "india" },
		server: "india",
		domain: DOMAIN,
		working: {
			source,
			seen: seenByHq("india", DOMAIN, ["working-app"]),
			application: {
				appId: "working-app",
				domain: DOMAIN,
				builtFromAppId,
				builds: [],
				version: 1,
				name: "Visits",
				rawModules: [],
			},
		},
		appId: "0b4f6a52-7c55-4a35-9d1e-3c2f8a1b4e6d",
		readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
		source,
		project,
		places,
	});
}

describe("readReadingProjectData", () => {
	it("holds a table tagged __proto__ to both bounds of one inline copy", async () => {
		const measure = {
			dataBytes: LOOKUP_MAX_CHANGE_BYTES + 1,
			largestRowBytes: LOOKUP_MAX_ROW_BYTES + 1,
		};
		const table = {
			id: PROTO_ID,
			tag: "__proto__",
			fields: [{ field_name: "code", properties: [] }],
			is_global: true,
			item_attributes: [],
			resource_uri: "",
		};
		const row = {
			id: "7a1e0f4a9b8d4c7e8f6a5b4c3d2e1f01",
			fixture_type: "__proto__",
			fields: { code: "001" },
			resource_uri: "",
		};
		const source = await sourceNoting(
			"instance('item-list:unrelated')",
			"count(instance('item-list:__proto__')/__proto___list/__proto__) > 0",
		);
		const answer = await withHttpPeer(async (peer) => {
			serveJson(peer, LIST, {
				meta: { limit: 100, next: null, offset: 0, total_count: 1 },
				objects: [table],
			});
			serveJson(
				peer,
				`/a/${DOMAIN}/api/fixture/v1/?fixture_type_id=${PROTO_ID}`,
				{
					meta: { limit: 1000, next: null, offset: 0, total_count: 1 },
					objects: [row],
				},
			);
			return read(source, emptyProject(measure));
		});
		if (answer.kind !== "read") throw new Error("the read failed");
		const [proto] = answer.data.gathered.tables;
		if (proto?.read.kind !== "read") throw new Error("__proto__ was not read");
		/* Postgres's measure of `__proto__` is found under its own tag, never
		 * the prototype's: it is past both bounds of one inline copy, so the table comes in as a
		 * reference to its source with no rows held inline (section 1C),
		 * rather than as the one row the list served. */
		expect(
			lookupInlineCopyExcess(
				managedLookupContentOf(proto.read.table, [row]),
				measure,
			),
		).toHaveLength(2);
		expect(proto.findings).toEqual([]);
		expect(proto.read.rows).toEqual([]);
		expect(proto.read.canonical.source?.inventory).toBe("unavailable");
	});

	it("reads only the rows reached by the form's local alias, even when prose, a declaration, or a longer tag mentions another table", async () => {
		const source = await sourceNoting(
			"Notes about item-list:locations and item-list:unused",
			[
				"count(instance((('item-list:locations')))/locations-west_list/locations-west) > 0",
				"count(instance(('optional'), 'unknown')/unused_list/unused) > 0",
				"count(instance(('item-list:unused'))/unused_list/unused) > 0",
				"count(instance('selected')/unused_list/unused) > 0",
				"count(instance('remote')/unused_list/unused) > 0",
				"count(instance('item-list:meeting.1')/meeting.1_list/meeting.1) > 0",
			].join(" and "),
			'<instance id="item-list:locations" src="jr://fixture/item-list:locations-west"/><instance id="optional" src="jr://fixture/item-list:unused"/><instance id="selected" src="jr://instance/selected-entities/item-list:unused"/><instance id="remote" src="jr://instance/remote/item-list:unused"/>',
		);
		await withHttpPeer(async (peer) => {
			const tables = ["locations", "locations-west", "unused", "meeting.1"].map(
				(tag, index) => ({
					id: String(index + 1).padStart(32, "0"),
					tag,
					fields: [{ field_name: "code", properties: [] }],
					is_global: tag !== "locations-west",
					item_attributes: [],
					resource_uri: "",
				}),
			);
			serveJson(peer, LIST, {
				meta: { limit: 100, offset: 0, next: null, total_count: tables.length },
				objects: tables,
			});
			const rowsPath = `/a/${DOMAIN}/api/fixture/v1/?fixture_type_id=${tables[1].id}`;
			serveJson(peer, rowsPath, {
				meta: { limit: 1000, offset: 0, next: null, total_count: 0 },
				objects: [],
			});
			const reply = await read(
				source,
				emptyProject({ dataBytes: 0, largestRowBytes: 0 }),
			);
			if (reply.kind !== "read") throw new Error("The table read failed");
			const [remote] = reply.data.gathered.tables;
			expect(remote.read.table.tag).toBe("locations-west");
			/* Its rows are assigned to workers, so it comes in as a reference to
			 * its source (section 1B), never as rows every worker gets. */
			expect(remote.findings).toEqual([]);
			if (remote.read.kind !== "read") throw new Error("not read");
			expect(remote.read.canonical.source?.distribution).toBe("assigned");
			expect(
				peer
					.getCallHistory()
					?.calls()
					.map((call) => call.fullUrl.slice(HOST.length)),
			).toEqual([LIST, rowsPath]);
		});
	});

	it("keeps a refused read of the places that only the source's text asked for, and ends the read where it was asked always", async () => {
		// A value of the body that is the quoted word and reads no place.
		const source = await sourceNoting("locations");
		const nothing = emptyProject({ dataBytes: 0, largestRowBytes: 0 });
		const serveRefusal = (peer: MockAgent) => {
			serveJson(peer, LIST, {
				meta: { limit: 100, next: null, offset: 0, total_count: 0 },
				objects: [],
			});
			peer.get(HOST).intercept({ path: LEVELS, method: "GET" }).reply(403, "");
		};
		const held = await withHttpPeer(async (peer) => {
			serveRefusal(peer);
			return read(source, nothing);
		});
		if (held.kind !== "read") throw new Error("the read failed");
		expect(held.data.placesRead).toBe(false);
		expect(held.data.placesUnread).toMatchObject({
			request: "location-types",
			status: 403,
		});
		expect(held.data.organization).toEqual({ levelCodes: [], levels: [] });

		const ended = await withHttpPeer(async (peer) => {
			serveRefusal(peer);
			return read(source, nothing, "always");
		});
		expect(ended).toMatchObject({
			kind: "failed",
			failure: { request: "location-types", status: 403 },
		});
	});
});

describe("a source project's location instance factory", () => {
	const all = "/api/user_domains/v1/?limit=100";
	const flag = `${all}&feature_flag=hierarchical_location_fixture`;
	const domains = [{ domain_name: DOMAIN, project_name: "Clinic" }];
	const collection = (objects: unknown[]) => ({
		objects,
		meta: { limit: 100, next: null, offset: 0, total_count: objects.length },
	});
	it.each([
		["standard project", false, "", "flat"],
		["legacy project, flat list", true, "jr://fixture/locations", "flat"],
		[
			"legacy project, hierarchical list",
			true,
			"jr://fixture/commtrack:locations",
			"hierarchical",
		],
		[
			"legacy project with no corroborating declaration",
			true,
			"jr://instance/session",
			undefined,
		],
		["legacy project changed during the read", true, "changed", undefined],
	] as const)("reads %s", async (_site, flagged, fixture, expected) => {
		const source = await sourceNoting(
			"",
			"count(instance('locations')/locations/location) > 0",
		);
		const form = source.modules[0].forms[0];
		const ran = await withHttpPeer(async (peer) => {
			serveJson(peer, LIST, collection([]));
			serveJson(peer, all, collection(domains));
			serveJson(peer, flag, collection(flagged ? domains : []));
			const path = `/a/${DOMAIN}/apps/download/working-app/modules-0/forms-0.xml`;
			if (flagged) {
				peer
					.get(HOST)
					.intercept({ path, method: "GET" })
					.reply(
						200,
						`<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance><data xmlns="${form.xmlns}"/></instance><instance id="locations" src="${fixture === "changed" ? "jr://fixture/locations" : fixture}"/></model></h:head><h:body/></h:html>`,
					);
				if (fixture !== "jr://instance/session") {
					const after =
						fixture === "changed"
							? { ...source.raw, _attachments: {} }
							: source.raw;
					serveJson(peer, `/a/${DOMAIN}/apps/source/working-app/`, after);
				}
			}
			serveJson(peer, LEVELS, collection([]));
			serveJson(
				peer,
				`/a/${DOMAIN}/api/location/v2/?limit=5000`,
				collection([]),
			);
			const answer = await read(
				source,
				emptyProject({ dataBytes: 0, largestRowBytes: 0 }),
			);
			return {
				answer,
				paths: (peer.getCallHistory()?.calls() ?? []).map((call) =>
					call.fullUrl.replace(HOST, ""),
				),
				path,
			};
		});
		expect(ran.answer.kind).toBe("read");
		if (ran.answer.kind === "read")
			expect(ran.answer.data.sourceProjectFactories?.locations).toBe(expected);
		expect(ran.paths.includes(ran.path)).toBe(flagged);
	});

	it("keeps a saved build out of the working resource path", async () => {
		const source = await sourceNoting(
			"",
			"count(instance('locations')/locations/location) > 0",
		);
		const answer = await withHttpPeer(async (peer) => {
			serveJson(peer, LIST, collection([]));
			serveJson(peer, all, collection(domains));
			serveJson(peer, flag, collection(domains));
			serveJson(peer, LEVELS, collection([]));
			serveJson(
				peer,
				`/a/${DOMAIN}/api/location/v2/?limit=5000`,
				collection([]),
			);
			const result = await read(
				source,
				emptyProject({ dataBytes: 0, largestRowBytes: 0 }),
				"when-source-reads",
				"original-working-app",
			);
			return {
				result,
				paths: peer
					.getCallHistory()
					?.calls()
					.map((call) => call.fullUrl),
			};
		});
		expect(answer.result.kind).toBe("read");
		expect(answer.paths?.some((path) => path.includes("/apps/download/"))).toBe(
			false,
		);
		if (answer.result.kind === "read")
			expect(
				answer.result.data.sourceProjectFactories?.locations,
			).toBeUndefined();
	});

	it("asks no project flag for a scanner-visible label with no expression consuming it", async () => {
		const source = await sourceNoting("", "true()", "<!--before-->");
		const attachments = Object.fromEntries(
			Object.entries(source.raw._attachments as Record<string, string>).map(
				([key, xml]) => [
					key,
					xml.replace(
						/<value( [^>]*)?>[^<]+<\/value>/,
						"<value>Guide to instance('locations')</value>",
					),
				],
			),
		);
		expect(
			Object.values(attachments).some((xml) =>
				xml.includes("Guide to instance"),
			),
		).toBe(true);
		const reading = await sourceFromBody({
			...source.raw,
			_attachments: attachments,
		});
		const reply = await withHttpPeer(async (peer) => {
			serveJson(peer, LIST, collection([]));
			serveJson(peer, LEVELS, collection([]));
			serveJson(
				peer,
				`/a/${DOMAIN}/api/location/v2/?limit=5000`,
				collection([]),
			);
			const result = await read(
				reading,
				emptyProject({ dataBytes: 0, largestRowBytes: 0 }),
			);
			return {
				result,
				paths: peer
					.getCallHistory()
					?.calls()
					.map((call) => call.fullUrl),
			};
		});
		expect(reply.result.kind).toBe("read");
		expect(
			reply.paths?.some(
				(path) =>
					path.includes("user_domains") || path.includes("apps/download/"),
			),
		).toBe(false);
	});

	it.each([false, true])(
		"corroborates a suite-only factory against the same working source, changed=%s",
		async (changed) => {
			const original = await sourceNoting("");
			const menus = original.raw.modules as Array<
				Record<string, unknown> & { forms: Record<string, unknown>[] }
			>;
			const source = await sourceFromBody({
				...original.raw,
				modules: menus.map((menu, i) =>
					i === 0
						? {
								...menu,
								forms: menu.forms.map((form, j) =>
									j === 0
										? {
												...form,
												form_filter:
													"count(instance('locations')/locations/location) > 0",
											}
										: form,
								),
							}
						: menu,
				),
			});
			const answer = await withHttpPeer(async (peer) => {
				serveJson(peer, LIST, collection([]));
				serveJson(peer, all, collection(domains));
				serveJson(peer, flag, collection(domains));
				const suite = `/a/${DOMAIN}/apps/download/working-app/suite.xml`;
				peer
					.get(HOST)
					.intercept({ path: suite, method: "GET" })
					.reply(
						200,
						'<suite><entry><instance id="locations" src="jr://fixture/commtrack:locations"/></entry></suite>',
					);
				serveJson(
					peer,
					`/a/${DOMAIN}/apps/source/working-app/`,
					changed ? { ...source.raw, name: "Changed" } : source.raw,
				);
				serveJson(peer, LEVELS, collection([]));
				serveJson(
					peer,
					`/a/${DOMAIN}/api/location/v2/?limit=5000`,
					collection([]),
				);
				const result = await read(
					source,
					emptyProject({ dataBytes: 0, largestRowBytes: 0 }),
				);
				return {
					result,
					paths: peer
						.getCallHistory()
						?.calls()
						.map((call) => call.fullUrl),
				};
			});
			expect(answer.paths?.some((path) => path.endsWith("/suite.xml"))).toBe(
				true,
			);
			expect(answer.result.kind).toBe("read");
			if (answer.result.kind === "read")
				expect(answer.result.data.sourceProjectFactories?.locations).toBe(
					changed ? undefined : "hierarchical",
				);
		},
	);
});

describe("a working suite that supplies another screen's table", () => {
	const id = "item-list:zones";
	const url = `/a/${DOMAIN}/apps/download/working-app/suite.xml`;
	const rows = `/a/${DOMAIN}/api/fixture/v1/?fixture_type_id=${PROTO_ID}`;
	const both =
		'<datum id="case_id" detail-select="m0_case_short" detail-confirm="m0_case_long"/>';
	const short =
		'<instance-datum id="selected_cases" detail-select="m0_case_short"/>';
	const table = `<instance id="${id}" src="jr://fixture/item-list:zones"/>`;
	const native = `<instance id="${id}" src="jr://instance/casedb"/>`;
	const scenarios = [
		{
			name: "a search-results copy has no declaration",
			first: table,
			second: table,
			searchCopy: true,
		},
		{ name: "every entry", first: table, second: table, expected: true },
		{
			name: "the working source changed",
			first: table,
			second: table,
			changed: true,
		},
		{ name: "an unrelated entry", first: "", second: "" },
		{ name: "only one selecting entry", first: table, second: "" },
		{
			name: "another build profile disagrees",
			first: table,
			second: table,
			profile: true,
		},
		{
			name: "two selecting entries have different sources",
			first: table,
			second: native,
		},
		{
			name: "a duplicate local declaration",
			first: table,
			second: table + native,
		},
	];
	it.each(scenarios)(
		"fetches the matching rows for $name",
		async ({ first, second, profile, changed, expected, searchCopy }) => {
			const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
			const source = await sourceFromBody(
				exportedBody(doc, {
					root: profile
						? { build_profiles: { field: { name: "Field", langs: ["en"] } } }
						: {},
					modules: (menus) => {
						const pair = menus[0].case_details as {
							short: { columns: Record<string, unknown>[] };
							long: { columns: Record<string, unknown>[] };
						};
						for (const detail of [pair.short, pair.long])
							Object.assign(detail.columns[0], {
								useXpathExpression: true,
								field:
									"count(instance((('item-list:zones')))/zones_list/zones)",
							});
						return menus;
					},
				}),
			);
			const suite = (one: string, two: string) =>
				`<suite><detail id="m0_case_short"/><detail id="m0_case_long"/><detail id="m1_case_short"/>${searchCopy ? '<detail id="m0_search_short"/><remote-request><session><datum detail-select="m0_search_short"/></session></remote-request>' : ""}<entry>${one}<session>${both}</session></entry><remote-request>${two}<session>${short}</session></remote-request><entry>${table}<session><datum detail-select="m1_case_short"/></session></entry></suite>`;
			const answer = await withHttpPeer(async (peer) => {
				const collection = (objects: unknown[]) => ({
					meta: {
						limit: 1000,
						next: null,
						offset: 0,
						total_count: objects.length,
					},
					objects,
				});
				serveJson(
					peer,
					LIST,
					collection([
						{
							id: PROTO_ID,
							tag: "zones",
							fields: [{ field_name: "code", properties: [] }],
							is_global: true,
							item_attributes: [],
							resource_uri: "",
						},
					]),
				);
				peer
					.get(HOST)
					.intercept({ path: url, method: "GET" })
					.reply(200, suite(first, second));
				if (profile)
					peer
						.get(HOST)
						.intercept({ path: `${url}?profile=field`, method: "GET" })
						.reply(200, suite("", ""));
				serveJson(
					peer,
					`/a/${DOMAIN}/apps/source/working-app/`,
					changed ? { ...source.raw, name: { en: "Changed" } } : source.raw,
				);
				if (expected) serveJson(peer, rows, collection([]));
				const result = await read(
					source,
					emptyProject({ dataBytes: 0, largestRowBytes: 0 }),
				);
				return {
					result,
					paths: peer
						.getCallHistory()
						?.calls()
						.map((call) => call.fullUrl.slice(HOST.length)),
				};
			});
			expect(answer.result.kind).toBe("read");
			expect(answer.paths).toContain(url);
			expect(answer.paths?.includes(rows)).toBe(Boolean(expected));
		},
	);
});
