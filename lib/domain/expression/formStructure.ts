import type { BlueprintDoc } from "../blueprint";
import type { FieldKind, RepeatMode } from "../fields";
import type { ConnectActivity } from "../fields/connectActivity";
import type { TextField } from "../fields/text";
import {
	type FormBehaviorTexts,
	type FormLinkTarget,
	type FormType,
	formBehaviorTextsOf,
	formLinkEntries,
} from "../forms";
import type { LookupTableId } from "../lookupIds";
import { moduleUuidOfForm } from "../postSubmit";
import type { QueryRepeatPlacement, RowTiming } from "../queryRepeatPlacement";
import { ownRecordValue } from "../records";
import { expressionSlotValue } from "../referenceSlots";
import { submissionLayout } from "../submissionLayout";
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
	readonly repeatMode?: RepeatMode;
	readonly activityKind?: ConnectActivity["kind"];
	/** A query repeat's held placement (its stored `placement`), absent where
	 * it holds none. */
	readonly heldQueryPlacement?: QueryRepeatPlacement;
	readonly rowTiming?: RowTiming;
	/** A Hidden Value's value slot, absent where it holds neither. Where both slots are present, the calculation supplies the final answer. */
	readonly hiddenValueSource?: "calculate" | "default_value";
	readonly textInput?: Pick<TextField, "keypad" | "addressLookup">;
	readonly choices?: FormStructureChoices;
	readonly proseSlots?: readonly (
		| "label"
		| "hint"
		| "help"
		| "validate_msg"
		| "addFirstLabel"
		| "addLabel"
	)[];
}

export interface FormStructure extends FormBehaviorTexts {
	readonly dataRootName?: string;
	readonly formUuid: Uuid;
	readonly moduleUuid: Uuid;
	readonly type: FormType;
	readonly fields: ReadonlyMap<Uuid, FormStructureField>;
	readonly fieldOrder: ReadonlyMap<Uuid, readonly Uuid[]>;
	/** Every link of the form (`forms.ts::formLinkEntries`): its
	 *  destinations, and the otherwise when it is a link (`role:
	 *  "otherwise"`, which has no condition slot). */
	readonly links: ReadonlyMap<
		Uuid,
		{
			readonly target: FormLinkTarget;
			readonly datums: readonly FormLinkDatumName[];
			readonly role?: "otherwise";
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
	const layout = submissionLayout(formUuid, doc.fields, doc.fieldOrder);
	const fields = new Map<Uuid, FormStructureField>();

	const visiting = new Set<Uuid>();
	const visit = (parent: Uuid): void => {
		if (visiting.has(parent)) return;
		visiting.add(parent);
		const ordered = ownRecordValue(doc.fieldOrder, parent) ?? [];

		for (const uuid of ordered) {
			const field = ownRecordValue(doc.fields, uuid);
			if (field === undefined || fields.has(uuid)) continue;
			const choices =
				"optionsSource" in field ? field.optionsSource : undefined;
			fields.set(uuid, {
				uuid,
				id: field.id,
				kind: field.kind,
				...(field.kind === "connect_activity" && {
					activityKind: field.activity.kind,
				}),
				parent: layout.parents.get(uuid) ?? parent,
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
					...(field.kind === "repeat" && field.addFirstLabel !== undefined
						? ["addFirstLabel" as const]
						: []),
					...(field.kind === "repeat" && field.addLabel !== undefined
						? ["addLabel" as const]
						: []),
					...("validate_msg" in field && field.validate_msg !== undefined
						? ["validate_msg" as const]
						: []),
				],
				...(field.kind === "text" && {
					textInput: {
						keypad: field.keypad,
						addressLookup: field.addressLookup,
					},
				}),
				...(field.kind === "repeat" ? { repeatMode: field.repeat_mode } : {}),
				...(field.kind === "repeat" &&
				field.repeat_mode === "query_bound" &&
				field.placement !== undefined
					? { heldQueryPlacement: field.placement }
					: {}),
				...(field.kind === "repeat" &&
				field.repeat_mode === "query_bound" &&
				field.rowTiming !== undefined
					? { rowTiming: field.rowTiming }
					: {}),
				...(field.kind === "hidden"
					? field.calculate !== undefined
						? { hiddenValueSource: "calculate" as const }
						: field.default_value !== undefined
							? { hiddenValueSource: "default_value" as const }
							: {}
					: {}),
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
	const result: FormStructure = {
		formUuid,
		...(form.dataRootName !== undefined && { dataRootName: form.dataRootName }),
		moduleUuid,
		type: form.type,
		...formBehaviorTextsOf(form),
		fields,
		fieldOrder: layout.children,
		links: new Map(
			formLinkEntries(form).map(({ role, link }) => [
				link.uuid,
				{
					target: link.target,
					datums: (link.datums ?? []).map((datum) => datum.name),
					...(role === "otherwise" ? { role } : {}),
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
