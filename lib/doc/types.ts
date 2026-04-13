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
	BlueprintForm,
	BlueprintModule,
	CaseType,
	ConnectType,
	Question,
} from "@/lib/schemas/blueprint";

/**
 * A module as stored in the normalized doc.
 *
 * Derived from `BlueprintModule` by dropping the `forms` array (forms are
 * looked up via `BlueprintDoc.formOrder[moduleUuid]` → `BlueprintDoc.forms`)
 * and adding a required stable `uuid`. The on-disk `BlueprintModule` schema
 * does not carry a UUID — Phase 1's blueprint→doc converter assigns one at
 * load time and persists it in Firestore going forward.
 */
export type ModuleEntity = Omit<BlueprintModule, "forms"> & { uuid: Uuid };

/**
 * A form as stored in the normalized doc.
 *
 * Same pattern as `ModuleEntity`: drops the nested `questions` array, adds a
 * `uuid`. Questions are looked up via `questionOrder[formUuid]`.
 */
export type FormEntity = Omit<BlueprintForm, "questions"> & { uuid: Uuid };

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
