import { z } from "zod";
import { LOOKUP_MAX_ROWS } from "@/lib/lookup/constants";
import {
	lookupColumnLabelSchema,
	lookupRevisionSchema,
	lookupTableNameSchema,
} from "@/lib/lookup/schema";
import type {
	LookupCellValue,
	LookupRevision,
	LookupRowId,
} from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

const boundedRowCountSchema = z
	.number()
	.int()
	.nonnegative()
	.max(LOOKUP_MAX_ROWS);

/** Constant-size, server-verifiable summary of one ordered saved-value/label
 * projection. The digest binds exact row identity, order, value, label, and
 * missing-cell state; the counters give the reviewer useful semantics without
 * copying an entire shared table into the Design Contract. */
export const lookupChoiceProjectionAttestationSchema = z
	.object({
		tableRevision: lookupRevisionSchema,
		tableName: lookupTableNameSchema,
		valueColumnLabel: lookupColumnLabelSchema,
		labelColumnLabel: lookupColumnLabelSchema,
		rowCount: boundedRowCountSchema,
		projectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
		distinctValueCount: boundedRowCountSchema,
		invalidValueCount: boundedRowCountSchema,
		blankLabelCount: boundedRowCountSchema,
		duplicateValueCount: boundedRowCountSchema,
	})
	.strict()
	.superRefine((attestation, ctx) => {
		if (
			attestation.distinctValueCount +
				attestation.invalidValueCount +
				attestation.duplicateValueCount !==
			attestation.rowCount
		) {
			ctx.addIssue({
				code: "custom",
				path: ["rowCount"],
				message:
					"The distinct, invalid, and duplicate saved-value counts must account for every projected row.",
			});
		}
		if (attestation.blankLabelCount > attestation.rowCount) {
			ctx.addIssue({
				code: "custom",
				path: ["blankLabelCount"],
				message: "The blank-label count cannot exceed the projected row count.",
			});
		}
	});
export type LookupChoiceProjectionAttestation = z.infer<
	typeof lookupChoiceProjectionAttestationSchema
>;

export interface LookupChoiceProjectionRow {
	readonly rowId: LookupRowId | string;
	readonly value?: LookupCellValue;
	readonly label?: LookupCellValue;
}

function canonicalProjectionRow(row: LookupChoiceProjectionRow) {
	return {
		rowId: row.rowId,
		...(row.value === undefined ? {} : { value: row.value }),
		...(row.label === undefined ? {} : { label: row.label }),
	};
}

/** Digest and metrics are computed only from authoritative rows. Valid saved
 * values are nonempty and contain no ASCII whitespace, matching lookup-backed
 * controlled-choice construction. Duplicate count means valid rows beyond the
 * first occurrence of each saved value. */
export function computeLookupChoiceProjectionAttestation(args: {
	readonly tableRevision: LookupRevision;
	readonly tableName: string;
	readonly valueColumnLabel: string;
	readonly labelColumnLabel: string;
	readonly rows: readonly LookupChoiceProjectionRow[];
}): LookupChoiceProjectionAttestation {
	const values: string[] = [];
	let invalidValueCount = 0;
	let blankLabelCount = 0;
	for (const row of args.rows) {
		const valueText = row.value === undefined ? "" : String(row.value);
		const labelText = row.label === undefined ? "" : String(row.label);
		if (valueText === "" || /[\t\n\r ]/.test(valueText)) invalidValueCount += 1;
		else values.push(valueText);
		if (labelText.trim() === "") blankLabelCount += 1;
	}
	const distinctValueCount = new Set(values).size;
	return lookupChoiceProjectionAttestationSchema.parse({
		tableRevision: args.tableRevision,
		tableName: args.tableName,
		valueColumnLabel: args.valueColumnLabel,
		labelColumnLabel: args.labelColumnLabel,
		rowCount: args.rows.length,
		projectionDigest: canonicalJsonDigest(
			args.rows.map((row) => canonicalProjectionRow(row)),
		),
		distinctValueCount,
		invalidValueCount,
		blankLabelCount,
		duplicateValueCount: values.length - distinctValueCount,
	});
}

export function lookupChoiceAttestationsEqual(
	left: LookupChoiceProjectionAttestation,
	right: LookupChoiceProjectionAttestation,
): boolean {
	return (
		left.tableRevision === right.tableRevision &&
		left.tableName === right.tableName &&
		left.valueColumnLabel === right.valueColumnLabel &&
		left.labelColumnLabel === right.labelColumnLabel &&
		left.rowCount === right.rowCount &&
		left.projectionDigest === right.projectionDigest &&
		left.distinctValueCount === right.distinctValueCount &&
		left.invalidValueCount === right.invalidValueCount &&
		left.blankLabelCount === right.blankLabelCount &&
		left.duplicateValueCount === right.duplicateValueCount
	);
}
