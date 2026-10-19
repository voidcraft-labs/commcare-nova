/** Search-screen slot findings project the checker over each actual input slot. */
import { findOnDeviceDateAddIssue } from "@/lib/commcare/validator/onDeviceCompatibility";
import {
	type BlueprintDoc,
	type Module,
	searchInputOptions,
	type Uuid,
} from "@/lib/domain";
import {
	type CheckError,
	checkExpression,
	type Expression,
	type ExpressionContext,
	type ModuleExpressionSlotRef,
	slotContext,
	type Term,
	walkExpressionTerms,
} from "@/lib/domain/expression";
import {
	type ValidationError,
	type ValidationErrorCode,
	validationError,
} from "../../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";
import { formatPath } from "./shared";

export function searchInputScreenPredicateTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const [index, input] of (
		mod.caseListConfig?.searchInputs ?? []
	).entries()) {
		const who = `Search input "${input.label || input.name}" (input #${index + 1}, name "${input.name}") on the case list of module "${mod.name}"`;
		const identity = {
			index: String(index),
			inputName: input.name,
			inputUuid: input.uuid,
		};
		const context = (
			slot: Extract<
				ModuleExpressionSlotRef,
				{ member: { searchInputUuid: Uuid } }
			>["slot"],
		) =>
			slotContext(
				doc,
				{
					entity: "module",
					uuid: moduleUuid,
					slot,
					member: { searchInputUuid: input.uuid },
				},
				lookupTables ?? new Map(),
			);
		if (input.kind === "hidden") {
			const ctx = context("search_input_hidden_value");
			if (ctx !== undefined)
				errors.push(
					...screenFindings({
						expression: input.value,
						ctx,
						mod,
						moduleUuid,
						who,
						identity,
						slot: `caseListConfig.searchInputs[${index}].value`,
						noun: "a hidden value",
						caseDataCode:
							"CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_CASE_DATA_UNAVAILABLE",
						typeCode: "CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_TYPE_ERROR",
					}),
				);
			continue;
		}
		if (input.required?.when !== undefined) {
			const ctx = context("search_input_required_when");
			if (ctx !== undefined)
				errors.push(
					...screenFindings({
						expression: input.required.when,
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
			const ctx = context("search_input_validation_rule");
			if (ctx !== undefined)
				errors.push(
					...screenFindings({
						expression: input.validation.rule,
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
			const ctx = context("search_input_options");
			if (ctx !== undefined)
				errors.push(
					...optionsFilterFindings({
						expression: options.filter,
						ctx,
						mod,
						moduleUuid,
						who,
						identity: { ...identity, tableId: options.tableId },
						slot: `caseListConfig.searchInputs[${index}].options.filter`,
					}),
				);
		}
	}
	return errors;
}
interface ScreenSlot {
	readonly expression: Expression;
	readonly ctx: ExpressionContext;
	readonly mod: Module;
	readonly moduleUuid: Uuid;
	readonly who: string;
	readonly identity: Record<string, string>;
	readonly slot: string;
}
function screenFindings(
	args: ScreenSlot & {
		readonly noun: string;
		readonly caseDataCode: ValidationErrorCode;
		readonly typeCode: ValidationErrorCode;
	},
): ValidationError[] {
	const { mod, moduleUuid, who, identity, slot, noun } = args;
	const errors = semanticCheckErrors(
		checkExpression(args.expression, args.ctx),
	);
	const caseData = errors.find(
		(error) => error.code === "case-data-unavailable",
	);
	if (caseData !== undefined)
		return [
			validationError(
				args.caseDataCode,
				"module",
				`${who} has ${noun} that reads case information before a case is selected. Use fixed values or current-user information instead.`,
				{ moduleUuid, moduleName: mod.name },
				{ ...identity, slot, ...checkErrorDetails(caseData) },
			),
		];
	return errors
		.filter((error) => error.code !== "search-answer-unavailable")
		.map((error) =>
			validationError(
				args.typeCode,
				"module",
				`${who} has ${noun} that needs a change${formatPath(error.path) ? ` (at ${formatPath(error.path)})` : ""}: ${error.message}`,
				{ moduleUuid, moduleName: mod.name },
				{ ...identity, slot, ...checkErrorDetails(error) },
			),
		);
}
function optionsFilterFindings(args: ScreenSlot): ValidationError[] {
	const { mod, moduleUuid, who, identity, slot } = args;
	const errors: ValidationError[] = [];
	const terms = new Map<string, Term>();
	walkExpressionTerms(args.expression, (term, path) =>
		terms.set(JSON.stringify(path), term),
	);
	const seen = new Set<string>();
	for (const error of semanticCheckErrors(
		checkExpression(args.expression, args.ctx),
	)) {
		const term = terms.get(JSON.stringify(error.path));
		const reason = scopeReason(error);
		const key =
			reason === "case-data"
				? reason
				: reason === "search-input" && term?.kind === "input"
					? `${reason}:${term.searchInputUuid}`
					: reason === "form-field" && term?.kind === "field"
						? `${reason}:${term.uuid}`
						: undefined;
		if (key !== undefined && seen.has(key)) continue;
		if (key !== undefined) seen.add(key);
		errors.push(
			validationError(
				reason === undefined
					? "CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_TYPE_ERROR"
					: "CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_SCOPE",
				"module",
				`${who} narrows its choices with a rule that needs a change: ${error.message}`,
				{ moduleUuid, moduleName: mod.name },
				{
					...identity,
					slot,
					...checkErrorDetails(error),
					...(reason === undefined ? {} : { reason }),
					...(term?.kind === "input"
						? { inputRefUuid: term.searchInputUuid }
						: {}),
					...(term?.kind === "field" ? { referencedFieldUuid: term.uuid } : {}),
				},
			),
		);
	}
	const issue = findOnDeviceDateAddIssue(args.expression, args.ctx);
	if (issue !== undefined)
		errors.push(
			validationError(
				"CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_NOT_ON_DEVICE",
				"module",
				`${who} narrows its choices with a date calculation that cannot run on the device. Use a whole date with seconds, minutes, hours, days, or weeks.`,
				{ moduleUuid, moduleName: mod.name },
				{
					...identity,
					slot,
					reason: issue.reason,
					interval: issue.expression.interval,
				},
			),
		);
	return errors;
}
function scopeReason(
	error: CheckError,
): "case-data" | "search-input" | "form-field" | undefined {
	if (error.code === "case-data-unavailable") return "case-data";
	if (
		error.code === "search-answer-unavailable" ||
		error.code === "unknown-search-input"
	)
		return "search-input";
	if (
		error.code === "form-answer-unavailable" ||
		error.code === "unknown-form-field"
	)
		return "form-field";
	return undefined;
}
