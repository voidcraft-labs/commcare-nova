/**
 * The one planner that rewrites reads in place across the carriers that
 * hold them, as granular mutations.
 *
 * A planner that keeps a read meaning what it meant when the thing it reads
 * changes (a choice whose inline source goes away, worker information
 * declared under a name a read already uses) finds its carriers through the
 * reference index and hands them here with a rewrite of one expression leaf
 * or one prose reference part. Every expression and prose slot of each
 * carrier is mapped, and each changed slot travels as the mutation that owns
 * it: a field's slots as one `updateField` (an inline choice's label as its
 * `updateOption`), a form's conditions and Connect settings as `updateForm`,
 * an after-submit destination as `updateFormLink`, the otherwise as
 * `setFormOtherwise`, a case operation as its `caseOperationPatch`, and a
 * module's condition and case list as `updateModule` plus the case list's
 * granular kinds. Never a reducer side effect, so the batch replays to the
 * document it reached.
 *
 * A translation of a field's text holds the same protected parts as its
 * source (`translationUnits.ts::translationValueIntegrityIssue`), so one that
 * was current before the rewrite is rewritten the same way and kept current;
 * one already out of date is left for review as it is.
 */

import { produce } from "immer";
import {
	collectTranslationUnits,
	type Field,
	FORM_REFERENCE_SLOTS,
	type Form,
	fieldReferenceSlotsFor,
	type LanguageTag,
	MODULE_REFERENCE_SLOTS,
	type Module,
	type ProseAtomPart,
	type ProsePart,
	type ProseTemplate,
	rewriteSlotValues,
	type TranslationUnitId,
} from "@/lib/domain";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import { isExpression, type Term } from "@/lib/domain/expression/types";
import { translationSourceFingerprintsEqual } from "@/lib/domain/localization";
import { caseOperationChangesForUpdate } from "./caseOperationMutations";
import { deepEqual } from "./deepEqual";
import { diffModuleConfigMutations } from "./diffDocsToMutations";
import { applyMutations } from "./mutations";
import type { BlueprintDoc, Mutation } from "./types";

/** What a rewrite changes: an expression leaf, a prose reference part, or
 *  both. Each returns `undefined` to keep what it was given. */
export interface SlotReadRewrite {
	readonly mapTerm?: (term: Term) => Term | undefined;
	readonly mapProsePart?: (
		part: Exclude<ProseAtomPart, { kind: "value" }>,
	) => ProsePart | undefined;
}

/** `value` with every expression leaf and every prose part `rewrite` maps,
 *  or `value` itself where nothing changed. */
function rewriteExpressionValue(
	value: unknown,
	rewrite: SlotReadRewrite,
): unknown {
	if (rewrite.mapTerm === undefined || !isExpression(value)) return value;
	const mapTerm = rewrite.mapTerm;
	return mapExpressionAst(value, { mapTerm: (term) => mapTerm(term) });
}

function rewriteProseValue(
	template: unknown,
	rewrite: SlotReadRewrite,
): unknown {
	if (template === null || typeof template !== "object") return template;
	const parts = (template as { parts?: unknown }).parts;
	if (!Array.isArray(parts)) return template;
	let changed = false;
	const next = parts.map((part: ProsePart) => {
		if (part.kind === "text") return part;
		if (part.kind === "value") {
			const expression = rewriteExpressionValue(part.expression, rewrite);
			if (expression === part.expression) return part;
			changed = true;
			return { ...part, expression };
		}
		const replacement = rewrite.mapProsePart?.(part);
		if (replacement === undefined || replacement === part) return part;
		changed = true;
		return replacement;
	});
	return changed ? { ...template, parts: next } : template;
}

/** The top-level key of a registry slot path. */
function topKey(path: string): string {
	return (path.split(".")[0] ?? path).replace(/\[\]$/u, "");
}

