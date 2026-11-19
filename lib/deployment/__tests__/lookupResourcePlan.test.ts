/** Ownership decisions consume complete inventory evidence. The workbook and
 * ledger consequences run through actual MCP + Postgres publishing tests. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { listHqLookupTables } from "@/lib/commcare/hq/lookupTables";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	canonicalLookupTable,
	lookupDefinitionChange,
	lookupRowsChange,
} from "../hqResourceBaseline";
import {
	planLookupResourcePush,
	type RemoteLookupTable,
	unsupportedLookupContent,
} from "../lookupResourcePlan";
import { baselineFromTableOrigin } from "../managedData";
import type { SiblingLookupMapping } from "../store";
import type {
	CanonicalLookupTable,
	DeploymentResource,
	DeploymentResourceOwnership,
} from "../types";

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
		adoptedByName: ownership === "adopted" ? "Actor" : null,
		releasedAt: null,
		endedReason: null,
		endedByName: null,
		heldByAnotherApp: false,
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
/** No sibling mapping and no takeover: the input every case starts from. */
const ALONE = { siblings: [], takenOver: [] } as const;

it.each(["nova-created", "adopted"] as const)(
	"retains %s ownership only for the exact surviving remote object",
	(ownership) => {
		const input = {
			tables: [districts],
			mappings: [mapping(ownership)],
			hqTables: [hq("hq-districts", "districts")],
			adoptTableIds: [],
			...ALONE,
		};
		const before = structuredClone(input);
		const owned = {
			...districts,
			ownership,
			mappedRemoteId: "hq-districts",
			adoption: null,
			baseline: "mapping",
		};
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
			pushes: [
				{
					...districts,
					ownership: "adopted",
					mappedRemoteId: null,
					adoption: null,
					baseline: null,
				},
			],
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
			...ALONE,
		};
		// The mapped table HQ no longer holds is still the one compared.
		expect(planLookupResourcePush(input)).toEqual({
			ok: true,
			pushes: [
				{
					...districts,
					ownership: "nova-created",
					mappedRemoteId: "hq-districts",
					adoption: null,
					baseline: "mapping",
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
			pushes: [
				{
					...renamed,
					ownership: "nova-created",
					mappedRemoteId: null,
					adoption: null,
					baseline: null,
				},
			],
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
		...ALONE,
	};
	expect(planLookupResourcePush(input)).toEqual({
		ok: true,
		pushes: [created(statuses), created(districts)],
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
		...ALONE,
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
		pushes: [adoptedHere(districts), adoptedHere(statuses)],
	});
});

/** A table this push makes, mapped by nobody. */
function created(table: { tableId: typeof DISTRICTS; tag: string }) {
	return {
		...table,
		ownership: "nova-created",
		mappedRemoteId: null,
		adoption: null,
		baseline: null,
	};
}
/** A table the caller names in `adoptTableIds`, attributed to whoever presses. */
function adoptedHere(table: { tableId: typeof DISTRICTS; tag: string }) {
	return { ...created(table), ownership: "adopted" };
}

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
				...ALONE,
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
		...ALONE,
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
			...ALONE,
		}),
	).toEqual({ ok: true, pushes: [created(districts)] });
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
				path: "/a/clinic/api/lookup_table/v1/?limit=1000",
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

/** A live mapping another app of the Project holds on this project space. */
function sibling(
	appId: string,
	remoteId: string,
	adopted: { at: string; by: string } | null = null,
): SiblingLookupMapping {
	return {
		tableId: DISTRICTS,
		appId,
		remoteId,
		pushedIdentity: "districts",
		ownership: adopted === null ? "nova-created" : "adopted",
		adoptedAt: adopted?.at ?? null,
		adoptedBy: adopted?.by ?? null,
	};
}

it("pushes the Project's own table where a sibling's mapping names the table HQ holds, and compares with that mapping's baseline", () => {
	const plan = planLookupResourcePush({
		tables: [districts],
		mappings: [],
		hqTables: [hq("hq-districts", "districts")],
		adoptTableIds: [],
		siblings: [sibling("app-a", "hq-districts")],
		takenOver: [],
	});
	expect(plan).toEqual({
		ok: true,
		pushes: [
			{
				...districts,
				ownership: "nova-created",
				mappedRemoteId: "hq-districts",
				adoption: null,
				baseline: "mapping",
			},
		],
	});
});

