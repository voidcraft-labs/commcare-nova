/**
 * Builder state re-architecture — domain type definitions.
 *
 * This file is imported by every later phase of the re-architecture:
 *   - Phase 1 uses `BlueprintDoc`, entity types, and the `Mutation` union to
 *     build the normalized Zustand store and its mutation reducer.
 *   - Phase 2 uses `Uuid` as the selection/screen identifier type in the URL.
 *   - Phase 3 uses entity types when dissolving the engine into hooks.
 *   - Phase 4 uses `Mutation` to translate agent events via `toMutations`.
 *   - Phase 5 uses `Uuid` for virtual-list row keys.
 *
 * NOTHING in this file is wired into the running app yet. Phase 0 is inert.
 */

/**
 * Branded UUID type. Prevents accidental mixing with ordinary strings.
 *
 * Branding is a compile-time-only construct — at runtime a Uuid is just a
 * string. Use `asUuid(s)` to cast an existing crypto UUID string into the
 * branded type when entering the doc layer (e.g. when converting a legacy
 * blueprint into the normalized doc shape).
 */
export type Uuid = string & { readonly __brand: "Uuid" };

/** Narrowing cast from `string` to `Uuid`. Prefer this over `as Uuid`. */
export function asUuid(s: string): Uuid {
	return s as Uuid;
}

import type {
	CaseType,
	ConnectConfig,
	ConnectType,
	FormLink,
	FormType,
	PostSubmitDestination,
	Question,
} from "@/lib/schemas/blueprint";
import type { CaseColumn } from "@/lib/services/normalizedState";

/**
 * A module as stored in the normalized doc.
 *
 * Uses camelCase field names to match the legacy `NModule` type in
 * `normalizedState.ts`. The wire-format blueprint schema uses snake_case
 * (`case_type`, `case_list_columns`, etc.); `toDoc` / `toBlueprint` in
 * `converter.ts` handle the conversion at the boundary.
 *
 * The on-disk `BlueprintModule` schema does not carry a UUID — Phase 1's
 * blueprint→doc converter assigns one at load time and persists it in
 * Firestore going forward.
 */
export type ModuleEntity = {
	uuid: Uuid;
	name: string;
	caseType: string | undefined;
	caseListOnly: boolean | undefined;
	purpose: string | undefined;
	caseListColumns: CaseColumn[] | undefined;
	caseDetailColumns: CaseColumn[] | null | undefined;
};

/**
 * A form as stored in the normalized doc.
 *
 * Uses camelCase field names to match the legacy `NForm` type in
 * `normalizedState.ts`. The wire-format blueprint schema uses snake_case
 * (`close_condition`, `post_submit`, `form_links`); `toDoc` / `toBlueprint`
 * in `converter.ts` handle the conversion at the boundary.
 *
 * Questions are looked up via `questionOrder[formUuid]`.
 */
export type FormEntity = {
	uuid: Uuid;
	name: string;
	type: FormType;
	purpose: string | undefined;
	closeCondition:
		| { question: string; answer: string; operator?: "=" | "selected" }
		| undefined;
	connect: ConnectConfig | null | undefined;
	postSubmit: PostSubmitDestination | undefined;
	formLinks: FormLink[] | undefined;
};

/**
 * A question as stored in the normalized doc.
 *
 * The blueprint `Question` already carries a `uuid: string`; we narrow that
 * to the branded `Uuid` type. Children are represented by
 * `questionOrder[questionUuid]` (when the question is a group/repeat) rather
 * than an inline `children: Question[]` array.
 */
export type QuestionEntity = Omit<Question, "uuid" | "children"> & {
	uuid: Uuid;
};

/**
 * The normalized builder document. Single source of truth for the domain.
 *
 * Shape rationale:
 *   - Entity tables (`modules`, `forms`, `questions`) are keyed by `Uuid` so
 *     hooks can subscribe to a single entity's slot without rendering when
 *     siblings change. Immer's structural sharing keeps unchanged entity
 *     references stable across mutations.
 *   - Ordering maps (`*Order`) are the only place hierarchy is expressed.
 *     Reordering a module doesn't touch the module entity itself — only the
 *     `moduleOrder` array — so entity-level subscribers don't re-render.
 *   - `questionOrder` is keyed by either a form uuid (top-level questions)
 *     or a group/repeat question uuid (nested children). Same map, two
 *     logical uses.
 *
 * Phase 1 builds the Zustand store, loader, and mutation reducer around this
 * shape. `connectType` and `caseTypes` are nullable to mirror the current
 * blueprint schema where surveys/empty apps can omit them.
 */
