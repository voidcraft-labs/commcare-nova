/** Ownership decisions consume complete inventory evidence. The workbook and
 * ledger consequences run through actual MCP + Postgres publishing tests. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { listHqLookupTables } from "@/lib/commcare/hq/lookupTables";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	planLookupResourcePush,
	type RemoteLookupTable,
	unsupportedLookupContent,
} from "../lookupResourcePlan";
import type { DeploymentResource, DeploymentResourceOwnership } from "../types";

const DISTRICTS = lookupTableIdSchema.parse(
	"018f0000-0000-7000-8000-000000000001",
);
const STATUSES = lookupTableIdSchema.parse(
	"018f0000-0000-7000-8000-000000000002",
);
function mapping(ownership: DeploymentResourceOwnership): DeploymentResource {
	return {
		deploymentId: "dep-1",
		novaResourceId: DISTRICTS,
		kind: "lookup-table",
		remoteId: "hq-districts",
		ownership,
		pushedIdentity: "districts",
		adoptedAt: ownership === "adopted" ? "2026-08-18T00:00:00.000Z" : null,
		adoptedBy: ownership === "adopted" ? "actor" : null,
		pushedRevision: null,
		pushToken: "01992000-0000-7000-8000-000000000001",
		pushedAt: "2026-08-18T00:00:00.000Z",
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		remoteMissingAt: null,
	};
}
/** A global table with no field property and no row attribute, which a push keeps whole. */
function hq(
	id: string,
	tag: string,
	held: Partial<RemoteLookupTable> = {},
): RemoteLookupTable {
	return {
		id,
		tag,
		isGlobal: true,
		fieldProperties: { code: [] },
		itemAttributes: [],
		...held,
	};
}
const districts = { tableId: DISTRICTS, tag: "districts" };
const statuses = { tableId: STATUSES, tag: "statuses" };

it.each(["nova-created", "adopted"] as const)(
	"retains %s ownership only for the exact surviving remote object",
	(ownership) => {
		const input = {
			tables: [districts],
			mappings: [mapping(ownership)],
			hqTables: [hq("hq-districts", "districts")],
			adoptTableIds: [],
		};
		const before = structuredClone(input);
		const owned = { ...districts, ownership, mappedRemoteId: "hq-districts" };
		expect(planLookupResourcePush(input)).toEqual({
			ok: true,
			pushes: [owned],
		});
		// Repeated approval does not invent a second adoption of an owned object.
		expect(
			planLookupResourcePush({ ...input, adoptTableIds: [DISTRICTS] }),
		).toEqual({ ok: true, pushes: [owned] });
		expect(input).toEqual(before);
		expect(
			planLookupResourcePush({
				...input,
				hqTables: [hq("replacement", "districts")],
			}),
		).toEqual({
			ok: false,
			conflicts: [{ ...districts, remoteId: "replacement" }],
		});
		expect(
			planLookupResourcePush({
				...input,
				hqTables: [hq("replacement", "districts")],
				adoptTableIds: [DISTRICTS],
			}),
		).toEqual({
			ok: true,
			// A table taken over in this publish is not compared with the one mapped before.
			pushes: [{ ...districts, ownership: "adopted", mappedRemoteId: null }],
		});
	},
);

it.each(["nova-created", "adopted"] as const)(
	"records a new creation after the previously %s table disappears or its tag changes",
	(ownership) => {
		const input = {
			tables: [districts],
			mappings: [mapping(ownership)],
			hqTables: [],
			adoptTableIds: [],
		};
		// The mapped table HQ no longer holds is still the one compared.
		expect(planLookupResourcePush(input)).toEqual({
			ok: true,
			pushes: [
				{
					...districts,
					ownership: "nova-created",
					mappedRemoteId: "hq-districts",
				},
			],
		});
		const renamed = { ...districts, tag: "areas" };
		expect(
			planLookupResourcePush({
				...input,
				tables: [renamed],
				hqTables: [hq("hq-districts", "districts")],
			}),
		).toEqual({
			ok: true,
			// Renamed in Nova: the mapping names another tag, so nothing is compared.
			pushes: [{ ...renamed, ownership: "nova-created", mappedRemoteId: null }],
		});
		expect(
			planLookupResourcePush({
				...input,
				tables: [renamed],
				hqTables: [hq("hq-districts", "districts"), hq("theirs", "areas")],
			}),
		).toEqual({ ok: false, conflicts: [{ ...renamed, remoteId: "theirs" }] });
	},
);

it("creates all requested tables in order only when none conflicts", () => {
	const input = {
		tables: [statuses, districts],
		mappings: [],
		hqTables: [],
		adoptTableIds: [],
	};
	expect(planLookupResourcePush(input)).toEqual({
		ok: true,
		pushes: [
			{ ...statuses, ownership: "nova-created", mappedRemoteId: null },
			{ ...districts, ownership: "nova-created", mappedRemoteId: null },
		],
	});
	expect(
		planLookupResourcePush({
			...input,
			hqTables: [hq("foreign", "districts")],
		}),
	).toEqual({ ok: false, conflicts: [{ ...districts, remoteId: "foreign" }] });
});

it("adopts exactly the named conflicts and refuses the whole workbook until every conflict is resolved", () => {
	const input = {
		tables: [districts, statuses],
		mappings: [],
		hqTables: [
			hq("foreign-districts", "districts"),
			hq("foreign-statuses", "statuses"),
		],
		adoptTableIds: [],
	};
	expect(planLookupResourcePush(input)).toEqual({
		ok: false,
		conflicts: [
			{ ...districts, remoteId: "foreign-districts" },
			{ ...statuses, remoteId: "foreign-statuses" },
		],
	});
	expect(
		planLookupResourcePush({ ...input, adoptTableIds: [DISTRICTS] }),
	).toEqual({
		ok: false,
		conflicts: [{ ...statuses, remoteId: "foreign-statuses" }],
	});
	expect(
		planLookupResourcePush({ ...input, adoptTableIds: [DISTRICTS, STATUSES] }),
	).toEqual({
		ok: true,
		pushes: [
			{ ...districts, ownership: "adopted", mappedRemoteId: null },
			{ ...statuses, ownership: "adopted", mappedRemoteId: null },
		],
	});
});

