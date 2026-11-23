/**
 * What a bring-in's review carries about project data, the answers a person
 * gives to a lookup table whose tag meets a Project table, and the answer to
 * an owner rule the places CommCare HQ holds cannot satisfy, with their
 * schemas.
 *
 * Client-safe: the run-time imports are `zod` and the browser-safe canonical
 * JSON text.
 */

import { z } from "zod";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { recordFromEntries } from "@/lib/domain/records";
import {
	type LookupSourceFacts,
	lookupSourceFactsSchema,
} from "@/lib/lookup/source";
import type { LookupReferencingAppSummary } from "@/lib/lookup/types";
import type {
	OwnerRuleConflict,
	ReviewOwnerRule,
} from "@/lib/publish/ownerRuleCopy";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

/** The two answers to a tag that meets a Project table. */
export const LOOKUP_TABLE_CHOICES = ["use-commcare-hq", "use-project"] as const;
export type LookupTableChoice = (typeof LOOKUP_TABLE_CHOICES)[number];

/** Whether one answer is offered, and what it means or why it is not. */
export type LookupChoiceOffer =
	| {
			readonly offered: true;
			/** `use-commcare-hq` only: columns the apps read that CommCare HQ's table lacks. */
			readonly goneColumns: readonly string[];
			/** `use-commcare-hq` only: the Project table's columns that are not text and become it,
			 *  by label. */
			readonly retypedColumns: readonly string[];
	  }
	| {
			readonly offered: false;
			readonly why:
				| "needs-source-evidence"
				| "needs-admin"
				| "managed-elsewhere"
				| "app-reads-a-missing-column"
				| "fails-a-project-space-rule"
				| "too-many-columns";
			/** `managed-elsewhere`: the other project space. `app-reads-a-missing-column`: the first
			 *  such field, in CommCare HQ's order. `too-many-columns`: the columns the table would
			 *  hold, with a thousands separator. Null for the other two. */
			readonly name: string | null;
	  };

/** JSON, equal for equal CommCare HQ content and equal Project revisions. */
export interface ReviewTable {
	readonly source?: LookupSourceFacts;
	readonly tag: string;
	/** `LookupTableStanding["kind"]`. */
	readonly standing: "new" | "same-managed" | "same-equal" | "choice";
	/** `HqLookupTableRead.canonical`'s digest: CommCare HQ's columns and rows. */
	readonly hqDigest: string;
	/** The Project table it met, at the revisions the read saw; null for `new`. */
	readonly projectTable: {
		readonly tableId: LookupTableId;
		readonly definitionRevision: string;
		readonly rowsRevision: string;
	} | null;
	/** For `choice`: what differs, who reads the Project's table, and each answer's offer. */
	readonly choice: {
		readonly differs: readonly ("columns" | "rows")[];
		readonly apps: readonly LookupReferencingAppSummary[];
		readonly options: Readonly<Record<LookupTableChoice, LookupChoiceOffer>>;
	} | null;
}

export interface ReviewPlaces {
	readonly count: number;
	/** `ManagedPlacePlan.digest`. */
	readonly digest: string;
}

export const lookupChoiceOfferSchema: z.ZodType<LookupChoiceOffer> =
	z.discriminatedUnion("offered", [
		z.strictObject({
			offered: z.literal(true),
			goneColumns: z.array(z.string()).readonly(),
			retypedColumns: z.array(z.string()).readonly(),
		}),
		z.strictObject({
			offered: z.literal(false),
			why: z.enum([
				"needs-source-evidence",
				"needs-admin",
				"managed-elsewhere",
				"app-reads-a-missing-column",
				"fails-a-project-space-rule",
				"too-many-columns",
			]),
			name: z.string().nullable(),
		}),
	]);

export const reviewTableSchema: z.ZodType<ReviewTable> = z.strictObject({
	tag: z.string().min(1),
	source: lookupSourceFactsSchema.optional(),
	standing: z.enum(["new", "same-managed", "same-equal", "choice"]),
	hqDigest: z.string().regex(/^[0-9a-f]{64}$/),
	projectTable: z
		.strictObject({
			// A lookup table id. Typed by the cast below: this module imports no schema of `lib/lookup`.
			tableId: z.string().min(1),
			definitionRevision: z.string().regex(/^[0-9]+$/),
			rowsRevision: z.string().regex(/^[0-9]+$/),
		})
		.nullable(),
	choice: z
		.strictObject({
			differs: z.array(z.enum(["columns", "rows"])).readonly(),
			apps: z
				.array(
					z.strictObject({
						appId: z.string().min(1),
						appName: z.string(),
						deleted: z.boolean(),
					}),
				)
				.readonly(),
			options: z.strictObject({
				"use-commcare-hq": lookupChoiceOfferSchema,
				"use-project": lookupChoiceOfferSchema,
			}),
		})
		.nullable(),
}) as unknown as z.ZodType<ReviewTable>;

