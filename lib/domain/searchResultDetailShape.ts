import { z } from "zod";
import { uuidSchema } from "./uuid";

/** The text branch of a calculated column when it runs on a Search result
 * Detail. An offered prompt's absence reads as empty text. The column's
 * ordinary expression still owns the fallback. */
export const searchResultDetailTextSchema = z.union([
	z.strictObject({
		inputUuid: uuidSchema,
		prefix: z.string(),
		suffix: z.string(),
	}),
	z.strictObject({ text: z.string() }),
]);

export type SearchResultDetailText = z.infer<
	typeof searchResultDetailTextSchema
>;