export type BlueprintDoc = {
	appId: string;
	appName: string;
	connectType: ConnectType | null;
	caseTypes: CaseType[] | null;

	modules: Record<Uuid, ModuleEntity>;
	forms: Record<Uuid, FormEntity>;
	questions: Record<Uuid, QuestionEntity>;

	moduleOrder: Uuid[];
	formOrder: Record<Uuid /* moduleUuid */, Uuid[]>;
	questionOrder: Record<Uuid /* formUuid | groupUuid */, Uuid[]>;
};

/**
 * Every way the document can change, as a discriminated union.
 *
 * Design notes:
 *   - `kind` names follow the mutation-action method names on the store
 *     (e.g. `addQuestion` → `{ kind: "addQuestion", ... }`). Phase 1 defines
 *     the reducer that switches on `kind`.
 *   - Every payload uses `Uuid` for identity — no paths, no indices. Phase 1
 *     will expose thin `qpath → uuid` adapters for callers that haven't been
 *     migrated yet.
 *   - `replaceForm` carries its own questions + questionOrder because
 *     wholesale form replacement (an LLM tool today) needs to atomically
 *     swap the form's entire subtree.
 *   - `duplicateQuestion` takes no payload other than the source uuid; the
 *     reducer generates a new uuid, deep-clones children, and deduplicates
 *     ids as needed.
 *   - App-level mutations (`setAppName`, etc.) are separate entries rather
 *     than a single "update app" patch because each has distinct undo
 *     semantics.
 */
export type Mutation =
	// Module mutations
	| { kind: "addModule"; module: ModuleEntity; index?: number }
	| { kind: "removeModule"; uuid: Uuid }
	| { kind: "moveModule"; uuid: Uuid; toIndex: number }
	| { kind: "renameModule"; uuid: Uuid; newId: string }
	| {
			kind: "updateModule";
			uuid: Uuid;
			patch: Partial<Omit<ModuleEntity, "uuid">>;
	  }
	// Form mutations
	| { kind: "addForm"; moduleUuid: Uuid; form: FormEntity; index?: number }
	| { kind: "removeForm"; uuid: Uuid }
	| { kind: "moveForm"; uuid: Uuid; toModuleUuid: Uuid; toIndex: number }
	| { kind: "renameForm"; uuid: Uuid; newId: string }
	| { kind: "updateForm"; uuid: Uuid; patch: Partial<Omit<FormEntity, "uuid">> }
	| {
			kind: "replaceForm";
			uuid: Uuid;
			form: FormEntity;
			questions: QuestionEntity[];
			/**
			 * The complete ordering map for the replacement subtree. Keys are
			 * parent UUIDs: the form's own `uuid` for top-level questions, and
			 * each group/repeat question's `uuid` for its nested children.
			 * Shape matches `BlueprintDoc.questionOrder`, so Phase 1's reducer
			 * can splice these entries directly into the doc without having
			 * to infer nested ordering from the flat `questions` array.
			 */
			questionOrder: Record<Uuid, Uuid[]>;
	  }
	// Question mutations
	| {
			kind: "addQuestion";
			parentUuid: Uuid;
			question: QuestionEntity;
			index?: number;
	  }
	| { kind: "removeQuestion"; uuid: Uuid }
	| { kind: "moveQuestion"; uuid: Uuid; toParentUuid: Uuid; toIndex: number }
	| { kind: "renameQuestion"; uuid: Uuid; newId: string }
	| { kind: "duplicateQuestion"; uuid: Uuid }
	| {
			kind: "updateQuestion";
			uuid: Uuid;
			patch: Partial<Omit<QuestionEntity, "uuid">>;
	  }
	// App-level mutations
	| { kind: "setAppName"; name: string }
	| { kind: "setConnectType"; connectType: ConnectType | null }
	| { kind: "setCaseTypes"; caseTypes: CaseType[] | null };
