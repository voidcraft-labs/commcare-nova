/**
 * What each outcome of the expression stage becomes: the manifest entry a
 * held slot is claimed under, and the entry a refusal claims, by slot, by
 * parse issue and by checker code. Every entry id this stage can answer is a
 * member of `EXPRESSION_CLAIMS`, declared once through `defineClaims`, and the
 * tables answer members, never a string, so an id cannot be answered without
 * being registered and held to the manifest by `claimsBindManifest.test.ts`.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { AUTHORED_CASE_PROPERTY_NAME_PATTERN } from "@/lib/domain/casePropertyName";
import {
	formFieldPath,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type {
	CheckError,
	CheckErrorCode,
} from "@/lib/domain/expression/typeChecker";
import {
	type CheckPath,
	type Expression,
	isProseSlotRef,
	type SlotContextRef,
	type Term,
	XML_ELEMENT_NAME_PATTERN,
} from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { formOfField } from "@/lib/domain/fieldForm";
import { menuScreenOf, screenChoosesCaseFirst } from "@/lib/domain/menuScreens";
import { moduleFormsReadSearch } from "@/lib/domain/modules";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { canonicalProseAtom } from "@/lib/domain/proseExpression";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import { expressionSlotValue } from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import { inventoryIndex } from "../../surface/inventory";
import { rethrowWorkStop } from "../../workMeter";
import type { FormParseIssue } from "../../xpath/formParseIssues";
import type { FormSyntax } from "../../xpath/formSyntax";
import { visitSyntax } from "../../xpath/formSyntax";
import { declaredInstance, instanceForRead } from "../../xpath/instanceSources";
import { parser } from "../../xpath/parser";
import { defineClaims, drop, refuse, take } from "../claims";
import { sameJson } from "../jsonCursor";
import type { PendingExpression } from "../pendingExpressions";
import { readFormSyntax } from "../syntaxRead";
import {
	locationDataNameRefused,
	workerDataNameRefused,
} from "../worldEntities";
import { absolutePathText, contextPathText } from "./folds";

/** The name of every expression slot a registration can stand in. */
export type SlotName = SlotContextRef["slot"];

/**
 * One member per entry and surface key this stage answers: the entry's id less
 * its area, and `@<key>` after it where the entry is answered under more than
 * one key. Its use is the one its standing permits: `take` for HELD, `drop`
 * for INERT, `refuse` for HELD-NEW and REFUSED.
 */
