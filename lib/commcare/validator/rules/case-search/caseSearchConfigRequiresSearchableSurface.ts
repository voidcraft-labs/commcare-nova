/**
 * Rule: the internal owner-only provenance bit may not coexist with authored
 * Search-action settings when there are no inputs. Explicit `{}` is a valid
 * zero-input Search action: it lets a worker deliberately refresh from the
 * server even when no availability rule narrows the request. The only invalid
 * state is therefore a stale/imported `searchActionEnabled:false` alongside
 * copy or an availability condition that claims a Search action exists.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import { type ValidationError, validationError } from "../../errors";

export function caseSearchConfigRequiresSearchableSurface(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseSearchConfig;
	if (
		config?.searchActionEnabled !== false ||
		(mod.caseListConfig?.searchInputs.length ?? 0) > 0
	) {
		return [];
	}
	const hasSearchSetting =
		config.searchScreenTitle !== undefined ||
		config.searchScreenSubtitle !== undefined ||
		config.searchButtonLabel !== undefined ||
		config.searchButtonDisplayCondition !== undefined;
	if (!hasSearchSetting) return [];

	return [
		validationError(
			"CASE_SEARCH_CONFIG_NO_SEARCHABLE_SURFACE",
			"module",
			`Module "${mod.name}" has Search-action settings while its assigned-case rule says no Search action was authored. Add a search field, enable the Search action, or remove the unused Search settings.`,
			{ moduleUuid, moduleName: mod.name },
		),
	];
}
