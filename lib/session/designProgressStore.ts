/**
 * Design-build progress store — the pre-materialization conversation's own
 * view of a design session (§15.1–§15.4).
 *
 * Deliberately NOT part of the builder session store: that store describes an
 * APP being edited (preview mode, sidebars, the run event buffer), and a
 * design build has no app yet. This one holds exactly the durable projections
 * the orchestrator streams — the reviewed-design outline, the build plan's
 * slice names, which slices have committed — plus the two facts only the
 * client can observe (a paused question round, a fatal stream error).
 *
 * Stage is DERIVED, never stored: `deriveDesignStage` folds "which frames have
 * arrived" into the §15.2 vocabulary, so the display cannot disagree with the
 * durable events it was fed. Every frame is validated through
 * `lib/generation/designProgressWire` before it lands, and an invalid or
 * foreign-session frame is dropped rather than half-applied.
 *
 * One instance per mounted conversation (`ChatContainer` owns it); switching
 * threads resets it, because a different conversation is a different design.
 */

import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
	type BuildCompletionProjection,
	type BuildPlanSummaryProjection,
	type BuildSliceStartedProjection,
	type DesignBuildStage,
	type DesignOutlineProjection,
	type DesignPulsePhase,
	type DesignSessionScope,
	type DesignSessionSeed,
	designPulseStage,
	designStageIsWorking,
	designStageLabel,
	parseBuildCompletion,
	parseBuildPlanSummary,
	parseBuildSliceCommitted,
	parseBuildSliceStarted,
	parseDesignOutline,
	parseDesignPulse,
} from "@/lib/generation/designProgressWire";

// ── State ──────────────────────────────────────────────────────────

export interface DesignProgressState {
	/** The conversation's design session, or null before its first turn's
	 *  `data-design-session` frame (and for an app-born edit thread). */
	designSessionId: string | null;
	/** The app this session materialized, once it has. Null while the build
	 *  is still pre-app — the signal that separates "building the first
	 *  workflow" from every later slice. */
	materializedAppId: string | null;
	outline: DesignOutlineProjection | null;
	plan: BuildPlanSummaryProjection | null;
	/** The slice currently being built, from the last `slice-started` frame
	 *  that has not yet committed. */
	activeSlice: BuildSliceStartedProjection | null;
	/** Committed slices in commit order. The materialization root emits the
	 *  same progress projection as later slices, in addition to its strict
	 *  activation receipt. */
	committedSlices: readonly BuildSliceStartedProjection[];
	completion: BuildCompletionProjection | null;
	/** The design-pipeline phase whose model call the server last reported
	 *  streaming (`data-design-pulse`). The live refinement of the design
	 *  span: it names reviewing/revising/planning while those calls run,
	 *  which no durable frame does until the phase has finished. Cleared at
	 *  every turn boundary — a pulse describes only the stream it rode. */
	pulsePhase: DesignPulsePhase | null;
	/** The pulse's sub-step label, when the server derived one from a
	 *  streaming submission's keys ("Working out the records"). Lives and
	 *  dies with `pulsePhase`. */
	pulseStep: string | null;
	/** The run paused on a blocking question round (§15.8). Observed from the
	 *  transcript, which is the only place the pause is visible client-side. */
	awaitingInput: boolean;
	/** An error this turn reported — ANY design-run error stops the run, so
	 *  either kind must halt the stage line (§15.12: a spinner over a dead
	 *  run is the forbidden dishonesty — observed live on a recoverable
	 *  failure whose toast said "retry" while the stage kept working).
	 *  `recoverable` picks the stage: a retryable stop reads `incomplete`
	 *  ("Stopped before it finished"), a fatal one `failed`. Cleared when
	 *  the next turn opens. */
	failure: {
		message: string;
		recoverable: boolean;
	} | null;
	/** The stage the SERVER derived when the page loaded a design session with
	 *  no run in flight (`deriveDesignBuildStage` over the durable session +
	 *  orchestration head). It is the floor the fold falls back to before any
	 *  frame arrives, so a resumed design says where it actually stopped
	 *  instead of pretending a fresh turn is running. A live turn supersedes
	 *  it the moment its scope frame lands. */
	seededStage: DesignBuildStage | null;
	/** Seed a cold page load of an existing design session. There is no
	 *  client-side re-derivation of the outline or plan — those live only in
	 *  the frames a run streams — so this carries the stage and nothing
	 *  else. */
	seedSession: (seed: DesignSessionSeed) => void;
	/** Open (or re-open) a design session's scope. Idempotent for the same
	 *  id — a stream replay re-delivers this frame — and a clean reset when
	 *  the id changes. Clears a previous turn's failure. */
	beginSession: (scope: DesignSessionScope) => void;
	/** Route one `data-*` frame. Returns whether the type was a design
	 *  progress frame at all, so the caller knows it was consumed; an
	 *  unparseable or foreign-session payload is dropped and still counts as
	 *  consumed (there is nothing else that could read it). */
	applyProgressFrame: (type: string, data: unknown) => boolean;
	/** The first workflow committed and the app exists. */
	markMaterialized: (appId: string) => void;
	/** A turn is on its way to the server. Retires the page-load snapshot the
	 *  moment it stops describing the present, so a resumed design cannot keep
	 *  saying "waiting on your answer" over an answer already being sent. The
	 *  turn's own scope frame follows within the same stream. */
	noteTurnOpened: () => void;
	setAwaitingInput: (awaiting: boolean) => void;
	markFailed: (message: string, opts: { recoverable: boolean }) => void;
	reset: () => void;
}