export const EXPRESSION_CLAIMS = defineClaims("expressions", {
	"case-list-action-condition": take(
		"menus-and-case-lists/case-list-form-relevancy-expression-with-followup-forms-as-case",
		"schema:CaseListForm.relevancy_expression",
	),
	"navigation-condition-outside-typed-worker-context": refuse(
		"menus-and-case-lists/navigation-condition-outside-typed-worker-context",
		"schema:Module.module_filter",
	),
	"form-badge": take(
		"forms-and-case-writes/custom-icons-0",
		"schema:CustomIcon.xpath",
	),
	"module-badge": take(
		"menus-and-case-lists/custom-icons-0-badge-localized-text-or-xpath",
		"schema:CustomIcon.xpath",
	),
	"badge-calculation-outside-typed-values": refuse(
		"menus-and-case-lists/badge-calculation-outside-typed-values",
		"schema:CustomIcon.xpath",
	),
	"search-button-display-condition-lifting-into-predicate": take(
		"case-search/search-button-display-condition-lifting-into-predicate",
		"schema:CaseSearch.search_button_display_condition",
	),
	"search-button-display-condition-outside-predicate": refuse(
		"case-search/search-button-display-condition-outside-predicate",
		"schema:CaseSearch.search_button_display_condition",
	),
	"blacklisted-owner-ids-expression-lifting-into-valueexpression": take(
		"case-search/blacklisted-owner-ids-expression-lifting-into-valueexpression",
		"schema:CaseSearch.blacklisted_owner_ids_expression",
	),
	"blacklisted-owner-ids-expression-outside-valueexpression": refuse(
		"case-search/blacklisted-owner-ids-expression-outside-valueexpression",
		"schema:CaseSearch.blacklisted_owner_ids_expression",
	),
	"itemset-nodeset-filter-predicate-lifting-into-predicate": take(
		"case-search/itemset-nodeset-filter-predicate-lifting-into-predicate",
		"schema:Itemset.nodeset",
	),
	"itemset-nodeset-filter-predicate-outside-predicate": refuse(
		"case-search/itemset-nodeset-filter-predicate-outside-predicate",
		"schema:Itemset.nodeset",
	),
	"default-value-lifting-into-valueexpression": take(
		"case-search/default-value-lifting-into-valueexpression",
		"schema:CaseSearchProperty.default_value",
	),
	"default-value-outside-valueexpression": refuse(
		"case-search/default-value-outside-valueexpression",
		"schema:CaseSearchProperty.default_value",
	),
	"required-test-text": take(
		"case-search/required-test-text",
		"schema:CaseSearchProperty.required",
	),
	"validations-0-test-text": take(
		"case-search/validations-0-test-text",
		"schema:CaseSearchProperty.validations",
	),
	"required-or-validation-test-reading-the-case": refuse(
		"case-search/required-or-validation-test-reading-the-case",
		"schema:Assertion.test",
	),
	"required-or-validation-test-outside-what-nova-types": refuse(
		"case-search/required-or-validation-test-outside-what-nova-types",
		"schema:Assertion.test",
	),
	"and-or-parentheses@csql-op:and": take(
		"case-search/and-or-parentheses",
		"csql-op:and",
	),
	"and-or-parentheses@csql-op:or": take(
		"case-search/and-or-parentheses",
		"csql-op:or",
	),
	"not-q": take("case-search/not-q", "csql-fn:not"),
	"match-all-match-none@csql-fn:match-all": take(
		"case-search/match-all-match-none",
		"csql-fn:match-all",
	),
	"match-all-match-none@csql-fn:match-none": take(
		"case-search/match-all-match-none",
		"csql-fn:match-none",
	),
	"p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v@csql-op:=":
		take(
			"case-search/p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v",
			"csql-op:=",
		),
	"p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v@csql-op:!=":
		take(
			"case-search/p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v",
			"csql-op:!=",
		),
	"p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v@csql-op:>":
		take(
			"case-search/p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v",
			"csql-op:>",
		),
	"p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v@csql-op:>=":
		take(
			"case-search/p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v",
			"csql-op:>=",
		),
	"p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v@csql-op:<":
		take(
			"case-search/p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v",
			"csql-op:<",
		),
	"p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v@csql-op:<=":
		take(
			"case-search/p-v-p-v-literal-value-function-or-runtime-value-and-p-v-p-v-p-v",
			"csql-op:<=",
		),
	"p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of@csql-op:>":
		refuse(
			"case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of",
			"csql-op:>",
		),
	"p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of@csql-op:>=":
		refuse(
			"case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of",
			"csql-op:>=",
		),
	"p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of@csql-op:<":
		refuse(
			"case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of",
			"csql-op:<",
		),
	"p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of@csql-op:<=":
		refuse(
			"case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of",
			"csql-op:<=",
		),
	"p-where-p-is-not-date-opened-closed-on-or-last-modified": take(
		"case-search/p-where-p-is-not-date-opened-closed-on-or-last-modified",
		"csql-op:=",
	),
	"date-opened-closed-on-or-last-modified-compared-with-any@csql-metadata:date_opened":
		refuse(
			"case-search/date-opened-closed-on-or-last-modified-compared-with-any",
			"csql-metadata:date_opened",
		),
	"date-opened-closed-on-or-last-modified-compared-with-any@csql-metadata:closed_on":
		refuse(
			"case-search/date-opened-closed-on-or-last-modified-compared-with-any",
			"csql-metadata:closed_on",
		),
	"date-opened-closed-on-or-last-modified-compared-with-any@csql-metadata:last_modified":
		refuse(
			"case-search/date-opened-closed-on-or-last-modified-compared-with-any",
			"csql-metadata:last_modified",
		),
	"metadata-case-id-owner-id-status-name-case-name-external-id-date@csql-metadata:date_opened":
		take(
			"case-search/metadata-case-id-owner-id-status-name-case-name-external-id-date",
			"csql-metadata:date_opened",
		),
	"metadata-case-id-owner-id-status-name-case-name-external-id-date@csql-metadata:last_modified":
		take(
			"case-search/metadata-case-id-owner-id-status-name-case-name-external-id-date",
			"csql-metadata:last_modified",
		),
	"metadata-case-id-owner-id-status-name-case-name-external-id-date@csql-metadata:@case_id":
		take(
			"case-search/metadata-case-id-owner-id-status-name-case-name-external-id-date",
			"csql-metadata:@case_id",
		),
	"metadata-case-id-owner-id-status-name-case-name-external-id-date@csql-metadata:@owner_id":
		take(
			"case-search/metadata-case-id-owner-id-status-name-case-name-external-id-date",
			"csql-metadata:@owner_id",
		),
	"metadata-case-id-owner-id-status-name-case-name-external-id-date@csql-metadata:@status":
		take(
			"case-search/metadata-case-id-owner-id-status-name-case-name-external-id-date",
			"csql-metadata:@status",
		),
	"metadata-case-id-owner-id-status-name-case-name-external-id-date@csql-metadata:name":
		take(
			"case-search/metadata-case-id-owner-id-status-name-case-name-external-id-date",
			"csql-metadata:name",
		),
	"metadata-case-id-owner-id-status-name-case-name-external-id-date@csql-metadata:case_name":
		take(
			"case-search/metadata-case-id-owner-id-status-name-case-name-external-id-date",
			"csql-metadata:case_name",
		),
	"metadata-case-id-owner-id-status-name-case-name-external-id-date@csql-metadata:external_id":
		take(
			"case-search/metadata-case-id-owner-id-status-name-case-name-external-id-date",
			"csql-metadata:external_id",
		),
	"metadata-closed-on": take(
		"case-search/metadata-closed-on",
		"csql-metadata:closed_on",
	),
	"authored-case-type-comparisons-other-than-a-hop-qualifier": take(
		"case-search/authored-case-type-comparisons-other-than-a-hop-qualifier",
		"csql-metadata:@case_type",
	),
	"date-only-comparison-on-date-opened-closed-on-last-modified@csql-metadata:date_opened":
		refuse(
			"case-search/date-only-comparison-on-date-opened-closed-on-last-modified",
			"csql-metadata:date_opened",
		),
	"date-only-comparison-on-date-opened-closed-on-last-modified@csql-metadata:closed_on":
		refuse(
			"case-search/date-only-comparison-on-date-opened-closed-on-last-modified",
			"csql-metadata:closed_on",
		),
	"date-only-comparison-on-date-opened-closed-on-last-modified@csql-metadata:last_modified":
		refuse(
			"case-search/date-only-comparison-on-date-opened-closed-on-last-modified",
			"csql-metadata:last_modified",
		),
	"date-v-string-date-datetime-v-string@csql-fn:date": take(
		"case-search/date-v-string-date-datetime-v-string",
		"csql-fn:date",
	),
	"date-v-string-date-datetime-v-string@csql-fn:datetime": take(
		"case-search/date-v-string-date-datetime-v-string",
		"csql-fn:datetime",
	),
	"date-int-datetime-number-epoch-days@csql-fn:date": take(
		"case-search/date-int-datetime-number-epoch-days",
		"csql-fn:date",
	),
	"date-int-datetime-number-epoch-days@csql-fn:datetime": take(
		"case-search/date-int-datetime-number-epoch-days",
		"csql-fn:datetime",
	),
	"double-v-today-now@csql-fn:double": take(
		"case-search/double-v-today-now",
		"csql-fn:double",
	),
	"double-v-today-now@csql-fn:today": take(
		"case-search/double-v-today-now",
		"csql-fn:today",
	),
	"double-v-today-now@csql-fn:now": take(
		"case-search/double-v-today-now",
		"csql-fn:now",
	),
	"date-add-d-interval-n-datetime-add@csql-fn:date-add": take(
		"case-search/date-add-d-interval-n-datetime-add",
		"csql-fn:date-add",
	),
	"date-add-d-interval-n-datetime-add@csql-fn:datetime-add": take(
		"case-search/date-add-d-interval-n-datetime-add",
		"csql-fn:datetime-add",
	),
	"unwrap-list": take("case-search/unwrap-list", "csql-fn:unwrap-list"),
	"selected-p-v-selected-any-selected-all-with-a-literal-v@csql-fn:selected":
		take(
			"case-search/selected-p-v-selected-any-selected-all-with-a-literal-v",
			"csql-fn:selected",
		),
	"selected-p-v-selected-any-selected-all-with-a-literal-v@csql-fn:selected-any":
		take(
			"case-search/selected-p-v-selected-any-selected-all-with-a-literal-v",
			"csql-fn:selected-any",
		),
	"selected-p-v-selected-any-selected-all-with-a-literal-v@csql-fn:selected-all":
		take(
			"case-search/selected-p-v-selected-any-selected-all-with-a-literal-v",
			"csql-fn:selected-all",
		),
	"selected-with-a-runtime-assembled-v@csql-fn:selected": take(
		"case-search/selected-with-a-runtime-assembled-v",
		"csql-fn:selected",
	),
	"selected-with-a-runtime-assembled-v@csql-fn:selected-any": take(
		"case-search/selected-with-a-runtime-assembled-v",
		"csql-fn:selected-any",
	),
	"selected-with-a-runtime-assembled-v@csql-fn:selected-all": take(
		"case-search/selected-with-a-runtime-assembled-v",
		"csql-fn:selected-all",
	),
	"starts-with-fuzzy-match-phonetic-match-fuzzy-date@csql-fn:starts-with": take(
		"case-search/starts-with-fuzzy-match-phonetic-match-fuzzy-date",
		"csql-fn:starts-with",
	),
	"starts-with-fuzzy-match-phonetic-match-fuzzy-date@csql-fn:fuzzy-match": take(
		"case-search/starts-with-fuzzy-match-phonetic-match-fuzzy-date",
		"csql-fn:fuzzy-match",
	),
	"starts-with-fuzzy-match-phonetic-match-fuzzy-date@csql-fn:phonetic-match":
		take(
			"case-search/starts-with-fuzzy-match-phonetic-match-fuzzy-date",
			"csql-fn:phonetic-match",
		),
	"starts-with-fuzzy-match-phonetic-match-fuzzy-date@csql-fn:fuzzy-date": take(
		"case-search/starts-with-fuzzy-match-phonetic-match-fuzzy-date",
		"csql-fn:fuzzy-date",
	),
	"within-distance-in-miles-kilometers-with-static-radius@csql-fn:within-distance":
		take(
			"case-search/within-distance-in-miles-kilometers-with-static-radius",
			"csql-fn:within-distance",
		),
	"within-distance-in-miles-kilometers-with-static-radius@csql-unit:miles":
		take(
			"case-search/within-distance-in-miles-kilometers-with-static-radius",
			"csql-unit:miles",
		),
	"within-distance-in-miles-kilometers-with-static-radius@csql-unit:kilometers":
		take(
			"case-search/within-distance-in-miles-kilometers-with-static-radius",
			"csql-unit:kilometers",
		),
	"within-distance-in-yards-feet-inch-meters-centimeters@csql-fn:within-distance":
		take(
			"case-search/within-distance-in-yards-feet-inch-meters-centimeters",
			"csql-fn:within-distance",
		),
	"within-distance-in-yards-feet-inch-meters-centimeters@csql-unit:yards": take(
		"case-search/within-distance-in-yards-feet-inch-meters-centimeters",
		"csql-unit:yards",
	),
	"within-distance-in-yards-feet-inch-meters-centimeters@csql-unit:feet": take(
		"case-search/within-distance-in-yards-feet-inch-meters-centimeters",
		"csql-unit:feet",
	),
	"within-distance-in-yards-feet-inch-meters-centimeters@csql-unit:inch": take(
		"case-search/within-distance-in-yards-feet-inch-meters-centimeters",
		"csql-unit:inch",
	),
	"within-distance-in-yards-feet-inch-meters-centimeters@csql-unit:meters":
		take(
			"case-search/within-distance-in-yards-feet-inch-meters-centimeters",
			"csql-unit:meters",
		),
	"within-distance-in-yards-feet-inch-meters-centimeters@csql-unit:centimeters":
		take(
			"case-search/within-distance-in-yards-feet-inch-meters-centimeters",
			"csql-unit:centimeters",
		),
	"within-distance-in-yards-feet-inch-meters-centimeters@csql-unit:millimeters":
		take(
			"case-search/within-distance-in-yards-feet-inch-meters-centimeters",
			"csql-unit:millimeters",
		),
	"within-distance-in-yards-feet-inch-meters-centimeters@csql-unit:nauticalmiles":
		take(
			"case-search/within-distance-in-yards-feet-inch-meters-centimeters",
			"csql-unit:nauticalmiles",
		),
	"within-distance-with-a-runtime-radius-or-unit": take(
		"case-search/within-distance-with-a-runtime-radius-or-unit",
		"csql-fn:within-distance",
	),
	"subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path@csql-op:=":
		take(
			"case-search/subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path",
			"csql-op:=",
		),
	"subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path@csql-op:!=":
		take(
			"case-search/subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path",
			"csql-op:!=",
		),
	"subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path@csql-op:>":
		take(
			"case-search/subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path",
			"csql-op:>",
		),
	"subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path@csql-op:>=":
		take(
			"case-search/subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path",
			"csql-op:>=",
		),
	"subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path@csql-op:<":
		take(
			"case-search/subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path",
			"csql-op:<",
		),
	"subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path@csql-op:<=":
		take(
			"case-search/subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path",
			"csql-op:<=",
		),
	"subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path@csql-fn:subcase-exists":
		take(
			"case-search/subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path",
			"csql-fn:subcase-exists",
		),
	"subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path@csql-fn:subcase-count":
		take(
			"case-search/subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path",
			"csql-fn:subcase-count",
		),
	"subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path@csql-fn:ancestor-exists":
		take(
			"case-search/subcase-exists-id-q-subcase-count-id-q-op-n-ancestor-exists-path",
			"csql-fn:ancestor-exists",
		),
	"clause-chosen-at-runtime-by-input-presence": take(
		"case-search/clause-chosen-at-runtime-by-input-presence",
		"csql-key:_xpath_query",
	),
	"property-names-operators-or-function-names-computed-at-runtime": refuse(
		"case-search/property-names-operators-or-function-names-computed-at-runtime",
		"schema:DefaultCaseSearchProperty.defaultValue",
	),
	"a-search-value-that-queries-cases-a-table-or-places": refuse(
		"case-search/a-search-value-that-queries-cases-a-table-or-places",
		"schema:DefaultCaseSearchProperty.defaultValue",
	),
	"a-function-call-written-unparenthesized-as-the-2nd-or-later": refuse(
		"case-search/a-function-call-written-unparenthesized-as-the-2nd-or-later",
		null,
	),
	"a-function-on-the-left-side-a-property-on-the-right-side": refuse(
		"case-search/a-function-on-the-left-side-a-property-on-the-right-side",
		"csql-fn:search-value-mixes-quote-marks",
	),
	"several-xpath-query-rows": take(
		"case-search/several-xpath-query-rows",
		"csql-key:_xpath_query",
	),
	"xpath-query-condition-outside-what-nova-types": refuse(
		"case-search/xpath-query-condition-outside-what-nova-types",
		"csql-key:_xpath_query",
	),
	"casedb-jr-instance-casedb": take(
		"expressions-and-data/casedb-jr-instance-casedb",
		"instance-scheme:casedb",
	),
	"commcaresession-jr-instance-session": take(
		"expressions-and-data/commcaresession-jr-instance-session",
		"instance-scheme:commcaresession",
	),
	"session-data-datum": take(
		"expressions-and-data/session-data-datum",
		"session-path:session/data/*",
	),
	"session-data-datum-the-entry-does-not-supply": refuse(
		"expressions-and-data/session-data-datum-the-entry-does-not-supply",
		"session-path:session/data/*",
	),
	"session-data-supply-point-id-anywhere-except-in-an-advanced-form": refuse(
		"expressions-and-data/session-data-supply-point-id-anywhere-except-in-an-advanced-form",
		"session-path:session/data/*",
	),
	"session-data-supply-point-id-in-an-advanced-form-whose-computed": refuse(
		"expressions-and-data/session-data-supply-point-id-in-an-advanced-form-whose-computed",
		"session-path:session/data/*",
	),
	"session-data-stringquery": take(
		"expressions-and-data/session-data-stringquery",
		"session-path:session/data/stringquery",
	),
	"session-data-fingerprintquery": refuse(
		"expressions-and-data/session-data-fingerprintquery",
		"session-path:session/data/fingerprintquery",
	),
	"session-context-userid-context-username@session-path:session/context/userid":
		take(
			"expressions-and-data/session-context-userid-context-username",
			"session-path:session/context/userid",
		),
	"session-context-userid-context-username@session-path:session/context/username":
		take(
			"expressions-and-data/session-context-userid-context-username",
			"session-path:session/context/username",
		),
	"session-context-deviceid": take(
		"expressions-and-data/session-context-deviceid",
		"session-path:session/context/deviceid",
	),
	"session-context-appversion": take(
		"expressions-and-data/session-context-appversion",
		"session-path:session/context/appversion",
	),
	"session-context-drift": take(
		"expressions-and-data/session-context-drift",
		"session-path:session/context/drift",
	),
	"session-context-window-width": take(
		"expressions-and-data/session-context-window-width",
		"session-path:session/context/window_width",
	),
	"session-context-window-width-in-form-logic": refuse(
		"expressions-and-data/session-context-window-width-in-form-logic",
		"session-path:session/context/window_width",
	),
	"session-context-applanguage": take(
		"expressions-and-data/session-context-applanguage",
		"session-path:session/context/applanguage",
	),
	"session-user-data-field": take(
		"expressions-and-data/session-user-data-field",
		"session-path:session/user/data/*",
	),
	"ledgerdb-vellum-id-ledger": refuse(
		"expressions-and-data/ledgerdb-vellum-id-ledger",
		"instance-scheme:ledgerdb",
	),
	"item-list-tag-read-through-nova-s-typed-lookup-carriers": take(
		"expressions-and-data/item-list-tag-read-through-nova-s-typed-lookup-carriers",
		"instance-scheme:item-list",
	),
	"item-list-tag-read-in-any-other-expression": take(
		"expressions-and-data/item-list-tag-read-in-any-other-expression",
		"instance-scheme:item-list",
	),
	"groups-jr-fixture-user-groups": take(
		"expressions-and-data/groups-jr-fixture-user-groups",
		"instance-scheme:groups",
	),
	"locations-flat-jr-fixture-locations-read-in-an-expression": take(
		"expressions-and-data/locations-flat-jr-fixture-locations-read-in-an-expression",
		"instance-scheme:locations",
	),
	"commtrack-locations-hierarchical@instance-scheme:locations": refuse(
		"expressions-and-data/commtrack-locations-hierarchical",
		"instance-scheme:locations",
	),
	"commtrack-locations-hierarchical@instance-scheme:commtrack": refuse(
		"expressions-and-data/commtrack-locations-hierarchical",
		"instance-scheme:commtrack",
	),
	"reports-commcare-reports-commcare-reports-commcare-reports@instance-scheme:reports":
		refuse(
			"expressions-and-data/reports-commcare-reports-commcare-reports-commcare-reports",
			"instance-scheme:reports",
		),
	"reports-commcare-reports-commcare-reports-commcare-reports@instance-scheme:commcare":
		refuse(
			"expressions-and-data/reports-commcare-reports-commcare-reports-commcare-reports",
			"instance-scheme:commcare",
		),
	"reports-commcare-reports-commcare-reports-commcare-reports@instance-scheme:commcare-reports":
		refuse(
			"expressions-and-data/reports-commcare-reports-commcare-reports-commcare-reports",
			"instance-scheme:commcare-reports",
		),
	"reports-commcare-reports-commcare-reports-commcare-reports@instance-scheme:commcare-reports-filters":
		refuse(
			"expressions-and-data/reports-commcare-reports-commcare-reports-commcare-reports",
			"instance-scheme:commcare-reports-filters",
		),
	"registry-jr-instance-remote-registry": refuse(
		"expressions-and-data/registry-jr-instance-remote-registry",
		"instance-scheme:registry",
	),
	"results-results-inline-results-name-in-search-details": take(
		"expressions-and-data/results-results-inline-results-name-in-search-details",
		"instance-scheme:results",
	),
	"results-read-in-form-expressions-of-an-inline-search-module": take(
		"expressions-and-data/results-read-in-form-expressions-of-an-inline-search-module",
		"instance-scheme:results",
	),
	"results-read-in-form-expressions-reached-through-a-search-that": refuse(
		"expressions-and-data/results-read-in-form-expressions-reached-through-a-search-that",
		"instance-scheme:results",
	),
	"search-input-results-and-legacy-search-input-read-while-the": take(
		"expressions-and-data/search-input-results-and-legacy-search-input-read-while-the",
		"instance-scheme:search-input",
	),
	"search-input-results-read-in-the-search-results-detail": refuse(
		"expressions-and-data/search-input-results-read-in-the-search-results-detail",
		"instance-scheme:search-input",
	),
	"search-input-results-read-in-the-case-list-of-an-inline-search": take(
		"expressions-and-data/search-input-results-read-in-the-case-list-of-an-inline-search",
		"instance-scheme:search-input",
	),
	"legacy-search-input-read-after-the-query-in-the-results-detail": refuse(
		"expressions-and-data/legacy-search-input-read-after-the-query-in-the-results-detail",
		"instance-scheme:search-input",
	),
	"search-input-read-in-form-expressions-of-an-inline-search-module": take(
		"expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module",
		"instance-scheme:search-input",
	),
	"search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu":
		refuse(
			"expressions-and-data/search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu",
			"instance-scheme:search-input",
		),
	"search-input-read-in-form-expressions-reached-through-a-search": refuse(
		"expressions-and-data/search-input-read-in-form-expressions-reached-through-a-search",
		"instance-scheme:search-input",
	),
	"selected-cases-search-selected-cases-parent-selected-cases-jr": take(
		"expressions-and-data/selected-cases-search-selected-cases-parent-selected-cases-jr",
		"instance-scheme:selected_cases",
	),
	"schedule-m-p-f": refuse(
		"expressions-and-data/schedule-m-p-f",
		"instance-scheme:schedule",
	),
	"indicators-call-center-indicators": refuse(
		"expressions-and-data/indicators-call-center-indicators",
		"instance-scheme:indicators",
	),
	"commtrack-products-commtrack-programs": refuse(
		"expressions-and-data/commtrack-products-commtrack-programs",
		"instance-scheme:commtrack",
	),
	"case-search-fixture": refuse(
		"expressions-and-data/case-search-fixture",
		"instance-scheme:case-search-fixture",
	),
	"declared-and-referenced-instance-with-an-unrecognized-src": refuse(
		"expressions-and-data/declared-and-referenced-instance-with-an-unrecognized-src",
		"instance-source:(none)",
	),
	"referenced-undeclared-instance-id-with-no-known-scheme-or-one@instance-scheme:commcare":
		refuse(
			"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
			"instance-scheme:commcare",
		),
	"referenced-undeclared-instance-id-with-no-known-scheme-or-one@instance-scheme:commcare-reports":
		refuse(
			"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
			"instance-scheme:commcare-reports",
		),
	"referenced-undeclared-instance-id-with-no-known-scheme-or-one@instance-scheme:commcare-reports-filters":
		refuse(
			"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
			"instance-scheme:commcare-reports-filters",
		),
	"referenced-undeclared-instance-id-with-no-known-scheme-or-one@instance-scheme:results":
		refuse(
			"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
			"instance-scheme:results",
		),
	"referenced-undeclared-instance-id-with-no-known-scheme-or-one@instance-scheme:search-input":
		refuse(
			"expressions-and-data/referenced-undeclared-instance-id-with-no-known-scheme-or-one",
			"instance-scheme:search-input",
		),
	"declared-unreferenced-instance-whose-source-loads-no-data-casedb": drop(
		"expressions-and-data/declared-unreferenced-instance-whose-source-loads-no-data-casedb",
		"instance-source:casedb",
	),
	"declared-unreferenced-fixture-instance-item-list-locations-user": drop(
		"expressions-and-data/declared-unreferenced-fixture-instance-item-list-locations-user",
		"instance-source:fixture",
	),
	"declared-unreferenced-fixture-instance-the-project-space-may-not": take(
		"expressions-and-data/declared-unreferenced-fixture-instance-the-project-space-may-not",
		"instance-source:fixture",
	),
	abs: take("expressions-and-data/abs", "jr-fn:abs"),
	acos: take("expressions-and-data/acos", "jr-fn:acos"),
	asin: take("expressions-and-data/asin", "jr-fn:asin"),
	atan: take("expressions-and-data/atan", "jr-fn:atan"),
	atan2: take("expressions-and-data/atan2", "jr-fn:atan2"),
	boolean: take("expressions-and-data/boolean", "jr-fn:boolean"),
	"boolean-from-string": take(
		"expressions-and-data/boolean-from-string",
		"jr-fn:boolean-from-string",
	),
	ceiling: take("expressions-and-data/ceiling", "jr-fn:ceiling"),
	checklist: take("expressions-and-data/checklist", "jr-fn:checklist"),
	checksum: take("expressions-and-data/checksum", "jr-fn:checksum"),
	"closest-point-on-polygon": take(
		"expressions-and-data/closest-point-on-polygon",
		"jr-fn:closest-point-on-polygon",
	),
	coalesce: take("expressions-and-data/coalesce", "jr-fn:coalesce"),
	concat: take("expressions-and-data/concat", "jr-fn:concat"),
	cond: take("expressions-and-data/cond", "jr-fn:cond"),
	contains: take("expressions-and-data/contains", "jr-fn:contains"),
	cos: take("expressions-and-data/cos", "jr-fn:cos"),
	count: take("expressions-and-data/count", "jr-fn:count"),
	"count-selected": take(
		"expressions-and-data/count-selected",
		"jr-fn:count-selected",
	),
	date: take("expressions-and-data/date", "jr-fn:date"),
	"decrypt-string": take(
		"expressions-and-data/decrypt-string",
		"jr-fn:decrypt-string",
	),
	depend: take("expressions-and-data/depend", "jr-fn:depend"),
	distance: take("expressions-and-data/distance", "jr-fn:distance"),
	"distinct-values": take(
		"expressions-and-data/distinct-values",
		"jr-fn:distinct-values",
	),
	double: take("expressions-and-data/double", "jr-fn:double"),
	"encrypt-string": take(
		"expressions-and-data/encrypt-string",
		"jr-fn:encrypt-string",
	),
	"ends-with": take("expressions-and-data/ends-with", "jr-fn:ends-with"),
	exp: take("expressions-and-data/exp", "jr-fn:exp"),
	false: take("expressions-and-data/false", "jr-fn:false"),
	floor: take("expressions-and-data/floor", "jr-fn:floor"),
	"format-date": take("expressions-and-data/format-date", "jr-fn:format-date"),
	"format-date-for-calendar": take(
		"expressions-and-data/format-date-for-calendar",
		"jr-fn:format-date-for-calendar",
	),
	"id-compress": take("expressions-and-data/id-compress", "jr-fn:id-compress"),
	if: take("expressions-and-data/if", "jr-fn:if"),
	"index-of": take("expressions-and-data/index-of", "jr-fn:index-of"),
	int: take("expressions-and-data/int", "jr-fn:int"),
	"is-point-inside-polygon": take(
		"expressions-and-data/is-point-inside-polygon",
		"jr-fn:is-point-inside-polygon",
	),
	"is-selected": take("expressions-and-data/is-selected", "jr-fn:is-selected"),
	join: take("expressions-and-data/join", "jr-fn:join"),
	"join-chunked": take(
		"expressions-and-data/join-chunked",
		"jr-fn:join-chunked",
	),
	"json-property": take(
		"expressions-and-data/json-property",
		"jr-fn:json-property",
	),
	log: take("expressions-and-data/log", "jr-fn:log"),
	log10: take("expressions-and-data/log10", "jr-fn:log10"),
	"lower-case": take("expressions-and-data/lower-case", "jr-fn:lower-case"),
	max: take("expressions-and-data/max", "jr-fn:max"),
	min: take("expressions-and-data/min", "jr-fn:min"),
	not: take("expressions-and-data/not", "jr-fn:not"),
	now: take("expressions-and-data/now", "jr-fn:now"),
	number: take("expressions-and-data/number", "jr-fn:number"),
	pi: take("expressions-and-data/pi", "jr-fn:pi"),
	position: take("expressions-and-data/position", "jr-fn:position"),
	pow: take("expressions-and-data/pow", "jr-fn:pow"),
	random: take("expressions-and-data/random", "jr-fn:random"),
	regex: take("expressions-and-data/regex", "jr-fn:regex"),
	replace: take("expressions-and-data/replace", "jr-fn:replace"),
	round: take("expressions-and-data/round", "jr-fn:round"),
	selected: take("expressions-and-data/selected", "jr-fn:selected"),
	"selected-at": take("expressions-and-data/selected-at", "jr-fn:selected-at"),
	sin: take("expressions-and-data/sin", "jr-fn:sin"),
	sleep: take("expressions-and-data/sleep", "jr-fn:sleep"),
	sort: take("expressions-and-data/sort", "jr-fn:sort"),
	"sort-by": take("expressions-and-data/sort-by", "jr-fn:sort-by"),
	sqrt: take("expressions-and-data/sqrt", "jr-fn:sqrt"),
	"starts-with": take("expressions-and-data/starts-with", "jr-fn:starts-with"),
	string: take("expressions-and-data/string", "jr-fn:string"),
	"string-length": take(
		"expressions-and-data/string-length",
		"jr-fn:string-length",
	),
	substr: take("expressions-and-data/substr", "jr-fn:substr"),
	"substring-after": take(
		"expressions-and-data/substring-after",
		"jr-fn:substring-after",
	),
	"substring-before": take(
		"expressions-and-data/substring-before",
		"jr-fn:substring-before",
	),
	sum: take("expressions-and-data/sum", "jr-fn:sum"),
	tan: take("expressions-and-data/tan", "jr-fn:tan"),
	today: take("expressions-and-data/today", "jr-fn:today"),
	translate: take("expressions-and-data/translate", "jr-fn:translate"),
	true: take("expressions-and-data/true", "jr-fn:true"),
	"upper-case": take("expressions-and-data/upper-case", "jr-fn:upper-case"),
	uuid: take("expressions-and-data/uuid", "jr-fn:uuid"),
	"weighted-checklist": take(
		"expressions-and-data/weighted-checklist",
		"jr-fn:weighted-checklist",
	),
	"instance-id-current-path-roots": take(
		"expressions-and-data/instance-id-current-path-roots",
		"xpath-expr:XPathPathExpr",
	),
	"an-expression-core-cannot-evaluate-as-its-author-meant": refuse(
		"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant",
		null,
	),
	"a-form-expression-outside-what-nova-types": refuse(
		"expressions-and-data/a-form-expression-outside-what-nova-types",
		null,
	),
	"a-read-of-a-place-s-location-data-under-a-name-no-location-property-takes":
		refuse(
			"expressions-and-data/a-read-of-a-place-s-location-data-under-a-name-no-location-property-takes",
			null,
		),
	"a-read-of-the-worker-s-session-data-under-a-name-no-worker-property-takes":
		refuse(
			"expressions-and-data/a-read-of-the-worker-s-session-data-under-a-name-no-worker-property-takes",
			null,
		),
	"jr-itext-id": take(
		"expressions-and-data/jr-itext-id",
		"jr-handler:jr:itext",
	),
	"jr-choice-name-value-path-on-a-static-choice-select": take(
		"expressions-and-data/jr-choice-name-value-path-on-a-static-choice-select",
		"jr-handler:jr:choice-name",
	),
	"jr-choice-name-on-a-lookup-itemset-select": refuse(
		"expressions-and-data/jr-choice-name-on-a-lookup-itemset-select",
		"jr-handler:jr:choice-name",
	),
	"here-in-a-form": refuse(
		"expressions-and-data/here-in-a-form",
		"jr-handler:here",
	),
	"here-in-a-case-list-calculated-column-or-sort": take(
		"expressions-and-data/here-in-a-case-list-calculated-column-or-sort",
		"jr-handler:here",
	),
	"any-other-function-name": refuse(
		"expressions-and-data/any-other-function-name",
		null,
	),
	"union-a-b@xpath-expr:XPathUnionExpr": refuse(
		"expressions-and-data/union-a-b",
		"xpath-expr:XPathUnionExpr",
	),
	"union-a-b@xpath-token:UNION": refuse(
		"expressions-and-data/union-a-b",
		"xpath-token:UNION",
	),
	"filter-expression-expr-root-other-than-instance-current": refuse(
		"expressions-and-data/filter-expression-expr-root-other-than-instance-current",
		"xpath-expr:XPathFilterExpr",
	),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-token:DBL_SLASH":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-token:DBL_SLASH",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_ANCESTOR":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-axis:AXIS_ANCESTOR",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_ANCESTOR_OR_SELF":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-axis:AXIS_ANCESTOR_OR_SELF",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_DESCENDANT":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-axis:AXIS_DESCENDANT",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_DESCENDANT_OR_SELF":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-axis:AXIS_DESCENDANT_OR_SELF",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_FOLLOWING":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-axis:AXIS_FOLLOWING",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_FOLLOWING_SIBLING":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-axis:AXIS_FOLLOWING_SIBLING",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_NAMESPACE":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-axis:AXIS_NAMESPACE",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_PRECEDING":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-axis:AXIS_PRECEDING",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_PRECEDING_SIBLING":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-axis:AXIS_PRECEDING_SIBLING",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-test:TEST_TYPE_TEXT":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-test:TEST_TYPE_TEXT",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-test:TEST_TYPE_COMMENT":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-test:TEST_TYPE_COMMENT",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-test:TEST_TYPE_PROCESSING_INSTRUCTION":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-test:TEST_TYPE_PROCESSING_INSTRUCTION",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-test:TEST_NAMESPACE_WILDCARD":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-test:TEST_NAMESPACE_WILDCARD",
		),
	"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-token:NSWILDCARD":
		refuse(
			"expressions-and-data/and-axes-other-than-child-name-or-attribute-name-self-node",
			"xpath-token:NSWILDCARD",
		),
	"after-a-named-step-data-a-b@xpath-token:DBL_DOT": refuse(
		"expressions-and-data/after-a-named-step-data-a-b",
		"xpath-token:DBL_DOT",
	),
	"after-a-named-step-data-a-b@xpath-axis:AXIS_PARENT": refuse(
		"expressions-and-data/after-a-named-step-data-a-b",
		"xpath-axis:AXIS_PARENT",
	),
	"var-in-a-form-expression@xpath-expr:XPathVariableReference": refuse(
		"expressions-and-data/var-in-a-form-expression",
		"xpath-expr:XPathVariableReference",
	),
	"var-in-a-form-expression@xpath-token:VAR": refuse(
		"expressions-and-data/var-in-a-form-expression",
		"xpath-token:VAR",
	),
	"or-with-a-time-on-either-side-a-time-answer-property-or-string@xpath-expr:XPathCmpExpr":
		refuse(
			"expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string",
			"xpath-expr:XPathCmpExpr",
		),
	"or-with-a-time-on-either-side-a-time-answer-property-or-string@xpath-token:LT":
		refuse(
			"expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string",
			"xpath-token:LT",
		),
	"or-with-a-time-on-either-side-a-time-answer-property-or-string@xpath-token:LTE":
		refuse(
			"expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string",
			"xpath-token:LTE",
		),
	"or-with-a-time-on-either-side-a-time-answer-property-or-string@xpath-token:GT":
		refuse(
			"expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string",
			"xpath-token:GT",
		),
	"or-with-a-time-on-either-side-a-time-answer-property-or-string@xpath-token:GTE":
		refuse(
			"expressions-and-data/or-with-a-time-on-either-side-a-time-answer-property-or-string",
			"xpath-token:GTE",
		),
	"relative-paths-q-current-x@xpath-token:DBL_DOT": take(
		"expressions-and-data/relative-paths-q-current-x",
		"xpath-token:DBL_DOT",
	),
	"relative-paths-q-current-x@xpath-axis:AXIS_PARENT": take(
		"expressions-and-data/relative-paths-q-current-x",
		"xpath-axis:AXIS_PARENT",
	),
	"relative-paths-q-current-x@xpath-axis:AXIS_SELF": take(
		"expressions-and-data/relative-paths-q-current-x",
		"xpath-axis:AXIS_SELF",
	),
	"relative-paths-q-current-x@xpath-test:TEST_TYPE_NODE": take(
		"expressions-and-data/relative-paths-q-current-x",
		"xpath-test:TEST_TYPE_NODE",
	),
	"relative-paths-q-current-x@xpath-token:DOT": take(
		"expressions-and-data/relative-paths-q-current-x",
		"xpath-token:DOT",
	),
	"xpath-location-paths@xpath-expr:XPathPathExpr": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-expr:XPathPathExpr",
	),
	"xpath-location-paths@xpath-axis:AXIS_CHILD": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-axis:AXIS_CHILD",
	),
	"xpath-location-paths@xpath-axis:AXIS_ATTRIBUTE": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-axis:AXIS_ATTRIBUTE",
	),
	"xpath-location-paths@xpath-test:TEST_NAME": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-test:TEST_NAME",
	),
	"xpath-location-paths@xpath-test:TEST_NAME_WILDCARD": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-test:TEST_NAME_WILDCARD",
	),
	"xpath-location-paths@xpath-token:QNAME": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-token:QNAME",
	),
	"xpath-location-paths@xpath-token:SLASH": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-token:SLASH",
	),
	"xpath-location-paths@xpath-token:AT": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-token:AT",
	),
	"xpath-location-paths@xpath-token:LBRACK": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-token:LBRACK",
	),
	"xpath-location-paths@xpath-token:RBRACK": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-token:RBRACK",
	),
	"xpath-location-paths@xpath-token:WILDCARD": take(
		"expressions-and-data/xpath-location-paths",
		"xpath-token:WILDCARD",
	),
	"xpath-operators-and-literals@xpath-expr:XPathCmpExpr": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-expr:XPathCmpExpr",
	),
	"xpath-operators-and-literals@xpath-token:LT": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:LT",
	),
	"xpath-operators-and-literals@xpath-token:LTE": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:LTE",
	),
	"xpath-operators-and-literals@xpath-token:GT": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:GT",
	),
	"xpath-operators-and-literals@xpath-token:GTE": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:GTE",
	),
	"xpath-operators-and-literals@xpath-expr:XPathArithExpr": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-expr:XPathArithExpr",
	),
	"xpath-operators-and-literals@xpath-expr:XPathBoolExpr": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-expr:XPathBoolExpr",
	),
	"xpath-operators-and-literals@xpath-expr:XPathEqExpr": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-expr:XPathEqExpr",
	),
	"xpath-operators-and-literals@xpath-expr:XPathNumNegExpr": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-expr:XPathNumNegExpr",
	),
	"xpath-operators-and-literals@xpath-expr:XPathNumericLiteral": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-expr:XPathNumericLiteral",
	),
	"xpath-operators-and-literals@xpath-expr:XPathStringLiteral": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-expr:XPathStringLiteral",
	),
	"xpath-operators-and-literals@xpath-token:AND": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:AND",
	),
	"xpath-operators-and-literals@xpath-token:OR": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:OR",
	),
	"xpath-operators-and-literals@xpath-token:EQ": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:EQ",
	),
	"xpath-operators-and-literals@xpath-token:NEQ": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:NEQ",
	),
	"xpath-operators-and-literals@xpath-token:PLUS": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:PLUS",
	),
	"xpath-operators-and-literals@xpath-token:MINUS": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:MINUS",
	),
	"xpath-operators-and-literals@xpath-token:MULT": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:MULT",
	),
	"xpath-operators-and-literals@xpath-token:DIV": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:DIV",
	),
	"xpath-operators-and-literals@xpath-token:MOD": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:MOD",
	),
	"xpath-operators-and-literals@xpath-token:UMINUS": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:UMINUS",
	),
	"xpath-operators-and-literals@xpath-token:NUM": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:NUM",
	),
	"xpath-operators-and-literals@xpath-token:STR": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:STR",
	),
	"xpath-operators-and-literals@xpath-token:LPAREN": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:LPAREN",
	),
	"xpath-operators-and-literals@xpath-token:RPAREN": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:RPAREN",
	),
	"xpath-operators-and-literals@xpath-token:COMMA": take(
		"expressions-and-data/xpath-operators-and-literals",
		"xpath-token:COMMA",
	),
	"suite-variable-references@xpath-expr:XPathVariableReference": take(
		"expressions-and-data/suite-variable-references",
		"xpath-expr:XPathVariableReference",
	),
	"suite-variable-references@xpath-token:VAR": take(
		"expressions-and-data/suite-variable-references",
		"xpath-token:VAR",
	),
	"case-prop-case-parent-prop-case-grandparent-prop@hashtag:#case": take(
		"expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
		"hashtag:#case",
	),
	"case-prop-case-parent-prop-case-grandparent-prop@hashtag:#case/": take(
		"expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
		"hashtag:#case/",
	),
	"case-prop-case-parent-prop-case-grandparent-prop@hashtag:#case/parent": take(
		"expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
		"hashtag:#case/parent",
	),
	"case-prop-case-parent-prop-case-grandparent-prop@hashtag:#case/grandparent":
		take(
			"expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
			"hashtag:#case/grandparent",
		),
	"case-prop-case-parent-prop-case-grandparent-prop@hashtag:#parent": take(
		"expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
		"hashtag:#parent",
	),
	"case-prop-case-parent-prop-case-grandparent-prop@hashtag:#host": take(
		"expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
		"hashtag:#host",
	),
	"user-prop-in-xform-expressions@hashtag:#user": take(
		"forms-and-case-writes/user-prop-in-xform-expressions",
		"hashtag:#user",
	),
	"session-hq-shorthand-in-navigation-slots-for-the-context-and": take(
		"expressions-and-data/session-hq-shorthand-in-navigation-slots-for-the-context-and",
		"hashtag:#session/",
	),
	"session-data-datum-hq-shorthand-in-navigation-slots": take(
		"expressions-and-data/session-data-datum-hq-shorthand-in-navigation-slots",
		"hashtag:#session/",
	),
	"an-invalid-xpath-in-a-bind-attribute": refuse(
		"expressions-and-data/an-invalid-xpath-in-a-bind-attribute",
		"xform:model/bind@calculate",
	),
	"form-filter-lifting-into-predicate-a-direct-own-case-property-in": take(
		"forms-and-case-writes/form-filter-lifting-into-predicate-a-direct-own-case-property-in",
		"schema:Form.form_filter",
	),
	"form-filter-outside-predicate-parent-host-user-usercase-reads": take(
		"forms-and-case-writes/form-filter-outside-predicate-parent-host-user-usercase-reads",
		"schema:Form.form_filter",
	),
	"form-filter-reading-case-status-case-id-case-type-owner-id": refuse(
		"forms-and-case-writes/form-filter-reading-case-status-case-id-case-type-owner-id",
		"schema:Form.form_filter",
	),
	"form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first": refuse(
		"menus-and-case-lists/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first",
		"schema:Form.form_filter",
	),
	"form-filter-referencing-the-case-database-other-than-through": refuse(
		"forms-and-case-writes/form-filter-referencing-the-case-database-other-than-through",
		"schema:Form.form_filter",
	),
	"a-display-condition-reading-case-user-casedb-with-no-non-auto": refuse(
		"forms-and-case-writes/a-display-condition-reading-case-user-casedb-with-no-non-auto",
		"schema:AdvancedForm.form_filter",
	),
	"form-filter-using-fixture-value": refuse(
		"forms-and-case-writes/form-filter-using-fixture-value",
		"schema:Form.form_filter",
	),
	/** The pattern HQ's build replaces in a form's condition where its menu's lookup table
	 *  selection is active (`menus.py`, `fixture_xpath`), a use of the condition's text. */
	"form-filter-using-fixture-value@hashtag:$fixture_value": refuse(
		"forms-and-case-writes/form-filter-using-fixture-value",
		"hashtag:$fixture_value",
	),
	/** HQ's `#case` shorthand in a slot its build interpolates whose text names a menu's case by
	 *  its slug (`#case:<slug>/…`), which the replacement leaves after the case's path, a use of the
	 *  slot's text (`surfaceUses.ts::shorthandUses`). */
	"case-module-slug@hashtag:#case": refuse(
		"expressions-and-data/case-module-slug-unrelated-parent-select-case",
		"hashtag:#case",
	),
	"form-links-xpath": take(
		"forms-and-case-writes/form-links-xpath",
		"schema:Form.form_links",
	),
	"form-links-datums-on-a-form-target-names-among-the-target-s": take(
		"forms-and-case-writes/form-links-datums-on-a-form-target-names-among-the-target-s",
		"schema:FormDatum.xpath",
	),
	"two-or-more-form-links-conditions-true-at-once": take(
		"forms-and-case-writes/two-or-more-form-links-conditions-true-at-once",
		"schema:Form.form_links",
	),
	"update-key-holding-a-non-ascii-core-name-character": refuse(
		"forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character",
		"schema:Form.actions",
	),
	"user-prop-in-module-filter-form-filter-case-list-slots-the": take(
		"forms-and-case-writes/user-prop-in-module-filter-form-filter-case-list-slots-the",
		"schema:Form.form_filter",
	),
	"module-filter-value-lifts-into-predicate": take(
		"menus-and-case-lists/module-filter-value-lifts-into-predicate",
		"parser:MenuParser/menu@relevant",
	),
	"module-filter-false-or-false-and-rest-menu-reached-only-by-links": take(
		"menus-and-case-lists/module-filter-false-or-false-and-rest-menu-reached-only-by-links",
		"parser:MenuParser/menu@relevant",
	),
	"form-filter-false-or-false-and-rest-form-reached-only-by-links": take(
		"menus-and-case-lists/form-filter-false-or-false-and-rest-form-reached-only-by-links",
		"schema:Form.form_filter",
	),
	"module-filter-value-outside-predicate-any-xpath-hq-s-validator": take(
		"menus-and-case-lists/module-filter-value-outside-predicate-any-xpath-hq-s-validator",
		"parser:MenuParser/menu@relevant",
	),
	"module-filter-referencing-case-parent-host-or-a-bare": refuse(
		"menus-and-case-lists/module-filter-referencing-case-parent-host-or-a-bare",
		"parser:MenuParser/menu@relevant",
	),
	"module-filter-failing-hq-s-validate-xpath": refuse(
		"menus-and-case-lists/module-filter-failing-hq-s-validate-xpath",
		"parser:MenuParser/menu@relevant",
	),
	"form-context-value": take(
		"menus-and-case-lists/detail-persist-case-context-persistent-case-context-xml",
		"schema:Detail.persistent_case_context_xml",
	),
	"form-context-value-outside": refuse(
		"menus-and-case-lists/form-context-expression-outside-its-case-scope",
		"schema:Detail.persistent_case_context_xml",
	),
	"tab-child-filter": take(
		"menus-and-case-lists/data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset",
		"schema:DetailTab.nodeset_filter",
	),
	"tab-custom-rows": take(
		"menus-and-case-lists/data-tab-over-a-custom-nodeset-xpath",
		"schema:DetailTab.nodeset",
	),
	"tab-child-filter-outside": refuse(
		"menus-and-case-lists/detail-tab-without-a-resolvable-row-source",
		"schema:DetailTab.nodeset_filter",
	),
	"tab-custom-rows-outside": refuse(
		"menus-and-case-lists/detail-tab-without-a-resolvable-row-source",
		"schema:DetailTab.nodeset",
	),
	"tab-condition": take(
		"menus-and-case-lists/tab-relevant-lifts-into-predicate-not",
		"schema:DetailTab.relevant",
	),
	"tab-condition-outside-scope": refuse(
		"menus-and-case-lists/tab-display-condition-outside-its-case-scope",
		"schema:DetailTab.relevant",
	),
	"detail-filter-value-lifts-into-predicate": take(
		"menus-and-case-lists/detail-filter-value-lifts-into-predicate",
		"schema:Detail.filter",
	),
	"detail-filter-value-outside-predicate": refuse(
		"menus-and-case-lists/detail-filter-value-outside-predicate",
		"schema:Detail.filter",
	),
	"detail-filter-failing-etree-xpath-dummy-filter": refuse(
		"menus-and-case-lists/detail-filter-failing-etree-xpath-dummy-filter",
		"schema:Detail.filter",
	),
	"mapping-label-condition": take(
		"menus-and-case-lists/20-conditional-enum",
		"schema:MappingItem.key",
	),
	"mapping-image-condition": take(
		"menus-and-case-lists/19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot",
		"schema:MappingItem.key",
	),
	"mapping-condition-untyped": refuse(
		"menus-and-case-lists/mapping-condition-outside-predicate",
		"schema:MappingItem.key",
	),
	"calculated-order": take(
		"menus-and-case-lists/sort-calculation-authored-calculation-row-field",
		"schema:SortElement.sort_calculation",
	),
	"calculated-order-untyped": refuse(
		"menus-and-case-lists/sort-calculation-without-a-typed-value",
		"schema:SortElement.sort_calculation",
	),
	"usexpathexpression-field-xpath-lifting-into-valueexpression": take(
		"menus-and-case-lists/usexpathexpression-field-xpath-lifting-into-valueexpression",
		"schema:DetailColumn.field",
	),
	"usexpathexpression-field-xpath-outside-valueexpression": refuse(
		"menus-and-case-lists/usexpathexpression-field-xpath-outside-valueexpression",
		"schema:DetailColumn.field",
	),
	"repeat-with-jr-count-naming-an-integer-question-of-the-form-s": take(
		"questions/repeat-with-jr-count-naming-an-integer-question-of-the-form-s",
		"mug:Repeat",
	),
	"jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in": take(
		"questions/jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in",
		"mug:Repeat",
	),
	"jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer": refuse(
		"questions/jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer",
		"mug:Repeat",
	),
	"jr-count-naming-a-single-select-question-whose-every-choice": take(
		"questions/jr-count-naming-a-single-select-question-whose-every-choice",
		"mug:Repeat",
	),
	"jr-count-naming-a-decimal-question": refuse(
		"questions/jr-count-naming-a-decimal-question",
		"mug:Repeat",
	),
	"jr-count-naming-any-other-question-kind-text-barcode-multi": refuse(
		"questions/jr-count-naming-any-other-question-kind-text-barcode-multi",
		"mug:Repeat",
	),
	"repeat-model-iteration-vellum-role-repeat-ids-count-current": take(
		"questions/repeat-model-iteration-vellum-role-repeat-ids-count-current",
		"mug:Repeat",
	),
	"count-repeat-whose-count-and-row-ids-come-from-one-query-a": take(
		"questions/count-repeat-whose-count-and-row-ids-come-from-one-query-a",
		"mug:Repeat",
	),
	"itemset-filter-lifting-into-predicate": take(
		"questions/itemset-filter-lifting-into-predicate",
		"xform:select1/itemset@nodeset",
	),
	"itemset-filter-outside-predicate": refuse(
		"questions/itemset-filter-outside-predicate",
		"xform:select1/itemset@nodeset",
	),
	"savetocase-create-case-type-literal-case-name-owner-id-uuid-case": take(
		"questions/savetocase-create-case-type-literal-case-name-owner-id-uuid-case",
		"mug:SaveToCase",
	),
	"savetocase-update-case-id-xpath": take(
		"questions/savetocase-update-case-id-xpath",
		"mug:SaveToCase",
	),
	"savetocase-property-rows-calculation-condition-lifting-into": take(
		"questions/savetocase-property-rows-calculation-condition-lifting-into",
		"mug:SaveToCase",
	),
	"savetocase-expressions-outside-nova-s-typed-vocabularies-case-id": refuse(
		"questions/savetocase-expressions-outside-nova-s-typed-vocabularies-case-id",
		"mug:SaveToCase",
	),
	"savetocase-open-case-condition": take(
		"questions/savetocase-open-case-condition",
		"mug:SaveToCase",
	),
	"savetocase-owner": take("questions/savetocase-owner", "mug:SaveToCase"),
	"savetocase-link-index-name-child-extension-and-unlink-empty": take(
		"questions/savetocase-link-index-name-child-extension-and-unlink-empty",
		"mug:SaveToCase",
	),
	"savetocase-inside-a-group-whose-display-condition-gates-it": take(
		"questions/savetocase-inside-a-group-whose-display-condition-gates-it",
		"mug:SaveToCase",
	),
	"connect-assessment": take(
		"questions/connect-assessment",
		"mug:ConnectAssessment",
	),
	"connect-deliver-unit": take(
		"questions/connect-deliver-unit",
		"mug:ConnectDeliverUnit",
	),
	"bind-relevant": take("questions/bind-relevant", "xform:model/bind@relevant"),
	"bind-required-true": take(
		"questions/bind-required-true",
		"xform:model/bind@required",
	),
	"bind-required-expr": take(
		"questions/bind-required-expr",
		"xform:model/bind@required",
	),
	"bind-constraint": take(
		"questions/bind-constraint",
		"xform:model/bind@constraint",
	),
	"bind-calculate-on-a-hidden-value": take(
		"questions/bind-calculate-on-a-hidden-value",
		"xform:model/bind@calculate",
	),
	"setvalue-event-xforms-ready-default-on-a-question-outside": take(
		"questions/setvalue-event-xforms-ready-default-on-a-question-outside",
		"jr-action:setvalue",
	),
	"setvalue-event-jr-insert-default-inside-a-repeat-not-reading": take(
		"questions/setvalue-event-jr-insert-default-inside-a-repeat-not-reading",
		"jr-action:setvalue",
	),
	"a-default-value-that-reads-form-nodes": take(
		"questions/a-default-value-that-reads-form-nodes",
		"jr-action:setvalue",
	),
	"output-value-of-a-question-case-or-user-reference": take(
		"questions/output-value-of-a-question-case-or-user-reference",
		"xform:model/itext/translation/text/value/output",
	),
	"output-value-any-other-expression": take(
		"questions/output-value-any-other-expression",
		"xform:model/itext/translation/text/value/output@value",
	),
	"itext-entry-referenced-only-from-jr-itext-in-an-expression": refuse(
		"questions/itext-entry-referenced-only-from-jr-itext-in-an-expression",
		"xform:model/itext/translation/text@id",
	),
});

