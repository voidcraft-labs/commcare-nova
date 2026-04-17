/**
 * Legacy wire-format bridge.
 *
 * One-way translator between the domain's normalized `BlueprintDoc`
 * (top-level field maps + order arrays, internal `case_property` naming)
 * and the legacy nested `AppBlueprint` wire format that CommCare-adjacent
 * code and the SA's data-done / data-blueprint-updated events still speak.
 *
 * Historical context: before Phase 1 the entire codebase round-tripped
 * through the legacy `toDoc` / `toBlueprint` pair in `lib/doc/converter.ts`.
 * Phase 1 flipped Firestore to persist the normalized shape directly —
 * after Task 14 `converter.ts` is deleted. Until the components/SA layers
 * finish their rename (Task 21), this file keeps two bridging helpers
 * alive:
 *
 *   - `legacyAppBlueprintToDoc` — decompose a nested `AppBlueprint` (or
 *     its Firestore blob form) into a `BlueprintDoc`. Used by the
 *     client-side stream dispatcher on `data-done` / `data-blueprint-
 *     updated`, and by the one-time Firestore migration script.
 *   - `toBlueprint` — re-emit a doc as a nested `AppBlueprint`. Used by
 *     the SA's event emissions (it still speaks the wire format on the
 *     chat stream) and by export / chat-body serializers.
 *
 * Both helpers rename CommCare-boundary fields at the translation
 * boundary: `case_property_on` ↔ `case_property`, `close_condition.
 * question` ↔ `close_condition.field`, and form_link index ↔ uuid form.
 *
 * This file has no side effects and no Firestore dependency — the
 * migration script imports `legacyAppBlueprintToDoc` from here and adds
 * the I/O wrapper.
 */

import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import {
	asUuid,
	type BlueprintDoc,
	blueprintDocSchema,
	type Field,
	type Form,
	type FormLink,
	type Module,
	type Uuid,
} from "@/lib/domain";
import type {
	AppBlueprint,
	BlueprintForm,
	BlueprintModule,
	Question,
} from "@/lib/schemas/blueprint";

// ─── AppBlueprint → BlueprintDoc ────────────────────────────────────────

/**
 * Translate a legacy nested `AppBlueprint` form-link target (which
 * references modules and forms by index) to the normalized uuid-based
 * target shape used by the `FormLink` domain schema.
 *
 * Legacy targets look like:
 *   { type: "form", moduleIndex: 0, formIndex: 1 }
 *   { type: "module", moduleIndex: 2 }
 *
 * Normalized targets look like:
 *   { type: "form", moduleUuid: "<uuid>", formUuid: "<uuid>" }
 *   { type: "module", moduleUuid: "<uuid>" }
 *
 * Unknown target types are cast through as-is; the schema `parse()` at
 * the end of `legacyAppBlueprintToDoc` will surface any invalid shape.
 */
function migrateFormLinkTarget(
	legacyTarget: Record<string, unknown>,
	moduleOrder: Uuid[],
	formOrder: Record<Uuid, Uuid[]>,
): FormLink["target"] {
	if (legacyTarget.type === "module") {
		const idx = legacyTarget.moduleIndex as number;
		return { type: "module", moduleUuid: moduleOrder[idx] };
	}
	if (legacyTarget.type === "form") {
		const mIdx = legacyTarget.moduleIndex as number;
		const fIdx = legacyTarget.formIndex as number;
		const moduleUuid = moduleOrder[mIdx];
		const formUuid = formOrder[moduleUuid]?.[fIdx];
		return { type: "form", moduleUuid, formUuid };
	}
	return legacyTarget as FormLink["target"];
}

/**
 * Convert a legacy nested `AppBlueprint` (or its Firestore blob) into a
 * normalized `BlueprintDoc`. Pure function — no I/O.
 *
 * Every field in the output passes through `blueprintDocSchema.parse`
 * at the end so callers get a type guarantee: a returned doc is valid
 * per the domain schema, including the post-rename field names.
 *
 * Missing uuids on modules / forms / questions are minted with
 * `crypto.randomUUID()` — matches the behavior of the original migration
 * script. Optional fields that are absent in the input are omitted from
 * the output (never written as explicit `undefined`), matching Firestore's
 * no-undefined rule.
 *
 * @param appId - The Firestore document ID, assigned to the doc's `appId`.
 * @param legacy - Raw Firestore doc data in the old AppBlueprint shape.
 */
