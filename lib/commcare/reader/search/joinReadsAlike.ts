/**
 * Which conjuncts of a search's own filter the reader may join to the list filter of a menu whose
 * forms read the search (`rows.ts::classifySearchRows`, kind F, recorded as
 * `search-filter-joined-to-list`).
 *
 * After the join the search still sends the conjunct (a list filter clause is a row of the search
 * on such a menu), and the device's list filter, which runs over the cases the search answered
 * (`suite_xml/sections/entries.py::EntriesHelper.get_datum_meta_module` appends the list's filter
 * to the inline search's results instance in the datum's nodeset), runs it too. So the list a worker sees is the one it was exactly where every case HQ's
 * search returns for the conjunct is a case the device keeps for it: HQ true implies the device
 * true. Each shape below was read at the pins in HQ's case search (`corehq/apps/case_search`,
 * `corehq/apps/es/case_search.py`, the case search index's mapping
 * `corehq/apps/es/mappings/case_search_mapping.py`) and in Core's XPath over the results instance:
 *
 * - **A custom property of the searched case compared with a string literal by `=`.** HQ's
 *   `_xpath_query` `=` is never fuzzy (`case_search/utils.py::CaseSearchQueryBuilder._build_filter_from_xpath`
 *   is called with `fuzzy=False` for it) and is an exact term on `case_properties.value.exact`, letter
 *   case included (`xpath_functions/comparison.py::_create_query`, `es/case_search.py::case_property_query`,
 *   `exact_case_property_text_query`); the case HQ answers holds that text
 *   (`casexml/apps/case/fixtures.py::CaseDBFixture`), and Core compares two strings as strings
 *   (`XPathEqExpr.testEquality`). Admitted. The blank literal is HQ's `case_property_missing` (the
 *   property unset or `''`), which Core reads alike, since a missing element unpacks to `''`.
 * - **The same by `!=`.** HQ's is the negation of the exact term (`comparison.py::_create_query`),
 *   true also where the value is longer than the exact field indexes (`ignore_above` 8191), which
 *   can equal only a literal that long. Admitted for a literal of at most 8191 characters.
 * - **`is-blank` of such a property.** HQ's `case_property_missing`, read alike. Admitted.
 * - **`starts-with` of such a property and a string literal.** HQ's prefix on the exact field
 *   (`xpath_functions/query_functions.py::starts_with`, `es/case_search.py::case_property_starts_with`),
 *   case-sensitive; Core's `XPathStartsWithFunc` compares the two strings. Admitted.
 * - **Such a property compared by `=` with the worker's own information.** The device writes the
 *   value into the search's text and reads the same value in the list (a session value does not
 *   move between the search and its list), so it is the literal case. Admitted.
 * - **`and`, `or`, `match-all` and `match-none` of admitted conjuncts.** HQ true of a conjunction
 *   is HQ true of each part, of a disjunction of some part. Admitted.
 * - **`not` of a conjunct.** Needs the converse too (device true implies HQ true), which fails
 *   where the exact field does not index a value (`ignore_above`) or the device reads a value the
 *   index does not. Not admitted.
 * - **A standard property** (a case's name, owner, status, dates): HQ reads its own indexed
 *   metadata (`comparison.py::property_comparison_query`, `INDEXED_METADATA_BY_KEY`), dates by the
 *   project space's time zone (`_create_system_datetime_query`), where the device reads the
 *   results' own elements. Not admitted.
 * - **A property read through a related case** (`ancestor-exists`, `subcase-exists`,
 *   `subcase-count`, `parent/<property>`): HQ reads every case of the project space's index
 *   (`xpath_functions/ancestor_functions.py`, `subcase_functions.py`), the device only the related
 *   cases its instance holds (`xpath/wire/rowScope.ts::immediateRelationPresence`), which a case HQ
 *   returned need not bring. Not admitted.
 * - **A number or a date compared, by any operator**: HQ's numeric and date subfields
 *   (`case_property_numeric_range`, `case_property_date_range`, `ignore_malformed`, the index's
 *   date formats) against Core's own conversions of the text (`FunctionUtils.toNumeric`, its date
 *   parsing); and `today()`, which HQ reads as the project space's day
 *   (`xpath_functions/value_functions.py`) and the device as its own. Not admitted.
 * - **A typed property compared with text** (a number, a date or a date and time): the device
 *   compares by the type and HQ by the text. Not admitted.
 * - **A match of several values** (`selected-any`, `selected-all`): HQ's analyzed match on
 *   `case_properties.value` (`query_functions.py::_selected_query`, `case_property_text_query`),
 *   which lowers letter case and splits on punctuation, where Core's `selected` splits on spaces
 *   and keeps case. Not admitted.
 * - **Fuzzy, phonetic and fuzzy-date matching**, and any comparison HQ's search makes fuzzy for a
 *   property: a device runs none of them (`csql/matchModes.ts`), so the list filter cannot hold
 *   one. Not admitted.
 * - **A distance** (`within-distance`): HQ's `geo_distance` over `geopoint_value`, filled only for
 *   a property the project space types as a location (`pillows/case_search.py::_add_smart_types`),
 *   against Core's own distance. Not admitted.
 *
 * Anything else is not admitted: the reader keeps such a conjunct in the search where an excluded
 * field holds it, and refuses it otherwise.
 */

