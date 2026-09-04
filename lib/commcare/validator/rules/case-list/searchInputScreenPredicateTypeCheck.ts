/**
 * Rule: the Search-screen slots a search input carries beside its match
 * type-check and read only what the Search screen can see.
 *
 * Four slots evaluate ON the Search screen, before any case exists:
 *
 *   - `required.when` (the prompt's `<required test>`),
 *   - `validation.rule` (the prompt's `<validation test>`),
 *   - a hidden input's `value` (the prompt's `default`), and
 *   - a choice input's `options.filter` (the `<itemset>` nodeset predicate).
 *
 * All four share the global guard the starting-value rule applies: there is
 * no case row, so a property, count, exists, or missing read is refused
 * (`…_CASE_DATA_UNAVAILABLE`). They differ in what else they may read:
 *
 *   - `required.when` and `validation.rule` run with the search-input
 *     instance loaded (`RemoteQuerySessionManager.validateUserAnswers`
 *     evaluates both against `search-input:<storage>`), so a bare
 *     `input(...)` of ANY sibling is valid here, no `when-input-present`
 *     envelope needed. An unanswered sibling reads as blank; `is-blank`
 *     is the honest "not answered" test. `searchInputRefUsesWhenInputPresent`
 *     therefore leaves these two slots alone.
 *   - A hidden input's `value` re-evaluates at every query-screen
 *     construction, before answers exist, so it may read no input at all.
 *     That refusal lives with the other forbids-input-ref slots in
 *     `searchInputRefUsesWhenInputPresent`; this rule owns its type.
 *   - `options.filter` is a lookup-row predicate: the same table-row scope a
 *     lookup-backed form select carries (`rules/lookupOptionsSource.ts`),
 *     minus form answers, because there is no form. Columns of the source
 *     table, fixed values, and current-user/session values are the whole
 *     vocabulary; case data and Search answers reject with the concrete
 *     repair. Its date arithmetic must also run on the device, since the
 *     itemset predicate is evaluated by JavaRosa when the screen builds.
 *
 * Type errors surface with the AST path so the editor lands on the node.
 * Match modes and date arithmetic in `required.when` / `validation.rule` are
 * judged by the shared wire-slot rules through `moduleWireSlots.ts`.
 */

