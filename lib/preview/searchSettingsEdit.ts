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
		caseListMap: previewSearchValuesSchema.shape.caseListMap.describe(
			"Whether this destination has the Web Apps record map. Omit to keep the team’s setting, or use null when unconfirmed.",
		),
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
	// A move near the start must not turn the rest of the list into an
	// insertion. Find the longest increasing sequence of original positions.
	const pairs: { original: number; current: number; previous: number }[] = [];
	const tails: number[] = [];
	for (const [current, row] of after.entries()) {
		const original = available.get(JSON.stringify(row))?.pop();
		if (original === undefined) continue;
		let low = 0,
			high = tails.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (pairs[tails[middle]].original < original) low = middle + 1;
			else high = middle;
		}
		pairs.push({ original, current, previous: low ? tails[low - 1] : -1 });
		tails[low] = pairs.length - 1;
	}
	const anchors: typeof pairs = [];
	for (let i = tails.at(-1) ?? -1; i >= 0; i = pairs[i].previous)
		anchors.push(pairs[i]);
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
	for (const { original, current } of anchors.reverse()) {
		addUntil(original, current);
		oldStart = original + 1;
		newStart = current + 1;
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
	if ((base.caseListMap ?? null) !== (next.caseListMap ?? null))
		changes.caseListMap = next.caseListMap ?? null;
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

/** Carry a person's edits onto the team's newer revision. Each setting the
 * person changed from the revision they started on keeps their value; every
 * setting they left alone takes the team's. Each rule list is one setting,
 * because a reordered or edited list has no meaning spliced into another. */
export function rebasePreviewSearchValues(
	base: PreviewSearchValues,
	mine: PreviewSearchValues,
	latest: PreviewSearchValues,
): PreviewSearchValues {
	const same = (a: unknown, b: unknown) =>
		JSON.stringify(a) === JSON.stringify(b);
	const pick = <T>(before: T, edited: T, team: T) =>
		same(before, edited) ? team : edited;
	let propertyMatchers = latest.propertyMatchers;
	if (mine.propertyMatchers === null) {
		if (base.propertyMatchers !== null) propertyMatchers = null;
	} else if (!same(base.propertyMatchers, mine.propertyMatchers)) {
		const before = base.propertyMatchers;
		const team = latest.propertyMatchers;
		propertyMatchers = {
			fuzzyProperties: pick(
				before?.fuzzyProperties ?? [],
				mine.propertyMatchers.fuzzyProperties,
				team?.fuzzyProperties ?? [],
			),
			ignoredText: pick(
				before?.ignoredText ?? [],
				mine.propertyMatchers.ignoredText,
				team?.ignoredText ?? [],
			),
		};
	}
	const caseListMap = pick(
		base.caseListMap ?? null,
		mine.caseListMap ?? null,
		latest.caseListMap ?? null,
	);
	return {
		maximum: pick(base.maximum, mine.maximum, latest.maximum),
		timeZone: pick(base.timeZone, mine.timeZone, latest.timeZone),
		...(caseListMap === null ? {} : { caseListMap }),
		propertyMatchers,
	};
}
