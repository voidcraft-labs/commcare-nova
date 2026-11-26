/**
 * The JSON carrier's requests and the three outcomes a journal resumes from,
 * over real fetch with only CommCare HQ's peer controlled. The plausible
 * failures: a body CommCare HQ's schema refuses (a field's `field_name`, a
 * row's `field_list`, the `data_type_id` and `sort_key` its row resource
 * needs), a refusal that may have written read as one that did not, and an
 * acknowledgement Nova cannot read taken as applied.
 */
import { expect, it, vi } from "vitest";
import {
	readHttpRequestBody,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { recordFromEntries } from "@/lib/domain/records";
import { log } from "@/lib/logger";
import {
	createHqLookupRowJson,
	createHqLookupTableJson,
	deleteHqLookupRowJson,
	updateHqLookupRowJson,
	updateHqLookupTableJson,
} from "../hq/lookupJson";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const HOST = "https://india.commcarehq.org";
const TABLE = "a".repeat(32);
const ROW = "b".repeat(32);
const DEFINITION = {
	tag: "types",
	fields: [{ name: "name", properties: ["lang"] }],
	itemAttributes: ["zone"],
};
const CONTENT = {
	fields: {
		name: [
			{ value: " 007 ", properties: { lang: "en" } },
			{ value: "", properties: { lang: "fr" } },
		],
	},
	itemAttributes: { zone: "upland" },
	sortKey: 4,
};

function quiet() {
	vi.spyOn(log, "error").mockImplementation(() => undefined);
	vi.spyOn(log, "warn").mockImplementation(() => undefined);
}

it("creates a table tagged types with every field's name and properties, and takes the bodiless 201", async () => {
	let sent: unknown;
	const answer = await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: "/a/clinic/api/lookup_table/v1/", method: "POST" })
			.reply(async (request) => {
				sent = JSON.parse((await readHttpRequestBody(request)).toString());
				return { statusCode: 201, data: "" };
			});
		return createHqLookupTableJson(CREDS, "clinic", DEFINITION);
	});
	expect(answer).toEqual({ kind: "applied", value: true });
	expect(sent).toEqual({
		tag: "types",
		is_global: true,
		fields: [{ field_name: "name", properties: ["lang"] }],
		item_attributes: ["zone"],
	});
});

it("appends a row with its exact spaces and an empty repeated value, and takes CommCare HQ's minted id and rank", async () => {
	let sent: unknown;
	const answer = await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({
				path: "/a/clinic/api/lookup_table_item/v2/",
				method: "POST",
			})
			.reply(async (request) => {
				sent = JSON.parse((await readHttpRequestBody(request)).toString());
				return {
					statusCode: 201,
					data: JSON.stringify({
						id: ROW,
						data_type_id: TABLE,
						sort_key: 9,
						fields: {},
						item_attributes: {},
						resource_uri: "",
					}),
					responseOptions: { headers: { "content-type": "application/json" } },
				};
			});
		return createHqLookupRowJson(CREDS, "clinic", TABLE, CONTENT);
	});
	expect(answer).toEqual({ kind: "applied", value: { id: ROW, sortKey: 9 } });
	expect(sent).toEqual({
		data_type_id: TABLE,
		fields: {
			name: {
				field_list: [
					{ field_value: " 007 ", properties: { lang: "en" } },
					{ field_value: "", properties: { lang: "fr" } },
				],
			},
		},
		item_attributes: { zone: "upland" },
		sort_key: 4,
	});
});

it("answers an append whose saved row names another table, or no id, as uncertain", async () => {
	quiet();
	for (const saved of [
		{ id: ROW, data_type_id: "c".repeat(32), sort_key: 1 },
		{ data_type_id: TABLE, sort_key: 1 },
	]) {
		const answer = await withHttpPeer(async (peer) => {
			peer
				.get(HOST)
				.intercept({
					path: "/a/clinic/api/lookup_table_item/v2/",
					method: "POST",
				})
				.reply(201, saved);
			return createHqLookupRowJson(CREDS, "clinic", TABLE, CONTENT);
		});
		expect(answer.kind).toBe("uncertain");
	}
});

