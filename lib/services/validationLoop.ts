/**
 * Validation and fix loop for CommCare app blueprints.
 *
 * Two-phase validation:
 * 1. Blueprint validation — structural/semantic rules + XPath deep validation
 * 2. Post-expansion validation — parse generated XForm XML and verify internal references
 *
 * Auto-fixes from the fix registry are applied between validation attempts.
 *
 * ## Wire format is a boundary detail
 *
 * The SA and the rest of the app operate on `BlueprintDoc` (the normalized
 * domain shape). The CommCare validator, expander, fix registry, and XForm
 * compiler all still consume the nested `AppBlueprint` wire format — that's
 * the legitimate external CommCare boundary. This function is the single
 * place that round-trips through the wire shape: doc → blueprint for
 * validation/expansion, then blueprint → doc at egress to fold any
 * fix-registry mutations back into the SA's working state. Callers stay on
 * the domain side of the wall.
 */
import { legacyAppBlueprintToDoc, toBlueprint } from "@/lib/doc/legacyBridge";
import type { BlueprintDoc } from "@/lib/domain";
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

/**
 * Result of a validate-and-fix pass.
 *
 * `doc` is the SA's working doc after any fix-registry mutations have been
 * folded back in — always present regardless of success. `hqJson` is the
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
 * Run CommCare validation + auto-fix loop against the SA's current doc.
 *
 * Accepts and returns `BlueprintDoc` so the SA (and any future caller)
 * never touches the wire format. Internally translates to `AppBlueprint`
 * once at ingress (the validator, expander, fix registry, and XForm
 * compiler all still consume the nested wire shape), then translates the
 * mutated blueprint back via `legacyAppBlueprintToDoc` at egress so the
 * caller can replace its working doc without losing fix-loop edits.
 */
export async function validateAndFix(
	ctx: GenerationContext,
	doc: BlueprintDoc,
): Promise<ValidateAndFixResult> {
	// Cross the wire boundary once. Every downstream helper
	// (`runValidation`, `expandBlueprint`, `FIX_REGISTRY`, `deriveConnectDefaults`)
	// is CommCare-flavored and operates on the nested `AppBlueprint` shape.
	const blueprint: AppBlueprint = toBlueprint(doc);
	const appId = doc.appId;

	// Fold the fix-registry's in-place blueprint mutations back into the
	// domain shape so the caller's working doc stays up to date.
	const toResultDoc = (): BlueprintDoc =>
		legacyAppBlueprintToDoc(appId, blueprint);

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
				return {
					success: false,
					doc: toResultDoc(),
					hqJson,
					errors: postErrors,
				};
			}
			return { success: true, doc: toResultDoc(), hqJson };
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
				return { success: false, doc: toResultDoc(), hqJson, errors };
			} catch {
				return { success: false, doc: toResultDoc(), errors };
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
