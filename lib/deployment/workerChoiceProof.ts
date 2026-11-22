import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "@/lib/apiError";
import { claimExportWorkspace } from "@/lib/export/artifacts/capacity";
import {
	lookupReadCandidates,
	lookupReadFilter,
	lookupReadPosition,
	type ResolvedLookupRead,
	resolveLookupRead,
} from "@/lib/commcare/lookup/read";
import type { FixtureAtom } from "@/lib/commcare/lookup/row";
import type { FixtureAtomBytes } from "@/lib/commcare/lookup/streamFixture";
import { collectLookupOptionsSourceCarriers } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { LookupRead } from "@/lib/domain/lookupRead";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/** A row and its pinned streaming atoms in one authenticated worker reading.
 * Ordinals are local to this reading. They are never HQ row identities. */
export interface WorkerChoiceRow {
	row: LookupFixtureRow;
	read?: FixtureAtomBytes;
}
type Role = "value" | "label" | "sort";
type Issue =
	| "unavailable"
	| "empty-source"
	| "blank"
	| "whitespace"
	| "ambiguous"
	| "duplicate";
interface Finding {
	owner: string;
	role: Role;
	kind: Issue;
	count: number;
	firstPositions: number[];
}
type Selector = { read: LookupRead; resolved: ResolvedLookupRead };
async function* body(atom: FixtureAtom, row: WorkerChoiceRow) {
	const external = row.read?.(atom);
	if (external) {
		yield* external;
		return;
	}
	const text = atom.text;
	for (let start = 0; start < text.length; ) {
		let end = Math.min(text.length, start + 8192);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		yield Buffer.from(text.slice(start, end), "utf8");
		start = end;
	}
}
/** Compare bytes from the same immutable reading even when their transfer
 * chunks divide a multibyte character at different positions. */
async function sameBytes(
	left: AsyncIterable<Uint8Array>,
	right: AsyncIterable<Uint8Array>,
) {
	const a = left[Symbol.asyncIterator](),
		b = right[Symbol.asyncIterator]();
	let ca: Uint8Array = new Uint8Array(0),
		cb: Uint8Array = new Uint8Array(0);
	let doneA = false,
		doneB = false;
	try {
		for (;;) {
			while (!ca.length && !doneA) {
				const next = await a.next();
				doneA = !!next.done;
				if (!next.done) ca = next.value;
			}
			while (!cb.length && !doneB) {
				const next = await b.next();
				doneB = !!next.done;
				if (!next.done) cb = next.value;
			}
			if (!ca.length || !cb.length) return doneA && doneB;
			const n = Math.min(ca.length, cb.length);
			if (
				!Buffer.from(ca.buffer, ca.byteOffset, n).equals(
					Buffer.from(cb.buffer, cb.byteOffset, n),
				)
			)
				return false;
			ca = ca.subarray(n);
			cb = cb.subarray(n);
		}
	} finally {
		await Promise.all([a.return?.(), b.return?.()]);
	}
}

async function selected(
	row: WorkerChoiceRow,
	s: Selector,
): Promise<FixtureAtom | "ambiguous" | undefined> {
	const wanted = lookupReadPosition(s.read),
		filter = lookupReadFilter(s.read);
	let position = 0,
		found: FixtureAtom | undefined;
	for (const item of lookupReadCandidates(row.row, s.read, s.resolved)) {
		if (
			item.predicate &&
			filter !== undefined &&
			!(await sameBytes(
				body(item.predicate, row),
				body({ slot: item.predicate.slot, text: filter }, { row: row.row }),
			))
		)
			continue;
		position++;
		if ((wanted === undefined || position === wanted) && item.output) {
			if (found) return "ambiguous";
			found = item.output;
		}
		if (position === wanted) break;
	}
	return found;
}
async function lexical(
	atom: FixtureAtom,
	row: WorkerChoiceRow,
	secret: Buffer,
) {
	const hash = createHash("sha256"),
		key = createHmac("sha256", secret);
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	let bytes = 0,
		allBlank = true,
		hasSpace = false;
	const scan = (text: string) => {
		if (text.trim() !== "") allBlank = false;
		if (/[\t\n\r ]/.test(text)) hasSpace = true;
	};
	for await (const part of body(atom, row)) {
		bytes += part.byteLength;
		hash.update(part);
		key.update(part);
		scan(decoder.decode(part, { stream: true }));
	}
	scan(decoder.decode());
	return {
		bytes,
		allBlank,
		hasSpace,
		digest: hash.digest("hex"),
		key: key.digest(),
	};
}

/** Validate each complete, unfiltered worker choice population before install
 * or publish. The disk-backed temporary index holds only per-operation keyed
 * digests and positions. Every potential duplicate is compared byte for byte
 * by reopening the representative row in the same authenticated reading. */
