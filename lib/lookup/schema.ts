import { z } from "zod";
import {
	lookupColumnIdSchema,
	lookupMemberIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	formEditorTagSuggestion,
	LOOKUP_DATA_TYPES,
	LOOKUP_MAX_CELL_BYTES,
	LOOKUP_MAX_CHANGE_BYTES,
	LOOKUP_MAX_COLUMN_LABEL_LENGTH,
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROW_BYTES,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_NAME_LENGTH,
	LOOKUP_MAX_TAG_LENGTH,
	LOOKUP_MAX_WIRE_NAME_LENGTH,
	LOOKUP_REVISION_MAX,
	LOOKUP_WIRE_IDENTIFIER_PATTERN,
	LOOKUP_XML_PREFIX_PATTERN,
	RESERVED_INSTANCE_TAG_WORD_SPELLING,
	reservedInstanceTagCause,
} from "./constants";
import type { LookupRevision, LookupRowValues } from "./types";

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

/** What keeps `value` from being a name CommCare HQ can store, said about
 * the first character that does. Every prefix of an XML name is one, so the
 * longest prefix the pattern admits ends right before that character. */
function wireNameProblem(label: string, value: string): string {
	const characters = [...value];
	let good = 0;
	while (
		good < characters.length &&
		LOOKUP_WIRE_IDENTIFIER_PATTERN.test(characters.slice(0, good + 1).join(""))
	)
		good++;
	const character = characters[good] ?? "";
	const example = "A name such as site_code or site.name works.";
	if (/\s/u.test(character)) return `${label} can't hold a space. ${example}`;
	if (good === 0)
		return `${label} can't start with “${character}”. It needs to start with a letter or an underscore. ${example}`;
	return `${label} can't hold “${character}”. ${example}`;
}

function wireIdentifierSchema(kind: "tag" | "column") {
	const maxLength =
		kind === "tag" ? LOOKUP_MAX_TAG_LENGTH : LOOKUP_MAX_WIRE_NAME_LENGTH;
	const label = kind === "tag" ? "The export tag" : "The export name";
	return z
		.string()
		.min(1, `${label} cannot be blank.`)
		.refine(
			(value) =>
				value.length <= maxLength ||
				(value.length <= 2 * maxLength && [...value].length <= maxLength),
			`${label} must be at most ${maxLength} characters.`,
		)
		.superRefine((value, ctx) => {
			if (value === "" || LOOKUP_WIRE_IDENTIFIER_PATTERN.test(value)) return;
			ctx.addIssue({ code: "custom", message: wireNameProblem(label, value) });
		})
		.refine(
			(value) => !LOOKUP_XML_PREFIX_PATTERN.test(value),
			`${label} can't start with lowercase "xml", which CommCare HQ keeps for itself. A capital first letter works.`,
		)
		.superRefine((value, ctx) => {
			if (kind !== "tag") return;
			// Core chooses storage from the fixture source, which contains the
			// table's tag even when a form assigns the instance another name.
			const cause = reservedInstanceTagCause(value);
			if (cause === null) return;
			ctx.addIssue({
				code: "custom",
				message:
					cause.kind === "name"
						? `${label} is a name CommCare reserves for its own data, so a table cannot use it. Pick another tag.`
						: cause.kind === "form-editor"
							? `${label} ${value} is a name CommCare HQ's form builder keeps for itself, so a form reading this table wouldn't open there. You can use ${formEditorTagSuggestion(value)} instead.`
							: `${label} contains ${cause.word}, and CommCare reads any tag containing ${cause.word} as its own data, so a table can't use it. You can write it as ${RESERVED_INSTANCE_TAG_WORD_SPELLING[cause.word]} instead.`,
			});
		})
		.describe(
			`A namespace-free XML name, up to ${maxLength} Unicode characters. Lowercase xml is reserved. Use a name like site_code for a spelling that works in any data path.`,
		);
}

export const lookupTagSchema = wireIdentifierSchema("tag");
export const lookupWireNameSchema = wireIdentifierSchema("column");

/** Base-62 fractional key, canonicalized by forbidding a trailing zero. */
export const lookupOrderKeySchema = z
	.string()
	.regex(ORDER_KEY_PATTERN, "Expected a canonical base-62 order key.");

export const lookupTextSchema = z.string().superRefine((value, ctx) => {
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
});

