/**
 * Named domain hooks for the BuilderSession store.
 *
 * Components never call `useBuilderSession` with inline selectors — they
 * import a named hook from this file. This enforces a single subscription
 * API (no `select*` vs `derive*` split) and makes call sites greppable.
 *
 * All hooks are "use client" because they subscribe to React context.
 */
"use client";

import type { UIMessage } from "ai";
import { useMemo } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { docHasData } from "@/lib/doc/predicates";
import type { ConnectConfig, ConnectType } from "@/lib/domain";
import type { Event } from "@/lib/log/types";
import { BuilderPhase } from "@/lib/services/builder";
import { useBuilderSession, useBuilderSessionShallow } from "./provider";
import type { SidebarKind } from "./store";
import type {
	CursorMode,
	GenerationError,
	GenerationStage,
	PartialScaffoldData,
} from "./types";

// ── Cursor mode ───────────────────────────────────────────────────────────

/** Current cursor mode — "edit" or "pointer". */
export function useCursorMode(): CursorMode {
	return useBuilderSession((s) => s.cursorMode);
}

/** Atomic mode switch with sidebar stash/restore. Prefer over `useSetCursorMode`
 *  when the mode toggle should preserve sidebar layout state. */
export function useSwitchCursorMode(): (mode: CursorMode) => void {
	return useBuilderSession((s) => s.switchCursorMode);
}

/** Non-atomic cursor mode setter — for forced resets and initialization,
 *  not interactive mode toggles. Does not stash/restore sidebars. */
export function useSetCursorMode(): (mode: CursorMode) => void {
	return useBuilderSession((s) => s.setCursorMode);
}

// ── Active field ──────────────────────────────────────────────────────────

/** Which `[data-field-id]` element currently has focus. `undefined` when no
 *  field is focused. Transient UI hint for undo/redo scroll targeting. */
export function useActiveFieldId(): string | undefined {
	return useBuilderSession((s) => s.activeFieldId);
}

/** Setter for the active field ID. */
export function useSetActiveFieldId(): (fieldId: string | undefined) => void {
	return useBuilderSession((s) => s.setActiveFieldId);
}

// ── Sidebar state ─────────────────────────────────────────────────────────

/** Visibility + stash state for one sidebar. `open` is current visibility;
 *  `stashed` is the pre-pointer-mode value (or `undefined` if nothing stashed). */
export function useSidebarState(kind: SidebarKind): {
	open: boolean;
	stashed: boolean | undefined;
} {
	return useBuilderSessionShallow((s) => s.sidebars[kind]);
}

/** Set one sidebar's visibility. Preserves stash values and the other sidebar. */
export function useSetSidebarOpen(): (
	kind: SidebarKind,
	open: boolean,
) => void {
	return useBuilderSession((s) => s.setSidebarOpen);
}

// ── Connect stash ────────────────────────────────────────────────────────

/** Composite action: switch the app-level connect mode, handling stash
 *  lifecycle and doc mutations atomically. See `BuilderSessionState.switchConnectMode`. */
export function useSwitchConnectMode(): (
	type: ConnectType | null | undefined,
) => void {
	return useBuilderSession((s) => s.switchConnectMode);
}

/** Stash a single form's connect config by uuid. Used by form-level
 *  toggles that disable connect on an individual form. */
export function useStashFormConnect(): (
	mode: ConnectType,
	formUuid: string,
	config: ConnectConfig,
) => void {
	return useBuilderSession((s) => s.stashFormConnect);
}

/** Read a single form's stashed connect config. Returns `undefined` when
 *  no config is stashed for that form+mode combination. Subscribes with
 *  a narrow selector so the component only re-renders when this specific
 *  stash entry changes. */
export function useFormConnectStash(
	mode: ConnectType,
	formUuid: string,
): ConnectConfig | undefined {
	return useBuilderSession((s) => s.connectStash[mode]?.[formUuid]);
}

// ── Focus hint ───────────────────────────────────────────────────────────

/** Transient field key to focus after undo/redo. Consumed once by the
 *  section that owns the matching field key. */
export function useSessionFocusHint(): string | undefined {
	return useBuilderSession((s) => s.focusHint);
}