const C = EXPRESSION_CLAIMS;
/** M1: a session value the entry does not supply. */
const M1 = C["session-data-datum-the-entry-does-not-supply"].entry;
/** M2: a read of what is not there, a count of arguments Core refuses. */
const M2 = C["an-expression-core-cannot-evaluate-as-its-author-meant"].entry;
/** M3: a form expression CommCare runs and the checker narrows. */
const M3 = C["a-form-expression-outside-what-nova-types"].entry;
/** M5: a search test that reads the case. */
const M5 = C["required-or-validation-test-reading-the-case"].entry;
/** M6: a search test outside what Nova types. */
const M6 = C["required-or-validation-test-outside-what-nova-types"].entry;
/** M7: a search filter outside what Nova types. */
const M7 = C["xpath-query-condition-outside-what-nova-types"].entry;
/** M8: a child menu's form reading its inline-search parent's Search fields. */
const M8 =
	C["search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu"]
		.entry;

// ── By slot ──────────────────────────────────────────────────────────

type SlotRow = {
	held(
		doc: BlueprintDoc,
		ref: SlotContextRef,
		bound: Expression,
	): string | undefined;
	refused(doc: BlueprintDoc, ref: SlotContextRef): string | "form-default";
};

/** A row whose held and refused entries do not depend on the slot's owner. */
function fixed(held: string | undefined, refused: string): SlotRow {
	return { held: () => held, refused: () => refused };
}
/**
 * A menu's or form's display condition: `false()`, alone or first of an `and`, is the
 * condition that keeps it off its menu (`menus/modules.ts::displaySlots` holds it as
 * `hiddenFromMenu`, the rest as its condition), any other the condition itself.
 */