import { findOnDeviceDateAddIssueInPredicate } from "@/lib/commcare/expression/onDeviceCompatibility";
import type { BlueprintDoc, LookupTableId, Module, Uuid } from "@/lib/domain";
import { searchInputOptions } from "@/lib/domain";
import {
	type CheckError,
	checkPredicate,
	checkValueExpression,
	expressionReadsCaseData,
	type Predicate,
	type PredicateAstPath,
	predicateReadsCaseData,
	type TypeContext,
	walkTermsWithPaths,
} from "@/lib/domain/predicate";
import {
	type ValidationError,
	type ValidationErrorCode,
	validationError,
} from "../../errors";
import {
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";
import { formatPath, moduleTypeContext } from "./shared";

/**
 * Checker codes the options-filter leaf policy below already reports with a
 * concrete repair, so the generic type finding never duplicates them.
 */
const OPTIONS_FILTER_POLICY_CODES: ReadonlySet<CheckError["code"]> = new Set([
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

export function searchInputScreenPredicateTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	if (inputs.length === 0) return [];

	const ctx = moduleTypeContext(mod, doc, lookupTables);
	const errors: ValidationError[] = [];

	for (let index = 0; index < inputs.length; index++) {
		const input = inputs[index];
		const who = `Search input "${input.label || input.name}" (input #${index + 1}, name "${input.name}") on the case list of module "${mod.name}"`;
		const identity = {
			index: String(index),
			inputName: input.name,
			inputUuid: input.uuid,
		};

		if (input.kind === "hidden") {
			const slot = `caseListConfig.searchInputs[${index}].value`;
			if (expressionReadsCaseData(input.value)) {
				errors.push(
					validationError(
						"CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_CASE_DATA_UNAVAILABLE",
						"module",
						`${who} is a hidden value that reads a case property or relationship, but it is worked out when the Search screen opens, before any case is selected. There is no case to read, so the value would be blank on every runtime. Use \`now()\`, \`today()\`, a fixed value, or a current-user/session value.`,
						{ moduleUuid, moduleName: mod.name },
						{ ...identity, slot },
					),
				);
				continue;
			}
			for (const err of semanticCheckErrors(
				checkValueExpression(input.value, ctx),
			)) {
				const path = formatPath(err.path);
				errors.push(
					validationError(
						"CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_TYPE_ERROR",
						"module",
						`${who} has a hidden value that doesn't type-check${path ? ` (at ${path})` : ""}: ${err.message}. Open the field's editor and adjust the operand at that path.`,
						{ moduleUuid, moduleName: mod.name },
						{ ...identity, slot, path, checkCode: err.code },
					),
				);
			}
			continue;
		}

		if (input.required?.when !== undefined) {
			errors.push(
				...screenPredicateFindings({
					predicate: input.required.when,
					ctx,
					mod,
					moduleUuid,
					who,
					identity,
					slot: `caseListConfig.searchInputs[${index}].required.when`,
					noun: "a required condition",
					caseDataCode:
						"CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_CASE_DATA_UNAVAILABLE",
					typeCode: "CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_TYPE_ERROR",
				}),
			);
		}
		if (input.validation !== undefined) {
			errors.push(
				...screenPredicateFindings({
					predicate: input.validation.rule,
					ctx,
					mod,
					moduleUuid,
					who,
					identity,
					slot: `caseListConfig.searchInputs[${index}].validation.rule`,
					noun: "a check",
					caseDataCode:
						"CASE_LIST_SEARCH_INPUT_VALIDATION_RULE_CASE_DATA_UNAVAILABLE",
					typeCode: "CASE_LIST_SEARCH_INPUT_VALIDATION_RULE_TYPE_ERROR",
				}),
			);
		}

		const options = searchInputOptions(input);
		if (options?.filter !== undefined) {
			errors.push(
				...optionsFilterFindings({
					filter: options.filter,
					tableId: options.tableId,
					ctx,
					mod,
					moduleUuid,
					who,
					identity,
					slot: `caseListConfig.searchInputs[${index}].options.filter`,
				}),
			);
		}
	}

	return errors;
}

function screenPredicateFindings(args: {
	readonly predicate: Predicate;
	readonly ctx: TypeContext;
	readonly mod: Module;
	readonly moduleUuid: Uuid;
	readonly who: string;
	readonly identity: Record<string, string>;
	readonly slot: string;
	readonly noun: string;
	readonly caseDataCode: ValidationErrorCode;
	readonly typeCode: ValidationErrorCode;
}): ValidationError[] {
	const { mod, moduleUuid, who, identity, slot, noun } = args;
	if (predicateReadsCaseData(args.predicate)) {
		return [
			validationError(
				args.caseDataCode,
				"module",
				`${who} has ${noun} that reads a case property or relationship, but it runs on the Search screen before any case is selected. There is no case to read, so the condition can never hold. Compare the other search answers, fixed values, or current-user/session values instead.`,
				{ moduleUuid, moduleName: mod.name },
				{ ...identity, slot },
			),
		];
	}
	return semanticCheckErrors(checkPredicate(args.predicate, args.ctx)).map(
		(err) => {
			const path = formatPath(err.path);
			return validationError(
				args.typeCode,
				"module",
				`${who} has ${noun} that doesn't type-check${path ? ` (at ${path})` : ""}: ${err.message}. Open the condition in the Search canvas and adjust the operand at that path.`,
				{ moduleUuid, moduleName: mod.name },
				{ ...identity, slot, path, checkCode: err.code },
			);
		},
	);
}

function optionsFilterFindings(args: {
	readonly filter: Predicate;
	readonly tableId: LookupTableId;
	readonly ctx: TypeContext;
	readonly mod: Module;
	readonly moduleUuid: Uuid;
	readonly who: string;
	readonly identity: Record<string, string>;
	readonly slot: string;
}): ValidationError[] {
	const { filter, mod, moduleUuid, who, identity, slot } = args;
	const errors: ValidationError[] = [];
	const seen = new Set<string>();
	const pushOnce = (key: string, finding: () => ValidationError): void => {
		if (seen.has(key)) return;
		seen.add(key);
		errors.push(finding());
	};
	const scopeFinding = (
		message: string,
		details: Record<string, string>,
	): ValidationError =>
		validationError(
			"CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_SCOPE",
			"module",
			message,
			{ moduleUuid, moduleName: mod.name },
			{ ...identity, slot, tableId: args.tableId, ...details },
		);

	if (predicateReadsCaseData(filter)) {
		pushOnce("case-data", () =>
			scopeFinding(
				`${who} narrows its choices with a rule that reads case data, but the choices are built from the data table when the Search screen opens, before any case exists. Use columns from this table, fixed values, or current-user/session values.`,
				{ reason: "case-data" },
			),
		);
	}
	walkTermsWithPaths(filter, (term, path: PredicateAstPath): void => {
		const at = formatPath([...path]);
		if (term.kind === "input") {
			pushOnce(`search-input:${term.searchInputUuid}`, () =>
				scopeFinding(
					`${who} narrows its choices with a rule that reads another search answer${at ? ` (at ${at})` : ""}, but the choices are built once when the Search screen opens, before anyone has answered. Use columns from this table, fixed values, or current-user/session values.`,
					{
						reason: "search-input",
						inputRefUuid: term.searchInputUuid,
						path: at,
					},
				),
			);
		} else if (term.kind === "field") {
			pushOnce(`field:${term.uuid}`, () =>
				scopeFinding(
					`${who} narrows its choices with a rule that reads a form answer${at ? ` (at ${at})` : ""}, but the Search screen is not inside a form. Use columns from this table, fixed values, or current-user/session values.`,
					{ reason: "form-field", referencedFieldUuid: term.uuid, path: at },
				),
			);
		}
	});

	const columns = args.ctx.lookupTables?.get(args.tableId) ?? new Map();
	const rowCtx: TypeContext = {
		caseTypes: [],
		knownInputs: [],
		...(args.ctx.userPropertySlugs !== undefined && {
			userPropertySlugs: args.ctx.userPropertySlugs,
		}),
		...(args.ctx.lookupTables !== undefined && {
			lookupTables: args.ctx.lookupTables,
		}),
		tableScope: { tableId: args.tableId, columns },
	};
	for (const err of semanticCheckErrors(checkPredicate(filter, rowCtx)).filter(
		(error) => !OPTIONS_FILTER_POLICY_CODES.has(error.code),
	)) {
		const path = formatPath(err.path);
		errors.push(
			validationError(
				"CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_TYPE_ERROR",
				"module",
				`${who} narrows its choices with a rule that doesn't type-check${path ? ` (at ${path})` : ""}: ${err.message}. Open the field's Choices section and adjust the operand at that path.`,
				{ moduleUuid, moduleName: mod.name },
				{ ...identity, slot, path, checkCode: err.code, tableId: args.tableId },
			),
		);
	}

	const issue = findOnDeviceDateAddIssueInPredicate(filter, rowCtx);
	if (issue !== undefined) {
		const reason =
			issue.reason === "datetime-base"
				? "starts from a date and time, and running it on the device would discard the time"
				: `adds calendar-relative ${issue.expression.interval}, which the device cannot calculate faithfully`;
		errors.push(
			validationError(
				"CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_NOT_ON_DEVICE",
				"module",
				`${who} narrows its choices with a rule that cannot run on the device because it ${reason}. Use a whole date with seconds, minutes, hours, days, or weeks, or rewrite the comparison.`,
				{ moduleUuid, moduleName: mod.name },
				{
					...identity,
					slot,
					reason: issue.reason,
					interval: issue.expression.interval,
					tableId: args.tableId,
				},
			),
		);
	}
	return errors;
}
