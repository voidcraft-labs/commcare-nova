import { z } from "zod";
import {
	type PreviewSearchCatalog,
	previewSearchProfileSchema,
} from "./searchSettings";

const chunkLength = 16 * 1024;
const frameSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("start"),
		projectId: z.string().min(1),
		count: z.number().int().positive(),
	}),
	z.strictObject({
		kind: z.literal("part"),
		text: z.string().max(chunkLength),
		last: z.boolean(),
	}),
	z.strictObject({ kind: z.literal("end") }),
]);
type Frame = z.infer<typeof frameSchema>;

/** Each SSE event and JSON string is bounded even when many eligible targets
 * have large profiles. Publish a snapshot after receiving all of its targets. */
export function* previewSearchFrames(
	catalog: PreviewSearchCatalog,
): Generator<Frame> {
	yield {
		kind: "start",
		projectId: catalog.projectId,
		count: catalog.profiles.length,
	};
	for (const profile of catalog.profiles) {
		const json = JSON.stringify(profile);
		for (let i = 0; i < json.length; i += chunkLength)
			yield {
				kind: "part",
				text: json.slice(i, i + chunkLength),
				last: i + chunkLength >= json.length,
			};
	}
	yield { kind: "end" };
}

export function createPreviewSearchFrameReader() {
	let pending: PreviewSearchCatalog | undefined;
	let count = 0;
	let parts: string[] = [];
	// undefined means this stream still holds a partial snapshot. null clears
	// a malformed or foreign snapshot and all private pending source bytes.
	return (
		raw: string,
		projectId: string | null,
	): PreviewSearchCatalog | null | undefined => {
		try {
			const frame = frameSchema.parse(JSON.parse(raw));
			if (frame.kind === "start" && frame.projectId === projectId) {
				pending = { projectId, profiles: [] };
				count = frame.count;
				parts = [];
				return;
			}
			if (pending && pending.projectId === projectId) {
				if (frame.kind === "part" && pending.profiles.length < count) {
					parts.push(frame.text);
					if (frame.last) {
						pending.profiles.push(
							previewSearchProfileSchema.parse(JSON.parse(parts.join(""))),
						);
						parts = [];
					}
					return;
				}
				if (
					frame.kind === "end" &&
					pending.profiles.length === count &&
					!parts.length
				) {
					const completed = pending;
					pending = undefined;
					return completed;
				}
			}
		} catch {
			/* Discard this stream's partial answer. */
		}
		pending = undefined;
		parts = [];
		return null;
	};
}
