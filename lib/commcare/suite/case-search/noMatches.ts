/**
 * The wire constants of the no-matches registration form, shared by the
 * local suite compiler and the HQ-JSON expander so the two paths cannot
 * drift (`docs/architecture/complex-apps.md` § Register when nothing matches).
 */

/** `module_filter` / `<menu relevant>` of the hidden module that owns the
 *  form (`menus.py::_generate_menu` lowers the one to the other). */
export const NEVER_RELEVANT = "false()";

/**
 * The Register action's relevancy: the inline search found nothing. Read
 * only after the query ran (an inline entry always runs it before the
 * detail shows), so the instance exists; an explicit comparison because
 * `Action.isRelevant` string-compares the evaluated result to "true".
 */
export const NO_MATCHES_RELEVANCY =
	"count(instance('results:inline')/results/case) = 0";

/** The inline search's answers instance, `search-input:<storage>`
 *  (`VirtualInstances.makeSearchInputInstanceID`). */
export const INLINE_SEARCH_INPUT_INSTANCE_ID = "search-input:results:inline";