const FIELD_PROPERTY = { fieldProperties: { code: [], name: ["lang"] } };
const ROW_ATTRIBUTE = { itemAttributes: ["zone"] };
const NOT_GLOBAL = { isGlobal: false };

it("names what HQ's copy holds that a push would remove, in its order, and nothing for a plain table", () => {
	expect(unsupportedLookupContent(hq("t", "districts"))).toEqual([]);
	expect(
		unsupportedLookupContent(hq("t", "districts", FIELD_PROPERTY)),
	).toEqual(["field-properties"]);
	expect(unsupportedLookupContent(hq("t", "districts", ROW_ATTRIBUTE))).toEqual(
		["row-attributes"],
	);
	expect(unsupportedLookupContent(hq("t", "districts", NOT_GLOBAL))).toEqual([
		"not-global",
	]);
	expect(
		unsupportedLookupContent(
			hq("t", "districts", {
				...NOT_GLOBAL,
				...ROW_ATTRIBUTE,
				...FIELD_PROPERTY,
			}),
		),
	).toEqual(["field-properties", "row-attributes", "not-global"]);
});

it.each([
	["Nova's own", "nova-created", []],
	["an adopted", "adopted", []],
] as const)(
	"refuses a push over %s table whose HQ copy holds what the push would remove",
	(_label, ownership, adoptTableIds) => {
		for (const held of [FIELD_PROPERTY, ROW_ATTRIBUTE, NOT_GLOBAL]) {
			const plan = planLookupResourcePush({
				tables: [districts],
				mappings: [mapping(ownership)],
				hqTables: [hq("hq-districts", "districts", held)],
				adoptTableIds,
			});
			expect(plan).toEqual({
				ok: false,
				unsupported: [
					{
						...districts,
						remoteId: "hq-districts",
						holds: unsupportedLookupContent(
							hq("hq-districts", "districts", held),
						),
					},
				],
			});
		}
	},
);

it("refuses a table being adopted and a clash not yet adopted, ahead of the clash, listing every table in order", () => {
	const input = {
		tables: [statuses, districts],
		mappings: [],
		hqTables: [
			hq("foreign-districts", "districts", NOT_GLOBAL),
			hq("foreign-statuses", "statuses", {
				...FIELD_PROPERTY,
				...ROW_ATTRIBUTE,
			}),
		],
		adoptTableIds: [],
	};
	const refused = {
		ok: false,
		unsupported: [
			{
				...statuses,
				remoteId: "foreign-statuses",
				holds: ["field-properties", "row-attributes"],
			},
			{ ...districts, remoteId: "foreign-districts", holds: ["not-global"] },
		],
	};
	expect(planLookupResourcePush(input)).toEqual(refused);
	// Adopting keeps none of it, so naming the tables changes nothing.
	expect(
		planLookupResourcePush({ ...input, adoptTableIds: [DISTRICTS, STATUSES] }),
	).toEqual(refused);
	// One unsupported table refuses the push even beside a plain clash.
	expect(
		planLookupResourcePush({
			...input,
			hqTables: [
				hq("foreign-districts", "districts", NOT_GLOBAL),
				hq("foreign-statuses", "statuses"),
			],
		}),
	).toEqual({
		ok: false,
		unsupported: [
			{ ...districts, remoteId: "foreign-districts", holds: ["not-global"] },
		],
	});
});

it("never refuses for a tag HQ does not hold, whatever else it holds", () => {
	expect(
		planLookupResourcePush({
			tables: [districts],
			mappings: [],
			hqTables: [hq("other", "other_tag", { ...NOT_GLOBAL, ...ROW_ATTRIBUTE })],
			adoptTableIds: [],
		}),
	).toEqual({
		ok: true,
		pushes: [{ ...districts, ownership: "nova-created", mappedRemoteId: null }],
	});
});

it("names the retained table that holds all three in HQ's own definition list", async () => {
	/* `proof/hq-reads/lookups/lookup-tables.json`: HQ's answer, retained by
	 * the lane, over `plain` (global, nothing else) and `rich` (not global,
	 * with a field property and a row attribute). */
	const answer = JSON.parse(
		readFileSync(
			path.join(process.cwd(), "proof/hq-reads/lookups/lookup-tables.json"),
			"utf8",
		),
	) as { status: number; headers: Record<string, string>; body: string };
	const tables = await withHttpPeer(async (peer) => {
		peer
			.get("https://india.commcarehq.org")
			.intercept({
				path: "/a/clinic/api/lookup_table/v1/?limit=100",
				method: "GET",
			})
			.reply(answer.status, answer.body, { headers: answer.headers });
		return listHqLookupTables(
			{ username: "account", apiKey: "fixture-key", server: "india" },
			"clinic",
		);
	});
	if ("success" in tables) throw new Error("the retained list did not parse");
	const byTag = new Map(tables.map((table) => [table.tag, table] as const));
	const rich = byTag.get("rich");
	const plain = byTag.get("plain");
	if (rich === undefined || plain === undefined) {
		throw new Error("the retained list lacks its plain and rich tables");
	}
	expect(unsupportedLookupContent(rich)).toEqual([
		"field-properties",
		"row-attributes",
		"not-global",
	]);
	expect(unsupportedLookupContent(plain)).toEqual([]);
});