export const lookupCellInputSchema = z.union([lookupTextSchema, z.number()]);

/** The aggregate may grow through several individually bounded edits. */
export const storedLookupRowValuesSchema = z.record(
	lookupColumnIdSchema,
	z.union([z.string(), z.number()]),
);
export const lookupRowValuesSchema = z
	.record(lookupColumnIdSchema, lookupCellInputSchema)
	.superRefine((values, ctx) => {
		const keys = Object.keys(values);
		if (keys.length > LOOKUP_MAX_COLUMNS) {
			ctx.addIssue({
				code: "custom",
				message: `A row may contain at most ${LOOKUP_MAX_COLUMNS} cells.`,
			});
		}
	})
	.overwrite((values) => values satisfies LookupRowValues);

export const lookupMemberDraftSchema = z.strictObject({
	wireName: lookupWireNameSchema.refine(
		(name) => name !== "xmlns",
		"This detail needs a different export name. The XML namespace uses xmlns.",
	),
	label: lookupColumnLabelSchema,
});
export const lookupMemberSchema = lookupMemberDraftSchema.extend({
	id: lookupMemberIdSchema,
});
export const lookupOccurrenceSchema = z.strictObject({
	text: lookupTextSchema,
	properties: z.record(lookupMemberIdSchema, lookupTextSchema),
});
export const lookupRowContentSchema = z.strictObject({
	attributes: z.record(lookupMemberIdSchema, lookupTextSchema).optional(),
	occurrences: z
		.record(lookupColumnIdSchema, z.array(lookupOccurrenceSchema))
		.optional(),
});
const memberList = z
	.array(lookupMemberDraftSchema)
	.max(LOOKUP_MAX_COLUMNS)
	.refine(
		(members) =>
			new Set(members.map((member) => member.wireName)).size === members.length,
		"Each detail needs its own export name.",
	);

export const lookupColumnDraftSchema = z
	.strictObject({
		wireName: lookupWireNameSchema,
		label: lookupColumnLabelSchema,
		dataType: lookupDataTypeSchema,
		repeated: z.literal(true).optional(),
		properties: memberList.optional(),
		indexed: z.boolean().optional(),
	})
	.superRefine((column, ctx) => {
		if (column.repeated && column.dataType !== "text")
			ctx.addIssue({
				code: "custom",
				message: "Repeated values need a text column.",
			});
		if (column.properties?.length && !column.repeated)
			ctx.addIssue({
				code: "custom",
				message: "A column with value details needs repeated values.",
			});
	});

export const createLookupTableInputSchema = z
	.strictObject({
		name: lookupTableNameSchema,
		tag: lookupTagSchema,
		attributes: memberList.optional(),
		columns: z.array(lookupColumnDraftSchema).max(LOOKUP_MAX_COLUMNS),
	})
	.superRefine((input, ctx) => {
		if (!input.columns.length && !input.attributes?.length)
			ctx.addIssue({
				code: "custom",
				message: "A table needs at least one column or row detail.",
			});
		const seen = new Set<string>();
		for (let index = 0; index < input.columns.length; index++) {
			const wireName = input.columns[index].wireName;
			if (seen.has(wireName)) {
				ctx.addIssue({
					code: "custom",
					path: ["columns", index, "wireName"],
					message: `The export name “${wireName}” is used twice in this table.`,
				});
			}
			seen.add(wireName);
		}
	});

const expectedTableRevisionShape = {
	tableId: lookupTableIdSchema,
	expectedTableRevision: lookupRevisionSchema,
};

export const lookupExpectedTableRevisionInputSchema = z.strictObject(
	expectedTableRevisionShape,
);

export const updateLookupTableNameInputSchema = z.strictObject({
	...expectedTableRevisionShape,
	name: lookupTableNameSchema,
});

export const updateLookupTableTagInputSchema = z.strictObject({
	...expectedTableRevisionShape,
	tag: lookupTagSchema,
});

export const lookupReaderReviewSchema = z.strictObject({
	projectRevision: lookupRevisionSchema,
	readerAppIds: z.array(z.string().min(1)),
});

export const addLookupColumnInputSchema = z.strictObject({
	reviewed: lookupReaderReviewSchema.optional(),
	...expectedTableRevisionShape,
	column: lookupColumnDraftSchema,
});

