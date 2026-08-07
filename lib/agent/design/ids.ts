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

export const designIdSchema = z
	.string()
	.regex(CANONICAL_UUID_PATTERN, "Expected a canonical lowercase RFC UUID.")
	.brand<"DesignId">();

export type DesignId = z.infer<typeof designIdSchema>;

/** Parse and narrow string → DesignId. Prefer over unchecked assertions. */
export function asDesignId(value: string): DesignId {
	return designIdSchema.parse(value);
}
