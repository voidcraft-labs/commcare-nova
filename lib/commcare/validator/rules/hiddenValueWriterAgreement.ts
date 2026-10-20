/**
 * Rule: a Hidden Value that saves to a case property is a typed writer, held
 * to the property's type as a case operation's write is.
 *
 * The property's type is its declared type, else the one type its visible
 * questions and case operations agree on, else the one type its Hidden Value
 * writers agree on (`int` and `decimal` agreeing on `decimal`, `text` and
 * `single_select` on `text`); the facts come
 * from `lib/domain/expression/inference.ts::hiddenWriterVerdicts`. Each
 * writer is one finding, whose `details.paths` lists every offending output
 * and whose reason is the most serious of three:
 *
 * - `type`: some value the Hidden Value can end with (a branch of `if`,
 *   `switch` or `coalesce`, or the whole expression) is not
 *   write-assignable to the property (`ruleSets.ts::isWriteAssignable`:
 *   storage assignability, plus a `format-date` fixed to `%Y-%m-%d` into a
 *   date, which `DateData.cast` reads back). A follow-up question that fills
 *   itself from a date, time, number or location property casts the saved
 *   text through its own answer class at form open, and text the class
 *   can't read stops the form (`CASTING_PROPERTY_TYPES`); a text or choice
 *   property takes any text, so its readers get the wrong kind of value.
 * - `clock-lost`: the value is a date and time whose clock an earlier Hidden
 *   Value dropped, saved to a date-and-time property, so the case would hold
 *   midnight instead of the moment.
 * - `hidden-disagreement`: only Hidden Values type the property and they name
 *   different types, so the property has none. `details.disagreement` says
 *   whether the writer's own results disagree (`own`) or it disagrees with
 *   the other Hidden Value writers (`others`).
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
import { formOfField } from "@/lib/domain/fieldForm";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import type { Uuid } from "@/lib/domain/uuid";
import {
	valueKindPhrase,
	valueKindsPhrase,
} from "@/lib/domain/valueKindPhrases";
import { type ValidationError, validationError } from "../errors";

/**
 * The property types whose question casts the saved text through its own
 * answer class when a form fills it from the case, and stops the form on
 * text the class can't read (`SetValueAction.java::processAction` →
 * `AnswerDataFactory.templateByDataType(...).cast`: `DateData`,
 * `DateTimeData`, `TimeData`, `IntegerData`, `DecimalData` and
 * `GeoPointData` throw `IllegalArgumentException`). Text and both choice
 * classes take any text (`StringData.cast`, `SelectOneData.cast`,
 * `SelectMultiData.cast`).
 */
export const CASTING_PROPERTY_TYPES: ReadonlySet<CasePropertyDataType> =
	new Set(["date", "datetime", "time", "int", "decimal", "geopoint"]);

const REASON_ORDER: readonly HiddenWriterFinding["reason"][] = [
	"type",
	"hidden-disagreement",
	"clock-lost",
];

/** One finding per writer: its most serious reason, every offending output
 * of that reason, and every offending output's path. */
export function hiddenValueWriterAgreement(
	doc: BlueprintDoc,
): ValidationError[] {
	return hiddenWriterVerdicts(doc).map((verdict) => writerError(doc, verdict));
}

