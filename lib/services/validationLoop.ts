/**
 * Validation and fix loop for CommCare app blueprints.
 *
 * Two-phase validation:
 *   1. Domain validation — structural/semantic rules + XPath deep validation
 *      run directly on `BlueprintDoc`.
 *   2. Post-expansion validation — parse generated XForm XML and verify
 *      internal references. Expansion itself is the legitimate XForm
 *      wire-boundary emission; the doc is translated to `AppBlueprint`
 *      exactly once at that emit site and never travels back.
 *
 * Auto-fixes from the fix registry produce domain `Mutation`s, which are
 * applied to the working doc between validation attempts via the same
 * reducer the builder and SA use for manual edits. No wire-format round-
 * trip of the doc itself remains.
 */

import { produce } from "immer";
import type { GenerationContext } from "@/lib/agent/generationContext";
import { toBlueprint } from "@/lib/doc/legacyBridge";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { HqApplication } from "./commcare";
import {
	errorToString,
	type ValidationError,
} from "./commcare/validate/errors";
import { FIX_REGISTRY } from "./commcare/validate/fixes";
import { runValidation } from "./commcare/validate/runner";
import { validateXFormXml } from "./commcare/validate/xformValidator";
import { deriveConnectDefaults } from "./connectConfig";
import { expandBlueprint } from "./hqJsonExpander";

// ── Post-expansion validation ────────────────────────────────────────

/**
 * Validate all XForm attachments in the expanded HQ JSON. The XML attachment
 * keys match the form's CommCare `unique_id` — we walk them positionally
 * against the doc so every error carries the right form/module name.
 */
function validateExpansion(
	hqJson: HqApplication,
	doc: BlueprintDoc,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (let mIdx = 0; mIdx < hqJson.modules.length; mIdx++) {
		const hqMod = hqJson.modules[mIdx];
		const moduleUuid = doc.moduleOrder[mIdx];
		const docMod = moduleUuid ? doc.modules[moduleUuid] : undefined;

		for (let fIdx = 0; fIdx < hqMod.forms.length; fIdx++) {
			const hqForm = hqMod.forms[fIdx];
			const formUuid = moduleUuid
				? doc.formOrder[moduleUuid]?.[fIdx]
				: undefined;
			const docForm = formUuid ? doc.forms[formUuid] : undefined;
			const formName = docForm?.name ?? `Form ${fIdx}`;
			const moduleName = docMod?.name ?? `Module ${mIdx}`;

			const attachmentKey = `${hqForm.unique_id}.xml`;
			const xml = hqJson._attachments[attachmentKey];
			if (typeof xml !== "string") continue;

			errors.push(...validateXFormXml(xml, formName, moduleName));
		}
	}

	return errors;
}

// ── Validate + fix loop ──────────────────────────────────────────────

/**
 * Result of a validate-and-fix pass.
 *
 * `doc` is the SA's working doc after any fix-registry mutations have been
 * folded in — always present regardless of success. `hqJson` is the
 * expanded CommCare application (XForm XML included); present whenever
 * expansion reached the point of producing output, even on post-expansion
 * validation failure. `errors` carries the remaining issues the fix loop
 * couldn't resolve.
 */
export interface ValidateAndFixResult {
	success: boolean;
	doc: BlueprintDoc;
	hqJson?: HqApplication;
	errors?: ValidationError[];
}

/**
 * Run CommCare validation + auto-fix loop against a `BlueprintDoc`.
 *
 * Validation runs directly on the domain doc. When errors exist, each fix
 * in the registry produces a list of `Mutation`s; the loop applies them
 * atomically via Immer + `applyMutations` and re-validates. When no
 * errors remain, the doc is emitted through the XForm expander (the
 * legitimate wire-format boundary); any post-expansion errors are
 * returned without further auto-fix.
 *
 * The loop guards against a fix cycle with a 3-repeat stuck signature
 * check — if the same error set recurs three times in a row, the loop
 * exits early with the remaining errors.
 */
