import { z } from "zod";
import {
	LOOKUP_DATA_TYPES,
	LOOKUP_MAX_CELL_BYTES,
	LOOKUP_MAX_COLUMN_LABEL_LENGTH,
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
	LOOKUP_MAX_TABLE_NAME_LENGTH,
	LOOKUP_MAX_TAG_LENGTH,
	LOOKUP_MAX_WIRE_NAME_LENGTH,
	LOOKUP_REVISION_MAX,
	LOOKUP_WIRE_IDENTIFIER_PATTERN,
	LOOKUP_XML_PREFIX_PATTERN,
} from "./constants";
import type {
	LookupCellValue,
	LookupId,
	LookupRevision,
	LookupRowValues,
} from "./types";

const UUID_V7_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const ORDER_KEY_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
const textEncoder = new TextEncoder();

export function hasUnpairedUtf16Surrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (index + 1 >= value.length) return true;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

export function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export const lookupIdSchema = z
	.string()
	.regex(UUID_V7_PATTERN, "Expected a UUIDv7 identifier.")
	.transform((value) => value.toLowerCase() as LookupId);

export const lookupRevisionSchema = z
	.string()
	.regex(REVISION_PATTERN, "Expected a canonical nonnegative decimal revision.")
	.max(19, "Revision exceeds the signed-int64 range.")
	.refine(
		(value) =>
			REVISION_PATTERN.test(value) &&
			value.length <= 19 &&
			BigInt(value) <= LOOKUP_REVISION_MAX,
		"Revision exceeds the signed-int64 range.",
	)
	.transform((value) => value as LookupRevision);

/** The one application-wire parser for bigint-backed revisions. */
export function parseLookupRevision(value: unknown): LookupRevision {
	return lookupRevisionSchema.parse(value);
}

export function compareLookupRevisions(
	a: LookupRevision,
	b: LookupRevision,
): -1 | 0 | 1 {
	const left = BigInt(a);
	const right = BigInt(b);
	return left < right ? -1 : left > right ? 1 : 0;
}

export function maxLookupRevision(
	a: LookupRevision,
	b: LookupRevision,
): LookupRevision {
	return compareLookupRevisions(a, b) >= 0 ? a : b;
}

export const lookupDataTypeSchema = z.enum(LOOKUP_DATA_TYPES);

function rejectUnsafeDatabaseText(
	value: string,
	ctx: z.RefinementCtx,
	maxCharacters: number,
	label: string,
): void {
	if (value.includes("\0")) {
		ctx.addIssue({ code: "custom", message: "Text may not contain NUL." });
	}
	if (hasUnpairedUtf16Surrogate(value)) {
		ctx.addIssue({
			code: "custom",
			message: "Text contains an unpaired UTF-16 surrogate.",
		});
	}
	if ([...value].length > maxCharacters) {
		ctx.addIssue({
			code: "custom",
			message: `${label} must be at most ${maxCharacters} characters.`,
		});
	}
}

export const lookupTableNameSchema = z
	.string()
	.trim()
	.min(1, "Table name cannot be blank.")
	.superRefine((value, ctx) =>
		rejectUnsafeDatabaseText(
			value,
			ctx,
			LOOKUP_MAX_TABLE_NAME_LENGTH,
			"Table name",
		),
	);

export const lookupColumnLabelSchema = z
	.string()
	.trim()
	.min(1, "Column label cannot be blank.")
	.superRefine((value, ctx) =>
		rejectUnsafeDatabaseText(
			value,
			ctx,
			LOOKUP_MAX_COLUMN_LABEL_LENGTH,
			"Column label",
		),
	);

function wireIdentifierSchema(kind: "tag" | "column") {
	const maxLength =
		kind === "tag" ? LOOKUP_MAX_TAG_LENGTH : LOOKUP_MAX_WIRE_NAME_LENGTH;
	const label = kind === "tag" ? "Table tag" : "Column wire name";
	return z
		.string()
		.min(1, `${label} cannot be blank.`)
		.max(maxLength, `${label} must be at most ${maxLength} characters.`)
		.regex(
			LOOKUP_WIRE_IDENTIFIER_PATTERN,
			`${label} must start with an ASCII letter or underscore and contain only ASCII letters, digits, and underscores.`,
		)
		.refine(
			(value) => !LOOKUP_XML_PREFIX_PATTERN.test(value),
			`${label} may not start with xml.`,
		);
}

export const lookupTagSchema = wireIdentifierSchema("tag");
export const lookupWireNameSchema = wireIdentifierSchema("column");

/** Base-62 fractional key, canonicalized by forbidding a trailing zero. */
export const lookupOrderKeySchema = z
	.string()
	.regex(ORDER_KEY_PATTERN, "Expected a canonical base-62 order key.");

export const lookupCellInputSchema = z.union([
	z.string().superRefine((value, ctx) => {
		if (value.includes("\0")) {
			ctx.addIssue({
				code: "custom",
				message: "Cell text may not contain NUL.",
			});
		}
		if (hasUnpairedUtf16Surrogate(value)) {
			ctx.addIssue({
				code: "custom",
				message: "Cell text contains an unpaired UTF-16 surrogate.",
			});
		}
		if (utf8ByteLength(value) > LOOKUP_MAX_CELL_BYTES) {
			ctx.addIssue({
				code: "custom",
				message: `Cell text must be at most ${LOOKUP_MAX_CELL_BYTES} UTF-8 bytes.`,
			});
		}
	}),
	z.number().finite(),
]);

