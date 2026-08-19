/**
 * What Nova is allowed to write over on a project space.
 *
 * The rule these prove is one sentence: a shared NAME is never evidence
 * of ownership. CommCare HQ's fixture upload matches tables by tag
 * (`fixtures/upload/run_upload.py::table_key`), so every path that ends
 * in a push has to be able to say WHY that table is Nova's, and the only
 * two answers are "the ledger says so" and "a person said so".
 */

import { describe, expect, it } from "vitest";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { planLookupResourcePush } from "../lookupResourcePlan";
import type { DeploymentResource } from "../types";

const DISTRICTS = "018f0000-0000-7000-8000-000000000001" as LookupTableId;
const STATUSES = "018f0000-0000-7000-8000-000000000002" as LookupTableId;

function mapping(
	over: Partial<DeploymentResource> & { novaResourceId: string },
): DeploymentResource {
	return {
		deploymentId: "dep-1",
		kind: "lookup-table",
		remoteId: "hq-districts",
		ownership: "nova-created",
		pushedIdentity: "districts",
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision: null,
		pushedAt: "2026-08-18T00:00:00.000Z",
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		...over,
	};
}

describe("a project space Nova has never pushed to", () => {
	it("creates every referenced table", () => {
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "districts" }],
			mappings: [],
			hqTables: [],
			adoptTableIds: [],
		});
		expect(plan).toEqual({
			ok: true,
			pushes: [
				{
					tableId: DISTRICTS,
					tag: "districts",
					ownership: "nova-created",
				},
			],
		});
	});

	it("refuses a name that is already taken there", () => {
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "districts" }],
			mappings: [],
			hqTables: [{ id: "somebody-elses", tag: "districts" }],
			adoptTableIds: [],
		});
		expect(plan).toEqual({
			ok: false,
			conflicts: [
				{ tableId: DISTRICTS, tag: "districts", remoteId: "somebody-elses" },
			],
		});
	});

	it("refuses the WHOLE push when any one table clashes", () => {
		/* One workbook, one upload. Pushing the clean tables and skipping the
		 * rest would leave the project space holding an app's data half
		 * updated, with no state that describes it. */
		const plan = planLookupResourcePush({
			tables: [
				{ tableId: DISTRICTS, tag: "districts" },
				{ tableId: STATUSES, tag: "statuses" },
			],
			mappings: [],
			hqTables: [{ id: "somebody-elses", tag: "statuses" }],
			adoptTableIds: [],
		});
		expect(plan.ok).toBe(false);
		if (plan.ok) throw new Error("expected a refusal");
		expect(plan.conflicts.map((conflict) => conflict.tag)).toEqual([
			"statuses",
		]);
	});

	it("takes a table over only when that exact table was named", () => {
		const plan = planLookupResourcePush({
			tables: [
				{ tableId: DISTRICTS, tag: "districts" },
				{ tableId: STATUSES, tag: "statuses" },
			],
			mappings: [],
			hqTables: [
				{ id: "theirs-1", tag: "districts" },
				{ id: "theirs-2", tag: "statuses" },
			],
			adoptTableIds: [DISTRICTS],
		});
		/* Naming one does not resolve the other: the refusal stands, and the
		 * person is asked about the table they have not answered for. */
		expect(plan.ok).toBe(false);
		if (plan.ok) throw new Error("expected a refusal");
		expect(plan.conflicts.map((conflict) => conflict.tag)).toEqual([
			"statuses",
		]);
	});

	it("records an adoption as an adoption, never as a creation", () => {
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "districts" }],
			mappings: [],
			hqTables: [{ id: "theirs", tag: "districts" }],
			adoptTableIds: [DISTRICTS],
		});
		expect(plan).toEqual({
			ok: true,
			pushes: [
				{
					tableId: DISTRICTS,
					tag: "districts",
					ownership: "adopted",
				},
			],
		});
	});

	it("ignores an adoption for a table that is not in conflict", () => {
		/* The plan records the ownership it can prove. A caller naming a
		 * table Nova already owns must not downgrade it to "adopted", which
		 * would attribute a takeover that never happened. */
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "districts" }],
			mappings: [mapping({ novaResourceId: DISTRICTS })],
			hqTables: [{ id: "hq-districts", tag: "districts" }],
			adoptTableIds: [DISTRICTS],
		});
		expect(plan.ok && plan.pushes[0]?.ownership).toBe("nova-created");
	});
});

