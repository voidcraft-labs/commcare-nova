/**
 * Value flow into inline choice questions. Follow returned branches, hidden
 * values, choice identities, and the app's case writes. Storage types cannot
 * establish membership: text may always be 'yes' or 'no', and two single
 * selects may offer different values. This runs app-wide, including when a
 * later writer/option edit is validated in another form's scope.
 *
 * An unbounded authored producer needs an explicit choice-valued mapping.
 * This is not an enum on persisted case data: external/historical values
 * still need runtime diagnosis. No value is filtered or rewritten in the emitted app.
 */
import { descendantFieldUuids } from "@/lib/doc/fieldWalk";
import { automationsOf } from "@/lib/domain/automations";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { normalizeCaseScalarTextValue } from "@/lib/domain/caseScalarText";
import { selectAnswerTokens } from "@/lib/domain/expression/choiceValue";
import {
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { numericAnswerText } from "@/lib/domain/expression/numberLiteral";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import {
	checkExpression,
	visitAssignmentOutputs,
} from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import type { Field, SelectOption } from "@/lib/domain/fields";
import {
	type CaseOperation,
	operationCaseType,
	orderedCaseOperations,
} from "@/lib/domain/forms";
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
		readonly valueCaseType?: string;
	};
interface Write {
	readonly source?: Writer;
	readonly expression: Expression;
}