export const reviewPlacesSchema: z.ZodType<ReviewPlaces> = z.strictObject({
	count: z.number().int().min(0),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * The answers to tables' choices that still hold for a review that came back:
 * a table's answer is kept only where its entry in `now` is the very entry,
 * as canonical JSON, it was given against in `before` (its standing, CommCare
 * HQ's content, the Project table's revisions, what differs, the apps that
 * read it and both offers), and that answer is still offered. Any other
 * answer is dropped, `dropped` says so, and the table is asked again: a
 * person answers a table's consequences, never its tag.
 */
export function keptTableChoices(
	before: readonly ReviewTable[],
	now: readonly ReviewTable[],
	choices: Readonly<Record<string, LookupTableChoice>>,
): {
	readonly choices: Readonly<Record<string, LookupTableChoice>>;
	readonly dropped: boolean;
} {
	const kept = recordFromEntries<LookupTableChoice>([]);
	let dropped = false;
	for (const [tag, choice] of Object.entries(choices)) {
		const was = before.find((table) => table.tag === tag);
		const is = now.find((table) => table.tag === tag);
		if (
			was !== undefined &&
			is !== undefined &&
			is.choice?.options[choice].offered === true &&
			canonicalJsonText(was) === canonicalJsonText(is)
		) {
			kept[tag] = choice;
		} else {
			dropped = true;
		}
	}
	return { choices: kept, dropped };
}

// ---------------------------------------------------------------------------
// Owner rules
// ---------------------------------------------------------------------------

/**
 * The one explicit owner rule a review offers for a rule that gives a case
 * to the place at a level and that the places cannot satisfy: the worker who
 * fills in the form owns the case, as a case change with no owner rule gives
 * it. The other remedy is CommCare HQ's: change the places there and read
 * the app again. Nova never picks a place for the person.
 */
export const OWNER_RULE_CHOICES = ["worker"] as const;
export type OwnerRuleChoice = (typeof OWNER_RULE_CHOICES)[number];

export type {
	OwnerRuleConflict,
	ReviewOwnerRule,
} from "@/lib/publish/ownerRuleCopy";

const ownerRuleConflictSchema: z.ZodType<OwnerRuleConflict> =
	z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("two-places"),
			source: z.string(),
			places: z.tuple([z.string(), z.string()]).readonly(),
		}),
		z.strictObject({ kind: z.literal("no-place"), source: z.string() }),
		z.strictObject({ kind: z.literal("level-owns-no-cases") }),
		z.strictObject({ kind: z.literal("no-owning-level-above") }),
		z.strictObject({
			kind: z.literal("outside-address-book"),
			place: z.string(),
			persona: z.string(),
		}),
	]);

export const reviewOwnerRuleSchema: z.ZodType<ReviewOwnerRule> = z.strictObject(
	{
		level: z.string(),
		levelName: z.string(),
		conflict: ownerRuleConflictSchema,
		forms: z.array(z.string()).readonly(),
	},
);

/** The answers to owner rules, by level code. */
export const ownerRuleChoicesSchema = z.record(
	z.string(),
	z.enum(OWNER_RULE_CHOICES),
);

/**
 * The person's owner-rule answers against the review's questions: every
 * question answered, and no answer for a level the review does not ask about.
 * Pure.
 */
export function resolveOwnerRuleChoices(
	questions: readonly ReviewOwnerRule[],
	answers: Readonly<Record<string, string>>,
):
	| { readonly ok: true; readonly levels: readonly string[] }
	| {
			readonly ok: false;
			/** Levels the review asks about that have no answer. */
			readonly missing: readonly string[];
			/** Answers for a level the review does not ask about, or that it does not offer. */
			readonly notOffered: readonly string[];
	  } {
	const asked = new Set(questions.map((question) => question.level));
	const offered = new Set<string>(OWNER_RULE_CHOICES);
	const notOffered = Object.entries(answers)
		.filter(([level, answer]) => !asked.has(level) || !offered.has(answer))
		.map(([level]) => level);
	const missing = questions
		.map((question) => question.level)
		.filter((level) => !Object.hasOwn(answers, level));
	if (notOffered.length > 0 || missing.length > 0)
		return { ok: false, missing, notOffered };
	return { ok: true, levels: questions.map((question) => question.level) };
}

/**
 * The owner-rule answers that still hold for a review that came back: an
 * answer is kept only where `now` asks the very question, as canonical JSON,
 * it was given against in `before`. A person answers a conflict, never a
 * level's code alone.
 */
export function keptOwnerRuleChoices(
	before: readonly ReviewOwnerRule[],
	now: readonly ReviewOwnerRule[],
	choices: Readonly<Record<string, OwnerRuleChoice>>,
): {
	readonly choices: Readonly<Record<string, OwnerRuleChoice>>;
	readonly dropped: boolean;
} {
	const kept = recordFromEntries<OwnerRuleChoice>([]);
	let dropped = false;
	for (const [level, choice] of Object.entries(choices)) {
		const was = before.find((question) => question.level === level);
		const is = now.find((question) => question.level === level);
		if (
			was !== undefined &&
			is !== undefined &&
			canonicalJsonText(was) === canonicalJsonText(is)
		)
			kept[level] = choice;
		else dropped = true;
	}
	return { choices: kept, dropped };
}
