/**
 * One table's publish through CommCare HQ's JSON resources, over the real
 * destination ledger and journal in Postgres and a peer that answers as
 * `fixtures/resources/v0_1.py` and `v0_6.py` do: a table create refused at a
 * held tag and answered with no id, a row create appended at the table's
 * largest rank plus one whatever it is sent, a row update that writes the
 * rank it is sent, a delete of a missing row answered 404.
 *
 * The plausible failures: an unchanged table written again, a row matched by
 * its values, a request sent again whose first try landed, a row create
 * whose acknowledgement was lost adopted by its values, a ledger moved ahead
 * of its journal, two publishers of one table sending over each other's
 * plan, and a publish that ends with CommCare HQ's rows out of Nova's order.
 */

import { v7 } from "uuid";
import { describe, expect, it } from "vitest";
import type { CommCareApiError } from "@/lib/commcare/hq/http";
import type {
	HqLookupJsonDefinition,
	HqLookupJsonRow,
	HqLookupJsonWrite,
} from "@/lib/commcare/hq/lookupJson";
import type { HqLookupTable } from "@/lib/commcare/hq/lookupTables";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { createLookupTable } from "@/lib/lookup/service";
import {
	type LookupJsonHq,
	type LookupJsonJournal,
	type LookupJsonRemoteRow,
	publishLookupTableJson,
} from "../lookupJsonExecutor";
import {
	journalLookupJsonOperation,
	type LookupJsonDestinationKey,
	readLookupJsonDestination,
	settleLookupJsonOperationInTransaction,
} from "../lookupJsonLedger";
import {
	type HqLookupJsonContent,
	type LookupJsonLocalRow,
	lookupJsonRowDigest,
} from "../lookupJsonPlan";

const h = setupAppStateTestDb("lookup_json_");

const PROJECT = "project-json";
const ACTOR = "json-publisher";
const HOLD_MS = 6 * 60_000;

const DEFINITION: HqLookupJsonDefinition = {
	tag: "types",
	fields: [{ name: "name", properties: ["lang"] }],
	itemAttributes: ["code"],
};

function content(name: string): HqLookupJsonContent {
	/* Surrounding spaces and an empty value with a property: what the
	 * workbook's reader would trim or drop, and the JSON resources keep. */
	return {
		fields: {
			name: [
				{ value: ` ${name} `, properties: { lang: "en" } },
				{ value: "", properties: { lang: "fr" } },
			],
		},
		itemAttributes: { code: name },
	};
}

/** A fixed Nova row id per name, so a renamed row is the same row. */
const ids = new Map<string, string>();
function rowId(name: string): string {
	let id = ids.get(name);
	if (id === undefined) {
		id = v7();
		ids.set(name, id);
	}
	return id;
}
function rows(...names: string[]): LookupJsonLocalRow[] {
	return names.map((name) => ({
		novaRowId: rowId(name),
		content: content(name),
	}));
}
function renamed(row: string, to: string): LookupJsonLocalRow {
	return { novaRowId: rowId(row), content: content(to) };
}

type Fault = "lose-answer" | "lose-request" | "refuse";

/** CommCare HQ's lookup resources for one project space, as the source reads. */
class HqPeer implements LookupJsonHq {
	readonly tables = new Map<string, HqLookupTable>();
	readonly rows = new Map<
		string,
		{ tableId: string; sortKey: number; content: HqLookupJsonContent }
	>();
	readonly sent: string[] = [];
	/** The fault each next write meets, in order; absent is a plain answer. */
	readonly faults: (Fault | undefined)[] = [];
	private minted = 0;

	private mint(): string {
		this.minted++;
		return this.minted.toString(16).padStart(32, "0");
	}
	private refusal(status: number): CommCareApiError {
		return { success: false, status };
	}
	private async write<T>(
		label: string,
		apply: () => HqLookupJsonWrite<T>,
	): Promise<HqLookupJsonWrite<T>> {
		this.sent.push(label);
		const fault = this.faults.shift();
		if (fault === "refuse")
			return { kind: "not-applied", error: this.refusal(400) };
		if (fault === "lose-request")
			return {
				kind: "uncertain",
				error: { success: false, status: 503, cause: "timeout" },
			};
		const answer = apply();
		if (fault === "lose-answer" && answer.kind === "applied")
			return {
				kind: "uncertain",
				error: { success: false, status: 503, cause: "timeout" },
			};
		return answer;
	}

