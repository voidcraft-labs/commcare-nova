import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	type ExpressionContext,
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { numericAnswerText } from "@/lib/domain/expression/numberLiteral";
import {
	type CheckError,
	checkExpression,
} from "@/lib/domain/expression/typeChecker";
import type {
	Expression,
	SlotContextRef,
	Term,
} from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import {
	type ValidationError,
	type ValidationErrorCode,
	validationError,
} from "./errors";
import { checkErrorDetails, semanticCheckErrors } from "./lookupTypeContext";

export const SESSION_FORM_READ_MESSAGE =
	"This runs after the form has closed, so it can't read the form's answers. Save the answer to a case property and read that instead.";

/** A presentation projection. The checker remains the semantic authority. */
export interface FormLogicFinding {
	readonly code: Extract<
		ValidationErrorCode,
		| "INVALID_REF"
		| "INVALID_CASE_REF"
		| "INVALID_SEARCH_REF"
		| "TYPE_ERROR"
		| "XPATH_TIME_ORDERING"
		| "PROSE_EDITOR_ROUND_TRIP_LOSS"
		| "SESSION_DATUM_NOT_SUPPLIED"
		| "FORM_LINK_DATUM_UNUSED"
		| "CASE_HASHTAG_ON_CREATE_FORM"
		| "SELECT_DEFAULT_NOT_AN_OPTION"
		| "XPATH_FUNCTION_CONTEXT_UNAVAILABLE"
		| "XPATH_CARRIER_CONTEXT_UNAVAILABLE"
	>;
	readonly message: string;
	readonly slot?: SlotContextRef;
	readonly checkCode?: CheckError["code"];
	readonly reason?: string;
	readonly path?: CheckError["path"];
	readonly ref?: string;
	readonly storedRef?: "dangling-identity";
	readonly details?: Readonly<Record<string, string>>;
}
function termAt(
	expression: Expression,
	path: CheckError["path"],
): Term | undefined {
	let result: Term | undefined;
	walkExpression(expression, {
		visitTerm: (term, at) => {
			if (JSON.stringify(at) === JSON.stringify(path)) result = term;
		},
	});
	return result;
}
export function formLogicFinding(
	error: CheckError,
	ctx?: ExpressionContext,
	expression?: Expression,
): FormLogicFinding {
	const term =
		expression === undefined ? undefined : termAt(expression, error.path);
	let code: FormLogicFinding["code"] = "TYPE_ERROR";
	let message = error.message;
	let details: Record<string, string> | undefined;
	switch (error.code) {
		case "time-ordering":
			code = "XPATH_TIME_ORDERING";
			break;
		case "unknown-form-field":
		case "unknown-user-property":
		case "row-scope":
			code = "INVALID_REF";
			if (term?.kind === "choice")
				details = { identity: "choice", choiceFieldUuid: term.field };
			break;
		case "form-answer-unavailable":
			code = "INVALID_REF";
			if (ctx?.profile.scope === "session") message = SESSION_FORM_READ_MESSAGE;
			break;
		case "unknown-property":
		case "unknown-case-type":
		case "property-scope":
			code = "INVALID_CASE_REF";
			if (
				ctx?.form?.type === "registration" &&
				term?.kind === "form-case" &&
				ctx.facts.moduleCaseTypes.get(ctx.form.moduleUuid) === term.caseType &&
				term.property !== "case_id"
			) {
				code = "CASE_HASHTAG_ON_CREATE_FORM";
				details = {
					hashtag: `#${term.caseType}/${term.property}`,
					surface: ctx.slot.slot,
				};
				message = `The new ${term.caseType} record has no saved ${term.property} yet. Read the answer from its question instead.`;
			}
			break;
		case "unknown-search-input":
		case "search-answer-unavailable":
			code = "INVALID_SEARCH_REF";
			break;
		case "datum-not-supplied": {
			const targetUnused = error.reason === "target-not-requested";
			const datum =
				targetUnused &&
				ctx?.slot.entity === "form" &&
				ctx.slot.slot === "form_link_datum_xpath"
					? ctx.slot.member.datum
					: term?.kind === "session-datum"
						? term.datum
						: undefined;
			code = targetUnused
				? "FORM_LINK_DATUM_UNUSED"
				: "SESSION_DATUM_NOT_SUPPLIED";
			details = {
				slot: ctx?.slot.slot ?? "",
				carrier: ctx?.slot.slot.startsWith("form_link_")
					? "form-link"
					: ctx?.slot.entity === "field"
						? "field"
						: "connect",
				reason: error.reason ?? "not-supplied",
				...(datum !== undefined
					? {
							ref: JSON.stringify(datum),
							datumKind: datum.kind,
							...("module" in datum ? { datumModule: datum.module } : {}),
							...("caseType" in datum ? { datumCaseType: datum.caseType } : {}),
						}
					: (term?.kind === "session-user" ||
								term?.kind === "session-user-property") &&
							term.source === "worker-record"
						? {
								ref: JSON.stringify({ kind: "worker-record" }),
								datumKind: "worker-record",
							}
						: {}),
			};
			break;
		}
		case "default-not-a-choice":
			code = "SELECT_DEFAULT_NOT_AN_OPTION";
			if (ctx?.slot.entity === "field" && term?.kind === "literal") {
				const field = ctx.form?.fields.get(ctx.slot.uuid);
				const choices =
					field?.choices?.kind === "inline"
						? field.choices.options
						: ctx.facts.options.get(ctx.slot.uuid);
				if (choices !== undefined) {
					const value =
						typeof term.value === "number"
							? numericAnswerText(term.value)
							: String(term.value);
					const options = choices.map((option) => option.value).join(", ");
					details = { value, options };
					message = `"${field?.id ?? "This question"}" starts on "${value}", which isn't one of its choices (${options}). CommCare's Web Apps can't open a form whose choice question starts on a value it doesn't offer. You can start it on one of its choices, like '${choices[0]?.value ?? ""}', or leave the starting value empty.`;
				}
			}
			break;
		case "arm-unavailable":
			if (error.reason === "here" || error.reason === "choice-name")
				code = "XPATH_FUNCTION_CONTEXT_UNAVAILABLE";
			break;
	}
	return {
		code,
		message,
		...(ctx === undefined ? {} : { slot: ctx.slot }),
		checkCode: error.code,
		path: error.path,
		...(error.reason === undefined ? {} : { reason: error.reason }),
		...(details === undefined ? {} : { details }),
		...(error.code === "unknown-form-field" ||
		error.code === "unknown-user-property"
			? { storedRef: "dangling-identity" as const }
			: {}),
	};
}
export function formLogicFindings(
	expression: Expression,
	ctx: ExpressionContext,
): readonly FormLogicFinding[] {
	return semanticCheckErrors(checkExpression(expression, ctx)).map((error) =>
		formLogicFinding(error, ctx, expression),
	);
}
export function presentFormLogicFinding(
	doc: BlueprintDoc,
	slot: SlotContextRef,
	error: FormLogicFinding,
): ValidationError {
	const formUuid =
		slot.entity === "form"
			? slot.uuid
			: slot.entity === "field"
				? findForm(doc, slot.uuid)
				: undefined;
	const moduleUuid =
		slot.entity === "module"
			? slot.uuid
			: formUuid === undefined
				? undefined
				: moduleUuidOfForm(doc, formUuid);
	const field = slot.entity === "field" ? doc.fields[slot.uuid] : undefined;
	const owner =
		field !== undefined
			? `Field "${field.id}"`
			: slot.entity === "form"
				? `Form "${doc.forms[slot.uuid]?.name ?? "this form"}"`
				: `Menu "${doc.modules[slot.uuid]?.name ?? "this menu"}"`;
	const slotLabel =
		slot.slot === "calculate"
			? "calculated value"
			: slot.slot === "default_value"
				? "default value"
				: slot.slot === "relevant"
					? "display condition"
					: slot.slot === "required"
						? "required condition"
						: slot.slot === "validate"
							? "validation rule"
							: slot.slot === "repeat_count"
								? "repeat count"
								: slot.slot === "ids_query"
									? "case query"
									: "formula";
	const referenced =
		error.checkCode === "unknown-user-property"
			? "worker property"
			: error.reason === "datum-module"
				? "menu"
				: "question";
	const choiceFieldName =
		error.details?.choiceFieldUuid === undefined
			? undefined
			: (doc.fields[
					error.details.choiceFieldUuid as import("@/lib/domain/uuid").Uuid
				]?.id ?? "that question");
	const message =
		error.storedRef !== "dangling-identity"
			? error.message
			: error.details?.identity === "choice"
				? `${owner} uses a choice that "${choiceFieldName ?? "that question"}" no longer has in its ${slotLabel}. Choose one of its current choices.`
				: error.reason === "form-filter-step"
					? `${owner} uses a filter position that no longer belongs to the referenced question. Choose a current position in its ${slotLabel}.`
					: `${owner} reads a ${referenced} that no longer exists in its ${slotLabel}. Choose a current ${referenced}, or remove this reference.`;
	const details = {
		...(error.checkCode === undefined
			? {}
			: checkErrorDetails({
					code: error.checkCode,
					message: error.message,
					path: error.path ?? [],
					...(error.reason === undefined ? {} : { reason: error.reason }),
				})),
		...(error.storedRef === undefined ? {} : { storedRef: error.storedRef }),
		...error.details,
		...(choiceFieldName === undefined ? {} : { choiceFieldName }),
		...(error.details?.datumModule === undefined
			? {}
			: {
					datumModuleName:
						doc.modules[
							error.details.datumModule as import("@/lib/domain/uuid").Uuid
						]?.name ?? "that menu",
				}),
		...("member" in slot && "linkUuid" in slot.member
			? { linkUuid: slot.member.linkUuid }
			: {}),
	};
	return validationError(
		error.code,
		slot.entity,
		message,
		{
			...(moduleUuid === undefined
				? {}
				: { moduleUuid, moduleName: doc.modules[moduleUuid]?.name }),
			...(formUuid === undefined
				? {}
				: { formUuid, formName: doc.forms[formUuid]?.name }),
			...(field === undefined
				? {}
				: { fieldUuid: field.uuid, fieldId: field.id }),
			field: slot.slot,
		},
		details,
	);
}
function findForm(
	doc: BlueprintDoc,
	uuid: import("@/lib/domain/uuid").Uuid,
): import("@/lib/domain/uuid").Uuid | undefined {
	const seen = new Set<import("@/lib/domain/uuid").Uuid>();
	let at = uuid;
	while (!seen.has(at)) {
		seen.add(at);
		const parent = doc.fieldParent[at];
		if (parent === undefined) return undefined;
		if (doc.forms[parent] !== undefined) return parent;
		at = parent;
	}
	return undefined;
}
/** The editor and the gate share this exact projection for a parsed draft. */
export function checkFormLogicSlot(
	doc: BlueprintDoc,
	slot: SlotContextRef,
	expression: Expression,
	lookupTables: LookupTypeIndex = new Map(),
	preparedContext?: ExpressionContext,
): readonly ValidationError[] {
	const ctx = preparedContext ?? slotContext(doc, slot, lookupTables);
	if (ctx === undefined)
		return [
			presentFormLogicFinding(doc, slot, {
				code: "INVALID_REF",
				message: "This expression has no valid owning slot.",
			}),
		];
	return formLogicFindings(expression, ctx).map((error) =>
		presentFormLogicFinding(doc, slot, error),
	);
}
