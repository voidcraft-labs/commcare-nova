import { current, type Draft } from "immer";
import { deepEqual } from "@/lib/doc/deepEqual";
import { spliceAfter } from "@/lib/doc/mutations/sequence";
import { rebaseSourceLanguage } from "@/lib/doc/sourceLanguage";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type AppLocalization,
	type CaseType,
	effectiveAppLocalization,
	languageTag,
} from "@/lib/domain";
import { compareCaseRelations } from "@/lib/domain/caseRelations";
import {
	rebaseFormMediaLanguages,
	rebaseNavigationMedia,
} from "@/lib/domain/formMediaLanguages";
import {
	editableLanguageEntries,
	reboundLanguageCodes,
	translationSourceFingerprintsEqual,
} from "@/lib/domain/localization";
import {
	reviewedTranslationValueMode,
	translationUnitsById,
} from "@/lib/domain/translationUnits";

/**
 * App-level mutations: name, connect mode, case-type catalog, logo, app
 * settings. The
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
				| "setConnectRoles"
				| "setAppLogo"
				| "setAppSettings"
				| "relabelSourceLanguage"
				| "addLanguage"
				| "removeLanguage"
				| "moveLanguage"
				| "rebindLanguageCodes"
				| "rebaseSourceLanguage"
				| "setProjectLanguageDirection"
				| "setDefaultLanguage"
				| "setTranslation"
				| "reviewTranslation"
				| "declareCaseType"
				| "retireCaseType"
				| "addCaseProperty"
				| "setCaseProperty"
				| "moveCaseProperty"
				| "removeCaseProperty"
				| "setCaseTypeMeta";
		}
	>,
): void {
	switch (mut.kind) {
		case "setAppName":
			draft.appName = mut.name;
			return;
		case "setConnectRoles":
			draft.connectRoles = [...mut.roles];
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
		case "setAppSettings": {
			const change = mut.settings.installationProfile;
			if (change?.operation === "remove") {
				const profiles = draft.appSettings.installationProfiles;
				if (profiles) {
					delete profiles[change.uuid];
					if (Object.keys(profiles).length === 0)
						delete draft.appSettings.installationProfiles;
				}
			} else if (change?.operation === "add") {
				draft.appSettings.installationProfiles ??= {};
				const profiles = draft.appSettings.installationProfiles;
				if (!Object.hasOwn(profiles, change.profile.uuid))
					profiles[change.profile.uuid] = structuredClone(change.profile);
			} else if (change) {
				const profile = draft.appSettings.installationProfiles?.[change.uuid];
				if (profile) Object.assign(profile, structuredClone(change.patch));
			}
			// Each named key replaces its value; a key the patch leaves out
			// keeps the document's.
			if (mut.settings.captureLocation === true)
				draft.appSettings.captureLocation = true;
			else if (mut.settings.captureLocation === false)
				delete draft.appSettings.captureLocation;
			if (mut.settings.caseSharing === null)
				delete draft.appSettings.caseSharing;
			else if (mut.settings.caseSharing !== undefined)
				draft.appSettings.caseSharing = mut.settings.caseSharing;
			const search = mut.settings.projectSearch;
			if (search) {
				const entries = draft.appSettings.projectSearches ?? {};
				if (search.operation === "remove") {
					delete entries[search.uuid];
					if (!Object.keys(entries).length)
						delete draft.appSettings.projectSearches;
				} else if (
					(search.operation === "rename") ===
					Object.hasOwn(entries, search.uuid)
				) {
					entries[search.uuid] = { name: search.name };
					draft.appSettings.projectSearches = entries;
				}
			}
			if (mut.settings.showSavedForms !== undefined) {
				draft.appSettings.showSavedForms = mut.settings.showSavedForms;
			}
			if (mut.settings.showIncompleteForms !== undefined) {
				draft.appSettings.showIncompleteForms =
					mut.settings.showIncompleteForms;
			}
			if (mut.settings.firstMenuLayout === null)
				delete draft.appSettings.firstMenuLayout;
			else if (mut.settings.firstMenuLayout !== undefined)
				draft.appSettings.firstMenuLayout = mut.settings.firstMenuLayout;
			if (mut.settings.formMenuLayout === null)
				delete draft.appSettings.formMenuLayout;
			else if (mut.settings.formMenuLayout !== undefined)
				draft.appSettings.formMenuLayout = mut.settings.formMenuLayout;
			if (mut.settings.requiredAndroidApps !== undefined) {
				if (mut.settings.requiredAndroidApps.length === 0)
					delete draft.appSettings.requiredAndroidApps;
				else
					draft.appSettings.requiredAndroidApps = [
						...mut.settings.requiredAndroidApps,
					];
			}
			// `null` clears the declaration to Web Apps and Android, the
			// absent key; a value narrows the app to one platform.
			if (mut.settings.runsOnlyOn === null) delete draft.appSettings.runsOnlyOn;
			else if (mut.settings.runsOnlyOn !== undefined)
				draft.appSettings.runsOnlyOn = mut.settings.runsOnlyOn;
			return;
		}
		case "relabelSourceLanguage": {
			const current = effectiveAppLocalization(draft.localization);
			if (current.languageOrder.length !== 1) return;
			const tag = languageTag(mut.language);
			rebaseNavigationMedia(draft, current, tag, [tag], current.sourceLanguage);
			rebaseFormMediaLanguages(
				draft.fields,
				current.sourceLanguage,
				[current.sourceLanguage],
				current.defaultLanguage,
				current.defaultLanguage,
			);
			for (const profile of Object.values(
				draft.appSettings.installationProfiles ?? {},
			)) {
				profile.languages = profile.languages.map((language) =>
					language === current.sourceLanguage ? tag : language,
				);
			}
			draft.localization = {
				sourceLanguage: tag,
				defaultLanguage: tag,
				languageOrder: [tag],
				translations: {},
				...(draft.localization?.generatedSourceWording && {
					generatedSourceWording: draft.localization.generatedSourceWording,
				}),
				wireCodes: { [tag]: mut.wireCode },
			};
			return;
		}
		case "addLanguage": {
			// The carried wire code is stored as it is: the producer minted it
			// against the codes this document holds, and a replay must give the
			// same code whatever the language catalog says by then. A code
			// another language holds is refused like a held tag.
			const localization = materializeLocalization(draft);
			const tag = languageTag(mut.language);
			if (localization.languageOrder.includes(tag)) return;
			if (Object.values(localization.wireCodes).includes(mut.wireCode)) return;
			localization.languageOrder.push(tag);
			localization.translations[tag] = {};
			localization.wireCodes[tag] = mut.wireCode;
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
			rebaseNavigationMedia(
				draft,
				localization,
				localization.sourceLanguage,
				localization.languageOrder.filter((tag) => tag !== mut.code),
			);
			localization.languageOrder = localization.languageOrder.filter(
				(code) => code !== mut.code,
			);
			rebaseFormMediaLanguages(
				draft.fields,
				localization.sourceLanguage,
				localization.languageOrder,
				localization.defaultLanguage,
				localization.defaultLanguage,
			);
			delete localization.translations[mut.code];
			delete localization.wireCodes[mut.code];
			if (localization.rtlProjectLanguages) {
				delete localization.rtlProjectLanguages[mut.code];
				if (!Object.keys(localization.rtlProjectLanguages).length)
					delete localization.rtlProjectLanguages;
			}
			return;
		}
		case "rebindLanguageCodes": {
			const codes = effectiveAppLocalization(draft.localization).wireCodes;
			const rebound = reboundLanguageCodes(
				new Map(Object.entries(codes)),
				mut.changes,
			);
			if (rebound)
				materializeLocalization(draft).wireCodes = Object.fromEntries(rebound);
			return;
		}
		case "rebaseSourceLanguage": {
			if (
				effectiveAppLocalization(draft.localization).sourceLanguage === mut.from
			)
				rebaseSourceLanguage(draft, current(draft), mut.to, "saved-document");
			return;
		}
		case "setProjectLanguageDirection": {
			const localization = draft.localization;
			if (
				!localization?.languageOrder.includes(mut.code) ||
				!mut.code.startsWith("project:")
			)
				return;
			if (mut.direction === "rtl") {
				localization.rtlProjectLanguages ??= {};
				localization.rtlProjectLanguages[mut.code] = true;
			} else if (localization.rtlProjectLanguages) {
				delete localization.rtlProjectLanguages[mut.code];
				if (!Object.keys(localization.rtlProjectLanguages).length)
					delete localization.rtlProjectLanguages;
			}
			return;
		}
		case "setDefaultLanguage":
		case "moveLanguage": {
			const localization = materializeLocalization(draft);
			if (!localization.languageOrder.includes(mut.code)) return;
			const after = mut.kind === "setDefaultLanguage" ? null : mut.after;
			const order = spliceAfter(localization.languageOrder, mut.code, after);
			// A file inherited from the form default keeps showing the same
			// file when the first language changes.
			rebaseFormMediaLanguages(
				draft.fields,
				localization.sourceLanguage,
				localization.languageOrder,
				localization.defaultLanguage,
				order[0],
			);
			localization.languageOrder = order;
			localization.defaultLanguage = order[0];
			return;
		}
		case "setTranslation": {
			const localization = materializeLocalization(draft);
			const translations = editableLanguageEntries(
				localization,
				mut.language,
				mut.entry !== null,
			);
			if (translations === undefined) return;
			if (mut.entry === null) delete translations[mut.unitId];
			else translations[mut.unitId] = structuredClone(mut.entry);
			return;
		}
		case "reviewTranslation": {
			const localization = materializeLocalization(draft);
			const translations =
				mut.language === localization.sourceLanguage
					? localization.generatedSourceWording
					: localization.translations[mut.language];
			const entry = translations?.[mut.unitId];
			if (
				entry === undefined ||
				!translationSourceFingerprintsEqual(
					entry.sourceFingerprint,
					mut.expectedSourceFingerprint,
				) ||
				!deepEqual(entry.value, mut.value)
			) {
				return;
			}
			// Translation maps are normalized null-prototype records. A stored
			// entry may remain a frozen shared value until this exact key is
			// replaced, so never mutate its nested fields in place.
			if (translations === undefined) return;
			const unit =
				entry.valueMode === undefined
					? undefined
					: translationUnitsById(draft).get(mut.unitId);
			translations[mut.unitId] = {
				...(unit === undefined
					? {}
					: reviewedTranslationValueMode(unit, entry)),
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
		case "moveCaseProperty": {
			const ct = findCaseType(draft, mut.caseType);
			if (!ct || mut.property === mut.after) return;
			const from = ct.properties.findIndex((p) => p.name === mut.property);
			const anchor =
				mut.after === null
					? -1
					: ct.properties.findIndex((p) => p.name === mut.after);
			if (from < 0 || (mut.after !== null && anchor < 0)) return;
			const [property] = ct.properties.splice(from, 1);
			if (property)
				ct.properties.splice(anchor < from ? anchor + 1 : anchor, 0, property);
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
			if (mut.relationChange !== undefined) {
				const { action, edge } = mut.relationChange;
				const defaultMatches =
					edge.identifier === "parent" &&
					ct.parent_type === edge.targetType &&
					(ct.relationship ?? "child") === edge.relationship;
				if (defaultMatches && action === "remove") {
					delete ct.parent_type;
					delete ct.relationship;
				}
				if (defaultMatches && action === "add") return;
				const relations = (ct.relations ?? []).filter(
					(one) => compareCaseRelations(one, edge) !== 0,
				);
				if (action === "add") relations.push({ ...edge });
				if (relations.length)
					ct.relations = relations.sort(compareCaseRelations);
				else delete ct.relations;
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
