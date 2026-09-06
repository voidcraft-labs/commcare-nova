// lib/doc/hooks/useCaseOperationFacts.ts
//
// The small document facts the case-operation surfaces read without
// needing the whole doc: how many changes a form makes, one change by
// identity, and whether this exact form opens with a case in hand.
//
// Named hooks rather than selectors at the call site — selector-
// accepting store hooks are lib-private — and each one narrow, so a
// settings row showing a count does not re-render on every unrelated
// document edit.

"use client";

import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
} from "@/lib/domain";
import type { Uuid } from "../types";
import { useBlueprintDoc, useBlueprintDocShallow } from "./useBlueprintDoc";

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
 * Whether this exact form opens with a case in hand. A follow-up or close
 * form always selects its case before its XForm opens; whether every sibling
 * does the same only decides if CommCare hoists that selection ahead of the
 * module's form menu. Keep this on the centralized form-type set used by the
 * validator so mixed registration/follow-up modules remain authorable.
 */
export function useFormHasSessionCase(
	moduleUuid: Uuid,
	formUuid: Uuid,
): boolean {
	return useBlueprintDoc((state) => {
		const module = state.modules[moduleUuid];
		const form = state.forms[formUuid];
		return (
			module?.caseType !== undefined &&
			form !== undefined &&
			(state.formOrder[moduleUuid] ?? []).includes(formUuid) &&
			CASE_LOADING_FORM_TYPES.has(form.type)
		);
	});
}

/** The case type a module hands its forms, if it has one. */
export function useModuleCaseType(moduleUuid: Uuid): string | undefined {
	return useBlueprintDoc((state) => state.modules[moduleUuid]?.caseType);
}

const NO_FIELDS: BlueprintDoc["fields"] = {};
const NO_FIELD_ORDER: BlueprintDoc["fieldOrder"] = {};
const NO_FIELD_PARENT: BlueprintDoc["fieldParent"] = {};

/** UUID label projection needs field and worker identities only while a form
 * exists. The persistent rail's idle call must not subscribe to field edits. */
export function useOperationLabelInputs(formUuid: Uuid | undefined) {
	return useBlueprintDocShallow((state) => {
		const form = formUuid === undefined ? undefined : state.forms[formUuid];
		return {
			form,
			fields: form === undefined ? NO_FIELDS : state.fields,
			fieldOrder: form === undefined ? NO_FIELD_ORDER : state.fieldOrder,
			fieldParent: form === undefined ? NO_FIELD_PARENT : state.fieldParent,
			userProperties: form === undefined ? undefined : state.userProperties,
		};
	});
}