it("replaces a row whole at its own id, and deletes one by its id", async () => {
	const calls: string[] = [];
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({
				path: `/a/clinic/api/lookup_table_item/v2/${ROW}/`,
				method: "PUT",
			})
			.reply(async (request) => {
				calls.push(`PUT ${(await readHttpRequestBody(request)).toString()}`);
				return { statusCode: 200, data: "{}" };
			});
		peer
			.get(HOST)
			.intercept({
				path: `/a/clinic/api/lookup_table_item/v2/${ROW}/`,
				method: "DELETE",
			})
			.reply(() => {
				calls.push("DELETE");
				return { statusCode: 202, data: "" };
			});
		expect(
			await updateHqLookupRowJson(CREDS, "clinic", TABLE, ROW, CONTENT),
		).toEqual({ kind: "applied", value: true });
		expect(await deleteHqLookupRowJson(CREDS, "clinic", ROW)).toEqual({
			kind: "applied",
			value: true,
		});
	});
	expect(calls[0]).toContain(`"data_type_id":"${TABLE}"`);
	expect(calls[0]).toContain('"sort_key":4');
	expect(calls[1]).toBe("DELETE");
});

it("tells a refusal before the view from one that may have written", async () => {
	quiet();
	const outcome = async (status: number) =>
		withHttpPeer(async (peer) => {
			peer
				.get(HOST)
				.intercept({
					path: `/a/clinic/api/lookup_table/v1/${TABLE}/`,
					method: "PUT",
				})
				.reply(status, "{}");
			return (await updateHqLookupTableJson(CREDS, "clinic", TABLE, DEFINITION))
				.kind;
		});
	// A tag change and a schema the resource refuses are 400s before any save.
	expect(await outcome(400)).toBe("not-applied");
	expect(await outcome(403)).toBe("not-applied");
	// A server error or a gateway's own may have run the save.
	expect(await outcome(500)).toBe("uncertain");
	expect(await outcome(504)).toBe("uncertain");
	// A 404 is uncertain: only a read of the id tells.
	expect(await outcome(404)).toBe("uncertain");
});

it("sends nothing for an id or rank CommCare HQ could not hold", async () => {
	await withHttpPeer(async () => {
		expect(
			(await updateHqLookupRowJson(CREDS, "clinic", TABLE, "../x", CONTENT))
				.kind,
		).toBe("not-applied");
		expect(
			(
				await createHqLookupRowJson(CREDS, "clinic", TABLE, {
					...CONTENT,
					sortKey: 2 ** 31,
				})
			).kind,
		).toBe("not-applied");
		expect((await deleteHqLookupRowJson(CREDS, "not a domain", ROW)).kind).toBe(
			"not-applied",
		);
	});
});

it("sends a field and a detail named __proto__ as their own entries", async () => {
	let sent = "";
	const fields = recordFromEntries([
		[
			"__proto__",
			[{ value: "x", properties: recordFromEntries([["__proto__", "y"]]) }],
		],
	]);
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({
				path: `/a/clinic/api/lookup_table_item/v2/${ROW}/`,
				method: "PUT",
			})
			.reply(async (request) => {
				sent = (await readHttpRequestBody(request)).toString();
				return { statusCode: 204, data: "" };
			});
		return updateHqLookupRowJson(CREDS, "clinic", TABLE, ROW, {
			fields,
			itemAttributes: recordFromEntries([["__proto__", "z"]]),
			sortKey: 0,
		});
	});
	expect(JSON.parse(sent)).toMatchObject({
		fields: {
			["__proto__"]: {
				field_list: [{ field_value: "x", properties: { ["__proto__"]: "y" } }],
			},
		},
	});
	expect(sent).toContain('"item_attributes":{"__proto__":"z"}');
});
