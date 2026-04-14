/**
 * Pure mutation mapper for generation stream events.
 *
 * Translates server-sent stream events into doc-layer `Mutation[]` arrays
 * that can be applied to a `BlueprintDoc` via `store.apply()` or
 * `store.applyMany()`. No side effects, no store references, no signal
 * grid — the caller is responsible for dispatching the returned mutations.
 *
 * This is the Phase 4 extraction of the entity-mutation logic that was
 * previously interleaved with session/progress state inside the legacy
 * builder store's generation setters (`setSchema`, `setScaffold`,
 * `setModuleContent`, `setFormContent`).
 */

import { flattenQuestions } from "@/lib/doc/converter";
import type {
	BlueprintDoc,
	FormEntity,
	Mutation,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type {
	BlueprintForm,
	CaseType,
	FormType,
	Scaffold,
} from "@/lib/schemas/blueprint";
import type { CaseColumn } from "@/lib/services/normalizedState";
import { decomposeFormEntity } from "@/lib/services/normalizedState";

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
	const caseTypes = data.caseTypes as CaseType[];
	return [{ kind: "setCaseTypes", caseTypes }];
}

/**
 * `data-scaffold` — creates the app skeleton: name, optional connect
 * type, module shells, and empty form shells.
 *
 * Each module and form gets a freshly minted crypto UUID. Form mutations
 * reference their parent module's UUID so the doc reducer can wire up
 * the `formOrder` relationship.
 *
 * Ported from `scaffoldToMutations` in `lib/services/builderStore.ts`.
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

	/* Module + form shells */
	for (const sm of scaffold.modules) {
		const moduleUuid = asUuid(crypto.randomUUID());
		mutations.push({
			kind: "addModule",
			module: {
				uuid: moduleUuid,
				name: sm.name,
				caseType: sm.case_type ?? undefined,
				caseListOnly: sm.case_list_only ?? undefined,
				purpose: sm.purpose ?? undefined,
				caseListColumns: undefined,
				caseDetailColumns: undefined,
			},
		});

		for (const sf of sm.forms) {
			const formUuid = asUuid(crypto.randomUUID());
			mutations.push({
				kind: "addForm",
				moduleUuid,
				form: {
					uuid: formUuid,
					name: sf.name,
					type: sf.type as FormType,
					purpose: sf.purpose ?? undefined,
					closeCondition: undefined,
					connect: undefined,
					postSubmit: sf.post_submit ?? undefined,
					formLinks: undefined,
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
	const caseListColumns = data.caseListColumns as CaseColumn[] | null;

	const moduleUuid = doc.moduleOrder[moduleIndex];
	if (!moduleUuid) return [];

	return [
		{
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {
				caseListColumns: caseListColumns ?? undefined,
			},
		},
	];
}

/**
 * `data-form-done` / `data-form-fixed` / `data-form-updated` — replaces
 * an entire form's content with the SA's generated/fixed/updated output.
 *
 * The incoming `BlueprintForm` is decomposed into a flat `FormEntity` +
 * flattened questions, matching the doc's normalized shape. The form's
 * existing `purpose` (set during scaffold) is preserved because the
 * wire-format `BlueprintForm` doesn't carry purpose.
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

	/*
	 * Stamp the doc's form UUID onto the incoming form before decomposing.
	 * `decomposeFormEntity` reads `form.uuid` verbatim — we need it to
	 * match the doc's existing UUID, not whatever the SA sent.
	 */
	const formWithUuid: BlueprintForm = { ...form, uuid: formUuid };
	const nForm = decomposeFormEntity(formWithUuid);

	/*
	 * Preserve the scaffold-set purpose. BlueprintForm doesn't carry purpose,
	 * so the freshly decomposed entity always has `purpose: undefined`. The
	 * existing form in the doc may have a purpose from the scaffold step.
	 */
	const existingForm = doc.forms[formUuid];
	const replacement: FormEntity = {
		...(nForm as unknown as FormEntity),
		purpose: existingForm?.purpose ?? nForm.purpose,
	};

	/*
	 * Flatten the nested question tree into the doc's normalized shape.
	 * `questionOrder` is keyed by parent UUID: top-level questions land
	 * under `formUuid`; nested group/repeat children land under their
	 * parent question UUID (handled recursively by flattenQuestions).
	 */
	const questionsMap: Record<Uuid, QuestionEntity> = {};
	const questionOrder: Record<Uuid, Uuid[]> = {};
	questionOrder[formUuid] = flattenQuestions(
		form.questions ?? [],
		questionsMap,
		questionOrder,
	);
	const questions = Object.values(questionsMap);

	return [
		{
			kind: "replaceForm",
			uuid: formUuid,
			form: replacement,
			questions,
			questionOrder,
		},
	];
}