export function selectPreloadWriterOptions(
	doc: BlueprintDoc,
	lookupTables: LookupTypeIndex,
): ValidationError[] {
	const writes = new Map<string, Write[]>();
	const readers: Reader[] = [];
	const retypes: {
		readonly from: string;
		readonly to: string;
		readonly overwritten: ReadonlySet<string>;
	}[] = [];
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
			for (const uuid of descendantFieldUuids(doc, formUuid)) {
				const field = doc.fields[uuid];
				if (
					(field?.kind === "single_select" || field?.kind === "multi_select") &&
					field.optionsSource.kind === "inline" &&
					field.default_value !== undefined
				)
					readers.push({
						...place,
						field,
						multiple: field.kind === "multi_select",
						options: field.optionsSource.options,
					});
			}
			for (const operation of orderedCaseOperations(form)) {
				const operationType =
					operation.retype ?? operationCaseType(doc, formUuid, operation);
				if (operationType === undefined) continue;
				const originalType = operationCaseType(doc, formUuid, operation);
				if (
					operation.retype !== undefined &&
					originalType !== undefined &&
					originalType !== operation.retype
				) {
					retypes.push({
						from: originalType,
						to: operation.retype,
						overwritten: new Set(
							(operation.writes ?? [])
								.filter(
									(write) =>
										write.via === undefined &&
										write.condition === undefined &&
										write.onlyIfChanged !== true,
								)
								.map((write) => write.property),
						),
					});
				}
				const values = [
					...(operation.writes ?? []),
					...("name" in operation && operation.name !== undefined
						? [{ property: "case_name", value: operation.name }]
						: []),
					...("rename" in operation && operation.rename !== undefined
						? [{ property: "case_name", value: operation.rename }]
						: []),
				];
				for (const write of values) {
					const reached =
						write.via === undefined
							? { ok: true as const, caseType: operationType }
							: resolveRelationDestination(
									{ kind: "ancestor", via: write.via },
									operationType,
									doc.caseTypes ?? [],
								);
					if (!reached.ok) continue;
					const term =
						write.value.kind === "term" ? write.value.term : undefined;
					const field =
						term?.kind === "field" &&
						term.role === undefined &&
						term.filters === undefined
							? doc.fields[term.uuid]
							: undefined;
					const slot =
						field?.kind === "hidden"
							? field.calculate !== undefined
								? "calculate"
								: field.default_value !== undefined
									? "default_value"
									: undefined
							: undefined;
					const source: Writer = {
						...place,
						caseType: reached.caseType,
						property: write.property,
						valueCaseType: module.caseType,
						...(field !== undefined && slot !== undefined
							? { kind: "hidden", field, slot }
							: { kind: "operation", operation }),
					};
					const key = tupleKey(reached.caseType, write.property);
					const bucket = writes.get(key) ?? [];
					bucket.push({ source, expression: write.value });
					writes.set(key, bucket);
				}
			}
		}
	}
	// HQ automations are authored writers too, even though Preview does not
	// execute them. A copy follows the source property's writers.
	for (const automation of Object.values(automationsOf(doc))) {
		if (automation.kind !== "case-update") continue;
		const type = doc.caseTypes?.find(
			(type) => type.name === automation.caseType,
		);
		const scoped = (scope: "case" | "parent" | "host"): string | undefined =>
			scope === "case"
				? automation.caseType
				: scope === "host" && type?.relationship !== "extension"
					? undefined
					: type?.parent_type;
		for (const update of automation.updates) {
			const target = scoped(update.target.scope);
			if (target === undefined) continue;
			const sourceType =
				update.value.kind === "case-property"
					? scoped(update.value.source.scope)
					: undefined;
			const expression: Expression | undefined =
				update.value.kind === "literal"
					? {
							kind: "term",
							term: { kind: "literal", value: update.value.value },
						}
					: sourceType === undefined
						? undefined
						: {
								kind: "term",
								term: {
									kind: "prop",
									caseType: sourceType,
									property: update.value.source.property,
								},
							};
			if (expression === undefined) continue;
			const key = tupleKey(target, update.target.property);
			const bucket = writes.get(key) ?? [];
			bucket.push({ expression });
			writes.set(key, bucket);
		}
	}
	const errors: ValidationError[] = [];
	for (const reader of readers) {
		if (
			!("default_value" in reader.field) ||
			reader.field.default_value === undefined
		)
			continue;
		const context = slotContext(
			doc,
			{ entity: "field", uuid: reader.field.uuid, slot: "default_value" },
			lookupTables,
		);
		// Missing entry data, invalid references and direct literal failures
		// already have a precise finding from the expression checker.
		if (
			context === undefined ||
			checkExpression(reader.field.default_value, context).errors.length > 0
		)
			continue;
		let unknown = false;
		const unbounded = (writer?: Writer): void => {
			if (unknown) return;
			unknown = true;
			const source =
				writer === undefined
					? "a value whose answers are not limited to its choices"
					: `"${writer.property}" on "${writer.caseType}", which a writer can fill with other answers`;
			errors.push(
				validationError(
					"SELECT_DEFAULT_VALUES_UNBOUNDED",
					"field",
					`Question "${reader.field.id}" in "${reader.formName}" starts on ${source}. Nova can't confirm that every result is an available answer, and CommCare can't display an inline choice answer it doesn't offer. You can use a condition that returns one of this question's choices in every branch, or remove the starting value and ask the worker to choose.`,
					{
						moduleUuid: reader.moduleUuid,
						moduleName: reader.moduleName,
						formUuid: reader.formUuid,
						formName: reader.formName,
						fieldUuid: reader.field.uuid,
						fieldId: reader.field.id,
						field: "default_value",
					},
					{
						...(writer === undefined
							? {}
							: {
									caseType: writer.caseType,
									property: writer.property,
									writerForm: writer.formName,
								}),
						options: reader.options.map((option) => option.value).join(", "),
					},
				),
			);
		};
		const seen = new Set<string>();
		const reported = new Set<string>();
		const emit = (text: string, writer?: Writer): void => {
			if (text === "") return;
			const values = reader.multiple ? selectAnswerTokens(text) : [text];
			if (
				values.every((value) =>
					reader.options.some((option) => option.value === value),
				)
			)
				return;
			const key = JSON.stringify([
				text,
				writer?.formUuid,
				writer?.kind === "hidden" ? writer.field.uuid : writer?.operation.uuid,
			]);
			if (reported.has(key)) return;
			reported.add(key);
			if (writer !== undefined) {
				errors.push(writerError({ ...writer, text }, reader));
				return;
			}
			errors.push(
				validationError(
					"SELECT_DEFAULT_NOT_AN_OPTION",
					"field",
					`Question "${reader.field.id}" in "${reader.formName}" can start on "${text}", which isn't one of its choices. You can map the source to one of its choices, or change the choices it offers.`,
					{
						moduleUuid: reader.moduleUuid,
						moduleName: reader.moduleName,
						formUuid: reader.formUuid,
						formName: reader.formName,
						fieldUuid: reader.field.uuid,
						fieldId: reader.field.id,
						field: "default_value",
					},
					{
						value: text,
						options: reader.options.map((option) => option.value).join(", "),
					},
				),
			);
		};
		const visit = (
			expression: Expression,
			writer?: Writer,
			indirect = false,
			trimOutput = false,
		): void => {
			const outputValue = (text: string): void =>
				emit(trimOutput ? normalizeCaseScalarTextValue(text) : text, writer);
			visitAssignmentOutputs(expression, [], (output) => {
				// Constant text composition is bounded too. Other calculations
				// need an explicit choice-valued result; storage type is no proof.
				if (
					output.kind === "concat" &&
					output.parts.every(
						(part) =>
							part.kind === "term" &&
							part.term.kind === "literal" &&
							typeof part.term.value === "string",
					)
				) {
					outputValue(
						output.parts
							.map((part) =>
								part.kind === "term" && part.term.kind === "literal"
									? part.term.value
									: "",
							)
							.join(""),
					);
					return;
				}
				const coerced =
					output.kind === "concat"
						? output.parts.filter(
								(part) =>
									!(
										part.kind === "term" &&
										part.term.kind === "literal" &&
										part.term.value === ""
									),
							)
						: output.kind === "call" && output.fn === "string"
							? output.args
							: undefined;
				if (
					coerced?.length === 1 &&
					coerced[0].kind === "term" &&
					["field", "form-case", "prop", "choice"].includes(
						coerced[0].term.kind,
					)
				) {
					// String coercion of an answer node keeps its held answer text.
					// Numeric expressions are deliberately not treated this way:
					// XPath string() and setvalue's numeric cast spell them differently.
					visit(coerced[0], writer, true, trimOutput);
					return;
				}
				if (output.kind !== "term") {
					unbounded(writer);
					return;
				}
				const term = output.term;
				if (term.kind === "literal") {
					// The slot checker already judges literals returned directly by
					// the default. This rule owns values reached through references.
					if (!indirect) return;
					if (typeof term.value === "string") outputValue(term.value);
					else if (typeof term.value === "number")
						outputValue(numericAnswerText(term.value));
					return;
				}
				if (term.kind === "choice") {
					const field = doc.fields[term.field];
					if (
						(field?.kind !== "single_select" &&
							field?.kind !== "multi_select") ||
						field.optionsSource.kind !== "inline"
					)
						return;
					const options = term.options.map((uuid) =>
						field.optionsSource.kind === "inline"
							? field.optionsSource.options.find(
									(option) => option.uuid === uuid,
								)
							: undefined,
					);
					if (options.every((option) => option !== undefined))
						outputValue(options.map((option) => option.value).join(" "));
					return;
				}
				if (term.kind === "field" && term.role === undefined) {
					const key = `field:${term.uuid}:${writer?.caseType ?? ""}:${writer?.property ?? ""}:${trimOutput}`;
					if (seen.has(key)) return;
					seen.add(key);
					const field = doc.fields[term.uuid];
					if (field?.kind === "hidden") {
						const value = field.calculate ?? field.default_value;
						if (value !== undefined) visit(value, writer, true, trimOutput);
					} else if (
						(field?.kind === "single_select" ||
							field?.kind === "multi_select") &&
						field.optionsSource.kind === "inline"
					) {
						for (const option of field.optionsSource.options)
							outputValue(option.value);
						// A multiple-choice source can also hold a combination. Two
						// choices suffice to witness a non-single answer, without
						// constructing the exponential set of all combinations.
						if (
							!reader.multiple &&
							field.kind === "multi_select" &&
							field.optionsSource.options.length > 1
						)
							outputValue(
								field.optionsSource.options
									.slice(0, 2)
									.map((option) => option.value)
									.join(" "),
							);
					} else if (field !== undefined) unbounded(writer);
					return;
				}
				if (term.kind === "form-case" || term.kind === "prop") {
					const caseType =
						term.caseType ??
						(term.kind === "prop" ? writer?.valueCaseType : undefined);
					if (caseType === undefined) {
						unbounded(writer);
						return;
					}
					const reached =
						term.kind === "prop" && term.via !== undefined
							? resolveRelationDestination(
									term.via,
									caseType,
									doc.caseTypes ?? [],
								)
							: { ok: true as const, caseType };
					if (!reached.ok) return;
					const key = tupleKey(reached.caseType, term.property);
					const visitKey = `${key}:${trimOutput}`;
					if (seen.has(visitKey)) return;
					seen.add(visitKey);
					const sources: Write[] = [
						...(writes.get(key) ?? []),
						...retypes
							.filter(
								(retype) =>
									retype.to === reached.caseType &&
									!retype.overwritten.has(term.property),
							)
							.map((retype) => ({
								expression: {
									kind: "term" as const,
									term: {
										kind: "prop" as const,
										caseType: retype.from,
										property: term.property,
									},
								},
							})),
					];
					if (sources.length === 0) {
						const property = doc.caseTypes
							?.find((type) => type.name === reached.caseType)
							?.properties.find((property) => property.name === term.property);
						if (
							property?.options !== undefined &&
							(property.data_type === "single_select" ||
								property.data_type === "multi_select")
						) {
							for (const option of property.options) outputValue(option.value);
							if (
								!reader.multiple &&
								property.data_type === "multi_select" &&
								property.options.length > 1
							)
								emit(
									property.options
										.slice(0, 2)
										.map((option) => option.value)
										.join(" "),
								);
						} else unbounded(writer);
					}
					for (const write of sources)
						visit(
							write.expression,
							write.source,
							true,
							trimOutput ||
								["case_name", "external_id", "owner_id"].includes(
									term.property,
								),
						);
					return;
				}
				unbounded(writer);
			});
		};
		if (
			"default_value" in reader.field &&
			reader.field.default_value !== undefined
		)
			visit(reader.field.default_value);
	}
	return errors;
}

function writerError(
	writer: Writer & { readonly text: string },
	reader: Reader,
): ValidationError {
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
function tupleKey(caseType: string, property: string): string {
	return JSON.stringify([caseType, property]);
}
