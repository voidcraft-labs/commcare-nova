/**
 * Which conjuncts of a search's own filter the reader may join to the list filter of a menu whose
 * forms read the search (`rows.ts::classifySearchRows`, kind F, recorded as
 * `search-filter-joined-to-list`).
 *
 * After the join the search still sends the conjunct (a list filter clause is a row of the search
 * on such a menu), and the device's list filter, which runs over the cases the search answered
 * (`suite_xml/sections/entries.py::EntriesHelper.get_datum_meta_module` appends the list's filter
 * to the inline search's results instance in the datum's nodeset), runs it too. So the list a
 * worker sees is the one it was exactly where every case HQ's search returns for the conjunct is a
 * case the device keeps for it: HQ true implies the device true. Each shape below was read at the
 * pins in HQ's case search (`corehq/apps/case_search`, `corehq/apps/es/case_search.py`, the case
 * search index's mapping `corehq/apps/es/mappings/case_search_mapping.py`) and in Core's XPath
 * over the results instance.
 *
 * The two read different text. HQ stores and indexes a property's text as submitted, spaces at its
 * ends included (`xml2json`'s leaf text, `update_strategy.py::_apply_update_action`,
 * `pillows/case_search.py::_format_property`, a `value.exact` keyword with no normalizer), and
 * its results write that text (`casexml/apps/case/fixtures.py::CaseDBFixture`). Core trims every
 * value of the results it parses, Java `String.trim()`, the code units up to U+0020 at both ends
 * (`TreeElementParser.parse`, and `CaseXmlParser` and `BulkProcessingCaseXmlParser` on Web Apps'
 * indexed path). So a case HQ holds as `' '` is `''` on the device, and one HQ holds as
 * `'closed '` is `'closed'`; a test is admitted only where it holds of every stored text once
 * trimmed:
 *
 * - **A custom property of the searched case compared with a string literal by `=`**, the literal
 *   with no code unit up to U+0020 at either end. HQ's `_xpath_query` `=` is never fuzzy
 *   (`case_search/utils.py::CaseSearchQueryBuilder._build_filter_from_xpath` is called with
 *   `fuzzy=False` for it) and is an exact term on `case_properties.value.exact`, letter case
 *   included (`xpath_functions/comparison.py::_create_query`, `es/case_search.py::case_property_query`,
 *   `exact_case_property_text_query`), so the stored text is the literal, which the trim leaves as
 *   it is, and Core compares two strings as strings (`XPathEqExpr.testEquality`). A literal with
 *   a space at an end matches a stored text the device reads trimmed, and is not admitted. The
 *   blank literal is HQ's `case_property_missing` (the property unset or exactly `''`), which the
 *   device reads as `''`, since a missing element unpacks to `''`. Admitted.
 * - **The same by `!=`, or under `not`.** HQ's is the negation of the exact term
 *   (`comparison.py::_create_query`), true of a stored text the literal followed by a space, which
 *   the device trims to the literal. Not admitted, whatever the literal.
 * - **`is-blank` of such a property.** HQ's `case_property_missing`, unset or exactly `''`, both
 *   blank on the device. Admitted. Under `not`, HQ keeps a stored `' '`, which the device reads as
 *   blank. Not admitted.
 * - **`starts-with` of such a property and a string literal**, the literal with no code unit up to
 *   U+0020 at either end. HQ's prefix on the exact field
 *   (`xpath_functions/query_functions.py::starts_with`, `es/case_search.py::case_property_starts_with`),
 *   case-sensitive; Core's `XPathStartsWithFunc` compares the two strings. A stored text that
 *   starts with such a literal keeps it once trimmed. Admitted. A literal with a space at an end
 *   is not, and neither is a negation: a value longer than the exact field indexes matches no
 *   prefix in HQ and may start with it on the device.
 * - **Such a property compared by `=` with the worker's own information that Core holds trimmed**:
 *   the worker's record (`source: "worker-record"`, a case of the device's case database, whose
 *   values `CaseXmlParser` trims), and the session's `username` and `userid`
 *   (`SessionInstanceBuilder.addMetadata`), which hold no space. The device writes the value into
 *   the search's text and reads the same value in the list (none of these moves between the search
 *   and its list), so it is the literal case. Admitted. The session's user data is the restore's
 *   text as written (`UserXmlParser` trims none of it), so a value of it may end in a space. Not
 *   admitted.
 * - **`and`, `or`, `match-all` and `match-none` of admitted conjuncts.** HQ true of a conjunction
 *   is HQ true of each part, of a disjunction of some part. Admitted.
 * - **`not` of a conjunct.** HQ's `not` is the negation of its argument's filter
 *   (`query_functions.py::not_`, `filters.NOT`), and its `!=` is the same negation of `=`
 *   (`comparison.py::_create_query`), so a negation is read as its argument with each comparison
 *   turned over, and admitted where that reading is: `not` of `!=` is `=`, `not` of `and` and `or`
 *   is `or` and `and` of the negations, and `not` of `=`, of a blank test and of `starts-with` of
 *   a custom property is not admitted (above).
 * - **The case's type compared by `=` or `!=` with a case type or a string literal.** HQ reads the
 *   exact term of the type it indexes (`comparison.py::_create_system_query` over
 *   `INDEXED_METADATA_BY_KEY['@case_type']`, `type.exact`), and the device the `@case_type` of the
 *   case HQ answered, an attribute Core's parse does not trim, which is that type. Admitted,
 *   either way round and under `not`.
 * - **Any other standard property** (a case's name, owner, status, dates): HQ reads its own indexed
 *   metadata (`comparison.py::property_comparison_query`, `INDEXED_METADATA_BY_KEY`), dates by the
 *   project space's time zone (`_create_system_datetime_query`), where the device reads the
 *   results' own elements. Not admitted.
 * - **An `if` whose condition reads only literals and the worker's own information**, each branch
 *   admitted. The device evaluates the condition when it sends the search and again in the list
 *   over values that do not move between the two, so both take one branch. A condition over any
 *   other session value is not admitted: `drift` is set again from every answer the device gets
 *   (`CommCareNetworkServiceGenerator.driftInterceptor`), the search's own among them, and
 *   `window_width` and `applanguage` change with the worker's window and language.
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
import { normalizeCaseScalarTextValue } from "@/lib/domain/caseScalarText";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import type { Expression, PropertyRef, Term } from "@/lib/domain/expression";
import { searchSessionTextOrder } from "@/lib/domain/expression/ruleSets";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";

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
	/** A string literal Core's trim leaves as it is: no code unit up to U+0020 at either end. */
	const trimmedText = (operand: Expression) =>
		operand.kind === "term" &&
		operand.term.kind === "literal" &&
		operand.term.data_type === undefined &&
		typeof operand.term.value === "string" &&
		normalizeCaseScalarTextValue(operand.term.value) === operand.term.value;
	const worker = (operand: Expression) =>
		operand.kind === "term" && isTrimmedWorkerValue(operand.term);
	const typeValue = (operand: Expression) =>
		operand.kind === "term" &&
		(operand.term.kind === "case-type" ||
			(operand.term.kind === "literal" &&
				operand.term.data_type === undefined &&
				typeof operand.term.value === "string"));
	const rowType = (operand: Expression) =>
		operand.kind === "term" && operand.term.kind === "case-row-type";
	const typeTest = (left: Expression, right: Expression) =>
		(rowType(left) && typeValue(right)) || (rowType(right) && typeValue(left));
	const equal = (left: Expression, right: Expression) =>
		(ownText(left) && (trimmedText(right) || worker(right))) ||
		(ownText(right) && (trimmedText(left) || worker(left))) ||
		typeTest(left, right);
	// A custom property unequal to a value is true in HQ of the value followed by a space, which the
	// device trims to the value, so only the case's type is admitted unequal.
	const unequal = typeTest;
	/** Whether `node` reads alike, or, where `negated`, whether its negation does. */
	const alike = (node: Expression, negated: boolean): boolean => {
		switch (node.kind) {
			case "match-all":
			case "match-none":
				return true;
			case "and":
			case "or":
				return node.clauses.every((clause) => alike(clause, negated));
			case "not":
				return alike(node.clause, !negated);
			case "eq":
				return negated
					? unequal(node.left, node.right)
					: equal(node.left, node.right);
			case "neq":
				return negated
					? equal(node.left, node.right)
					: unequal(node.left, node.right);
			case "is-blank":
				return !negated && ownText(node.left);
			case "match":
				return (
					!negated &&
					node.mode === "starts-with" &&
					ownText(node.property) &&
					trimmedText(node.value)
				);
			case "if":
				return (
					steady(node.cond) &&
					alike(node.then, negated) &&
					alike(node.else, negated)
				);
			default:
				return false;
		}
	};
	return alike(conjunct, false);
}