	async listTables() {
		return [...this.tables.values()];
	}
	private ordered(tableId: string): LookupJsonRemoteRow[] {
		return [...this.rows.entries()]
			.filter(([, row]) => row.tableId === tableId)
			.sort(
				([a, x], [b, y]) =>
					x.sortKey - y.sortKey || (a < b ? -1 : a > b ? 1 : 0),
			)
			.map(([id, row]) => ({
				id,
				sortKey: row.sortKey,
				digest: lookupJsonRowDigest(row.content),
			}));
	}
	async readRows(table: HqLookupTable) {
		return this.ordered(table.id);
	}
	async readRow(table: HqLookupTable, id: string) {
		return this.ordered(table.id).find((row) => row.id === id) ?? "missing";
	}
	createTable(definition: HqLookupJsonDefinition) {
		return this.write("POST table", () => {
			if ([...this.tables.values()].some((t) => t.tag === definition.tag))
				return { kind: "not-applied", error: this.refusal(400) };
			const id = this.mint();
			this.tables.set(id, {
				id,
				tag: definition.tag,
				isGlobal: true,
				fields: definition.fields.map((field) => field.name),
				fieldProperties: Object.fromEntries(
					definition.fields.map((field) => [field.name, field.properties]),
				),
				itemAttributes: definition.itemAttributes,
			});
			return { kind: "applied", value: true as const };
		});
	}
	createRow(tableId: string, row: HqLookupJsonRow) {
		return this.write("POST row", () => {
			if (!this.tables.has(tableId))
				return { kind: "not-applied", error: this.refusal(400) };
			const ranks = this.ordered(tableId).map((held) => held.sortKey);
			const sortKey = ranks.length === 0 ? 0 : Math.max(...ranks) + 1;
			const id = this.mint();
			this.rows.set(id, { tableId, sortKey, content: contentOf(row) });
			return { kind: "applied", value: { id, sortKey } };
		});
	}
	updateRow(tableId: string, rowId: string, row: HqLookupJsonRow) {
		return this.write(`PUT ${rowId.slice(-2)}@${row.sortKey}`, () => {
			if (!this.rows.has(rowId))
				return { kind: "not-applied", error: this.refusal(404) };
			this.rows.set(rowId, {
				tableId,
				sortKey: row.sortKey,
				content: contentOf(row),
			});
			return { kind: "applied", value: true as const };
		});
	}
	deleteRow(rowId: string) {
		return this.write(`DELETE ${rowId.slice(-2)}`, () => {
			if (!this.rows.delete(rowId))
				return { kind: "not-applied", error: this.refusal(404) };
			return { kind: "applied", value: true as const };
		});
	}
	/** Every row's id and name, in CommCare HQ's order. */
	view(): { id: string; name: string }[] {
		const table = [...this.tables.values()][0];
		if (table === undefined) return [];
		return this.ordered(table.id).map((row) => ({
			id: row.id,
			name: (
				this.rows.get(row.id)?.content.fields.name?.[0]?.value ?? ""
			).trim(),
		}));
	}
}

function contentOf(row: HqLookupJsonRow): HqLookupJsonContent {
	return { fields: row.fields, itemAttributes: row.itemAttributes };
}

async function seedTable(): Promise<LookupTableId> {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const table = await createLookupTable(
		{ projectId: PROJECT, actorId: ACTOR, role: "owner" },
		{
			name: "Types",
			tag: "types",
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		},
	);
	return table.id;
}

/**
 * The journal over the real ledger. Admission here journals only: the
 * deployment's admission (`store.ts::admitLookupJsonWrite`) adds the
 * Project fence and the publisher's authority, which the JSON cases of
 * `publishSequence.postgres.test.ts` hold.
 */
