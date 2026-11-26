import {
	type SearchInputDef,
	type SearchInputGroup,
	searchInputGroupLabelUnitId,
	searchInputGroupsWithMembers,
} from "@/lib/domain";
import { el } from "../../elementBuilders";

/** Each group key follows the row positions written by HQ's Case List editor. */
export function groupedSearchWire(
	searchInputs: readonly SearchInputDef[],
	searchInputGroups: readonly SearchInputGroup[] | undefined,
) {
	let row = 0;
	return searchInputGroupsWithMembers({ searchInputs, searchInputGroups }).map(
		(group) => {
			const key = `group_header_${row}`;
			row += 1 + group.inputs.length;
			return {
				...group,
				key,
				labelUnit: searchInputGroupLabelUnitId(group.uuid),
			};
		},
	);
}

export function searchGroupElement(moduleId: string, key: string) {
	const localeId = `search_property.${moduleId}.${key}`;
	return {
		localeId,
		element: el("group", { key }, [
			el("display", {}, [el("text", {}, [el("locale", { id: localeId })])]),
		]),
	};
}
