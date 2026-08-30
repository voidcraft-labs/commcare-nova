/**
 * Design identity — the branded ID vocabulary of the Design Contract domain.
 *
 * A `DesignId` uses canonical UUID bytes but is a SEPARATE TypeScript brand
 * from the Blueprint's authored `Uuid`: design intents, actors, tasks, and
 * slices are not in the Blueprint's global authored-identity namespace, and a
 * `DesignId` can never be passed to a canonical mutation as an entity UUID
 * without an explicit implementation binding.
 *
 * This is the first file of the design package; the contract, review, and
 * planner schemas (the reviewed-intent plan's Unit C) build around it.
 */

import { z } from "zod";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";

/** JSON-schema marker for the Design Contract identity domain. The design
 * tool wire projection and raw-UUID admission both consume this same marker,
 * then remove it before the provider sees the schema. UUID-looking values in
 * other domains (Project lookup ids, source coordinates, media ids) never
 * acquire design semantics merely because of their property name. */
export const DESIGN_IDENTITY_SCHEMA_MARKER = "x-nova-design-identity";

/** Current durable handle-ledger vocabulary. Historical migrations remain
 * self-contained, while runtime reads and writes use this one contract. */
export const DESIGN_IDENTITY_HANDLE_ENTITY_KINDS = [
	"contract",
	"actor",
	"record",
	"property",
	"workflow",
	"list",
	"access",
	"navigation",
	"external_requirement",
	"decision",
	"assumption",
	"open_question",
	"module_composition",
	"form_composition",
	"composition_section",
	"composition_item",
	"lookup_table_intent",
	"lookup_column_intent",
	"lookup_row_intent",
	"referenced",
] as const;
export const designIdentityHandleEntityKindSchema = z.enum(
	DESIGN_IDENTITY_HANDLE_ENTITY_KINDS,
);
export type DesignIdentityHandleEntityKind = z.infer<
	typeof designIdentityHandleEntityKindSchema
>;

export const designIdSchema = z
	.string()
	.regex(CANONICAL_UUID_PATTERN, "Expected a canonical lowercase RFC UUID.")
	.brand<"DesignId">()
	.meta({ [DESIGN_IDENTITY_SCHEMA_MARKER]: true });

export type DesignId = z.infer<typeof designIdSchema>;

/** Parse and narrow string → DesignId. Prefer over unchecked assertions. */
export function asDesignId(value: string): DesignId {
	return designIdSchema.parse(value);
}

/**
 * The model-facing symbol grammar for design identities. The design loop's
 * stage tools accept `{ "handle": "@x" }` objects wherever a design-ID slot
 * appears, and the reviewer's output schema accepts the same bare symbols in
 * its element slots. Lives here (a leaf) so the reviewer schema can share it
 * without importing the loop's tool machinery.
 */
export const DESIGN_HANDLE_PATTERN = /^@[a-z][a-z0-9_-]{0,62}$/;
