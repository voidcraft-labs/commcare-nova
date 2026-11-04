/** Registry-driven case-property renames over the one Expression tree. */
import {
	type CaseType,
	type Field,
	FORM_REFERENCE_SLOTS,
	type Form,
	fieldReferenceSlotsFor,
	MODULE_REFERENCE_SLOTS,
	type Module,
	mapCasePropertiesInProse,
	type ProseTemplate,
	readSlotValues,
} from "@/lib/domain";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import {
	type CasePropertyNameResolver,
	mapCasePropertiesInExpression,
} from "@/lib/domain/expression/rewrite";
import { isExpression } from "@/lib/domain/expression/types";

export interface FieldSlotRewriteOps {
	resolveCaseProperty: CasePropertyNameResolver;
	caseTypes: readonly CaseType[];
}
export interface FormSlotRewriteContext extends FieldSlotRewriteOps {
	/** The case type of the form's module: the own arm's case type, which it
	 *  does not store. Absent for a form in a module without one. */
	moduleCaseType?: string;
}

function rewriteExpressions(
	entity: unknown,
	path: string,
	ops: FieldSlotRewriteOps,
): number {
	let changed = 0;
	for (const { value } of readSlotValues(entity, path)) {
		if (isExpression(value))
			changed += mapCasePropertiesInExpression(
				value,
				ops.resolveCaseProperty,
				ops.caseTypes,
			);
	}
	return changed;
}

/** UUID-owned form reads keep their identity; only named property pairs change. */
export function rewriteFieldReferenceSlots(
	field: Field,
	ops: FieldSlotRewriteOps,
): number {
	let changed = 0;
	for (const slot of fieldReferenceSlotsFor(
		field.kind,
		field.kind === "repeat" ? field.repeat_mode : undefined,
	)) {
		switch (slot.kind) {
			case "expression":
				changed += rewriteExpressions(field, slot.path, ops);
				break;
			case "prose":
				for (const { value } of readSlotValues(field, slot.path))
					changed += mapCasePropertiesInProse(
						value as ProseTemplate,
						ops.resolveCaseProperty,
					);
				break;
			case "options-source":
				changed += rewriteExpressions(field, `${slot.path}.filter`, ops);
				if (
					(field.kind === "single_select" || field.kind === "multi_select") &&
					field.optionsSource.kind === "cases"
				) {
					const source = field.optionsSource;
					const next = ops.resolveCaseProperty(
						source.caseType,
						source.labelProperty,
					);
					if (next !== undefined && next !== source.labelProperty) {
						source.labelProperty = next;
						changed++;
					}
				}
				break;
			case "case-property-ref":
			case "case-type-ref":
			case "entity-uuid":
			case "relation-path":
			case "datum-ref":
				break;
			default: {
				const exhaustive: never = slot.kind;
				return exhaustive;
			}
		}
	}
	return changed;
}

export function rewriteFormReferenceSlots(
	form: Form,
	ops: FormSlotRewriteContext,
): number {
	let changed = 0;
	for (const slot of FORM_REFERENCE_SLOTS) {
		if (slot.kind === "expression")
			changed += rewriteExpressions(form, slot.path, ops);
		if (slot.slot === "case_operation_write_property") {
			for (const operation of form.caseOperations ?? []) {
				const operationCaseType =
					operation.action === "own"
						? ops.moduleCaseType
						: (operation.retype ?? operation.caseType);
				for (const write of operation.writes ?? []) {
					// A write keyed through `via` saves to the case its indices
					// reach, so the property it names is that case's.
					const destination = resolveRelationDestination(
						write.via === undefined
							? undefined
							: { kind: "ancestor", via: write.via },
						operationCaseType,
						ops.caseTypes,
					);
					if (!destination.ok) continue;
					const next = ops.resolveCaseProperty(
						destination.caseType,
						write.property,
					);
					if (next !== undefined && next !== write.property) {
						write.property = next;
						changed++;
					}
				}
			}
		}
	}
	return changed;
}

export interface ModuleCaseRefRewrites {
	columnsRewritten: number;
	astRefsRewritten: number;
}

export function rewriteModuleCaseRefs(
	mod: Module,
	resolveCaseProperty: CasePropertyNameResolver,
	caseTypes: readonly CaseType[],
): ModuleCaseRefRewrites {
	const ops = { resolveCaseProperty, caseTypes };
	let columnsRewritten = 0;
	let astRefsRewritten = 0;
	for (const slot of MODULE_REFERENCE_SLOTS) {
		if (slot.kind === "expression")
			astRefsRewritten += rewriteExpressions(mod, slot.path, ops);
		if (slot.kind === "options-source")
			astRefsRewritten += rewriteExpressions(mod, `${slot.path}.filter`, ops);
		if (slot.slot === "case_list_column_field" && mod.caseType !== undefined) {
			for (const column of mod.caseListConfig?.columns ?? []) {
				if (column.kind === "calculated") continue;
				const next = resolveCaseProperty(mod.caseType, column.field);
				if (next !== undefined && next !== column.field) {
					column.field = next;
					columnsRewritten++;
				}
			}
		}
		if (slot.slot === "search_input_property") {
			for (const input of mod.caseListConfig?.searchInputs ?? []) {
				if (input.kind !== "simple") continue;
				const destination = resolveRelationDestination(
					input.via,
					mod.caseType,
					caseTypes,
				);
				if (!destination.ok) continue;
				const next = resolveCaseProperty(destination.caseType, input.property);
				if (next !== undefined && next !== input.property) {
					input.property = next;
					astRefsRewritten++;
				}
			}
		}
	}
	return { columnsRewritten, astRefsRewritten };
}
