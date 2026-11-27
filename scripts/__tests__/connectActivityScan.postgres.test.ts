/**
 * Contract: the read-only Connect scan reads each app still holding the
 * released shape (`connect_roles` NULL, `connect_type` and each form's
 * `connect` blocks in its stored rows) through the fold snapshot, converts it,
 * and reports whether the current document admits it, without writing. The
 * plausible failures: a released row read without its blocks or its role, a
 * converted row scanned again, a refused conversion reported as admitted, or
 * the scan leaving anything behind in the database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import {
	scanConnectActivities,
	summarizeConnectScan,
} from "../lib/connectActivityScan";

const h = setupAppStateTestDb("connect_activity_scan_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: "20261209000000_hq_round_trip_complete",
});

interface ReleasedFixture {
	readonly name: string;
	readonly released: {
		connectType: "learn" | "deliver" | null;
		forms: Record<
			string,
			{ connect?: Record<string, Record<string, unknown>> }
		>;
		[key: string]: unknown;
	};
}

const fixtures: readonly ReleasedFixture[] = JSON.parse(
	readFileSync(
		join(import.meta.dirname, "fixtures", "released-connect-3e16e43f.json"),
		"utf8",
	),
);

function fixture(name: string): ReleasedFixture["released"] {
	const found = fixtures.find((entry) => entry.name === name);
	if (!found) throw new Error(`Missing the ${name} fixture.`);
	return structuredClone(found.released);
}

/** Store the released document the way the released image stored it: its
 *  content in the current rows, then the role and each form's blocks put back
 *  into `apps.connect_type` and the form rows, with `connect_roles` unset. */
async function seedReleased(
	id: string,
	released: ReleasedFixture["released"],
): Promise<void> {
	const { connectType, ...rest } = released;
	const blocks = new Map<string, unknown>();
	const current = structuredClone(rest) as typeof rest & {
		connectRoles: string[];
	};
	for (const [uuid, form] of Object.entries(current.forms)) {
		if (form.connect !== undefined) blocks.set(uuid, form.connect);
		delete form.connect;
	}
	current.connectRoles = [];
	await h.seedAppWithBlueprint(
		hydratePersistedBlueprint(blueprintDocSchema.parse(current)),
		{ id, owner: "scan-owner", projectId: "scan-project" },
	);
	await sql`UPDATE public.apps SET connect_roles = NULL, connect_type = ${connectType}
		WHERE id = ${id}`.execute(h.db());
	for (const [uuid, connect] of blocks)
		await sql`UPDATE public.blueprint_entities
			SET data = data || jsonb_build_object('connect', ${JSON.stringify(connect)}::jsonb)
			WHERE app_id = ${id} AND uuid = ${uuid}::uuid`.execute(h.db());
}

describe("scanConnectActivities", () => {
	it("converts a released app in memory, counts its activities and writes nothing", async () => {
		await seedReleased("released-learn", fixture("learn-custom"));
		await seedReleased("released-deliver", fixture("deliver-default"));
		const before = await h.readAppRow("released-learn");

		const outcomes = await scanConnectActivities(h.db());
		expect(outcomes).toEqual([
			{
				appId: "released-deliver",
				projectId: "scan-project",
				deleted: false,
				outcome: "converted",
				roles: ["deliver"],
				activities: { delivery: 1, "assigned-task": 1 },
				runsOnlyOn: "android",
			},
			{
				appId: "released-learn",
				projectId: "scan-project",
				deleted: false,
				outcome: "converted",
				roles: ["learn"],
				activities: { "learning-module": 1, assessment: 1 },
				runsOnlyOn: "android",
			},
		]);
		expect(summarizeConnectScan(outcomes)).toEqual({
			unconverted: 2,
			converted: 2,
			conversionRefused: 0,
			schemaRefused: 0,
			gateRefused: 0,
			withRoles: 2,
			activities: {
				"learning-module": 1,
				assessment: 1,
				delivery: 1,
				"assigned-task": 1,
			},
			reasons: {},
		});
		expect(await h.readAppRow("released-learn")).toEqual(before);
		const { rows } = await sql<{ kinds: number }>`SELECT count(*)::int AS kinds
			FROM public.blueprint_entities
			WHERE data ->> 'kind' = 'connect_activity'`.execute(h.db());
		expect(rows[0].kinds).toBe(0);
	});

	it("scans released rows before the additive Connect column exists", async () => {
		await seedReleased("released-before-roles", fixture("learn-default"));
		await sql`ALTER TABLE public.apps RENAME COLUMN connect_roles TO held_connect_roles`.execute(
			h.db(),
		);
		try {
			expect(
				await scanConnectActivities(h.db(), "released-before-roles"),
			).toMatchObject([
				{
					appId: "released-before-roles",
					outcome: "converted",
					roles: ["learn"],
				},
			]);
		} finally {
			await sql`ALTER TABLE public.apps RENAME COLUMN held_connect_roles TO connect_roles`.execute(
				h.db(),
			);
		}
	});

	it("names what the current document refuses, by place, and skips a converted app", async () => {
		const released = fixture("learn-default");
		const [formUuid] = Object.keys(released.forms);
		const connect = released.forms[formUuid].connect;
		if (connect?.learn_module === undefined)
			throw new Error("Missing the learning module.");
		// The released schema took an empty module name; a unit needs one now.
		connect.learn_module.name = "";
		await seedReleased("unnamed-module", released);
		const { connectType: _released, ...absent } = fixture("absent");
		await h.seedAppWithBlueprint(
			hydratePersistedBlueprint(
				blueprintDocSchema.parse({ ...absent, connectRoles: [] }),
			),
			{
				id: "already-converted",
				owner: "scan-owner",
				projectId: "scan-project",
			},
		);

		const outcomes = await scanConnectActivities(h.db());
		expect(outcomes).toEqual([
			{
				appId: "unnamed-module",
				projectId: "scan-project",
				deleted: false,
				outcome: "schema-refused",
				reasons: ["too_small at fields.*.activity.name"],
			},
		]);
		expect(await scanConnectActivities(h.db(), "already-converted")).toEqual(
			[],
		);
	});
});
