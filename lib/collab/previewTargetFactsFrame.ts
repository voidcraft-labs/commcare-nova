/**
 * The browser-safe wire contract for one `preview-target-facts` SSE frame:
 * what the one reached project space holds of the two kept settings Preview
 * plays, emitted by `/api/apps/{id}/stream` on connect and again whenever a
 * deployment write changes them.
 *
 * The value is the SERVER's resolution (`lib/deployment/previewSpace.ts`),
 * never a client's claim, under the rule that names `commcare_project`: one
 * reached project space or none. `facts: null` means Preview holds no facts
 * (no reached project space, several, or a baseline Nova never read) and plays
 * what a new project space gives.
 *
 * Its own frame name rather than a key on `preview-project-space`: that
 * frame's schema is strict, so a tab still running an older build would drop
 * a widened frame whole and lose `commcare_project` with it, where it simply
 * does not listen for a name it does not know.
 */

import { z } from "zod";

export const previewTargetFactsSchema = z.strictObject({
	/** The project space's `cc-fuzzy-search-enabled` is `yes`. */
	fuzzyListSearch: z.boolean(),
	/** The project space's `cc-label-required-questions-with-asterisk` is `yes`. */
	markRequiredQuestions: z.boolean(),
});

export type PreviewTargetFacts = z.infer<typeof previewTargetFactsSchema>;

export const previewTargetFactsFrameSchema = z.strictObject({
	facts: previewTargetFactsSchema.nullable(),
});

export type PreviewTargetFactsFrame = z.infer<
	typeof previewTargetFactsFrameSchema
>;

/** One SSE data payload; a malformed frame gives null and the held value stays. */
export function parsePreviewTargetFactsFrame(
	data: string,
): PreviewTargetFactsFrame | null {
	try {
		const parsed = previewTargetFactsFrameSchema.safeParse(JSON.parse(data));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