function fieldMutations(
	field: Field,
	rewrite: SlotReadRewrite,
): { mutations: Mutation[]; prose: boolean } {
	const mapped = structuredClone(field);
	const changedKeys = new Set<string>();
	let prose = false;
	for (const slot of fieldReferenceSlotsFor(
		field.kind,
		field.kind === "repeat" ? field.repeat_mode : undefined,
	)) {
		const changed =
			slot.kind === "prose"
				? rewriteSlotValues(mapped, slot.path, (template) =>
						rewriteProseValue(template, rewrite),
					)
				: slot.kind === "expression"
					? rewriteSlotValues(mapped, slot.path, (value) =>
							rewriteExpressionValue(value, rewrite),
						)
					: slot.kind === "options-source"
						? rewriteSlotValues(mapped, `${slot.path}.filter`, (value) =>
								rewriteExpressionValue(value, rewrite),
							)
						: 0;
		if (changed === 0) continue;
		if (slot.kind === "prose") prose = true;
		changedKeys.add(topKey(slot.path));
	}
	const mutations: Mutation[] = [];
	const patch: Record<string, unknown> = {};
	const before = field as unknown as Record<string, unknown>;
	const after = mapped as unknown as Record<string, unknown>;
	for (const key of changedKeys) {
		if (key !== "optionsSource") {
			patch[key] = after[key];
			continue;
		}
		const beforeSource = "optionsSource" in field ? field.optionsSource : null;
		const afterSource = "optionsSource" in mapped ? mapped.optionsSource : null;
		if (beforeSource?.kind === "inline" && afterSource?.kind === "inline") {
			// A choice's wording is its own entity's: one `updateOption` each,
			// so a peer's edit to another choice merges.
			for (const option of afterSource.options) {
				const previous = beforeSource.options.find(
					(candidate) => candidate.uuid === option.uuid,
				);
				if (previous !== undefined && !deepEqual(previous, option))
					mutations.push({
						kind: "updateOption",
						fieldUuid: field.uuid,
						uuid: option.uuid,
						option,
					});
			}
		} else if (!deepEqual(before[key], after[key])) {
			patch[key] = after[key];
		}
	}
	if (Object.keys(patch).length > 0)
		mutations.unshift({
			kind: "updateField",
			uuid: field.uuid,
			targetKind: field.kind,
			patch,
		} as Mutation);
	return { mutations, prose };
}

function formMutations(form: Form, rewrite: SlotReadRewrite): Mutation[] {
	const mapped = structuredClone(form);
	const changedKeys = new Set<string>();
	for (const slot of FORM_REFERENCE_SLOTS) {
		if (
			slot.kind !== "expression" ||
			rewriteSlotValues(mapped, slot.path, (value) =>
				rewriteExpressionValue(value, rewrite),
			) === 0
		)
			continue;
		changedKeys.add(topKey(slot.path));
	}
	const mutations: Mutation[] = [];
	const patch: Extract<Mutation, { kind: "updateForm" }>["patch"] = {};
	if (changedKeys.has("badge")) patch.badge = mapped.badge;
	if (changedKeys.has("displayCondition"))
		patch.displayCondition = mapped.displayCondition;
	if (changedKeys.has("openCondition"))
		patch.openCondition = mapped.openCondition;
	if (changedKeys.has("closeCondition"))
		patch.closeCondition = mapped.closeCondition;
	if (changedKeys.has("connect")) patch.connect = mapped.connect;
	if (Object.keys(patch).length > 0)
		mutations.push({ kind: "updateForm", uuid: form.uuid, patch });
	if (changedKeys.has("formLinks")) {
		for (const link of mapped.formLinks ?? []) {
			const previous = form.formLinks?.find(
				(value) => value.uuid === link.uuid,
			);
			if (previous === undefined) continue;
			const linkPatch: Extract<Mutation, { kind: "updateFormLink" }>["patch"] =
				{};
			if (!deepEqual(previous.condition, link.condition))
				linkPatch.condition = link.condition;
			if (!deepEqual(previous.datums, link.datums))
				linkPatch.datums = link.datums;
			if (Object.keys(linkPatch).length > 0)
				mutations.push({
					kind: "updateFormLink",
					formUuid: form.uuid,
					uuid: link.uuid,
					patch: linkPatch,
				});
		}
	}
	if (changedKeys.has("otherwise") && mapped.otherwise !== undefined)
		mutations.push({
			kind: "setFormOtherwise",
			formUuid: form.uuid,
			otherwise: mapped.otherwise,
		});
	if (changedKeys.has("caseOperations")) {
		for (const operation of mapped.caseOperations ?? []) {
			const previous = form.caseOperations?.find(
				(value) => value.uuid === operation.uuid,
			);
			if (previous !== undefined)
				mutations.push(
					...caseOperationChangesForUpdate(form.uuid, previous, operation),
				);
		}
	}
	return mutations;
}

