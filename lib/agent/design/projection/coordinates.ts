/**
 * Implementation coordinates — the closed union naming WHERE in the canonical
 * app a design intent is implemented.
 *
 * Committed intent provenance (`app_change_intents`) persists one coordinate
 * per row and strict-parses it back through this exact schema; diagnostics,
 * conformance, Design history, and corrective planning all consume the same
 * closed set. Display paths are derived at read time — a coordinate is
 * identity, never prose.
 *
 * This is the first file of the deterministic-projection package; the
 * projection walkers (the reviewed-intent plan's Unit F) build around it.
 */

import { z } from "zod";
import { designIdSchema } from "@/lib/agent/design/ids";
import { uuidSchema } from "@/lib/domain/uuid";

export const implementationCoordinateSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("app"), appId: z.string().min(1) }).strict(),
	z.object({ kind: z.literal("module"), uuid: uuidSchema }).strict(),
	z.object({ kind: z.literal("form"), uuid: uuidSchema }).strict(),
	z.object({ kind: z.literal("field"), uuid: uuidSchema }).strict(),
	z.object({ kind: z.literal("case-list-column"), uuid: uuidSchema }).strict(),
	z.object({ kind: z.literal("case-operation"), uuid: uuidSchema }).strict(),
	z.object({ kind: z.literal("worker-property"), uuid: uuidSchema }).strict(),
	z.object({ kind: z.literal("user-type"), uuid: uuidSchema }).strict(),
	z.object({ kind: z.literal("persona"), uuid: uuidSchema }).strict(),
	z
		.object({ kind: z.literal("organization-level"), uuid: uuidSchema })
		.strict(),
	z.object({ kind: z.literal("location-property"), uuid: uuidSchema }).strict(),
	z.object({ kind: z.literal("automation"), uuid: uuidSchema }).strict(),
	z
		.object({
			kind: z.literal("case-property"),
			caseType: z.string().min(1),
			property: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal("external-action"),
			externalActionId: designIdSchema,
		})
		.strict(),
]);

export type ImplementationCoordinate = z.infer<
	typeof implementationCoordinateSchema
>;