const EMPTY: Omit<
	DesignProgressState,
	| "seedSession"
	| "beginSession"
	| "applyProgressFrame"
	| "markMaterialized"
	| "noteTurnOpened"
	| "setAwaitingInput"
	| "markFailed"
	| "reset"
> = {
	designSessionId: null,
	materializedAppId: null,
	outline: null,
	plan: null,
	activeSlice: null,
	committedSlices: [],
	completion: null,
	pulsePhase: null,
	pulseStep: null,
	awaitingInput: false,
	failure: null,
	seededStage: null,
};

export type DesignProgressStoreApi = ReturnType<
	typeof createDesignProgressStore
>;

export function createDesignProgressStore() {
	return createStore<DesignProgressState>()((set, get) => ({
		...EMPTY,

		seedSession(seed) {
			set({
				...EMPTY,
				designSessionId: seed.designSessionId,
				materializedAppId: seed.materializedAppId,
				seededStage: seed.stage,
			});
		},

		beginSession(scope: DesignSessionScope) {
			const current = get();
			if (current.designSessionId !== scope.designSessionId) {
				set({
					...EMPTY,
					designSessionId: scope.designSessionId,
					materializedAppId: scope.materializedAppId,
				});
				return;
			}
			set({
				/* A materialized id never goes back to null: the app exists. A
				 * replayed frame from before materialization must not un-say it. */
				materializedAppId: scope.materializedAppId ?? current.materializedAppId,
				awaitingInput: false,
				failure: null,
				/* A pulse describes only the stream it rode on. */
				pulsePhase: null,
				pulseStep: null,
				/* This turn is live; the page-load snapshot no longer describes it. */
				seededStage: null,
			});
		},

		applyProgressFrame(type: string, data: unknown): boolean {
			const state = get();
			const sessionId = state.designSessionId;
			switch (type) {
				case "data-design-outline": {
					if (sessionId === null) return true;
					const outline = parseDesignOutline(data, sessionId);
					if (outline !== null) set({ outline });
					return true;
				}
				case "data-build-plan-summary": {
					if (sessionId === null) return true;
					const plan = parseBuildPlanSummary(data, sessionId);
					if (plan !== null) set({ plan });
					return true;
				}
				case "data-design-pulse": {
					if (sessionId === null) return true;
					const pulse = parseDesignPulse(data, sessionId);
					if (pulse !== null) {
						set({ pulsePhase: pulse.phase, pulseStep: pulse.step ?? null });
					}
					return true;
				}
				case "data-build-slice-started": {
					if (sessionId === null) return true;
					const slice = parseBuildSliceStarted(data, sessionId);
					if (slice !== null) {
						set({
							activeSlice: slice,
							/* A slice start is durable evidence that planning ended. Do
							 * not render the last design pulse (for example "Assigning
							 * ownership") under live build work. */
							pulsePhase: null,
							pulseStep: null,
						});
					}
					return true;
				}
				case "data-build-slice-committed": {
					if (sessionId === null) return true;
					const slice = parseBuildSliceCommitted(data, sessionId);
					if (slice === null) return true;
					set({
						activeSlice:
							state.activeSlice?.sliceId === slice.sliceId
								? null
								: state.activeSlice,
						committedSlices: appendSlice(state.committedSlices, slice),
					});
					return true;
				}
				case "data-build-completion": {
					if (sessionId === null) return true;
					const completion = parseBuildCompletion(data, sessionId);
					if (completion !== null) {
						set({ completion, activeSlice: null, awaitingInput: false });
					}
					return true;
				}
				default:
					return false;
			}
		},

		markMaterialized(appId: string) {
			const state = get();
			if (state.materializedAppId === appId) return;
			/* Compatibility for a replay produced before the root began emitting
			 * a committed projection. Only fold the active slice when the plan
			 * proves it is the first slice; a delayed activation receipt must never
			 * clear or falsely commit a later slice. */
			const legacyMaterializationRoot =
				state.activeSlice !== null &&
				state.committedSlices.length === 0 &&
				state.plan?.sliceNames[0] === state.activeSlice.sliceName;
			set({
				materializedAppId: appId,
				activeSlice: legacyMaterializationRoot ? null : state.activeSlice,
				committedSlices:
					legacyMaterializationRoot && state.activeSlice !== null
						? appendSlice(state.committedSlices, state.activeSlice)
						: state.committedSlices,
			});
		},

		noteTurnOpened() {
			const current = get();
			/* Completion belongs to the build turn that produced it. A later edit
			 * returns to the ordinary chat status until the server explicitly opens
			 * another design session; it must not keep saying the app is ready while
			 * that edit is running. */
			if (current.completion !== null) {
				set({ ...EMPTY });
				return;
			}
			if (
				current.seededStage === null &&
				current.failure === null &&
				current.pulsePhase === null &&
				!current.awaitingInput
			)
				return;
			set({
				seededStage: null,
				failure: null,
				pulsePhase: null,
				pulseStep: null,
				awaitingInput: false,
			});
		},

		setAwaitingInput(awaiting: boolean) {
			if (get().awaitingInput === awaiting) return;
			set({ awaitingInput: awaiting });
		},

		markFailed(message: string, opts: { recoverable: boolean }) {
			set({
				failure: {
					message,
					recoverable: opts.recoverable,
				},
				activeSlice: null,
			});
		},

		reset() {
			set({ ...EMPTY });
		},
	}));
}

