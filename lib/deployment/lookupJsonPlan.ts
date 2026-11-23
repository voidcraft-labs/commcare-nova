/**
 * The writes one publish of a table through CommCare HQ's JSON resources
 * makes, decided from three facts and nothing else: the table Nova holds, the
 * destination ledger of what Nova last put there, and CommCare HQ's table as
 * read just before (`lib/commcare/hq/lookupJson.ts` is the carrier).
 *
 * Pure. Identity is the ledger's mapping of a Nova row UUID to the row id
 * CommCare HQ minted for it, never a value or a rank: two rows that look the
 * same are two rows, and a row whose values match a stranger's is not
 * adopted. A rank is only order.
 *
 * What it refuses to plan, and answers `review` for instead, is every state
 * where a write could overwrite something Nova did not put there or cannot
 * account for: a tag another table holds, a held table moved or recreated,
 * a table CommCare HQ restricts to some workers, a definition or a row
 * changed in CommCare HQ since the ledger, a row the ledger does not know,
 * and a schema change over rows that already reach workers, whose
 * intermediate states a run of separate REST commits cannot keep usable.
 *
 * A plan sends nothing for a table already as Nova holds it. Otherwise its
 * operations go in this order, one request each: the table's create or its
 * definition's update; the deletes of rows Nova removed; the full PUT of each
 * kept row whose values or rank changed; then the appends of new rows. Every
 * row gets a distinct integer rank in Nova's order, keeping the rank of the
 * longest run of kept rows already in order, and the ranks it chooses are
 * `RANK_STEP` apart where they fit, so a move or an insert rewrites the moved
 * or new row alone where its neighbours left room, and otherwise also the
 * kept rows after it, up to the first whose rank leaves room. `LookupTableItemResource.obj_create` gives an appended row the
 * table's largest rank plus one whatever it is sent; a create's `sortKey` is
 * the rank the plan wants, and the executor moves the row there with a PUT
 * where CommCare HQ chose another.
 */

import type {
	HqLookupJsonDefinition,
	HqLookupJsonRow,
} from "@/lib/commcare/hq/lookupJson";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/** The lowest and highest rank `LookupTableRow.sort_key`, a Postgres `integer`, holds. */
const RANK_FLOOR = 0;
const RANK_CEILING = 2_147_483_647;

/**
 * How far apart the plan puts the ranks it chooses, where they fit: a later
 * insert or move between two of them then takes a free rank and rewrites no
 * neighbour. 2^31 / 1024 leaves room for two million rows so spaced.
 */
export const RANK_STEP = 1024;

/** A row's content as the JSON resource carries it, without its rank. */
export type HqLookupJsonContent = Omit<HqLookupJsonRow, "sortKey">;

/** The digest the ledger, the plan and a read-back compare a row's content by. */
export function lookupJsonRowDigest(content: HqLookupJsonContent): string {
	return canonicalJsonDigest({
		fields: content.fields,
		itemAttributes: content.itemAttributes,
	});
}

/** The digest of a definition, as the ledger records it. */
export function lookupJsonDefinitionDigest(
	definition: HqLookupJsonDefinition,
): string {
	return canonicalJsonDigest({
		tag: definition.tag,
		fields: definition.fields,
		itemAttributes: definition.itemAttributes,
	});
}

/** One row of the table Nova holds, in Nova's order. */
export interface LookupJsonLocalRow {
	readonly novaRowId: string;
	readonly content: HqLookupJsonContent;
}

/** What the ledger recorded of one row after its last acknowledged write. */
export interface LookupJsonLedgerRow {
	readonly novaRowId: string;
	readonly remoteId: string;
	readonly sortKey: number;
	readonly digest: string;
}

/** The destination ledger of one table on one project space. */
export interface LookupJsonLedger {
	readonly remoteTableId: string;
	readonly tag: string;
	readonly definitionDigest: string;
	readonly rows: readonly LookupJsonLedgerRow[];
}

/** CommCare HQ's table as read whole just before the plan. */
export interface LookupJsonRemote {
	readonly id: string;
	readonly tag: string;
	readonly isGlobal: boolean;
	readonly definitionDigest: string;
	/** Every row, each by its id, rank and content digest. */
	readonly rows: readonly {
		readonly id: string;
		readonly sortKey: number;
		readonly digest: string;
	}[];
}

