// lib/doc/types.ts
//
// Defines the doc-layer `Mutation` union and re-exports the handful of
// doc-adjacent types that the mutation reducers + hooks need. Components
// and application code import entity types (`Field`, `Form`, `Module`,
// `BlueprintDoc`) directly from `@/lib/domain`; this file exists only
// because `Mutation` cites domain types in the mutation payload shapes,
// and it's conventional for reducers to live in the same directory as
// the types they consume.

export type { BlueprintDoc, Uuid } from "@/lib/domain";
export { asUuid } from "@/lib/domain";

import type {
	CaseType,
	ConnectType,
	Field,
	FieldKind,
	FieldPatch,
	Form,
	Module,
	Uuid,
} from "@/lib/domain";

// ─── Mutation union ────────────────────────────────────────────────────
//
// Every way the doc store can change. Each reducer in `./mutations/*` is
// an exhaustive switch over a subset of these kinds.

export type Mutation =
	// Module
	| { kind: "addModule"; module: Module; index?: number }
	| { kind: "removeModule"; uuid: Uuid }
	| { kind: "moveModule"; uuid: Uuid; toIndex: number }
	| { kind: "renameModule"; uuid: Uuid; newId: string }
	| { kind: "updateModule"; uuid: Uuid; patch: Partial<Omit<Module, "uuid">> }
	// Form
	| { kind: "addForm"; moduleUuid: Uuid; form: Form; index?: number }
	| { kind: "removeForm"; uuid: Uuid }
	| { kind: "moveForm"; uuid: Uuid; toModuleUuid: Uuid; toIndex: number }
	| { kind: "renameForm"; uuid: Uuid; newId: string }
	| { kind: "updateForm"; uuid: Uuid; patch: Partial<Omit<Form, "uuid">> }
	// Field
	| { kind: "addField"; parentUuid: Uuid; field: Field; index?: number }
	| { kind: "removeField"; uuid: Uuid }
	| { kind: "moveField"; uuid: Uuid; toParentUuid: Uuid; toIndex: number }
	| { kind: "renameField"; uuid: Uuid; newId: string }
	| { kind: "duplicateField"; uuid: Uuid }
	| { kind: "updateField"; uuid: Uuid; patch: FieldPatch }
	| { kind: "convertField"; uuid: Uuid; toKind: FieldKind }
	// App-level
	| { kind: "setAppName"; name: string }
	| { kind: "setConnectType"; connectType: ConnectType | null }
	| { kind: "setCaseTypes"; caseTypes: CaseType[] | null };

// ─── MutationResult ────────────────────────────────────────────────────
//
// Per-mutation result returned by the reducer.
//
// `applyMany(mutations)` returns `MutationResult[]` — one entry per input
// mutation, same order. Most mutation kinds produce `undefined`; the two
// that surface actionable metadata are:
//   - `renameField`: `FieldRenameMeta` with the XPath-rewrite count
//   - `moveField`: `MoveFieldResult` with cross-level auto-rename info
//
// A flat union (rather than a positionally-typed tuple or a
// generic-per-mutation result) keeps the public API uniform and easy to
// type at call sites. Callers that need metadata destructure by known
// position and narrow via `typeof` / kind check. This shape is final —
// it will not expand to a mapped type when new mutation kinds are added,
// because those kinds return `undefined` and `undefined` already belongs
// to this union.

import type {
	FieldRenameMeta,
	MoveFieldResult,
} from "@/lib/doc/mutations/fields";

export type MutationResult = FieldRenameMeta | MoveFieldResult | undefined;

export type { FieldRenameMeta, MoveFieldResult };
