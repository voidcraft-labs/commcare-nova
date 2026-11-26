import "server-only";

/**
 * One publish of one lookup table through CommCare HQ's JSON resources: read
 * what CommCare HQ holds, plan the writes (`lookupJsonPlan.ts`), and send
 * them one request at a time, each journaled before it goes and settled when
 * its outcome is known (`lookupJsonLedger.ts`).
 *
 * Every request is admitted on its own (`LookupJsonJournal.admit`): the
 * admission takes the Project's lookup fence, rechecks that the publisher may
 * still write this table to this project space, and journals the operation,
 * all in one transaction. CommCare HQ checks no lookup permission on these
 * resources (`fixtures/resources/v0_1.py` overrides `obj_*` without calling
 * the resource's authorization), so that recheck is the only thing standing
 * between a person who lost the table and a write over it.
 *
 * Nothing is retried blind. A request whose outcome is unknown is settled by
 * reading the exact resource it named: a row update or delete by its id, a
 * table create by its tag (CommCare HQ holds a tag unique in a project space
 * and refuses a create at a held one), and a row create, whose id only its
 * acknowledgement carries, by looking for a row the ledger does not know. A
 * read that finds the intended result advances the ledger; one that finds the
 * state before the request, once the request can no longer land
 * (`holdMs`), lets it be sent again; anything else stops for a person. An
 * unacknowledged row create that left a row Nova cannot name is never
 * adopted by its values.
 */

import { HQ_LOOKUP_DETAIL_MAX_BYTES } from "@/lib/commcare/hq/bounds";
import type {
	CommCareApiError,
	CommCareCredentials,
} from "@/lib/commcare/hq/http";
import {
	checkHqLookupJsonWrite,
	createHqLookupRowJson,
	createHqLookupTableJson,
	deleteHqLookupRowJson,
	type HqLookupJsonDefinition,
	type HqLookupJsonRow,
	type HqLookupJsonWrite,
	updateHqLookupRowJson,
} from "@/lib/commcare/hq/lookupJson";
import {
	readSelectedLookupDetails,
	streamHqLookupTable,
} from "@/lib/commcare/hq/lookupSource";
import {
	type HqFixtureRow,
	type HqLookupTable,
	listHqLookupTables,
} from "@/lib/commcare/hq/lookupTables";
import { log } from "@/lib/logger";
import type {
	LookupJsonDestination,
	LookupJsonJournalEntry,
	LookupJsonOpenOperation,
	LookupJsonSettlement,
} from "./lookupJsonLedger";
import { lookupJsonJournalEntry } from "./lookupJsonLedger";
import {
	type HqLookupJsonContent,
	type LookupJsonLocalRow,
	type LookupJsonOperation,
	type LookupJsonRemote,
	type LookupJsonReviewReason,
	lookupJsonDefinitionDigest,
	lookupJsonRowDigest,
	planLookupJsonPublish,
} from "./lookupJsonPlan";

/** One row of CommCare HQ's table, by its id, rank and content digest. */
export interface LookupJsonRemoteRow {
	readonly id: string;
	readonly sortKey: number;
	readonly digest: string;
}

/** CommCare HQ, as the executor reads and writes it. Production: `hqLookupJsonPort`. */
export interface LookupJsonHq {
	listTables(): Promise<readonly HqLookupTable[] | CommCareApiError>;
	/** Every row of `table`, each read whole, in CommCare HQ's order. */
	readRows(
		table: HqLookupTable,
	): Promise<readonly LookupJsonRemoteRow[] | CommCareApiError>;
	readRow(
		table: HqLookupTable,
		id: string,
	): Promise<LookupJsonRemoteRow | "missing" | CommCareApiError>;
	createTable(
		definition: HqLookupJsonDefinition,
	): Promise<HqLookupJsonWrite<true>>;
	createRow(
		tableId: string,
		row: HqLookupJsonRow,
	): Promise<
		HqLookupJsonWrite<{ readonly id: string; readonly sortKey: number }>
	>;
	updateRow(
		tableId: string,
		rowId: string,
		row: HqLookupJsonRow,
	): Promise<HqLookupJsonWrite<true>>;
	deleteRow(rowId: string): Promise<HqLookupJsonWrite<true>>;
}