const columnMutationShape = {
	...expectedTableRevisionShape,
	columnId: lookupColumnIdSchema,
};

export const updateLookupColumnLabelInputSchema = z.strictObject({
	...columnMutationShape,
	label: lookupColumnLabelSchema,
});

export const updateLookupColumnWireNameInputSchema = z.strictObject({
	...columnMutationShape,
	wireName: lookupWireNameSchema,
});

export const lookupColumnIndexSchema = z
	.number()
	.int()
	.nonnegative()
	.max(2147483646);

export const moveLookupColumnInputSchema = z.strictObject({
	...columnMutationShape,
	toIndex: lookupColumnIndexSchema,
});

export const lookupCreateRowIndexSchema = z
	.number()
	.int()
	.nonnegative()
	.max(2147483647);

export const lookupExistingRowIndexSchema = z
	.number()
	.int()
	.nonnegative()
	.max(2147483646);

export const createLookupRowInputSchema = z.strictObject({
	operationId: z.uuid().optional(),
	...expectedTableRevisionShape,
	toIndex: lookupCreateRowIndexSchema,
	values: lookupRowValuesSchema,
	content: lookupRowContentSchema.optional(),
});

const rowMutationShape = {
	operationId: z.uuid().optional(),
	...expectedTableRevisionShape,
	rowId: lookupRowIdSchema,
};

const occurrenceAt = {
	columnId: lookupColumnIdSchema,
	index: z.number().int().nonnegative().max(2147483646),
};
export const lookupRowPatchSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("cell"),
		columnId: lookupColumnIdSchema,
		value: lookupCellInputSchema.nullable(),
	}),
	z.strictObject({
		kind: z.literal("attribute"),
		attributeId: lookupMemberIdSchema,
		text: lookupTextSchema,
	}),
	z.strictObject({
		kind: z.literal("occurrence"),
		...occurrenceAt,
		text: lookupTextSchema,
	}),
	z.strictObject({
		kind: z.literal("property"),
		...occurrenceAt,
		propertyId: lookupMemberIdSchema,
		text: lookupTextSchema.nullable(),
	}),
	z.strictObject({
		kind: z.literal("insert"),
		...occurrenceAt,
		value: lookupOccurrenceSchema,
	}),
	z.strictObject({ kind: z.literal("remove"), ...occurrenceAt }),
	z.strictObject({
		kind: z.literal("list"),
		columnId: lookupColumnIdSchema,
		present: z.boolean(),
	}),
]);
export const lookupRowChangesSchema = z
	.array(lookupRowPatchSchema)
	.min(1)
	.max(LOOKUP_MAX_COLUMNS);
export const updateLookupRowInputSchema = z.union([
	z.strictObject({
		...rowMutationShape,
		values: lookupRowValuesSchema,
		content: lookupRowContentSchema.optional(),
	}),
	z.strictObject({ ...rowMutationShape, changes: lookupRowChangesSchema }),
]);

export const deleteLookupRowInputSchema = z.strictObject(rowMutationShape);

export const moveLookupRowInputSchema = z.strictObject({
	...rowMutationShape,
	toIndex: lookupExistingRowIndexSchema,
});

export const removeLookupColumnInputSchema =
	z.strictObject(columnMutationShape);

export const retypeLookupColumnInputSchema = z.strictObject({
	...columnMutationShape,
	dataType: lookupDataTypeSchema,
});

/** Which lookup resource's reference edges a caller is asking about. An
 *  absent `columnId` asks about the table itself. */
export const lookupResourceReferenceQuerySchema = z.strictObject({
	tableId: lookupTableIdSchema,
	columnId: lookupColumnIdSchema.optional(),
});

export const replaceLookupRowsInputSchema = z.strictObject({
	operationId: z.uuid().optional(),
	...expectedTableRevisionShape,
	rows: z.array(lookupRowValuesSchema).max(LOOKUP_MAX_ROWS),
});

/** Parses exact Postgres-derived storage measurements; it never estimates. */
export const lookupStorageMeasurementSchema = z
	.strictObject({
		rowValueBytes: z
			.array(z.number().int().nonnegative().max(LOOKUP_MAX_ROW_BYTES))
			.max(LOOKUP_MAX_ROWS),
		dataBytes: z.number().int().nonnegative().max(LOOKUP_MAX_CHANGE_BYTES),
	})
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
