// lib/doc/hooks/useCaseOperationFacts.ts
//
// The small document facts the case-operation surfaces read without
// needing the whole doc: how many changes a form makes, one change by
// identity, and whether a module hands its forms a case.
//
// Named hooks rather than selectors at the call site — selector-
// accepting store hooks are lib-private — and each one narrow, so a
// settings row showing a count does not re-render on every unrelated
// document edit.

"use client";

import { type CaseOperation, isCaseFirstModule } from "@/lib/domain";
import type { Uuid } from "../types";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** How many case changes this form makes on submission. */
export function useCaseOperationCount(formUuid: Uuid): number {
	return useBlueprintDoc(
		(state) => state.forms[formUuid]?.caseOperations?.length ?? 0,
	);
}

/** One case change by identity, or `undefined` once it is gone. */
export function useCaseOperation(
	formUuid: Uuid | undefined,
	operationUuid: Uuid | undefined,
): CaseOperation | undefined {
	return useBlueprintDoc((state) =>
		formUuid === undefined || operationUuid === undefined
			? undefined
			: state.forms[formUuid]?.caseOperations?.find(
					(candidate) => candidate.uuid === operationUuid,
				),
	);
}

/**
 * Whether this module picks a case before opening its forms — which is
 * exactly when a change may act on "the case this form opened".
 * `isCaseFirstModule` is the same rule the validator applies to the
 * session target, so the picker and the gate cannot disagree.
 */
export function useModuleSelectsCaseFirst(moduleUuid: Uuid): boolean {
	return useBlueprintDoc((state) => {
		const module = state.modules[moduleUuid];
		const formTypes = (state.formOrder[moduleUuid] ?? [])
			.map((uuid) => state.forms[uuid]?.type)
			.filter((type): type is NonNullable<typeof type> => type !== undefined);
		return isCaseFirstModule(formTypes, module?.caseType !== undefined);
	});
}

/** The case type a module hands its forms, if it has one. */
export function useModuleCaseType(moduleUuid: Uuid): string | undefined {
	return useBlueprintDoc((state) => state.modules[moduleUuid]?.caseType);
}