export function legacyAppBlueprintToDoc(
	appId: string,
	legacy: unknown,
): BlueprintDoc {
	// Loose-typed input; the final `blueprintDocSchema.parse` enforces the
	// contract of the returned doc.
	const src = legacy as Record<string, unknown>;

	const modules: BlueprintDoc["modules"] = {};
	const forms: BlueprintDoc["forms"] = {};
	const fields: BlueprintDoc["fields"] = {};
	const moduleOrder: Uuid[] = [];
	const formOrder: Record<Uuid, Uuid[]> = {};
	const fieldOrder: Record<Uuid, Uuid[]> = {};

	const legacyModules = (src.modules ?? []) as Record<string, unknown>[];

	// First pass: mint every module + form uuid so the second pass can
	// resolve form_link index targets to uuid targets without lookaheads.
	for (const mod of legacyModules) {
		const moduleUuid = asUuid(
			(mod.uuid as string | undefined) ?? crypto.randomUUID(),
		);
		moduleOrder.push(moduleUuid);
		formOrder[moduleUuid] = [];

		const legacyForms = (mod.forms ?? []) as Record<string, unknown>[];
		for (const form of legacyForms) {
			const formUuid = asUuid(
				(form.uuid as string | undefined) ?? crypto.randomUUID(),
			);
			formOrder[moduleUuid].push(formUuid);
		}
	}

	// Second pass: build entity tables using the now-complete order maps.
	for (let mIdx = 0; mIdx < legacyModules.length; mIdx++) {
		const mod = legacyModules[mIdx];
		const moduleUuid = moduleOrder[mIdx];

		// Modules carry a separate semantic id slug. Legacy docs predating
		// that field derive it from the display name.
		const moduleId =
			(mod.id as string | undefined) ??
			(mod.name as string).toLowerCase().replace(/\s+/g, "_");

		modules[moduleUuid] = {
			uuid: moduleUuid,
			id: moduleId,
			name: mod.name as string,
			...(mod.case_type != null && { caseType: mod.case_type as string }),
			...(mod.case_list_only != null && {
				caseListOnly: mod.case_list_only as boolean,
			}),
			...(mod.purpose != null && { purpose: mod.purpose as string }),
			...(mod.case_list_columns != null && {
				caseListColumns: mod.case_list_columns as Module["caseListColumns"],
			}),
			...(mod.case_detail_columns != null && {
				caseDetailColumns:
					mod.case_detail_columns as Module["caseDetailColumns"],
			}),
		};

		const legacyForms = (mod.forms ?? []) as Record<string, unknown>[];

		for (let fIdx = 0; fIdx < legacyForms.length; fIdx++) {
			const form = legacyForms[fIdx];
			const formUuid = formOrder[moduleUuid][fIdx];

			const formId =
				(form.id as string | undefined) ??
				(form.name as string).toLowerCase().replace(/\s+/g, "_");

			// close_condition: wire format uses `question`, domain uses `field`.
			let closeCondition: Form["closeCondition"];
			const legacyCc = form.close_condition as
				| Record<string, unknown>
				| undefined;
			if (legacyCc) {
				closeCondition = {
					field: legacyCc.question as string,
					answer: legacyCc.answer as string,
					...(legacyCc.operator != null && {
						operator: legacyCc.operator as "=" | "selected",
					}),
				};
			}

			// form_links: index-based targets → uuid-based targets.
			const legacyLinks = form.form_links as
				| Array<Record<string, unknown>>
				| undefined;
			const formLinks: FormLink[] | undefined = legacyLinks?.map((link) => ({
				...(link.condition != null && { condition: link.condition as string }),
				target: migrateFormLinkTarget(
					link.target as Record<string, unknown>,
					moduleOrder,
					formOrder,
				),
				...(link.datums != null && {
					datums: link.datums as FormLink["datums"],
				}),
			}));

			forms[formUuid] = {
				uuid: formUuid,
				id: formId,
				name: form.name as string,
				type: form.type as Form["type"],
				...(form.purpose != null && { purpose: form.purpose as string }),
				...(closeCondition !== undefined && { closeCondition }),
				...(form.connect != null && {
					connect: form.connect as Form["connect"],
				}),
				...(form.post_submit != null && {
					postSubmit: form.post_submit as Form["postSubmit"],
				}),
				...(formLinks != null && { formLinks }),
			};

			fieldOrder[formUuid] = [];

			// Recursive walker: visits every question in the form tree and
			// installs it into the normalized `fields` map under its parent's
			// `fieldOrder` entry. The domain `kind` discriminant maps 1:1 from
			// the legacy `type` discriminant. `case_property_on` (wire) →
			// `case_property` (domain). Zod strips keys that don't belong on
			// the matched kind at the final `parse()` step.
			function walk(questions: Record<string, unknown>[], parentUuid: Uuid) {
				for (const q of questions) {
					const fieldUuid = asUuid(
						(q.uuid as string | undefined) ?? crypto.randomUUID(),
					);
					fieldOrder[parentUuid].push(fieldUuid);

					const fieldObj: Record<string, unknown> = {
						kind: q.type,
						uuid: fieldUuid,
						id: q.id,
						label: q.label ?? "",
						...(q.case_property_on != null && {
							case_property: q.case_property_on,
						}),
						...(q.hint != null && { hint: q.hint }),
						...(q.required != null && { required: q.required }),
						...(q.relevant != null && { relevant: q.relevant }),
						...(q.validate != null && { validate: q.validate }),
						// Legacy wire `validation` → domain `validate` (alias
						// kept for fixtures predating the rename).
						...(q.validation != null && { validate: q.validation }),
						...(q.validation_msg != null && {
							validate_msg: q.validation_msg,
						}),
						...(q.calculate != null && { calculate: q.calculate }),
						...(q.default_value != null && { default_value: q.default_value }),
						...(q.options != null && { options: q.options }),
					};

					fields[fieldUuid] = fieldObj as Field;

					const children = q.children as Record<string, unknown>[] | undefined;
					if (children?.length && (q.type === "group" || q.type === "repeat")) {
						fieldOrder[fieldUuid] = [];
						walk(children, fieldUuid);
					}
				}
			}

			const legacyQuestions = (form.questions ?? []) as Record<
				string,
				unknown
			>[];
			walk(legacyQuestions, formUuid);
		}
	}

	// Build the persistable shape (no `fieldParent` — that field is derived
	// and not part of the schema).
	const persistableInput = {
		appId,
		appName: src.app_name as string,
		connectType: (src.connect_type as BlueprintDoc["connectType"]) ?? null,
		caseTypes: (src.case_types as BlueprintDoc["caseTypes"]) ?? null,
		modules,
		forms,
		fields,
		moduleOrder,
		formOrder,
		fieldOrder,
	};

	// Parse — and USE the parsed output. The walker above sprays `label: ""`
	// onto every field regardless of kind; Zod's default strip mode drops
	// keys that don't belong on the matched variant (e.g. `label` on a
	// `hidden` field). Discarding the parsed output would let those stray
	// keys reach Firestore. Throws on invalid shape — no silent skip.
	const persistable = blueprintDocSchema.parse(persistableInput);

	// Assemble the in-memory doc with an empty fieldParent, then populate
	// it in place so callers can read the reverse-parent index immediately.
	const doc: BlueprintDoc = {
		...persistable,
		fieldParent: {} as Record<Uuid, Uuid | null>,
	};
	rebuildFieldParent(doc);
	return doc;
}

