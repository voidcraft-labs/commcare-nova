/**
 * Validation and fix loop for CommCare app blueprints.
 *
 * Two-phase validation:
 * 1. Blueprint validation — structural/semantic rules + XPath deep validation
 * 2. Post-expansion validation — parse generated XForm XML and verify internal references
 *
 * Auto-fixes from the fix registry are applied between validation attempts.
 */
import type { AppBlueprint } from "../schemas/blueprint";
import type { HqApplication } from "./commcare";
import {
	errorToString,
	type ValidationError,
} from "./commcare/validate/errors";
import { FIX_REGISTRY } from "./commcare/validate/fixes";
import { runValidation } from "./commcare/validate/runner";
import { validateXFormXml } from "./commcare/validate/xformValidator";
import { deriveConnectDefaults } from "./connectConfig";
import type { GenerationContext } from "./generationContext";
import { expandBlueprint } from "./hqJsonExpander";

// ── Post-expansion validation ────────────────────────────────────────

/** Validate all XForm attachments in the expanded HQ JSON. */
function validateExpansion(
	hqJson: HqApplication,
	blueprint: AppBlueprint,
): ValidationError[] {
	const errors: ValidationError[] = [];

	for (let mIdx = 0; mIdx < hqJson.modules.length; mIdx++) {
		const hqMod = hqJson.modules[mIdx];
		const bpMod = blueprint.modules[mIdx];

		for (let fIdx = 0; fIdx < hqMod.forms.length; fIdx++) {
			const hqForm = hqMod.forms[fIdx];
			const formName = bpMod?.forms[fIdx]?.name ?? `Form ${fIdx}`;
			const moduleName = bpMod?.name ?? `Module ${mIdx}`;

			// Find the XForm attachment for this form
			const attachmentKey = `${hqForm.unique_id}.xml`;
			const xml = hqJson._attachments[attachmentKey];
			if (typeof xml !== "string") continue;

			errors.push(...validateXFormXml(xml, formName, moduleName));
		}
	}

	return errors;
}

// ── Validate + fix loop ──────────────────────────────────────────────

export async function validateAndFix(
	ctx: GenerationContext,
	blueprint: AppBlueprint,
): Promise<{
	success: boolean;
	blueprint: AppBlueprint;
	hqJson?: HqApplication;
	errors?: ValidationError[];
}> {
	// Auto-populate Connect config defaults before validation
	if (blueprint.connect_type) {
		for (const mod of blueprint.modules) {
			for (const form of mod.forms) {
				if (form.connect) {
					deriveConnectDefaults(blueprint.connect_type, form, mod.name);
				}
			}
		}
	}

	const recentSignatures: string[] = [];
	const MAX_STUCK_REPEATS = 3;
	let attempt = 0;

	while (true) {
		attempt++;
		const errors = runValidation(blueprint);

		if (errors.length === 0) {
			// Blueprint is clean — expand and run post-expansion validation
			const hqJson = expandBlueprint(blueprint);
			const postErrors = validateExpansion(hqJson, blueprint);
			if (postErrors.length > 0) {
				return { success: false, blueprint, hqJson, errors: postErrors };
			}
			return { success: true, blueprint, hqJson };
		}

		// Stuck detection
		const sig = errors
			.map(
				(e) =>
					`${e.code}:${e.location.formName ?? ""}:${e.location.questionId ?? ""}`,
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
				const hqJson = expandBlueprint(blueprint);
				return { success: false, blueprint, hqJson, errors };
			} catch {
				return { success: false, blueprint, errors };
			}
		}

		ctx.emit("data-phase", { phase: "fix" });
		ctx.emit("data-fix-attempt", {
			attempt,
			errorCount: errors.length,
			errors: errors.map(errorToString),
		});

		// Apply auto-fixes from the registry
		let anyFixed = false;
		for (const error of errors) {
			const fix = FIX_REGISTRY.get(error.code);
			if (fix?.(error, blueprint)) {
				anyFixed = true;
			}
		}

		// Emit form-fixed events for forms that were touched
		if (anyFixed) {
			const fixedForms = new Set<string>();
			for (const error of errors) {
				if (FIX_REGISTRY.has(error.code) && error.location.formName) {
					fixedForms.add(error.location.formName);
				}
			}
			for (const formName of fixedForms) {
				for (let mIdx = 0; mIdx < blueprint.modules.length; mIdx++) {
					for (
						let fIdx = 0;
						fIdx < blueprint.modules[mIdx].forms.length;
						fIdx++
					) {
						if (blueprint.modules[mIdx].forms[fIdx].name === formName) {
							ctx.emit("data-form-fixed", {
								moduleIndex: mIdx,
								formIndex: fIdx,
								form: blueprint.modules[mIdx].forms[fIdx],
							});
						}
					}
				}
			}
		}
	}
}