function journalFor(
	key: LookupJsonDestinationKey,
	appId = "app-one",
	hooks: { beforeAdmit?: () => Promise<void> } = {},
): LookupJsonJournal {
	return {
		read: () => readLookupJsonDestination(h.db(), key),
		async admit(entry, expectedRevision) {
			await hooks.beforeAdmit?.();
			const journaled = await h
				.db()
				.transaction()
				.execute((tx) =>
					journalLookupJsonOperation(tx, key, {
						expectedRevision,
						appId,
						actorUserId: ACTOR,
						entry,
					}),
				);
			return journaled.kind === "journaled"
				? {
						kind: "admitted",
						operationId: journaled.operationId,
						writeIds: [],
					}
				: journaled;
		},
		settle: (operationId, settlement) =>
			h
				.db()
				.transaction()
				.execute((tx) =>
					settleLookupJsonOperationInTransaction(
						tx,
						key,
						operationId,
						settlement,
					),
				),
	};
}

async function journalStates(): Promise<string[]> {
	const entries = await h
		.db()
		.selectFrom("lookup_json_operations")
		.select(["kind", "state"])
		.orderBy("admitted_at")
		.orderBy("id")
		.execute();
	return entries.map((entry) => `${entry.kind}:${entry.state}`);
}

async function setup() {
	const tableId = await seedTable();
	const key: LookupJsonDestinationKey = {
		projectId: PROJECT,
		server: "india",
		domain: "clinic",
		tableId,
	};
	return { key, hq: new HqPeer() };
}

function publish(
	hq: HqPeer,
	journal: LookupJsonJournal,
	local: readonly LookupJsonLocalRow[],
	now = Date.now,
) {
	return publishLookupTableJson({
		hq,
		journal,
		definition: DEFINITION,
		rows: local,
		holdMs: HOLD_MS,
		now,
	});
}

