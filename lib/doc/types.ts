// lib/doc/types.ts
//
// Thin re-export shim that forwards the normalized blueprint types from
// `@/lib/domain` and defines the doc-layer `Mutation` union. New code
// should import the entity types (`Field`, `Form`, `Module`, `BlueprintDoc`)
// directly from `@/lib/domain`; the `*Entity` aliases exported here exist
// only for legacy call sites inside this package that are not yet renamed.

export type {
	BlueprintDoc,
	Field as QuestionEntity,
	Form as FormEntity,
	Module as ModuleEntity,
	Uuid,
} from "@/lib/domain";
export { asUuid } from "@/lib/domain";

import type {
	CaseType,
	ConnectType,
	Field,
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
	| {
			kind: "replaceForm";
			uuid: Uuid;
			form: Form;
			fields: Field[];
			fieldOrder: Record<Uuid, Uuid[]>;
	  }
	// Field
	| { kind: "addField"; parentUuid: Uuid; field: Field; index?: number }
	| { kind: "removeField"; uuid: Uuid }
	| { kind: "moveField"; uuid: Uuid; toParentUuid: Uuid; toIndex: number }
	| { kind: "renameField"; uuid: Uuid; newId: string }
	| { kind: "duplicateField"; uuid: Uuid }
	| { kind: "updateField"; uuid: Uuid; patch: FieldPatch }
	// App-level
	| { kind: "setAppName"; name: string }
	| { kind: "setConnectType"; connectType: ConnectType | null }
	| { kind: "setCaseTypes"; caseTypes: CaseType[] | null };