/** Why an admission sent nothing. */
export type LookupJsonAdmissionRefusal =
	/** The table was handed back to CommCare HQ on this project space. */
	| "handed-back"
	/** The table, its rows or the publisher's standing changed since the plan. */
	| "changed";

/** The destination's journal, behind the admission that rechecks Nova's authority. */
export interface LookupJsonJournal {
	read(): Promise<LookupJsonDestination>;
	/**
	 * In one transaction: take the Project's lookup fence, recheck the
	 * publisher's authority over this table and project space, and journal
	 * `entry` over the ledger at `expectedRevision`.
	 */
	admit(
		entry: LookupJsonJournalEntry,
		expectedRevision: string | null,
	): Promise<
		| {
				readonly kind: "admitted";
				readonly operationId: string;
				readonly writeIds: readonly string[];
		  }
		| { readonly kind: "stale" }
		| { readonly kind: "busy" }
		| { readonly kind: "refused"; readonly reason: LookupJsonAdmissionRefusal }
	>;
	/** Settle an operation, its remote writes with it. Answers the destination's revision. */
	settle(
		operationId: string,
		settlement: LookupJsonSettlement,
		writes: {
			readonly writeIds: readonly string[];
			readonly answered: boolean;
		},
	): Promise<string>;
}

/** Why a publish of the table stopped before CommCare HQ held it as Nova does. */
export type LookupJsonStop =
	| { readonly kind: "review"; readonly reason: LookupJsonReviewReason }
	/** CommCare HQ refused a request before it could write. */
	| { readonly kind: "refused"; readonly error: CommCareApiError }
	/** A request's outcome is still unknown; it may yet land. */
	| { readonly kind: "unknown-outcome" }
	/** A request's outcome read as neither before nor after: a person must look. */
	| { readonly kind: "unexpected-outcome" }
	/** A row create left a row Nova cannot name. */
	| { readonly kind: "unnamed-row" }
	| { readonly kind: "read-failed"; readonly error: CommCareApiError }
	/** Another publish of this table is writing. */
	| { readonly kind: "busy" }
	| { readonly kind: "checkpoint" }
	| { readonly kind: "admission"; readonly reason: LookupJsonAdmissionRefusal }
	/** The table CommCare HQ holds after the writes is not the ledger's. */
	| { readonly kind: "not-verified" };

export type LookupJsonPublishResult =
	| {
			readonly kind: "published";
			readonly remoteTableId: string;
			/** Requests this call sent: zero for a table CommCare HQ already held as Nova does. */
			readonly writes: number;
	  }
	| {
			readonly kind: "stopped";
			readonly stop: LookupJsonStop;
			readonly remoteTableId: string | null;
			readonly writes: number;
	  };

export interface LookupJsonPublishInput {
	readonly hq: LookupJsonHq;
	readonly journal: LookupJsonJournal;
	readonly definition: HqLookupJsonDefinition;
	/** Every row of Nova's table, in Nova's order. */
	readonly rows: readonly LookupJsonLocalRow[];
	/** How long after its admission a request can no longer land. */
	readonly holdMs: number;
	readonly now?: () => number;
	/** Paged publishes yield only between settled operations. */
	readonly writeBudget?: { readonly requests: number; readonly until: number };
}

/** How many times a plan is made again because another publisher moved the ledger. */
const REPLANS = 3;

function definitionOf(table: HqLookupTable): HqLookupJsonDefinition {
	return {
		tag: table.tag,
		fields: table.fields.map((name) => ({
			name,
			properties: table.fieldProperties[name] ?? [],
		})),
		itemAttributes: table.itemAttributes,
	};
}

function stopped(
	stop: LookupJsonStop,
	remoteTableId: string | null,
	writes: number,
): LookupJsonPublishResult {
	return { kind: "stopped", stop, remoteTableId, writes };
}

