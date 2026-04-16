/**
 * useDocTreeData — derive `TreeData` directly from the doc store.
 *
 * Reads entity maps + ordering arrays from the BlueprintDoc store via
 * `useBlueprintDocShallow`, then memoizes the camelCase→snake_case
 * translation into the `TreeData` shape that AppTree and other consumers
 * render.
 *
 * In the new model (Phase 4), scaffold modules are created as real doc
 * mutations by the mutation mapper — so the doc IS the progressive
 * generation state. Doc-based derivation works during BOTH generation
 * and Ready phases. The only fallback is `partialScaffold` for the
 * brief pre-scaffold window when the SA is streaming module/form names
 * but the full Scaffold hasn't arrived yet.
 */

import { useMemo } from "react";
import type { Uuid } from "@/lib/doc/types";
import type { TreeData } from "@/lib/services/builder";
import type { NQuestion } from "@/lib/services/normalizedState";
import { assembleQuestions } from "@/lib/services/normalizedState";
import type { PartialScaffoldData } from "@/lib/session/types";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

/**
 * Derive `TreeData` from the doc store's entity maps.
 *
 * Precedence:
 * 1. Doc entities (works during generation AND Ready/Completed) — camelCase → snake_case
 * 2. Partial scaffold (early generation, before scaffold creates doc entities) — streaming names
 * 3. Undefined — no data yet
 *
 * @param partialScaffold - Intermediate scaffold data streamed before the
 *   full Scaffold arrives. Only used as a fallback when the doc has no
 *   modules yet (the brief window before `setScaffold` creates doc entities).
 */
export function useDocTreeData(
	partialScaffold?: PartialScaffoldData,
): TreeData | undefined {
	/* Subscribe to exactly the doc fields the derivation reads. Shallow
	 * equality compares each field by reference — only produces a new `doc`
	 * object when at least one entity map, ordering array, or scalar changes. */
	const doc = useBlueprintDocShallow((s) => ({
		appName: s.appName,
		connectType: s.connectType,
		modules: s.modules,
		forms: s.forms,
		fields: s.fields,
		moduleOrder: s.moduleOrder,
		formOrder: s.formOrder,
		fieldOrder: s.fieldOrder,
	}));

	return useMemo(() => {
		/* Doc has modules → derive from normalized entities. This works during
		 * BOTH generation (scaffold modules are doc entities via mutation mapper)
		 * and Ready/Completed phases. The doc uses branded Uuid keys and camelCase
		 * fields; TreeData uses snake_case. */
		if (doc.moduleOrder.length > 0) {
			return {
				app_name: doc.appName,
				connect_type: doc.connectType ?? undefined,
				modules: doc.moduleOrder.map((moduleUuid: Uuid) => {
					const mod = doc.modules[moduleUuid];
					const formUuids = doc.formOrder[moduleUuid] ?? [];
					return {
						name: mod.name,
						case_type: mod.caseType,
						purpose: mod.purpose,
						case_list_columns: mod.caseListColumns,
						case_detail_columns: mod.caseDetailColumns,
						forms: formUuids.map((formUuid: Uuid) => {
							const form = doc.forms[formUuid];
							return {
								name: form.name,
								type: form.type,
								purpose: form.purpose,
								questions: assembleQuestions(
									/* The doc store's field records are keyed by branded
									 * Uuid and structurally identical to NQuestion at runtime
									 * (both camelCase, flat). Cast through `unknown` to bridge
									 * the branded type boundary — same pattern as syncOldFromDoc. */
									doc.fields as unknown as Record<string, NQuestion>,
									doc.fieldOrder as unknown as Record<string, string[]>,
									formUuid as string,
								),
								connect: form.connect ?? undefined,
							};
						}),
					};
				}),
			};
		}

		/* Fallback: partial scaffold during early generation — the SA is
		 * streaming module/form names but the full Scaffold hasn't arrived
		 * yet, so no doc entities exist. */
		if (partialScaffold?.modules.length) {
			return {
				app_name: partialScaffold.appName ?? "",
				modules: partialScaffold.modules,
			};
		}

		return undefined;
	}, [doc, partialScaffold]);
}
