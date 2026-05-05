// lib/case-store/form-bridge/__tests__/fixtures.ts
//
// Shared test fixtures for the form-bridge test suite. Both
// `deriveFromForm.test.ts` (pure-function unit tests) and
// `writeThrough.test.ts` (integration tests against testcontainers
// Postgres) build a single-form `BlueprintDoc` from a nested field-
// tree fixture; the shape pattern mirrors
// `lib/preview/engine/__tests__/formEngine.test.ts` so future
// maintainers can cross-reference fixture conventions.
//
// The `appId` argument lets each test file pin its own value (the
// pure tests use a generic placeholder; the integration tests use
// a per-suite-unique value so leaked rows surface against the right
// app namespace if the per-test database isolation ever regresses).

import type {
	BlueprintDoc,
	CaseType,
	Field,
	FieldKind,
	Form,
	FormType,
	Uuid,
} from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import type { CompletedForm } from "../deriveFromForm";

// ---------------------------------------------------------------
// Shared identifiers
// ---------------------------------------------------------------

/** The form uuid every fixture pins. Stable across both test files. */
export const FORM_UUID = asUuid("test-form-uuid");

/** The owning module uuid every fixture pins. */
export const MODULE_UUID = asUuid("test-module-uuid");

// ---------------------------------------------------------------
// Field-tree fixture shape
// ---------------------------------------------------------------

/**
 * Convenience type for the nested test-fixture tree. The blueprint
 * stores fields as a flat map plus a `fieldOrder` adjacency; this
 * shape lets test bodies declare nested structure inline and the
 * builder flattens it. Containers (`group`, `repeat`) carry a
 * `children` slot; leaf fields don't.
 */
export interface DField {
	id: string;
	kind: FieldKind;
	label?: string;
	required?: string;
	relevant?: string;
	calculate?: string;
	default_value?: string;
	case_property_on?: string;
	options?: Array<{ value: string; label: string }>;
	children?: DField[];
}

/**
 * Configuration for `buildBlueprint`. `appId` is parameterized so
 * test files (unit vs integration) can pin their own value;
 * everything else flows from the field tree.
 */
export interface BuildBlueprintArgs {
	appId: string;
	formType: FormType;
	moduleCaseType?: string;
	caseTypes: ReadonlyArray<CaseType>;
	fields: ReadonlyArray<DField>;
}

/**
 * Result of a fixture-build. The form uuid + form type travel with
 * the blueprint so test bodies don't have to re-resolve them.
 */
export interface BuiltBlueprint {
	blueprint: BlueprintDoc;
	formUuid: Uuid;
	formType: FormType;
}

// ---------------------------------------------------------------
// Builders
// ---------------------------------------------------------------

/**
 * Build a single-form `BlueprintDoc` from a nested field-tree
 * fixture. The form, module, and field maps fill from the supplied
 * shape; uuid generation is deterministic per position path so
 * fixture changes produce stable diffs in failure messages.
 */
export function buildBlueprint(args: BuildBlueprintArgs): BuiltBlueprint {
	const form: Form = {
		uuid: FORM_UUID,
		id: "test-form",
		name: "Test Form",
		type: args.formType,
	};
	const fields: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = {};
	const fieldParent: Record<string, Uuid | null> = {};

	const walk = (nodes: ReadonlyArray<DField>, parentUuid: Uuid): Uuid[] => {
		const order: Uuid[] = [];
		for (const node of nodes) {
			// Position-derived uuid: `<parentUuid>.<id>` — stable,
			// readable in failure messages, no clock dependency.
			const uuid = asUuid(`${parentUuid}.${node.id}`);
			order.push(uuid);
			fieldParent[uuid] = parentUuid;
			const { children, ...rest } = node;
			fields[uuid] = { uuid, ...rest } as Field;
			if (node.kind === "group" || node.kind === "repeat") {
				fieldOrder[uuid] = walk(children ?? [], uuid);
			}
		}
		return order;
	};

	fieldOrder[FORM_UUID] = walk(args.fields, FORM_UUID);

	return {
		blueprint: {
			appId: args.appId,
			appName: "test-app",
			connectType: null,
			caseTypes: [...args.caseTypes],
			modules: {
				[MODULE_UUID]: {
					uuid: MODULE_UUID,
					id: "test-module",
					name: "Test Module",
					...(args.moduleCaseType !== undefined
						? { caseType: args.moduleCaseType }
						: {}),
				},
			},
			forms: { [FORM_UUID]: form },
			fields,
			moduleOrder: [MODULE_UUID],
			formOrder: { [MODULE_UUID]: [FORM_UUID] },
			fieldOrder,
			fieldParent,
		},
		formUuid: FORM_UUID,
		formType: args.formType,
	};
}

/**
 * Build a `CompletedForm` snapshot from path → value pairs. The
 * shape matches `FormEngine.getValueSnapshot().values` (a
 * `Map<XFormPath, string>`); the optional `caseId` carries the
 * bound case for followup / close forms.
 */
export function completed(
	values: ReadonlyArray<[string, string]>,
	caseId?: string,
): CompletedForm {
	return {
		values: new Map(values),
		...(caseId !== undefined ? { caseId } : {}),
	};
}

// ---------------------------------------------------------------
// Reusable case-type definitions
// ---------------------------------------------------------------

/**
 * A patient case-type covering the most common `data_type` arms
 * (text / int / decimal / date / multi_select). Used as the
 * primary case-type fixture in both test files.
 */
export const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight", label: "Weight (kg)", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{
			name: "tags",
			label: "Tags",
			data_type: "multi_select",
			options: [
				{ value: "urgent", label: "Urgent" },
				{ value: "stable", label: "Stable" },
			],
		},
	],
};

/**
 * A child case-type with `parent_type: "patient"` so registration
 * fixtures can exercise the child-case insert path. Two simple
 * text properties keep the assertion targets stable.
 */
export const VISIT_CASE_TYPE: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [
		{ name: "case_name", label: "Visit", data_type: "text" },
		{ name: "notes", label: "Notes", data_type: "text" },
	],
};