export async function verifyWorkerChoices(
	doc: BlueprintDoc,
	table: LookupTableDefinition,
	rows: AsyncIterable<WorkerChoiceRow>,
	options: {
		workerBinding: string;
		reopenRow: (oneBasedPosition: number) => Promise<WorkerChoiceRow>;
	},
) {
	if (!options.workerBinding)
		throw new Error("Choose a verified worker before checking their choices.");
	const sources = collectLookupOptionsSourceCarriers(doc).filter(
		(c) => c.source.tableId === table.id,
	);
	const receipt = createHash("sha256").update(
		canonicalJsonDigest([
			options.workerBinding,
			table,
			sources.map(({ owner, source }) => [owner, source]),
		]),
	);
	const findings = new Map<string, Finding>();
	function issue(owner: string, role: Role, kind: Issue, position: number) {
		const key = JSON.stringify([owner, role, kind]);
		const finding = findings.get(key) ?? {
			owner,
			role,
			kind,
			count: 0,
			firstPositions: [],
		};
		finding.count++;
		if (position > 0 && finding.firstPositions.length < 5)
			finding.firstPositions.push(position);
		findings.set(key, finding);
	}
	const selectors = sources.flatMap(({ owner, source }) => {
		const id = owner.kind === "field" ? owner.fieldUuid : owner.inputUuid;
		const reads = [
			["value", source.valueColumnId],
			["label", source.labelColumnId],
			["sort", source.sortColumnId],
		] as const;
		return reads.flatMap(([role, read]) => {
			if (!read) return [];
			const resolved = resolveLookupRead(table, read);
			if (!resolved) {
				issue(id, role, "unavailable", 0);
				return [];
			}
			return [{ owner: id, role, read, resolved }];
		});
	});
	const release=claimExportWorkspace("workerChoices");
	let db:DatabaseSync|undefined;
	let position = 0;
	try {
		db=new DatabaseSync("");
		const secret = randomBytes(32);
		db.exec(
			"PRAGMA page_size=4096; PRAGMA max_page_count=8192; PRAGMA journal_mode=OFF; PRAGMA cache_size=-1024; CREATE TABLE seen(owner TEXT,key BLOB,position INTEGER,matched INTEGER DEFAULT 0,PRIMARY KEY(owner,key,position)) WITHOUT ROWID",
		);
		const next = db.prepare(
			"SELECT position,matched FROM seen WHERE owner=? AND key=? AND position>? ORDER BY position LIMIT 1",
		);
		const add = db.prepare(
			"INSERT INTO seen(owner,key,position) VALUES(?,?,?)",
		);
		const matched = db.prepare(
			"UPDATE seen SET matched=1 WHERE owner=? AND key=? AND position=?",
		);
		for await (const row of rows) {
			position++;
			for (const selector of selectors) {
				const { owner, role } = selector;
				const atom = await selected(row, selector);
				if (atom === "ambiguous") {
					issue(owner, role, "ambiguous", position);
					receipt.update("A");
					continue;
				}
				if (!atom) {
					if (role !== "sort") issue(owner, role, "blank", position);
					receipt.update("M");
					continue;
				}
				const value = await lexical(atom, row, secret);
				receipt.update(`V${value.digest}`);
				if (role === "label" && value.allBlank) {
					issue(owner, role, "blank", position);
					continue;
				}
				if (role !== "value") continue;
				if (!value.bytes) {
					issue(owner, role, "blank", position);
					continue;
				}
				if (value.hasSpace) {
					issue(owner, role, "whitespace", position);
					continue;
				}
				let prior = 0;
				for (;;) {
					const hit = next.get(owner, value.key, prior);
					if (!hit) {
						add.run(owner, value.key, position);
						break;
					}
					prior = Number(hit.position);
					const earlier = await options.reopenRow(prior);
					const representative = await selected(earlier, selector);
					if (!representative || representative === "ambiguous")
						throw new Error(
							"The worker’s lookup rows changed during verification.",
						);
					if (
						!(await sameBytes(body(atom, row), body(representative, earlier)))
					)
						continue;
					if (!hit.matched) {
						issue(owner, role, "duplicate", prior);
						matched.run(owner, value.key, prior);
					}
					issue(owner, role, "duplicate", position);
					break;
				}
			}
		}
		if (!position)
			for (const selector of selectors)
				if (selector.role === "value")
					issue(selector.owner, "value", "empty-source", 0);
		return {
			rows: position,
			digest: receipt.update(String(position)).digest("hex"),
			issues: [...findings.values()],
		};
	} catch(error) {
		if(typeof error === "object" && error !== null && "errcode" in error && error.errcode === 13)
			throw new ApiError("The choice check ran out of temporary space for this worker’s data. You can reduce the rows assigned to this worker or the number of choice lists that use this table.", 413);
		throw error;
	} finally {
		try { db?.close(); } finally { release(); }
	}
}
