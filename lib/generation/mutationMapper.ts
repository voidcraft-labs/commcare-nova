/**
 * Pure mutation mapper for generation stream events.
 *
 * Translates server-sent stream events into doc-layer `Mutation[]` arrays
 * that can be applied to a `BlueprintDoc` via `store.apply()` or
 * `store.applyMany()`. No side effects, no store references, no signal
 * grid — the caller is responsible for dispatching the returned mutations.
 *
 * The SA still emits wire-format `AppBlueprint` fragments on every doc-
 * mutating event; this file is the ingest boundary that translates those
 * fragments back into the normalized doc shape. `data-form-updated` and
 * its siblings map onto the atomic `replaceForm` mutation, which drops
 * the old field subtree and installs the new one in one pass.
 */

import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseType,
	Field,
	Form,
	FormType,
	Uuid,
} from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import type { BlueprintForm, Scaffold } from "@/lib/schemas/blueprint";

// ── Event type constants ───────────────────────────────────────────────

/** Stream event types that produce doc mutations. */
const FORM_CONTENT_EVENTS = new Set([
	"data-form-done",
	"data-form-fixed",
	"data-form-updated",
]);

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Map a single stream event to zero or more doc mutations.
 *
 * Pure function: reads `doc` for index-to-UUID resolution but never
 * mutates it. The caller applies the returned mutations to the store.
 *
 * @param type - stream event type string (e.g. "data-scaffold")
 * @param data - event payload blob — shape varies by event type
 * @param doc  - current BlueprintDoc snapshot for index lookups
 * @returns mutations to apply, or `[]` if the event is not doc-relevant
 */
export function toDocMutations(
	type: string,
	data: Record<string, unknown>,
	doc: BlueprintDoc,
): Mutation[] {
	switch (type) {
		case "data-schema":
			return mapSchema(data);
		case "data-scaffold":
			return mapScaffold(data);
		case "data-module-done":
			return mapModuleDone(data, doc);
		default:
			if (FORM_CONTENT_EVENTS.has(type)) {
				return mapFormContent(data, doc);
			}
			return [];
	}
}

// ── Event handlers ─────────────────────────────────────────────────────

/**
 * `data-schema` — sets the case type definitions on the doc.
 *
 * Expected payload: `{ caseTypes: CaseType[] }`
 */
function mapSchema(data: Record<string, unknown>): Mutation[] {
	const caseTypes = data.caseTypes as CaseType[] | undefined;
	if (!caseTypes) return [];
	return [{ kind: "setCaseTypes", caseTypes }];
}

/**
 * Produce a lowercase snake_case slug from a display name for entities
 * (modules, forms) that carry a distinct semantic id. The SA wire format
 * for scaffolds doesn't emit slugs, so we derive one at ingest.
 */
function slugify(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return slug;
}

/**
 * `data-scaffold` — creates the app skeleton: name, optional connect
 * type, module shells, and empty form shells.
 *
 * Each module and form gets a freshly minted crypto UUID. Form mutations
 * reference their parent module's UUID so the doc reducer wires up
 * `formOrder` correctly.
 *
 * Expected payload: the Scaffold object directly (app_name, modules, etc.
 * are top-level keys on `data`, not wrapped in a `scaffold` property).
 */
function mapScaffold(data: Record<string, unknown>): Mutation[] {
	const scaffold = data as unknown as Scaffold;
	const mutations: Mutation[] = [];

	/* App-level fields */
	mutations.push({ kind: "setAppName", name: scaffold.app_name });
	if (
		scaffold.connect_type === "learn" ||
		scaffold.connect_type === "deliver"
	) {
		mutations.push({
			kind: "setConnectType",
			connectType: scaffold.connect_type,
		});
	}

	/* Module + form shells — only emit fields that are actually present
	 *  so the reducer receives a domain-valid Module / Form shape (no
	 *  explicit `undefined` keys, which Firestore + Zod both dislike). */
	for (const sm of scaffold.modules) {
		const moduleUuid = asUuid(crypto.randomUUID());
		mutations.push({
			kind: "addModule",
			module: {
				uuid: moduleUuid,
				id: slugify(sm.name) || "module",
				name: sm.name,
				...(sm.case_type != null && { caseType: sm.case_type }),
				...(sm.case_list_only && { caseListOnly: sm.case_list_only }),
				...(sm.purpose !== undefined && { purpose: sm.purpose }),
			},
		});

		for (const sf of sm.forms) {
			const formUuid = asUuid(crypto.randomUUID());
			mutations.push({
				kind: "addForm",
				moduleUuid,
				form: {
					uuid: formUuid,
					id: slugify(sf.name) || "form",
					name: sf.name,
					type: sf.type as FormType,
					...(sf.purpose !== undefined && { purpose: sf.purpose }),
					...(sf.post_submit != null && { postSubmit: sf.post_submit }),
				},
			});
		}
	}

	return mutations;
}

/**
 * `data-module-done` — updates a module's case list columns after the
 * SA finishes generating the module content.
 *
 * Expected payload: `{ moduleIndex: number, caseListColumns: CaseColumn[] | null }`
 */
function mapModuleDone(
	data: Record<string, unknown>,
	doc: BlueprintDoc,
): Mutation[] {
	const moduleIndex = data.moduleIndex as number;
	const caseListColumns = data.caseListColumns as Array<{
		field: string;
		header: string;
	}> | null;

	const moduleUuid = doc.moduleOrder[moduleIndex];
	if (!moduleUuid) return [];

	/* Build a patch that always emits a `caseListColumns` key — either the
	 * caller-supplied value or `undefined` when the SA sent `null` (meaning
	 * "clear"). The reducer then merges via `Object.assign`, which treats
	 * `undefined` as removal, so the column list is cleared when appropriate
	 * and replaced otherwise. */
	const patch: Partial<Omit<(typeof doc.modules)[Uuid], "uuid">> = {
		caseListColumns: caseListColumns ?? undefined,
	};

	return [{ kind: "updateModule", uuid: moduleUuid, patch }];
}