function displayCondition(
	held: string,
	offTheMenu: string,
	restoredRecords: string,
): SlotRow {
	return {
		held: (_doc, _ref, bound) =>
			bound.kind === "match-none" ||
			(bound.kind === "and" && bound.clauses[0]?.kind === "match-none")
				? offTheMenu
				: readsNavigationData(bound)
					? restoredRecords
					: held,
		refused: () => C["navigation-condition-outside-typed-worker-context"].entry,
	};
}
function readsNavigationData(bound: Expression): boolean {
	let found = false;
	walkExpression(bound, {
		visitExpression(node) {
			if (
				["cases", "table-rows", "project", "table-lookup"].includes(node.kind)
			)
				found = true;
		},
		visitTerm(term) {
			if (term.kind === "prop" && term.via && term.via.kind !== "self")
				found = true;
		},
		visitRelation(via) {
			if (via.kind !== "self") found = true;
		},
	});
	return found;
}
/** A form slot: a refusal takes M2 or M3 by its code. */
function formSlot(held: string | undefined): SlotRow {
	return { held: () => held, refused: () => "form-default" };
}

/** Whether a tree reads a form node: an answer, a generated node or a repeat's row attribute. */
function readsFormNode(expression: Expression): boolean {
	let reads = false;
	walkExpression(expression, {
		visitTerm(term) {
			if (
				term.kind === "field" ||
				term.kind === "form-node" ||
				term.kind === "repeat-row"
			)
				reads = true;
		},
	});
	return reads;
}