function writerError(
	doc: BlueprintDoc,
	verdict: HiddenWriterVerdict,
): ValidationError {
	const { writer, property } = verdict;
	const reason =
		REASON_ORDER.find((candidate) =>
			verdict.findings.some((finding) => finding.reason === candidate),
		) ?? "type";
	const primary = verdict.findings.filter(
		(finding) => finding.reason === reason,
	);
	const clockAlso =
		reason !== "clock-lost" &&
		verdict.findings.some((finding) => finding.reason === "clock-lost");
	const field = doc.fields[writer.field];
	const fieldId = field?.id ?? "this hidden value";
	const formUuid = writer.form;
	const formName =
		formUuid === undefined ? undefined : doc.forms[formUuid]?.name;
	const moduleUuid =
		formUuid === undefined ? undefined : moduleUuidOfForm(doc, formUuid);
	const subject = `Hidden value "${fieldId}" in "${formName ?? "its form"}"`;
	const target = `"${writer.property}" on "${writer.caseType}"`;
	const holds = valueKindPhrase(property.type);
	const origin = originDetails(doc, property);
	const clockSource =
		reason === "clock-lost" || clockAlso
			? clockLostOrigin(doc, writer)
			: undefined;
	const clockName =
		clockSource === undefined ? "an earlier hidden value" : `"${clockSource}"`;
	const valueTypes = [
		...new Set(
			primary.flatMap((finding) =>
				finding.type === undefined ? [] : [finding.type],
			),
		),
	];
	const disagreement = writer.outputsDisagree ? "own" : "others";
	const gives = valueKindsPhrase(valueTypes);
	const stopsForm =
		property.type !== undefined && CASTING_PROPERTY_TYPES.has(property.type);
	const consequence = stopsForm
		? `A form that fills a question from "${writer.property}" would stop when it opens on a value that isn't ${holds}.`
		: `Forms and case lists that read "${writer.property}" would get ${gives} where they expect ${holds}.`;
	const change =
		writer.source === "default_value" ? "starting value" : "calculation";
	const message =
		reason === "clock-lost"
			? `${subject} saves a date and time to ${target}, which holds a date and time, but the value keeps only the day because ${clockName} doesn't keep the time. The case would hold midnight instead of the moment. You can save it from a question or from now() instead.`
			: reason === "hidden-disagreement"
				? disagreement === "own"
					? `${subject} saves ${gives} to ${target} from different results, so the property has no one type. A form that fills a question from "${writer.property}" can't know what it holds. You can make every result of the ${change} give the same kind of value, or save it to another property.`
					: `${subject} saves ${valueKindPhrase(writer.opinion ?? valueTypes[0])} to ${target}, and other hidden values save ${otherHiddenPhrase(doc, writer)} there, so the property has no one type. A form that fills a question from "${writer.property}" can't know what it holds. You can make every hidden value that saves there give the same kind of value, or save this one to another property.`
				: `${subject} saves ${gives} to ${target}, which holds ${holds} (${origin.phrase}). ${consequence} You can change the ${change} so it gives ${holds}, or save it to another property.${clockAlso ? ` Another of its results also keeps only the day because ${clockName} doesn't keep the time.` : ""}`;
	const paths = verdict.findings
		.filter((finding) => finding.reason === reason)
		.map((finding) => finding.path);
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
			reason,
			path: JSON.stringify(primary[0]?.path ?? []),
			paths: JSON.stringify(paths),
			...(reason === "hidden-disagreement" ? { disagreement } : {}),
			...(reason === "type"
				? { consequence: stopsForm ? "stops-form" : "wrong-kind" }
				: {}),
			...(reason === "hidden-disagreement" && writer.opinion !== undefined
				? { valueType: writer.opinion }
				: valueTypes[0] === undefined
					? {}
					: { valueType: valueTypes[0] }),
			...(valueTypes.length > 1 ? { valueTypes: valueTypes.join(",") } : {}),
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
			const form = formOfField(doc, origin.field);
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

/** What the other Hidden Value writers of the property give instead. */
function otherHiddenPhrase(doc: BlueprintDoc, writer: HiddenOpinion): string {
	const others = new Set<CasePropertyDataType>();
	for (const other of inferExpressionTypes(doc).hiddenOpinions.values())
		if (
			other.field !== writer.field &&
			other.caseType === writer.caseType &&
			other.property === writer.property &&
			other.opinion !== undefined &&
			other.opinion !== writer.opinion
		)
			others.add(other.opinion);
	return others.size === 0 ? "something different" : valueKindsPhrase(others);
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
