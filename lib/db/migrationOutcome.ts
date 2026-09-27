import { z } from "zod";

/** Exact saved-data consequence retained beside a canonical checkpoint. */
export const migrationOutcomeSchema = z.strictObject({
	migrated: z.number().int().nonnegative(),
	reshaped: z.number().int().nonnegative(),
	retyped: z.number().int().nonnegative(),
	restored: z.number().int().nonnegative(),
	parked: z.number().int().nonnegative(),
	parkedCaseTypes: z.array(z.string()),
	failureReasons: z.array(z.string()),
});
export type MigrationOutcome = z.infer<typeof migrationOutcomeSchema>;
