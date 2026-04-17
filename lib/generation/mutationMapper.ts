/**
 * Pure mutation mapper for generation stream events.
 *
 * Translates server-sent stream events into doc-layer `Mutation[]` arrays
 * that can be applied to a `BlueprintDoc` via `store.apply()` or
 * `store.applyMany()`. No side effects, no store references, no signal
 * grid — the caller is responsible for dispatching the returned mutations.
 *
 * This file is the ONE legitimate wire-format ingress for SA stream
 * events: CommCare's `BlueprintForm` vocabulary (`type`, `case_property_on`,
 * `validation`, nested `children` tree, snake_case keys) is only tolerated
 * here. Everything downstream receives the normalized domain shape —
 * `Field` with `kind`, `case_property`, `validate`, and a flat entity map
 * joined by uuid-keyed `fieldOrder` maps.
 *
 * Form-content events (`data-form-done`, `data-form-fixed`,
 * `data-form-updated`) emit a DECOMPOSED mutation sequence rather than a
 * single wholesale swap. The sequence is always:
 *
 *   1. `updateForm` — form-entity metadata patch (name/type/closeCondition/…).
 *   2. `removeField × N` — one per existing top-level child of the form;
 *      the reducer cascades each into its descendants.
 *   3. `addField × M` — one per incoming wire question, emitted in
 *      top-down tree order so container parents land before their kids.
 *
 * The decomposition matches the fine-grained mutation surface used by the
 * interactive builder, so the SA and the user both drive the doc store
 * through the same API. Phase 4's event log captures semantic history
 * instead of opaque replacement blobs, and undo collapses cleanly per
 * user-meaningful action.
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

// ── Wire-format types (local to this boundary) ─────────────────────────

/**
 * Wire-format question shape as received from the SA stream.
 *
 * Mirrors the subset of `BlueprintForm.questions[]` keys that a doc
 * `Field` cares about. CommCare's vocabulary (`type`, `case_property_on`,
 * `validation`, `validation_msg`) survives ONLY here — every downstream
 * mutation carries the domain names (`kind`, `case_property`, `validate`,
 * `validate_msg`). Kept local (not exported) because there is no other
 * legitimate consumer of the wire shape; the rest of the app should only
 * ever see translated `Field` entities.
 */
interface WireQuestion {
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
	children?: WireQuestion[];
}

/**
 * Flat-list tuple describing one pending `addField` mutation.
 *
 * Produced by `flattenWireQuestionsToFields` in top-down tree order so
 * that emitting `addField` mutations in array order guarantees every
 * container parent is installed in the draft before any of its children
 * tries to reference it.
 *
 * `parentUuid` is either the form's uuid (for top-level fields) or a
 * container field's uuid (for nested fields). `index` is the sibling
 * index within the parent (0-based) — emitted explicitly so sequential
 * `addField` dispatches land in a stable, deterministic order regardless
 * of the reducer's append-vs-insert default.
 */
