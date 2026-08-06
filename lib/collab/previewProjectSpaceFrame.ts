/**
 * The browser-safe wire contract for one `preview-project-space` SSE frame:
 * the project space Preview may honestly say a worker signed into, emitted
 * by `/api/apps/{id}/stream` on connect and again whenever a deployment
 * write pokes the relay's deployment lane.
 *
 * The value is the SERVER's resolution (`lib/deployment/previewSpace.ts`),
 * never a client-asserted one, because only the server can see whether the
 * app is live on more than one project space — which is exactly when
 * `commcare_project` has two real answers and Nova must name neither.
 * `projectSpace: null` means Preview names nothing: no deployment has
 * reached `uploaded`, or several have.
 *
 * This frame is how a tab that did not perform the publish (a co-member's
 * open builder, a second tab) keeps its client-side preview identity in
 * step with the server-side resolvers, so one expression cannot answer two
 * ways depending on which side evaluated it.
 */

import { z } from "zod";

export const previewProjectSpaceFrameSchema = z
	.object({
		projectSpace: z.string().min(1).nullable(),
	})
	.strict();

export type PreviewProjectSpaceFrame = z.infer<
	typeof previewProjectSpaceFrameSchema
>;

/** Parse one SSE data payload without letting JSON or schema failures escape
 * the provider listener: a malformed frame returns `null` and the retained
 * value is left alone (fail-safe: garbage must not move what an expression
 * evaluates to). */
export function parsePreviewProjectSpaceFrame(
	data: string,
): PreviewProjectSpaceFrame | null {
	try {
		const parsed = previewProjectSpaceFrameSchema.safeParse(JSON.parse(data));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
