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

import { useContext, useMemo } from "react";
import { useStore } from "zustand";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { LookupActivationState } from "@/lib/doc/lookupReferences";
import { docHasData } from "@/lib/doc/predicates";
import type { CommitOutcome, ConnectConfig, ConnectType } from "@/lib/domain";
import type { MediaKind } from "@/lib/domain/multimedia";
import type { Event } from "@/lib/log/types";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	deriveAgentError,
	deriveAgentStage,
	deriveAttachmentPrep,
	derivePostBuildEdit,
	deriveStatusMessage,
	deriveValidationAttempt,
} from "./lifecycle";
import {
	BuilderSessionContext,
	useBuilderSession,
	useBuilderSessionShallow,
} from "./provider";
import type { AccessPhase, EditScrollMemory, SidebarKind } from "./store";
import { createBuilderSessionStore } from "./store";

export type { AccessPhase } from "./store";

import type {
	GenerationError,
	GenerationStage,
	PreviewCaseTarget,
	PreviewSelectedCase,
	StagedUpload,
} from "./types";

// ── Preview mode ──────────────────────────────────────────────────────────

/** Whether the builder is in preview mode — the canvas runs live instead
 *  of click-to-select editing. */
export function usePreviewing(): boolean {
	return useBuilderSession((s) => s.previewing);
}

/** Atomic preview toggle with sidebar stash/restore — entering closes both
 *  sidebars, leaving restores the stashed layout. */
export function useSetPreviewing(): (on: boolean) => void {
	return useBuilderSession((s) => s.setPreviewing);
}

/** The running-app preview's case target — the case-loading form the case
 *  list feeds and the case selected for it. `undefined` outside a
 *  case-selection flow. PreviewShell reads it to preload the form. */
export function usePreviewCaseTarget(): PreviewCaseTarget | undefined {
	return useBuilderSession((s) => s.previewCaseTarget);
}

/** Setter for the preview case target. The module menu sets the destination
 *  form; the case list's Continue adds the selected case. */
export function useSetPreviewCaseTarget(): (
	target: PreviewCaseTarget | undefined,
) => void {
	return useBuilderSession((s) => s.setPreviewCaseTarget);
}

/** The case currently open in the running-app case list (detail/confirm), or
 *  `undefined`. Drives the breadcrumb's case crumb while on the list. */
export function usePreviewSelectedCase(): PreviewSelectedCase | undefined {
	return useBuilderSession((s) => s.previewSelectedCase);
}