/** Make CommCare HQ's table the one Nova holds, or say exactly why not. */
export async function publishLookupTableJson(
	input: LookupJsonPublishInput,
): Promise<LookupJsonPublishResult> {
	const { hq, journal, definition, rows } = input;
	const now = input.now ?? Date.now;
	const definitionDigest = lookupJsonDefinitionDigest(definition);
	let writes = 0;
	let remoteTableId: string | null = null;

	/* The ledger this publish writes over: none where Nova's table has a new
	 * export tag since, which goes there as a new table and leaves the one
	 * under the old tag as it is. */
	const ledgerOf = (destination: LookupJsonDestination) =>
		destination.ledger?.tag === definition.tag ? destination.ledger : null;

	for (let attempt = 0; attempt <= REPLANS; attempt++) {
		let destination = await journal.read();
		remoteTableId = ledgerOf(destination)?.remoteTableId ?? null;

		/* An operation an earlier run left open is settled first, by reading
		 * what it named. Until it is, nothing else is sent for this table. */
		if (destination.open !== null) {
			const settled = await settleOpen(
				hq,
				journal,
				destination,
				destination.open,
				{ writeIds: [], answered: true },
				now,
				input.holdMs,
			);
			if (settled !== null) return stopped(settled, remoteTableId, writes);
			destination = await journal.read();
			remoteTableId = ledgerOf(destination)?.remoteTableId ?? null;
		}

		const tables = await hq.listTables();
		if ("success" in tables)
			return stopped(
				{ kind: "read-failed", error: tables },
				remoteTableId,
				writes,
			);
		const ledger = ledgerOf(destination);
		const held =
			ledger === null
				? tables.find((table) => table.tag === definition.tag)
				: (tables.find((table) => table.id === ledger.remoteTableId) ??
					tables.find((table) => table.tag === definition.tag));
		let remote: LookupJsonRemote | null = null;
		if (held !== undefined) {
			/* With no ledger the tag alone decides (`tag-held-elsewhere`), and
			 * the rows of a table Nova cannot account for are not read. */
			const remoteRows = ledger === null ? [] : await hq.readRows(held);
			if ("success" in remoteRows)
				return stopped(
					{ kind: "read-failed", error: remoteRows },
					remoteTableId,
					writes,
				);
			remote = {
				id: held.id,
				tag: held.tag,
				isGlobal: held.isGlobal,
				definitionDigest: lookupJsonDefinitionDigest(definitionOf(held)),
				rows: remoteRows,
			};
		}

		const plan = planLookupJsonPublish({ definition, rows, ledger, remote });
		if (plan.kind === "review")
			return stopped(
				{ kind: "review", reason: plan.reason },
				remoteTableId,
				writes,
			);
		if (plan.operations.length === 0 && ledger !== null)
			return { kind: "published", remoteTableId: ledger.remoteTableId, writes };

		const ran = await runOperations({
			hq,
			journal,
			definitionDigest,
			operations: plan.operations,
			revision: destination.revision,
			remoteTableId,
			table: held ?? null,
			order: rows.map((row) => row.novaRowId),
			ledgerRanks: new Map(
				(ledger?.rows ?? []).map((row) => [row.novaRowId, row.sortKey]),
			),
			holdMs: input.holdMs,
			now,
			canWrite: (inRun) =>
				input.writeBudget === undefined ||
				(writes + inRun < input.writeBudget.requests &&
					now() < input.writeBudget.until),
		});
		writes += ran.writes;
		remoteTableId = ran.remoteTableId;
		if (ran.kind === "replan") continue;
		if (ran.kind === "stopped") return stopped(ran.stop, remoteTableId, writes);

		/* Every write landed. CommCare HQ's table must now be exactly the
		 * ledger's, each row at its rank in Nova's order. */
		const verified = await verify(hq, journal, rows);
		if (verified.kind !== "verified")
			return stopped(verified.stop, verified.remoteTableId, writes);
		return { kind: "published", remoteTableId: verified.remoteTableId, writes };
	}
	return stopped({ kind: "busy" }, remoteTableId, writes);
}

type RunResult =
	| { kind: "done"; writes: number; remoteTableId: string | null }
	| { kind: "replan"; writes: number; remoteTableId: string | null }
	| {
			kind: "stopped";
			stop: LookupJsonStop;
			writes: number;
			remoteTableId: string | null;
	  };