export async function validateAndFix(
	ctx: GenerationContext,
	doc: BlueprintDoc,
): Promise<ValidateAndFixResult> {
	let workingDoc = doc;

	// Auto-populate Connect config defaults before validation. This mutates
	// the form.connect struct in place — we re-wire by materializing the
	// wire form, running the existing helper, then folding the result back
	// via a set of `updateForm` mutations. In practice the helper rarely
	// changes anything (it only fills in id/name/description defaults), so
	// the cost is negligible.
	workingDoc = applyConnectDefaults(workingDoc);

	const recentSignatures: string[] = [];
	const MAX_STUCK_REPEATS = 3;
	let attempt = 0;

	while (true) {
		attempt++;
		const errors = runValidation(workingDoc);

		if (errors.length === 0) {
			const hqJson = expandBlueprint(toBlueprint(workingDoc));
			const postErrors = validateExpansion(hqJson, workingDoc);
			if (postErrors.length > 0) {
				return {
					success: false,
					doc: workingDoc,
					hqJson,
					errors: postErrors,
				};
			}
			return { success: true, doc: workingDoc, hqJson };
		}

		// Stuck detection — if the same error set recurs MAX_STUCK_REPEATS
		// times, bail with whatever output we can produce.
		const sig = errors
			.map(
				(e) =>
					`${e.code}:${e.location.formName ?? ""}:${e.location.fieldId ?? ""}`,
			)
			.sort()
			.join("|||");
		recentSignatures.push(sig);
		if (recentSignatures.length > MAX_STUCK_REPEATS) recentSignatures.shift();
		if (
			recentSignatures.length === MAX_STUCK_REPEATS &&
			recentSignatures.every((s) => s === sig)
		) {
			try {
				const hqJson = expandBlueprint(toBlueprint(workingDoc));
				return { success: false, doc: workingDoc, hqJson, errors };
			} catch {
				return { success: false, doc: workingDoc, errors };
			}
		}

		ctx.emit("data-phase", { phase: "fix" });
		ctx.emit("data-fix-attempt", {
			attempt,
			errorCount: errors.length,
			errors: errors.map(errorToString),
		});

		// Collect all mutations from the fix registry, then apply as one
		// atomic Immer draft so downstream listeners see a single consistent
		// update rather than a partial-apply state.
		const allMutations: Mutation[] = [];
		const fixedFormUuids = new Set<string>();
		for (const error of errors) {
			const fix = FIX_REGISTRY.get(error.code);
			if (!fix) continue;
			const muts = fix(error, workingDoc);
			if (muts.length > 0) {
				allMutations.push(...muts);
				if (error.location.formUuid)
					fixedFormUuids.add(error.location.formUuid);
			}
		}

		if (allMutations.length === 0) {
			// No fixes available for any error — surface the remainder.
			try {
				const hqJson = expandBlueprint(toBlueprint(workingDoc));
				return { success: false, doc: workingDoc, hqJson, errors };
			} catch {
				return { success: false, doc: workingDoc, errors };
			}
		}

		workingDoc = produce(workingDoc, (draft) => {
			applyMutations(draft, allMutations);
		});

		// Emit form-fixed events for forms that were touched. The emitter
		// serializes each fixed form via the wire shape so stream consumers
		// match the rest of the builder's event contract.
		if (fixedFormUuids.size > 0) {
			const wire = toBlueprint(workingDoc);
			for (const formUuid of fixedFormUuids) {
				for (let mIdx = 0; mIdx < workingDoc.moduleOrder.length; mIdx++) {
					const moduleUuid = workingDoc.moduleOrder[mIdx];
					const formList = workingDoc.formOrder[moduleUuid] ?? [];
					const fIdx = formList.indexOf(formUuid as typeof moduleUuid);
					if (fIdx === -1) continue;
					ctx.emit("data-form-fixed", {
						moduleIndex: mIdx,
						formIndex: fIdx,
						form: wire.modules[mIdx].forms[fIdx],
					});
				}
			}
		}
	}
}

/**
 * Apply `deriveConnectDefaults` to every form's connect block (if present).
 * The helper operates on the wire `BlueprintForm` shape; we round-trip the
 * whole doc through the wire format, let the helper fill in defaults in
 * place, then fold any resulting changes back via `updateForm` mutations.
 *
 * Nothing here changes semantics — it mirrors the previous loop's behavior
 * — but keeping it off to the side prevents it from hiding inside the
 * main validate/fix flow.
 */
function applyConnectDefaults(doc: BlueprintDoc): BlueprintDoc {
	if (!doc.connectType) return doc;

	// Only forms that already have `form.connect` set receive defaults.
	// We build the set of affected form uuids first; if none, skip.
	const affected: string[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (doc.forms[formUuid].connect) affected.push(formUuid);
		}
	}
	if (affected.length === 0) return doc;

	const wire = toBlueprint(doc);
	const mutations: Mutation[] = [];
	for (let mIdx = 0; mIdx < wire.modules.length; mIdx++) {
		const mod = wire.modules[mIdx];
		for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
			const form = mod.forms[fIdx];
			if (!form.connect) continue;
			deriveConnectDefaults(doc.connectType, form, mod.name);
			const formUuid = doc.formOrder[doc.moduleOrder[mIdx]]?.[fIdx];
			if (!formUuid) continue;
			mutations.push({
				kind: "updateForm",
				uuid: formUuid,
				patch: { connect: form.connect },
			});
		}
	}

	if (mutations.length === 0) return doc;
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}
