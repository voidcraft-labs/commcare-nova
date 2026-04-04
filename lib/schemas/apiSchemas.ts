import { z } from "zod";
import { appBlueprintSchema } from "./blueprint";

export const chatRequestSchema = z.object({
	blueprint: appBlueprintSchema.optional(),
	runId: z.string().optional(),
	/** Firestore app ID — present after first save so subsequent saves update the same doc. */
	appId: z.string().optional(),
});