async function runOperations(input: {
	readonly hq: LookupJsonHq;
	readonly journal: LookupJsonJournal;
	readonly definitionDigest: string;
	readonly operations: readonly LookupJsonOperation[];
	readonly revision: string | null;
	readonly remoteTableId: string | null;
	/** CommCare HQ's table the plan read, null before a create makes it. */
	readonly table: HqLookupTable | null;
	/** Nova's row order. */
	readonly order: readonly string[];
	/** Each kept row's rank before this run. */
	readonly ledgerRanks: ReadonlyMap<string, number>;
	readonly holdMs: number;
	readonly now: () => number;
	readonly canWrite: (writes: number) => boolean;
}): Promise<RunResult> {
	const { hq, journal } = input;
	let revision = input.revision;
	let remoteTableId = input.remoteTableId;
	let table = input.table;
	let writes = 0;
	const digestOf = (operation: LookupJsonOperation) =>
		operation.kind === "create-row" || operation.kind === "update-row"
			? lookupJsonRowDigest(contentOf(operation.row))
			: "";
	/* The rank each row holds once this run is through: planned for a row
	 * still to be written, CommCare HQ's for a row it created. */
	const finalRank = new Map<string, number>(input.ledgerRanks);
	for (const operation of input.operations)
		if (operation.kind === "create-row" || operation.kind === "update-row")
			finalRank.set(operation.novaRowId, operation.row.sortKey);
	const position = new Map(input.order.map((id, index) => [id, index]));
	let index = 0;
	let adjustment: LookupJsonOperation | undefined;
	while (adjustment || index < input.operations.length) {
		if (!input.canWrite(writes))
			return {
				kind: "stopped",
				stop: { kind: "checkpoint" },
				writes,
				remoteTableId,
			};
		const operation = adjustment ?? input.operations[index++];
		adjustment = undefined;
		const entry = lookupJsonJournalEntry(
			operation,
			digestOf,
			input.definitionDigest,
		);
		const admission = await journal.admit(entry, revision);
		if (admission.kind === "stale")
			return { kind: "replan", writes, remoteTableId };
		if (admission.kind === "busy")
			return { kind: "stopped", stop: { kind: "busy" }, writes, remoteTableId };
		if (admission.kind === "refused")
			return {
				kind: "stopped",
				stop: { kind: "admission", reason: admission.reason },
				writes,
				remoteTableId,
			};
		/* A row an update or delete names is read again once its request is
		 * admitted and just before it goes: a person may have changed the row
		 * in CommCare HQ since the plan read the table, and CommCare HQ's row
		 * resource writes whatever it is sent, with no precondition of its
		 * own, so a full PUT would put Nova's row over that change. A row no
		 * longer as the ledger holds it settles the request unsent and stops
		 * the table for a person. */
		if (operation.kind === "update-row" || operation.kind === "delete-row") {
			if (table === null)
				throw new Error("A row write was planned before its table was found.");
			const current = await hq.readRow(table, operation.remoteId);
			const changed =
				current === "missing" ||
				("success" in current
					? null
					: current.sortKey !== operation.before.sortKey ||
						current.digest !== operation.before.digest);
			if (changed !== false) {
				await journal.settle(
					admission.operationId,
					{ kind: "not-applied" },
					{ writeIds: admission.writeIds, answered: true },
				);
				return {
					kind: "stopped",
					stop:
						current !== "missing" && "success" in current
							? { kind: "read-failed", error: current }
							: { kind: "review", reason: "rows-changed" },
					writes,
					remoteTableId,
				};
			}
		}
		writes++;
		const outcome = await send(hq, operation, remoteTableId);
		const answered = outcome.kind !== "uncertain";
		const writeIds = admission.writeIds;

		if (outcome.kind === "not-applied") {
			await journal.settle(
				admission.operationId,
				{ kind: "not-applied" },
				{ writeIds, answered },
			);
			return {
				kind: "stopped",
				stop: { kind: "refused", error: outcome.error },
				writes,
				remoteTableId,
			};
		}

		if (operation.kind === "create-table" && outcome.kind === "applied") {
			/* The create's 201 names no table: the tag finds it. Where it does
			 * not, the operation stays open and the read below settles it. */
			const tables = await hq.listTables();
			const found =
				"success" in tables
					? undefined
					: tables.find(
							(candidate) => candidate.tag === operation.definition.tag,
						);
			if (
				found?.isGlobal &&
				lookupJsonDefinitionDigest(definitionOf(found)) ===
					input.definitionDigest
			) {
				revision = await journal.settle(
					admission.operationId,
					{ kind: "applied", remoteId: found.id },
					{ writeIds, answered },
				);
				remoteTableId = found.id;
				table = found;
				continue;
			}
		}

		if (outcome.kind === "uncertain" || operation.kind === "create-table") {
			revision = await journal.settle(
				admission.operationId,
				{ kind: "uncertain" },
				{ writeIds, answered },
			);
			const destination = await journal.read();
			if (destination.open === null)
				throw new Error("An uncertain JSON operation was not left open.");
			const settled = await settleOpen(
				hq,
				journal,
				destination,
				destination.open,
				{ writeIds: [], answered: false },
				input.now,
				input.holdMs,
			);
			if (settled !== null)
				return { kind: "stopped", stop: settled, writes, remoteTableId };
			/* The read found it landed. The rest of the plan rests on the new
			 * revision, so it is made again over the ledger as it now stands. */
			return { kind: "replan", writes, remoteTableId };
		}

		if (operation.kind === "create-row") {
			const created = outcome.value as { id: string; sortKey: number };
			revision = await journal.settle(
				admission.operationId,
				{ kind: "applied", remoteId: created.id, sortKey: created.sortKey },
				{ writeIds, answered },
			);
			/* CommCare HQ appended the row at its own rank. Where that rank
			 * breaks Nova's order between the row's neighbours, the row is
			 * moved to the rank the plan chose, with the same full PUT. */
			const at = position.get(operation.novaRowId) as number;
			const lower = neighbourRank(input.order, finalRank, at, -1);
			const upper = neighbourRank(input.order, finalRank, at, 1);
			if (
				(lower === undefined || lower < created.sortKey) &&
				(upper === undefined || created.sortKey < upper)
			) {
				finalRank.set(operation.novaRowId, created.sortKey);
				continue;
			}
			adjustment = {
				kind: "update-row",
				novaRowId: operation.novaRowId,
				remoteId: created.id,
				row: operation.row,
				before: {
					sortKey: created.sortKey,
					digest: lookupJsonRowDigest(contentOf(operation.row)),
				},
			};
			continue;
		}

		revision = await journal.settle(
			admission.operationId,
			{ kind: "applied" },
			{ writeIds, answered },
		);
	}
	return { kind: "done", writes, remoteTableId };
}

