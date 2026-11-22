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
import {
	retainedSourceBody,
	sourceFromBody,
} from "@/lib/commcare/reader/__tests__/readerInput";
import {
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_TABLE_BYTES,
} from "@/lib/lookup/constants";
import {
	type LookupRowsMeasure,
	lookupCapExcess,
} from "@/lib/lookup/managedRules";
import type { LookupRevision } from "@/lib/lookup/types";
import { managedLookupContentOf } from "../lookupTables";
import { type ReadingProjectSide, readReadingProjectData } from "../read";

const DOMAIN = "clinic";
const HOST = "https://india.commcarehq.org";
const LIST = `/a/${DOMAIN}/api/lookup_table/v1/?limit=1000`;
const LEVELS = `/a/${DOMAIN}/api/location_type/v1/?limit=1000`;
const CAPS_ENTRY =
	"expressions-and-data/table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64";
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
) {
	return readReadingProjectData({
		creds: { username: "account", apiKey: "fixture-key", server: "india" },
		server: "india",
		domain: DOMAIN,
		appId: "0b4f6a52-7c55-4a35-9d1e-3c2f8a1b4e6d",
		readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
		source,
		project,
		places,
	});
}

describe("readReadingProjectData", () => {
	it("holds a table tagged __proto__ to both byte caps", async () => {
		const measure = {
			dataBytes: LOOKUP_MAX_TABLE_BYTES + 1,
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
		const phrases = lookupCapExcess(
			managedLookupContentOf(proto.read.table, proto.read.rows),
			measure,
		);
		expect(phrases).toHaveLength(2);
		expect(
			proto.findings.map((finding) => [finding.code, finding.detail.name]),
		).toEqual(phrases.map((phrase) => [CAPS_ENTRY, `__proto__: ${phrase}`]));
		expect(proto.standing).toBeNull();
	});

	it("reads only the rows reached by the form's local alias, even when prose, a declaration, or a longer tag mentions another table", async () => {
		const source = await sourceNoting(
			"Notes about item-list:plain and item-list:unused",
			"count(instance('item-list:plain')/plain-west_list/plain-west) > 0",
			'<instance id="item-list:plain" src="jr://fixture/item-list:plain-west"/><instance id="optional" src="jr://fixture/item-list:unused"/>',
		);
		await withHttpPeer(async (peer) => {
			const tables = ["plain", "plain-west", "unused"].map((tag, index) => ({
				id: String(index + 1).padStart(32, "0"),
				tag,
				fields: [{ field_name: "code", properties: [] }],
				is_global: true,
				item_attributes: [],
				resource_uri: "",
			}));
			serveJson(peer, LIST, {
				meta: { limit: 100, offset: 0, next: null, total_count: 3 },
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
			expect(reply.kind).toBe("read");
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
