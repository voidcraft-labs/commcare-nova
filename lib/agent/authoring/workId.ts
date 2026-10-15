import { z } from "zod";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";
import { AuthoringInputError } from "./errors";

/** Work identities are UUIDs; app, Project and request IDs remain opaque text. */
export const workIdSchema = z
	.string()
	.regex(CANONICAL_UUID_PATTERN, "Use the work ID returned by begin_work.");
export const workIdJsonSchema = z.toJSONSchema(workIdSchema);
export function assertWorkId(workId: string): void {
	if (!workIdSchema.safeParse(workId).success)
		throw new AuthoringInputError("Use the work ID returned by begin_work.");
}
