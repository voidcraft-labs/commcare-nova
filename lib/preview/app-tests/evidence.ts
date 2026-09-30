import { z } from "zod";

/** Recorded production journeys had 3.5 KiB p95 and 12.7 KiB maximum steps.
 * A page fits several normal observations while every larger value stays
 * reachable through bounded, explicit inspection of its persisted JSON. */
export const APP_TEST_EVIDENCE_BYTES = 64 * 1024;
export const appTestReadWindowSchema = z.strictObject({
	afterStep: z.number().int().min(-1).max(201).optional(),
	throughStep: z.number().int().min(0).max(201).optional(),
	limit: z.number().int().min(1).max(20).optional(),
	inspect: z
		.strictObject({
			step: z.number().int().min(0).max(201),
			path: z
				.array(z.union([z.string().max(1024), z.number().int().min(0)]))
				.max(32)
				.optional(),
			offset: z
				.number()
				.int()
				.min(0)
				.max(32 * 1024 * 1024)
				.optional(),
		})
		.optional(),
});
export type AppTestReadWindow = z.infer<typeof appTestReadWindowSchema>;
export const evidenceBytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;
export class AppTestEvidenceInputError extends Error {}

type Path = readonly (string | number)[];

function descriptor(value: unknown, path: Path) {
	const bytes = evidenceBytes(value);
	return bytes <= 1024
		? { kind: "value" as const, value, path }
		: {
				kind: Array.isArray(value)
					? ("array" as const)
					: typeof value === "string"
						? ("string" as const)
						: ("object" as const),
				bytes,
				path,
			};
}

/** A projection, never truncation passed off as a complete observation. Object
 * fields/array members can be opened by their returned path; long strings have
 * an explicit next offset and preserve code points across fragments. */
export function inspectAppTestEvidence(
	value: unknown,
	path: Path = [],
	offset = 0,
) {
	let selected = value;
	for (const part of path) {
		if (
			selected === null ||
			typeof selected !== "object" ||
			!Object.hasOwn(selected, part)
		)
			throw new AppTestEvidenceInputError("That evidence path is unavailable.");
		selected = (selected as Record<string | number, unknown>)[part];
	}
	if (evidenceBytes(selected) <= 16 * 1024)
		return {
			kind: "value" as const,
			path,
			value: selected,
			complete: true as const,
		};
	if (typeof selected === "string") {
		if (
			offset > selected.length ||
			(offset > 0 && /[\uDC00-\uDFFF]/.test(selected[offset] ?? ""))
		)
			throw new AppTestEvidenceInputError(
				"Use the next offset returned by this evidence read.",
			);
		let end = Math.min(selected.length, offset + 2048);
		if (/[\uD800-\uDBFF]/.test(selected[end - 1] ?? "")) end -= 1;
		return {
			kind: "string" as const,
			path,
			offset,
			text: selected.slice(offset, end),
			length: selected.length,
			nextOffset: end < selected.length ? end : null,
			complete: false as const,
		};
	}
	const entries = Array.isArray(selected)
		? selected.map((item, index) => ({ key: index, item }))
		: Object.entries(selected as Record<string, unknown>).map(
				([key, item]) => ({ key, item }),
			);
	const nodes = entries
		.slice(offset, offset + 20)
		.map(({ key, item }) => ({ key, ...descriptor(item, [...path, key]) }));
	return {
		kind: Array.isArray(selected) ? ("array" as const) : ("object" as const),
		path,
		offset,
		entries: nodes,
		length: entries.length,
		nextOffset:
			offset + nodes.length < entries.length ? offset + nodes.length : null,
		complete: false as const,
	};
}