/** Set the transient focus hint — called by undo/redo before the flash. */
export function useSetFocusHint(): (fieldId: string | undefined) => void {
	return useBuilderSession((s) => s.setFocusHint);
}

/** Clear the focus hint — called by the consuming section after read. */
export function useClearFocusHint(): () => void {
	return useBuilderSession((s) => s.clearFocusHint);
}

// ── New question marker ──────────────────────────────────────────────────

/** Whether the given uuid is the just-added question. Drives auto-focus
 *  and select-all on the ID input in ContextualEditorHeader. */
export function useIsNewField(uuid: string): boolean {
	return useBuilderSession((s) => s.newQuestionUuid === uuid);
}

/** Mark a uuid as newly added. Called by FieldTypePicker after insert. */
export function useMarkNewField(): (uuid: string) => void {
	return useBuilderSession((s) => s.markNewField);
}

/** Clear the new-question marker. Called after the first rename succeeds
 *  or when the header unmounts. */
export function useClearNewField(): () => void {
	return useBuilderSession((s) => s.clearNewField);
}

// ── Generation lifecycle ──────────────────────────────────────────────────

/** Whether the agent is currently streaming a build or edit. */
export function useAgentActive(): boolean {
	return useBuilderSession((s) => s.agentActive);
}

/** Current generation stage — `null` when idle or between stages. */
export function useAgentStage(): GenerationStage | null {
	return useBuilderSession((s) => s.agentStage);
}

/** Error metadata during generation — `null` when no error. */
export function useAgentError(): GenerationError {
	return useBuilderSession((s) => s.agentError);
}

/** Human-readable status text for the current generation stage or error. */
export function useStatusMessage(): string {
	return useBuilderSession((s) => s.statusMessage);
}

/** Whether the current agent activation is editing an existing app
 *  (not initial generation). */
export function usePostBuildEdit(): boolean {
	return useBuilderSession((s) => s.postBuildEdit);
}

/** Firestore app document ID for the current builder session.
 *  `undefined` for new builds before the app document is created. */
export function useAppId(): string | undefined {
	return useBuilderSession((s) => s.appId);
}

/** Intermediate scaffold data streamed before the full Scaffold arrives.
 *  `undefined` when no partial scaffold is available. */
export function usePartialScaffold(): PartialScaffoldData | undefined {
	return useBuilderSession((s) => s.partialScaffold);
}

/** Generic loading flag for async operations outside of agent writes. */
export function useIsLoading(): boolean {
	return useBuilderSession((s) => s.loading);
}

// ── Replay ───────────────────────────────────────────────────────────────

/** Whether the builder is currently in replay mode. */
export function useInReplayMode(): boolean {
	return useBuilderSession((s) => s.replay !== undefined);
}

/**
 * Derives progressive `UIMessage[]` from the replay event log up to the
 * current cursor. Returns the reference-stable empty array sentinel when
 * replay is not loaded.
 *
 * Replaces the pre-rendered `replay.messages` field: messages are now
 * derived on read via `buildReplayMessages`. See that function's docs
 * for the per-event-type mapping rules.
 *
 * Implementation notes — this hook cannot inline `buildReplayMessages`
 * into the Zustand selector. The builder allocates fresh part objects
 * every call, so every selector invocation would return a new reference.
 * React's `useSyncExternalStore` calls `getSnapshot` repeatedly during
 * render to verify snapshot stability; a non-stable snapshot triggers
 * the "getSnapshot should be cached to avoid an infinite loop" warning
 * and an actual infinite loop.
 *
 * The fix: select `{events, cursor}` with shallow equality (both are
 * reference-stable across unrelated store changes — `events` is a
 * frozen-at-load array, `cursor` is a primitive), then `useMemo` the
 * derivation so the built array reference is stable across re-renders
 * that don't touch `events` or `cursor`.
 */
export function useReplayMessages(): UIMessage[] {
	/* Shallow select: returns the same `{events, cursor}` reference when
	 * neither field has changed — which is exactly the condition under
	 * which we want to skip re-deriving. When replay is undefined, both
	 * slots are `undefined` and the `useMemo` below returns the stable
	 * empty-array sentinel. */
	const slice = useBuilderSessionShallow((s) => ({
		events: s.replay?.events,
		cursor: s.replay?.cursor,
	}));
	return useMemo(() => {
		if (!slice.events || slice.cursor === undefined) {
			return EMPTY_REPLAY_MESSAGES;
		}
		return buildReplayMessages(slice.events, slice.cursor);
	}, [slice.events, slice.cursor]);
}