/**
 * `data-form-done` / `data-form-fixed` / `data-form-updated` — replaces
 * an entire form's content with the SA's generated/fixed/updated output.
 *
 * The incoming wire-format `BlueprintForm` is translated to the normalized
 * domain shape: flat `Field[]` + `fieldOrder` map keyed by parent uuid.
 * The form's existing `purpose` (set during scaffold) is preserved
 * because the wire-format `BlueprintForm` doesn't carry purpose.
 *
 * Expected payload: `{ moduleIndex: number, formIndex: number, form: BlueprintForm }`
 */
function mapFormContent(
	data: Record<string, unknown>,
	doc: BlueprintDoc,
): Mutation[] {
	const moduleIndex = data.moduleIndex as number;
	const formIndex = data.formIndex as number;
	const form = data.form as BlueprintForm;

	/* Resolve the form's UUID from the doc's index-based ordering. */
	const moduleUuid = doc.moduleOrder[moduleIndex];
	if (!moduleUuid) return [];

	const formUuid = doc.formOrder[moduleUuid]?.[formIndex];
	if (!formUuid) return [];

	/* Preserve the scaffold-set purpose. BlueprintForm doesn't carry
	 * purpose, so we re-stamp it from the doc's existing form entity. */
	const existingForm = doc.forms[formUuid];
	const replacementForm: Form = {
		uuid: formUuid,
		// Forms carry a semantic id slug. Preserve the scaffold slug when
		// we have one; fall back to a fresh slug from the display name.
		id: existingForm?.id ?? (slugify(form.name) || "form"),
		name: form.name,
		type: form.type as FormType,
		...(existingForm?.purpose !== undefined && {
			purpose: existingForm.purpose,
		}),
		...(form.close_condition && {
			closeCondition: {
				field: form.close_condition.question,
				answer: form.close_condition.answer,
				...(form.close_condition.operator && {
					operator: form.close_condition.operator,
				}),
			},
		}),
		...(form.connect && { connect: form.connect }),
		...(form.post_submit !== undefined && { postSubmit: form.post_submit }),
	};

	/*
	 * Walk the nested wire-format question tree and flatten it into the
	 * doc's normalized shape. `fieldOrder` is keyed by parent UUID: top-
	 * level questions land under `formUuid`; nested group/repeat children
	 * land under their parent's UUID. The `case_property_on` → `case_
	 * property` rename happens here, at the wire boundary.
	 */
	const fields: Field[] = [];
	const fieldOrder: Record<Uuid, Uuid[]> = {};
	fieldOrder[formUuid] = [];
	flattenFormQuestions(
		(form.questions ?? []) as unknown as Parameters<
			typeof flattenFormQuestions
		>[0],
		formUuid,
		fields,
		fieldOrder,
	);

	return [
		{
			kind: "replaceForm",
			uuid: formUuid,
			form: replacementForm,
			fields,
			fieldOrder,
		},
	];
}

/**
 * Recursive wire→domain walker for question subtrees. Populates `fields`
 * and `fieldOrder` by side effect so nested recursion doesn't allocate
 * intermediate arrays at each level.
 *
 * Rename rules applied here:
 *   - wire `type` → domain `kind` (the discriminant rename)
 *   - wire `case_property_on` → domain `case_property`
 *   - wire `validation` / `validation_msg` → domain `validate` / `validate_msg`
 *
 * Uuids are preserved verbatim from the wire input — the SA assigns
 * them at question creation time, and downstream `renameField` logic
 * depends on their stability.
 */
function flattenFormQuestions(
	questions: Array<{
		uuid: string;
		id: string;
		type: string;
		label?: string;
		hint?: string;
		required?: string;
		relevant?: string;
		validation?: string;
		validation_msg?: string;
		calculate?: string;
		default_value?: string;
		options?: Array<{ value: string; label: string }>;
		case_property_on?: string;
		children?: Array<Record<string, unknown>>;
	}>,
	parentUuid: Uuid,
	fields: Field[],
	fieldOrder: Record<Uuid, Uuid[]>,
): void {
	for (const q of questions) {
		const uuid = asUuid(q.uuid);
		fieldOrder[parentUuid].push(uuid);

		const fieldObj: Record<string, unknown> = {
			kind: q.type,
			uuid,
			id: q.id,
			label: q.label ?? "",
			...(q.case_property_on != null && { case_property: q.case_property_on }),
			...(q.hint != null && { hint: q.hint }),
			...(q.required != null && { required: q.required }),
			...(q.relevant != null && { relevant: q.relevant }),
			...(q.validation != null && { validate: q.validation }),
			...(q.validation_msg != null && { validate_msg: q.validation_msg }),
			...(q.calculate != null && { calculate: q.calculate }),
			...(q.default_value != null && { default_value: q.default_value }),
			...(q.options != null && { options: q.options }),
		};
		fields.push(fieldObj as Field);

		if (q.children?.length && (q.type === "group" || q.type === "repeat")) {
			fieldOrder[uuid] = [];
			flattenFormQuestions(
				q.children as Parameters<typeof flattenFormQuestions>[0],
				uuid,
				fields,
				fieldOrder,
			);
		}
	}
}
