import { z } from "zod";
import {
	fuzzySearchPropertySchema,
	ignoredSearchTextSchema,
	type PreviewSearchValues,
	previewSearchValuesSchema,
} from "./searchSettings";

const position = z.number().int().min(0).max(16384);
function splices<T extends z.ZodType>(row: T) {
	return z
		.array(
			z.strictObject({
				start: position.describe(
					"Zero-based index in this list after the preceding edits.",
				),
				remove: position.describe("Number of existing rows to remove here."),
				insert: z.array(row).describe("Rows to insert here, in order."),
			}),
		)
		.max(256);
}

// A normal edit transports its changed rows. Leave room for the browser action
// envelope and for clients that escape non-ASCII text a second time.
export const previewSearchChangesSchema = z
	.strictObject({
		maximum: previewSearchValuesSchema.shape.maximum.optional(),
		timeZone: previewSearchValuesSchema.shape.timeZone.optional(),
		propertyMatchers: z
			.strictObject({
				fuzzyProperties: splices(fuzzySearchPropertySchema).optional(),
				ignoredText: splices(ignoredSearchTextSchema).optional(),
			})
			.nullable()
			.optional(),
	})
	.refine(
		(edit) =>
			new TextEncoder().encode(JSON.stringify(edit)).length <= 64 * 1024,
		"Save fewer changed rules together. You can change the remaining rules after this save.",
	);
export type PreviewSearchChanges = z.infer<typeof previewSearchChangesSchema>;
type Splice<T> = { start: number; remove: number; insert: T[] };

function editRows<T>(
	base: readonly T[],
	changes: readonly Splice<T>[] | undefined,
) {
	const rows = [...base];
	for (const { start, remove, insert } of changes ?? []) {
		if (start > rows.length || remove > rows.length - start) return null;
		rows.splice(start, remove, ...insert);
	}
	return rows;
}

export function applyPreviewSearchChanges(
	base: PreviewSearchValues,
	edit: PreviewSearchChanges,
) {
	let propertyMatchers = base.propertyMatchers;
	if (edit.propertyMatchers === null) propertyMatchers = null;
	else if (edit.propertyMatchers) {
		const fuzzyProperties = editRows(
			propertyMatchers?.fuzzyProperties ?? [],
			edit.propertyMatchers.fuzzyProperties,
		);
		const ignoredText = editRows(
			propertyMatchers?.ignoredText ?? [],
			edit.propertyMatchers.ignoredText,
		);
		if (!fuzzyProperties || !ignoredText)
			return {
				error:
					"That rule position is outside the current settings. Read the latest rules and choose a position in that list.",
			};
		propertyMatchers = { fuzzyProperties, ignoredText };
	}
	const result = previewSearchValuesSchema.safeParse({
		...base,
		...edit,
		propertyMatchers,
	});
	return result.success
		? { values: result.data }
		: { error: result.error.issues[0].message };
}

/** Use unchanged rows as anchors. Distant edits and moves therefore never
 * need to transmit intervening unchanged literals, even when rows repeat. */
function changedRows<T>(
	before: readonly T[],
	after: readonly T[],
): Splice<T>[] {
	const available = new Map<string, number[]>();
	for (let i = before.length - 1; i >= 0; i--) {
		const key = JSON.stringify(before[i]);
		const positions = available.get(key);
		if (positions) positions.push(i);
		else available.set(key, [i]);
	}
	const changes: Splice<T>[] = [];
	let oldStart = 0,
		newStart = 0;
	function addUntil(oldEnd: number, newEnd: number) {
		if (oldEnd !== oldStart || newEnd !== newStart)
			changes.push({
				start: newStart,
				remove: oldEnd - oldStart,
				insert: after.slice(newStart, newEnd),
			});
	}
	for (const [index, row] of after.entries()) {
		const positions = available.get(JSON.stringify(row));
		let next = positions?.pop();
		while (next !== undefined && next < oldStart) next = positions?.pop();
		if (next === undefined) continue;
		addUntil(next, index);
		oldStart = next + 1;
		newStart = index + 1;
	}
	addUntil(before.length, after.length);
	return changes;
}

export function describePreviewSearchChanges(
	base: PreviewSearchValues,
	next: PreviewSearchValues,
): PreviewSearchChanges {
	const changes: PreviewSearchChanges = {};
	if (base.maximum !== next.maximum) changes.maximum = next.maximum;
	if (base.timeZone !== next.timeZone) changes.timeZone = next.timeZone;
	if (next.propertyMatchers === null) {
		if (base.propertyMatchers !== null) changes.propertyMatchers = null;
	} else {
		const fuzzyProperties = changedRows(
			base.propertyMatchers?.fuzzyProperties ?? [],
			next.propertyMatchers.fuzzyProperties,
		);
		const ignoredText = changedRows(
			base.propertyMatchers?.ignoredText ?? [],
			next.propertyMatchers.ignoredText,
		);
		if (!base.propertyMatchers || fuzzyProperties.length || ignoredText.length)
			changes.propertyMatchers = {
				...(fuzzyProperties.length && { fuzzyProperties }),
				...(ignoredText.length && { ignoredText }),
			};
	}
	return changes;
}
