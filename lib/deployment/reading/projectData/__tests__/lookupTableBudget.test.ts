/**
 * The bounds a bring-in's lookup read keeps: one table's rows, and the rows of
 * every table one request reads together. CommCare HQ's own answers, retained
 * under `proof/hq-reads/lookups/`, served through a controlled peer to the
 * production readers, with the two bounds set small enough for those answers
 * to pass them.
 *
 * A table past its bound read as a failure of the whole reading, a request that
 * keeps reading past its total, or a table read further than what the request
 * has left are what these cases catch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	classifyHqFailure,
	hqReadCircumstance,
} from "@/lib/commcare/hq/failure";
import { readHqLookupTablesForReading } from "../lookupTableStore";
import { lookupTableFindings } from "../lookupTables";

const limits = vi.hoisted(() => ({ table: 0, request: 0 }));
vi.mock("@/lib/commcare/hq/bounds", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/commcare/hq/bounds")>();
	return {
		...actual,
		get HQ_LOOKUP_TABLE_ROWS_MAX_BYTES() {
			return limits.table;
		},
		get HQ_LOOKUP_ROWS_REQUEST_MAX_BYTES() {
			return limits.request;
		},
	};
});

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const HOST = "https://india.commcarehq.org";
const LOOKUPS = path.join(process.cwd(), "proof/hq-reads/lookups");
const LIST = "/a/clinic/api/lookup_table/v1/?limit=1000";
const PLAIN_ID = "09948f8373da4c86a86b7707a0e9fbcd";
const RICH_ID = "9ea70d486f644cc4a2f22c063294e197";
const SOURCE =
	'<instance id="a" src="jr://fixture/item-list:plain"/> instance(\'item-list:rich\')';

function retained(name: string): {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly body: string;
} {
	return JSON.parse(readFileSync(path.join(LOOKUPS, name), "utf8"));
}
const PLAIN = retained("fixture-rows-plain.json");
const RICH = retained("fixture-rows-rich.json");
const bytesOf = (answer: { readonly body: string }) =>
	Buffer.byteLength(answer.body);

function serve(
	peer: MockAgent,
	requestPath: string,
	answer: ReturnType<typeof retained>,
) {
	peer
		.get(HOST)
		.intercept({ path: requestPath, method: "GET" })
		.reply(answer.status, answer.body, { headers: answer.headers });
}
const rowsPath = (tableId: string) =>
	`/a/clinic/api/fixture/v1/?fixture_type_id=${tableId}`;

afterEach(() => {
	limits.table = 0;
	limits.request = 0;
});

describe("a bring-in's lookup rows", () => {
	it("hold a table past one table's bound as that table's finding, and still read the others", async () => {
		/* `plain` fits; `rich` passes one table's bound with room in the request. */
		limits.table = bytesOf(RICH) - 1;
		limits.request = 10 * bytesOf(RICH);
		const answer = await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookup-tables.json"));
			serve(peer, rowsPath(PLAIN_ID), PLAIN);
			serve(peer, rowsPath(RICH_ID), RICH);
			return readHqLookupTablesForReading({
				creds: CREDS,
				domain: "clinic",
				sourceText: SOURCE,
			});
		});
		if ("success" in answer) throw new Error("the read failed");
		expect(answer.tables.map((table) => [table.kind, table.table.tag])).toEqual(
			[
				["read", "plain"],
				["over-byte-limit", "rich"],
			],
		);
		const [, rich] = answer.tables;
		if (rich === undefined) throw new Error("rich was not answered");
		expect(
			lookupTableFindings(rich, null).map((finding) =>
				"detail" in finding ? finding.detail : null,
			),
		).toContainEqual({ name: "rich: more data than Nova reads for one table" });
	});

	it("answer a request whose tables together pass the request's bound as more lookup data than Nova brings in", async () => {
		/* Each table fits one table's bound; the two together pass the request's. */
		limits.table = bytesOf(RICH) + 1;
		limits.request = bytesOf(PLAIN) + bytesOf(RICH) - 1;
		const answer = await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookup-tables.json"));
			serve(peer, rowsPath(PLAIN_ID), PLAIN);
			serve(peer, rowsPath(RICH_ID), RICH);
			return readHqLookupTablesForReading({
				creds: CREDS,
				domain: "clinic",
				sourceText: SOURCE,
			});
		});
		expect(answer).toEqual({
			success: false,
			status: 502,
			cause: "too-large",
			request: "lookup-rows",
		});
		if (!("success" in answer)) throw new Error("the read did not fail");
		expect(hqReadCircumstance(classifyHqFailure(answer, answer.request))).toBe(
			"lookup-data-too-large",
		);
	});
});
