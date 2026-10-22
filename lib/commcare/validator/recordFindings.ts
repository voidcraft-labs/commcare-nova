/**
 * Two facts every record slot reports under one code whatever slot holds the
 * read, the way form logic reports them: a read of Date closed where a device
 * evaluates it (`CASE_LIST_CLOSED_ON_NOT_ON_DEVICE`, part 06 §3.1), and a read
 * of the case chosen in a menu the slot's entries don't supply before it runs
 * (`SESSION_DATUM_NOT_SUPPLIED`, part 05 §1.6). Each record rule wraps its
 * checker findings in its own slot code with `checkErrorDetails`; the runner
 * re-codes those two here, so a new record rule needs no code of its own.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { Uuid } from "@/lib/domain/uuid";
import type { ValidationError } from "./errors";

/** The person-facing sentence of a record slot's chosen-case read the
 * entries don't supply (part 05 §1.6's table; the validator's message and
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
	return error;
}
