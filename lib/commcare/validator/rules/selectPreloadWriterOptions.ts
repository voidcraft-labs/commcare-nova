/**
 * Rule: a fixed value saved into a property that a choice question starts
 * on is one of that question's choices.
 *
 * A single or multiple select with written choices, on a form that opens
 * one case, whose starting value is the case's current value of a property
 * it saves (`lib/domain/casePreload.ts::fieldPreload`) opens showing it. Core casts that
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
 * Writers judged: a Hidden Value whose answer a case operation saves, when
 * its `calculate` is a whole-slot string or number literal, or, with no
 * `calculate`, its `default_value` is one; and a case operation's write whose
 * value is one, conditional writes included. A computed value, a reader whose
 * choices come from a Project data table or from cases, and a select that
 * never starts on the case's value are outside the rule. Whether the value's type fits the property is writer agreement's
 * question (`hiddenValueWriterAgreement.ts`, `caseOperations.ts`), not this
 * one's.
 *
 * App-scoped because writer and reader sit in different forms.
 */

import { descendantFieldUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { fieldPreload, formOpensWithOneCase } from "@/lib/domain/casePreload";
import { formCaseWriteViews } from "@/lib/domain/caseWriteViews";
import { selectAnswerTokens } from "@/lib/domain/expression/choiceValue";
import { numericAnswerText } from "@/lib/domain/expression/numberLiteral";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import type { Expression } from "@/lib/domain/expression/types";
import type { Field, SelectOption } from "@/lib/domain/fields";
import {
	type CaseOperation,
	operationCaseType,
	orderedCaseOperations,
} from "@/lib/domain/forms";
import { caseSelectionCardinality } from "@/lib/domain/modules";
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
			const views = formCaseWriteViews(doc, formUuid);
			const opensWithOneCase = formOpensWithOneCase(
				form.type,
				caseSelectionCardinality(module),
			);
			for (const field of formFields(doc, formUuid)) {
				const fieldViews = (views.get(field.uuid) ?? []).filter(
					(view) => view.slot === "write" || view.slot === "name",
				);
				if (fieldViews.length === 0) continue;
				// A form that works on several cases reads no one case's value
				// into a question; the checker refuses the read there.
				const preload = opensWithOneCase ? fieldPreload(field) : undefined;
				if (
					(field.kind === "single_select" || field.kind === "multi_select") &&
					field.optionsSource.kind === "inline" &&
					preload !== undefined &&
					fieldViews.some(
						(view) =>
							view.caseType === preload.caseType &&
							view.property === preload.property,
					)
				) {
					const key = tupleKey(preload.caseType, preload.property);
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
						: field.default_value !== undefined
							? "default_value"
							: undefined;
				const text = slot === undefined ? undefined : literalText(field[slot]);
				if (slot === undefined || text === undefined) continue;
				for (const view of fieldViews)
					writers.push({
						...place,
						kind: "hidden",
						field,
						slot,
						caseType: view.caseType,
						property: view.property,
						text,
					});
			}
			for (const operation of orderedCaseOperations(form)) {
				const operationType =
					operation.retype ?? operationCaseType(doc, formUuid, operation);
				if (operationType === undefined) continue;
				for (const write of operation.writes ?? []) {
					const text = literalText(write.value);
					if (text === undefined) continue;
					// A write through `via` saves to the case above; one the catalog
					// does not resolve is refused on its own (`CASE_WRITE_VIA_INVALID`).
					const reached =
						write.via === undefined
							? { ok: true as const, caseType: operationType }
							: resolveRelationDestination(
									{ kind: "ancestor", via: write.via },
									operationType,
									doc.caseTypes ?? [],
								);
					if (!reached.ok) continue;
					writers.push({
						...place,
						kind: "operation",
						operation,
						caseType: reached.caseType,
						property: write.property,
						text,
					});
				}
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
	// A literal typed as another kind is the writer-type rules' question.
	const typed = expression.term.data_type;
	if (
		typed !== undefined &&
		typed !== "text" &&
		typed !== "single_select" &&
		typed !== "multi_select"
	)
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