/** Reference-stable empty array — returned when no replay is loaded so
 *  consumers don't re-render on every store tick. */
const EMPTY_REPLAY_MESSAGES: UIMessage[] = [];

/**
 * Pure builder: projects a slice of the event log (up to and including
 * `cursor`) into the `UIMessage[]` shape the chat UI consumes.
 *
 * Walks conversation events sequentially and groups them into messages:
 *   - `user-message` starts a new user `UIMessage` and closes the current
 *     pending assistant message (if any).
 *   - `assistant-text` / `assistant-reasoning` append the corresponding
 *     part to the current assistant message (created lazily the first
 *     time an assistant-produced event appears after a user message).
 *   - `tool-call` appends a `tool-{toolName}` part with
 *     `state: "output-available"`. The state is set eagerly because the
 *     log is written AFTER the agent step runs — there are no partial
 *     states in the log.
 *   - `tool-result` merges `output` into the existing tool-call part
 *     matched by `toolCallId`. No-op when no matching call exists
 *     (tolerates malformed logs).
 *   - `error` appends an `error` part to the current assistant message.
 *     If no assistant message is open, the error opens one (errors
 *     attributed to the agent, not to the user's last turn).
 *
 * Mutation events are skipped entirely — they drive the doc store, not
 * chat. Cursor is clamped implicitly by the loop (`i <= cursor && i <
 * events.length`) so out-of-range values are safe: negative cursors
 * return `[]`; cursors past the end yield all messages.
 *
 * Exported for unit tests — UI callers use `useReplayMessages`.
 *
 * The `UIMessage` parts union in the `ai` SDK is a strict discriminated
 * union parameterized by tool types. Because we project a runtime log
 * that carries arbitrary tool names, we cast the constructed parts
 * through `unknown` at the push sites — the runtime shape matches the
 * SDK's expectations for each variant.
 */
export function buildReplayMessages(
	events: readonly Event[],
	cursor: number,
): UIMessage[] {
	const messages: UIMessage[] = [];
	/* `current` is the assistant message being accumulated. It's nulled
	 * whenever a user-message closes the turn so subsequent assistant
	 * events start a fresh message. */
	let current: UIMessage | null = null;

	const upper = Math.min(cursor, events.length - 1);
	for (let i = 0; i <= upper; i++) {
		const e = events[i];
		/* Mutation events never surface in chat — skip without touching
		 * the assistant accumulator (they don't close the turn). */
		if (e.kind !== "conversation") continue;
		const p = e.payload;

		if (p.type === "user-message") {
			/* Close any open assistant message before the user speaks. */
			if (current) {
				messages.push(current);
				current = null;
			}
			messages.push({
				id: `u-${i}`,
				role: "user",
				parts: [{ type: "text", text: p.text }],
			} as unknown as UIMessage);
			continue;
		}

		/* Lazily open a new assistant message for the first assistant-side
		 * event after a user message (or at the start of the log). */
		if (!current) {
			current = {
				id: `a-${i}`,
				role: "assistant",
				parts: [],
			} as unknown as UIMessage;
		}

		switch (p.type) {
			case "assistant-text":
				current.parts.push({
					type: "text",
					text: p.text,
				} as UIMessage["parts"][number]);
				break;
			case "assistant-reasoning":
				current.parts.push({
					type: "reasoning",
					text: p.text,
				} as UIMessage["parts"][number]);
				break;
			case "tool-call":
				/* Eagerly stamp `output-available` — tool-result events
				 * that arrive later just merge their output into this
				 * same part. If no result ever arrives (malformed log
				 * or mid-run crash), the UI still sees the invocation. */
				current.parts.push({
					type: `tool-${p.toolName}`,
					toolCallId: p.toolCallId,
					toolName: p.toolName,
					input: p.input,
					state: "output-available",
				} as unknown as UIMessage["parts"][number]);
				break;
			case "tool-result": {
				/* Match by toolCallId — the envelope invariant pairs
				 * tool-call + tool-result 1:1 within a run. Defensive
				 * find (no-op on mismatch) tolerates partial logs. */
				const target = current.parts.find(
					(x) => (x as { toolCallId?: string }).toolCallId === p.toolCallId,
				) as { output?: unknown } | undefined;
				if (target) target.output = p.output;
				break;
			}
			case "error":
				current.parts.push({
					type: "error",
					error: p.error.message,
				} as unknown as UIMessage["parts"][number]);
				break;
		}
	}

	/* Flush any open assistant message — the last turn of the log is
	 * usually assistant output that never got a trailing user message. */
	if (current) messages.push(current);
	return messages;
}

