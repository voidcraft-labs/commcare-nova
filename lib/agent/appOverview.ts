import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	orderedAutomations,
	orderedLocationProperties,
	orderedOrganizationLevels,
	orderedPersonas,
	orderedUserProperties,
	orderedUserTypes,
	parseLanguageTag,
} from "@/lib/domain";

/** A map for choosing what to inspect. Field content, expressions, translations
 * and configuration detail belong to scoped reads, not every turn's context. */
export function appOverview(doc: BlueprintDoc) {
	const localization = effectiveAppLocalization(doc.localization);
	return {
		appId: doc.appId,
		name: doc.appName,
		...(doc.connectType && { connect: doc.connectType }),
		caseTypes: (doc.caseTypes ?? []).map((type) => ({
			name: type.name,
			...(type.parent_type && { parent: type.parent_type }),
			properties: type.properties.map((property) => ({
				name: property.name,
				...(property.data_type && { type: property.data_type }),
			})),
		})),
		modules: doc.moduleOrder.map((uuid) => {
			const module = doc.modules[uuid];
			return {
				uuid,
				name: module.name,
				...(module.purpose && { purpose: module.purpose }),
				...(module.parentModuleUuid && { parentUuid: module.parentModuleUuid }),
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
				forms: (doc.formOrder[uuid] ?? []).map((formUuid) => {
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
			({ uuid, slug, label }) => ({ uuid, name: slug, label }),
		),
		roles: orderedUserTypes(doc).map(({ uuid, name }) => ({ uuid, name })),
		personas: orderedPersonas(doc).map(({ uuid, name }) => ({ uuid, name })),
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
