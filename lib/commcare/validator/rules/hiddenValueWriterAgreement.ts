/**
 * Rule: a Hidden Value that saves to a case property is a typed writer, held
 * to the property's type as a case operation's write is.
 *
 * The property's type is its declared type, else the one type its visible
 * questions and case operations agree on, else the one type its Hidden Value
 * writers agree on (`int` and `decimal` agreeing on `decimal`); the facts come
 * from `lib/domain/expression/inference.ts::hiddenWriterVerdicts`. A finding
 * is one of three:
 *
 * - `type`: some value the Hidden Value can end with (a branch of `if`,
 *   `switch` or `coalesce`, or the whole expression) is not
 *   storage-assignable to the property. A follow-up question that fills
 *   itself from the property casts the saved text through its own answer
 *   class at form open (`SetValueAction.java::processAction` →
 *   `AnswerDataFactory.templateByDataType(...).cast`), and text that is no
 *   date stops the form.
 * - `clock-lost`: the value is a date and time whose clock an earlier Hidden
 *   Value dropped, saved to a date-and-time property, so the case would hold
 *   midnight instead of the moment.
 * - `hidden-disagreement`: only Hidden Values type the property and they name
 *   different types, so the property has none.
 *
 * A blank `''` fits every property (`Recalculate.wrapData` stores no value),
 * an output nothing types holds no opinion, and a starting value a preload
 * overwrites never saves its own value, so none of them is reported.
 *
 * App-scoped because writer and reader sit in different forms: the rule runs
 * on every validation, scoped or not, and its code is scope-exempt.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import {
	type HiddenOpinion,
	type HiddenWriterFinding,
	type HiddenWriterVerdict,
	hiddenWriterVerdicts,
	inferExpressionTypes,
	type PropertyAgreement,
} from "@/lib/domain/expression/inference";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import type { Uuid } from "@/lib/domain/uuid";
import { type ValidationError, validationError } from "../errors";

/** A kind of value, as a sentence names one of it. */
export function dataTypePhrase(type: CasePropertyDataType | undefined): string {
	switch (type) {
		case "int":
		case "decimal":
			return "a number";
		case "text":
		case "single_select":
		case "multi_select":
			return "text";
		case "date":
			return "a date";
		case "datetime":
			return "a date and time";
		case "time":
			return "a time";
		case "geopoint":
			return "a place";
		default:
			return "a value";
	}
}

export function hiddenValueWriterAgreement(
	doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const verdict of hiddenWriterVerdicts(doc))
		for (const finding of verdict.findings)
			errors.push(writerError(doc, verdict, finding));
	return errors;
}

function writerError(
	doc: BlueprintDoc,
	verdict: HiddenWriterVerdict,
	finding: HiddenWriterFinding,
): ValidationError {
	const { writer, property } = verdict;
	const field = doc.fields[writer.field];
	const fieldId = field?.id ?? "this hidden value";
	const formUuid = writer.form;
	const formName =
		formUuid === undefined ? undefined : doc.forms[formUuid]?.name;
	const moduleUuid =
		formUuid === undefined ? undefined : moduleUuidOfForm(doc, formUuid);
	const subject = `Hidden value "${fieldId}" in "${formName ?? "its form"}"`;
	const target = `"${writer.property}" on "${writer.caseType}"`;
	const holds = dataTypePhrase(property.type);
	const origin = originDetails(doc, property);
	const clockSource =
		finding.reason === "clock-lost" ? clockLostOrigin(doc, writer) : undefined;
	const message =
		finding.reason === "clock-lost"
			? `${subject} saves a date and time to ${target}, which holds a date and time, but the value keeps only the day because ${clockSource === undefined ? "an earlier hidden value" : `"${clockSource}"`} doesn't keep the time. The case would hold midnight instead of the moment. You can save it from a question or from now() instead.`
			: finding.reason === "hidden-disagreement"
				? `${subject} saves ${dataTypePhrase(finding.type)} to ${target}, and ${writer.outputsDisagree ? "its other results give" : "other hidden values save"} ${otherHiddenPhrase(doc, writer, finding.type)} there, so the property has no one type. A form that fills a question from "${writer.property}" can't know what it holds. You can make every hidden value that saves there give the same kind of value, or save this one to another property.`
				: `${subject} saves ${dataTypePhrase(finding.type)} to ${target}, which holds ${holds} (${origin.phrase}). A form that fills a question from "${writer.property}" would stop on a value that isn't ${holds}. You can change the ${writer.source === "default_value" ? "starting value" : "calculation"} so it gives ${holds}, or save it to another property.`;
	return validationError(
		"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
		"field",
		message,
		{
			...(moduleUuid === undefined
				? {}
				: { moduleUuid, moduleName: doc.modules[moduleUuid]?.name }),
			...(formUuid === undefined ? {} : { formUuid, formName }),
			fieldUuid: writer.field,
			fieldId,
			field: writer.source ?? "calculate",
		},
		{
			caseType: writer.caseType,
			property: writer.property,
			reason: finding.reason,
			path: JSON.stringify(finding.path),
			...(finding.type === undefined ? {} : { valueType: finding.type }),
			...(property.type === undefined ? {} : { propertyType: property.type }),
			...origin.details,
			...(clockSource === undefined ? {} : { clockSource }),
		},
	);
}

