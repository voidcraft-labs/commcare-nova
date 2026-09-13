import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseAuthoredXPath } from "@/lib/doc/expressionText";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import { asUuid, type BlueprintDoc, type Uuid } from "@/lib/domain";
import {
	expressionSchema,
	normalizeExpression,
	normalizeText,
	textSchema,
} from "../text";

type Input = Record<string, unknown>;
interface NamedField {
	uuid: Uuid;
	id: string;
	parent: string;
}
const object = z.record(z.string(), z.unknown());

/** This name index describes a single authoring operation. It is never an
 * executable document or a second mutation engine. All values still pass
 * through the original shared tool and canonical admission. */
function formNames(
	doc: BlueprintDoc,
	formUuid: Uuid,
	additions: Input[],
	rename?: { uuid: string; id: string },
) {
	const fields: NamedField[] = Object.values(doc.fields)
		.filter((field) => findContainingForm(doc, field.uuid) === formUuid)
		.map((field) => ({
			uuid: field.uuid,
			id: field.id,
			parent: doc.fieldParent[field.uuid] ?? formUuid,
		}));
	for (const field of additions) {
		const uuid = asUuid(randomUUID());
		field.fieldUuid = uuid;
		fields.push({ uuid, id: z.string().parse(field.id), parent: formUuid });
	}
	for (const field of additions) {
		const current = fields.find((entry) => entry.uuid === field.fieldUuid);
		if (!current) throw new Error("Missing declared field.");
		if (typeof field.parent === "string") {
			const matches = fields.filter(
				(entry) => entry.uuid === field.parent || entry.id === field.parent,
			);
			if (matches.length !== 1)
				throw new Error(
					`Parent ${field.parent} must identify one group in this form.`,
				);
			const parent = matches[0];
			if (!parent) throw new Error("Missing parent.");
			current.parent = parent.uuid;
			field.parentUuid = parent.uuid;
		}
		delete field.parent;
	}
	function path(field: NamedField, seen: Set<string>): string {
		if (seen.has(field.uuid))
			throw new Error(`Field ${field.id} has cyclic parents.`);
		seen.add(field.uuid);
		if (field.parent === formUuid) return field.id;
		const parent = fields.find((entry) => entry.uuid === field.parent);
		if (!parent)
			throw new Error(`Field ${field.id} has no parent in this form.`);
		return `${path(parent, seen)}/${field.id}`;
	}
	const paths = fields.map((field) => ({
		field,
		path: path(field, new Set()),
	}));
	if (rename) {
		const field = fields.find((field) => field.uuid === rename.uuid);
		if (field) field.id = rename.id;
		paths.push(
			...fields.map((field) => ({ field, path: path(field, new Set()) })),
		);
	}
	return (segments: readonly string[]) => {
		const name = segments.join("/");
		const matches = [
			...new Set(
				paths
					.filter((entry) => entry.path === name)
					.map((entry) => entry.field.uuid),
			),
		];
		return matches.length === 1 ? matches[0] : undefined;
	};
}

