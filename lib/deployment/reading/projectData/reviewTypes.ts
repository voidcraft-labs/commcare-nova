/**
 * What a bring-in's review carries about project data, and the answers a
 * person gives to a lookup table whose tag meets a Project table, with their
 * schemas.
 *
 * Client-safe: the only run-time import is `zod`.
 */

import { z } from "zod";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupReferencingAppSummary } from "@/lib/lookup/types";

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
				| "needs-admin"
				| "managed-elsewhere"
				| "app-reads-a-missing-column"
				| "fails-a-project-space-rule";
			/** `managed-elsewhere`: the other project space. `app-reads-a-missing-column`: the first
			 *  such field, in CommCare HQ's order. Null for the other two. */
			readonly name: string | null;
	  };

/** JSON, equal for equal CommCare HQ content and equal Project revisions. */
export interface ReviewTable {
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
				"needs-admin",
				"managed-elsewhere",
				"app-reads-a-missing-column",
				"fails-a-project-space-rule",
			]),
			name: z.string().nullable(),
		}),
	]);

export const reviewTableSchema: z.ZodType<ReviewTable> = z.strictObject({
	tag: z.string().min(1),
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
