/**
 * Validation and fix loop for CommCare app blueprints.
 *
 * Two-phase validation:
 *   1. Domain validation — structural/semantic rules + XPath deep
 *      validation run directly on `BlueprintDoc`.
 *   2. Post-expansion validation — `expandDoc` produces the HQ import
 *      JSON + XForm attachments; the XForm XML is parsed and its
 *      internal references verified.
 *
 * Auto-fixes from the fix registry produce domain `Mutation`s, which are
 * applied to the working doc between validation attempts via the same
 * reducer the builder and SA use for manual edits. Connect-config
 * defaults are filled in by `deriveConnectDefaults`, which operates on
 * `BlueprintDoc` directly and returns the defaulted `ConnectConfig`;
 * `applyConnectDefaults` below folds that into an `updateForm` mutation
 * per affected form.
 */

import { produce } from "immer";
import type { HqApplication } from "@/lib/commcare";
import { expandDoc } from "@/lib/commcare/expander";
import {
	errorToString,
	type ValidationError,
} from "@/lib/commcare/validator/errors";
import { FIX_REGISTRY } from "@/lib/commcare/validator/fixes";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateXFormXml } from "@/lib/commcare/validator/xformValidator";
import { deriveConnectDefaults } from "@/lib/doc/connectConfig";
import { iterForms } from "@/lib/doc/fieldWalk";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { GenerationContext } from "./generationContext";

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

	// Auto-populate Connect config defaults before validation. The helper
	// produces a defaulted `ConnectConfig` per affected form; we apply the
	// resulting `updateForm` batch locally AND emit it through `ctx` so the
	// live builder sees the same defaults the server's working doc carries
	// into the validator.
	workingDoc = applyConnectDefaults(ctx, workingDoc);

	const recentSignatures: string[] = [];
	const MAX_STUCK_REPEATS = 3;
	let attempt = 0;

	while (true) {
		attempt++;
		const errors = runValidation(workingDoc);

		if (errors.length === 0) {
			const hqJson = expandDoc(workingDoc);
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
				const hqJson = expandDoc(workingDoc);
				return { success: false, doc: workingDoc, hqJson, errors };
			} catch {
				return { success: false, doc: workingDoc, errors };
			}
		}

		/* Log one validation-attempt conversation event per fix round. The
		 * attempt number + human-readable error list land in both the
		 * event log (debug artifact answering "which errors drove which
		 * fix batch?") and the SSE stream (so the live UI's status pill
		 * reads from the same derivation replay uses). Emitted BEFORE the
		 * fix mutations so a buffer walker sees the validation context
		 * ahead of the `fix:attempt-N` tagged mutations. */
		ctx.emitConversation({
			type: "validation-attempt",
			attempt,
			errors: errors.map(errorToString),
		});

		// Collect all mutations from the fix registry. We apply them as one
		// atomic Immer draft below so downstream listeners see a single
		// consistent update rather than a partial-apply state. Per-form
		// grouping is derivable from each mutation's target uuid by
		// downstream consumers that need it; this loop doesn't pre-bucket.
		const allMutations: Mutation[] = [];
		for (const error of errors) {
			const fix = FIX_REGISTRY.get(error.code);
			if (!fix) continue;
			const muts = fix(error, workingDoc);
			if (muts.length > 0) allMutations.push(...muts);
		}

		if (allMutations.length === 0) {
			// No fixes available for any error — surface the remainder.
			try {
				const hqJson = expandDoc(workingDoc);
				return { success: false, doc: workingDoc, hqJson, errors };
			} catch {
				return { success: false, doc: workingDoc, errors };
			}
		}

		workingDoc = produce(workingDoc, (draft) => {
			applyMutations(draft, allMutations);
		});

		// Emit the fix mutations as a single staged batch. The client
		// applies them via `applyMany`. The `fix:attempt-N` stage tag
		// lets the log UI render each fix pass as its own chapter.
		// Pass the post-mutation `workingDoc` so the intermediate save
		// persists the same snapshot the next validation pass will read.
		ctx.emitMutations(allMutations, workingDoc, `fix:attempt-${attempt}`);
	}
}

/**
 * Apply `deriveConnectDefaults` to every form's connect block (if present).
 * The helper produces a defaulted `ConnectConfig` per form; we batch one
 * `updateForm` mutation per affected form, apply locally on an Immer draft
 * (so the validator sees the defaults), AND emit through `ctx.emitMutations`
 * (so the live builder applies the identical batch via `docStore.applyMany`).
 *
 * The `connect-defaults` stage tag is stamped on every envelope so the log
 * UI can render the defaults pass distinctly from `fix:attempt-N` batches.
 */
function applyConnectDefaults(
	ctx: GenerationContext,
	doc: BlueprintDoc,
): BlueprintDoc {
	if (!doc.connectType) return doc;

	const mutations: Mutation[] = [];
	for (const { moduleName, formUuid } of iterForms(doc)) {
		const form = doc.forms[formUuid];
		if (!form?.connect) continue;
		const next = deriveConnectDefaults({
			connectType: doc.connectType,
			doc,
			formUuid,
			moduleName,
		});
		if (!next) continue;
		mutations.push({
			kind: "updateForm",
			uuid: formUuid,
			patch: { connect: next },
		});
	}

	if (mutations.length === 0) return doc;
	const nextDoc = produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
	// Pass `nextDoc` so the intermediate save persists the post-defaults
	// snapshot the rest of the validation loop reads.
	ctx.emitMutations(mutations, nextDoc, "connect-defaults");
	return nextDoc;
}
