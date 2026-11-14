import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	afterEmptySearchRegistrationFormOf,
	type BlueprintDoc,
	moduleHasCaseListMenuItem,
} from "@/lib/domain";
import {
	caseListSessionDatums,
	entrySessionDatums,
	formLinkProjectionContext,
	moduleFrameActionsBuildable,
} from "../../formLinkProjection";
import { lookupWireNaming } from "../../lookup/naming";
import { type ValidationError, validationError } from "../errors";

/** A containing menu may already supply a parent datum. Refuse the exact
 * reuse that would silently substitute another explicitly named selector. */
export function parentSelectionConflicts(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext,
): ValidationError[] {
	const findings = new Map<string, ValidationError>();
	const context = formLinkProjectionContext(doc, {
		lookupNaming:
			lookupContext.kind === "available"
				? lookupWireNaming(lookupContext.definitions)
				: undefined,
		onParentSelectionConflict: (moduleUuid) => {
			findings.set(
				moduleUuid,
				validationError(
					"CASE_PARENT_SELECTION_CONFLICT",
					"module",
					`Module "${doc.modules[moduleUuid].name}" would reuse a parent selected in its containing menu instead of its chosen parent module. Choose the containing module as this parent selector, or move this module out of that submenu.`,
					{ moduleUuid, moduleName: doc.modules[moduleUuid].name },
				),
			);
		},
	});
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (
			!module?.parentCaseModuleUuid ||
			!module.parentModuleUuid ||
			!moduleFrameActionsBuildable(doc, [moduleUuid])
		)
			continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? [])
			entrySessionDatums(doc, context, moduleUuid, formUuid);
		if (moduleHasCaseListMenuItem(module))
			caseListSessionDatums(doc, context, moduleUuid);
	}
	return [...findings.values()];
}

/**
 * A form of a nested menu that creates a case of the type its root menu's
 * first form opens a chosen case of. HQ aligns the form's entry with that
 * first form's (`suite_xml/sections/entries.py::EntriesHelper.add_parent_datums`)
 * and matches the new case's `uuid()` datum to the root's selection by case
 * type alone (`_same_case`), so the entry names the new case by the root's
 * selection id: CommCare asks for a case before the form, never runs the
 * `uuid()`, and the form's case block reads a `case_id_new_<type>_<i>` the
 * session never holds, so the form cannot open on CommCare HQ's build.
 */
export function rootSelectionTakesNewCase(
	doc: BlueprintDoc,
	lookupContext: LookupValidationContext,
): ValidationError[] {
	const findings = new Map<string, ValidationError>();
	const context = formLinkProjectionContext(doc, {
		lookupNaming:
			lookupContext.kind === "available"
				? lookupWireNaming(lookupContext.definitions)
				: undefined,
		onRootSelectionTakesNewCase: (issue) => {
			const module = doc.modules[issue.moduleUuid];
			const form = doc.forms[issue.formUuid];
			const root = doc.modules[issue.rootModuleUuid];
			const rootForm = doc.forms[issue.rootFormUuid];
			if (!module || !form || !root || !rootForm) return;
			findings.set(
				issue.formUuid,
				validationError(
					"NESTED_MENU_NEW_CASE_TAKES_ROOT_CASE",
					"form",
					`"${form.name}" in "${module.name}" creates a new "${issue.caseType}" case, and "${module.name}" is under "${root.name}", whose first form "${rootForm.name}" opens a chosen "${issue.caseType}" case. CommCare HQ gives the new case that chosen case's place in the form's session, so "${form.name}" can't open there. You can move "${form.name}" to a menu that isn't under "${root.name}", or put a form first in "${root.name}" that doesn't open a chosen "${issue.caseType}" case.`,
					{
						moduleUuid: issue.moduleUuid,
						moduleName: module.name,
						formUuid: issue.formUuid,
						formName: form.name,
					},
					{
						caseType: issue.caseType,
						rootModuleUuid: issue.rootModuleUuid,
						rootModuleName: root.name,
						rootFormUuid: issue.rootFormUuid,
						rootFormName: rootForm.name,
					},
				),
			);
		},
	});
	for (const moduleUuid of doc.moduleOrder) {
		if (
			!doc.modules[moduleUuid]?.parentModuleUuid ||
			!moduleFrameActionsBuildable(doc, [moduleUuid])
		)
			continue;
		// A registration offered after an empty search is emitted in a menu of
		// its own, under no root (`emissionPlan.ts`).
		const offered = afterEmptySearchRegistrationFormOf(doc, moduleUuid);
		for (const formUuid of doc.formOrder[moduleUuid] ?? [])
			if (formUuid !== offered)
				entrySessionDatums(doc, context, moduleUuid, formUuid);
	}
	return [...findings.values()];
}