// ─── BlueprintDoc → AppBlueprint ────────────────────────────────────────

/**
 * Re-emit a normalized `BlueprintDoc` in the nested `AppBlueprint` wire
 * format. The SA agent uses this to translate its internal doc state
 * back to the shape consumed by:
 *
 *   - stream events (`data-form-updated`, `data-blueprint-updated`,
 *     `data-done`) — the client-side stream dispatcher then re-normalizes.
 *   - CommCare-adjacent code still operating on `AppBlueprint` (the
 *     compiler, the validator, the HQ expander). These are migrated in
 *     later phases; until then this bridge is how the SA feeds them.
 *
 * Rename rules at the boundary:
 *   - `case_property` (domain) → `case_property_on` (wire)
 *   - `closeCondition.field` (domain) → `close_condition.question` (wire)
 *   - `postSubmit` (domain) → `post_submit` (wire)
 *   - camelCase module / form fields → snake_case
 *   - form_links uuid targets → index targets
 *
 * Output ordering mirrors `moduleOrder` / `formOrder` / `fieldOrder`
 * verbatim — the entity tables are consulted for field values but never
 * for ordering.
 */
export function toBlueprint(doc: BlueprintDoc): AppBlueprint {
	return {
		app_name: doc.appName,
		connect_type: doc.connectType ?? undefined,
		case_types: doc.caseTypes ?? null,
		modules: doc.moduleOrder.map((modUuid) => {
			const mod = doc.modules[modUuid];
			const formUuids = doc.formOrder[modUuid] ?? [];
			return {
				...assembleModule(mod),
				forms: formUuids.map((formUuid) => {
					const form = doc.forms[formUuid];
					return {
						...assembleForm(form, doc),
						questions: assembleQuestions(formUuid, doc),
					};
				}),
			};
		}),
	};
}

/**
 * camelCase module → snake_case `BlueprintModule` (minus nested forms).
 * Omits undefined / null / absent optional fields so the wire-format
 * output matches the schema's `.optional()` semantics (no explicit
 * `undefined` values).
 */