// ── Derived ───────────────────────────────────────────────────────────────

/** Derive edit mode from cursor mode. "pointer" maps to "test" (live form
 *  preview); everything else maps to "edit" (design mode). Replaces the
 *  legacy `selectEditMode` selector. */
export function useEditMode(): "edit" | "test" {
	const mode = useCursorMode();
	return mode === "pointer" ? "test" : "edit";
}

// ── Phase derivation ─────────────────────────────────────────────────────

/** Session fields consumed by `derivePhase`. Kept minimal so callers
 *  (including unit tests) don't need a full `BuilderSessionState`. */
interface DerivePhaseSession {
	loading?: boolean;
	justCompleted?: boolean;
	agentActive?: boolean;
	postBuildEdit?: boolean;
	agentStage?: GenerationStage | null;
}

/**
 * Derive the builder lifecycle phase from session + doc state.
 *
 * Priority chain (highest wins):
 *   Loading > Completed > Generating > Ready > Idle.
 *
 * - **Loading** — async setup in progress (initial app load, import).
 * - **Completed** — transient celebration after a successful build/edit;
 *   auto-decays to Ready when the signal grid animation settles.
 * - **Generating** — agent is streaming an initial build. Requires an
 *   explicit generation stage (`agentStage !== null`) so that the brief
 *   window between the chat status effect setting `agentActive` and the
 *   first `data-start-build` event stays in Idle (the SA might be doing
 *   askQuestions, not building). Post-build edits stay in Ready.
 * - **Ready** — a usable blueprint exists in the doc store.
 * - **Idle** — fresh builder with no data and no agent activity.
 *
 * Exported for unit testing — components use `useBuilderPhase()`.
 */
export function derivePhase(
	session: DerivePhaseSession,
	docHasData: boolean,
): BuilderPhase {
	if (session.loading) return BuilderPhase.Loading;
	if (session.justCompleted) return BuilderPhase.Completed;
	/* Generating requires all three: agent active, not a post-build edit,
	 * AND an explicit generation stage. The stage is set by beginAgentWrite
	 * or advanceStage — without it, the agent is still thinking/questioning
	 * and the builder should stay in Idle (centered chat). */
	if (
		session.agentActive &&
		!session.postBuildEdit &&
		session.agentStage != null
	)
		return BuilderPhase.Generating;
	if (docHasData) return BuilderPhase.Ready;
	return BuilderPhase.Idle;
}

/**
 * Reactive builder phase — derived from session lifecycle flags and
 * whether the doc store has any modules. Replaces the legacy store's
 * explicit `phase` field; will fully supersede `useBuilderPhase()` in
 * `hooks/useBuilder.tsx` once T8/T10 completes the migration.
 */
export function useBuilderPhase(): BuilderPhase {
	const session = useBuilderSessionShallow((s) => ({
		loading: s.loading,
		justCompleted: s.justCompleted,
		agentActive: s.agentActive,
		postBuildEdit: s.postBuildEdit,
		agentStage: s.agentStage,
	}));
	/* Single-source predicate — see `lib/doc/predicates.ts::docHasData`.
	 * Identical to `useDocHasData`, inlined here to avoid coupling the
	 * phase derivation to a second reactive hook. */
	const hasData = useBlueprintDoc(docHasData);
	return derivePhase(session, hasData);
}

/**
 * Whether the builder has a usable blueprint — covers both `Ready` and
 * the transient `Completed` celebration phase. Gate on this (not
 * `phase === Ready`) when checking "has a usable blueprint".
 */
export function useBuilderIsReady(): boolean {
	const phase = useBuilderPhase();
	return phase === BuilderPhase.Ready || phase === BuilderPhase.Completed;
}
