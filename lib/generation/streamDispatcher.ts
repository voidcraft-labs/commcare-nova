/**
 * Stream event dispatcher — routes server-sent generation events to the
 * appropriate handler: doc mutations, doc lifecycle transitions, or
 * session store updates.
 *
 * This is the Phase 4 replacement for `applyDataPart` in
 * `lib/services/builder.ts`. The key difference is that this dispatcher
 * takes explicit store references (doc store + session store) instead of
 * the legacy `{ store, docStore }` adapter object, and routes doc-mutating
 * events through the pure `toDocMutations` mapper rather than legacy store
 * setters that mixed entity writes with lifecycle state.
 *
 * Three event categories:
 *
 *   1. **Doc mutation events** — `data-schema`, `data-scaffold`,
 *      `data-module-done`, `data-form-done`, `data-form-fixed`,
 *      `data-form-updated`. Mapped to `Mutation[]` via `toDocMutations`
 *      and applied to the doc store as a single atomic batch.
 *
 *   2. **Doc lifecycle events** — `data-done`, `data-blueprint-updated`.
 *      Replace the entire doc via `docStore.load()` and manage undo
 *      tracking state.
 *
 *   3. **Session-only events** — `data-start-build`, `data-phase`,
 *      `data-fix-attempt`, `data-partial-scaffold`, `data-error`,
 *      `data-app-saved`. Pure session store actions with no doc impact.
 *
 * Signal grid energy is injected BEFORE processing so the animation
 * responds immediately to the event arrival, not after the mutation
 * completes.
 */

import { toDoc } from "@/lib/doc/converter";
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import type { PartialScaffoldData } from "@/lib/session/types";
import { signalGrid } from "@/lib/signalGrid/store";
import { toDocMutations } from "./mutationMapper";

// ── Signal grid energy table ────────────────────────────────────────────

/**
 * Inject energy into the signal grid based on event significance.
 *
 * High-energy events (200) are structural milestones — a module or form
 * just completed. Medium-energy (100) are edit replacements. Low-energy
 * (50) are progress markers and intermediate states.
 */
function injectSignalEnergy(type: string): void {
	switch (type) {
		case "data-module-done":
		case "data-form-done":
		case "data-form-fixed":
			signalGrid.injectEnergy(200);
			break;
		case "data-form-updated":
		case "data-blueprint-updated":
			signalGrid.injectEnergy(100);
			break;
		case "data-phase":
		case "data-schema":
		case "data-scaffold":
		case "data-partial-scaffold":
		case "data-fix-attempt":
			signalGrid.injectEnergy(50);
			break;
	}
}

// ── Doc mutation event types ────────────────────────────────────────────

/** Events that produce doc mutations via `toDocMutations`. */
const DOC_MUTATION_EVENTS = new Set([
	"data-schema",
	"data-scaffold",
	"data-module-done",
	"data-form-done",
	"data-form-fixed",
	"data-form-updated",
]);

// ── Partial scaffold parser ─────────────────────────────────────────────

/**
 * Parse raw partial scaffold data into the `PartialScaffoldData` shape.
 *
 * Filters modules and forms that have a `name` — partially streamed
 * scaffold data may have incomplete objects where the LLM hasn't
 * finished producing the name field yet. Returns `undefined` when no
 * valid modules survive the filter.
 */