function assembleModule(mod: Module): Omit<BlueprintModule, "forms"> {
	return {
		uuid: mod.uuid,
		name: mod.name,
		...(mod.caseType != null && { case_type: mod.caseType }),
		...(mod.caseListOnly && { case_list_only: mod.caseListOnly }),
		...(mod.caseListColumns && { case_list_columns: mod.caseListColumns }),
		...(mod.caseDetailColumns != null && {
			case_detail_columns: mod.caseDetailColumns,
		}),
	};
}

/**
 * camelCase form → snake_case `BlueprintForm` (minus nested questions).
 *
 * `closeCondition.field` → `close_condition.question` (wire format retains
 * the legacy key name). `formLinks` are re-emitted in the index-based
 * target shape by looking up uuids in the doc's order arrays.
 */
function assembleForm(
	form: Form,
	doc: BlueprintDoc,
): Omit<BlueprintForm, "questions"> {
	return {
		uuid: form.uuid,
		name: form.name,
		type: form.type,
		...(form.closeCondition && {
			close_condition: {
				question: form.closeCondition.field,
				answer: form.closeCondition.answer,
				...(form.closeCondition.operator && {
					operator: form.closeCondition.operator,
				}),
			},
		}),
		...(form.postSubmit && { post_submit: form.postSubmit }),
		...(form.formLinks && {
			form_links: form.formLinks.map((link) => ({
				...(link.condition != null && { condition: link.condition }),
				target: assembleFormLinkTarget(link.target, doc),
				...(link.datums != null && { datums: link.datums }),
			})),
		}),
		...(form.connect && { connect: form.connect }),
	};
}

/**
 * Translate a uuid-based form-link target back to the index-based wire
 * shape. If the target's module or form uuid is missing from the doc
 * (e.g. a dangling link after deletion) the index falls back to `-1`,
 * which downstream validation will flag.
 */
function assembleFormLinkTarget(
	target: FormLink["target"],
	doc: BlueprintDoc,
):
	| { type: "form"; moduleIndex: number; formIndex: number }
	| { type: "module"; moduleIndex: number } {
	if (target.type === "module") {
		const moduleIndex = doc.moduleOrder.indexOf(target.moduleUuid);
		return { type: "module", moduleIndex };
	}
	const moduleIndex = doc.moduleOrder.indexOf(target.moduleUuid);
	const formUuids = doc.formOrder[target.moduleUuid] ?? [];
	const formIndex = formUuids.indexOf(target.formUuid);
	return { type: "form", moduleIndex, formIndex };
}

/**
 * Reassemble a question subtree from the normalized doc, following
 * `fieldOrder[parentUuid]` and recursing into container fields.
 *
 * Domain `kind` → wire `type`. `case_property` → `case_property_on`.
 * `validate` / `validate_msg` stay under those same keys on the wire
 * (matching the domain's preferred names); legacy `validation` is not
 * produced on emit — only accepted on ingest for migration.
 */
function assembleQuestions(parentUuid: Uuid, doc: BlueprintDoc): Question[] {
	const order = doc.fieldOrder[parentUuid] ?? [];
	return order.map((fUuid) => {
		const field = doc.fields[fUuid];
		const anyField = field as Record<string, unknown>;
		const q: Question = {
			uuid: fUuid,
			id: field.id,
			type: field.kind as Question["type"],
			...(typeof anyField.label === "string" && { label: anyField.label }),
			...(typeof anyField.hint === "string" && { hint: anyField.hint }),
			...(typeof anyField.required === "string" && {
				required: anyField.required,
			}),
			// Domain `validate` + `validate_msg` map to wire `validation` +
			// `validation_msg` because the existing wire schema predates the
			// domain rename. Keep the SA + CommCare pipeline happy.
			...(typeof anyField.validate === "string" && {
				validation: anyField.validate,
			}),
			...(typeof anyField.validate_msg === "string" && {
				validation_msg: anyField.validate_msg,
			}),
			...(typeof anyField.relevant === "string" && {
				relevant: anyField.relevant,
			}),
			...(typeof anyField.calculate === "string" && {
				calculate: anyField.calculate,
			}),
			...(typeof anyField.default_value === "string" && {
				default_value: anyField.default_value,
			}),
			...(Array.isArray(anyField.options) && {
				options: anyField.options as Question["options"],
			}),
			...(typeof anyField.case_property === "string" && {
				case_property_on: anyField.case_property,
			}),
		};

		// Container fields carry their children; leaves omit `children`
		// entirely (not even an empty array, to match `processSingleFormOutput`).
		const nested = doc.fieldOrder[fUuid];
		if (nested !== undefined) {
			return { ...q, children: assembleQuestions(fUuid, doc) };
		}
		return q;
	});
}
