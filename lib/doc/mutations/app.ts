import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type AppLocalization,
	type CaseType,
	effectiveAppLocalization,
	languageTag,
} from "@/lib/domain";

/**
 * App-level mutations: name, connect mode, case-type catalog, logo. The
 * scalar setters are single-field assignments with no cascading side
 * effects. The granular catalog kinds (`declareCaseType` / `retireCaseType`
 * / `addCaseProperty` / `setCaseProperty` / `removeCaseProperty` /
 * `setCaseTypeMeta`) key by `(case-type name, property name)` and never
 * rewrite the whole `caseTypes` array, so two members concurrently editing
 * different types / properties merge by construction. They are total:
 * targeting an absent type is a no-op (the commit gate adjudicates a field
 * left writing to it via `CASE_WRITE_UNKNOWN_TYPE`, and the guarded
 * writer's `mutationTargetsInvalid` rejects a catalog edit against a
 * concurrently-retired type).
 */
export function applyAppMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "setAppName"
				| "setConnectType"
				| "setAppLogo"
				| "relabelSourceLanguage"
				| "addLanguage"
				| "removeLanguage"
				| "setDefaultLanguage"
				| "setTranslation"
				| "reviewTranslation"
				| "declareCaseType"
				| "retireCaseType"
				| "addCaseProperty"
				| "setCaseProperty"
				| "removeCaseProperty"
				| "setCaseTypeMeta";
		}
	>,
): void {
	switch (mut.kind) {
		case "setAppName":
			draft.appName = mut.name;
			return;
		case "setConnectType":
			draft.connectType = mut.connectType;
			return;
		case "setAppLogo":
			// The doc's `logo` slot is `.optional()`, not `.nullable()`, so
			// a cleared logo must drop off the doc — not persist as a
			// literal `null` or own `undefined` the schema would reject. The
			// payload carries `null` to mean "clear"; the reducer deletes the
			// property. An asset id sets it verbatim.
			if (mut.logo === null) delete draft.logo;
			else draft.logo = mut.logo;
			return;
		case "relabelSourceLanguage": {
			const current = effectiveAppLocalization(draft.localization);
			if (current.languageOrder.length !== 1) return;
			const tag = languageTag(mut.language);
			draft.localization = {
				sourceLanguage: tag,
				defaultLanguage: tag,
				languageOrder: [tag],
				translations: {},
			};
			return;
		}
		case "addLanguage": {
			const localization = materializeLocalization(draft);
			const tag = languageTag(mut.language);
			if (localization.languageOrder.includes(tag)) return;
			localization.languageOrder.push(tag);
			localization.translations[tag] = {};
			return;
		}
		case "removeLanguage": {
			const localization = materializeLocalization(draft);
			if (
				mut.code === localization.sourceLanguage ||
				mut.code === localization.defaultLanguage ||
				!localization.languageOrder.includes(mut.code)
			) {
				return;
			}
			localization.languageOrder = localization.languageOrder.filter(
				(code) => code !== mut.code,
			);
			delete localization.translations[mut.code];
			return;
		}
		case "setDefaultLanguage": {
			const localization = materializeLocalization(draft);
			if (!localization.languageOrder.includes(mut.code)) return;
			localization.defaultLanguage = mut.code;
			localization.languageOrder = [
				mut.code,
				...localization.languageOrder.filter((code) => code !== mut.code),
			];
			return;
		}
		case "setTranslation": {
			const localization = materializeLocalization(draft);
			const translations = localization.translations[mut.language];
			if (translations === undefined) return;
			if (mut.entry === null) delete translations[mut.unitId];
			else translations[mut.unitId] = structuredClone(mut.entry);
			return;
		}
		case "reviewTranslation": {
			const localization = materializeLocalization(draft);
			const entry = localization.translations[mut.language]?.[mut.unitId];
			if (
				entry === undefined ||
				entry.sourceFingerprint !== mut.expectedSourceFingerprint ||
				JSON.stringify(entry.value) !== JSON.stringify(mut.value)
			) {
				return;
			}
			// Translation maps are normalized null-prototype records. A stored
			// entry may remain a frozen shared value until this exact key is
			// replaced, so never mutate its nested fields in place.
			const translations = localization.translations[mut.language];
			if (translations === undefined) return;
			translations[mut.unitId] = {
				value: structuredClone(mut.value),
				sourceFingerprint: mut.sourceFingerprint,
				origin: entry.origin,
				review: "reviewed",
				translatedFrom: entry.translatedFrom,
			};
			return;
		}
		case "declareCaseType": {
			// Idempotent: an existing declaration is left untouched (its
			// properties + ancestry survive a re-declare).
			draft.caseTypes ??= [];
			if (!draft.caseTypes.some((ct) => ct.name === mut.caseType)) {
				draft.caseTypes.push({ name: mut.caseType, properties: [] });
			}
			return;
		}
		case "retireCaseType": {
			if (!draft.caseTypes) return;
			const kept = draft.caseTypes.filter((ct) => ct.name !== mut.caseType);
			// An emptied catalog stores as `null` — the canonical spelling a fresh
			// app is born with (matches `caseTypeRetirement` / `scaffolds`), so the
			// diff round-trip reproduces `null`, not `[]`.
			draft.caseTypes = kept.length > 0 ? kept : null;
			return;
		}
		case "addCaseProperty": {
			// Insert into an EXISTING declared type only; idempotent on the
			// property name. Omitted `after` means an intentional append,
			// `null` means first, and a name means immediately after that
			// property. Document-aware sequence admission proves an authored
			// anchor still exists in this exact case type before reduction.
			const ct = findCaseType(draft, mut.caseType);
			if (!ct) return;
			if (!ct.properties.some((p) => p.name === mut.property.name)) {
				// Cloned: a batch is applied more than once and Immer freezes what
				// `produce` returns, so the payload must never BE the stored record.
				const property = structuredClone(mut.property);
				if (mut.after === undefined) {
					ct.properties.push(property);
				} else if (mut.after === null) {
					ct.properties.unshift(property);
				} else {
					const anchorIndex = ct.properties.findIndex(
						(existing) => existing.name === mut.after,
					);
					if (anchorIndex < 0) return;
					ct.properties.splice(anchorIndex + 1, 0, property);
				}
			}
			return;
		}
		case "setCaseProperty": {
			// Replace a property by name (append if absent) — the diff's
			// content-change emission for a property whose data_type/label/…
			// shifted.
			const ct = findCaseType(draft, mut.caseType);
			if (!ct) return;
			const idx = ct.properties.findIndex((p) => p.name === mut.property.name);
			const property = structuredClone(mut.property);
			if (idx === -1) ct.properties.push(property);
			else ct.properties[idx] = property;
			return;
		}
		case "removeCaseProperty": {
			const ct = findCaseType(draft, mut.caseType);
			if (!ct) return;
			ct.properties = ct.properties.filter((p) => p.name !== mut.property);
			return;
		}
		case "setCaseTypeMeta": {
			// Type-level ancestry (`parent_type` / `relationship`). A `null`
			// clears the slot; an omitted (`undefined`) slot is left untouched —
			// a clear must travel as an explicit `null` because JSON drops
			// `undefined`-valued keys.
			const ct = findCaseType(draft, mut.caseType);
			if (!ct) return;
			if (mut.parent_type !== undefined) {
				if (mut.parent_type === null) delete ct.parent_type;
				else ct.parent_type = mut.parent_type;
			}
			if (mut.relationship !== undefined) {
				if (mut.relationship === null) delete ct.relationship;
				else ct.relationship = mut.relationship;
			}
			return;
		}
	}
}

/**
 * Materialize the derived English-only state only when an edit needs storage.
 * The batch-end dematerialize step restores the canonical absent-root
 * spelling if the batch leaves the app exactly English-only.
 */
function materializeLocalization(
	draft: Draft<BlueprintDoc>,
): Draft<AppLocalization> {
	if (draft.localization === undefined) {
		const englishOnly = effectiveAppLocalization(undefined);
		draft.localization = structuredClone(englishOnly) as AppLocalization;
	}
	return draft.localization;
}

/** Resolve a case-type record by name on the draft catalog. */
function findCaseType(
	draft: Draft<BlueprintDoc>,
	name: string,
): Draft<CaseType> | undefined {
	return draft.caseTypes?.find((ct) => ct.name === name);
}
