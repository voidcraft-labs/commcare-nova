import {
	asUuid,
	type BlueprintDoc,
	deriveCaseWriteInventory,
	type Expression,
	type Field,
	fieldCaseWrite,
	moduleUuidOfForm,
	type Uuid,
	uniqueSlug,
} from "@/lib/domain";
import {
	type FormStructure,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type { FieldExpressionSlotRef } from "@/lib/domain/expression/types";
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
): Expression | undefined {
	const writers = namingContext(doc, formUuid)?.writers;
	if (writers?.length !== 1) return;
	const field = writers[0];
	return field.kind === "hidden" && field.calculate && !field.relevant
		? field.calculate
		: { kind: "term", term: { kind: "field", uuid: field.uuid } };
}

export interface PreparedFormRecordName {
	readonly slot: FieldExpressionSlotRef;
	readonly form: FormStructure;
	readonly fieldUuid: Uuid;
	readonly fieldId: string;
}

/** Declare the actual calculate carrier before parsing a record-name edit.
 * A new hidden field has an identity and a place, with no dummy expression.
 * The caller retains this preparation until the same identity is committed. */
export function prepareFormRecordName(
	doc: BlueprintDoc,
	formUuid: Uuid,
	prospectiveUuid: Uuid = asUuid(crypto.randomUUID()),
): PreparedFormRecordName | undefined {
	const naming = namingContext(doc, formUuid);
	const form = formStructure(doc, formUuid);
	if (naming === undefined || form === undefined) return undefined;
	const existing =
		naming.writers.length === 1 &&
		naming.writers[0].kind === "hidden" &&
		!naming.writers[0].relevant
			? naming.writers[0]
			: undefined;
	const fieldUuid = existing?.uuid ?? prospectiveUuid;
	const fieldId =
		existing?.id ??
		uniqueSlug(
			"record_name",
			"record_name",
			new Set([...form.fields.values()].map((field) => field.id)),
		);
	const slot: FieldExpressionSlotRef = {
		entity: "field",
		uuid: fieldUuid,
		slot: "calculate",
	};
	if (existing !== undefined) return { slot, form, fieldUuid, fieldId };
	if (doc.fields[fieldUuid] !== undefined)
		throw new Error("The new record-name field's identity is already in use.");
	const fields = new Map(form.fields);
	fields.set(fieldUuid, {
		uuid: fieldUuid,
		id: fieldId,
		kind: "hidden",
		parent: formUuid,
		caseWrite: { caseType: naming.caseType, property: "case_name" },
	});
	const fieldOrder = new Map(form.fieldOrder);
	fieldOrder.set(formUuid, [...(fieldOrder.get(formUuid) ?? []), fieldUuid]);
	return {
		slot,
		fieldUuid,
		fieldId,
		form: {
			...form,
			fields,
			fieldOrder,
			expressionAt: (ref) =>
				ref.entity === "field" && ref.uuid === fieldUuid
					? undefined
					: form.expressionAt(ref),
		},
	};
}

/** Author a record name through the ordinary field-write model. Reuse a text
 * answer when possible; expressions use a calculated field, visible in Builder.
 * All destinations and supporting fields are changed in the caller's one batch. */
export function formRecordNameMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	value: Expression,
	prepared?: Pick<PreparedFormRecordName, "fieldUuid" | "fieldId">,
): Mutation[] {
	const context = namingContext(doc, formUuid);
	if (!context)
		throw new Error(
			"This form has no record to name. Choose a registration, follow-up or close form with a record type.",
		);
	if (deepEqual(formRecordName(doc, formUuid), value)) return [];
	const reference =
		value.kind === "term" &&
		value.term.kind === "field" &&
		value.term.role === undefined &&
		value.term.filters === undefined
			? value.term
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
		const pending = prepareFormRecordName(doc, formUuid, prepared?.fieldUuid);
		if (pending === undefined)
			throw new Error("This form no longer has a record to name.");
		if (prepared !== undefined && pending.fieldId !== prepared.fieldId)
			throw new Error(
				"The record-name field changed while you were editing. Reopen it to use its latest place in the form.",
			);
		const field: Field = {
			uuid: pending.fieldUuid,
			id: pending.fieldId,
			kind: "hidden",
			calculate: value,
			caseWrite: destination,
		};
		mutations.push({ kind: "addField", parentUuid: formUuid, field });
	}
	return mutations;
}
