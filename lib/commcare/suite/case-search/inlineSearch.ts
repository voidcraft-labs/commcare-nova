import type { RuntimeTarget } from "@/lib/commcare/runtimeTarget";
// lib/commcare/suite/case-search/inlineSearch.ts
//
// The inline shape a search-first module lowers to: CommCare runs the
// search INSIDE each entry that needs a case, so there is no
// `<remote-request>`, no `m{N}_search_*` detail, and no Search action on
// the case list. Each such entry carries the `<query>` immediately before
// the datum that reads its results (`instance('results:inline')`), and the
// claim `<post>` that adopts a picked case the device does not yet hold
// (`app_manager/suite_xml/sections/entries.py::EntriesHelper.add_remote_query_datums`
// / `add_post_to_entry`). `formLinkProjection.ts` places the query in the
// datum list; `compiler.ts` places the post on the entry and merges the
// strings.

import {
	type CaseListConfig,
	effectiveCaseSearchConfig,
	emptyCaseListConfig,
	type Module,
	makeTranslationUnitId,
	moduleOpensOnSearch,
	type OrdinaryCaseSearchConfig,
	type WireStringSource,
} from "@/lib/domain";
import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import type { LookupWireNaming } from "../../lookup/naming";
import type { SessionQuery } from "../../session";
import { compileForPlatform } from "./compileForPlatform";
import { buildSearchQuery } from "./searchSession";
import type { WireShape } from "./types";

export interface InlineSearchEmission {
	readonly query: SessionQuery;
	readonly strings: Record<string, string>;
	readonly translationUnits: Record<string, WireStringSource>;
	readonly wire: WireShape;
}

/** Whether the module lowers to the inline shape. */
export function moduleIsSearchFirst(mod: Module): boolean {
	return moduleOpensOnSearch(mod);
}

/**
 * The `<query>` of a search-first module, ready to sit in a session datum
 * list, with the locale strings its title, description, and prompts
 * reference. `ancestorCaseType` is the parent module's case type when the
 * module's cases are selected under a parent.
 */
export function buildInlineSearch(args: {
	readonly module: Module;
	readonly runtimeTarget?: RuntimeTarget;
	readonly moduleIndex: number;
	readonly typeContext?: TypeContext;
	readonly lookupNaming?: LookupWireNaming;
	readonly ancestorCaseType?: string;
}): InlineSearchEmission {
	const { module: mod, moduleIndex } = args;
	const caseSearchConfig = effectiveCaseSearchConfig(mod);
	if (mod.caseType === undefined || caseSearchConfig?.searchFirst !== true) {
		throw new Error(
			`Tried to build the inline search of module index ${moduleIndex} ("${mod.name}"), but the module is not search-first with a case type. ` +
				"`moduleIsSearchFirst` gates every caller; reaching here means a caller bypassed it.",
		);
	}
	const caseListConfig: CaseListConfig =
		mod.caseListConfig ?? emptyCaseListConfig();
	// Search first is platform-independent, so the platform context is
	// immaterial; `web` is the one every other emitter defaults to.
	const wire = compileForPlatform(caseListConfig, caseSearchConfig, {
		platform: "web",
	});
	const emission = buildSearchQuery({
		caseListConfig,
		caseSearchConfig,
		wire,
		caseType: mod.caseType,
		moduleIndex,
		typeContext: args.typeContext,
		lookupNaming: args.lookupNaming,
		runtimeTarget: args.runtimeTarget,
		ancestorCaseType: args.ancestorCaseType,
	});
	const query: SessionQuery = {
		element: emission.element,
		storageInstance: "results:inline",
		caseType: mod.caseType,
		hasPrompts: emission.hasPrompts,
		defaultSearch: wire.defaultSearch,
		instances: [...emission.instances],
	};
	return {
		query,
		strings: emission.strings,
		translationUnits: {
			...emission.translationUnits,
			...searchScreenTranslationUnits(mod, moduleIndex, caseSearchConfig),
		},
		wire,
	};
}

/**
 * The translation units behind the Search screen's own locale ids: the
 * title (`case_search.m{N}.inputs`), the optional description, and each
 * prompt's label. Shared by the `<remote-request>` and the inline shape,
 * which reference the same ids from their `<query>`.
 */
export function searchScreenTranslationUnits(
	mod: Module,
	moduleIndex: number,
	caseSearchConfig: OrdinaryCaseSearchConfig,
): Record<string, WireStringSource> {
	const moduleId = `m${moduleIndex}`;
	const units: Record<string, WireStringSource> = {
		[`case_search.${moduleId}.inputs`]: makeTranslationUnitId(
			"module",
			mod.uuid,
			"search-title",
		),
		...(caseSearchConfig.searchScreenSubtitle !== undefined
			? {
					[`case_search.${moduleId}.description`]: makeTranslationUnitId(
						"module",
						mod.uuid,
						"search-subtitle",
					),
				}
			: {}),
	};
	for (const input of mod.caseListConfig?.searchInputs ?? []) {
		units[`search_property.${moduleId}.${input.name}`] = makeTranslationUnitId(
			"search-input",
			input.uuid,
			"label",
		);
	}
	return units;
}
