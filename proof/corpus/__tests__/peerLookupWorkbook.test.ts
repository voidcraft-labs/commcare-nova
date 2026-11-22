import { describe, expect, it } from "vitest";
import { readSelectedHqLookupRows } from "@/lib/commcare/hq/lookupSource";
import {
	listHqLookupTables,
	uploadLookupTableWorkbook,
} from "@/lib/commcare/hq/lookupTables";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { buildLookupWorkbook } from "@/lib/commcare/lookup/workbook";
import { lookupRowIdSchema } from "@/lib/domain/lookupIds";
import { qualifiedLookupValues } from "@/proof/targeted/documents/qualifiedLookupValues";
import { hqAuthoredDocument, loadRetainedHqApp } from "../hqAuthored";
import { type TargetState, withTargetPeer } from "../targetPeer";

const credentials = {
	username: "publisher",
	apiKey: "synthetic-key",
	server: "production" as const,
};
const domain = "nova-proof";
const alice = { kind: "user" as const, name: "alice", id: "worker-a" };
const team = { kind: "group" as const, name: "North Team", id: "group-north" };
const state: TargetState = {
	credentials,
	domain,
	flags: new Set(),
	caseSearchEnabled: false,
	appId: "qualified",
	commcareVersion: "2.57.0",
	cloudcareGranted: false,
	lookupOwners: [alice, team],
};

describe("the fixture upload capture reads the workbook sent by Nova", () => {
	it("reads rich rows and approved owner identities without exposing those identities on the REST list", async () => {
		const snapshot = qualifiedLookupValues().lookup;
		if (!snapshot) throw Error("Expected the qualified lookup witness.");
		const definition = snapshot.definitions[0];
		const rows = snapshot.rowsByTable.get(definition.id);
		if (!rows) throw Error("Expected the qualified rows.");
		const table = {
			...definition,
			workerAccess: "assigned" as const,
			columns: definition.columns.map((c) => ({
				...c,
				index: "indexed" as const,
			})),
		};
		const naming = lookupWireNaming([table]);
		const owners = new Map([
			[
				table.id,
				new Map(
					rows.map((r, i) => [
						r.id,
						{
							users: i === 0 ? ["ALICE"] : [],
							groups: i === 1 ? ["North Team"] : [],
							locations: [],
						},
					]),
				),
			],
		]);
		await withTargetPeer(state, async (peer) => {
			const send = () =>
				uploadLookupTableWorkbook(
					credentials,
					domain,
					buildLookupWorkbook(naming, snapshot.rowsByTable, owners).bytes,
					{ replace: true },
				);
			expect(await send()).toMatchObject({ success: true });
			const stored = peer.snapshot().tables[0];
			expect(stored).toMatchObject({
				isGlobal: false,
				fields: [{ isIndexed: true }],
				rows: [{ owners: [alice] }, { owners: [team] }],
			});
			const listed = await listHqLookupTables(credentials, domain);
			if ("success" in listed) throw Error("Expected the native table list.");
			const read = await readSelectedHqLookupRows(
				credentials,
				domain,
				listed[0],
				{ maxRows: 10, maxBytes: 1_000_000 },
			);
			if ("success" in read || "kind" in read)
				throw Error(
					`Expected the selected rich row details: ${JSON.stringify(read)}; requests: ${JSON.stringify(peer.requests.map((r) => [r.method, r.path]))}`,
				);
			expect(read.rows.map((r) => r.itemAttributes)).toEqual([
				{ code: "north" },
				{ code: "east" },
			]);
			const col = table.columns[0].wireName;
			expect(read.rows.map((r) => r.fields[col])).toEqual([
				[
					{ value: "North", properties: { lang: "en" } },
					{ value: "Nord", properties: { lang: "fr" } },
				],
				[
					{ value: "East", properties: { lang: "en" } },
					{ value: "Est", properties: { lang: "fr" } },
				],
			]);
			expect(read.rows.every((r) => !Object.hasOwn(r, "owners"))).toBe(true);
			owners
				.get(table.id)
				?.set(rows[1].id, { users: [], groups: ["north team"], locations: [] });
			expect(await send()).toMatchObject({
				success: false,
				mayHaveLanded: true,
			});
			expect(peer.snapshot().tables[0].id).toBe(stored.id);
			expect(peer.snapshot().tables[0].rows[1].owners ?? []).toEqual([]);
			expect(peer.unexpected).toEqual([]);
		});
	});
});

it.each(["hq-expressions", "hq-lookups", "hq-search"])(
	"keeps %s's lookup data in the original project space during admission",
	async (id) => {
		const app = await hqAuthoredDocument(loadRetainedHqApp(id));
		expect(app.lookup?.definitions.length).toBeGreaterThan(0);
		for (const table of app.lookup?.definitions ?? []) {
			expect(table.hq?.managedBy).toBe("commcare-hq");
			for (const row of app.lookup?.rowsByTable.get(table.id) ?? [])
				expect(lookupRowIdSchema.safeParse(row.id).success).toBe(true);
			expect(table.hq?.source?.distribution).toBe("global");
			expect(table.columns.every((c) => c.index === "unobserved")).toBe(true);
		}
	},
);
