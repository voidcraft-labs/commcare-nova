/**
 * A bring-in's read of an app whose forms hold more than one reading parses,
 * over `gatherFromHq` with a Project side that holds nothing and CommCare HQ
 * answering on a loopback socket.
 *
 * Contract: the forms are parsed and their nodes counted before anything
 * reads them; an app whose forms together pass the reading's total
 * (`HQ_BRING_IN_READING_MAX_XML_NODES`) answers the one `too-large` account,
 * as an app past the byte cap does, and nothing reads its forms after the
 * count (the edit mode test reads none). An app at the total reads on. The
 * total is set here to the retained app's own count so the case needs no
 * large body: the count is what is under test.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { publishedCaseBlocks } from "@/lib/commcare/hq/publishedCaseBlocks";
import { heldXmlParse } from "@/lib/commcare/xmlParse";
import type { LookupRevision } from "@/lib/lookup/types";
import { gatherFromHq } from "../gather";
import type { ReadingProjectSide } from "../projectData/read";

const total = vi.hoisted(() => ({ nodes: 0 }));
vi.mock("@/lib/commcare/hq/bounds", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/commcare/hq/bounds")>();
	return {
		...actual,
		get HQ_BRING_IN_READING_MAX_XML_NODES() {
			return total.nodes;
		},
	};
});
vi.mock("@/lib/commcare/hq/publishedCaseBlocks", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@/lib/commcare/hq/publishedCaseBlocks")
		>();
	return { ...actual, publishedCaseBlocks: vi.fn(actual.publishedCaseBlocks) };
});

const HOSTNAME = "india.commcarehq.org";
const DOMAIN = "clinic";
const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const SOURCE = retainedGroupRead("navigation-base/app-source");
const APP = retainedBodyJson(retainedReadingRead("application")).id as string;
const KEY = {
	projectId: "forms-project",
	server: "india",
	domain: DOMAIN,
	remoteAppId: APP,
} as const;

const PATHS = {
	application: `/a/${DOMAIN}/api/application/v1/${APP}/`,
	source: `/a/${DOMAIN}/apps/source/${APP}/`,
	version: `/a/${DOMAIN}/apps/view/${APP}/current_version/`,
	tables: `/a/${DOMAIN}/api/lookup_table/v1/?limit=1000`,
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

/** The nodes the retained app's forms hold, as the reading counts them. */
function sourceNodes(): number {
	const attachments = retainedBodyJson(SOURCE)._attachments as Record<
		string,
		unknown
	>;
	let nodes = 0;
	for (const [name, text] of Object.entries(attachments)) {
		if (!name.endsWith(".xml") || typeof text !== "string") continue;
		const parsed = heldXmlParse(text);
		if ("doc" in parsed) nodes += parsed.nodes;
	}
	return nodes;
}

async function gather() {
	return withSocketHttpPeer(
		HOSTNAME,
		(request: IncomingMessage, response: ServerResponse) => {
			if (request.url === PATHS.application)
				send(response, {
					...retainedReadingRead("application"),
					body: JSON.stringify({
						...retainedBodyJson(retainedReadingRead("application")),
						id: APP,
					}),
				});
			else if (request.url === PATHS.source) send(response, SOURCE);
			else if (request.url === PATHS.version)
				send(response, retainedReadingRead("current-version"));
			else if (request.url === PATHS.tables) send(response, noTables());
			else {
				response.writeHead(404);
				response.end();
			}
		},
		() =>
			gatherFromHq({
				key: KEY,
				readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5c",
				appId: "5b0c8d6e-2f1a-4c3b-9e7d-6a5b4c3d2e10",
				stageMedia: null,
				onEvent: () => {},
				creds: CREDS,
				project: NOTHING,
			}),
	);
}

beforeEach(() => {
	vi.mocked(publishedCaseBlocks).mockClear();
});

describe("a bring-in's read of an app whose forms hold more than one reading parses", () => {
	it("answers the one too-large account, naming the app, and reads none of its forms after the count", async () => {
		total.nodes = sourceNodes() - 1;
		const { result } = await gather();
		expect(result.kind).toBe("account");
		if (result.kind !== "account") return;
		expect(result.account.findings.map((finding) => finding.code)).toEqual([
			"too-large",
		]);
		expect(result.account.appName).toBe(retainedBodyJson(SOURCE).name);
		expect(publishedCaseBlocks).not.toHaveBeenCalled();
	});

	it("reads on where the forms hold exactly the total", async () => {
		total.nodes = sourceNodes();
		const { result } = await gather();
		expect(
			result.kind === "account"
				? result.account.findings.map((finding) => finding.code)
				: [],
		).not.toContain("too-large");
		expect(publishedCaseBlocks).toHaveBeenCalled();
	});
});
