/**
 * One-way adapter: BlueprintDoc → legacy builderStore.
 *
 * Subscribes to the doc's entity maps and order arrays and mirrors every
 * change into the old builderStore's equivalent fields. Gives consumers
 * that still read from the old store (Phase 1b has not yet migrated them)
 * a live view of the new doc's truth.
 *
 * Rationale for a one-way sync:
 *   - During Phase 1b, all user-driven and generation-stream entity
 *     mutations flow through `doc.apply()`. The old store never writes
 *     to its own entity maps from within a mutation action (Task 8
 *     removes those writes). The only writer is this adapter, so there
 *     is no reverse path and no loop risk.
 *   - Session fields on the old store (selection, navigation, cursor
 *     mode, generationData) are untouched. Consumers that read those
 *     keep working unchanged.
 *
 * Lifetime:
 *   - `startSyncOldFromDoc(docStore, oldStore)` installs the subscription
 *     and returns a dispose function. The provider calls `start` once
 *     per mount and returns `stop` from its cleanup effect.
 *   - The first subscription tick happens after hydration: both stores
 *     have already been loaded from the same blueprint, so a shallow
 *     reference check short-circuits the projection until a mutation
 *     actually flips an entity map reference. Future mutations are
 *     what this adapter actually buys us.
 *
 * Type-compatibility note:
 *   - `ModuleEntity` / `FormEntity` / `QuestionEntity` (doc) and
 *     `NModule` / `NForm` / `NQuestion` (legacy) use the same camelCase
 *     field names — both omit the nested children arrays and carry a
 *     `uuid`. The doc layer's `toDoc` converter handles snake→camel
 *     conversion at the wire boundary, so by the time entities reach
 *     this adapter they already match the legacy store's expected shape.
 *     We cast through `unknown` only to bypass the branded-`Uuid`
 *     mismatch (doc keys are branded, legacy keys are plain `string`).
 *
 * Phase 3 deletes this file: every consumer migrates to `lib/doc/hooks/**`
 * and the old builder store stops holding blueprint state entirely.
 */

import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import type { BuilderStoreApi } from "@/lib/services/builderStore";

/**
 * Fields we mirror from the doc into the old store. Excludes `appId` and
 * action methods — `appId` is written once by the old store's `loadApp`
 * and doesn't change across mutations, and action methods are not state.
 */
type MirroredSlice = Pick<
	BlueprintDoc,
	| "appName"
	| "connectType"
	| "caseTypes"
	| "modules"
	| "forms"
	| "questions"
	| "moduleOrder"
	| "formOrder"
	| "questionOrder"
>;

/**
 * Extract the subset of the doc state that this adapter cares about.
 * Pulled out so both the subscribe callback and the shallow-equality
 * check operate on the same shape.
 */
function project(state: BlueprintDoc): MirroredSlice {
	return {
		appName: state.appName,
		connectType: state.connectType,
		caseTypes: state.caseTypes,
		modules: state.modules,
		forms: state.forms,
		questions: state.questions,
		moduleOrder: state.moduleOrder,
		formOrder: state.formOrder,
		questionOrder: state.questionOrder,
	};
}

/**
 * Shallow reference equality across all nine mirrored fields. Immer
 * preserves object identity for unchanged entity maps, so this check
 * is both cheap and accurate — if any of the fields has a new reference,
 * at least one underlying entity changed and we must re-project.
 */
function shallowEqualSlice(a: MirroredSlice, b: MirroredSlice): boolean {
	return (
		a.appName === b.appName &&
		a.connectType === b.connectType &&
		a.caseTypes === b.caseTypes &&
		a.modules === b.modules &&
		a.forms === b.forms &&
		a.questions === b.questions &&
		a.moduleOrder === b.moduleOrder &&
		a.formOrder === b.formOrder &&
		a.questionOrder === b.questionOrder
	);
}

/**
 * Install the one-way sync and return a dispose function.
 *
 * Uses a plain `subscribe(listener)` — the default zustand subscription
 * fires on every state change. We then cheap-out on writes via the
 * shallow-equal check inside the callback so unrelated doc changes
 * don't thrash the old store.
 *
 * The legacy store uses Immer middleware, so we freely mutate `draft`
 * inside `setState`. Entity maps are reference-assigned directly — the
 * doc and legacy entity shapes are identical at runtime, and the cast
 * through `unknown` crosses only the branded-`Uuid` vs `string` boundary.
 */
export function startSyncOldFromDoc(
	docStore: BlueprintDocStore,
	oldStore: BuilderStoreApi,
): () => void {
	let prev: MirroredSlice | null = null;

	const unsub = docStore.subscribe((state) => {
		const next = project(state);
		// First tick or real change: write through. On first tick `prev` is
		// null, so we always run the projection once to guarantee parity
		// regardless of whether the old store was pre-hydrated.
		if (prev && shallowEqualSlice(prev, next)) return;
		prev = next;

		oldStore.setState((draft) => {
			// Scalar app-level fields. Map `null` sentinels to the shapes the
			// legacy store expects:
			//   - doc `connectType: null`  → legacy `undefined`
			//   - doc `caseTypes: null`    → legacy `[]` (legacy never stores null)
			draft.appName = next.appName;
			draft.connectType = next.connectType ?? undefined;
			draft.caseTypes = next.caseTypes ?? [];

			// Entity maps and ordering arrays. Cast through `unknown` because
			// the doc keys are branded `Uuid` while the legacy keys are plain
			// `string`; the underlying shapes match.
			draft.modules = next.modules as unknown as typeof draft.modules;
			draft.forms = next.forms as unknown as typeof draft.forms;
			draft.questions = next.questions as unknown as typeof draft.questions;
			draft.moduleOrder =
				next.moduleOrder as unknown as typeof draft.moduleOrder;
			draft.formOrder = next.formOrder as unknown as typeof draft.formOrder;
			draft.questionOrder =
				next.questionOrder as unknown as typeof draft.questionOrder;
		});
	});

	return () => {
		unsub();
		prev = null;
	};
}