import type { BlueprintDoc } from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import type { Expression, PropertyRef, Term } from "@/lib/domain/expression";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";

/** The longest value the case search index's exact field holds (`case_search_mapping.py`, `ignore_above`). */
const EXACT_INDEXED_LENGTH = 8191;

/** The property types whose comparison with text a device makes as text. */
const TEXT_TYPES: ReadonlySet<string | undefined> = new Set([
	undefined,
	"text",
	"single_select",
]);

/** Whether a case HQ's search returns for `conjunct` is one the device's list filter keeps for it, on
 *  a menu of `caseType` in `doc` (the module's doc comment). */
export function joinReadsAlike(
	conjunct: Expression,
	doc: BlueprintDoc,
	caseType: string,
): boolean {
	const types = effectiveCaseTypes(doc).find((one) => one.name === caseType);
	const ownText = (operand: Expression | PropertyRef): boolean => {
		const ref =
			operand.kind === "prop"
				? operand
				: operand.kind === "term" && operand.term.kind === "prop"
					? operand.term
					: undefined;
		if (
			ref === undefined ||
			ref.via !== undefined ||
			ref.caseType !== caseType ||
			isStandardCaseListProperty(ref.property)
		)
			return false;
		const declared = types?.properties.find(
			(property) => property.name === ref.property,
		);
		return TEXT_TYPES.has(declared?.data_type);
	};
	const text = (operand: Expression, longest = Number.POSITIVE_INFINITY) =>
		operand.kind === "term" &&
		operand.term.kind === "literal" &&
		operand.term.data_type === undefined &&
		typeof operand.term.value === "string" &&
		operand.term.value.length <= longest;
	const worker = (operand: Expression) =>
		operand.kind === "term" && isWorkerValue(operand.term);
	const alike = (node: Expression): boolean => {
		switch (node.kind) {
			case "match-all":
			case "match-none":
				return true;
			case "and":
			case "or":
				return node.clauses.every(alike);
			case "eq":
				return (
					(ownText(node.left) && (text(node.right) || worker(node.right))) ||
					(ownText(node.right) && (text(node.left) || worker(node.left)))
				);
			case "neq":
				return (
					(ownText(node.left) && text(node.right, EXACT_INDEXED_LENGTH)) ||
					(ownText(node.right) && text(node.left, EXACT_INDEXED_LENGTH))
				);
			case "is-blank":
				return ownText(node.left);
			case "match":
				return (
					node.mode === "starts-with" &&
					ownText(node.property) &&
					text(node.value)
				);
			default:
				return false;
		}
	};
	return alike(conjunct);
}

function isWorkerValue(term: Term): boolean {
	return term.kind === "session-user" || term.kind === "session-user-property";
}
