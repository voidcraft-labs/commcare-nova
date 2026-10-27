/**
 * Where an app runs, held at the commit gate: a structural feature the app
 * holds that reads unavailable on a platform it declares
 * (`lib/domain/platforms.ts`) is refused, one finding per use. Expression
 * leaves are the checker's (`platform-unavailable`, which keeps its slot's
 * code); this rule reads structural features.
 *
 * An app rule, scope-exempt, because a declaration change has no module or
 * form footprint and a scoped commit (adding a date-and-time question to one
 * form) must still meet it.
 */

import {
	type BlueprintDoc,
	declaredPlatforms,
	PLATFORM_FEATURE_IDS,
	PLATFORM_FEATURES,
	type Platform,
	type PlatformFeatureUse,
	platformFeatureUses,
	platformRefusalMessage,
	unavailablePlatform,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";

/** A feature the app holds that reads unavailable on a platform it declares
 * (`lib/domain/platforms.ts`), one finding per use. Expression leaves are the
 * checker's (`platform-unavailable`); this rule reads structural features. */
export function platformFeatureAvailability(
	doc: BlueprintDoc,
): ValidationError[] {
	const platforms = declaredPlatforms(doc);
	const features = new Set(
		PLATFORM_FEATURE_IDS.filter(
			(id) =>
				PLATFORM_FEATURES[id].channel === "structure" &&
				unavailablePlatform(id, platforms) !== undefined,
		),
	);
	if (features.size === 0) return [];
	return platformFeatureUses(doc, { features }).map((use) =>
		platformFeatureError(doc, use, platforms),
	);
}

function platformFeatureError(
	doc: BlueprintDoc,
	use: PlatformFeatureUse,
	platforms: readonly Platform[],
): ValidationError {
	const platform = unavailablePlatform(use.feature, platforms);
	if (platform === undefined)
		throw new Error(
			`The platform rule found a use of ${use.feature}, which every platform this app declares runs. Ask platformFeatureUses only for features a declared platform can't run.`,
		);
	const base = { feature: use.feature, platform };
	const message = (subject: string) =>
		platformRefusalMessage({
			feature: use.feature,
			platform,
			platforms,
			subject,
		});
	const owner = use.owner;
	switch (owner.kind) {
		case "app":
			return validationError(
				"PLATFORM_FEATURE_UNAVAILABLE",
				"app",
				message("This app"),
				{},
				{ ...base, connectType: doc.connectType ?? "" },
			);
		case "module": {
			const moduleName = doc.modules[owner.moduleUuid]?.name ?? "";
			return validationError(
				"PLATFORM_FEATURE_UNAVAILABLE",
				"module",
				message(`Module "${moduleName}"`),
				{ moduleUuid: owner.moduleUuid, moduleName },
				base,
			);
		}
		case "field": {
			const moduleName = doc.modules[owner.moduleUuid]?.name ?? "";
			const formName = doc.forms[owner.formUuid]?.name ?? "";
			const fieldId = doc.fields[owner.fieldUuid]?.id ?? "";
			return validationError(
				"PLATFORM_FEATURE_UNAVAILABLE",
				"field",
				message(`Question "${fieldId}" in form "${formName}"`),
				{
					moduleUuid: owner.moduleUuid,
					moduleName,
					formUuid: owner.formUuid,
					formName,
					fieldUuid: owner.fieldUuid,
					fieldId,
				},
				base,
			);
		}
		case "search-input": {
			const module = doc.modules[owner.moduleUuid];
			const moduleName = module?.name ?? "";
			const inputs = module?.caseListConfig?.searchInputs ?? [];
			const index = inputs.findIndex((input) => input.uuid === owner.inputUuid);
			const inputName = inputs[index]?.name ?? "";
			return validationError(
				"PLATFORM_FEATURE_UNAVAILABLE",
				"module",
				message(`Search field "${inputName}" in module "${moduleName}"`),
				{ moduleUuid: owner.moduleUuid, moduleName },
				{
					...base,
					inputUuid: owner.inputUuid,
					inputName,
					slot: `caseListConfig.searchInputs[${index}]`,
				},
			);
		}
		default:
			throw new Error(
				`The platform rule found ${use.feature} on a ${owner.kind}, and no structural feature a declaration can refuse belongs to one. Locate the finding at its owner in rules/platforms.ts.`,
			);
	}
}