/** Whether a question sits inside a repeat of its form. */
function insideRepeat(doc: BlueprintDoc, uuid: Uuid): boolean {
	let parent = doc.fieldParent[uuid];
	while (parent !== undefined && parent !== null) {
		const field = doc.fields[parent];
		if (field === undefined) return false;
		if (field.kind === "repeat") return true;
		parent = doc.fieldParent[parent];
	}
	return false;
}

/** The question a count reads directly, where it reads one and nothing else. */
function countSource(
	doc: BlueprintDoc,
	count: Expression | undefined,
): BlueprintDoc["fields"][string] | undefined {
	if (count?.kind !== "term" || count.term.kind !== "field") return undefined;
	return doc.fields[count.term.uuid];
}

const REPEAT_COUNT: SlotRow = {
	held(doc, _ref, bound) {
		const source = countSource(doc, bound);
		if (source?.kind === "int")
			return C["repeat-with-jr-count-naming-an-integer-question-of-the-form-s"]
				.entry;
		if (source?.kind === "single_select")
			return C["jr-count-naming-a-single-select-question-whose-every-choice"]
				.entry;
		return C["jr-count-naming-a-hidden-value-whose-calculate-is-an-integer-in"]
			.entry;
	},
	refused(doc, ref) {
		if (ref.entity !== "field" || ref.slot !== "repeat_count")
			return "form-default";
		const count = expressionSlotValue(doc, ref);
		if (count === undefined) return "form-default";
		const source = countSource(doc, count);
		if (source?.kind === "decimal")
			return C["jr-count-naming-a-decimal-question"].entry;
		if (source === undefined || source.kind === "hidden")
			return C[
				"jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer"
			].entry;
		return C["jr-count-naming-any-other-question-kind-text-barcode-multi"]
			.entry;
	},
};

const IDS_QUERY: SlotRow = {
	held(doc, ref) {
		const form = formOfField(doc, ref.uuid);
		const structure = form === undefined ? undefined : formStructure(doc, form);
		const placement =
			structure === undefined
				? "model-iteration"
				: effectiveQueryRepeatPlacement(structure, ref.uuid);
		return placement === "count"
			? C["count-repeat-whose-count-and-row-ids-come-from-one-query-a"].entry
			: C["repeat-model-iteration-vellum-role-repeat-ids-count-current"].entry;
	},
	refused: () => "form-default",
};

const PROSE: SlotRow = {
	held: (_doc, _ref, bound) =>
		canonicalProseAtom(bound).kind === "value"
			? C["output-value-any-other-expression"].entry
			: C["output-value-of-a-question-case-or-user-reference"].entry,
	refused: () => "form-default",
};

const SAVE_TO_CASE_REFUSED =
	C["savetocase-expressions-outside-nova-s-typed-vocabularies-case-id"].entry;
const SAVE_TO_CASE_ROWS =
	C["savetocase-property-rows-calculation-condition-lifting-into"].entry;

/** A slot a reader registers an expression for: every slot but a Search
 *  field's own condition, which is a search filter row that
 *  `csqlRead.ts::readSearchFilterRow` reads where the search is settled,
 *  answering its own claim. */
export type RegisteredSlotName = Exclude<SlotName, "search_input_predicate">;

/** Each slot's held entry and its refusal's default entry, by slot name. `held` and
 *  `refused` take the document because a row can choose by the slot's owner
 *  (a repeat's placement, a question in a repeat, an operation's action) or by
 *  the bound tree. `held` answers undefined for a row that has no slot entry;
 *  `refused` answers `"form-default"` where a refusal takes M2 or M3 by its code. */
export const SLOT_ENTRIES: Readonly<Record<RegisteredSlotName, SlotRow>> = {
	relevant: formSlot(C["bind-relevant"].entry),
	validate: formSlot(C["bind-constraint"].entry),
	required: {
		held: (_doc, _ref, bound) =>
			bound.kind === "match-all"
				? C["bind-required-true"].entry
				: C["bind-required-expr"].entry,
		refused: () => "form-default",
	},
	calculate: formSlot(C["bind-calculate-on-a-hidden-value"].entry),
	default_value: {
		held(doc, ref, bound) {
			if (readsFormNode(bound))
				return C["a-default-value-that-reads-form-nodes"].entry;
			return insideRepeat(doc, ref.uuid)
				? C["setvalue-event-jr-insert-default-inside-a-repeat-not-reading"]
						.entry
				: C["setvalue-event-xforms-ready-default-on-a-question-outside"].entry;
		},
		refused: () => "form-default",
	},
	repeat_count: REPEAT_COUNT,
	ids_query: IDS_QUERY,
	lookup_options_source: fixed(
		C["itemset-filter-lifting-into-predicate"].entry,
		C["itemset-filter-outside-predicate"].entry,
	),
	label: PROSE,
	hint: PROSE,
	help: PROSE,
	validate_msg: PROSE,
	extended_text: PROSE,
	qr_code: PROSE,
	spoken_text: PROSE,
	option_label: PROSE,
	form_badge: fixed(
		C["form-badge"].entry,
		C["badge-calculation-outside-typed-values"].entry,
	),
	module_badge: fixed(
		C["module-badge"].entry,
		C["badge-calculation-outside-typed-values"].entry,
	),
	form_display_condition: displayCondition(
		C["form-filter-lifting-into-predicate-a-direct-own-case-property-in"].entry,
		C["form-filter-false-or-false-and-rest-form-reached-only-by-links"].entry,
		C["form-filter-outside-predicate-parent-host-user-usercase-reads"].entry,
	),
	// Part of the case reader's structured actions: no text is registered.
	form_open_condition: formSlot(undefined),
	// Registered only from a Save to Case block: the own close's condition,
	// its group's `relevant` or the own arm's close in its block.
	form_close_condition: fixed(
		C["savetocase-inside-a-group-whose-display-condition-gates-it"].entry,
		SAVE_TO_CASE_REFUSED,
	),
	assessment_user_score: formSlot(C["connect-assessment"].entry),
	deliver_entity_id: formSlot(C["connect-deliver-unit"].entry),
	deliver_entity_name: formSlot(C["connect-deliver-unit"].entry),
	// A form whose destinations hold two or more conditions, any two of which may hold together:
	// every destination whose condition holds runs, in author order.
	form_link_condition: {
		held(doc, ref) {
			const links = doc.forms[ref.uuid]?.formLinks ?? [];
			return links.filter((link) => link.condition !== undefined).length >= 2
				? C["two-or-more-form-links-conditions-true-at-once"].entry
				: C["form-links-xpath"].entry;
		},
		refused: () => "form-default",
	},
	// A carried value is a datum's, whose entry names `FormDatum.xpath`.
	form_link_datum_xpath: formSlot(
		C["form-links-datums-on-a-form-target-names-among-the-target-s"].entry,
	),
	case_operation_name: fixed(
		C["savetocase-create-case-type-literal-case-name-owner-id-uuid-case"].entry,
		SAVE_TO_CASE_REFUSED,
	),
	case_operation_owner: fixed(
		C["savetocase-owner"].entry,
		SAVE_TO_CASE_REFUSED,
	),
	case_operation_rename: fixed(SAVE_TO_CASE_ROWS, SAVE_TO_CASE_REFUSED),
	case_operation_write_value: fixed(SAVE_TO_CASE_ROWS, SAVE_TO_CASE_REFUSED),
	case_operation_write_condition: fixed(
		SAVE_TO_CASE_ROWS,
		SAVE_TO_CASE_REFUSED,
	),
	case_operation_condition: {
		held(doc, ref) {
			if (ref.entity !== "form" || ref.slot !== "case_operation_condition")
				return C["savetocase-open-case-condition"].entry;
			const operationUuid = ref.member.operationUuid;
			const operation = doc.forms[ref.uuid]?.caseOperations?.find(
				(candidate) => candidate.uuid === operationUuid,
			);
			return operation?.action === "create"
				? C["savetocase-open-case-condition"].entry
				: C["savetocase-inside-a-group-whose-display-condition-gates-it"].entry;
		},
		refused: () => SAVE_TO_CASE_REFUSED,
	},
	case_operation_target_expression: fixed(
		C["savetocase-update-case-id-xpath"].entry,
		SAVE_TO_CASE_REFUSED,
	),
	case_operation_link_target_expression: fixed(
		C["savetocase-link-index-name-child-extension-and-unlink-empty"].entry,
		SAVE_TO_CASE_REFUSED,
	),
	module_display_condition: displayCondition(
		C["module-filter-value-lifts-into-predicate"].entry,
		C["module-filter-false-or-false-and-rest-menu-reached-only-by-links"].entry,
		C["module-filter-value-outside-predicate-any-xpath-hq-s-validator"].entry,
	),
	case_form_context_line: fixed(
		C["form-context-value"].entry,
		C["form-context-value-outside"].entry,
	),
	case_detail_tab_filter: fixed(
		C["tab-child-filter"].entry,
		C["tab-child-filter-outside"].entry,
	),
	case_detail_tab_rows: fixed(
		C["tab-custom-rows"].entry,
		C["tab-custom-rows-outside"].entry,
	),
	case_detail_tab_condition: fixed(
		C["tab-condition"].entry,
		C["tab-condition-outside-scope"].entry,
	),
	case_list_filter: fixed(
		C["detail-filter-value-lifts-into-predicate"].entry,
		C["detail-filter-value-outside-predicate"].entry,
	),
	case_list_mapping_condition: {
		held: (doc, ref) => {
			if (ref.entity !== "module" || ref.slot !== "case_list_mapping_condition")
				return undefined;
			const column = doc.modules[ref.uuid]?.caseListConfig?.columns.find(
				(c) => c.uuid === ref.member.columnUuid,
			);
			return column?.kind === "image-map"
				? C["mapping-image-condition"].entry
				: C["mapping-label-condition"].entry;
		},
		refused: () => C["mapping-condition-untyped"].entry,
	},
	case_list_sort_expression: fixed(
		C["calculated-order"].entry,
		C["calculated-order-untyped"].entry,
	),
	case_list_column_expression: fixed(
		C["usexpathexpression-field-xpath-lifting-into-valueexpression"].entry,
		C["usexpathexpression-field-xpath-outside-valueexpression"].entry,
	),
	case_list_action_condition: fixed(
		C["case-list-action-condition"].entry,
		"unrecognized",
	),
	search_button_display_condition: fixed(
		C["search-button-display-condition-lifting-into-predicate"].entry,
		C["search-button-display-condition-outside-predicate"].entry,
	),
	excluded_owner_ids: fixed(
		C["blacklisted-owner-ids-expression-lifting-into-valueexpression"].entry,
		C["blacklisted-owner-ids-expression-outside-valueexpression"].entry,
	),
	search_input_options: fixed(
		C["itemset-nodeset-filter-predicate-lifting-into-predicate"].entry,
		C["itemset-nodeset-filter-predicate-outside-predicate"].entry,
	),
	search_input_default: fixed(
		C["default-value-lifting-into-valueexpression"].entry,
		C["default-value-outside-valueexpression"].entry,
	),
	search_input_hidden_value: fixed(
		C["default-value-lifting-into-valueexpression"].entry,
		C["default-value-outside-valueexpression"].entry,
	),
	search_input_required_when: fixed(C["required-test-text"].entry, M6),
	search_input_validation_rule: fixed(C["validations-0-test-text"].entry, M6),
};