function appendSlice(
	slices: readonly BuildSliceStartedProjection[],
	slice: BuildSliceStartedProjection,
): readonly BuildSliceStartedProjection[] {
	return slices.some((entry) => entry.sliceId === slice.sliceId)
		? slices
		: [...slices, { sliceId: slice.sliceId, sliceName: slice.sliceName }];
}

// ── Derivations ────────────────────────────────────────────────────

/**
 * Fold the arrived frames into the §15.2 stage. The order is the priority
 * chain: a client-observed halt (failure, pause) outranks progress, and
 * progress outranks the design phase it came from.
 *
 * The design pipeline is internally convergent, so `understanding` covers
 * everything up to the first outline — that is exactly what the durable
 * frames say, and inventing a finer story would be a client-side state
 * machine, which §15.2 forbids.
 */
export function deriveDesignStage(
	state: Pick<
		DesignProgressState,
		| "designSessionId"
		| "materializedAppId"
		| "outline"
		| "plan"
		| "activeSlice"
		| "committedSlices"
		| "completion"
		| "pulsePhase"
		| "awaitingInput"
		| "failure"
		| "seededStage"
	>,
): DesignBuildStage | null {
	if (state.designSessionId === null) return null;
	if (state.failure !== null) {
		/* Both kinds STOP the line — a recoverable stop invites the retry the
		 * toast offered; a fatal one says the design is done for. */
		return state.failure.recoverable ? "incomplete" : "failed";
	}
	if (state.awaitingInput) return "needs-input";
	if (state.completion !== null) return "ready";
	/* A later user adjustment can reopen design after one or more slices have
	 * already committed. The live server pulse describes what is happening NOW
	 * and must outrank that historical build progress; otherwise a review or
	 * revision falsely keeps saying "Building your app." A real slice start
	 * clears the pulse in `applyProgressFrame`, so current build work still
	 * takes over immediately and no stale design label can survive it. */
	if (state.pulsePhase !== null) return designPulseStage(state.pulsePhase);
	if (state.activeSlice !== null || state.committedSlices.length > 0) {
		return state.materializedAppId === null
			? "building-first-workflow"
			: "building";
	}
	if (state.plan !== null) return "planning";
	if (state.outline !== null) return "designing";
	/* No frame has said anything yet: the server's load-time derivation, or
	 * the first stage of a turn that has only just opened. */
	return state.seededStage ?? "understanding";
}

