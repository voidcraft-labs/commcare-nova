import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
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
					{ moduleUuid },
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
		if (module.caseListOnly) caseListSessionDatums(doc, context, moduleUuid);
	}
	return [...findings.values()];
}
