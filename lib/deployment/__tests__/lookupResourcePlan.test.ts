/** Ownership decisions consume complete inventory evidence. The workbook and
 * ledger consequences run through actual MCP + Postgres publishing tests. */
import { expect, it } from "vitest";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { planLookupResourcePush } from "../lookupResourcePlan";
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
		pushedAt: "2026-08-18T00:00:00.000Z",
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
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
			hqTables: [{ id: "hq-districts", tag: "districts" }],
			adoptTableIds: [],
		};
		const before = structuredClone(input);
		expect(planLookupResourcePush(input)).toEqual({
			ok: true,
			pushes: [{ ...districts, ownership }],
		});
		// Repeated approval does not invent a second adoption of an owned object.
		expect(
			planLookupResourcePush({ ...input, adoptTableIds: [DISTRICTS] }),
		).toEqual({ ok: true, pushes: [{ ...districts, ownership }] });
		expect(input).toEqual(before);
		expect(
			planLookupResourcePush({
				...input,
				hqTables: [{ id: "replacement", tag: "districts" }],
			}),
		).toEqual({
			ok: false,
			conflicts: [{ ...districts, remoteId: "replacement" }],
		});
		expect(
			planLookupResourcePush({
				...input,
				hqTables: [{ id: "replacement", tag: "districts" }],
				adoptTableIds: [DISTRICTS],
			}),
		).toEqual({ ok: true, pushes: [{ ...districts, ownership: "adopted" }] });
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
		expect(planLookupResourcePush(input)).toEqual({
			ok: true,
			pushes: [{ ...districts, ownership: "nova-created" }],
		});
		const renamed = { ...districts, tag: "areas" };
		expect(
			planLookupResourcePush({
				...input,
				tables: [renamed],
				hqTables: [{ id: "hq-districts", tag: "districts" }],
			}),
		).toEqual({
			ok: true,
			pushes: [{ ...renamed, ownership: "nova-created" }],
		});
		expect(
			planLookupResourcePush({
				...input,
				tables: [renamed],
				hqTables: [
					{ id: "hq-districts", tag: "districts" },
					{ id: "theirs", tag: "areas" },
				],
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
			{ ...statuses, ownership: "nova-created" },
			{ ...districts, ownership: "nova-created" },
		],
	});
	expect(
		planLookupResourcePush({
			...input,
			hqTables: [{ id: "foreign", tag: "districts" }],
		}),
	).toEqual({ ok: false, conflicts: [{ ...districts, remoteId: "foreign" }] });
});

it("adopts exactly the named conflicts and refuses the whole workbook until every conflict is resolved", () => {
	const input = {
		tables: [districts, statuses],
		mappings: [],
		hqTables: [
			{ id: "foreign-districts", tag: "districts" },
			{ id: "foreign-statuses", tag: "statuses" },
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
			{ ...districts, ownership: "adopted" },
			{ ...statuses, ownership: "adopted" },
		],
	});
});
