import { z } from "zod";
import { uuidSchema } from "./uuid";

/** The text branch of a calculated column when it runs on a Search result
 * Detail or Results list. A Details column can also read the submitted text of a calendar prompt.
 * An offered prompt's absence reads as empty text. The column's
 * ordinary expression still owns the fallback. */
export const searchResultDetailTextSchema = z.union([
	z.strictObject({
		inputUuid: uuidSchema,
		prefix: z.string(),
		suffix: z.string(),
		onList: z.literal(true).optional(),
	}),
	z.strictObject({ text: z.string() }),
]);

export type SearchResultDetailText = z.infer<
	typeof searchResultDetailTextSchema
>;
