import {
	asUuid,
	type BlueprintDoc,
	deriveCaseWriteInventory,
	type Field,
	fieldCaseWrite,
	moduleUuidOfForm,
	type Uuid,
	uniqueSlug,
	type XPathExpression,
} from "@/lib/domain";
import { deepEqual } from "./deepEqual";
import { findContainingForm } from "./mutations/helpers";
import { type Mutation, mutationSchema } from "./types";

function namingContext(doc: BlueprintDoc, formUuid: Uuid) {
	const form = doc.forms[formUuid];
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid ? doc.modules[moduleUuid] : undefined;
	if (!form || !module?.caseType || form.type === "survey") return;
	const primary = deriveCaseWriteInventory(
		doc,
		formUuid,
		module,
		form.type,
	).buckets.find((bucket) => bucket.kind === "primary");
	return {
		caseType: module.caseType,
		writers: (primary?.writers ?? [])
			.filter((writer) => writer.property === "case_name")
			.map((writer) => doc.fields[writer.fieldUuid]),
	};
}

/** Read the existing canonical writer; there is no parallel form-name state. */
export function formRecordName(
	doc: BlueprintDoc,
	formUuid: Uuid,
): XPathExpression | undefined {
	const writers = namingContext(doc, formUuid)?.writers;
	if (writers?.length !== 1) return;
	const field = writers[0];
	return field.kind === "hidden" && field.calculate && !field.relevant
		? field.calculate
		: { parts: [{ kind: "field-ref", uuid: field.uuid }] };
}

/** Author a record name through the ordinary field-write model. Reuse a text
 * answer when possible; expressions use a calculated field, visible in Builder.
 * All destinations and supporting fields are changed in the caller's one batch. */
export function formRecordNameMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	value: XPathExpression,
): Mutation[] {
	const context = namingContext(doc, formUuid);
	if (!context)
		throw new Error(
			"This form has no record to name. Choose a registration, follow-up or close form with a record type.",
		);
	if (deepEqual(formRecordName(doc, formUuid), value)) return [];
	const parts = value.parts.filter(
		(part) => part.kind !== "text" || part.text.trim() !== "",
	);
	const reference =
		parts.length === 1 &&
		(parts[0].kind === "field-ref" || parts[0].kind === "path-ref")
			? parts[0]
			: undefined;
	const answer = reference ? doc.fields[reference.uuid] : undefined;
	if (answer && findContainingForm(doc, answer.uuid) !== formUuid)
		throw new Error("The record name must use answers from this form.");
	const destination = { caseType: context.caseType, property: "case_name" };
	const currentWrite = answer ? fieldCaseWrite(answer) : undefined;
	if (
		answer &&
		context.writers.length === 1 &&
		context.writers[0].uuid === answer.uuid
	)
		return [];
	const direct =
		answer?.kind === "text" &&
		(!currentWrite || deepEqual(currentWrite, destination))
			? answer
			: undefined;
	const calculated =
		context.writers.length === 1 &&
		context.writers[0].kind === "hidden" &&
		!context.writers[0].relevant
			? context.writers[0]
			: undefined;
	const target = calculated ?? direct;
	const mutations: Mutation[] = context.writers
		.filter((writer) => writer.uuid !== target?.uuid)
		.map((writer) =>
			mutationSchema.parse({
				kind: "updateField",
				uuid: writer.uuid,
				targetKind: writer.kind,
				patch: { caseWrite: null },
			}),
		);
	if (calculated) {
		mutations.push({
			kind: "updateField",
			uuid: calculated.uuid,
			targetKind: "hidden",
			patch: { calculate: value, default_value: null },
		});
	} else if (direct) {
		mutations.push({
			kind: "updateField",
			uuid: direct.uuid,
			targetKind: "text",
			patch: { caseWrite: destination },
		});
	} else {
		const field: Field = {
			uuid: asUuid(crypto.randomUUID()),
			id: uniqueSlug(
				"record_name",
				"record_name",
				new Set(
					Object.values(doc.fields)
						.filter((field) => findContainingForm(doc, field.uuid) === formUuid)
						.map((field) => field.id),
				),
			),
			kind: "hidden",
			calculate: value,
			caseWrite: destination,
		};
		mutations.push({ kind: "addField", parentUuid: formUuid, field });
	}
	return mutations;
}
