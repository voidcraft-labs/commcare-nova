/**
 * The claims a bring-in files for a menu icon whose file CommCare HQ no longer serves, over
 * `gatherFromHq` with a Project side that holds nothing and CommCare HQ answering on a loopback
 * socket.
 *
 * Contract: a file judged missing makes the reader run once more over the verdicts
 * (`gather.ts::checkWith`), where the icon's path resolves to no file and is handed to project
 * data; the files' claim for it (an icon only Web Apps draws, as a broken picture) is counted
 * once for each site the reader handed that path off from, and recorded where the value its
 * entry names sits: the app's `multimedia_map`, under `schema:Application.multimedia_map`, the
 * place the lane's parity reads that key at.
 *
 * The plausible failures: the claims of the reader's first run, made before any file was judged,
 * where every mapped path is a file and nothing is handed off, filed with the verdicts' claims,
 * so the icon's claim stands nowhere and its entry is counted nowhere; or the claim recorded at
 * the menu's icon slot, a place where the map's key does not sit.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import type { LookupRevision } from "@/lib/lookup/types";
import { gatherFromHq } from "../gather";
import type { ReadingProjectSide } from "../projectData/read";

const HOSTNAME = "india.commcarehq.org";
const DOMAIN = "clinic";
const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const APP = retainedBodyJson(retainedReadingRead("application")).id as string;
const KEY = {
	projectId: "icon-project",
	server: "india",
	domain: DOMAIN,
	remoteAppId: APP,
} as const;
const ICON = "jr://file/commcare/image/menu_icon.png";
const MEDIA_ID = "0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a";

const PATHS = {
	application: `/a/${DOMAIN}/api/application/v1/${APP}/`,
	source: `/a/${DOMAIN}/apps/source/${APP}/`,
	version: `/a/${DOMAIN}/apps/view/${APP}/current_version/`,
	tables: `/a/${DOMAIN}/api/lookup_table/v1/?limit=100`,
	icon: `/hq/multimedia/file/CommCareImage/${MEDIA_ID}/`,
};

const NOTHING: ReadingProjectSide = {
	tables: async () => ({
		projectId: KEY.projectId,
		projectRevision: "0" as LookupRevision,
		definitions: [],
		rowsByTable: {},
		keptColumns: {},
	}),
	referencingApps: async () => ({}),
	siblings: async () => [],
	mayAdminister: async () => true,
	measureRows: async () => ({ dataBytes: 0, largestRowBytes: 0 }),
};

function noTables(): RetainedHqAnswer {
	const answer = retainedGroupRead("lookups/lookup-tables");
	const body = retainedBodyJson(answer);
	return {
		...answer,
		body: JSON.stringify({
			...body,
			meta: { ...(body.meta as object), total_count: 0 },
			objects: [],
		}),
	};
}

function send(response: ServerResponse, answer: RetainedHqAnswer): void {
	response.writeHead(answer.status, { ...answer.headers });
	response.end(retainedBodyText(answer));
}

/** `navigation-base` with its first menu's icon at `ICON`, mapped to a file where `mapped`, and
 *  with an empty media map otherwise. */
function withIcon(mapped: boolean): RetainedHqAnswer {
	const answer = retainedGroupRead("navigation-base/app-source");
	const body = retainedBodyJson(answer);
	const [language = "en"] = body.langs as string[];
	const [menu] = body.modules as Record<string, unknown>[];
	if (menu === undefined) throw new Error("navigation-base holds a menu.");
	menu.media_image = { [language]: ICON };
	body.multimedia_map = mapped
		? {
				[ICON]: {
					doc_type: "HQMediaMapItem",
					multimedia_id: MEDIA_ID,
					media_type: "CommCareImage",
					unique_id: "1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b",
					version: 1,
				},
			}
		: {};
	return { ...answer, body: JSON.stringify(body) };
}

const NOTHING_DRAWS =
	"expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map";

/** A bring-in of `source` over the loopback socket: the place and key of each record of the
 *  icon's entry in its claim log, and the entry's count. */
async function iconClaims(source: RetainedHqAnswer): Promise<{
	readonly records: readonly { where: string; key: string | null }[];
	readonly count: number | undefined;
}> {
	let found:
		| {
				readonly records: readonly { where: string; key: string | null }[];
				readonly count: number | undefined;
		  }
		| undefined;
	await withSocketHttpPeer(
		HOSTNAME,
		(request: IncomingMessage, response: ServerResponse) => {
			if (request.url === PATHS.application)
				send(response, retainedReadingRead("application"));
			else if (request.url === PATHS.source) send(response, source);
			else if (request.url === PATHS.version)
				send(response, retainedReadingRead("current-version"));
			else if (request.url === PATHS.tables) send(response, noTables());
			else {
				response.writeHead(404);
				response.end();
			}
		},
		async () => {
			const { claims } = await gatherFromHq({
				key: KEY,
				readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5c",
				appId: "5b0c8d6e-2f1a-4c3b-9e7d-6a5b4c3d2e1a",
				keepMedia: false,
				onEvent: () => {},
				creds: CREDS,
				project: NOTHING,
				claims: "full",
			});
			const records = (claims?.log ?? "")
				.split("\n")
				.filter((line) => line !== "")
				.map(
					(line) =>
						JSON.parse(line) as {
							where: string;
							key: string | null;
							entry: string;
						},
				)
				.filter((one) => one.entry === NOTHING_DRAWS)
				.map(({ where, key }) => ({ where, key }));
			found = { records, count: claims?.counts[NOTHING_DRAWS] };
		},
	);
	if (found === undefined)
		throw new Error("The loopback bring-in finished without reading the app.");
	return found;
}

describe("the claims a bring-in files for a menu icon with no file", () => {
	it("files the icon's claim at the app's media map, once a site the reader's run over the verdicts handed it off from", async () => {
		expect(await iconClaims(withIcon(true))).toEqual({
			records: [
				{ where: "/multimedia_map", key: "schema:Application.multimedia_map" },
			],
			count: 1,
		});
	});

	it("files the icon's claim at the media map with no surface key where the map is empty, which is no use", async () => {
		expect(await iconClaims(withIcon(false))).toEqual({
			records: [{ where: "/multimedia_map", key: null }],
			count: 1,
		});
	});
});