export function normalizePilotInput(
	toolName: string,
	raw: unknown,
	doc: BlueprintDoc,
): Input {
	const input = structuredClone(object.parse(raw));
	function content(
		value: Input,
		parse: Parameters<typeof normalizeText>[1],
		record = false,
	): Input {
		const result = { ...value };
		for (const key of record ? ["label", "hint"] : ["label", "hint", "help"]) {
			if (value[key] != null)
				result[key] = normalizeText(textSchema.parse(value[key]), parse);
		}
		for (const key of record
			? ["required", "validation"]
			: ["required", "relevant", "calculate", "default_value"]) {
			if (value[key] != null)
				result[key] = normalizeExpression(
					expressionSchema.parse(value[key]),
					parse,
				);
		}
		if (!record && value.validate != null) {
			const validate = object.parse(value.validate);
			result.validate = {
				...validate,
				expr: normalizeExpression(expressionSchema.parse(validate.expr), parse),
				...(validate.msg !== undefined
					? { msg: normalizeText(textSchema.parse(validate.msg), parse) }
					: {}),
			};
		}
		const source =
			value.optionsSource == null
				? undefined
				: object.parse(value.optionsSource);
		const options = record ? value.options : source?.options;
		if (options != null) {
			const normalized = z
				.array(object)
				.parse(options)
				.map((option) => ({
					...option,
					label: normalizeText(textSchema.parse(option.label), parse),
				}));
			if (record) result.options = normalized;
			else result.optionsSource = { ...source, options: normalized };
		}
		return result;
	}
	function normalizeForm(
		form: Input,
		formUuid: Uuid,
		caseType?: string,
	): Input {
		const fields = z.array(object).parse(form.fields ?? []);
		const resolve = formNames(doc, formUuid, fields);
		const parse = (source: string) =>
			parseAuthoredXPath(
				doc,
				formUuid,
				resolve,
				source,
				form.type === "followup" || form.type === "close"
					? caseType
					: undefined,
			);
		const result: Input = {
			...form,
			fields: fields.map((field) => content(field, parse)),
		};
		if (result.close_condition != null) {
			const condition = object.parse(result.close_condition);
			const name = z.string().parse(condition.field);
			const uuid = resolve(name.split("/"));
			if (!uuid)
				throw new Error(`Unknown or ambiguous close-condition field: ${name}`);
			const { field: _field, ...settings } = condition;
			result.close_condition = { ...settings, fieldUuid: uuid };
		}
		return result;
	}
	if (toolName === "createModule") {
		input.moduleUuid = randomUUID();
		input.forms =
			input.forms == null
				? input.forms
				: z
						.array(object)
						.parse(input.forms)
						.map((form) => {
							const formUuid = asUuid(randomUUID());
							return normalizeForm(
								{ ...form, formUuid },
								formUuid,
								typeof input.case_type === "string"
									? input.case_type
									: undefined,
							);
						});
		return input;
	}
	if (toolName === "createForm") {
		const formUuid = asUuid(randomUUID());
		return normalizeForm(
			{ ...input, formUuid },
			formUuid,
			doc.modules[asUuid(z.string().parse(input.moduleUuid))]?.caseType,
		);
	}
	if (toolName === "addFields")
		return normalizeForm(input, asUuid(z.string().parse(input.formUuid)));
	if (toolName === "updateForm") {
		const { fields: _fields, ...settings } = normalizeForm(
			input,
			asUuid(z.string().parse(input.formUuid)),
		);
		return settings;
	}
	const formUuid =
		toolName === "editField"
			? findContainingForm(doc, asUuid(z.string().parse(input.fieldUuid)))
			: undefined;
	const edit =
		toolName === "editField" ? object.parse(input.updates) : undefined;
	const rename =
		typeof edit?.id === "string"
			? { uuid: z.string().parse(input.fieldUuid), id: edit.id }
			: undefined;
	const resolve = formUuid
		? formNames(doc, formUuid, [], rename)
		: () => undefined;
	const parse = (source: string) =>
		parseAuthoredXPath(doc, formUuid, resolve, source);
	if (toolName === "editField") {
		const updates = content(object.parse(input.updates), parse);
		const field = doc.fields[asUuid(z.string().parse(input.fieldUuid))];
		const existing =
			field && "optionsSource" in field ? field.optionsSource : undefined;
		if (updates.optionsSource != null && existing?.kind === "inline") {
			if (existing.options.some((option) => option.media !== undefined))
				throw new Error(
					"This comparison cannot replace choices with attached media.",
				);
			const source = object.parse(updates.optionsSource);
			updates.optionsSource = {
				...source,
				options: z
					.array(object)
					.parse(source.options)
					.map((option) => ({
						...option,
						optionUuid: existing.options.find(
							(old) => old.value === option.value,
						)?.uuid,
					})),
			};
		}
		return { ...input, updates };
	}
	if (toolName === "generateSchema") {
		return {
			...input,
			caseTypes: z
				.array(object)
				.parse(input.caseTypes)
				.map((record) => ({
					...record,
					properties: z
						.array(object)
						.parse(record.properties)
						.map((property) => content(property, parse, true)),
				})),
		};
	}
	return input;
}