/** Where a property's type comes from, as a sentence and as details. */
function originDetails(
	doc: BlueprintDoc,
	property: PropertyAgreement,
): { readonly phrase: string; readonly details: Record<string, string> } {
	const origin = property.origin;
	switch (origin?.kind) {
		case "declared":
			return {
				phrase: "as the case type declares it",
				details: { origin: "declared" },
			};
		case "standard":
			return {
				phrase: "as every case does",
				details: { origin: "standard" },
			};
		case "field": {
			const writer = doc.fields[origin.field];
			const form = formOf(doc, origin.field);
			const formName = form === undefined ? undefined : doc.forms[form]?.name;
			return {
				phrase: `saved by "${writer?.id ?? "a question"}" in "${formName ?? "another form"}"`,
				details: {
					origin: "field",
					originField: writer?.id ?? "",
					...(formName === undefined ? {} : { originForm: formName }),
				},
			};
		}
		case "operation": {
			const form = doc.forms[origin.form];
			const operation = form?.caseOperations?.find(
				(entry) => entry.uuid === origin.operation,
			);
			return {
				phrase: `saved by case operation "${operation?.id ?? "another operation"}" in "${form?.name ?? "another form"}"`,
				details: {
					origin: "operation",
					originOperation: operation?.id ?? "",
					...(form === undefined ? {} : { originForm: form.name }),
				},
			};
		}
		case "hidden":
			return {
				phrase: "saved by the other hidden values that write it",
				details: { origin: "hidden" },
			};
		default:
			return { phrase: "its type", details: {} };
	}
}

/** What the other Hidden Value writers of the property, or this writer's
 * other results, give instead. */
function otherHiddenPhrase(
	doc: BlueprintDoc,
	writer: HiddenOpinion,
	own: CasePropertyDataType | undefined,
): string {
	const others = new Set<string>();
	if (writer.outputsDisagree) {
		for (const output of writer.outputs)
			if (output.type !== undefined && output.type !== own)
				others.add(dataTypePhrase(output.type));
	} else {
		for (const other of inferExpressionTypes(doc).hiddenOpinions.values())
			if (
				other.field !== writer.field &&
				other.caseType === writer.caseType &&
				other.property === writer.property &&
				other.opinion !== undefined
			)
				others.add(dataTypePhrase(other.opinion));
		others.delete(dataTypePhrase(own));
	}
	const list = [...others];
	return list.length === 0
		? "something different"
		: list.length === 1
			? list[0]
			: `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
}

/** The Hidden Value whose date and time first lost its clock, reached from
 * the writer through the clock-lost Hidden Values its value reads. */
function clockLostOrigin(
	doc: BlueprintDoc,
	writer: HiddenOpinion,
): string | undefined {
	const lost = inferExpressionTypes(doc).clockLost;
	const seen = new Set<Uuid>([writer.field]);
	let at: Uuid = writer.field;
	let origin: Uuid | undefined;
	for (;;) {
		const next = lostRead(hiddenValueExpression(doc, at), lost, seen);
		if (next === undefined) break;
		seen.add(next);
		origin = next;
		at = next;
	}
	return origin === undefined ? undefined : doc.fields[origin]?.id;
}

function lostRead(
	expression: Expression | undefined,
	lost: ReadonlySet<Uuid>,
	seen: ReadonlySet<Uuid>,
): Uuid | undefined {
	if (expression === undefined) return undefined;
	let found: Uuid | undefined;
	walkExpressionTerms(expression, (term) => {
		if (
			found === undefined &&
			term.kind === "field" &&
			lost.has(term.uuid) &&
			!seen.has(term.uuid)
		)
			found = term.uuid;
	});
	return found;
}

function hiddenValueExpression(
	doc: BlueprintDoc,
	uuid: Uuid,
): Expression | undefined {
	const field = doc.fields[uuid];
	if (field?.kind !== "hidden") return undefined;
	return field.calculate ?? field.default_value;
}

function formOf(doc: BlueprintDoc, uuid: Uuid): Uuid | undefined {
	const seen = new Set<Uuid>();
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
