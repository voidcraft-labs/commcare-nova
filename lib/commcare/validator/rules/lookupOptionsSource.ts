/**
 * Semantic validation for lookup-backed select filters.
 *
 * Structural table/column existence is owned by the production lookup
 * extractor. This rule owns the row-scope and form-answer contract that a
 * rows-free definition snapshot can prove:
 *
 * - table columns belong to the source table;
 * - case/Search reads are unavailable;
 * - form answers come from an earlier field in effective `(order, uuid)` DFS;
 * - repeated answers come only from the current or an enclosing repeat.
 *
 * Generic expression operators remain available. The policy is on their leaf
 * sources, so pure arithmetic/conditionals over legal leaves do not need a
 * second hand-maintained operator allowlist.
 */

import {
	type FormFieldEntry,
	formFieldEntriesFor,
	lookupFilterEligibleFormFields,
	lookupFilterFormFieldAdmission,
} from "@/lib/doc/formFieldEntries";
import type { BlueprintDoc, Field, Module, Uuid } from "@/lib/domain";
import {
	type CheckError,
	checkPredicate,
	type PredicateAstPath,
	predicateReadsCaseData,
	type TypeContext,
	walkTermsWithPaths,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../errors";
import {
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../lookupTypeContext";
import { formatPath } from "./case-list/shared";

/**
 * Checker diagnostics owned by the select-filter leaf policy below. The
 * checker receives no case/Search declarations on purpose: those contexts do
 * not exist while lookup choices are built. Missing/non-value form answers
 * are likewise reported by the field-policy finding with the repair the
 * author needs. Operator/result diagnostics for admitted leaves remain.
 */
const POLICY_OWNED_CHECK_CODES: ReadonlySet<CheckError["code"]> = new Set([
	"unknown-case-type",
	"unknown-property",
	"property-scope",
	"relation-origin",
	"relation-self",
	"relation-path",
	"relation-destination",
	"relation-ambiguous",
	"unknown-search-input",
	"unknown-form-field",
]);

function eligibleFormFieldTypes(args: {
	readonly entries: readonly FormFieldEntry[];
	readonly currentFieldUuid: Uuid;
}): NonNullable<TypeContext["formFields"]> {
	return new Map(
		lookupFilterEligibleFormFields(args.entries, args.currentFieldUuid).map(
			(entry) => [entry.uuid, entry.dataType],
		),
	);
}

function location(
	mod: Module,
	moduleUuid: Uuid,
	formUuid: Uuid,
	formName: string,
	field: Field,
) {
	return {
		moduleUuid,
		moduleName: mod.name,
		formUuid,
		formName,
		fieldUuid: field.uuid,
		fieldId: field.id,
		field: "optionsSource.filter",
	};
}

function policyFinding(args: {
	readonly code:
		| "LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED"
		| "LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER"
		| "LOOKUP_SELECT_FILTER_FIELD_REPEAT_SCOPE";
	readonly mod: Module;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly formName: string;
	readonly field: Field;
	readonly message: string;
	readonly details: Record<string, string>;
}): ValidationError {
	return validationError(
		args.code,
		"field",
		args.message,
		location(
			args.mod,
			args.moduleUuid,
			args.formUuid,
			args.formName,
			args.field,
		),
		args.details,
	);
}

function selectFilterFindings(args: {
	readonly mod: Module;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly formName: string;
	readonly field: Field;
	readonly entries: readonly FormFieldEntry[];
	readonly entriesByUuid: ReadonlyMap<Uuid, FormFieldEntry>;
	readonly lookupTables: LookupTypeIndex;
}): ValidationError[] {
	const { field } = args;
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return [];
	const source = field.optionsSource;
	if (source.kind !== "lookup" || source.filter === undefined) return [];

	const errors: ValidationError[] = [];
	const seenPolicy = new Set<string>();
	const pushOnce = (key: string, finding: () => ValidationError): void => {
		if (seenPolicy.has(key)) return;
		seenPolicy.add(key);
		errors.push(finding());
	};

	if (predicateReadsCaseData(source.filter)) {
		pushOnce("case-data", () =>
			policyFinding({
				code: "LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED",
				...args,
				message: `Lookup choices for field "${field.id}" in "${args.formName}" read case data, but choices are built from one lookup row before any case-row context exists. Use columns from this lookup table, fixed values, current-user/session values, or an eligible earlier form answer.`,
				details: {
					reason: "case-data",
					target: "case-data",
					tableId: source.tableId,
				},
			}),
		);
	}

	walkTermsWithPaths(source.filter, (term, path: PredicateAstPath): void => {
		const at = formatPath([...path]);
		if (term.kind === "input") {
			const inputName =
				args.mod.caseListConfig?.searchInputs.find(
					(input) => input.uuid === term.searchInputUuid,
				)?.name ?? term.searchInputUuid;
			pushOnce(`search-input:${term.searchInputUuid}`, () =>
				policyFinding({
					code: "LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED",
					...args,
					message: `Lookup choices for field "${field.id}" in "${args.formName}" read Search answer "${inputName}"${at ? ` at ${at}` : ""}, but a form question's choices are built outside the case-search screen. Use a lookup column, fixed value, current-user/session value, or eligible earlier form answer.`,
					details: {
						reason: "search-input",
						target: `input:${term.searchInputUuid}`,
						inputName,
						inputUuid: term.searchInputUuid,
						path: at,
						tableId: source.tableId,
					},
				}),
			);
			return;
		}
		if (term.kind !== "field") return;

		const referenced = args.entriesByUuid.get(term.uuid);
		const admission = lookupFilterFormFieldAdmission(
			args.entries,
			field.uuid,
			term.uuid,
		);
		const admissionReason = admission.admitted ? undefined : admission.reason;
		if (
			referenced === undefined ||
			admissionReason === "field-unavailable" ||
			admissionReason === "current-field-unavailable"
		) {
			pushOnce(`field-unavailable:${term.uuid}`, () =>
				policyFinding({
					code: "LOOKUP_SELECT_FILTER_TERM_NOT_ALLOWED",
					...args,
					message: `Lookup choices for field "${field.id}" in "${args.formName}" refer to form field "${term.uuid}"${at ? ` at ${at}` : ""}, but that field is missing or has no answer value. Choose a value-bearing field in this form.`,
					details: {
						reason: "field-unavailable",
						target: `field:${term.uuid}`,
						referencedFieldUuid: term.uuid,
						path: at,
						tableId: source.tableId,
					},
				}),
			);
			return;
		}

		if (admissionReason === "field-repeat-scope") {
			pushOnce(`field-repeat:${term.uuid}`, () =>
				policyFinding({
					code: "LOOKUP_SELECT_FILTER_FIELD_REPEAT_SCOPE",
					...args,
					message: `Lookup choices for field "${field.id}" in "${args.formName}" read "${referenced.id}" from a child, sibling, or unrelated repeat${at ? ` at ${at}` : ""}. A lookup filter may read root answers plus earlier answers from its current or an enclosing repeat only.`,
					details: {
						referencedFieldUuid: term.uuid,
						referencedFieldId: referenced.id,
						path: at,
						tableId: source.tableId,
					},
				}),
			);
			return;
		}

		if (admissionReason === "field-not-earlier") {
			pushOnce(`field-order:${term.uuid}`, () =>
				policyFinding({
					code: "LOOKUP_SELECT_FILTER_FIELD_NOT_EARLIER",
					...args,
					message: `Lookup choices for field "${field.id}" in "${args.formName}" read "${referenced.id}"${at ? ` at ${at}` : ""}, but that answer is not earlier in the form's effective order. Move the source question earlier or remove the dependency.`,
					details: {
						referencedFieldUuid: term.uuid,
						referencedFieldId: referenced.id,
						path: at,
						tableId: source.tableId,
					},
				}),
			);
		}
	});

	const columns = args.lookupTables.get(source.tableId) ?? new Map();
	const ctx: TypeContext = {
		caseTypes: [],
		knownInputs: [],
		formFields: eligibleFormFieldTypes({
			entries: args.entries,
			currentFieldUuid: field.uuid,
		}),
		lookupTables: args.lookupTables,
		tableScope: { tableId: source.tableId, columns },
	};
	const typeErrors = semanticCheckErrors(
		checkPredicate(source.filter, ctx),
	).filter((error) => !POLICY_OWNED_CHECK_CODES.has(error.code));
	for (const error of typeErrors) {
		const at = formatPath(error.path);
		errors.push(
			validationError(
				"LOOKUP_SELECT_FILTER_TYPE_ERROR",
				"field",
				`Lookup choices for field "${field.id}" in "${args.formName}" have a filter type error${at ? ` at ${at}` : ""}: ${error.message}`,
				location(
					args.mod,
					args.moduleUuid,
					args.formUuid,
					args.formName,
					field,
				),
				{
					path: at,
					checkCode: error.code,
					tableId: source.tableId,
				},
			),
		);
	}

	return errors;
}

/**
 * Validate lookup-backed select filters reachable from one form. Detached
 * records stay the structural extractor's responsibility; attaching one to a
 * form makes this semantic rule run before the mutation can commit.
 */
export function validateLookupOptionsSources(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
	lookupTables: LookupTypeIndex,
): ValidationError[] {
	const form = doc.forms[formUuid];
	const mod = doc.modules[moduleUuid];
	const entries = formFieldEntriesFor(doc.fields, doc.fieldOrder, formUuid);
	const entriesByUuid = new Map(entries.map((entry) => [entry.uuid, entry]));
	const errors: ValidationError[] = [];
	for (const entry of entries) {
		const field = doc.fields[entry.uuid];
		if (field === undefined) continue;
		errors.push(
			...selectFilterFindings({
				mod,
				moduleUuid,
				formUuid,
				formName: form.name,
				field,
				entries,
				entriesByUuid,
				lookupTables,
			}),
		);
	}
	return errors;
}