describe("a table published through CommCare HQ's JSON resources", () => {
	it("creates a table tagged types with its exact values, and a second publish from another app writes nothing", async () => {
		const { key, hq } = await setup();
		const first = await publish(hq, journalFor(key), rows("a", "b", "c"));
		expect(first).toMatchObject({ kind: "published", writes: 4 });
		expect(hq.sent).toEqual(["POST table", "POST row", "POST row", "POST row"]);
		expect(hq.view().map((row) => row.name)).toEqual(["a", "b", "c"]);
		/* The values CommCare HQ holds are Nova's, spaces and empty value kept. */
		const [held] = [...hq.rows.values()];
		expect(held?.content).toEqual(content("a"));

		const destination = await readLookupJsonDestination(h.db(), key);
		expect(destination.ledger?.rows.map((row) => row.remoteId)).toEqual(
			hq.view().map((row) => row.id),
		);
		expect(destination.open).toBeNull();

		hq.sent.length = 0;
		const second = await publish(
			hq,
			journalFor(key, "app-two"),
			rows("a", "b", "c"),
		);
		expect(second).toMatchObject({ kind: "published", writes: 0 });
		expect(hq.sent).toEqual([]);
		expect(await journalStates()).toEqual([
			"create-table:applied",
			"create-row:applied",
			"create-row:applied",
			"create-row:applied",
		]);
	});

	it("appends, changes, moves and removes rows by their ids, keeping every other row's id", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a", "b", "c", "d"));
		const before = new Map(hq.view().map((row) => [row.name, row.id]));
		hq.sent.length = 0;

		/* b removed, c renamed to c2, d moved before a, e appended. */
		const result = await publish(hq, journalFor(key), [
			...rows("d", "a"),
			renamed("c", "c2"),
			...rows("e"),
		]);
		expect(result).toMatchObject({ kind: "published" });
		expect(hq.view()).toEqual([
			{ id: before.get("d"), name: "d" },
			{ id: before.get("a"), name: "a" },
			{ id: before.get("c"), name: "c2" },
			{ id: expect.any(String), name: "e" },
		]);
		expect(hq.sent.filter((line) => line.startsWith("DELETE"))).toEqual([
			`DELETE ${before.get("b")?.slice(-2)}`,
		]);
		/* The append kept CommCare HQ's own rank, which already follows c2. */
		expect(hq.sent.filter((line) => line.startsWith("POST"))).toEqual([
			"POST row",
		]);

		hq.sent.length = 0;
		expect(
			await publish(hq, journalFor(key), [
				...rows("d", "a"),
				renamed("c", "c2"),
				...rows("e"),
			]),
		).toMatchObject({ kind: "published", writes: 0 });
		expect(hq.sent).toEqual([]);
	});

	it("moves an inserted row from CommCare HQ's appended rank to its place in Nova's order", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a", "c"));
		hq.sent.length = 0;
		/* No integer lies between a (0) and c (1): c moves out to a spaced
		 * rank first, then b is appended at CommCare HQ's 2049, after c, and
		 * moved back between them. */
		const result = await publish(hq, journalFor(key), rows("a", "b", "c"));
		expect(result).toMatchObject({ kind: "published", writes: 3 });
		expect(hq.sent).toEqual([
			expect.stringMatching(/^PUT ..@2048$/),
			"POST row",
			expect.stringMatching(/^PUT ..@1024$/),
		]);
		expect(hq.view().map((row) => row.name)).toEqual(["a", "b", "c"]);
	});

	it("settles an update whose answer was lost by reading the row, and goes on", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a", "b"));
		hq.sent.length = 0;
		hq.faults.push("lose-answer");
		const result = await publish(hq, journalFor(key), [
			renamed("a", "a2"),
			...rows("b"),
		]);
		expect(result).toMatchObject({ kind: "published", writes: 1 });
		expect(hq.view().map((row) => row.name)).toEqual(["a2", "b"]);
		expect((await journalStates()).at(-1)).toBe("update-row:applied");
	});

	it("waits on a lost request until it can no longer land, then sends it once more", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a"));
		hq.sent.length = 0;
		hq.faults.push("lose-request");
		const wanted = [renamed("a", "a2")];
		const stopped = await publish(hq, journalFor(key), wanted);
		expect(stopped).toMatchObject({
			kind: "stopped",
			stop: { kind: "unknown-outcome" },
		});
		/* Within the hold, a retry sends nothing over the open request. */
		expect(await publish(hq, journalFor(key), wanted)).toMatchObject({
			kind: "stopped",
			stop: { kind: "unknown-outcome" },
			writes: 0,
		});
		expect(hq.sent).toEqual([expect.stringMatching(/^PUT /)]);

		const later = () => Date.now() + HOLD_MS + 1;
		const resumed = await publish(hq, journalFor(key), wanted, later);
		expect(resumed).toMatchObject({ kind: "published", writes: 1 });
		expect(hq.view().map((row) => row.name)).toEqual(["a2"]);
		expect(await journalStates()).toEqual([
			"create-table:applied",
			"create-row:applied",
			"update-row:not-applied",
			"update-row:applied",
		]);
	});

	it("never adopts a row whose create was not acknowledged, however it looks", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a"));
		hq.sent.length = 0;
		hq.faults.push("lose-answer");
		const wanted = rows("a", "b");
		expect(await publish(hq, journalFor(key), wanted)).toMatchObject({
			kind: "stopped",
			stop: { kind: "unnamed-row" },
		});
		/* The row is there with exactly Nova's values, and it stays a stranger:
		 * the next publish, even long after, writes nothing over it. */
		expect(hq.view().map((row) => row.name)).toEqual(["a", "b"]);
		hq.sent.length = 0;
		expect(
			await publish(
				hq,
				journalFor(key),
				wanted,
				() => Date.now() + 2 * HOLD_MS,
			),
		).toMatchObject({
			kind: "stopped",
			stop: { kind: "unnamed-row" },
			writes: 0,
		});
		expect(hq.sent).toEqual([]);
		expect((await journalStates()).at(-1)).toBe("create-row:review");
	});

	it("settles a table create whose answer was lost by its tag", async () => {
		const { key, hq } = await setup();
		hq.faults.push("lose-answer");
		const result = await publish(hq, journalFor(key), rows("a"));
		expect(result).toMatchObject({ kind: "published", writes: 2 });
		expect(await journalStates()).toEqual([
			"create-table:applied",
			"create-row:applied",
		]);
	});

	it("resumes a publish stopped between an admission and its request exactly once", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a"));
		/* The process stops after journaling a delete, before sending it. */
		const destination = await readLookupJsonDestination(h.db(), key);
		const [held] = destination.ledger?.rows ?? [];
		if (held === undefined) throw new Error("expected a row");
		await h
			.db()
			.transaction()
			.execute((tx) =>
				journalLookupJsonOperation(tx, key, {
					expectedRevision: destination.revision,
					appId: "app-one",
					actorUserId: ACTOR,
					entry: {
						kind: "delete-row",
						rowId: held.novaRowId,
						remoteId: held.remoteId,
						before: { sortKey: held.sortKey, digest: held.digest },
					},
				}),
			);
		hq.sent.length = 0;
		expect(await publish(hq, journalFor(key), [])).toMatchObject({
			kind: "stopped",
			stop: { kind: "unknown-outcome" },
			writes: 0,
		});
		const later = () => Date.now() + HOLD_MS + 1;
		expect(await publish(hq, journalFor(key), [], later)).toMatchObject({
			kind: "published",
			writes: 1,
		});
		expect(hq.sent).toEqual([`DELETE ${held.remoteId.slice(-2)}`]);
		expect(hq.view()).toEqual([]);
	});

	it("writes nothing over a row changed in CommCare HQ since the ledger", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a", "b"));
		const [first] = hq.view();
		const edited = hq.rows.get(first?.id ?? "");
		if (edited === undefined) throw new Error("expected a row");
		hq.rows.set(first?.id ?? "", { ...edited, content: content("edited") });
		hq.sent.length = 0;
		expect(
			await publish(hq, journalFor(key), [renamed("a", "a2"), ...rows("b")]),
		).toMatchObject({
			kind: "stopped",
			stop: { kind: "review", reason: "rows-changed" },
			writes: 0,
		});
		expect(hq.sent).toEqual([]);
	});

	it("writes nothing over a row a person changes in CommCare HQ between two of Nova's requests", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a", "b"));
		const [first, second] = hq.view();
		hq.sent.length = 0;
		/* Nova renames both rows. Once its first request is admitted, a person
		 * edits the second row in CommCare HQ, after the plan read it. */
		let admissions = 0;
		const journal = journalFor(key, "app-one", {
			async beforeAdmit() {
				if (++admissions !== 2) return;
				const held = hq.rows.get(second?.id ?? "");
				if (held === undefined) throw new Error("expected a row");
				hq.rows.set(second?.id ?? "", { ...held, content: content("theirs") });
			},
		});
		/* The edit lands after the second admission's recheck, so it is seen by
		 * the read of the row just before its request. */
		const result = await publish(hq, journal, [
			renamed("a", "a2"),
			renamed("b", "b2"),
		]);
		expect(result).toMatchObject({
			kind: "stopped",
			stop: { kind: "review", reason: "rows-changed" },
			writes: 1,
		});
		expect(hq.sent.map((line) => line.split("@")[0])).toEqual([
			`PUT ${first?.id?.slice(-2)}`,
		]);
		expect(hq.view()).toEqual([
			{ id: first?.id, name: "a2" },
			{ id: second?.id, name: "theirs" },
		]);
	});

	it("stops at a request CommCare HQ refuses, and sends nothing after it", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a"));
		hq.sent.length = 0;
		hq.faults.push("refuse");
		expect(
			await publish(hq, journalFor(key), rows("a", "b", "c")),
		).toMatchObject({
			kind: "stopped",
			stop: { kind: "refused" },
			writes: 1,
		});
		expect(hq.sent).toEqual(["POST row"]);
		expect(
			await publish(hq, journalFor(key), rows("a", "b", "c")),
		).toMatchObject({
			kind: "published",
		});
		expect(hq.view().map((row) => row.name)).toEqual(["a", "b", "c"]);
	});

	it("makes the plan again where another publisher moved the ledger between the plan and the admission", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a"));
		let raced = false;
		const racing = journalFor(key, "app-one", {
			async beforeAdmit() {
				if (raced) return;
				raced = true;
				/* Another app of the Project publishes the same change first. */
				await publish(hq, journalFor(key, "app-two"), rows("a", "b"));
			},
		});
		hq.sent.length = 0;
		const result = await publish(hq, racing, rows("a", "b"));
		expect(result).toMatchObject({ kind: "published", writes: 0 });
		/* One row create, by the other publisher: no second copy of b. */
		expect(hq.sent).toEqual(["POST row"]);
		expect(hq.view().map((row) => row.name)).toEqual(["a", "b"]);
	});

	it("does not take a tag CommCare HQ already holds under another table", async () => {
		const { key, hq } = await setup();
		await hq.createTable(DEFINITION);
		hq.sent.length = 0;
		expect(await publish(hq, journalFor(key), rows("a"))).toMatchObject({
			kind: "stopped",
			stop: { kind: "review", reason: "tag-held-elsewhere" },
			writes: 0,
		});
		expect(hq.sent).toEqual([]);
	});

	it("puts a table given a new export tag there as a new table, and leaves the one under the old tag as it is", async () => {
		const { key, hq } = await setup();
		await publish(hq, journalFor(key), rows("a", "b"));
		const [old] = hq.tables.values();
		const oldRows = new Map(hq.rows);
		/* A column was added, which the old table can't take, and the table
		 * was given a new export tag. */
		const retagged: HqLookupJsonDefinition = {
			tag: "kinds",
			fields: [...DEFINITION.fields, { name: "note", properties: [] }],
			itemAttributes: DEFINITION.itemAttributes,
		};
		const local = rows("a", "b").map((row) => ({
			...row,
			content: {
				...row.content,
				fields: {
					...row.content.fields,
					note: [{ value: "", properties: {} }],
				},
			},
		}));
		const publishRetagged = (refuse = false) => {
			hq.sent.length = 0;
			if (refuse) hq.faults.push("refuse");
			return publishLookupTableJson({
				hq,
				journal: journalFor(key),
				definition: retagged,
				rows: local,
				holdMs: HOLD_MS,
			});
		};

		/* A create CommCare HQ refuses leaves the ledger of the old table. */
		expect(await publishRetagged(true)).toMatchObject({
			kind: "stopped",
			stop: { kind: "refused" },
			remoteTableId: null,
		});
		expect((await readLookupJsonDestination(h.db(), key)).ledger).toMatchObject(
			{
				remoteTableId: old?.id,
				tag: "types",
			},
		);

		const result = await publishRetagged();
		expect(result).toMatchObject({ kind: "published", writes: 3 });
		expect(hq.sent).toEqual(["POST table", "POST row", "POST row"]);
		const created = [...hq.tables.values()].find((t) => t.tag === "kinds");
		expect(result).toMatchObject({ remoteTableId: created?.id });
		/* The table under the old tag and its rows are untouched. */
		expect(hq.tables.get(old?.id ?? "")).toEqual(old);
		for (const [id, row] of oldRows) expect(hq.rows.get(id)).toEqual(row);
		const destination = await readLookupJsonDestination(h.db(), key);
		expect(destination.ledger).toMatchObject({
			remoteTableId: created?.id,
			tag: "kinds",
		});
		expect(
			destination.ledger?.rows.every(
				(row) => hq.rows.get(row.remoteId)?.tableId === created?.id,
			),
		).toBe(true);
		expect(destination.ledger?.rows).toHaveLength(2);

		/* And the next publish under the new tag writes nothing. */
		expect(await publishRetagged()).toMatchObject({
			kind: "published",
			writes: 0,
		});
	});

	it("keeps at most one open operation per destination", async () => {
		const { key } = await setup();
		const create = (expectedRevision: string | null) =>
			h
				.db()
				.transaction()
				.execute((tx) =>
					journalLookupJsonOperation(tx, key, {
						expectedRevision,
						appId: "app-one",
						actorUserId: ACTOR,
						entry: {
							kind: "create-table",
							tag: "types",
							definitionDigest: "a".repeat(64),
						},
					}),
				);
		expect(await create(null)).toMatchObject({ kind: "journaled" });
		expect(await create(null)).toEqual({ kind: "busy" });
	});
});
