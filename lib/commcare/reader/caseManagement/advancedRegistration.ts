import { NO_ENTRIES } from "@/lib/domain/records";
import { isJsonObject } from "../jsonCursor";

type JsonObject = Readonly<Record<string, unknown>>;

function object(value: unknown): JsonObject {
	return isJsonObject(value) ? value : NO_ENTRIES;
}

/** HQ's AdvancedForm.is_registration_form(module.case_type) and the root open
 * that can supply Nova's single newly created case. An unlinked repeated open
 * can qualify in HQ but does not provide an own case for the entry. */
export function registrationOpenIndex(
	opens: readonly unknown[],
	loads: readonly unknown[],
	caseType: string,
): number {
	const rows = opens.map(object);
	const parents = (action: JsonObject): string[] => {
		if (Array.isArray(action.case_indices))
			return action.case_indices.map((index) => {
				const tag = object(index).tag;
				return typeof tag === "string" ? tag : "";
			});
		const tag = object(action.case_index).tag;
		return typeof tag === "string" && tag ? [tag] : [];
	};
	const candidates = rows.flatMap((action, index) =>
		action.case_type === caseType &&
		(!parents(action).length || !action.repeat_context)
			? [index]
			: [],
	);
	const only = candidates[0];
	if (
		candidates.length !== 1 ||
		only === undefined ||
		rows[only].repeat_context
	)
		return -1;
	const manual = loads.map(object).filter((action) => !action.auto_select);
	if (!manual.length) return only;
	const indexed = parents(rows[only]);
	if (!indexed.length) return -1;
	const byTag = new Map(
		[...loads.map(object), ...rows].map((action) => [action.case_tag, action]),
	);
	byTag.delete(rows[only].case_tag);
	const pending = indexed.reverse();
	while (pending.length) {
		const tag = pending.pop();
		if (!tag) {
			if ([...byTag.values()].some((action) => !action.auto_select)) return -1;
			continue;
		}
		const parent = byTag.get(tag);
		if (!parent) return -1;
		byTag.delete(tag);
		const edges = parents(parent);
		for (let i = edges.length - 1; i >= 0; i--) pending.push(edges[i]);
	}
	return only;
}