interface PendingFieldAdd {
	parentUuid: Uuid;
	field: Field;
	index: number;
}

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
 * an entire form's content with the SA's generated/fixed/updated output
 * as a decomposed mutation sequence.
 *
 * Emitted mutations, in order:
 *   1. `updateForm` — patches the form-entity metadata in place. Omits
 *      `purpose` so the scaffold-stamped value survives (the wire form
 *      doesn't carry purpose; including the key as `undefined` would
 *      clear it via `Object.assign` in the reducer).
 *   2. `removeField × N` — one per existing top-level child of the form.
 *      The reducer's `cascadeDeleteField` walks into each container and
 *      deletes the entire descendant subtree, so only top-level children
 *      need explicit mutations.
 *   3. `addField × M` — one per incoming wire question, in top-down tree
 *      order. Container parents always precede their children in the
 *      array; the `addField` reducer pre-seeds `fieldOrder` for group /
 *      repeat kinds so nested adds find a valid parent slot.
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

	/* Resolve the form's UUID from the doc's index-based ordering. If
	 * either index falls outside the doc's current shape, emit nothing —
	 * the stream dispatcher will no-op and the mismatch surfaces as a
	 * silent drop rather than a throw. */
	const moduleUuid = doc.moduleOrder[moduleIndex];
	if (!moduleUuid) return [];
	const formUuid = doc.formOrder[moduleUuid]?.[formIndex];
	if (!formUuid) return [];

	const existingForm = doc.forms[formUuid];

	/*
	 * Build the form-level patch.
	 *
	 * Every mutable form-level property is emitted explicitly: present
	 * values install the new state, absent values become `undefined` so
	 * the reducer's `Object.assign(form, patch)` clears them. This keeps
	 * the wholesale-replace semantics the old `replaceForm` mutation
	 * provided at the form-entity level — a wire form that no longer has
	 * a `close_condition` correctly drops the stored `closeCondition`
	 * rather than leaving stale data in place.
	 *
	 * `purpose` is deliberately absent from the patch type + object.
	 * Scaffold stamps `purpose` onto the form entity; the SA's wire form
	 * payload doesn't round-trip it. Omitting the key entirely (not even
	 * as `undefined`) means `Object.assign` never sees it and the
	 * existing value survives — symmetric with the dance the old
	 * `replaceForm` code did when it re-stamped `existingForm.purpose`
	 * onto the replacement entity.
	 */
	const formPatch: Partial<Omit<Form, "uuid" | "purpose">> = {
		// Forms carry a semantic id slug; preserve the scaffold-derived
		// slug when present, otherwise derive one from the display name
		// (fallback catches forms created outside the normal scaffold path).
		id: existingForm?.id ?? (slugify(form.name) || "form"),
		name: form.name,
		type: form.type as FormType,
		// closeCondition maps the wire `question` key to the domain `field`
		// key. Left `undefined` when the wire form has no close condition
		// so the reducer clears any previously-stored value.
		closeCondition: form.close_condition
			? {
					field: form.close_condition.question,
					answer: form.close_condition.answer,
					...(form.close_condition.operator && {
						operator: form.close_condition.operator,
					}),
				}
			: undefined,
		// connect is the Connect sub-config (learn module / assessment /
		// deliver unit / task). Wire-absence clears the stored value via
		// the explicit `undefined`.
		connect: form.connect ?? undefined,
		// postSubmit preserves wholesale-replace semantics: when the wire
		// form has no `post_submit`, the patch clears any stored value.
		postSubmit: form.post_submit,
	};

	const mutations: Mutation[] = [
		{ kind: "updateForm", uuid: formUuid, patch: formPatch },
	];

	/*
	 * Wipe the existing field subtree. Only top-level children need an
	 * explicit `removeField` mutation — the reducer cascades each into
	 * its descendants via `cascadeDeleteField`. Reading `doc.fieldOrder`
	 * (the snapshot passed in) gives us the authoritative top-level list
	 * before any mutations are applied.
	 */
	const existingTopLevel = doc.fieldOrder[formUuid] ?? [];
	for (const childUuid of existingTopLevel) {
		mutations.push({ kind: "removeField", uuid: childUuid });
	}

	/*
	 * Add every incoming field. Order matters: a container parent
	 * (group/repeat) must be added BEFORE any of its children so the
	 * child's `addField` reducer finds the parent entity in the draft.
	 * The `addField` reducer pre-seeds an empty `fieldOrder` slot when a
	 * new container lands, so the subsequent child add has a valid
	 * sibling list to splice into.
	 *
	 * `flattenWireQuestionsToFields` produces the tree in top-down order,
	 * so emitting mutations in array order is sufficient.
	 */
	const pending: PendingFieldAdd[] = [];
	flattenWireQuestionsToFields(
		(form.questions ?? []) as WireQuestion[],
		formUuid,
		pending,
	);
	for (const { parentUuid, field, index } of pending) {
		mutations.push({ kind: "addField", parentUuid, field, index });
	}

	return mutations;
}

/**
 * Recursive wire→domain walker for question subtrees.
 *
 * Pushes a `PendingFieldAdd` tuple for every wire question onto `acc` in
 * top-down tree order. Ordering invariant: a container parent's tuple is
 * always pushed before any of its descendants' tuples, so a caller that
 * emits `addField` mutations in array order is guaranteed that every
 * parent is installed in the draft before any of its children try to
 * reference it.
 *
 * Rename rules applied here (the wire→domain translation happens only
 * at this boundary — every downstream `Field` uses the domain names):
 *   - wire `type` → domain `kind` (the discriminant rename)
 *   - wire `case_property_on` → domain `case_property`
 *   - wire `validation` / `validation_msg` → domain `validate` /
 *     `validate_msg`
 *
 * Uuids are preserved verbatim from the wire input — the SA assigns
 * them at question creation time, and downstream logic (XPath rewrite,
 * React key identity, dnd-kit) depends on their stability.
 *
 * Only `group` and `repeat` kinds recurse into `children`; every other
 * kind is a leaf at the doc-normalized level, regardless of what the
 * wire payload might have attached.
 */
function flattenWireQuestionsToFields(
	questions: ReadonlyArray<WireQuestion>,
	parentUuid: Uuid,
	acc: PendingFieldAdd[],
): void {
	questions.forEach((q, index) => {
		const uuid = asUuid(q.uuid);
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
		acc.push({ parentUuid, field: fieldObj as Field, index });
		if (q.children?.length && (q.type === "group" || q.type === "repeat")) {
			flattenWireQuestionsToFields(q.children, uuid, acc);
		}
	});
}