it("inherits an adoption from the earliest adopted sibling, whoever pushed first", () => {
	const plan = planLookupResourcePush({
		tables: [districts],
		mappings: [],
		hqTables: [hq("hq-districts", "districts")],
		adoptTableIds: [],
		siblings: [
			sibling("app-a", "hq-districts"),
			sibling("app-b", "hq-districts", {
				at: "2026-09-02T10:00:00.000Z",
				by: "later-admin",
			}),
			sibling("app-c", "hq-districts", {
				at: "2026-08-30T08:00:00.000Z",
				by: "first-admin",
			}),
		],
		takenOver: [],
	});
	expect(plan).toEqual({
		ok: true,
		pushes: [
			{
				...districts,
				ownership: "adopted",
				mappedRemoteId: "hq-districts",
				adoption: { at: "2026-08-30T08:00:00.000Z", by: "first-admin" },
				baseline: "mapping",
			},
		],
	});
});

it("reads a sibling's mapping of another HQ table, or under another tag, as nothing and refuses the clash", () => {
	for (const stale of [
		sibling("app-a", "hq-made-again"),
		{ ...sibling("app-a", "hq-districts"), pushedIdentity: "areas" },
	]) {
		expect(
			planLookupResourcePush({
				tables: [districts],
				mappings: [],
				hqTables: [hq("hq-districts", "districts")],
				adoptTableIds: [],
				siblings: [stale],
				takenOver: [],
			}),
		).toEqual({
			ok: false,
			conflicts: [{ ...districts, remoteId: "hq-districts" }],
		});
	}
});

it("pushes a table taken over with Manage in Nova as adopted by that person, compared with the table's own origin", () => {
	const taken = {
		tableId: DISTRICTS,
		remoteId: "hq-districts-at-refresh",
		at: "2026-10-01T09:00:00.000Z",
		by: "admin",
	};
	// CommCare HQ minted the table again since the last refresh: the takeover
	// still decides, and the comparison reads content, not the id.
	expect(
		planLookupResourcePush({
			tables: [districts],
			mappings: [],
			hqTables: [hq("hq-districts-now", "districts")],
			adoptTableIds: [],
			siblings: [],
			takenOver: [taken],
		}),
	).toEqual({
		ok: true,
		pushes: [
			{
				...districts,
				ownership: "adopted",
				mappedRemoteId: "hq-districts-now",
				adoption: { at: taken.at, by: taken.by },
				baseline: "table-origin",
			},
		],
	});
	// A sibling's mapping of the very table comes first: it is the Project's standing.
	expect(
		planLookupResourcePush({
			tables: [districts],
			mappings: [],
			hqTables: [hq("hq-districts-now", "districts")],
			adoptTableIds: [],
			siblings: [sibling("app-a", "hq-districts-now")],
			takenOver: [taken],
		}),
	).toMatchObject({ ok: true, pushes: [{ baseline: "mapping" }] });
	// A tag HQ does not hold is a create whatever the takeover says.
	expect(
		planLookupResourcePush({
			tables: [districts],
			mappings: [],
			hqTables: [],
			adoptTableIds: [],
			siblings: [],
			takenOver: [taken],
		}),
	).toEqual({ ok: true, pushes: [created(districts)] });
});

it("compares a re-minted taken-over table by content: its origin's canonical value under HQ's current id", () => {
	const table = {
		id: "hq-districts-now",
		tag: "districts",
		isGlobal: true,
		fields: ["code", "name"],
		fieldProperties: { code: [], name: [] },
		itemAttributes: [],
	};
	const rows = [{ id: "row-1", fields: { code: "001", name: "North" } }];
	const atRefresh = canonicalLookupTable(
		{ ...table, id: "hq-districts-at-refresh" },
		rows,
	);
	const baseline = baselineFromTableOrigin({
		canonical: JSON.parse(JSON.stringify(atRefresh)),
		remoteId: table.id,
		refreshedAt: "2026-10-01T09:00:00.000Z",
	});
	expect(baseline).toEqual({
		origin: "push",
		kind: "lookup-table",
		remoteId: table.id,
		canonical: { ...atRefresh, remoteId: table.id },
		digest: atRefresh.digest,
		observedAt: "2026-10-01T09:00:00.000Z",
	});
	expect(
		lookupDefinitionChange(baseline.canonical as CanonicalLookupTable, table),
	).toEqual([]);
	expect(
		lookupRowsChange(baseline.canonical as CanonicalLookupTable, {
			totalCount: 1,
			rows,
		}),
	).toEqual([]);
	expect(() =>
		baselineFromTableOrigin({
			canonical: { digest: atRefresh.digest },
			remoteId: table.id,
			refreshedAt: "2026-10-01T09:00:00.000Z",
		}),
	).toThrow();
});
