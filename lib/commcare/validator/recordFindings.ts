/**
 * Three facts every record slot reports the same way whatever slot holds the
 * read, the way form logic reports them: a read of Date closed where a device
 * evaluates it (`CASE_LIST_CLOSED_ON_NOT_ON_DEVICE`), a read
 * of the case chosen in a menu the slot's entries don't supply before it runs
 * (`SESSION_DATUM_NOT_SUPPLIED`), and a leaf a platform the app declares
 * lacks (the checker's `platform-unavailable`, which keeps its slot's code
 * and takes the platform refusal's message). Each record rule wraps its
 * checker findings in its own slot code with `checkErrorDetails`; the runner
 * re-codes the first two and re-words the third here, so a new record rule
 * needs no code of its own.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	declaredPlatforms,
	PLATFORM_FEATURE_IDS,
	PLATFORMS,
	platformRefusalMessage,
} from "@/lib/domain/platforms";
import type { Uuid } from "@/lib/domain/uuid";
import type { ValidationError } from "./errors";

/** The person-facing sentence of a record slot's chosen-case read the
 * entries don't supply (the validator's message and
 * `lib/doc/userFacingErrors.ts` share it). */
export function chosenCaseReadSentence(details: {
	readonly carrier: string;
	readonly reason: string;
	readonly moduleName: string;
	readonly formName?: string;
	readonly menuName: string;
	readonly otherModuleName?: string;
}): string {
	const menu = `"${details.menuName}"`;
	const module = `"${details.moduleName}"`;
	if (details.carrier === "form-display-condition") {
		const form = `"${details.formName ?? "This form"}"`;
		return details.reason === "several-cases"
			? `${form} shows only when the case chosen in ${menu} matches, but ${menu} now lets workers choose several cases, so there is no one chosen case to read. You can let ${menu} choose one case, or base the condition on the worker instead.`
			: `${form} shows only when the case chosen in ${menu} matches, but its menu shows before that case is chosen. You can choose the case before this menu, or base the condition on the worker instead.`;
	}
	const list =
		details.carrier === "search"
			? `The search in ${module}`
			: `The case list of ${module}`;
	switch (details.reason) {
		case "differs":
			return `${list} reads the case chosen in ${menu}, but "${details.otherModuleName ?? "another module"}" also shows this list, and there CommCare keeps that choice in another place, so the read would not find that case. You can remove the read, or give "${details.otherModuleName ?? "that module"}" its own list to choose from.`;
		case "several-cases":
			return `${list} reads the case chosen in ${menu}, but ${menu} now lets workers choose several cases, so there is no one chosen case to read. You can let ${menu} choose one case, or remove that read.`;
		default:
			return `${list} reads the case chosen in ${menu}, but ${module} no longer opens after ${menu}, so CommCare has no chosen case to read there. You can open ${module} from ${menu} again, or remove that read.`;
	}
}

/** The carriers of a record slot that reads a chosen case
 * (`typeChecker.ts::chosenCaseCarrier`); a form-logic or link finding names
 * its own carrier and keeps its code. */
const RECORD_CARRIERS: ReadonlySet<string> = new Set([
	"case-list",
	"search",
	"form-display-condition",
]);

/** A record slot's finding re-coded for the two shared facts; every other
 * finding is returned unchanged. `slotCode` keeps the slot's own code, by
 * which `userFacingErrors.ts` names the setting. */
