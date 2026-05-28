/**
 * Validation and fix loop for CommCare app blueprints.
 *
 * Two-phase validation:
 *   1. Domain validation — structural/semantic rules + XPath deep
 *      validation run directly on `BlueprintDoc`.
 *   2. Post-expansion validation — `expandDoc` produces the HQ import
 *      JSON + XForm attachments; the HQ-JSON oracle checks the import
 *      shape and each form's XForm oracle checks the parse-time contract.
 *      These oracles prove the emitter total; a failure is a generator
 *      bug, not a fixable authoring state, so no auto-fix runs on them.
 *
 * Auto-fixes from the fix registry produce domain `Mutation`s, which are
 * applied to the working doc between validation attempts via the same
 * reducer the builder and SA use for manual edits. Connect-config
 * defaults are filled in by `deriveConnectDefaults`, which operates on
 * `BlueprintDoc` directly and returns the defaulted `ConnectConfig`;
 * `applyConnectDefaults` below folds that into an `updateForm` mutation
 * per affected form.
 *
 * The loop takes a `ToolExecutionContext` rather than the chat-specific
 * `GenerationContext`, so the same validation + fix pass runs on both
 * the SA chat surface and the MCP adapter. Every persistence step goes
 * through `ctx.recordMutations` (fix batches, connect defaults) and
 * `ctx.recordConversation` (validation-attempt events). The chat
 * surface's intermediate save is fire-and-forget by construction; the
 * MCP surface awaits. This loop is agnostic to which — it just needs
 * the interface.
 */

import { produce } from "immer";
import type { HqApplication } from "@/lib/commcare";
import { expandDoc } from "@/lib/commcare/expander";
import {
	errorToString,
	type ValidationError,
} from "@/lib/commcare/validator/errors";
import { FIX_REGISTRY } from "@/lib/commcare/validator/fixes";
import { validateHqJson } from "@/lib/commcare/validator/hqJsonOracle";
import { runValidation } from "@/lib/commcare/validator/runner";
import { validateXForm } from "@/lib/commcare/validator/xformOracle";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import { deriveConnectDefaults } from "@/lib/doc/connectConfig";
import { iterForms } from "@/lib/doc/fieldWalk";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import type { ToolExecutionContext } from "./toolExecutionContext";

// ── Post-expansion validation ────────────────────────────────────────

/**
 * Validate the expanded HQ JSON on two surfaces: the import-deserialization
 * contract (`validateHqJson` mirrors `Application.wrap`'s FATAL shape), and the
 * XForm parse-time contract on every attachment (`validateXForm` mirrors
 * JavaRosa's `XFormParser`). The XML attachment keys match the form's CommCare
 * `unique_id` — we walk them positionally against the doc so every form-scoped
 * error carries the right form/module name.
 */
