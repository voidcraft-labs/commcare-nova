import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	declaredPlatforms,
	effectiveAppLocalization,
	effectiveCaseTypes,
	featuresNotOffered,
	isStandardCaseListProperty,
	menuFormUuidsOf,
	menuWithInheritedCaseSettings,
	orderedAutomations,
	orderedLocationProperties,
	orderedOrganizationLevels,
	orderedPersonas,
	orderedUserProperties,
	orderedUserTypes,
	parseLanguageTag,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
	STANDARD_CASE_PROPERTY_DESCRIPTIONS,
} from "@/lib/domain";
import { ANDROID_APP_NAMES } from "@/lib/domain/requiredAndroidApps";

import { workerReadiness } from "@/lib/domain/workerReadiness";

/** A map for choosing what to inspect. Field content, expressions, translations
 * and configuration detail belong to scoped reads, not every turn's context. */
export function appOverview(doc: BlueprintDoc) {
	const localization = effectiveAppLocalization(doc.localization);
	const readiness = workerReadiness(doc);
	return {
		appId: doc.appId,
		name: doc.appName,
		...(doc.connectType && { connect: doc.connectType }),
		settings: {
			firstMenuLayout: doc.appSettings.firstMenuLayout ?? "list",
			formMenuLayout: doc.appSettings.formMenuLayout ?? "list",
			showSavedForms: doc.appSettings.showSavedForms,
			showIncompleteForms: doc.appSettings.showIncompleteForms,
			requiredAndroidApps: (doc.appSettings.requiredAndroidApps ?? []).map(
				(app) => ({ app, name: ANDROID_APP_NAMES[app] }),
			),
			/** Every form requests the Android device location; a Connect app's
			 * forms request it whatever this says. */
			captureLocation: doc.appSettings.captureLocation === true,
			/** A new case a form gives the default owner goes to the worker's
			 * one case-sharing group. */
			caseSharing: doc.appSettings.caseSharing === true,
		},
		/** Where workers use the app, and the features that declaration refuses. */
		platforms: declaredPlatforms(doc),
		notOffered: featuresNotOffered(doc),
		standardRecordProperties: Object.entries(
			STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
		).map(([name, type]) => ({
			name,
			type,
			meaning:
				STANDARD_CASE_PROPERTY_DESCRIPTIONS[
					name as keyof typeof STANDARD_CASE_PROPERTY_DESCRIPTIONS
				],
		})),
		caseTypes: effectiveCaseTypes(doc).map((type) => ({
			name: type.name,
			...(type.relations?.length && { links: type.relations }),
			...(type.parent_type && {
				parent: type.parent_type,
				relationship: type.relationship ?? "child",
			}),
			properties: type.properties
				.filter((property) => !isStandardCaseListProperty(property.name))
				.map((property) => ({
					name: property.name,
					...(property.data_type && { type: property.data_type }),
				})),
		})),
		modules: doc.moduleOrder.map((uuid) => {
			// A menu listing another menu's forms takes its case type and
			// selection from that menu, and lists the forms it shows there.
			const module =
				menuWithInheritedCaseSettings(doc, uuid) ?? doc.modules[uuid];
			const source = module.formsFromMenu;
			return {
				uuid,
				name: module.name,
				...(source && {
					formsFromMenu: {
						menuUuid: source.menuUuid,
						name: doc.modules[source.menuUuid]?.name ?? "",
						excludedFormUuids: source.excludedFormUuids ?? [],
					},
				}),
				...(module.purpose && { purpose: module.purpose }),
				...(module.parentModuleUuid && { parentUuid: module.parentModuleUuid }),
				...(module.parentCaseModuleUuid && {
					parentCaseModuleUuid: module.parentCaseModuleUuid,
				}),
				...(module.caseType && { caseType: module.caseType }),
				...(module.caseListConfig && {
					caseList: {
						columns: module.caseListConfig.columns.length,
						search: module.caseListConfig.searchInputs.map(
							(input) => input.name,
						),
						...(module.caseListConfig.selection && {
							selection: module.caseListConfig.selection,
						}),
					},
				}),
				forms: (source
					? menuFormUuidsOf(doc, uuid)
					: (doc.formOrder[uuid] ?? [])
				).map((formUuid) => {
					const form = doc.forms[formUuid];
					return {
						uuid: formUuid,
						name: form.name,
						type: form.type,
						...(form.purpose && { purpose: form.purpose }),
						fields: countFieldsUnder(doc, formUuid),
					};
				}),
			};
		}),
		workerInformation: orderedUserProperties(doc).map(
			({ uuid, slug, label, required }) => ({
				uuid,
				name: slug,
				label,
				...(required && { required }),
			}),
		),
		roles: orderedUserTypes(doc).map(({ uuid, name }) => ({ uuid, name })),
		personas: orderedPersonas(doc).map(({ uuid, name }) => ({ uuid, name })),
		previewReadiness: {
			basis: readiness.basis,
			asMember: readiness.asMember,
			rolesWithoutPersonas: readiness.rolesWithoutPersonas,
			assignmentLevels: readiness.assignmentLevels,
			personasNeedingContext: readiness.personas
				.filter(
					(p) =>
						p.missingRequiredInformation.length ||
						p.locationContext === "no-assigned-place",
				)
				.map(({ uuid, name, missingRequiredInformation, locationContext }) => ({
					uuid,
					name,
					missingRequiredInformation,
					locationContext,
				})),
		},
		organization: {
			levels: orderedOrganizationLevels(doc).map(
				({ uuid, name, parentLevelUuid }) => ({
					uuid,
					name,
					...(parentLevelUuid && { parentUuid: parentLevelUuid }),
				}),
			),
			placeInformation: orderedLocationProperties(doc).map(
				({ uuid, slug, label }) => ({ uuid, name: slug, label }),
			),
		},
		automations: orderedAutomations(doc).map(
			({ uuid, name, kind, caseType }) => ({ uuid, name, kind, caseType }),
		),
		languages: {
			source: parseLanguageTag(localization.sourceLanguage),
			default: parseLanguageTag(localization.defaultLanguage),
			available: localization.languageOrder.map(parseLanguageTag),
		},
	};
}
