/**
 * Session reads no menu of the app supplies.
 *
 * A raw expression may read `instance('commcaresession')/session/data/<id>`
 * for any `<id>`, and only the datums the form's entry declares exist there.
 * Core refuses to load a form whose logic reads any other one ("Logic
 * references instance(commcaresession)/session/data/<id> which is not a
 * valid question or value"), so the form never opens on any path. The rule
 * takes the declared ids from `entrySessionDatums`, the projection the
 * compiler writes each `<entry>`'s `<session>` from, so the rule and the
 * emitted entry cannot disagree. The caller hands it the entry plan
 * (`entryMetadataOnly`), whose datums carry the compiled entry's ids without
 * its selectors; a selection datum there is marked `projectionOnlySelection`
 * and is still one the compiled entry writes. It reads each exact `session/data/<id>`
 * step through Nova's XPath grammar (`sessionDataAccessInXPath`). A read of
 * the whole `session/data` container is not an exact read and is left to the
 * fuzz-time binding-resolution oracle. A Predicate holds no raw XPath, so
 * only the registry's XPath slots are read.
 */

import {
	entrySessionDatums,
	type FormLinkProjectionContext,
	moduleFrameActionsBuildableIn,
} from "@/lib/commcare/formLinkProjection";
import {
	type BlueprintDoc,
	FORM_REFERENCE_SLOTS,
	fieldReferenceSlotsFor,
	isXPathExpression,
	projectXPath,
	readSlotValues,
	type Uuid,
	xpathPrintContext,
} from "@/lib/domain";
import { sessionDataAccessInXPath } from "../bindingResolutionOracle";
import { type ValidationError, validationError } from "../errors";

/** Which kind of slot a form-level read sits in; the renderer's sentence
 * follows it. */
export type SessionReadCarrier = "field" | "connect" | "form_link";

/** The carrier a slot of `FORM_REFERENCE_SLOTS` belongs to. */
function formSlotCarrier(slot: string): SessionReadCarrier {
	return slot.startsWith("form_link_") ? "form_link" : "connect";
}

export function sessionDatumNotSupplied(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
	linkContext: FormLinkProjectionContext,
): ValidationError[] {
	const form = doc.forms[formUuid];
	const mod = doc.modules[moduleUuid];
	if (form === undefined || mod === undefined) return [];
	// The entry is defined only where its menu projects; every "no" is a
	// finding another rule owns.
	if (!moduleFrameActionsBuildableIn(doc, linkContext, moduleUuid)) return [];
	const declared = new Set(
		entrySessionDatums(doc, linkContext, moduleUuid, formUuid).map(
			(datum) => datum.id,
		),
	);
	const printContext = xpathPrintContext(doc);
	const unsupplied = (value: unknown): string[] => {
		// The schema validator reports a malformed carrier on its own; this
		// rule stays total over a damaged or pre-schema slot.
		if (!isXPathExpression(value)) return [];
		const text = projectXPath(value, printContext).text;
		return [...sessionDataAccessInXPath(text).exactDatumIds].filter(
			(id) => !declared.has(id),
		);
	};
	const location = {
		moduleUuid,
		moduleName: mod.name,
		formUuid,
		formName: form.name,
	};
	const errors: ValidationError[] = [];

	const walkFields = (parentUuid: Uuid): void => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			for (const slot of fieldReferenceSlotsFor(
				field.kind,
				field.kind === "repeat" ? field.repeat_mode : undefined,
			)) {
				if (slot.kind !== "xpath-ast") continue;
				for (const entry of readSlotValues(field, slot.path)) {
					for (const datumId of unsupplied(entry.value)) {
						errors.push(
							validationError(
								"SESSION_DATUM_NOT_SUPPLIED",
								"field",
								`"${field.id}" reads "${datumId}" from the session, but no menu of this app supplies it, so CommCare can't open "${form.name}". You can read a question, a case property or the worker's own record instead.`,
								{
									...location,
									fieldUuid: field.uuid,
									fieldId: field.id,
									field: slot.slot,
								},
								{ datumId, slot: slot.slot, carrier: "field" },
							),
						);
					}
				}
			}
			if (doc.fieldOrder[uuid] !== undefined) walkFields(uuid);
		}
	};
	walkFields(formUuid);

	for (const slot of FORM_REFERENCE_SLOTS) {
		if (slot.kind !== "xpath-ast") continue;
		const carrier = formSlotCarrier(slot.slot);
		for (const entry of readSlotValues(form, slot.path)) {
			for (const datumId of unsupplied(entry.value)) {
				errors.push(
					validationError(
						"SESSION_DATUM_NOT_SUPPLIED",
						"form",
						carrier === "form_link"
							? `A link from "${form.name}" reads "${datumId}" from the session, but no menu of this app supplies it, so it never holds a value. You can read a case property or the worker's own record instead.`
							: `A CommCare Connect setting of "${form.name}" reads "${datumId}" from the session, but no menu of this app supplies it, so it never holds a value. You can read a question, a case property or the worker's own record instead.`,
						{ ...location, field: slot.slot },
						{ datumId, slot: slot.slot, carrier },
					),
				);
			}
		}
	}
	return errors;
}
