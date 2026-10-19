import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	type ExpressionContext,
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { numericAnswerText } from "@/lib/domain/expression/numberLiteral";
import { ANY_TYPE } from "@/lib/domain/expression/ruleSets";
import { expressionSlotLabel } from "@/lib/domain/expression/slotLabels";
import {
	type CheckError,
	checkExpression,
	dayOnlyRefusalCopy,
	expressionContextAtPath,
	formComparisonOperandTypes,
	type ScalarType,
	scalarDataType,
	typeOf,
	UNREADABLE_DATETIME_NEXT,
} from "@/lib/domain/expression/typeChecker";
import type {
	Expression,
	SlotContextRef,
	Term,
} from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { formOfField } from "@/lib/domain/fieldForm";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { FIELD_REFERENCE_SLOTS } from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import { valueKindPhrase } from "@/lib/domain/valueKindPhrases";
import {
	type ValidationError,
	type ValidationErrorCode,
	validationError,
} from "./errors";
import { checkErrorDetails, semanticCheckErrors } from "./lookupTypeContext";
import { locationsReadNeedsOrganization } from "./rules/locationsRead";

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
		| "XPATH_INCOMPATIBLE_VALUES"
		| "XPATH_MANY_VALUES"
		| "PROSE_EDITOR_ROUND_TRIP_LOSS"
		| "SESSION_DATUM_NOT_SUPPLIED"
		| "FORM_LINK_DATUM_UNUSED"
		| "CASE_HASHTAG_ON_CREATE_FORM"
		| "SELECT_DEFAULT_NOT_AN_OPTION"
		| "XPATH_FUNCTION_CONTEXT_UNAVAILABLE"
		| "XPATH_CARRIER_CONTEXT_UNAVAILABLE"
		| "SEARCH_RESULTS_NOT_SUPPLIED"
		| "SEARCH_RESULTS_READ_INVALID"
		| "LOCATIONS_READ_NEEDS_ORGANIZATION"
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
function expressionAt(
	expression: Expression,
	path: CheckError["path"],
): Expression | undefined {
	let result: Expression | undefined;
	walkExpression(expression, {
		visitExpression: (node, at) => {
			if (result === undefined && JSON.stringify(at) === JSON.stringify(path))
				result = node;
		},
	});
	return result;
}
/** The first node of `kind` at or under `path`. */
function firstUnder<K extends Expression["kind"]>(
	expression: Expression,
	path: CheckError["path"],
	kind: K,
): Extract<Expression, { kind: K }> | undefined {
	let result: Extract<Expression, { kind: K }> | undefined;
	walkExpression(expression, {
		visitExpression: (node, at) => {
			if (
				result === undefined &&
				node.kind === kind &&
				path.every((part, index) => at[index] === part)
			)
				result = node as Extract<Expression, { kind: K }>;
		},
	});
	return result;
}

/** The owner of a slot, as a sentence names it from the slot's context. */
function slotOwner(ctx: ExpressionContext | undefined): {
	/** `"visit"` or `This after-submit link condition`. */
	readonly subject: string;
	/** ` in its display condition` for a question, else nothing. */
	readonly inSlot: string;
	/** `"visit"'s display condition` or `This after-submit link condition`. */
	readonly slotSubject: string;
} {
	const label =
		ctx === undefined ? "formula" : expressionSlotLabel(ctx.slot.slot);
	const field =
		ctx?.slot.entity === "field"
			? ctx.form?.fields.get(ctx.slot.uuid)
			: undefined;
	if (field === undefined)
		return {
			subject: `This ${label}`,
			inSlot: "",
			slotSubject: `This ${label}`,
		};
	return {
		subject: `"${field.id}"`,
		inSlot: ` in its ${label}`,
		slotSubject: `"${field.id}"'s ${label}`,
	};
}

/** Which carrier a slot is: a question, a form link, or a CommCare Connect
 * setting. */
