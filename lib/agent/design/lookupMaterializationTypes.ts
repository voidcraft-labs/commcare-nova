import { z } from "zod";
import { designIdSchema } from "@/lib/agent/design/ids";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { lookupRevisionSchema } from "@/lib/lookup/schema";

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const designLookupBindingSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("lookup-table"),
			designId: designIdSchema,
			lookupId: lookupTableIdSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("lookup-column"),
			designId: designIdSchema,
			lookupId: lookupColumnIdSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("lookup-row"),
			designId: designIdSchema,
			lookupId: lookupRowIdSchema,
		})
		.strict(),
]);
export type DesignLookupBinding = z.infer<typeof designLookupBindingSchema>;

/** Only identities Blueprint construction can reference. Row UUIDs stay in
 * the immutable receipt and its full result digest, but never inflate plans or
 * per-slice execution briefs. */
export const buildPlanLookupBindingSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("lookup-table"),
			designId: designIdSchema,
			lookupId: lookupTableIdSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("lookup-column"),
			designId: designIdSchema,
			lookupId: lookupColumnIdSchema,
		})
		.strict(),
]);
export type BuildPlanLookupBinding = z.infer<
	typeof buildPlanLookupBindingSchema
>;

export function projectBuildPlanLookupBindings(
	bindings: readonly DesignLookupBinding[],
): BuildPlanLookupBinding[] {
	return bindings.filter(
		(binding): binding is BuildPlanLookupBinding =>
			binding.kind !== "lookup-row",
	);
}

export const designLookupTableStateSchema = z
	.object({
		tableId: lookupTableIdSchema,
		definitionRevision: lookupRevisionSchema,
		rowsRevision: lookupRevisionSchema,
		tableRevision: lookupRevisionSchema,
		columnIds: z.array(lookupColumnIdSchema),
	})
	.strict();

export const designLookupMaterializationPayloadSchema = z
	.object({
		schemaVersion: z.literal(1),
		designRevisionId: z.string().uuid(),
		designRevisionDigest: sha256HexSchema,
		projectId: z.string().min(1),
		projectRevision: lookupRevisionSchema,
		bindings: z.array(designLookupBindingSchema),
		tables: z.array(designLookupTableStateSchema),
	})
	.strict();
export type DesignLookupMaterializationPayload = z.infer<
	typeof designLookupMaterializationPayloadSchema
>;

export const buildPlanLookupMaterializationSchema = z
	.object({
		receiptId: z.string().uuid(),
		resultDigest: sha256HexSchema,
		projectRevision: lookupRevisionSchema,
		bindings: z.array(buildPlanLookupBindingSchema),
	})
	.strict();
export type BuildPlanLookupMaterialization = z.infer<
	typeof buildPlanLookupMaterializationSchema
>;
