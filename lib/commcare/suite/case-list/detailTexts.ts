/**
 * The texts HQ's build gives every case list's short detail, one constant
 * each, so the HQ JSON and the local archive cannot drift apart.
 *
 * HQ writes `<select_text>` on every short detail of an app at CommCare 2.54
 * or later (`suite_xml/sections/details.py::add_select_text_to_detail`,
 * `feature_support.py::supports_select_text`), and `<no_items_text>` where the
 * project space also holds `USH_EMPTY_CASE_LIST_TEXT`
 * (`::add_no_items_text_to_detail`, `::supports_empty_case_list_text`). Each
 * locale's string is the detail's stored text through `clean_trans`, whose
 * model defaults are these (`models/case_list.py::Detail.select_text`,
 * `::no_items_text`).
 */

/** The select button's text, `m<N>_select_text`. */
export const SELECT_TEXT = "Continue";

/** An empty list's text, `m<N>_no_items_text`. */
export const EMPTY_CASE_LIST_TEXT = "List is empty.";

/** HQ's locale id for a menu's select button text (`id_strings.py::select_text_detail`). */
export function selectTextLocaleId(moduleIndex: number): string {
	return `m${moduleIndex}_select_text`;
}

/** HQ's locale id for a menu's empty-list text (`id_strings.py::no_items_text_detail`). */
export function emptyCaseListTextLocaleId(moduleIndex: number): string {
	return `m${moduleIndex}_no_items_text`;
}
