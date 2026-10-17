/**
 * The Project-level lookup tag rename: pure.
 *
 * CommCare's runtime picks a form instance's data by the words its reference
 * contains (commcare-core `CommCareInstanceInitializer::generateRoot` tests
 * `ledgerdb`, then `casedb`, then `fixture`), so a lookup table whose tag
 * contains `casedb` or `ledgerdb` is read as the case or ledger database and
 * every select over it lists nothing. Step 2 refuses such a tag
 * (`lib/lookup/constants.ts::reservedInstanceTagCause`), and the cutover gives
 * every stored table that holds one a tag that does not: the word split by
 * an underscore, truncated to the tag cap, with a numbered suffix where the
 * Project already holds the result.
 *
 * A reference to a table is its uuid, so no document changes; the writer
 * renames the rows (`writer.ts`), and the plan judges every app against the
 * Project's definitions with the renames already applied (`plan.ts`).
 */

import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	LOOKUP_MAX_TAG_LENGTH,
	RESERVED_INSTANCE_TAG_WORD_SPELLING,
	RESERVED_INSTANCE_TAG_WORDS,
} from "@/lib/lookup/constants";
import { lookupTagSchema } from "@/lib/lookup/schema";

/** The highest suffix a rename tries before it gives up (`_2` to `_99`). */
export const MAX_RENAME_SUFFIX = 99;

/** Whether a stored tag holds a word the runtime reads as its own data, as written. */
export function holdsReservedTagWord(tag: string): boolean {
	return RESERVED_INSTANCE_TAG_WORDS.some((word) => tag.includes(word));
}

/**
 * Each `casedb` and `ledgerdb` in `tag`, left to right, written as
 * `case_db` and `ledger_db`. The two words do not overlap themselves or
 * each other, so an inserted underscore makes no new occurrence and one
 * pass leaves none.
 */
function splitReservedWords(tag: string): string {
	let out = "";
	let at = 0;
	while (at < tag.length) {
		const word = RESERVED_INSTANCE_TAG_WORDS.find((candidate) =>
			tag.startsWith(candidate, at),
		);
		if (word === undefined) {
			out += tag[at];
			at += 1;
			continue;
		}
		out += RESERVED_INSTANCE_TAG_WORD_SPELLING[word];
		at += word.length;
	}
	return out;
}

/**
 * The tag a stored table holding `casedb` or `ledgerdb` takes: each word
 * split, truncated to `LOOKUP_MAX_TAG_LENGTH`, and where `takenTags` holds
 * that, the first of its forms suffixed `_2` to `_99` (the tag truncated to
 * make room) that `takenTags` does not hold. Null when every one is taken.
 * A prefix of a tag with no reserved word holds none, so the truncation
 * cannot bring one back.
 */
export function renamedReservedTag(
	tag: string,
	takenTags: ReadonlySet<string>,
): string | null {
	const split = splitReservedWords(tag);
	const truncated = split.slice(0, LOOKUP_MAX_TAG_LENGTH);
	if (!takenTags.has(truncated)) return truncated;
	for (let suffix = 2; suffix <= MAX_RENAME_SUFFIX; suffix += 1) {
		const ending = `_${suffix}`;
		const candidate = `${split.slice(0, LOOKUP_MAX_TAG_LENGTH - ending.length)}${ending}`;
		if (!takenTags.has(candidate)) return candidate;
	}
	return null;
}

/** One table the cutover renames. Its tags are authored text, never printed by the report. */
export interface LookupTagRename {
	readonly tableId: string;
	readonly fromTag: string;
	readonly toTag: string;
}

/** A table the cutover cannot rename, which stops it for a person to resolve. */
export interface LookupTagRenameBlocker {
	readonly tableId: string;
	readonly code: "lookup-tag-unparsable" | "lookup-tag-rename-collision";
}

export interface ProjectLookupTagPlan {
	/** In table uuid order. */
	readonly renames: readonly LookupTagRename[];
	/** In table uuid order. */
	readonly blockers: readonly LookupTagRenameBlocker[];
	/**
	 * The Project's lookup context with each rename applied: each renamed
	 * table's definition carries its new tag, and nothing else changes. A
	 * blocked table keeps its old tag.
	 */
	readonly context: LookupValidationContext;
}

/**
 * One Project's renames, over its stored definitions. Each table whose tag
 * holds a reserved word is renamed in table uuid order, against every tag
 * the Project holds plus every new tag an earlier table of this pass took.
 * A result `lookupTagSchema` refuses is `lookup-tag-unparsable`, and no free
 * tag is `lookup-tag-rename-collision`.
 */
export function planProjectLookupTags(
	context: LookupValidationContext,
): ProjectLookupTagPlan {
	if (context.kind !== "available") {
		return { renames: [], blockers: [], context };
	}
	const taken = new Set(context.definitions.map((table) => table.tag));
	const renames: LookupTagRename[] = [];
	const blockers: LookupTagRenameBlocker[] = [];
	const ordered = [...context.definitions].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	for (const table of ordered) {
		if (!holdsReservedTagWord(table.tag)) continue;
		const toTag = renamedReservedTag(table.tag, taken);
		if (toTag === null) {
			blockers.push({
				tableId: table.id,
				code: "lookup-tag-rename-collision",
			});
			continue;
		}
		if (!lookupTagSchema.safeParse(toTag).success) {
			blockers.push({ tableId: table.id, code: "lookup-tag-unparsable" });
			continue;
		}
		taken.add(toTag);
		renames.push({ tableId: table.id, fromTag: table.tag, toTag });
	}
	const toTagOf = new Map(
		renames.map((rename) => [rename.tableId, rename.toTag] as const),
	);
	return {
		renames,
		blockers,
		context: {
			...context,
			definitions: context.definitions.map((table) => {
				const toTag = toTagOf.get(table.id);
				return toTag === undefined ? table : { ...table, tag: toTag };
			}),
		},
	};
}