/** "2 of 5 planned workflows committed" — offered ONLY while the current
 *  build plan is still active (§15.2). A finished, failed, or paused run has
 *  no live plan to count against. */
export function deriveSliceProgress(
	state: Pick<
		DesignProgressState,
		"plan" | "committedSlices" | "completion" | "failure" | "awaitingInput"
	>,
): { committed: number; planned: number } | null {
	if (state.plan === null) return null;
	if (state.completion !== null || state.failure !== null) return null;
	if (state.awaitingInput) return null;
	return {
		committed: Math.min(state.committedSlices.length, state.plan.sliceCount),
		planned: state.plan.sliceCount,
	};
}

/** Everything the progress region renders, derived in one place so the panel
 *  holds no logic of its own. */
export interface DesignProgressView {
	/** There is a design session worth reporting on. */
	readonly active: boolean;
	readonly designSessionId: string | null;
	readonly stage: DesignBuildStage | null;
	readonly stageLabel: string | null;
	/** Work is still moving — the spinner-vs-mark choice, never the meaning. */
	readonly working: boolean;
	/** The live sub-step under the stage line ("Working out the records"),
	 *  present only while design-phase work is streaming. */
	readonly pulseStep: string | null;
	readonly outline: DesignOutlineProjection | null;
	readonly plannedSliceNames: readonly string[];
	readonly sliceProgress: { committed: number; planned: number } | null;
	readonly currentSliceName: string | null;
	readonly committedSliceNames: readonly string[];
	/** The app exists: the normal builder is mounted and this region collapses
	 *  to a brief per-slice line (§15.7). */
	readonly materialized: boolean;
	readonly failure: string | null;
}

export function deriveDesignProgressView(
	state: DesignProgressState,
): DesignProgressView {
	const stage = deriveDesignStage(state);
	return {
		active: stage !== null,
		designSessionId: state.designSessionId,
		stage,
		stageLabel: stage === null ? null : designStageLabel(stage),
		working: stage !== null && designStageIsWorking(stage),
		pulseStep:
			state.pulsePhase !== null &&
			stage === designPulseStage(state.pulsePhase) &&
			designStageIsWorking(stage)
				? state.pulseStep
				: null,
		outline: state.outline,
		plannedSliceNames: state.plan?.sliceNames ?? [],
		sliceProgress: deriveSliceProgress(state),
		currentSliceName: state.activeSlice?.sliceName ?? null,
		committedSliceNames: state.committedSlices.map((slice) => slice.sliceName),
		materialized: state.materializedAppId !== null,
		failure: state.failure?.message ?? null,
	};
}

/** The named hook every consumer uses — no inline selectors at call sites.
 *  Zustand hands back a stable state object between writes, so the
 *  derivation memoizes on it. */
export function useDesignProgressView(
	store: DesignProgressStoreApi,
): DesignProgressView {
	const state = useStore(store);
	return useMemo(() => deriveDesignProgressView(state), [state]);
}
