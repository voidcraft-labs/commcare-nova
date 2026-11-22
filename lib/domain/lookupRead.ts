import { z } from "zod";
import {
	type LookupColumnId,
	type LookupMemberId,
	lookupColumnIdSchema,
	lookupMemberIdSchema,
} from "./lookupIds";

/** A whole, UUID-bound path from one row. An unqualified column keeps its
 * original scalar identity. Occurrence numbers are one-based and applied
 * in fixture order. A position may select among all occurrences or among
 * the ones whose property matches. */
export const lookupReadSchema = z.union([
	lookupColumnIdSchema,
	z.strictObject({ attributeId: lookupMemberIdSchema }),
	z
		.strictObject({
			columnId: lookupColumnIdSchema,
			where: z
				.strictObject({ propertyId: lookupMemberIdSchema, equals: z.string() })
				.optional(),
			occurrence: z
				.number()
				.int()
				.min(1)
				.max(Number.MAX_SAFE_INTEGER)
				.optional(),
			propertyId: lookupMemberIdSchema.optional(),
			positionBeforeFilter: z.literal(true).optional(),
		})
		.refine(
			(read) =>
				read.where !== undefined ||
				read.occurrence !== undefined ||
				read.propertyId !== undefined,
			"Choose an occurrence or a value detail.",
		).refine(read => !read.positionBeforeFilter || (read.where !== undefined && read.occurrence !== undefined), "Choose both a position and a value detail to change their order."),
]);
export type LookupRead = z.infer<typeof lookupReadSchema>;

export function readColumnId(read: LookupRead): LookupColumnId | undefined {
	return typeof read === "string"
		? read
		: "columnId" in read
			? read.columnId
			: undefined;
}

export function readMemberIds(read: LookupRead): readonly LookupMemberId[] {
	if (typeof read === "string") return [];
	if ("attributeId" in read) return [read.attributeId];
	return [
		...new Set(
			[read.where?.propertyId, read.propertyId].filter(
				(id): id is LookupMemberId => id !== undefined,
			),
		),
	];
}

/** A question offers row details and field values. Details of a particular
 * field value can qualify that field or be read by an expression. */
export function questionChoiceReadIssue(read: LookupRead): string | undefined {
	if (typeof read === "string" || "attributeId" in read) return undefined;
	if (read.propertyId) return "You can use a row detail or a column value for a question’s choices. A value detail can narrow the values in that column.";
	if (read.where?.equals.includes("[")) return "The form editor cannot keep a choice filter containing an opening square bracket. You can choose a different detail value or a position.";
	return undefined;
}

export function sameLookupRead(left: LookupRead, right: LookupRead): boolean {
	if (typeof left === "string" || typeof right === "string")
		return left === right;
	if ("attributeId" in left || "attributeId" in right)
		return (
			"attributeId" in left &&
			"attributeId" in right &&
			left.attributeId === right.attributeId
		);
	return (
		left.columnId === right.columnId &&
		left.occurrence === right.occurrence &&
		left.positionBeforeFilter === right.positionBeforeFilter &&
		left.propertyId === right.propertyId &&
		left.where?.propertyId === right.where?.propertyId &&
		left.where?.equals === right.where?.equals
	);
}

type ReadDefinition<T> = {
	readonly attributes?: readonly { readonly id: LookupMemberId }[];
	readonly columns: readonly {
		readonly id: LookupColumnId;
		readonly dataType: T;
		readonly properties?: readonly { readonly id: LookupMemberId }[];
	}[];
};

/** The scalar type of the selected node. Composite keys check that a value
 * detail belongs to the named column even when the Project holds many tables. */
export function lookupReadTypes<T>(
	table: ReadDefinition<T>,
): ReadonlyMap<string, T | "text"> {
	const types = new Map<string, T | "text">();
	for (const member of table.attributes ?? []) types.set(member.id, "text");
	for (const column of table.columns) {
		types.set(column.id, column.dataType);
		for (const member of column.properties ?? [])
			types.set(`${column.id}/${member.id}`, "text");
	}
	return types;
}
export function lookupReadType<T>(
	types: ReadonlyMap<string, T> | undefined,
	read: LookupRead,
): T | undefined {
	if (!types) return undefined;
	if (typeof read === "string") return types.get(read);
	if ("attributeId" in read) return types.get(read.attributeId);
	if (read.where && !types.has(`${read.columnId}/${read.where.propertyId}`))
		return undefined;
	return types.get(
		read.propertyId ? `${read.columnId}/${read.propertyId}` : read.columnId,
	);
}