/** The final rank of the nearest row before (`step` -1) or after (+1) position `at`. */
function neighbourRank(
	order: readonly string[],
	ranks: ReadonlyMap<string, number>,
	at: number,
	step: -1 | 1,
): number | undefined {
	const next = order[at + step];
	return next === undefined ? undefined : ranks.get(next);
}

function contentOf(row: HqLookupJsonRow): HqLookupJsonContent {
	return { fields: row.fields, itemAttributes: row.itemAttributes };
}

async function send(
	hq: LookupJsonHq,
	operation: LookupJsonOperation,
	remoteTableId: string | null,
): Promise<HqLookupJsonWrite<unknown>> {
	if (operation.kind === "create-table")
		return hq.createTable(operation.definition);
	if (remoteTableId === null)
		throw new Error("A row write was planned before its table was found.");
	switch (operation.kind) {
		case "create-row":
			return hq.createRow(remoteTableId, operation.row);
		case "update-row":
			return hq.updateRow(remoteTableId, operation.remoteId, operation.row);
		case "delete-row":
			return hq.deleteRow(operation.remoteId);
	}
}

/**
 * Settle an open operation by reading what it named. Null where it settled
 * (applied, or not applied once it can no longer land); otherwise why the
 * table waits.
 */
async function settleOpen(
	hq: LookupJsonHq,
	journal: LookupJsonJournal,
	destination: LookupJsonDestination,
	open: LookupJsonOpenOperation,
	writes: { readonly writeIds: readonly string[]; readonly answered: boolean },
	now: () => number,
	holdMs: number,
): Promise<LookupJsonStop | null> {
	const landedNoLonger = now() >= open.admittedAt.getTime() + holdMs;
	const settle = async (settlement: LookupJsonSettlement) => {
		await journal.settle(open.id, settlement, writes);
	};
	const notYet = async (): Promise<LookupJsonStop | null> => {
		if (!landedNoLonger) return { kind: "unknown-outcome" };
		await settle({ kind: "not-applied" });
		return null;
	};
	const tables = await hq.listTables();
	if ("success" in tables) return { kind: "read-failed", error: tables };

	if (open.kind === "create-table") {
		const found = tables.find((table) => table.tag === open.tag);
		if (found === undefined) return notYet();
		if (
			found.isGlobal &&
			lookupJsonDefinitionDigest(definitionOf(found)) === open.definitionDigest
		) {
			await settle({ kind: "applied", remoteId: found.id });
			return null;
		}
		await settle({ kind: "review" });
		return { kind: "unexpected-outcome" };
	}

	const ledger = destination.ledger;
	const table =
		ledger === null
			? undefined
			: tables.find((candidate) => candidate.id === ledger.remoteTableId);
	if (ledger === null || table === undefined) {
		await settle({ kind: "review" });
		return { kind: "review", reason: "table-moved" };
	}

	if (open.kind === "create-row") {
		const rows = await hq.readRows(table);
		if ("success" in rows) return { kind: "read-failed", error: rows };
		const known = new Set(ledger.rows.map((row) => row.remoteId));
		const strangers = rows.filter((row) => !known.has(row.id));
		if (strangers.length === 0) return notYet();
		/* A row Nova did not acknowledge. Its values might be the ones Nova
		 * sent, but a value never identifies a row, so a person decides. */
		await settle({ kind: "review" });
		return { kind: "unnamed-row" };
	}

	const row = await hq.readRow(table, open.remoteId);
	if (row !== "missing" && "success" in row)
		return { kind: "read-failed", error: row };
	if (open.kind === "delete-row") {
		if (row === "missing") {
			await settle({ kind: "applied" });
			return null;
		}
		if (
			row.sortKey === open.before.sortKey &&
			row.digest === open.before.digest
		)
			return notYet();
		await settle({ kind: "review" });
		return { kind: "unexpected-outcome" };
	}
	/* update-row */
	if (row === "missing") {
		await settle({ kind: "review" });
		return { kind: "review", reason: "rows-changed" };
	}
	if (row.sortKey === open.sortKey && row.digest === open.digest) {
		await settle({ kind: "applied" });
		return null;
	}
	if (row.sortKey === open.before.sortKey && row.digest === open.before.digest)
		return notYet();
	await settle({ kind: "review" });
	return { kind: "unexpected-outcome" };
}