/** The row of a registration's slot. No reader registers a Search field's own
 *  condition: it is a search filter row, read at the search's settle. */
export function slotEntries(slot: SlotName): SlotRow {
	if (slot === "search_input_predicate")
		throw new Error(
			"A Search field's own condition was registered with the expression stage, but it is a search filter row, which `csqlRead.ts::readSearchFilterRow` reads where the search is settled. Read it there instead of registering it.",
		);
	return SLOT_ENTRIES[slot];
}

// ── The raw text of a form's display condition ───────────────────────

/** Whether a form's display condition, read before HQ's interpolation, reads
 *  one of the case's attributes through a bare `#case`: `#case/@status`,
 *  `#case/@case_id`, `#case/@case_type`, `#case/@owner_id`. HQ's build would
 *  write the hashtag as the case's path and then read a standard property, so
 *  the text is tested before it is interpolated.
 *
 *  The grammar gives a hashtag at least one segment, as HQ's own parser
 *  does, so no text holding such a read parses whole. The parser's
 *  error-recovering tree still holds the shape: a `Child` step whose left is
 *  a `HashtagRef` of the type `case` with no `HashtagSegment`, and whose step
 *  is an attribute (`AttrSpecified`). */
export function readsCaseAttributeThroughHashtag(text: string): boolean {
	let found = false;
	parser.parse(text).iterate({
		enter(at) {
			if (found) return false;
			if (at.name !== "Child") return;
			const node = at.node;
			const left = node.firstChild;
			const step = node.lastChild;
			if (left?.name !== "HashtagRef" || step?.name !== "AttrSpecified") return;
			const type = left.getChild("HashtagType");
			if (
				type !== null &&
				text.slice(type.from, type.to) === "case" &&
				left.getChild("HashtagSegment") === null
			)
				found = true;
		},
	});
	return found;
}

/** The first `#case` attribute read of a form's display condition, as the
 *  claim its row makes, where the raw text holds one. */
export function rawTextEntry(
	pending: PendingExpression,
): { readonly entryId: string; readonly reason: string } | undefined {
	if (
		pending.ref.entity !== "form" ||
		pending.ref.slot !== "form_display_condition" ||
		!readsCaseAttributeThroughHashtag(pending.text)
	)
		return undefined;
	return {
		entryId:
			C["form-filter-reading-case-status-case-id-case-type-owner-id"].entry,
		reason: "parse:case-attribute-hashtag",
	};
}

export { visitSyntax } from "../../xpath/formSyntax";

// ── By parse issue ───────────────────────────────────────────────────

const BIND_ATTRIBUTES: ReadonlySet<string> = new Set([
	"relevant",
	"validate",
	"calculate",
	"required",
]);

function inBindAttribute(ref: SlotContextRef): boolean {
	return ref.entity === "field" && BIND_ATTRIBUTES.has(ref.slot);
}
/** A slot of form logic: one the XForm source holds. */
function inFormLogic(ref: SlotContextRef): boolean {
	if (ref.entity === "field") return true;
	if (ref.entity !== "form") return false;
	return (
		ref.slot !== "form_display_condition" &&
		ref.slot !== "form_link_condition" &&
		ref.slot !== "form_link_datum_xpath"
	);
}
/** Whether every character outside the text's string literals is ASCII. The
 *  literals are the grammar's own `StringLiteral` tokens, which the parser
 *  reads in a text it cannot read whole too. */
function asciiOutsideStrings(text: string): boolean {
	const literals: { readonly from: number; readonly to: number }[] = [];
	parser.parse(text).iterate({
		enter(node) {
			if (node.name !== "StringLiteral") return;
			literals.push({ from: node.from, to: node.to });
			return false;
		},
	});
	let literal = 0;
	for (let index = 0; index < text.length; index++) {
		while (
			literal < literals.length &&
			(literals[literal] as { readonly to: number }).to <= index
		)
			literal++;
		const at = literals[literal];
		if (at !== undefined && at.from <= index) continue;
		if (text.charCodeAt(index) > 0x7f) return false;
	}
	return true;
}

/** The syntax of the text an issue spans, where it reads on its own. */
function spannedSyntax(
	pending: PendingExpression,
	issue: { readonly from?: number; readonly to?: number },
): FormSyntax | undefined {
	if (issue.from === undefined || issue.to === undefined) return undefined;
	const slice = pending.text.slice(issue.from, issue.to);
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(slice);
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
	return read.ok ? read.node : undefined;
}

/** The step names and string literals of a syntax tree, in document order. */
function namesIn(node: FormSyntax | undefined): {
	readonly names: readonly string[];
	readonly strings: readonly string[];
} {
	const names: string[] = [];
	const strings: string[] = [];
	if (node !== undefined)
		visitSyntax(node, (at) => {
			if (at.kind === "name") names.push(at.name);
			if (at.kind === "string") strings.push(at.value);
		});
	return { names, strings };
}

/** The entry an instance the parser does not know claims: by the source the
 *  form declares it from where it declares one, then by the scheme of its id.
 *  A declared source outside every scheme is the unrecognized-source entry;
 *  an undeclared id outside every scheme the undeclared-id entry. */
/** The entry an instance id no scheme names, declared by no source, reads under. */
const UNKNOWN_SCHEME_INSTANCE =
	C[
		"referenced-undeclared-instance-id-with-no-known-scheme-or-one@instance-scheme:commcare"
	].entry;

/** The REFUSED class of a case detail's or a form context's expression that cannot be bound to
 *  the selected case, by its slot; undefined for any other slot. */
function caseScopedSlotEntry(slot: string): string | undefined {
	switch (slot) {
		case "case_detail_tab_condition":
			return C["tab-condition-outside-scope"].entry;
		case "case_detail_tab_rows":
			return C["tab-custom-rows-outside"].entry;
		case "case_detail_tab_filter":
			return C["tab-child-filter-outside"].entry;
		case "case_form_context_line":
			return C["form-context-value-outside"].entry;
		default:
			return undefined;
	}
}

function instanceEntry(
	id: string | undefined,
	sources: ReadonlyMap<string, string> | undefined,
): string {
	const src = id === undefined ? undefined : sources?.get(id);
	if (src !== undefined)
		return (
			schemeEntry(sourceSchemeId(src)) ??
			C["declared-and-referenced-instance-with-an-unrecognized-src"].entry
		);
	return (
		(sources === undefined ? schemeEntry(id) : undefined) ??
		C[
			"referenced-undeclared-instance-id-with-no-known-scheme-or-one@instance-scheme:commcare"
		].entry
	);
}

/** The tag of the table an `instance-unknown` issue's read names: by the
 *  source the slot's form declares for the id read
 *  (`jr://fixture/item-list:<tag>`), or, for an id the form does not declare,
 *  by its `item-list:<tag>` id, which HQ's build declares from that source
 *  (`xform.py::add_missing_instances`); undefined for a read of any other
 *  instance. */
export function tableReadTag(
	issue: FormParseIssue,
	pending: PendingExpression,
	form: FormDeclarations,
): string | undefined {
	if (issue.code !== "instance-unknown") return undefined;
	const id = namesIn(spannedSyntax(pending, issue)).strings[0];
	if (id === undefined) return undefined;
	const source = instanceForRead(
		id,
		pending.mode.target === "xform" ? form.instanceSources : undefined,
	);
	return source?.kind === "table" ? source.tag : undefined;
}

/** The id a declared source names an instance by, as CommCare HQ's build
 *  writes each scheme's source (`suite_xml/post_process/instances.py`): the
 *  fixture id of `jr://fixture/<id>`, the remote id of
 *  `jr://instance/remote/<id>`, `ledgerdb` for the ledger's source, and the
 *  legacy `search-input` for `jr://instance/search-input`. */
function sourceSchemeId(src: string): string | undefined {
	const bound = declaredInstance(src);
	switch (bound?.kind) {
		case "table":
			return `item-list:${bound.tag}`;
		case "selected":
			return "selected_cases";
		case "native":
			return bound.id;
		default:
			return undefined;
	}
}

/** The identity for the account of a form's declared source, including
 * runtime data whose read the app model cannot yet hold. HQ's locations
 * factory historically produces the same tree as the commtrack factory. */
export function classifiedInstanceId(
	id: string,
	src: string | undefined,
): string | undefined {
	if (src === undefined) return id;
	if (id === "locations" && src === "jr://fixture/commtrack:locations")
		return id;
	return sourceSchemeId(src);
}

/** The entry an instance id's scheme claims, the text before its first colon;
 *  undefined for a scheme no entry of this table names. */
function schemeEntry(id: string | undefined): string | undefined {
	const scheme = id === undefined ? "" : (id.split(":")[0] ?? "");
	switch (scheme) {
		case "ledgerdb":
			return C["ledgerdb-vellum-id-ledger"].entry;
		case "commtrack":
			return id === "commtrack:locations"
				? C["commtrack-locations-hierarchical@instance-scheme:commtrack"].entry
				: C["commtrack-products-commtrack-programs"].entry;
		case "reports":
			return C[
				"reports-commcare-reports-commcare-reports-commcare-reports@instance-scheme:reports"
			].entry;
		case "commcare":
		case "commcare-reports":
		case "commcare-reports-filters":
			return C[
				"reports-commcare-reports-commcare-reports-commcare-reports@instance-scheme:commcare-reports"
			].entry;
		case "registry":
			return C["registry-jr-instance-remote-registry"].entry;
		case "schedule":
			return C["schedule-m-p-f"].entry;
		case "indicators":
			return C["indicators-call-center-indicators"].entry;
		case "case-search-fixture":
			return C["case-search-fixture"].entry;
		case "search-input":
			// The legacy id, which HQ's build declares from
			// `jr://instance/search-input` (`instances.py::search_input_instances`)
			// and leaves out of every entry (`InstancesHelper.IGNORED_INSTANCES`):
			// Core provides it only while a query is built, so a read anywhere
			// but a Search field's own slots (`parseIssueEntry`) is one after
			// the query.
			return id === "search-input" ? LEGACY_SEARCH_INPUT : undefined;
		default:
			return undefined;
	}
}

/** A read of the legacy search input after the search has ended. */
const LEGACY_SEARCH_INPUT =
	C["legacy-search-input-read-after-the-query-in-the-results-detail"].entry;

/** The root HQ's form builder gives every form's data, under which HQ's
 *  build adds its blocks. */
const FORM_DATA_ROOT = "data";

/** Whether a path the parser could not bind reads a block HQ's build adds to
 *  a form: `meta`, the case block, the worker's record block or a basic
 *  subcase. The parser refuses the path at its first step no question takes,
 *  so the path read is the longest plain path around the issue's span
 *  (`pathAroundSpan`), absolute or read from the question the slot evaluates
 *  at, and its step under the form's root names the block. */
function readsBuildBlock(
	doc: BlueprintDoc,
	pending: PendingExpression,
	issue: { readonly from?: number; readonly to?: number },
): boolean {
	const path = pathAroundSpan(doc, pending, issue, FORM_DATA_ROOT);
	if (path === undefined) return false;
	const [empty, root, block] = path.split("/");
	return (
		empty === "" &&
		root === FORM_DATA_ROOT &&
		block !== undefined &&
		(block === "meta" ||
			block === "case" ||
			block === "commcare_usercase" ||
			block.startsWith("subcase_"))
	);
}