/** The session's values that name the signed-in worker (`SessionInstanceBuilder.addMetadata`). */
const WORKER_CONTEXT_FIELDS: ReadonlySet<string> = new Set([
	"username",
	"userid",
]);

/** Whether `term` is the worker's own information as Core holds it trimmed: a value of the worker's
 *  record, which the device's case database holds as `CaseXmlParser` trimmed it, or the session's
 *  user name or id, which hold no space. The session's user data is the restore's text as written
 *  (`UserXmlParser`). */
function isTrimmedWorkerValue(term: Term): boolean {
	return (
		((term.kind === "session-user" || term.kind === "session-user-property") &&
			term.source === "worker-record") ||
		(term.kind === "session-context" && WORKER_CONTEXT_FIELDS.has(term.field))
	);
}

/** Whether `term` is the worker's own information, which does not move between the search and its
 *  list. */
function isWorkerValue(term: Term): boolean {
	return (
		term.kind === "session-user" ||
		term.kind === "session-user-property" ||
		(term.kind === "session-context" && WORKER_CONTEXT_FIELDS.has(term.field))
	);
}

/** Whether a device gives `condition` one value when it sends the search and in the list after:
 *  a comparison, `and`, `or` or `not` of literals and the worker's own information. */
function steady(condition: Expression): boolean {
	switch (condition.kind) {
		case "term":
			return condition.term.kind === "literal" || isWorkerValue(condition.term);
		case "match-all":
		case "match-none":
			return true;
		case "and":
		case "or":
			return condition.clauses.every(steady);
		case "not":
			return steady(condition.clause);
		case "eq":
		case "neq":
		case "lt":
		case "lte":
		case "gt":
		case "gte":
			return (
				searchSessionTextOrder(
					condition.kind,
					condition.left,
					condition.right,
				) ||
				(steady(condition.left) && steady(condition.right))
			);
		default:
			return false;
	}
}