/** Read the table back whole and hold it to the ledger and to Nova's order. */
async function verify(
	hq: LookupJsonHq,
	journal: LookupJsonJournal,
	rows: readonly LookupJsonLocalRow[],
): Promise<
	| { kind: "verified"; remoteTableId: string }
	| { kind: "failed"; stop: LookupJsonStop; remoteTableId: string | null }
> {
	const destination = await journal.read();
	const ledger = destination.ledger;
	if (ledger === null)
		return {
			kind: "failed",
			stop: { kind: "not-verified" },
			remoteTableId: null,
		};
	const tables = await hq.listTables();
	if ("success" in tables)
		return {
			kind: "failed",
			stop: { kind: "read-failed", error: tables },
			remoteTableId: ledger.remoteTableId,
		};
	const table = tables.find(
		(candidate) => candidate.id === ledger.remoteTableId,
	);
	const remoteRows = table === undefined ? null : await hq.readRows(table);
	if (remoteRows !== null && "success" in remoteRows)
		return {
			kind: "failed",
			stop: { kind: "read-failed", error: remoteRows },
			remoteTableId: ledger.remoteTableId,
		};
	const byRow = new Map(ledger.rows.map((row) => [row.novaRowId, row]));
	const expected = rows.map((row) => {
		const held = byRow.get(row.novaRowId);
		return held === undefined ||
			held.digest !== lookupJsonRowDigest(row.content)
			? null
			: held;
	});
	const matches =
		table !== undefined &&
		remoteRows !== null &&
		ledger.rows.length === rows.length &&
		remoteRows.length === rows.length &&
		expected.every(
			(held, index) =>
				held !== null &&
				remoteRows[index]?.id === held.remoteId &&
				remoteRows[index]?.sortKey === held.sortKey &&
				remoteRows[index]?.digest === held.digest &&
				(index === 0 ||
					(remoteRows[index - 1] as LookupJsonRemoteRow).sortKey <
						held.sortKey),
		);
	if (!matches) {
		log.error(
			"[deployment] lookup table JSON publish did not verify",
			undefined,
			{
				rows: rows.length,
				remoteRows: remoteRows?.length ?? null,
			},
		);
		return {
			kind: "failed",
			stop: { kind: "not-verified" },
			remoteTableId: ledger.remoteTableId,
		};
	}
	return { kind: "verified", remoteTableId: ledger.remoteTableId };
}