/** A question of the slot's form named in the text, whose choices come from a table or from cases. */
function readsLookupChoices(
	doc: BlueprintDoc,
	pending: PendingExpression,
	node: FormSyntax | undefined,
): boolean {
	const form =
		pending.ref.entity === "form"
			? pending.ref.uuid
			: pending.ref.entity === "field"
				? formOfField(doc, pending.ref.uuid)
				: undefined;
	if (form === undefined) return false;
	const { names } = namesIn(node);
	return Object.values(doc.fields).some((field) => {
		if (!names.includes(field.id) || formOfField(doc, field.uuid) !== form)
			return false;
		const source = (field as { optionsSource?: { kind?: string } })
			.optionsSource;
		return source?.kind === "lookup" || source?.kind === "cases";
	});
}

/** What a form declares beside its expressions that a parse issue's entry
 *  reads: each declared instance's `src` by id, the ids the form's computed
 *  datums give (an advanced form's `arbitrary_datums`), and the absolute
 *  path of each Save to Case create's id (`DraftForm.operationIdPaths`). */
export interface FormDeclarations {
	readonly instanceSources: ReadonlyMap<string, string>;
	readonly computedDatums: ReadonlySet<string>;
	readonly operationIdPaths: ReadonlyMap<string, Uuid>;
}
const NO_DECLARATIONS: FormDeclarations = {
	instanceSources: new Map(),
	computedDatums: new Set(),
	operationIdPaths: new Map(),
};

/** Whether the issue's span stands in the path of a Save to Case create's id
 *  in the slot's form: the parser refuses the path at its first step no
 *  question takes, so the path read is the longest plain path of the slot's
 *  text that holds the span, absolute, or relative or from `current()` read
 *  from the question a question's slot evaluates at (`folds.ts::contextPathText`).
 *  Core reads the path, and HQ's
 *  form builder offers a block's case id as a reference, while Nova holds the
 *  read of a create's id only in a case operation's slots
 *  (`folds.ts::operationId`), so elsewhere it is a form expression Nova's
 *  checker narrows, never a read of a node that is not there. */
function readsOperationId(
	doc: BlueprintDoc,
	pending: PendingExpression,
	issue: { readonly from?: number; readonly to?: number },
	form: FormDeclarations,
): boolean {
	// Every create's id path in the form starts with the form's root.
	const [first] = form.operationIdPaths.keys();
	const root = first?.split("/")[1];
	if (root === undefined) return false;
	const path = pathAroundSpan(doc, pending, issue, root);
	return path !== undefined && form.operationIdPaths.has(path);
}

/** The longest plain path of the slot's text that holds the issue's span, as
 *  absolute text: an absolute path as written, or a relative or `current()`
 *  path read from the question a question's slot evaluates at
 *  (`folds.ts::contextPathText`), the form's root named `root`. Undefined
 *  where no such path holds the span. */
