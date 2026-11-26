import { z } from "zod";
import {
	lookupColumnIdSchema,
	lookupMemberIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { lookupRevisionSchema } from "../schema";

export const lookupValueSlotSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("cell"), columnId: lookupColumnIdSchema }),
	z.strictObject({
		kind: z.literal("attribute"),
		attributeId: lookupMemberIdSchema,
	}),
	z.strictObject({
		kind: z.literal("occurrence"),
		columnId: lookupColumnIdSchema,
		index: z.number().int().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal("property"),
		columnId: lookupColumnIdSchema,
		index: z.number().int().nonnegative(),
		propertyId: lookupMemberIdSchema,
	}),
]);
export type LookupValueSlot = z.infer<typeof lookupValueSlotSchema>;
export const VALUE_CHUNK_BYTES = 32 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().nonnegative();
const operation = { tableId: lookupTableIdSchema, operationId: z.uuid() };
const target = {
	tableId: lookupTableIdSchema,
	rowId: lookupRowIdSchema,
	slot: lookupValueSlotSchema,
	expectedTableRevision: lookupRevisionSchema,
};
export const lookupValueReadRequestSchema = z.strictObject({
	...target,
	byteOffset: offset.optional(),
});
export const lookupValueEditRequestSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("begin"),
		...operation,
		...target,
		baseDigest: digest,
		startByte: offset,
		endByte: offset,
		replacementBytes: offset,
		replacementDigest: digest,
	}),
	z.strictObject({
		kind: z.literal("append"),
		...operation,
		offset,
		base64: z
			.string()
			.min(4)
			.max(4 * Math.ceil(VALUE_CHUNK_BYTES / 3)),
	}),
	z.strictObject({ kind: z.literal("finish"), ...operation }),
	z.strictObject({ kind: z.literal("cancel"), ...operation }),
]);
export type LookupValueReadRequest = z.infer<
	typeof lookupValueReadRequestSchema
>;
export type LookupValueEditRequest = z.infer<
	typeof lookupValueEditRequestSchema
>;
export function valueSlotPath(slot: LookupValueSlot): string[] {
	switch (slot.kind) {
		case "cell":
			return ["cell", slot.columnId];
		case "attribute":
			return ["attribute", slot.attributeId];
		case "occurrence":
			return ["occurrence", slot.columnId, String(slot.index)];
		case "property":
			return ["property", slot.columnId, String(slot.index), slot.propertyId];
	}
}