/** Setter for the case open in the running-app case list. */
export function useSetPreviewSelectedCase(): (
	selected: PreviewSelectedCase | undefined,
) => void {
	return useBuilderSession((s) => s.setPreviewSelectedCase);
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
 *  `stashed` is the pre-preview value (or `undefined` if nothing stashed). */
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

/** Composite action: switch the app-level connect mode — one gated batch
 *  (`setConnectType` + each participating form's block), stash lifecycle
 *  included. Returns the commit outcome so the caller's UI can react to
 *  a rejection. See `BuilderSessionState.switchConnectMode`. */
export function useSwitchConnectMode(): (
	type: ConnectType | null | undefined,
	stagedBlocks?: Record<string, ConnectConfig>,
	opts?: { announce?: boolean },
) => CommitOutcome {
	return useBuilderSession((s) => s.switchConnectMode);
}

/** The last Connect mode the app was in before Connect was toggled off —
 *  what a bare re-enable resolves to (falling back to `'learn'`). The
 *  enable flow reads it to know which mode's blocks to collect BEFORE
 *  committing. */
export function useLastConnectType(): ConnectType | undefined {
	return useBuilderSession((s) => s.lastConnectType);
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

// ── Staged media uploads ──────────────────────────────────────────────────

/** The staged upload on one carrier slot, or `undefined` when nothing is
 *  in flight there. Single-asset slots (module icon, app logo) subscribe
 *  with their own slot key. */
export function useStagedUpload(slotKey: string): StagedUpload | undefined {
	return useBuilderSession((s) => s.stagedUploads[slotKey]);
}

/** The staged uploads under one bundle slot, keyed by media kind — the
 *  `Media`-bundle carriers (`MediaSlot`) stage per kind under
 *  `<baseKey>/<kind>`, and this collects every kind in flight there.
 *  Shallow-compared: record references are stable across unrelated store
 *  writes, so a fresh-but-equal pick doesn't re-render the slot. */
export function useStagedUploadsFor(
	baseKey: string,
): Partial<Record<MediaKind, StagedUpload>> {
	const prefix = `${baseKey}/`;
	return useBuilderSessionShallow((s) => {
		const out: Partial<Record<MediaKind, StagedUpload>> = {};
		for (const [key, record] of Object.entries(s.stagedUploads)) {
			if (key.startsWith(prefix)) out[record.kind] = record;
		}
		return out;
	});
}

// ── Focus hint ───────────────────────────────────────────────────────────

/** Transient field key to focus after undo/redo. Read by the editor that
 *  owns the matching field key; cleared on the next selection change. */
export function useSessionFocusHint(): string | undefined {
	return useBuilderSession((s) => s.focusHint);
}

/** Set the transient focus hint — called by undo/redo before the flash. */
export function useSetFocusHint(): (fieldId: string | undefined) => void {
	return useBuilderSession((s) => s.setFocusHint);
}

/** Clear the focus hint — `useSelect` calls this on every selection change
 *  so a hint set for one field can't fire on the next. */
export function useClearFocusHint(): () => void {
	return useBuilderSession((s) => s.clearFocusHint);
}

// ── New field marker ──────────────────────────────────────────────────

/** Whether the given uuid is the just-added field. Drives auto-focus
 *  and select-all on the ID input in FieldIdentitySection. */
export function useIsNewField(uuid: string): boolean {
	return useBuilderSession((s) => s.newFieldUuid === uuid);
}

/** Mark a uuid as newly added. Called by FieldTypePicker after insert. */
export function useMarkNewField(): (uuid: string) => void {
	return useBuilderSession((s) => s.markNewField);
}

/** Clear the new-field marker. Called after the first rename succeeds
 *  or when the header unmounts. */
export function useClearNewField(): () => void {
	return useBuilderSession((s) => s.clearNewField);
}

// ── Edit-canvas scroll memory ─────────────────────────────────────────

/** Setter for a form's remembered edit-canvas scroll state (offset +
 *  measured-row snapshot). `VirtualFormList` calls it on unmount. */
export function useSetEditScroll(): (
	formUuid: string,
	memory: EditScrollMemory,
) => void {
	return useBuilderSession((s) => s.setEditScroll);
}

/** Imperative reader for a form's remembered edit-canvas scroll state.
 *  Returns a stable function (no selector subscription) so reading it to
 *  seed the virtualizer's `initialOffset` + `initialMeasurementsCache`
 *  never triggers a re-render. */
export function useGetEditScroll(): (
	formUuid: string,
) => EditScrollMemory | undefined {
	return useBuilderSession((s) => s.getEditScroll);
}

// ── Generation lifecycle ──────────────────────────────────────────────────
//
// Every public signal here derives from `session.events` + `runCompletedAt`
// + `loading`. No `agentActive` mirror exists — the events buffer IS the
// "a run is in progress" signal (cleared at both `beginRun` and `endRun`,
// so a non-empty buffer implies an active run), and every derived value is
// a pure function of that buffer.

/** Furthest cumulative generation milestone established by the events buffer
 *  — `null` during the askQuestions / thinking window before a mutation. */
export function useAgentStage(): GenerationStage | null {
	const events = useBuilderSession((s) => s.events);
	return useMemo(() => deriveAgentStage(events), [events]);
}

/** Latest classified error on the buffer, or null. */
export function useAgentError(): GenerationError {
	const events = useBuilderSession((s) => s.events);
	return useMemo(() => deriveAgentError(events), [events]);
}

/** Human-readable status text for the current generation stage or error. */
export function useStatusMessage(): string {
	const events = useBuilderSession((s) => s.events);
	return useMemo(() => {
		const stage = deriveAgentStage(events);
		const error = deriveAgentError(events);
		const attempt = deriveValidationAttempt(events);
		return deriveStatusMessage(stage, error, attempt);
	}, [events]);
}

/** Whether the run is reading document attachments right now — the pre-agent
 *  `resolveAttachments` window (resolving asset refs to their stored extracts).
 *  Drives the "Reading your documents" chat status while the first model
 *  token is still blocked. */
export function useAttachmentPrep(): boolean {
	const events = useBuilderSession((s) => s.events);
	return useMemo(() => deriveAttachmentPrep(events), [events]);
}

/** Latest validation-attempt context (attempt number + error count).
 *  Always null now — the validate-fix loop that emitted these annotations
 *  is retired, so no buffer carries them. */
export function useValidationAttempt(): {
	attempt: number;
	errorCount: number;
} | null {
	const events = useBuilderSession((s) => s.events);
	return useMemo(() => deriveValidationAttempt(events), [events]);
}

/** Whether the session's events buffer is currently empty. The buffer is
 *  cleared at both `beginRun()` and `endRun()`, so an empty buffer means
 *  no run is in flight — i.e. the SSE stream has closed. Consumed by
 *  ChatSidebar to gate the Completed → Ready auto-decay timer: the timer
 *  must not arm while the agent is still streaming its closing summary,
 *  otherwise `derivePhase` would briefly flip Completed → Generating
 *  after `acknowledgeCompletion` clears the run stamp. */
export function useSessionEventsEmpty(): boolean {
	return useBuilderSession((s) => s.events.length === 0);
}

/** Whether the current run is a post-build edit — a run is in flight
 *  (non-empty events buffer) and the doc already had data when it
 *  started (`runStartedWithData`, captured at `beginRun`). */
export function usePostBuildEdit(): boolean {
	const events = useBuilderSession((s) => s.events);
	const startedWithData = useBuilderSession((s) => s.runStartedWithData);
	return useMemo(
		() => derivePostBuildEdit(events, startedWithData),
		[events, startedWithData],
	);
}

/** App id for the current builder session.
 *  `undefined` for new builds before the app row is created. */
export function useAppId(): string | undefined {
	return useBuilderSession((s) => s.appId);
}

/** Generic loading flag for async operations outside of agent writes. */
export function useIsLoading(): boolean {
	return useBuilderSession((s) => s.loading);
}

/* Provider-optional fallback for `useCanEdit`. A builder leaf (a form-canvas
 * insertion point, an inline title) is rendered both inside the builder AND in
 * standalone preview-screen unit tests with no `BuilderSessionProvider`. Outside
 * a session there's no shared-app role to honor, so editing is unrestricted —
 * this module-level store reads `canEdit: true` (the factory default) and is
 * never written, so every fallback consumer shares one stable, editable store. */
const FALLBACK_SESSION_STORE = createBuilderSessionStore();

/** Whether this session's user may edit the app — `true` for
 *  editor/admin/owner Project members (including a role-seeded new build),
 *  `false` for viewers. Drives the read-only builder experience: every edit
 *  affordance hides or disables on `false`, and `useAutoSave` refuses to PUT,
 *  so a viewer's stray local change never reaches the server (which would
 *  reject the write as a 404).
 *
 *  Provider-optional: a builder leaf rendered outside a `BuilderSessionProvider`
 *  (a standalone preview, a unit test) reads `true` from the fallback rather
 *  than throwing — read-only is a concept that only exists inside a session. */
export function useCanEdit(): boolean {
	const store = useContext(BuilderSessionContext) ?? FALLBACK_SESSION_STORE;
	return useStore(store, (s) => s.canEdit);
}

/** The optimistic commit gate's dormant-vocabulary activation snapshot —
 *  server-provided with each authorized access payload, INACTIVE until
 *  then. Advisory: the authoritative commit re-reads in-transaction. */
export function useLookupActivation(): LookupActivationState {
	return useBuilderSession((s) => s.activation);
}

/** The lifecycle of the authoritative access tuple. Provider-optional for the
 *  same standalone builder leaves as `useCanEdit`; those default authorized. */
export function useAccessPhase(): AccessPhase {
	const store = useContext(BuilderSessionContext) ?? FALLBACK_SESSION_STORE;
	return useStore(store, (s) => s.accessPhase);
}

/** Monotonic Project-scope generation. Consumers should normally subscribe to
 *  the reconciler reset registry instead; this hook is for status/debug UI. */
export function useProjectScopeEpoch(): number {
	const store = useContext(BuilderSessionContext) ?? FALLBACK_SESSION_STORE;
	return useStore(store, (s) => s.scopeEpoch);
}

/** Whether local work is being held because the latest authorized snapshot is
 *  view-only. The reconciler remains the owner of the actual pending batches. */
export function useHasWaitingAccessChanges(): boolean {
	const store = useContext(BuilderSessionContext) ?? FALLBACK_SESSION_STORE;
	return useStore(store, (s) => s.hasWaitingAccessChanges);
}

// ── Derived ───────────────────────────────────────────────────────────────

/** Derive the canvas mode from the preview flag. Previewing maps to
 *  "preview" (live, interactive); otherwise "edit" (design mode). */
export function useEditMode(): "edit" | "preview" {
	return usePreviewing() ? "preview" : "edit";
}

// ── Phase derivation ─────────────────────────────────────────────────────

/** Session slice required by `derivePhase`. Kept as a struct so unit
 *  tests can pass a minimal shape without a full `BuilderSessionState`. */
export interface DerivePhaseSession {
	loading: boolean;
	runCompletedAt: number | undefined;
	events: readonly Event[];
	runStartedWithData: boolean;
}

/**
 * Derive the builder lifecycle phase from session + doc state.
 *
 * Priority chain (highest wins):
 *   Loading > Completed > Generating > Ready > Idle.
 *
 * - **Loading** — initial hydration (app load).
 * - **Completed** — `runCompletedAt` stamped by `data-done`; cleared
 *   by `acknowledgeCompletion()` after the done-animation settles.
 * - **Generating** — a generation-stage mutation is in the buffer AND
 *   the run opened on an EMPTY doc (`runStartedWithData` false — an
 *   initial build). The run-start capture distinguishes a build from a
 *   post-build edit — both emit the same stage tags (`module:create`,
 *   `form:M-F`), so stage alone is ambiguous. An active run with no
 *   stage yet (the planning / askQuestions window) stays in Idle;
 *   edits stay in Ready while the agent works.
 * - **Ready** — doc has data (a usable blueprint exists).
 * - **Idle** — otherwise (fresh builder, or SA mid-askQuestions with
 *   no doc data yet).
 *
 * Note the lack of an `agentActive` parameter: the buffer is cleared
 * at both `beginRun()` and `endRun()`, so "a non-empty buffer with a
 * generation stage and build foundation" is itself the "generation in
 * progress" signal — no shadow flag needed.
 *
 * Exported for unit testing — components use `useBuilderPhase()`.
 */
export function derivePhase(
	session: DerivePhaseSession,
	docHasData: boolean,
): BuilderPhase {
	if (session.loading) return BuilderPhase.Loading;
	if (session.runCompletedAt !== undefined) return BuilderPhase.Completed;

	const stage = deriveAgentStage(session.events);
	if (stage !== null && !session.runStartedWithData) {
		return BuilderPhase.Generating;
	}
	if (docHasData) return BuilderPhase.Ready;
	return BuilderPhase.Idle;
}

/**
 * Reactive builder phase — derives from session run-lifecycle fields
 * (`loading`, `runCompletedAt`, `events`) plus the doc store's
 * `docHasData` predicate.
 */
export function useBuilderPhase(): BuilderPhase {
	const session = useBuilderSessionShallow((s) => ({
		loading: s.loading,
		runCompletedAt: s.runCompletedAt,
		events: s.events,
		runStartedWithData: s.runStartedWithData,
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