function pathAroundSpan(
	doc: BlueprintDoc,
	pending: PendingExpression,
	issue: { readonly from?: number; readonly to?: number },
	root: string,
): string | undefined {
	const { from, to } = issue;
	if (from === undefined || to === undefined) return undefined;
	let read: ReturnType<typeof readFormSyntax>;
	try {
		read = readFormSyntax(pending.text);
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
	if (!read.ok || read.node === undefined) return undefined;
	const context = questionContext(doc, pending, root);
	let longest: { readonly text: string; readonly length: number } | undefined;
	visitSyntax(read.node, (node) => {
		if (node.from > from || node.to < to) return;
		const text =
			absolutePathText(node) ??
			(context === undefined ? undefined : contextPathText(node, context));
		if (text !== undefined && (longest?.length ?? -1) < node.to - node.from)
			longest = { text, length: node.to - node.from };
	});
	return longest?.text;
}

/** The names from the form's root, named `root`, down to the question a
 *  question's slot evaluates at: the context Core reads a relative path from. */
function questionContext(
	doc: BlueprintDoc,
	pending: PendingExpression,
	root: string,
): readonly string[] | undefined {
	const ref = pending.ref;
	if (ref.entity !== "field") return undefined;
	const formUuid = formOfField(doc, ref.uuid);
	const structure =
		formUuid === undefined ? undefined : formStructure(doc, formUuid);
	const path =
		structure === undefined ? undefined : formFieldPath(structure, ref.uuid);
	return path === undefined ? undefined : [root, ...path];
}

/** "By parse issue", from its second row down: the entry, `"unrecognized"`,
 *  or `"slot-default"`, with the `detail.reason`. The two refusals of HQ's
 *  interpolation are judged here too. The first row, a `#case` attribute
 *  read in a form's display condition, is tested on the raw text before it is
 *  interpolated (`rawTextEntry`). `form` holds what the slot's form declares
 *  beside its expressions: its instances, by id, and the ids its computed
 *  datums give. */
export function parseIssueEntry(
	issue: FormParseIssue | { readonly code: "case-reference" | "fixture-value" },
	doc: BlueprintDoc,
	pending: PendingExpression,
	form: FormDeclarations = NO_DECLARATIONS,
): {
	readonly entryId: string | "unrecognized" | "slot-default";
	readonly reason: string;
} {
	const reason = `parse:${issue.code}`;
	const ref = pending.ref;
	const answer = (entryId: string) => ({ entryId, reason });
	const bindAscii = inBindAttribute(ref) && asciiOutsideStrings(pending.text);
	const spanned = () =>
		"from" in issue ? spannedSyntax(pending, issue) : undefined;
	switch (issue.code) {
		case "case-reference":
			if (ref.slot === "module_display_condition")
				return answer(
					C["module-filter-referencing-case-parent-host-or-a-bare"].entry,
				);
			// An advanced form's filter reads with no case only where every load
			// auto-selects (`menus/modules.ts::formChoosesCase`), which HQ's
			// `AdvancedFormValidator` refuses as "filtering without case".
			if (
				ref.slot === "form_display_condition" &&
				pending.key === "schema:AdvancedForm.form_filter"
			)
				return answer(
					C["a-display-condition-reading-case-user-casedb-with-no-non-auto"]
						.entry,
				);
			if (ref.slot === "form_display_condition")
				return answer(
					C["form-filter-referencing-the-case-database-other-than-through"]
						.entry,
				);
			if (
				ref.slot === "search_input_required_when" ||
				ref.slot === "search_input_validation_rule"
			)
				return answer(M5);
			return answer("slot-default");
		case "fixture-value":
			return answer(C["form-filter-using-fixture-value"].entry);
		case "syntax":
			if (bindAscii)
				return answer(C["an-invalid-xpath-in-a-bind-attribute"].entry);
			if (ref.slot === "module_display_condition")
				return answer(C["module-filter-failing-hq-s-validate-xpath"].entry);
			if (ref.slot === "case_list_filter")
				return answer(
					C["detail-filter-failing-etree-xpath-dummy-filter"].entry,
				);
			// A rule's key that is no expression is no condition a case meets
			// (`proof/checks/manifest_value_classes.py::mapping_condition_outside_predicate`).
			if (ref.slot === "case_list_mapping_condition")
				return answer(C["mapping-condition-untyped"].entry);
			// So is a case detail's or a form context's expression: no condition, rows or
			// value of the selected case (`manifest_value_classes.py::_scoped_verdict`).
			return answer(caseScopedSlotEntry(ref.slot) ?? "unrecognized");
		case "unknown-hashtag":
			return bindAscii
				? answer(C["an-invalid-xpath-in-a-bind-attribute"].entry)
				: answer("slot-default");
		case "arity":
			return bindAscii
				? answer(C["an-invalid-xpath-in-a-bind-attribute"].entry)
				: answer(M2);
		case "unknown-function":
		case "capture-link-not-a-question":
			return answer(C["any-other-function-name"].entry);
		case "union":
			return answer(C["union-a-b@xpath-expr:XPathUnionExpr"].entry);
		case "filter-root":
			return answer(
				C["filter-expression-expr-root-other-than-instance-current"].entry,
			);
		case "axis": {
			const node = spanned();
			const axis =
				node?.kind === "axis"
					? node
					: node?.kind === "child" && node.step.kind === "axis"
						? node.step
						: undefined;
			// `self::node()` and `parent::node()` are refused only by a case,
			// table or place row's path (`formPathBinding.ts::name`): a form
			// path reads both as `.` and `..`.
			if (
				axis !== undefined &&
				(axis.axis === "self" || axis.axis === "parent") &&
				axis.value.kind === "call" &&
				axis.value.name === "node" &&
				axis.value.args.length === 0
			)
				return answer("slot-default");
			return answer(
				C[
					"and-axes-other-than-child-name-or-attribute-name-self-node@xpath-axis:AXIS_DESCENDANT"
				].entry,
			);
		}
		case "parent-after-name":
			return answer(
				C["after-a-named-step-data-a-b@xpath-axis:AXIS_PARENT"].entry,
			);
		case "variable":
			return inFormLogic(ref)
				? answer(
						C["var-in-a-form-expression@xpath-expr:XPathVariableReference"]
							.entry,
					)
				: answer("slot-default");
		case "search-results-remote":
			// A form opened after a search that is not inline finds no results;
			// any other slot that reads them is a setting Nova's record rule
			// holds no query in, the slot's own refusal.
			return ref.entity === "form" || ref.entity === "field"
				? answer(
						C["results-read-in-form-expressions-reached-through-a-search-that"]
							.entry,
					)
				: answer("slot-default");
		case "unknown-datum":
		case "placeholder-datum":
		case "multi-select-datum-value": {
			const { names } = namesIn(spanned());
			if (names.includes("supply_point_id"))
				return answer(
					form.computedDatums.has("supply_point_id")
						? C[
								"session-data-supply-point-id-in-an-advanced-form-whose-computed"
							].entry
						: C[
								"session-data-supply-point-id-anywhere-except-in-an-advanced-form"
							].entry,
				);
			if (names.includes("fingerprintquery"))
				return answer(C["session-data-fingerprintquery"].entry);
			return answer(M1);
		}
		case "unknown-itext":
			return answer(
				C["itext-entry-referenced-only-from-jr-itext-in-an-expression"].entry,
			);
		case "choice-name-not-a-select":
			return readsLookupChoices(doc, pending, spanned())
				? answer(C["jr-choice-name-on-a-lookup-itemset-select"].entry)
				: answer("slot-default");
		case "instance-unknown": {
			const { strings } = namesIn(spanned());
			const entry = instanceEntry(strings[0], form.instanceSources);
			// An instance no scheme names, read by a case detail's or a form context's
			// expression, leaves it unbound to the selected case: the slot's own class, whose
			// entry names an unresolved instance among its causes.
			const scoped = caseScopedSlotEntry(ref.slot);
			if (scoped !== undefined && entry === UNKNOWN_SCHEME_INSTANCE)
				return answer(scoped);
			// A Search field's own slots run while the query is built, where
			// the legacy id reads: Nova holds no such read, for a reason of its
			// own.
			const queryBuild =
				ref.entity === "module" &&
				(ref.slot.startsWith("search_input_") ||
					ref.slot === "excluded_owner_ids");
			return entry === LEGACY_SEARCH_INPUT && queryBuild
				? answer("slot-default")
				: answer(entry);
		}
		case "unknown-table":
		case "lookup-unavailable":
			return answer(M2);
		case "unknown-field":
		case "relative-unknown": {
			if (readsOperationId(doc, pending, issue, form))
				return { entryId: M3, reason: "operation-id-outside-case-operation" };
			return readsBuildBlock(doc, pending, issue) ? answer(M3) : answer(M2);
		}
		case "unknown-location-property": {
			// A reading declares a location property for every name a
			// `location_data` read names but one no location property takes
			// (`worldEntities.ts::worldEntitiesFromReads`).
			const { names } = namesIn(spanned());
			const at = names.lastIndexOf("location_data");
			const name = at < 0 ? undefined : names[at + 1];
			return name !== undefined && locationDataNameRefused(name, doc)
				? answer(
						C[
							"a-read-of-a-place-s-location-data-under-a-name-no-location-property-takes"
						].entry,
					)
				: answer(M2);
		}
		case "relative-above-form":
		case "form-root":
		case "unknown-level":
		case "unknown-column":
		case "table-path-mismatch":
			return answer(M2);
		case "wildcard":
		case "ambiguous-field":
		case "case-alias-unbound":
		case "case-query-untyped":
		case "case-row-attribute":
		case "row-step-after-value":
		case "row-leaves-record":
		case "relative-no-context":
		case "instance-argument":
		case "search-results-unexcluded":
			return answer("slot-default");
		case "unknown-search-input": {
			// A child menu's form reads no Search field of its own menu; where
			// its parent's forms read the search, the read is its parent's.
			const owner =
				ref.entity === "form"
					? ref.uuid
					: ref.entity === "field"
						? formOfField(doc, ref.uuid)
						: undefined;
			return owner !== undefined && childOfInlineSearchMenu(doc, owner)
				? answer(M8)
				: answer("slot-default");
		}
		default: {
			const exhaustive: never = issue;
			throw new Error(
				`The expression reader has no entry for the parse issue ${String((exhaustive as { code: string }).code)}. Place it in findings.ts::parseIssueEntry.`,
			);
		}
	}
}

// ── By checker code ──────────────────────────────────────────────────

/** The node a checker error's path addresses in a tree. */
function nodeAt(
	tree: Expression | undefined,
	path: CheckPath,
): Expression | Term | undefined {
	if (tree === undefined) return undefined;
	let found: Expression | Term | undefined;
	walkExpression(tree, {
		visitExpression(expression, at) {
			if (found === undefined && sameJson(at, path)) found = expression;
		},
		visitTerm(term, at) {
			if (found === undefined && sameJson(at, path)) found = term;
		},
	});
	return found;
}

/** The field a session read of the worker's own data names, where `node` is
 *  one: the name-backed leaf, read from the session and not the worker's own
 *  case. */
function sessionUserDataName(
	node: Expression | Term | undefined,
): string | undefined {
	const term =
		node === undefined
			? undefined
			: "term" in node && node.kind === "term"
				? node.term
				: (node as Term);
	return term?.kind === "session-user" && term.source !== "worker-record"
		? term.field
		: undefined;
}

/** The untyped relation identifier a refused `project` reads through, where
 *  its rows are reached by an index that is not `parent` and names no type. */
function untypedRelation(
	node: Expression | Term | undefined,
): string | undefined {
	if (node === undefined || node.kind !== "project") return undefined;
	let identifier: string | undefined;
	walkExpression(node, {
		visitTerm(term) {
			if (
				identifier === undefined &&
				term.kind === "case-index" &&
				term.identifier !== "parent" &&
				term.caseType === undefined
			)
				identifier = term.identifier;
		},
	});
	return identifier;
}

/** Whether the screen that lists a form chooses a case before it lists the
 *  form: where it does not, HQ's build interpolates the form's display
 *  condition in `case` mode and the device evaluates it with no case chosen. */
function formScreenChoosesCaseFirst(doc: BlueprintDoc, form: Uuid): boolean {
	const moduleUuid = moduleUuidOfForm(doc, form);
	return (
		moduleUuid === undefined ||
		doc.modules[moduleUuid] === undefined ||
		screenChoosesCaseFirst(doc, menuScreenOf(doc, moduleUuid))
	);
}

/**
 * Whether HQ's build refuses a display condition of the form that reads the
 * case (`suite_xml/sections/menus.py::MenuContributor`, `CaseXPathValidationError`):
 * not every form of its menu requires a case, or the menu shows its forms
 * above under a root that is not of its case type or holds a form that requires
 * none (`ModuleBase.root_requires_same_case`). That is the form's own entry;
 * the screen's wider class is the rest.
 */
function hqRefusesCaseFilter(doc: BlueprintDoc, form: Uuid): boolean {
	const requiresCase = (moduleUuid: Uuid) =>
		(doc.formOrder[moduleUuid] ?? []).every((one) => {
			const type = doc.forms[one]?.type;
			return type === "followup" || type === "close";
		});
	const moduleUuid = moduleUuidOfForm(doc, form);
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (moduleUuid === undefined || mod === undefined) return false;
	if (!requiresCase(moduleUuid)) return true;
	if (mod.formsInMenuAbove !== true) return false;
	const rootUuid = mod.parentModuleUuid;
	const root = rootUuid === undefined ? undefined : doc.modules[rootUuid];
	return (
		rootUuid === undefined ||
		root === undefined ||
		root.caseType !== mod.caseType ||
		!requiresCase(rootUuid)
	);
}

/** Whether the menu a form belongs to is a child of a menu whose forms read
 *  the search, and chooses its parent's case from that menu's list. */
export function childOfInlineSearchMenu(
	doc: BlueprintDoc,
	form: Uuid,
): boolean {
	const moduleUuid = moduleUuidOfForm(doc, form);
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	const parentUuid = mod?.parentModuleUuid;
	if (parentUuid === undefined) return false;
	const parent = doc.modules[parentUuid];
	return (
		parent !== undefined &&
		moduleFormsReadSearch(parent) &&
		mod?.parentCaseModuleUuid === parentUuid
	);
}

const SYSTEM_DATES: ReadonlySet<string> = new Set([
	"date_opened",
	"closed_on",
	"last_modified",
]);

/** Whether a comparison reads one of the three system dates on either side:
 *  the comparison the error's path addresses, or, where the path addresses an
 *  operand, any comparison of the tree. */
function comparesSystemDate(
	node: Expression | Term | undefined,
	tree: Expression | undefined,
): boolean {
	const compares = (expression: Expression): boolean => {
		if (
			expression.kind !== "eq" &&
			expression.kind !== "neq" &&
			expression.kind !== "gt" &&
			expression.kind !== "gte" &&
			expression.kind !== "lt" &&
			expression.kind !== "lte"
		)
			return false;
		return [expression.left, expression.right].some(
			(side) =>
				side.kind === "term" &&
				side.term.kind === "prop" &&
				SYSTEM_DATES.has(side.term.property),
		);
	};
	if (node !== undefined && "kind" in node && compares(node as Expression))
		return true;
	if (tree === undefined) return false;
	let found = false;
	walkExpression(tree, {
		visitExpression(expression) {
			if (compares(expression)) found = true;
		},
	});
	return found;
}

/** What a checker error is about: the slot, and whether the text is a search
 *  filter row, which `csqlRead.ts` reads as CSQL, rather than a registration. */
export interface CheckedText {
	readonly ref: SlotContextRef;
	readonly searchRow?: true;
}

/** "By checker code", before the slot's default: the entry, or
 *  `"slot-default"`, with the `detail.reason`. `candidate` is the tree the
 *  error is about; without it the slot's stored tree is read. */
export function checkErrorEntry(
	error: CheckError,
	doc: BlueprintDoc,
	checked: CheckedText,
	candidate?: Expression,
): { readonly entryId: string | "slot-default"; readonly reason: string } {
	const reason =
		error.reason === undefined ? error.code : `${error.code}:${error.reason}`;
	const answer = (entryId: string, why = reason) => ({ entryId, reason: why });
	const ref = checked.ref;
	const searchRow = checked.searchRow === true;
	const tree =
		candidate ??
		(isProseSlotRef(ref) ? undefined : expressionSlotValue(doc, ref));
	const node = nodeAt(tree, error.path);
	// A session read of a name a reading declares no worker property for
	// (`worldEntities.ts::heldWorkerSlugs`), in every slot alike.
	const workerName = sessionUserDataName(node);
	if (
		error.code === "undeclared-worker-field" &&
		workerName !== undefined &&
		workerDataNameRefused(workerName, doc)
	)
		return answer(
			C[
				"a-read-of-the-worker-s-session-data-under-a-name-no-worker-property-takes"
			].entry,
		);
	if (error.code === "time-ordering")
		return answer(
			C[
				"or-with-a-time-on-either-side-a-time-answer-property-or-string@xpath-expr:XPathCmpExpr"
			].entry,
		);
	if (error.code === "arm-unavailable") {
		if (error.reason === "here") return answer(C["here-in-a-form"].entry);
		if (error.reason === "window-width-in-form")
			return answer(C["session-context-window-width-in-form-logic"].entry);
		if (error.reason === "choice-name-dynamic")
			return answer(C["jr-choice-name-on-a-lookup-itemset-select"].entry);
	}
	if (error.code === "search-answer-unavailable") {
		const form =
			ref.entity === "form"
				? ref.uuid
				: ref.entity === "field"
					? formOfField(doc, ref.uuid)
					: undefined;
		if (
			error.reason === "not-forms-read-search" &&
			form !== undefined &&
			childOfInlineSearchMenu(doc, form)
		)
			return answer(M8);
		return answer(
			C["search-input-read-in-form-expressions-reached-through-a-search"].entry,
		);
	}
	if (error.code === "search-results-not-supplied")
		return answer(
			C["results-read-in-form-expressions-reached-through-a-search-that"].entry,
		);
	if (error.code === "datum-not-supplied") return answer(M1);
	if (
		error.code === "case-data-unavailable" &&
		ref.entity === "form" &&
		ref.slot === "form_display_condition" &&
		!formScreenChoosesCaseFirst(doc, ref.uuid)
	)
		return answer(
			hqRefusesCaseFilter(doc, ref.uuid)
				? C["form-filter-referencing-the-case-database-other-than-through"]
						.entry
				: C[
						"form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first"
					].entry,
		);
	if (
		searchRow &&
		error.code === "incompatible-values" &&
		error.reason === "date-datetime" &&
		comparesSystemDate(node, tree)
	)
		return answer(
			C[
				"date-only-comparison-on-date-opened-closed-on-last-modified@csql-metadata:date_opened"
			].entry,
		);
	if (error.code === "arm-unavailable" && error.reason === "project") {
		const identifier = untypedRelation(node);
		// An index identifier outside the element-name grammar Nova keeps
		// unchanged: the relation folds made no proposal for it.
		if (identifier !== undefined)
			return {
				entryId: "slot-default",
				reason: XML_ELEMENT_NAME_PATTERN.test(identifier)
					? `relation:${identifier}`
					: "name:index-identifier",
			};
	}
	if (
		error.code === "arm-unavailable" &&
		(error.reason === "call" ||
			error.reason === "cases" ||
			error.reason === "table-rows" ||
			error.reason === "project" ||
			error.reason === "count")
	)
		return {
			entryId: "slot-default",
			reason: node?.kind === "call" ? `call:${node.fn}` : error.reason,
		};
	if (searchRow) return answer(M7);
	return { entryId: "slot-default", reason };
}

/** A form slot's default: M2 for the codes that say the expression reads what
 *  the form does not hold, which stops the form or reads blank on a device;
 *  M3 for every other code, which CommCare runs and Nova's checker narrows. */
export function formRefusalEntry(code: CheckErrorCode): string {
	switch (code) {
		case "form-answer-unavailable":
		case "case-data-unavailable":
		case "many-values":
			return M2;
		case "unknown-property":
		case "unknown-search-input":
		case "unknown-form-field":
		case "unknown-user-property":
		case "unknown-lookup-table":
		case "unknown-lookup-column":
		case "lookup-table-scope":
		case "unknown-operation-id":
		case "operation-context-value":
		case "unknown-case-type":
		case "property-scope":
		case "case-status-value":
		case "incompatible-values":
		case "ordered-values":
		case "time-ordering":
		case "location-value":
		case "match-value":
		case "match-value-empty":
		case "multi-select-property":
		case "pattern-match-unavailable":
		case "range-order":
		case "relation-origin":
		case "relation-self":
		case "relation-path":
		case "relation-destination":
		case "relation-ambiguous":
		case "date-value":
		case "number-value":
		case "text-or-date-value":
		case "text-or-number-value":
		case "branch-values":
		case "text-value":
		case "expected-value":
		case "constraint-value":
		case "default-not-a-choice":
		case "arm-unavailable":
		case "search-answer-unavailable":
		case "search-results-not-supplied":
		case "search-results-order":
		case "search-results-other-type":
		case "row-scope":
		case "datum-not-supplied":
		case "record-position":
		case "datetime-literal-precision":
		case "format-date-pattern-not-fixed":
		case "closed-on-not-on-device":
		case "case-type-ordering":
		case "epoch-fraction-on-device":
		case "runtime-selected-value-type":
		case "runtime-selected-value-on-device":
		case "distance-not-numeric":
		case "distance-unit-type":
		// A read of worker information by a name the document does not declare
		// yet, as on the expression stage's first pass, which the reading
		// declares and reads again; a name no worker property takes is
		// `checkErrorEntry`'s own entry.
		case "undeclared-worker-field":
		case "worker-property-read-by-name":
			return M3;
		default: {
			const exhaustive: never = code;
			throw new Error(
				`The expression reader has no default for the checker code ${String(exhaustive)}. Place it in findings.ts::formRefusalEntry.`,
			);
		}
	}
}

// ── Names outside a grammar ──────────────────────────────────────────

type NameRefusal = {
	readonly entryId: string | "slot-default";
	readonly reason: string;
};

const NAME_REASONS = {
	property: "name:case-property",
	index: "name:index-identifier",
} as const;

/** Whether a name holds a character past ASCII, which Core reads in a name
 *  and Nova's property grammar does not. */
function nonAscii(name: string): boolean {
	for (let index = 0; index < name.length; index++)
		if (name.charCodeAt(index) > 0x7f) return true;
	return false;
}

/** The refusal of a tree that names a case property outside
 *  `AUTHORED_CASE_PROPERTY_NAME_PATTERN`, or a relation's index identifier
 *  outside `XML_ELEMENT_NAME_PATTERN`, the two grammars Nova keeps such names
 *  in unchanged: a property name that holds a character past ASCII claims the
 *  entry for a key holding one, and every other name the slot's default.
 *  Undefined where every name the tree holds is in its grammar. */
export function nameGrammarEntry(tree: Expression): NameRefusal | undefined {
	let found: NameRefusal | undefined;
	const index = (identifier: string) => {
		if (found === undefined && !XML_ELEMENT_NAME_PATTERN.test(identifier))
			found = { entryId: "slot-default", reason: NAME_REASONS.index };
	};
	walkExpression(tree, {
		visitTerm(term) {
			if (found !== undefined) return;
			if (term.kind === "case-index") index(term.identifier);
			if (term.kind !== "prop" && term.kind !== "form-case") return;
			if (term.kind === "prop" && term.via?.kind === "ancestor")
				for (const step of term.via.via) index(step.identifier);
			if (
				found === undefined &&
				!AUTHORED_CASE_PROPERTY_NAME_PATTERN.test(term.property)
			)
				found = {
					entryId: nonAscii(term.property)
						? C["update-key-holding-a-non-ascii-core-name-character"].entry
						: "slot-default",
					reason: NAME_REASONS.property,
				};
		},
	});
	return found;
}

// ── The key a claim is made under ────────────────────────────────────

/** The surface key a refusal's claim is made under: the slot's own key where
 *  the entry holds it, else the key of a use the expression's syntax makes
 *  that a member of the entry is registered under, else the first member's
 *  key, and the slot's own key for an entry no surface key holds. */
export function claimKey(
	entryId: string,
	slotKey: string,
	useKeys: readonly string[],
): string {
	if (inventoryIndex().entry(entryId)?.surfaceKeys.includes(slotKey) === true)
		return slotKey;
	return (
		claimKeyOfUse(entryId, useKeys) ??
		Object.values(EXPRESSION_CLAIMS).find(
			(claim) => claim.entry === entryId && claim.key !== null,
		)?.key ??
		slotKey
	);
}

/** The first of `useKeys` a member of the entry is registered under: the use
 *  of the expression's syntax a refusal under that entry stands for. */
export function claimKeyOfUse(
	entryId: string,
	useKeys: readonly string[],
): string | undefined {
	const keys = new Set(
		Object.values(EXPRESSION_CLAIMS).flatMap((claim) =>
			claim.entry === entryId && claim.key !== null ? [claim.key] : [],
		),
	);
	return useKeys.find((key) => keys.has(key));
}
