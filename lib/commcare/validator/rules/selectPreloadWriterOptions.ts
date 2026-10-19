import { descendantFieldUuids } from "@/lib/doc/fieldWalk";
/**
 * Rule: a fixed value saved into a property that a choice question starts
 * on is one of that question's choices.
 *
 * A single or multiple select with written choices that saves to its form's
 * one loaded case opens showing the case's current value
 * (`lib/domain/casePreload.ts::writerPreloadsFromLoadedCase`). Core casts that
 * text to a selection without checking it (`SelectOneData.cast`,
 * `SelectMultiData.cast` through `DataUtil.splitOnSpaces`), and Web Apps then
 * refuses a selection that names no choice: `Selection.attachChoice` throws
 * `XPathTypeMismatchException` from `PromptToJson.parseQuestionAnswer`. So
 * every Nova writer that saves a literal there must save one of the reader's
 * option values (single), or space-separated tokens that are all option
 * values (multiple), by the rule a select's own starting value follows:
 * a number reads as Core's answer text (`numericAnswerText`) and `''` saves no
 * value.
 *
 * Writers judged: a Hidden Value whose `calculate` is a whole-slot string or
 * number literal; one with no `calculate` whose `default_value` is one, unless
 * it fills itself from the same property (the preload's setvalue runs after
 * the default's and overwrites it, so the literal is never saved); and a case
 * operation's write whose value is one, conditional writes included. A
 * computed value, a reader whose choices come from a Project data table or
 * from cases, and a select that never fills itself from the case are outside
 * the rule. Whether the value's type fits the property is writer agreement's
 * question (`hiddenValueWriterAgreement.ts`, `caseOperations.ts`), not this
 * one's.
 *
 * App-scoped because writer and reader sit in different forms.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { writerPreloadsFromLoadedCase } from "@/lib/domain/casePreload";
import { fieldCaseWrite } from "@/lib/domain/caseTypes";
import { selectAnswerTokens } from "@/lib/domain/expression/choiceValue";
import { numericAnswerText } from "@/lib/domain/expression/numberLiteral";
import type { Expression } from "@/lib/domain/expression/types";
import type { Field, SelectOption } from "@/lib/domain/fields";
import { type CaseOperation, orderedCaseOperations } from "@/lib/domain/forms";
import type { Uuid } from "@/lib/domain/uuid";
import { type ValidationError, validationError } from "../errors";
import { caseOperationError } from "./caseOperations";

interface Place {
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	readonly formUuid: Uuid;
	readonly formName: string;
}

interface Reader extends Place {
	readonly field: Field;
	readonly multiple: boolean;
	readonly options: readonly SelectOption[];
}

type Writer = Place &
	(
		| {
				readonly kind: "hidden";
				readonly field: Field;
				readonly slot: "calculate" | "default_value";
		  }
		| { readonly kind: "operation"; readonly operation: CaseOperation }
	) & {
		readonly caseType: string;
		readonly property: string;
		readonly text: string;
	};

export function selectPreloadWriterOptions(
	doc: BlueprintDoc,
): ValidationError[] {
	const readers = new Map<string, Reader[]>();
	const writers: Writer[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (module === undefined) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const place: Place = {
				moduleUuid,
				moduleName: module.name,
				formUuid,
				formName: form.name,
			};
			for (const field of formFields(doc, formUuid)) {
				const write = fieldCaseWrite(field);
				if (write === undefined) continue;
				const preloads = writerPreloadsFromLoadedCase(field, module, form);
				if (
					(field.kind === "single_select" || field.kind === "multi_select") &&
					field.optionsSource.kind === "inline" &&
					preloads
				) {
					const key = tupleKey(write.caseType, write.property);
					const bucket = readers.get(key) ?? [];
					bucket.push({
						...place,
						field,
						multiple: field.kind === "multi_select",
						options: field.optionsSource.options,
					});
					readers.set(key, bucket);
				}
				if (field.kind !== "hidden") continue;
				const slot =
					field.calculate !== undefined
						? "calculate"
						: field.default_value !== undefined && !preloads
							? "default_value"
							: undefined;
				const text = slot === undefined ? undefined : literalText(field[slot]);
				if (slot !== undefined && text !== undefined)
					writers.push({
						...place,
						kind: "hidden",
						field,
						slot,
						caseType: write.caseType,
						property: write.property,
						text,
					});
			}
			for (const operation of orderedCaseOperations(form))
				for (const write of operation.writes ?? []) {
					const text = literalText(write.value);
					if (text !== undefined)
						writers.push({
							...place,
							kind: "operation",
							operation,
							caseType: operation.retype ?? operation.caseType,
							property: write.property,
							text,
						});
				}
		}
	}

	const errors: ValidationError[] = [];
	for (const writer of writers) {
		if (writer.text === "") continue;
		for (const reader of readers.get(
			tupleKey(writer.caseType, writer.property),
		) ?? []) {
			const values = reader.multiple
				? selectAnswerTokens(writer.text)
				: [writer.text];
			if (
				values.every((value) =>
					reader.options.some((option) => option.value === value),
				)
			)
				continue;
			errors.push(writerError(writer, reader));
		}
	}
	return errors;
}

/** A whole-slot string or number literal's saved text, typed or not. */
function literalText(expression: Expression | undefined): string | undefined {
	if (expression?.kind !== "term" || expression.term.kind !== "literal")
		return undefined;
	const value = expression.term.value;
	return typeof value === "number"
		? numericAnswerText(value)
		: typeof value === "string"
			? value
			: undefined;
}

function writerError(writer: Writer, reader: Reader): ValidationError {
	const options = reader.options.map((option) => option.value);
	const subject =
		writer.kind === "hidden"
			? `Hidden value "${writer.field.id}" in "${writer.formName}"`
			: `Case operation "${writer.operation.id}" in "${writer.formName}"`;
	const message = `${subject} saves "${writer.text}" to "${writer.property}" on "${writer.caseType}", which "${reader.field.id}" in "${reader.formName}" starts on, and "${writer.text}" isn't one of its choices (${options.join(", ")}). CommCare's Web Apps can't open a form whose choice question starts on a value it doesn't offer. You can save one of its choices, like '${options[0] ?? ""}', or save to another property.`;
	const details = {
		value: writer.text,
		caseType: writer.caseType,
		property: writer.property,
		readerField: reader.field.id,
		readerFieldUuid: reader.field.uuid,
		readerForm: reader.formName,
		readerFormUuid: reader.formUuid,
		options: options.join(", "),
	};
	if (writer.kind === "operation")
		return caseOperationError(
			"SELECT_PRELOAD_WRITE_NOT_AN_OPTION",
			message,
			writer,
			writer.operation,
			details,
		);
	return validationError(
		"SELECT_PRELOAD_WRITE_NOT_AN_OPTION",
		"field",
		message,
		{
			moduleUuid: writer.moduleUuid,
			moduleName: writer.moduleName,
			formUuid: writer.formUuid,
			formName: writer.formName,
			fieldUuid: writer.field.uuid,
			fieldId: writer.field.id,
			field: writer.slot,
		},
		details,
	);
}

/** Every field of a form, in tree order. */
function formFields(doc: BlueprintDoc, formUuid: Uuid): Field[] {
	return [...descendantFieldUuids(doc, formUuid)].map(
		(uuid) => doc.fields[uuid],
	);
}

/** JSON-encoded so no two `(caseType, property)` pairs share a key. */
function tupleKey(caseType: string, property: string): string {
	return JSON.stringify([caseType, property]);
}