export const lookupRowValuesSchema = z
	.record(z.string(), lookupCellInputSchema)
	.superRefine((values, ctx) => {
		const keys = Object.keys(values);
		if (keys.length > LOOKUP_MAX_COLUMNS) {
			ctx.addIssue({
				code: "custom",
				message: `A row may contain at most ${LOOKUP_MAX_COLUMNS} cells.`,
			});
		}
		const seen = new Set<string>();
		for (const key of keys) {
			const parsed = lookupIdSchema.safeParse(key);
			if (!parsed.success) {
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: "Row value keys must be UUIDv7 column identifiers.",
				});
				continue;
			}
			if (seen.has(parsed.data)) {
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: "Row value keys must be unique UUIDs.",
				});
			}
			seen.add(parsed.data);
		}
	})
	.transform((values) => {
		const normalized: Record<string, LookupCellValue> = {};
		for (const [key, value] of Object.entries(values)) {
			normalized[lookupIdSchema.parse(key)] = value;
		}
		return normalized as LookupRowValues;
	});

export const lookupColumnDraftSchema = z
	.object({
		wireName: lookupWireNameSchema,
		label: lookupColumnLabelSchema,
		dataType: lookupDataTypeSchema,
	})
	.strict();

export const createLookupTableInputSchema = z
	.object({
		name: lookupTableNameSchema,
		tag: lookupTagSchema,
		columns: z
			.array(lookupColumnDraftSchema)
			.min(1, "A lookup table needs at least one column.")
			.max(LOOKUP_MAX_COLUMNS),
	})
	.strict()
	.superRefine((input, ctx) => {
		const seen = new Set<string>();
		for (let index = 0; index < input.columns.length; index++) {
			const wireName = input.columns[index].wireName;
			if (seen.has(wireName)) {
				ctx.addIssue({
					code: "custom",
					path: ["columns", index, "wireName"],
					message: `Duplicate column wire name "${wireName}".`,
				});
			}
			seen.add(wireName);
		}
	});

const expectedTableRevisionShape = {
	tableId: lookupIdSchema,
	expectedTableRevision: lookupRevisionSchema,
};

export const lookupExpectedTableRevisionInputSchema = z
	.object(expectedTableRevisionShape)
	.strict();

export const updateLookupTableNameInputSchema = z
	.object({ ...expectedTableRevisionShape, name: lookupTableNameSchema })
	.strict();

export const updateLookupTableTagInputSchema = z
	.object({ ...expectedTableRevisionShape, tag: lookupTagSchema })
	.strict();

export const addLookupColumnInputSchema = z
	.object({ ...expectedTableRevisionShape, column: lookupColumnDraftSchema })
	.strict();

const columnMutationShape = {
	...expectedTableRevisionShape,
	columnId: lookupIdSchema,
};

export const updateLookupColumnLabelInputSchema = z
	.object({ ...columnMutationShape, label: lookupColumnLabelSchema })
	.strict();

export const updateLookupColumnWireNameInputSchema = z
	.object({ ...columnMutationShape, wireName: lookupWireNameSchema })
	.strict();

export const lookupColumnIndexSchema = z
	.number()
	.int()
	.nonnegative()
	.max(LOOKUP_MAX_COLUMNS - 1);

export const moveLookupColumnInputSchema = z
	.object({ ...columnMutationShape, toIndex: lookupColumnIndexSchema })
	.strict();

export const lookupCreateRowIndexSchema = z
	.number()
	.int()
	.nonnegative()
	.max(LOOKUP_MAX_ROWS);

export const lookupExistingRowIndexSchema = z
	.number()
	.int()
	.nonnegative()
	.max(LOOKUP_MAX_ROWS - 1);

export const createLookupRowInputSchema = z
	.object({
		...expectedTableRevisionShape,
		toIndex: lookupCreateRowIndexSchema,
		values: lookupRowValuesSchema,
	})
	.strict();

const rowMutationShape = {
	...expectedTableRevisionShape,
	rowId: lookupIdSchema,
};

export const updateLookupRowInputSchema = z
	.object({ ...rowMutationShape, values: lookupRowValuesSchema })
	.strict();

export const deleteLookupRowInputSchema = z.object(rowMutationShape).strict();

export const moveLookupRowInputSchema = z
	.object({ ...rowMutationShape, toIndex: lookupExistingRowIndexSchema })
	.strict();

export const replaceLookupRowsInputSchema = z
	.object({
		...expectedTableRevisionShape,
		rows: z.array(lookupRowValuesSchema).max(LOOKUP_MAX_ROWS),
	})
	.strict();

/** Parses exact Postgres-derived storage measurements; it never estimates. */
export const lookupStorageMeasurementSchema = z
	.object({
		rowValueBytes: z
			.array(z.number().int().nonnegative().max(LOOKUP_MAX_ROW_BYTES))
			.max(LOOKUP_MAX_ROWS),
		dataBytes: z.number().int().nonnegative().max(LOOKUP_MAX_TABLE_BYTES),
	})
	.strict()
	.superRefine((measurement, ctx) => {
		const sum = measurement.rowValueBytes.reduce(
			(total, bytes) => total + bytes,
			0,
		);
		if (sum !== measurement.dataBytes) {
			ctx.addIssue({
				code: "custom",
				path: ["dataBytes"],
				message: "dataBytes must equal the sum of Postgres row measurements.",
			});
		}
	});