function carrierOf(ctx: ExpressionContext | undefined): string {
	return ctx?.slot.slot.startsWith("form_link_")
		? "form-link"
		: ctx?.slot.entity === "field"
			? "field"
			: "connect";
}

/** The two sides of the comparison at `path`, typed as the form checker
 * types them (`typeChecker.ts::formComparisonOperandTypes`). */
function comparisonSides(
	root: Expression | undefined,
	path: CheckError["path"],
	ctx: ExpressionContext | undefined,
):
	| {
			readonly left: ScalarType | undefined;
			readonly right: ScalarType | undefined;
	  }
	| undefined {
	if (root === undefined || ctx === undefined) return undefined;
	const node = expressionAt(root, path);
	if (
		node === undefined ||
		(node.kind !== "eq" &&
			node.kind !== "neq" &&
			node.kind !== "gt" &&
			node.kind !== "gte" &&
			node.kind !== "lt" &&
			node.kind !== "lte")
	)
		return undefined;
	const at = expressionContextAtPath(root, ctx, path);
	return formComparisonOperandTypes(
		node,
		scalarDataType(typeOf(node.left, at)?.data),
		scalarDataType(typeOf(node.right, at)?.data),
	);
}
/** The side of a comparison that isn't `kind`, where one side is. */
function operandOtherThan(
	sides: ReturnType<typeof comparisonSides>,
	kind: ScalarType,
): ScalarType | undefined {
	if (sides === undefined) return undefined;
	if (sides.left === kind) return sides.right;
	if (sides.right === kind) return sides.left;
	return undefined;
}
function selectedCasesMessage(slotSubject: string, menu: string): string {
	return `${slotSubject} reads the cases chosen in ${menu} in a place that needs one value. This form works on several cases at once, so CommCare stops the form when more than one is chosen. You can count them, or join them.`;
}

/** The field slots that hold text, which shows a reference as written. */
const PROSE_SLOTS: ReadonlySet<string> = new Set(
	FIELD_REFERENCE_SLOTS.filter((entry) => entry.kind === "prose").map(
		(entry) => entry.slot,
	),
);
/** The repeat a structurally several read crosses: the outermost repeat on
 * the read's leaf that the slot's own question is not inside. */