function validateExpansion(
	hqJson: HqApplication,
	doc: BlueprintDoc,
): ValidationError[] {
	// The HQ-JSON oracle reads the typed application structure directly — it's
	// app-scoped, so it runs once over the whole expansion before the per-form
	// XForm walk.
	const errors: ValidationError[] = validateHqJson(hqJson);

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

			errors.push(...validateXForm(xml, formName, moduleName));
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
	ctx: ToolExecutionContext,
	doc: BlueprintDoc,
): Promise<ValidateAndFixResult> {
	let workingDoc = doc;

	// Auto-populate Connect config defaults before validation. The helper
	// produces a defaulted `ConnectConfig` per affected form; we apply the
	// resulting `updateForm` batch locally AND persist it through `ctx` so
	// every live listener — the chat client, the MCP adapter's doc
	// snapshot, the event log — sees the same defaults the server's
	// working doc carries into the validator.
	workingDoc = await applyConnectDefaults(ctx, workingDoc);

	const recentSignatures: string[] = [];
	const MAX_STUCK_REPEATS = 3;
	let attempt = 0;

	while (true) {
		attempt++;
		// Resolve the manifest before validation each iteration. The
		// SA's fixes can rewrite which assets the doc references — an
		// `attachFieldMedia` followed by an `attachOptionMedia` will
		// produce two different reference sets — so the manifest must
		// reflect the current doc's references, not the initial one.
		// `loadAssetsByIds` filters by owner (closes cross-tenant
		// enumeration); pending rows are included so `mediaAssetReady`
		// can fire with its actionable "still uploading" message
		// instead of `mediaAssetExists`'s generic "not found."
		const mediaAssets = await loadManifestForLoop(workingDoc, ctx.userId);
		const errors = runValidation(workingDoc, { mediaAssets });

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
		 * fix batch?") and — on the chat surface — the SSE stream (so the
		 * live UI's status pill reads from the same derivation replay
		 * uses). Recorded BEFORE the fix mutations so a buffer walker
		 * sees the validation context ahead of the `fix:attempt-N`
		 * tagged mutations. */
		ctx.recordConversation({
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

		// Persist the fix mutations as a single staged batch. The chat
		// client applies them via `applyMany`; the MCP adapter rebuilds
		// its in-memory doc from the persisted log. The `fix:attempt-N`
		// stage tag lets both the log UI and the replay derivation
		// render each fix pass as its own chapter. Pass the post-mutation
		// `workingDoc` so the intermediate save persists the same
		// snapshot the next validation pass will read.
		await ctx.recordMutations(
			allMutations,
			workingDoc,
			`fix:attempt-${attempt}`,
		);
	}
}

/**
 * Resolve the manifest of media-asset rows for the doc's references,
 * keyed by plain asset-id string (matching what `collectAssetRefs`
 * returns). Used inside the validation loop to feed the asset-context
 * media rules.
 *
 * Returns an empty map when the doc references zero assets — the
 * runner gates the asset-context rules on the manifest's presence,
 * not its size, so an empty map still runs the rules (which produce
 * zero errors against zero refs).
 */
async function loadManifestForLoop(
	doc: BlueprintDoc,
	owner: string,
): Promise<ReadonlyMap<string, MediaAssetRecord>> {
	const ids = [...collectAssetRefs(doc)];
	if (ids.length === 0) return new Map();
	const rows = await loadAssetsByIds(owner, ids);
	return new Map(rows.map((row) => [row.id as string, row]));
}

/**
 * Apply `deriveConnectDefaults` to every form's connect block (if present).
 * The helper produces a defaulted `ConnectConfig` per form; we batch one
 * `updateForm` mutation per affected form, apply locally on an Immer draft
 * (so the validator sees the defaults), AND persist through
 * `ctx.recordMutations` (so both surfaces apply the identical batch via
 * `docStore.applyMany` on the chat client and via the MCP adapter's
 * rebuild-from-log on the other).
 *
 * The `connect-defaults` stage tag is stamped on every envelope so the log
 * UI can render the defaults pass distinctly from `fix:attempt-N` batches.
 *
 * Returns a `Promise<BlueprintDoc>` because `recordMutations` is async on
 * the shared interface — the chat surface resolves synchronously (its
 * fire-and-forget save returns before Firestore completes), the MCP
 * surface awaits the persist. Either way the caller assigns the resolved
 * doc to its working variable via `await`.
 */
async function applyConnectDefaults(
	ctx: ToolExecutionContext,
	doc: BlueprintDoc,
): Promise<BlueprintDoc> {
	const connectType = doc.connectType;
	if (!connectType) return doc;

	const mutations: Mutation[] = [];
	// Apply each form's defaults to a working draft before deriving the
	// next form's, so `deriveConnectDefaults` sees ids minted earlier in
	// this pass. Without the incremental apply, two id-less blocks whose
	// names derive the same slug would both read the pre-pass doc and land
	// the same id — collapsing two Connect rows into one. The working draft
	// makes the uniqueness guarantee hold across forms, not just within one.
	// (`connectType` is captured pre-loop; `produce` preserves it on every
	// `workingDoc`, so it stays the narrowed non-null value.)
	let workingDoc = doc;
	for (const { moduleName, formUuid } of iterForms(workingDoc)) {
		const form = workingDoc.forms[formUuid];
		if (!form?.connect) continue;
		const next = deriveConnectDefaults({
			connectType,
			doc: workingDoc,
			formUuid,
			moduleName,
		});
		if (!next) continue;
		// Skip when the defaults pass produces a structurally identical
		// result. `deriveConnectDefaults` always returns a fresh object
		// graph (`{ ...form.connect }` + sub-config clones), so reference
		// equality never fires — without this value-equality check,
		// repeated `validateApp` calls on an already-defaulted form
		// re-emit the same `updateForm` mutation on every run, bloating
		// the event log and spending a Firestore write on a no-op reducer
		// patch. `JSON.stringify` is fine here because `ConnectConfig` is
		// a small plain-data shape (no functions, no Date, no Map/Set).
		if (JSON.stringify(next) === JSON.stringify(form.connect)) continue;
		const mutation: Mutation = {
			kind: "updateForm",
			uuid: formUuid,
			patch: { connect: next },
		};
		mutations.push(mutation);
		workingDoc = produce(workingDoc, (draft) => {
			applyMutations(draft, [mutation]);
		});
	}

	if (mutations.length === 0) return doc;
	// `workingDoc` already has every accumulated mutation applied — pass it
	// so the intermediate save persists the post-defaults snapshot the rest
	// of the validation loop reads.
	await ctx.recordMutations(mutations, workingDoc, "connect-defaults");
	return workingDoc;
}