export type LookupJsonOperation =
	| {
			readonly kind: "create-table";
			readonly definition: HqLookupJsonDefinition;
	  }
	| {
			readonly kind: "update-table";
			readonly definition: HqLookupJsonDefinition;
	  }
	| {
			readonly kind: "delete-row";
			readonly novaRowId: string;
			readonly remoteId: string;
			readonly before: { readonly sortKey: number; readonly digest: string };
	  }
	| {
			readonly kind: "update-row";
			readonly novaRowId: string;
			readonly remoteId: string;
			readonly row: HqLookupJsonRow;
			readonly before: { readonly sortKey: number; readonly digest: string };
	  }
	| {
			readonly kind: "create-row";
			readonly novaRowId: string;
			readonly row: HqLookupJsonRow;
	  };

export type LookupJsonReviewReason =
	/** CommCare HQ holds the tag under a table the ledger does not name. */
	| "tag-held-elsewhere"
	/** The ledger's table is gone from the tag, or another id holds it. */
	| "table-moved"
	/** CommCare HQ's table is restricted to some workers. */
	| "not-global"
	/** The definition changed in CommCare HQ since Nova's last write. */
	| "definition-changed"
	/** A row was added, removed, changed or moved in CommCare HQ since the ledger. */
	| "rows-changed"
	/** The definition changes while rows already reach workers. */
	| "schema-change-over-rows"
	/** No integer rank is free where Nova's order puts a row. */
	| "no-rank-room";

export type LookupJsonPlan =
	| {
			readonly kind: "operations";
			/** Empty where CommCare HQ already holds the table as Nova does. */
			readonly operations: readonly LookupJsonOperation[];
	  }
	| { readonly kind: "review"; readonly reason: LookupJsonReviewReason };

function review(reason: LookupJsonReviewReason): LookupJsonPlan {
	return { kind: "review", reason };
}

/** Whether CommCare HQ's rows are exactly the ledger's, each at its recorded rank and content. */
function remoteMatchesLedger(
	ledger: LookupJsonLedger,
	remote: LookupJsonRemote,
): boolean {
	if (ledger.rows.length !== remote.rows.length) return false;
	const recorded = new Map(ledger.rows.map((row) => [row.remoteId, row]));
	if (recorded.size !== ledger.rows.length) return false;
	const seen = new Set<string>();
	for (const row of remote.rows) {
		const held = recorded.get(row.id);
		if (
			held === undefined ||
			seen.has(row.id) ||
			held.sortKey !== row.sortKey ||
			held.digest !== row.digest
		)
			return false;
		seen.add(row.id);
	}
	return true;
}

/**
 * The positions of the longest run of `keys` already strictly increasing,
 * `null` entries skipped. Patience sorting; ties keep the earliest.
 */
function longestIncreasing(keys: readonly (number | null)[]): Set<number> {
	const tails: number[] = [];
	const previous = new Array<number>(keys.length).fill(-1);
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		if (key === null) continue;
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			const tail = keys[tails[middle] as number] as number;
			if (tail < key) low = middle + 1;
			else high = middle;
		}
		if (low > 0) previous[index] = tails[low - 1] as number;
		tails[low] = index;
	}
	const kept = new Set<number>();
	let at = tails.length === 0 ? -1 : (tails[tails.length - 1] as number);
	while (at !== -1) {
		kept.add(at);
		at = previous[at] as number;
	}
	return kept;
}

/**
 * `count` distinct ranks strictly between `lower` and `upper`, increasing.
 * After the last kept row (`upper` past CommCare HQ's integer) they go one
 * `RANK_STEP` past another where that fits, as appends; between two kept
 * rows they spread evenly, leaving room on both sides. Null where the gap
 * holds fewer integers than `count`.
 */
function ranksBetween(
	lower: number,
	upper: number,
	count: number,
): number[] | null {
	if (upper - lower - 1 < count) return null;
	const step =
		upper > RANK_CEILING && lower + RANK_STEP * count < upper
			? RANK_STEP
			: (upper - lower) / (count + 1);
	return Array.from({ length: count }, (_, offset) =>
		Math.floor(lower + step * (offset + 1)),
	);
}

/**
 * A distinct rank for every position, increasing in Nova's order. A kept row
 * of the longest in-order run keeps its rank, and every other row takes one
 * in the gap its neighbours leave (`ranksBetween`), so the next insert or
 * move there has room too. Where a gap has no integer free
 * for the rows it must hold, the kept rows after it give up their ranks one
 * by one, in Nova's order, until it does: the fewest rows that can make room
 * on that side are rewritten. Null only where even CommCare HQ's integer has
 * no room left after the last kept row before the gap.
 */
