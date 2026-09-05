/** Exact identity and behavior proof for the final slice's accepted entry points. */
import {
	asUuid,
	type BlueprintDoc,
	type EntryPointTarget,
	entryPointAt,
	entryPointInventory,
} from "@/lib/domain";
import type { ModuleHandleBinding } from "./acceptedModulePlacement";
import type {
	EntryPointRealization,
	SliceExecutionBrief,
} from "./executionBrief";

export interface AcceptedEntryPointIssue {
	readonly code: "ACCEPTED_ENTRY_POINT_MISMATCH";
	readonly message: string;
	readonly location: { readonly kind: "module"; readonly moduleUuid: string };
	readonly details: { readonly entryPointId: string };
}

export function realizedEntryPointTarget(
	doc: BlueprintDoc,
	expected: EntryPointRealization,
	handles: readonly ModuleHandleBinding[],
): EntryPointTarget | null {
	const moduleUuid = handles.find(
		(binding) =>
			binding.handle === expected.blueprintModuleHandle &&
			binding.entityKind === "module",
	)?.uuid;
	if (moduleUuid === undefined || doc.modules[moduleUuid] === undefined)
		return null;
	if (expected.kind !== "form")
		return { kind: expected.kind, moduleUuid: asUuid(moduleUuid) };
	const formUuid = handles.find(
		(binding) =>
			binding.handle === expected.blueprintFormHandle &&
			binding.entityKind === "form",
	)?.uuid;
	if (
		formUuid === undefined ||
		!doc.formOrder[moduleUuid]?.includes(asUuid(formUuid)) ||
		doc.forms[formUuid] === undefined
	)
		return null;
	return {
		kind: "form",
		moduleUuid: asUuid(moduleUuid),
		formUuid: asUuid(formUuid),
	};
}

export function acceptedEntryPointIssues(
	doc: BlueprintDoc,
	brief: SliceExecutionBrief,
	handles: readonly ModuleHandleBinding[],
): AcceptedEntryPointIssue[] {
	const expected = brief.entryPointRealizations;
	if (expected === undefined) return [];
	const issues: AcceptedEntryPointIssue[] = [];
	const matched = new Set<string>();
	for (const realization of expected) {
		const target = realizedEntryPointTarget(doc, realization, handles);
		const actual = target === null ? undefined : entryPointAt(doc, target);
		if (actual !== undefined) matched.add(actual.uuid);
		if (
			actual?.id === realization.id &&
			(actual.ignoreDisplayConditions === true) ===
				(realization.ignoreDisplayConditions === true)
		)
			continue;
		issues.push({
			code: "ACCEPTED_ENTRY_POINT_MISMATCH",
			message: `Entry point ${realization.id} must exist on its exact accepted destination with its accepted display-condition behavior. Resolve the brief's module and form handles and apply addEntryPoint or updateEntryPoint after completing navigation.`,
			location: { kind: "module", moduleUuid: target?.moduleUuid ?? "" },
			details: { entryPointId: realization.id },
		});
	}
	for (const { target, entryPoint } of entryPointInventory(doc)) {
		if (matched.has(entryPoint.uuid)) continue;
		issues.push({
			code: "ACCEPTED_ENTRY_POINT_MISMATCH",
			message: `Entry point ${entryPoint.id} was not accepted for this destination. Remove it before finishing.`,
			location: { kind: "module", moduleUuid: target.moduleUuid },
			details: { entryPointId: entryPoint.id },
		});
	}
	return issues;
}
