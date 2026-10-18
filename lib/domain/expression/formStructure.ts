import type { BlueprintDoc } from "../blueprint";
import type { CaseWrite, FieldKind, RepeatMode } from "../fields";
import type { FormEntry, FormLinkTarget, FormType } from "../forms";
import type { LookupTableId } from "../lookupIds";
import { moduleUuidOfForm } from "../postSubmit";
import { ownRecordValue } from "../records";
import { expressionSlotValue } from "../referenceSlots";
import type { Uuid } from "../uuid";
import type {
	Expression,
	FieldExpressionSlotRef,
	FormExpressionSlotRef,
	FormLinkDatumName,
} from "./types";

export type FormStructureChoices =
	| {
			readonly kind: "inline";
			readonly options: readonly {
				readonly uuid: Uuid;
				readonly value: string;
			}[];
	  }
	| { readonly kind: "cases"; readonly caseType: string }
	| { readonly kind: "lookup"; readonly tableId: LookupTableId };

/** The declarations a form expression can bind, without expression text or a
 * partial BlueprintDoc. Prepared calls supply the same view as saved forms. */
export interface FormStructureField {
	readonly uuid: Uuid;
	readonly id: string;
	readonly kind: FieldKind;
	readonly parent: Uuid;
	readonly caseWrite?: CaseWrite;
	readonly repeatMode?: RepeatMode;
	readonly choices?: FormStructureChoices;
	readonly proseSlots?: readonly ("label" | "hint" | "help" | "validate_msg")[];
}

export type FormStructureConnect = Readonly<
	Partial<
		Record<
			"learn_module" | "assessment" | "deliver_unit" | "task",
			{ readonly id: string }
		>
	>
>;

export interface FormStructure {
	readonly formUuid: Uuid;
	readonly moduleUuid: Uuid;
	readonly type: FormType;
	readonly entry?: FormEntry;
	readonly fields: ReadonlyMap<Uuid, FormStructureField>;
	readonly fieldOrder: ReadonlyMap<Uuid, readonly Uuid[]>;
	/** Only blocks active in the saved or pending app mode. */
	readonly connect: FormStructureConnect;
	readonly links: ReadonlyMap<
		Uuid,
		{
			readonly target: FormLinkTarget;
			readonly datums: readonly FormLinkDatumName[];
		}
	>;
	/** Pending views memoize production parsing here. A parse or dependency
	 * cycle failure throws; undefined means the optional slot is absent. */
	expressionAt(
		slot: FieldExpressionSlotRef | FormExpressionSlotRef,
	): Expression | undefined;
}

const structures = new WeakMap<BlueprintDoc, Map<Uuid, FormStructure>>();

/** A complete saved form's immutable structural view. */
export function formStructure(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormStructure | undefined {
	const cached = structures.get(doc)?.get(formUuid);
	if (cached !== undefined) return cached;
	const form = ownRecordValue(doc.forms, formUuid);
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (form === undefined || moduleUuid === undefined) return undefined;
	const fields = new Map<Uuid, FormStructureField>();
	const fieldOrder = new Map<Uuid, readonly Uuid[]>();
	const visiting = new Set<Uuid>();
	const visit = (parent: Uuid): void => {
		if (visiting.has(parent)) return;
		visiting.add(parent);
		const ordered = ownRecordValue(doc.fieldOrder, parent) ?? [];
		fieldOrder.set(parent, ordered);
		for (const uuid of ordered) {
			const field = ownRecordValue(doc.fields, uuid);
			if (field === undefined || fields.has(uuid)) continue;
			const choices =
				"optionsSource" in field ? field.optionsSource : undefined;
			fields.set(uuid, {
				uuid,
				id: field.id,
				kind: field.kind,
				parent,
				proseSlots: [
					...("label" in field && field.label !== undefined
						? ["label" as const]
						: []),
					...("hint" in field && field.hint !== undefined
						? ["hint" as const]
						: []),
					...("help" in field && field.help !== undefined
						? ["help" as const]
						: []),
					...("validate_msg" in field && field.validate_msg !== undefined
						? ["validate_msg" as const]
						: []),
				],
				...("caseWrite" in field && field.caseWrite !== undefined
					? { caseWrite: field.caseWrite }
					: {}),
				...(field.kind === "repeat" ? { repeatMode: field.repeat_mode } : {}),
				...(choices === undefined
					? {}
					: {
							choices:
								choices.kind === "inline"
									? { kind: "inline" as const, options: choices.options }
									: choices.kind === "cases"
										? { kind: "cases" as const, caseType: choices.caseType }
										: { kind: "lookup" as const, tableId: choices.tableId },
						}),
			});
			if (["group", "section", "repeat"].includes(field.kind)) visit(uuid);
		}
	};
	visit(formUuid);
	const connect: Partial<
		Record<keyof FormStructureConnect, { readonly id: string }>
	> = {};
	if (doc.connectType === "learn" && form.connect !== undefined) {
		if (
			"learn_module" in form.connect &&
			form.connect.learn_module !== undefined
		)
			connect.learn_module = { id: form.connect.learn_module.id };
		if ("assessment" in form.connect && form.connect.assessment !== undefined)
			connect.assessment = { id: form.connect.assessment.id };
	} else if (doc.connectType === "deliver" && form.connect !== undefined) {
		if (
			"deliver_unit" in form.connect &&
			form.connect.deliver_unit !== undefined
		)
			connect.deliver_unit = { id: form.connect.deliver_unit.id };
		if ("task" in form.connect && form.connect.task !== undefined)
			connect.task = { id: form.connect.task.id };
	}
	const result: FormStructure = {
		formUuid,
		moduleUuid,
		type: form.type,
		...(form.entry === undefined ? {} : { entry: form.entry }),
		fields,
		fieldOrder,
		connect,
		links: new Map(
			(form.formLinks ?? []).map((link) => [
				link.uuid,
				{
					target: link.target,
					datums: (link.datums ?? []).map((datum) => datum.name),
				},
			]),
		),
		expressionAt: (slot) => expressionSlotValue(doc, slot),
	};
	let forms = structures.get(doc);
	if (forms === undefined) {
		forms = new Map();
		structures.set(doc, forms);
	}
	forms.set(formUuid, result);
	return result;
}

/** Logical authored paths omit generated query-row structure. */
export function formFieldPath(
	form: FormStructure,
	uuid: Uuid,
): readonly string[] | undefined {
	const path: string[] = [];
	const seen = new Set<Uuid>();
	let current = uuid;
	while (!seen.has(current)) {
		seen.add(current);
		const field = form.fields.get(current);
		if (field === undefined) return undefined;
		path.unshift(field.id);
		if (field.parent === form.formUuid) return path;
		current = field.parent;
	}
	return undefined;
}
