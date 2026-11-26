import type {
	LookupColumn,
	LookupMember,
	LookupRowContent,
} from "@/lib/lookup/types";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

export function contentOf(row: LookupRowContent): LookupRowContent {
	return {
		...(row.attributes &&
			Object.keys(row.attributes).length > 0 && { attributes: row.attributes }),
		...(row.occurrences &&
			Object.keys(row.occurrences).length > 0 && {
				occurrences: row.occurrences,
			}),
	};
}

export function sameRowContent(
	left: LookupRowContent,
	right: LookupRowContent,
) {
	return (
		canonicalJsonText(contentOf(left)) === canonicalJsonText(contentOf(right))
	);
}

/** Reconcile by member identity. Keep all removed text available for recovery. */
export function reconcileRichRow(
	draft: LookupRowContent,
	columns: readonly LookupColumn[],
	attributes: readonly LookupMember[],
	current?: LookupRowContent,
): { content: LookupRowContent; removed: boolean } {
	const retainedAttributes = Object.fromEntries(
		attributes.flatMap((member) => {
			const text = draft.attributes?.[member.id];
			return text === undefined ? [] : [[member.id, text]];
		}),
	);
	const occurrences = Object.fromEntries(
		columns.flatMap((column) => {
			const values = draft.occurrences?.[column.id];
			if (!column.repeated || values === undefined) return [];
			const propertyIds = new Set<string>(
				(column.properties ?? []).map((member) => member.id),
			);
			return [
				[
					column.id,
					values.map((item) => ({
						text: item.text,
						properties: Object.fromEntries(
							Object.entries(item.properties).filter(([id]) =>
								propertyIds.has(id),
							),
						),
					})),
				],
			];
		}),
	);
	const retained = { attributes: retainedAttributes, occurrences };
	const result = {
		attributes: Object.fromEntries(
			attributes.map((member) => [
				member.id,
				draft.attributes?.[member.id] ?? current?.attributes?.[member.id] ?? "",
			]),
		),
		occurrences,
	};
	return {
		content: contentOf(result),
		removed: !sameRowContent(draft, retained),
	};
}