describe("a project space Nova already pushed to", () => {
	it("pushes over its own table without asking", () => {
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "districts" }],
			mappings: [mapping({ novaResourceId: DISTRICTS })],
			hqTables: [{ id: "hq-districts", tag: "districts" }],
			adoptTableIds: [],
		});
		expect(plan.ok && plan.pushes[0]).toEqual({
			tableId: DISTRICTS,
			tag: "districts",
			ownership: "nova-created",
		});
	});

	it("keeps an adoption adopted on every later publish", () => {
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "districts" }],
			mappings: [
				mapping({
					novaResourceId: DISTRICTS,
					ownership: "adopted",
					adoptedAt: "2026-08-18T00:00:00.000Z",
					adoptedBy: "u1",
				}),
			],
			hqTables: [{ id: "hq-districts", tag: "districts" }],
			adoptTableIds: [],
		});
		/* The decision was made once and recorded. Asking again every publish
		 * would make the ledger's whole point ceremonial. */
		expect(plan.ok && plan.pushes[0]?.ownership).toBe("adopted");
	});

	it("recreates its own table after somebody deleted it there", () => {
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "districts" }],
			mappings: [mapping({ novaResourceId: DISTRICTS })],
			hqTables: [],
			adoptTableIds: [],
		});
		expect(plan.ok && plan.pushes[0]).toEqual({
			tableId: DISTRICTS,
			tag: "districts",
			ownership: "nova-created",
			/* Nothing is left behind: the table Nova pushed is gone, and the
			 * new one carries the same name. */
		});
	});

	it("refuses when a DIFFERENT table now wears the name Nova pushed", () => {
		/* Deleted on CommCare HQ, then remade by somebody else under the same
		 * tag. The ledger cannot tell those apart by name, which is the whole
		 * reason for the remote-id comparison. */
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "districts" }],
			mappings: [mapping({ novaResourceId: DISTRICTS })],
			hqTables: [{ id: "a-different-table", tag: "districts" }],
			adoptTableIds: [],
		});
		expect(plan).toEqual({
			ok: false,
			conflicts: [
				{
					tableId: DISTRICTS,
					tag: "districts",
					remoteId: "a-different-table",
				},
			],
		});
	});

	it("makes a new table when a tag is renamed", () => {
		/* The old table stays on the project space, per the deployment
		 * contract's rule that Nova never deletes a remote resource. What
		 * is left there is reported from the ledger row this push
		 * supersedes (`leftBehindResources`), not from the plan. */
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "areas" }],
			mappings: [mapping({ novaResourceId: DISTRICTS })],
			hqTables: [{ id: "hq-districts", tag: "districts" }],
			adoptTableIds: [],
		});
		expect(plan.ok && plan.pushes[0]).toEqual({
			tableId: DISTRICTS,
			tag: "areas",
			ownership: "nova-created",
		});
	});

	it("claims a renamed table as created, not adopted", () => {
		/* The old table was somebody else's and was taken over. Renaming the
		 * tag makes Nova create a NEW table on CommCare HQ, which nobody has
		 * ever chosen to take over, so inheriting `adopted` would attribute a
		 * decision about a table that did not exist until this push. */
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "areas" }],
			mappings: [
				mapping({
					novaResourceId: DISTRICTS,
					ownership: "adopted",
					adoptedAt: "2026-03-01T00:00:00.000Z",
					adoptedBy: "u1",
				}),
			],
			hqTables: [{ id: "hq-districts", tag: "districts" }],
			adoptTableIds: [],
		});
		expect(plan.ok && plan.pushes[0]).toEqual({
			tableId: DISTRICTS,
			tag: "areas",
			ownership: "nova-created",
		});
	});

	it("still refuses when a rename lands on somebody else's name", () => {
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "areas" }],
			mappings: [mapping({ novaResourceId: DISTRICTS })],
			hqTables: [
				{ id: "hq-districts", tag: "districts" },
				{ id: "theirs", tag: "areas" },
			],
			adoptTableIds: [],
		});
		expect(plan.ok).toBe(false);
	});

	it("reads only its own kind of mapping", () => {
		/* The ledger holds the app's mapping too, keyed by the Nova app id.
		 * A planner that read every row could match one by coincidence. */
		const plan = planLookupResourcePush({
			tables: [{ tableId: DISTRICTS, tag: "districts" }],
			mappings: [
				{
					deploymentId: "dep-1",
					kind: "app",
					novaResourceId: DISTRICTS,
					remoteId: "hq-app",
					ownership: "nova-created",
					pushedIdentity: null,
					adoptedAt: null,
					adoptedBy: null,
					pushedRevision: 4,
					pushedAt: "2026-08-18T00:00:00.000Z",
					remoteRevision: null,
					remoteObservedAt: null,
					supersededAt: null,
				},
			],
			hqTables: [],
			adoptTableIds: [],
		});
		/* Matched, it would carry the app row's `nova-created` claim by
		 * coincidence rather than by proof -- so the assertion is that this
		 * table is planned as a fresh create with no mapping behind it. */
		expect(plan.ok && plan.pushes).toEqual([
			{ tableId: DISTRICTS, tag: "districts", ownership: "nova-created" },
		]);
	});
});
