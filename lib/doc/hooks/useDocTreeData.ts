/**
 * useDocTreeData — derive `TreeData` directly from the doc store.
 *
 * Reads entity maps + ordering arrays from the BlueprintDoc store via
 * `useBlueprintDocShallow`, then memoizes the camelCase→snake_case
 * translation into the `TreeData` shape that AppTree and other consumers
 * render.
 *
 * The hook accepts `phase` and `generationData` as parameters (not store
 * subscriptions) so it stays decoupled from the legacy builder store.
 * The caller (`useBuilderTreeData` in `hooks/useBuilder.tsx`) threads
 * those in from the legacy store.
 *
 * During the Ready/Completed phases, TreeData is derived entirely from
 * the doc store's normalized entities. During generation, the hook falls
 * through to `generationData` on the legacy store — scaffold, partial
 * scaffold, and partial modules are generation-only transient state that
 * never enters the doc.
 */

import { useMemo } from "react";
import type { Uuid } from "@/lib/doc/types";
import type { Scaffold } from "@/lib/schemas/blueprint";
import type { TreeData } from "@/lib/services/builder";
import { BuilderPhase } from "@/lib/services/builder";
import type {
	GenerationData,
	PartialModule,
} from "@/lib/services/builderStore";
import type { NQuestion } from "@/lib/services/normalizedState";
import { assembleQuestions } from "@/lib/services/normalizedState";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

/** Parameters threaded in by the caller — not subscribed to by this hook. */
export interface DocTreeInputs {
	phase: BuilderPhase;
	generationData: GenerationData | undefined;
}

/**
 * Derive `TreeData` from the doc store's entity maps.
 *
 * Precedence (matches the old `deriveTreeData` exactly):
 * 1. Normalized entities (Ready/Completed) — camelCase doc → snake_case TreeData
 * 2. Scaffold + partials (during generation) — merged overlay
 * 3. Scaffold alone (Structure stage) — just names
 * 4. Partial scaffold (early Structure) — streaming
 * 5. Undefined — no data yet
 */
export function useDocTreeData({
	phase,
	generationData,
}: DocTreeInputs): TreeData | undefined {
	/* Subscribe to exactly the doc fields the derivation reads. Shallow
	 * equality compares each field by reference — only produces a new `doc`
	 * object when at least one entity map, ordering array, or scalar changes. */
	const doc = useBlueprintDocShallow((s) => ({
		appName: s.appName,
		connectType: s.connectType,
		modules: s.modules,
		forms: s.forms,
		questions: s.questions,
		moduleOrder: s.moduleOrder,
		formOrder: s.formOrder,
		questionOrder: s.questionOrder,
	}));

	return useMemo(() => {
		/* Ready/Completed: derive from normalized doc entities.
		 * The doc uses branded Uuid keys and camelCase fields; TreeData uses
		 * snake_case. The translation mirrors the old deriveTreeData exactly. */
		if (doc.moduleOrder.length > 0 && phase !== BuilderPhase.Generating) {
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
									/* The doc store's QuestionEntity records are keyed by branded
									 * Uuid and structurally identical to NQuestion at runtime
									 * (both camelCase, flat). Cast through `unknown` to bridge
									 * the branded type boundary — same pattern as syncOldFromDoc. */
									doc.questions as unknown as Record<string, NQuestion>,
									doc.questionOrder as unknown as Record<string, string[]>,
									formUuid as string,
								),
								connect: form.connect ?? undefined,
							};
						}),
					};
				}),
			};
		}

		/* Generation phase: use generationData (legacy store) — identical to
		 * the old deriveTreeData. Generation-time transient state (scaffold,
		 * partial scaffold, partial modules) never enters the doc store. */
		if (!generationData) return undefined;

		if (
			generationData.scaffold &&
			Object.keys(generationData.partialModules).length > 0
		) {
			return mergeScaffoldWithPartials(
				generationData.scaffold,
				generationData.partialModules,
			);
		}

		if (generationData.scaffold) return generationData.scaffold;

		if (
			generationData.partialScaffold &&
			generationData.partialScaffold.modules.length > 0
		) {
			return {
				app_name: generationData.partialScaffold.appName ?? "",
				modules: generationData.partialScaffold.modules,
			};
		}

		return undefined;
	}, [doc, phase, generationData]);
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Merge a complete scaffold with partial module data during generation.
 * Creates a TreeData view that overlays received form content onto the
 * scaffold skeleton. Moved from builderSelectors.ts — only used here.
 */
function mergeScaffoldWithPartials(
	scaffold: Scaffold,
	partialModules: Record<number, PartialModule>,
): TreeData {
	return {
		app_name: scaffold.app_name,
		modules: scaffold.modules.map((sm, mIdx) => {
			const partial = partialModules[mIdx];
			return {
				name: sm.name,
				case_type: sm.case_type,
				purpose: sm.purpose,
				case_list_columns:
					partial?.caseListColumns !== undefined
						? partial.caseListColumns
						: undefined,
				forms: sm.forms.map((sf, fIdx) => {
					const assembledForm = partial?.forms[fIdx];
					if (assembledForm) {
						return { ...assembledForm, purpose: sf.purpose };
					}
					return {
						name: sf.name,
						type: sf.type,
						purpose: sf.purpose,
					};
				}),
			};
		}),
	};
}