export function sharedRecordFinding(
	doc: BlueprintDoc,
	error: ValidationError,
): ValidationError {
	const details = error.details;
	if (details === undefined) return error;
	if (
		details.checkCode === "closed-on-not-on-device" &&
		error.code !== "CASE_LIST_CLOSED_ON_NOT_ON_DEVICE"
	)
		return {
			...error,
			code: "CASE_LIST_CLOSED_ON_NOT_ON_DEVICE",
			details: { ...details, slotCode: error.code },
		};
	if (
		details.checkCode === "datum-not-supplied" &&
		RECORD_CARRIERS.has(details.carrier ?? "") &&
		details.datumModule !== undefined &&
		error.code !== "SESSION_DATUM_NOT_SUPPLIED"
	) {
		const menuName =
			doc.modules[details.datumModule as Uuid]?.name ?? "that menu";
		const otherModuleName =
			details.otherModule === undefined
				? undefined
				: (doc.modules[details.otherModule as Uuid]?.name ?? "another module");
		const reason = details.checkReason ?? "not-before";
		return {
			...error,
			code: "SESSION_DATUM_NOT_SUPPLIED",
			message: chosenCaseReadSentence({
				carrier: details.carrier,
				reason,
				moduleName: error.location.moduleName ?? "this module",
				...(error.location.formName === undefined
					? {}
					: { formName: error.location.formName }),
				menuName,
				...(otherModuleName === undefined ? {} : { otherModuleName }),
			}),
			details: {
				...details,
				slotCode: error.code,
				reason,
				datumModuleName: menuName,
				...(otherModuleName === undefined ? {} : { otherModuleName }),
			},
		};
	}
	if (details.checkReason === "platform-unavailable") {
		const feature = PLATFORM_FEATURE_IDS.find((id) => id === details.feature);
		const platform = PLATFORMS.find((id) => id === details.platform);
		if (feature === undefined || platform === undefined) return error;
		return {
			...error,
			message: platformRefusalMessage({
				feature,
				platform,
				platforms: declaredPlatforms(doc),
				subject: recordSlotSubject(doc, error),
			}),
			details: { ...details, slotCode: error.code },
		};
	}
	return error;
}

/** The record slot a platform refusal names, as the agent reads it: the
 * calculated column by its header, each other slot a window width read
 * reaches (every module slot and a form's display condition) by its setting,
 * and any other slot as the checker names it. */
function recordSlotSubject(doc: BlueprintDoc, error: ValidationError): string {
	const module = `module "${error.location.moduleName ?? ""}"`;
	const input =
		error.details?.inputName === undefined
			? `a Search field in ${module}`
			: `Search field "${error.details.inputName}" in ${module}`;
	switch (error.code) {
		case "MODULE_DISPLAY_CONDITION_TYPE_ERROR":
			return `The display condition of ${module}`;
		case "FORM_DISPLAY_CONDITION_TYPE_ERROR":
			return `The display condition of form "${error.location.formName ?? ""}"`;
		case "CASE_LIST_FILTER_TYPE_ERROR":
			return `The case list filter of ${module}`;
		case "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR":
			return `The Search button's display condition in ${module}`;
		case "CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR":
			return `The owners a search leaves out in ${module}`;
		case "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR":
			return `The starting value of ${input}`;
		case "CASE_LIST_SEARCH_INPUT_HIDDEN_VALUE_TYPE_ERROR":
			return `The value of ${input}`;
		case "CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR":
			return `The condition of ${input}`;
		case "CASE_LIST_SEARCH_INPUT_REQUIRED_CONDITION_TYPE_ERROR":
			return `The required condition of ${input}`;
		case "CASE_LIST_SEARCH_INPUT_VALIDATION_RULE_TYPE_ERROR":
			return `The check of ${input}`;
		case "CASE_LIST_SEARCH_INPUT_OPTIONS_FILTER_TYPE_ERROR":
			return `The choice filter of ${input}`;
		default:
			break;
	}
	if (error.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR") {
		const moduleUuid = error.location.moduleUuid;
		const column = (
			moduleUuid === undefined
				? undefined
				: doc.modules[moduleUuid]?.caseListConfig?.columns
		)?.find((entry) => entry.uuid === error.details?.columnUuid);
		const header =
			column !== undefined && "header" in column ? column.header : "";
		return `Calculated column "${header}" in module "${error.location.moduleName ?? ""}"`;
	}
	return "This expression";
}
