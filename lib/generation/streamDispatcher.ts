/**
 * Stream event dispatcher — routes server-sent generation events to the
 * appropriate handler: live doc mutation batches, legacy replay-style doc
 * mutation events, doc lifecycle transitions, or session store updates.
 *
 * This is the Phase 4 replacement for `applyDataPart` in
 * `lib/services/builder.ts`. The key difference is that this dispatcher
 * takes explicit store references (doc store + session store) instead of
 * the legacy `{ store, docStore }` adapter object, and routes doc-mutating
 * events through the pure `toDocMutations` mapper rather than legacy store
 * setters that mixed entity writes with lifecycle state.
 *
 * Four event categories (checked in this order):
 *
 *   1. **Live doc mutation batch** — `data-mutations`. Carries a
 *      fine-grained `Mutation[]` produced server-side by
 *      `GenerationContext.emitMutations()`. Applied atomically with no
 *      wire-format translation and no doc-snapshot lookup. This is the
 *      canonical path for every doc-modifying SA emission after Phase 3.
 *
 *   2. **Legacy replay doc mutation events** — `data-schema`,
 *      `data-scaffold`, `data-module-done`, `data-form-done`,
 *      `data-form-fixed`, `data-form-updated`. Coarse snapshot-shaped
 *      events that must be mapped to `Mutation[]` via `toDocMutations`
 *      against the current doc state. Kept for backward compatibility
 *      with historical chat logs that replay through this dispatcher;
 *      the live server (Task 17+) no longer emits these.
 *
 *   3. **Doc lifecycle events** — `data-done`, `data-blueprint-updated`.
 *      Replace the entire doc via `docStore.load()` and manage undo
 *      tracking state.
 *
 *   4. **Session-only events** — `data-start-build`, `data-phase`,
 *      `data-fix-attempt`, `data-partial-scaffold`, `data-error`,
 *      `data-app-saved`. Pure session store actions with no doc impact.
 *
 * Signal grid energy is injected BEFORE processing so the animation
 * responds immediately to the event arrival, not after the mutation
 * completes.
 */

import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain";
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
		case "data-mutations":
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

	// ── Category 1: Live doc mutation batch ──────────────────────────
	//
	// Server emits fine-grained `Mutation[]` directly via
	// `GenerationContext.emitMutations()`. The client applies the batch
	// atomically — no wire-format mapping, no doc-snapshot lookup. This
	// is the live path for every doc-modifying SA emission after Phase 3.
	//
	// The optional `stage` tag on the payload is intentionally ignored
	// here: the live path applies mutations regardless of stage. The
	// Phase 4 generation-log UI consumes `stage` when replaying event
	// streams for debugging.
	if (type === "data-mutations") {
		const mutations = data.mutations as Mutation[] | undefined;
		if (mutations && mutations.length > 0) {
			docStore.getState().applyMany(mutations);
		}
		return;
	}

	// ── Category 2: Legacy replay doc mutation events ────────────────
	//
	// Snapshot-shaped events from historical logs. Mapped through
	// `toDocMutations` against the current doc so the replay produces
	// the same fine-grained `Mutation[]` the live path would have
	// emitted. Kept solely for replay compatibility — the live server
	// no longer emits these event types.
	if (DOC_MUTATION_EVENTS.has(type)) {
		const mutations = toDocMutations(type, data, docStore.getState());
		if (mutations.length > 0) {
			docStore.getState().applyMany(mutations);
		}
		return;
	}

	// ── Category 3: Doc lifecycle events ─────────────────────────────
	switch (type) {
		case "data-done": {
			/*
			 * Generation complete. Reconcile the doc against the final
			 * authoritative snapshot from the SA — streaming may leave the
			 * doc slightly diverged from the server's canonical result (e.g.
			 * silent fix-loop mutations that never surfaced as incremental
			 * events). `load()` replaces the entire doc and clears + pauses
			 * undo history.
			 *
			 * The payload carries the normalized `PersistableDoc` directly;
			 * no wire-format translation happens on the client any more.
			 *
			 * `sessionStore.endAgentWrite()` cascades to `docStore.endAgentWrite()`
			 * internally (resumes undo tracking) AND sets `justCompleted=true`
			 * for the celebration animation.
			 */
			const doc = data.doc as PersistableDoc | undefined;
			if (doc) {
				docStore.getState().load(doc);
			}
			sessionStore.getState().endAgentWrite();
			return;
		}
		case "data-blueprint-updated": {
			/*
			 * Full doc replacement from a post-build edit tool. The SA's
			 * coarse edit tools emit this with the entire new doc.
			 *
			 * `load()` replaces the doc and pauses undo. We resume tracking
			 * directly on the doc store — the edit should be undoable. We do
			 * NOT call `sessionStore.endAgentWrite()` because that would set
			 * `justCompleted=true` and trigger a celebration animation. The
			 * `agentActive` flag is cleared separately by the chat status effect.
			 */
			const doc = data.doc as PersistableDoc | undefined;
			if (doc) {
				docStore.getState().load(doc);
				docStore.getState().endAgentWrite();
			}
			return;
		}
	}

	// ── Category 4: Session-only events ──────────────────────────────
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