// ── Production ───────────────────────────────────────────────────────

/** How much one whole-table read may take of CommCare HQ: per row, two passes. */
const READ_BYTES_PER_ROW = 4 * 1024;
const READ_DEADLINE_MS = 10 * 60_000;

function remoteRowOf(row: HqFixtureRow): LookupJsonRemoteRow | null {
	if (row.sortKey === undefined || row.itemAttributes === undefined)
		return null;
	const fields = Object.entries(row.fields);
	if (fields.some(([, values]) => typeof values === "string")) return null;
	return {
		id: row.id,
		sortKey: row.sortKey,
		digest: lookupJsonRowDigest({
			fields: row.fields as HqLookupJsonContent["fields"],
			itemAttributes: row.itemAttributes,
		}),
	};
}

/**
 * CommCare HQ through Nova's client: the table list, each row read in full
 * by its detail (`lookupSource.ts::streamHqLookupTable` with every detail,
 * twice over, so a table that moved while it was read is no answer), and the
 * JSON writer (`lookupJson.ts`). `expectedRows` bounds the read's work.
 */
export function hqLookupJsonPort(
	creds: CommCareCredentials,
	domain: string,
	expectedRows: number,
	cancel?: AbortSignal,
	expectedBytes = 0,
): LookupJsonHq {
	const rowsBound = Math.max(expectedRows, 1) * 2 + 1_000;
	const write = async <T>(
		send: () => Promise<HqLookupJsonWrite<T>>,
	): Promise<HqLookupJsonWrite<T>> => {
		const access = await checkHqLookupJsonWrite(creds, domain, cancel);
		return access === "confirmed"
			? send()
			: {
					kind: "not-applied",
					error: { success: false, status: access === "denied" ? 403 : 503 },
				};
	};
	return {
		listTables: () => listHqLookupTables(creds, domain, { cancel }),
		async readRows(table) {
			const rows: LookupJsonRemoteRow[] = [];
			let malformed = false;
			const read = await streamHqLookupTable(
				creds,
				domain,
				table,
				{
					cancel,
					maxBytes: (rowsBound * READ_BYTES_PER_ROW + expectedBytes * 2) * 2,
					maxRequests: rowsBound * 2 + 100,
					deadlineMs: READ_DEADLINE_MS,
					stage: async (page) => {
						for (const row of page.rows) {
							const remote = remoteRowOf(row);
							if (remote === null) malformed = true;
							else rows.push(remote);
						}
						return !malformed;
					},
				},
				true,
			);
			if ("success" in read) return read;
			if (malformed || rows.length !== read.totalCount)
				return { success: false, status: 502, cause: "malformed" };
			return rows;
		},
		async readRow(table, id) {
			const read = await readSelectedLookupDetails(
				creds,
				domain,
				table,
				[id],
				HQ_LOOKUP_DETAIL_MAX_BYTES,
				cancel,
			);
			if ("success" in read)
				return read.status === 404 && !read.edgeRefusal ? "missing" : read;
			const [row] = read.rows;
			const remote = row === undefined ? null : remoteRowOf(row);
			return remote ?? { success: false, status: 502, cause: "malformed" };
		},
		createTable: (definition) =>
			write(() => createHqLookupTableJson(creds, domain, definition, cancel)),
		createRow: (tableId, row) =>
			write(() => createHqLookupRowJson(creds, domain, tableId, row, cancel)),
		updateRow: (tableId, rowId, row) =>
			write(() =>
				updateHqLookupRowJson(creds, domain, tableId, rowId, row, cancel),
			),
		deleteRow: (rowId) =>
			write(() => deleteHqLookupRowJson(creds, domain, rowId, cancel)),
	};
}