function parsePartialScaffold(
	data: Record<string, unknown>,
): PartialScaffoldData | undefined {
	const rawModules = data.modules as Array<Record<string, unknown>> | undefined;
	if (!rawModules?.length) return undefined;

	const modules = rawModules
		.filter((m) => m?.name)
		.map((m) => ({
			name: m.name as string,
			case_type: m.case_type as string | undefined,
			purpose: m.purpose as string | undefined,
			forms: ((m.forms as Array<Record<string, unknown>> | undefined) ?? [])
				.filter((f) => f?.name)
				.map((f) => ({
					name: f.name as string,
					type: f.type as string,
					purpose: f.purpose as string | undefined,
				})),
		}));

	if (modules.length === 0) return undefined;

	return {
		appName: data.app_name as string | undefined,
		modules,
	};
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Dispatch a single server-sent stream event to the appropriate handlers.
 *
 * Replaces the legacy `applyDataPart` function. Takes explicit store
 * references so callers don't need an adapter object. Signal grid energy
 * is injected before processing so animations respond immediately.
 *
 * @param type         - stream event type (e.g. "data-scaffold")
 * @param data         - event payload — shape varies by event type
 * @param docStore     - the BlueprintDoc Zustand store
 * @param sessionStore - the BuilderSession Zustand store
 */
export function applyStreamEvent(
	type: string,
	data: Record<string, unknown>,
	docStore: BlueprintDocStoreApi,
	sessionStore: BuilderSessionStoreApi,
): void {
	/* Inject signal grid energy BEFORE processing so the animation
	 * responds to the event arrival, not after mutation completion. */
	injectSignalEnergy(type);

	// ── Category 1: Doc mutation events ──────────────────────────────
	if (DOC_MUTATION_EVENTS.has(type)) {
		const mutations = toDocMutations(type, data, docStore.getState());
		if (mutations.length > 0) {
			docStore.getState().applyMany(mutations);
		}
		return;
	}

	// ── Category 2: Doc lifecycle events ─────────────────────────────
	switch (type) {
		case "data-done": {
			/*
			 * Generation complete. Reconcile the doc against the final
			 * authoritative blueprint — streaming may leave the doc slightly
			 * diverged from the server's canonical result (e.g. silent fix
			 * loop mutations). `load()` replaces the entire doc and clears +
			 * pauses undo history.
			 *
			 * `sessionStore.endAgentWrite()` cascades to `docStore.endAgentWrite()`
			 * internally (resumes undo tracking) AND sets `justCompleted=true`
			 * for the celebration animation.
			 *
			 * TODO Task 17-18: the SA still emits a nested `AppBlueprint` here.
			 * Once the SA is migrated to emit a normalized `BlueprintDoc`,
			 * replace `toDoc(bp, appId)` with the direct `BlueprintDoc` payload
			 * and delete the `toDoc` import. At that point converter.ts can be
			 * fully removed (Task 14).
			 */
			const bp = data.blueprint as AppBlueprint;
			if (bp) {
				const appId = sessionStore.getState().appId ?? "";
				docStore.getState().load(toDoc(bp, appId));
			}
			sessionStore.getState().endAgentWrite();
			return;
		}
		case "data-blueprint-updated": {
			/*
			 * Full blueprint replacement from a post-build edit tool. The SA's
			 * coarse edit tools emit this with the entire new blueprint.
			 *
			 * `load()` replaces the doc and pauses undo. We resume tracking
			 * directly on the doc store — the edit should be undoable. We do
			 * NOT call `sessionStore.endAgentWrite()` because that would set
			 * `justCompleted=true` and trigger a celebration animation. The
			 * `agentActive` flag is cleared separately by the chat status effect.
			 *
			 * TODO Task 17-18: same as data-done — replace toDoc() with the
			 * direct BlueprintDoc payload once the SA emits normalized docs.
			 */
			const bp = data.blueprint as AppBlueprint;
			if (bp) {
				const appId = sessionStore.getState().appId ?? "";
				docStore.getState().load(toDoc(bp, appId));
				docStore.getState().endAgentWrite();
			}
			return;
		}
	}

	// ── Category 3: Session-only events ──────────────────────────────
	switch (type) {
		case "data-start-build":
			/* Begin an agent write stream. Pauses doc undo via the session
			 * store's cascading `beginAgentWrite()` call. No stage arg —
			 * the first `data-phase` event sets the initial stage. */
			sessionStore.getState().beginAgentWrite();
			break;
		case "data-phase":
			sessionStore.getState().advanceStage(data.phase as string);
			break;
		case "data-fix-attempt":
			sessionStore
				.getState()
				.setFixAttempt(data.attempt as number, data.errorCount as number);
			break;
		case "data-partial-scaffold": {
			const parsed = parsePartialScaffold(data);
			sessionStore.getState().setPartialScaffold(parsed);
			break;
		}
		case "data-error":
			sessionStore
				.getState()
				.failAgentWrite(
					data.message as string,
					(data.fatal as boolean) ? "failed" : "recovering",
				);
			break;
		case "data-app-saved":
			sessionStore.getState().setAppId(data.appId as string);
			break;
	}
}