export function lookupJsonRanks(
	current: readonly (number | null)[],
): readonly number[] | null {
	const anchors = longestIncreasing(current);
	const ranks = new Array<number>(current.length);
	let index = 0;
	let lower = RANK_FLOOR - 1;
	while (index < current.length) {
		let next = index;
		while (next < current.length && !anchors.has(next)) next++;
		let gap: number[] | null = null;
		for (;;) {
			const upper =
				next < current.length ? (current[next] as number) : RANK_CEILING + 1;
			gap = ranksBetween(lower, upper, next - index);
			if (gap !== null || next === current.length) break;
			/* No room before this kept row: it joins the rows that move, and
			 * the gap reaches to the kept row after it. */
			next++;
			while (next < current.length && !anchors.has(next)) next++;
		}
		if (gap === null) return null;
		gap.forEach((rank, offset) => {
			ranks[index + offset] = rank;
		});
		if (next < current.length) {
			ranks[next] = current[next] as number;
			lower = current[next] as number;
		}
		index = next + 1;
	}
	return ranks;
}

/** The writes that make CommCare HQ's table the one Nova holds, or why none may be planned. */
export function planLookupJsonPublish(input: {
	readonly definition: HqLookupJsonDefinition;
	readonly rows: readonly LookupJsonLocalRow[];
	readonly ledger: LookupJsonLedger | null;
	/** Null where no table holds the tag. */
	readonly remote: LookupJsonRemote | null;
}): LookupJsonPlan {
	const { definition, rows, ledger, remote } = input;
	const definitionDigest = lookupJsonDefinitionDigest(definition);
	const operations: LookupJsonOperation[] = [];
	if (new Set(rows.map((row) => row.novaRowId)).size !== rows.length)
		throw new Error("A lookup table's rows repeat a row id.");

	if (ledger === null) {
		if (remote !== null) return review("tag-held-elsewhere");
		const ranks = lookupJsonRanks(rows.map(() => null));
		if (ranks === null) return review("no-rank-room");
		operations.push({ kind: "create-table", definition });
		rows.forEach((row, index) => {
			operations.push({
				kind: "create-row",
				novaRowId: row.novaRowId,
				row: { ...row.content, sortKey: ranks[index] as number },
			});
		});
		return { kind: "operations", operations };
	}

	if (
		remote === null ||
		remote.id !== ledger.remoteTableId ||
		remote.tag !== ledger.tag ||
		ledger.tag !== definition.tag
	)
		return review("table-moved");
	if (!remote.isGlobal) return review("not-global");
	if (remote.definitionDigest !== ledger.definitionDigest)
		return review("definition-changed");
	if (!remoteMatchesLedger(ledger, remote)) return review("rows-changed");

	const held = new Map(ledger.rows.map((row) => [row.novaRowId, row]));
	if (definitionDigest !== ledger.definitionDigest) {
		if (ledger.rows.length > 0) return review("schema-change-over-rows");
		operations.push({ kind: "update-table", definition });
	}

	const local = new Set(rows.map((row) => row.novaRowId));
	for (const row of ledger.rows)
		if (!local.has(row.novaRowId))
			operations.push({
				kind: "delete-row",
				novaRowId: row.novaRowId,
				remoteId: row.remoteId,
				before: { sortKey: row.sortKey, digest: row.digest },
			});

	const ranks = lookupJsonRanks(
		rows.map((row) => held.get(row.novaRowId)?.sortKey ?? null),
	);
	if (ranks === null) return review("no-rank-room");
	const creates: LookupJsonOperation[] = [];
	rows.forEach((row, index) => {
		const sortKey = ranks[index] as number;
		const recorded = held.get(row.novaRowId);
		if (recorded === undefined) {
			creates.push({
				kind: "create-row",
				novaRowId: row.novaRowId,
				row: { ...row.content, sortKey },
			});
			return;
		}
		if (
			recorded.sortKey === sortKey &&
			recorded.digest === lookupJsonRowDigest(row.content)
		)
			return;
		operations.push({
			kind: "update-row",
			novaRowId: row.novaRowId,
			remoteId: recorded.remoteId,
			row: { ...row.content, sortKey },
			before: { sortKey: recorded.sortKey, digest: recorded.digest },
		});
	});
	operations.push(...creates);
	return { kind: "operations", operations };
}