function moduleMutations(module: Module, rewrite: SlotReadRewrite): Mutation[] {
	const mapped = structuredClone(module);
	let changed = false;
	for (const slot of MODULE_REFERENCE_SLOTS) {
		if (slot.kind !== "expression" && slot.kind !== "options-source") continue;
		const path =
			slot.kind === "options-source" ? `${slot.path}.filter` : slot.path;
		if (
			rewriteSlotValues(mapped, path, (value) =>
				rewriteExpressionValue(value, rewrite),
			) > 0
		)
			changed = true;
	}
	if (!changed) return [];
	const mutations: Mutation[] = [];
	if (!deepEqual(module.badge, mapped.badge))
		mutations.push({
			kind: "updateModule",
			uuid: module.uuid,
			patch: { badge: mapped.badge },
		});
	if (!deepEqual(module.displayCondition, mapped.displayCondition))
		mutations.push({
			kind: "updateModule",
			uuid: module.uuid,
			patch: { displayCondition: mapped.displayCondition },
		});
	mutations.push(...diffModuleConfigMutations(module, mapped));
	return mutations;
}

/**
 * The mutations that apply `rewrite` to every read the named carriers hold
 * in `doc`. `translationRewrite` maps the reads of a current translation of
 * a rewritten text; it defaults to `rewrite`, and a caller that tallies what
 * `rewrite` changed passes one that does not tally.
 */
export function slotReadRewriteMutations(
	doc: BlueprintDoc,
	carriers: Iterable<string>,
	rewrite: SlotReadRewrite,
	translationRewrite: SlotReadRewrite = rewrite,
): Mutation[] {
	const mutations: Mutation[] = [];
	const proseMutations: Mutation[] = [];
	for (const carrier of new Set(carriers)) {
		const field = doc.fields[carrier];
		if (field !== undefined) {
			const planned = fieldMutations(field, rewrite);
			mutations.push(...planned.mutations);
			if (planned.prose) proseMutations.push(...planned.mutations);
			continue;
		}
		const form = doc.forms[carrier];
		if (form !== undefined) {
			mutations.push(...formMutations(form, rewrite));
			continue;
		}
		const module = doc.modules[carrier];
		if (module !== undefined)
			mutations.push(...moduleMutations(module, rewrite));
	}
	if (proseMutations.length > 0)
		mutations.push(
			...currentTranslationRewrites(doc, proseMutations, translationRewrite),
		);
	return mutations;
}

/**
 * Each current translation of a text `proseMutations` rewrite, rewritten the
 * same way and carrying its source's new fingerprint.
 */
function currentTranslationRewrites(
	doc: BlueprintDoc,
	proseMutations: readonly Mutation[],
	rewrite: SlotReadRewrite,
): Mutation[] {
	const translations = doc.localization?.translations;
	if (translations === undefined) return [];
	const before = new Map(
		collectTranslationUnits(doc).map((unit) => [unit.id, unit]),
	);
	const rewritten = produce(doc, (draft) => {
		applyMutations(draft, [...proseMutations]);
	});
	const after = new Map(
		collectTranslationUnits(rewritten).map((unit) => [unit.id, unit]),
	);
	const out: Mutation[] = [];
	for (const [language, entries] of Object.entries(translations)) {
		for (const [unitId, entry] of Object.entries(entries)) {
			const prior = before.get(unitId as TranslationUnitId);
			const next = after.get(unitId as TranslationUnitId);
			if (
				prior === undefined ||
				next === undefined ||
				typeof entry.value === "string" ||
				translationSourceFingerprintsEqual(
					prior.sourceFingerprint,
					next.sourceFingerprint,
				) ||
				!translationSourceFingerprintsEqual(
					entry.sourceFingerprint,
					prior.sourceFingerprint,
				)
			)
				continue;
			out.push({
				kind: "setTranslation",
				language: language as LanguageTag,
				unitId: unitId as TranslationUnitId,
				entry: {
					...entry,
					value: rewriteProseValue(entry.value, rewrite) as ProseTemplate,
					sourceFingerprint: next.sourceFingerprint,
				},
			});
		}
	}
	return out;
}