function repeatCrossed(
	error: CheckError,
	ctx: ExpressionContext | undefined,
): { readonly uuid: Uuid; readonly id: string } | undefined {
	if (error.several?.reason !== "repeat") return undefined;
	const uuid = error.several.repeat;
	const id = ctx?.form?.fields.get(uuid)?.id;
	return id === undefined ? undefined : { uuid, id };
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
		case "row-scope": {
			code = "INVALID_REF";
			const named =
				error.reason === "choice-name-field" && expression !== undefined
					? firstUnder(expression, error.path, "choice-name")
					: undefined;
			if (term?.kind === "choice")
				details = { identity: "choice", choiceFieldUuid: term.field };
			else if (named !== undefined)
				details = { identity: "choice", choiceFieldUuid: named.field };
			else if (error.reason === "itext-unit") details = { identity: "wording" };
			else if (
				error.reason === "location-level" ||
				error.reason === "location-property"
			)
				details = { identity: "place" };
			break;
		}
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
			const selected =
				expression === undefined
					? undefined
					: firstUnder(expression, error.path, "selected-cases");
			const datum =
				targetUnused &&
				ctx?.slot.entity === "form" &&
				ctx.slot.slot === "form_link_datum_xpath"
					? ctx.slot.member.datum
					: term?.kind === "session-datum"
						? term.datum
						: selected !== undefined
							? { kind: "selected-case" as const, module: selected.module }
							: undefined;
			code = targetUnused
				? "FORM_LINK_DATUM_UNUSED"
				: "SESSION_DATUM_NOT_SUPPLIED";
			details = {
				slot: ctx?.slot.slot ?? "",
				carrier: carrierOf(ctx),
				reason: error.reason ?? "not-supplied",
				...(datum !== undefined
					? {
							ref: JSON.stringify(datum),
							datumKind: selected !== undefined ? "selected-cases" : datum.kind,
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
		case "search-results-not-supplied": {
			code = "SEARCH_RESULTS_NOT_SUPPLIED";
			const owner = slotOwner(ctx);
			const reason = error.reason ?? "not-search-first";
			details = {
				slot: ctx?.slot.slot ?? "",
				carrier: carrierOf(ctx),
				reason,
			};
			message =
				reason === "no-matches-form"
					? `${owner.slotSubject} reads what the search found, but this form opens only when the search finds nothing, so there are no results to read. You can read the worker's search answers with #search/ instead.`
					: reason === "link-source"
						? `${owner.slotSubject} reads what a search found, but the form this link leaves doesn't open after a search, so there are no results to read. You can read a case property instead.`
						: `${owner.slotSubject} reads what this menu's search found, but the menu no longer opens on its search, so the form has no search results to read. You can turn Search first back on, or read the case the worker chose instead.`;
			break;
		}
		case "search-results-order":
		case "search-results-other-type": {
			code = "SEARCH_RESULTS_READ_INVALID";
			const owner = slotOwner(ctx);
			if (error.code === "search-results-order") {
				details = { reason: "order" };
				message = `${owner.slotSubject} reads what the search found by its order. ${error.message}`;
			} else {
				const searched =
					ctx?.supplies.searchResults === undefined
						? undefined
						: ctx.facts.moduleCaseTypes.get(ctx.supplies.searchResults.module);
				let other: string | undefined;
				if (expression !== undefined)
					walkExpression(expression, {
						visitTerm: (node, at) => {
							if (
								other === undefined &&
								node.kind === "case-type" &&
								node.caseType !== searched &&
								error.path.every((part, index) => at[index] === part)
							)
								other = node.caseType;
						},
					});
				details = {
					reason: "other-type",
					...(searched === undefined ? {} : { caseType: searched }),
					...(other === undefined ? {} : { otherCaseType: other }),
				};
				message = `${owner.slotSubject} looks for ${other ?? "another type of"} cases in what the search found. ${error.message} You can remove that case type from the query.`;
			}
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
		case "arm-unavailable": {
			const owner = slotOwner(ctx);
			if (error.reason === "here") {
				code = "XPATH_FUNCTION_CONTEXT_UNAVAILABLE";
				// A slot that reads the form's answers can read a location
				// question instead; one that reads no answers (a case list
				// filter, a search input, a display condition) can't.
				const formSlot = ctx?.profile.formAnswers === true;
				details = { reason: "here", hereSurface: formSlot ? "form" : "record" };
				message = formSlot
					? `${owner.slotSubject} uses here(), the worker's location, which CommCare knows only in a case list's calculated column. You can add a location question and read its answer instead.`
					: `${owner.slotSubject} uses here(), the worker's location, which only a case list's calculated column can read. You can show it in a calculated column instead.`;
			} else if (
				error.reason === "choice-name" ||
				error.reason === "choice-name-dynamic"
			) {
				code = "XPATH_FUNCTION_CONTEXT_UNAVAILABLE";
				const named =
					expression === undefined
						? undefined
						: firstUnder(expression, error.path, "choice-name");
				const question =
					named === undefined
						? undefined
						: ctx?.form?.fields.get(named.field)?.id;
				details = {
					reason: error.reason,
					...(question === undefined ? {} : { choiceFieldId: question }),
				};
				const of = question === undefined ? "a question" : `"${question}"`;
				message =
					error.reason === "choice-name-dynamic"
						? `${owner.slotSubject} reads the label of a choice of ${of}, whose choices come from a Project data table or from cases, so CommCare has no label to read there. You can read the label from where the choices come from instead.`
						: `${owner.slotSubject} reads the label of a choice of ${of}, which only a form's own logic can read. You can read the answer itself instead.`;
			} else if (error.reason === "itext-reference") {
				code = "XPATH_FUNCTION_CONTEXT_UNAVAILABLE";
				const read =
					expression === undefined
						? undefined
						: expressionAt(expression, error.path);
				const wordingField =
					read?.kind === "itext"
						? read.unit.field
						: read?.kind === "choice-name"
							? read.field
							: undefined;
				const wordingFieldId =
					wordingField === undefined
						? undefined
						: ctx?.form?.fields.get(wordingField)?.id;
				const choice =
					read?.kind === "choice-name" ||
					(read?.kind === "itext" && read.unit.role === "select-option-label");
				details = {
					reason: "itext-reference",
					wordingKind: choice ? "choice" : "question",
					...(wordingFieldId === undefined ? {} : { wordingFieldId }),
				};
				const named =
					wordingFieldId === undefined ? "a question" : `"${wordingFieldId}"`;
				message =
					read?.kind === "choice-name"
						? `${owner.slotSubject} reads the label of a choice of ${named}, and a label of its choices includes an answer. CommCare would show a placeholder there instead of the answer. You can read the answer itself instead.`
						: `${owner.slotSubject} reads the wording of ${named}, which includes an answer. CommCare would show a placeholder there instead of the answer. You can read the answer itself instead.`;
			}
			break;
		}
		case "incompatible-values": {
			code = "XPATH_INCOMPATIBLE_VALUES";
			const owner = slotOwner(ctx);
			if (error.reason !== undefined) details = { reason: error.reason };
			if (error.reason === "date-datetime")
				message = `${owner.subject} compares a date with a date and time${owner.inSlot}. CommCare compares a date by its day and a date and time by its moment, so the two don't line up. You can wrap the date and time in date() to compare days.`;
			else if (error.reason === "datetime-ordering") {
				const other = operandOtherThan(
					comparisonSides(expression, error.path, ctx),
					"datetime",
				);
				details = {
					reason: error.reason,
					...(other === undefined ? {} : { otherType: other }),
				};
				message = `${owner.subject} orders a date and time against ${valueKindPhrase(other, "a value that isn't one")}${owner.inSlot}. CommCare can only order two dates and times by their moment. You can compare it with another date and time, or wrap it in date() to compare days.`;
			} else if (error.reason === "day-only-on-device") {
				const property = error.instant?.property;
				const equality = error.instant?.comparison === "equality";
				details = {
					reason: error.reason,
					comparison: equality ? "equality" : "ordering",
					...(property === undefined ? {} : { systemDate: property }),
				};
				const copy = dayOnlyRefusalCopy(error.instant);
				message = `${owner.subject} ${copy.asks}${owner.inSlot}. ${copy.kept}${copy.consequence} ${copy.next}`;
			} else if (error.reason === "clock-lost") {
				const field = error.instant?.field;
				const source =
					field === undefined ? undefined : ctx?.form?.fields.get(field)?.id;
				details = {
					reason: error.reason,
					comparison:
						error.instant?.comparison === "equality" ? "equality" : "ordering",
					...(source === undefined ? {} : { clockSource: source }),
				};
				message = `${owner.subject} compares ${source === undefined ? "a value" : `"${source}"`}, which has kept only the day of a date and time, with a moment${owner.inSlot}, so CommCare can't line the two up. You can compare the date and time from the question or value that first recorded it, or wrap both sides in date() to compare days.`;
			} else if (error.reason === "unreadable-datetime")
				message = `${owner.subject} uses a value Nova can't read as a date and time${owner.inSlot}. ${UNREADABLE_DATETIME_NEXT}`;
			else if (error.reason === "datetime-equality")
				message = `${owner.subject} compares a date and time with a value that isn't one${owner.inSlot}, so the two never match. You can compare it with another date and time, or check whether it's blank.`;
			else if (error.reason === "boolean") {
				const other = operandOtherThan(
					comparisonSides(expression, error.path, ctx),
					"boolean",
				);
				const kind =
					other === undefined || other === ANY_TYPE
						? "another kind of value"
						: valueKindPhrase(other, "another kind of value");
				details = {
					reason: error.reason,
					...(other === undefined ? {} : { otherType: other }),
				};
				message = `${owner.subject} compares a true-or-false result with ${kind}${owner.inSlot}. CommCare turns ${kind} into true or false before comparing, and anything that isn't blank or zero counts as true. You can compare the two values themselves, or use the true-or-false result on its own.`;
			}
			break;
		}
		case "many-values": {
			code = "XPATH_MANY_VALUES";
			const owner = slotOwner(ctx);
			if (error.reason === "selected-cases") {
				details = {
					reason: "selected-cases",
					...(error.several?.reason === "selected-cases"
						? { module: error.several.module }
						: {}),
				};
				message = selectedCasesMessage(owner.slotSubject, "its menu");
			} else {
				const repeat = repeatCrossed(error, ctx);
				details = {
					reason: "repeat",
					...(repeat === undefined
						? {}
						: { repeatUuid: repeat.uuid, repeatId: repeat.id }),
				};
				const entries =
					repeat === undefined ? "a repeat" : `the repeat "${repeat.id}"`;
				// Text shows a reference as written, so it can't count or join.
				const prose =
					ctx !== undefined && PROSE_SLOTS.has(ctx.slot.slot as string);
				if (prose) details = { ...details, prose: "true" };
				message = prose
					? `${owner.slotSubject} shows an answer from every entry of ${entries}, where it can show only one. CommCare stops the form when there's more than one. You can move this question into the repeat, or show a hidden value that counts or joins the entries.`
					: `${owner.slotSubject} reads an answer from every entry of ${entries} in a place that needs one value. CommCare stops the form when there's more than one. You can count the entries, join them, or read one entry, like the first.`;
			}
			break;
		}
		case "datetime-literal-precision": {
			const owner = slotOwner(ctx);
			details = { reason: "datetime-literal-precision" };
			message = `${owner.slotSubject} holds a time finer than a millisecond. CommCare compares dates and times to the millisecond, so this time names none of them exactly. You can write the time to the millisecond, second or minute.`;
			break;
		}
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
	return [
		...semanticCheckErrors(checkExpression(expression, ctx)).map((error) =>
			formLogicFinding(error, ctx, expression),
		),
		...locationsReadNeedsOrganization(expression, ctx),
	];
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
				? formOfField(doc, slot.uuid)
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
	const slotLabel = expressionSlotLabel(slot.slot);
	const referenced =
		error.checkCode === "unknown-user-property"
			? "worker property"
			: error.reason === "datum-module"
				? "menu"
				: error.reason === "itext-unit"
					? "question's wording"
					: error.reason === "location-level"
						? "place level"
						: error.reason === "location-property"
							? "piece of place information"
							: "question";
	const choiceFieldName =
		error.details?.choiceFieldUuid === undefined
			? undefined
			: (doc.fields[error.details.choiceFieldUuid as Uuid]?.id ??
				"that question");
	const selectedModule =
		error.code === "XPATH_MANY_VALUES" &&
		error.details?.reason === "selected-cases" &&
		error.details.module !== undefined
			? doc.modules[error.details.module as Uuid]?.name
			: undefined;
	const message =
		selectedModule !== undefined
			? selectedCasesMessage(
					field === undefined
						? `This ${slotLabel}`
						: `"${field.id}"'s ${slotLabel}`,
					`"${selectedModule}"`,
				)
			: error.storedRef !== "dangling-identity"
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
		...(selectedModule === undefined ? {} : { menuName: selectedModule }),
		...(error.details?.datumModule === undefined
			? {}
			: {
					datumModuleName:
						doc.modules[error.details.datumModule as Uuid]?.name ?? "that menu",
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
