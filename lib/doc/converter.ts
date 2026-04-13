/**
 * Blueprint ↔ BlueprintDoc converter.
 *
 * The on-disk blueprint schema (`AppBlueprint` in `lib/schemas/blueprint.ts`)
 * is a nested tree: modules contain forms, forms contain top-level questions,
 * and group/repeat questions contain children. The builder doc (`BlueprintDoc`
 * in `lib/doc/types.ts`) is normalized: three UUID-keyed entity tables plus
 * three order maps that capture hierarchy.
 *
 * `toDoc` is called on initial blueprint load (Phase 1b wires this into the
 * builder route). `toBlueprint` reconstructs the nested form for save, export,
 * and the chat body.
 *
 * Design choices:
 *   - Module and form UUIDs are freshly minted on every load because the
 *     on-disk schema doesn't persist them. Stable identity across sessions
 *     is NOT a promise of this converter — it's a session-scoped normalization.
 *   - Question UUIDs are preserved verbatim from the blueprint; questions
 *     already carry stable UUIDs (assigned at creation by the SA).
 *   - Missing question UUIDs throw — callers must have run `applyDefaults` or
 *     the SA's question-tree builder before handing the blueprint to `toDoc`.
 */

import {
	asUuid,
	type BlueprintDoc,
	type FormEntity,
	type ModuleEntity,
	type QuestionEntity,
	type Uuid,
} from "@/lib/doc/types";
import type { AppBlueprint, Question } from "@/lib/schemas/blueprint";
import {
	assembleFormFields,
	assembleModuleFields,
	decomposeFormEntity,
	decomposeModuleEntity,
} from "@/lib/services/normalizedState";

/**
 * Convert an `AppBlueprint` into a normalized `BlueprintDoc`.
 *
 * @param bp - the blueprint to flatten (as persisted in Firestore)
 * @param appId - the app's document ID, attached to the doc for routing
 */
export function toDoc(bp: AppBlueprint, appId: string): BlueprintDoc {
	const modules: Record<Uuid, ModuleEntity> = {};
	const forms: Record<Uuid, FormEntity> = {};
	const questions: Record<Uuid, QuestionEntity> = {};
	const moduleOrder: Uuid[] = [];
	const formOrder: Record<Uuid, Uuid[]> = {};
	const questionOrder: Record<Uuid, Uuid[]> = {};

	for (const mod of bp.modules) {
		const modUuid = asUuid(crypto.randomUUID());
		moduleOrder.push(modUuid);

		// Reuse the shared snake→camel module decomposer. The result is an
		// NModule (plain `string` uuid); cast to ModuleEntity (branded `Uuid`).
		modules[modUuid] = decomposeModuleEntity(
			mod,
			modUuid,
		) as unknown as ModuleEntity;

		const formUuids: Uuid[] = [];
		for (const form of mod.forms) {
			const formUuid = asUuid(crypto.randomUUID());
			formUuids.push(formUuid);

			// Reuse the shared snake→camel form decomposer (handles
			// close_condition / close_case migration, post_submit, etc.).
			forms[formUuid] = decomposeFormEntity(
				form,
				formUuid,
			) as unknown as FormEntity;

			questionOrder[formUuid] = flattenQuestions(
				form.questions ?? [],
				questions,
				questionOrder,
			);
		}
		formOrder[modUuid] = formUuids;
	}

	return {
		appId,
		appName: bp.app_name,
		connectType: bp.connect_type ?? null,
		caseTypes: bp.case_types ?? null,
		modules,
		forms,
		questions,
		moduleOrder,
		formOrder,
		questionOrder,
	};
}

/**
 * Recursively flatten a question tree into the doc's entity and order maps.
 *
 * Returns the ordered UUID array for the parent (form uuid or group uuid).
 * Populates `questions` and `questionOrder` by side effect — this avoids
 * allocating fresh arrays at each recursion depth.
 */
function flattenQuestions(
	src: Question[],
	questions: Record<Uuid, QuestionEntity>,
	questionOrder: Record<Uuid, Uuid[]>,
): Uuid[] {
	const order: Uuid[] = [];
	for (const q of src) {
		if (!q.uuid) {
			throw new Error(
				`toDoc: question "${q.id}" is missing a uuid — run the applyDefaults pass before calling toDoc`,
			);
		}
		const uuid = asUuid(q.uuid);
		order.push(uuid);
		const { children, uuid: _ignored, ...questionRest } = q;
		questions[uuid] = { ...questionRest, uuid } as QuestionEntity;
		if (children && children.length > 0) {
			questionOrder[uuid] = flattenQuestions(
				children,
				questions,
				questionOrder,
			);
		}
	}
	return order;
}

/**
 * Convert a normalized `BlueprintDoc` back into the nested `AppBlueprint`
 * wire format. The resulting blueprint is suitable for save, export, and
 * chat-body serialization.
 *
 * Output ordering is governed entirely by the doc's `*Order` arrays; the
 * entity tables are consulted for field values but never for ordering.
 *
 * UUID lifecycle:
 *   - Question UUIDs are preserved on output — they appear in the blueprint's
 *     `uuid` fields.
 *   - Module and form UUIDs are NOT serialized to the blueprint; they exist
 *     only for in-session reference. If you `toBlueprint(toDoc(bp))` the
 *     input and output will be identical regardless of the session UUIDs.
 */
export function toBlueprint(doc: BlueprintDoc): AppBlueprint {
	return {
		app_name: doc.appName,
		connect_type: doc.connectType ?? undefined,
		case_types: doc.caseTypes ?? null,
		modules: doc.moduleOrder.map((modUuid) => {
			const mod = doc.modules[modUuid];
			const formUuids = doc.formOrder[modUuid] ?? [];

			// Reuse the shared camel→snake module assembler. Cast through
			// `unknown` because doc entities use branded `Uuid` while the
			// assembler accepts plain-string NModule/NForm.
			return {
				...assembleModuleFields(
					mod as unknown as Parameters<typeof assembleModuleFields>[0],
				),
				forms: formUuids.map((formUuid) => {
					const form = doc.forms[formUuid];
					return {
						...assembleFormFields(
							form as unknown as Parameters<typeof assembleFormFields>[0],
						),
						questions: assembleQuestions(formUuid, doc),
					};
				}),
			};
		}),
	};
}

/**
 * Recursively rebuild the nested question tree for a given parent UUID.
 * Called for each form uuid at the top level, then recursively for each
 * group/repeat's own uuid.
 */
function assembleQuestions(parentUuid: Uuid, doc: BlueprintDoc): Question[] {
	const order = doc.questionOrder[parentUuid] ?? [];
	return order.map((qUuid) => {
		const q = doc.questions[qUuid];
		const nested = doc.questionOrder[qUuid];
		// Group/repeat → emit children. Leaf → omit children entirely (not []).
		return nested !== undefined
			? { ...q, children: assembleQuestions(qUuid, doc) }
			: q;
	});
}
