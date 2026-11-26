import { z } from "zod";
import {
	caseTypeNameSchema,
	conditionSchema,
	valueSchema,
} from "./expression/types";
import { type Uuid, uuidSchema } from "./uuid";

// The Details tab schema and its span arithmetic. `modules.ts` composes the
// case list schema from this file, so it imports nothing that reaches back to
// `modules.ts` at module load; the helpers that read a whole case list live in
// `detailTabs.ts`.

export const detailTabRowSourceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("children"),
		caseType: caseTypeNameSchema,
		condition: conditionSchema.optional(),
	}),
	z.strictObject({
		kind: z.literal("records"),
		rows: valueSchema,
		includeChildrenOfType: caseTypeNameSchema.optional(),
	}),
]);
export type DetailTabRowSource = z.infer<typeof detailTabRowSourceSchema>;

/** A title belongs to its tab. The first visible detail field anchors its
 * section when unrelated columns are renamed, hidden or rearranged. */
export const detailTabSchema = z.strictObject({
	uuid: uuidSchema,
	title: z.string().trim().min(1),
	startColumnUuid: uuidSchema,
	displayCondition: conditionSchema.optional(),
	rowSource: detailTabRowSourceSchema.optional(),
	orderFields: z.array(uuidSchema).min(1).optional(),
});
export type DetailTab = z.infer<typeof detailTabSchema>;
/** A search-enabled menu requests these related children in its worker
 * result instance, even when its tab shows a separate explicit collection. */
export function detailTabSearchChildType(
	tab: Pick<DetailTab, "rowSource">,
): string | undefined {
	const source = tab.rowSource;
	return source?.kind === "children"
		? source.caseType
		: source?.includeChildrenOfType;
}

export const detailTabsSchema = z.array(detailTabSchema).min(1);

export interface DetailTabSpan {
	readonly tab: DetailTab;
	readonly start: number;
	readonly end: number;
}

/** Every shown column belongs to exactly one populated tab. Indices are
 * derived only over the columns that are actually emitted on Details. */
export function detailTabSpans(
	tabs: readonly DetailTab[],
	columns: readonly { readonly uuid: Uuid }[],
): DetailTabSpan[] | undefined {
	if (tabs.length === 0) return [];
	const positions = new Map(columns.map(({ uuid }, i) => [uuid, i]));
	const seen = new Set<Uuid>();
	const spans: DetailTabSpan[] = [];
	let end = columns.length;
	for (let i = tabs.length - 1; i >= 0; i--) {
		const tab = tabs[i];
		const start = positions.get(tab.startColumnUuid);
		if (seen.has(tab.uuid) || start === undefined || start >= end)
			return undefined;
		seen.add(tab.uuid);
		spans.push({ tab, start, end });
		end = start;
	}
	return end === 0 ? spans.reverse() : undefined;
}
