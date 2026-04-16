// lib/doc/types.ts
//
// DEPRECATED: this file is a re-export shim from the domain layer for
// Phase 1's in-flight migration. Consumers should import from
// `@/lib/domain` directly. Phase 7 deletes this file.

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
	Form,
	Module,
	Uuid,
} from "@/lib/domain";

// ─── Mutation union ────────────────────────────────────────────────────
//
// Identical to the current Mutation union but with question→field renamed
// throughout. `replaceForm` retains its `questionOrder` key for Phase 1
// backward-compat; Phase 2 kills replaceForm entirely.

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
			fields: Field[]; // renamed from `questions`
			fieldOrder: Record<Uuid, Uuid[]>; // renamed from `questionOrder`
	  }
	// Field
	| { kind: "addField"; parentUuid: Uuid; field: Field; index?: number }
	| { kind: "removeField"; uuid: Uuid }
	| { kind: "moveField"; uuid: Uuid; toParentUuid: Uuid; toIndex: number }
	| { kind: "renameField"; uuid: Uuid; newId: string }
	| { kind: "duplicateField"; uuid: Uuid }
	| { kind: "updateField"; uuid: Uuid; patch: Partial<Omit<Field, "uuid">> }
	// App-level
	| { kind: "setAppName"; name: string }
	| { kind: "setConnectType"; connectType: ConnectType | null }
	| { kind: "setCaseTypes"; caseTypes: CaseType[] | null };
