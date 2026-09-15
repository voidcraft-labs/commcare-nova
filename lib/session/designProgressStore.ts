"use client";
import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
	type AppPlanProjection,
	authoringPlanFrameSchema,
	authoringProgressSchema,
	type DesignBuildStage,
	type DesignSessionScope,
	type DesignSessionSeed,
	designStageIsWorking,
	designStageLabel,
} from "@/lib/generation/designProgressWire";

interface ProgressData {
	designSessionId: string | null;
	materializedAppId: string | null;
	revision: number;
	plan: AppPlanProjection | null;
	stage: DesignBuildStage | null;
	awaitingInput: boolean;
	failure: { message: string; recoverable: boolean } | null;
}
export interface DesignProgressState extends ProgressData {
	seedSession(seed: DesignSessionSeed): void;
	beginSession(scope: DesignSessionScope): void;
	applyProgressFrame(type: string, data: unknown): boolean;
	markMaterialized(appId: string): void;
	noteTurnOpened(): void;
	setAwaitingInput(awaiting: boolean): void;
	markFailed(message: string, options: { recoverable: boolean }): void;
	reset(): void;
}
const EMPTY: ProgressData = {
	designSessionId: null,
	materializedAppId: null,
	revision: 0,
	plan: null,
	stage: null,
	awaitingInput: false,
	failure: null,
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
				stage: seed.stage,
				revision: seed.revision,
				plan: seed.plan ?? null,
			});
		},
		beginSession(scope) {
			const current = get();
			if (current.designSessionId !== scope.designSessionId) {
				set({ ...EMPTY, ...scope });
				return;
			}
			set({
				materializedAppId: scope.materializedAppId ?? current.materializedAppId,
				awaitingInput: false,
				failure: null,
			});
		},
		applyProgressFrame(type, data) {
			const state = get();
			if (type === "data-authoring-progress") {
				const parsed = authoringProgressSchema.safeParse(data);
				if (
					!parsed.success ||
					parsed.data.sessionId !== state.designSessionId ||
					parsed.data.revision <= state.revision
				)
					return true;
				const { revision, stage } = parsed.data;
				set({
					revision,
					stage,
					failure: null,
					awaitingInput: stage === "needs-input",
				});
				return true;
			}
			if (type === "data-authoring-plan") {
				const parsed = authoringPlanFrameSchema.safeParse(data);
				if (!parsed.success || parsed.data.sessionId !== state.designSessionId)
					return true;
				const plan = parsed.data.plan;
				if (
					!state.plan ||
					plan.revision > state.plan.revision ||
					(plan.revision === state.plan.revision &&
						(plan.reviewedRevision ?? 0) > (state.plan.reviewedRevision ?? 0))
				)
					set({ plan });
				return true;
			}
			return false;
		},
		markMaterialized(materializedAppId) {
			set({ materializedAppId });
		},
		noteTurnOpened() {
			const current = get();
			if (current.stage === "ready") {
				set({ ...EMPTY });
				return;
			}
			set({
				stage:
					current.stage && designStageIsWorking(current.stage)
						? current.stage
						: current.materializedAppId
							? "building"
							: "planning",
				failure: null,
				awaitingInput: false,
			});
		},
		setAwaitingInput(awaitingInput) {
			if (get().awaitingInput !== awaitingInput) set({ awaitingInput });
		},
		markFailed(message, { recoverable }) {
			if (get().stage !== "ready") set({ failure: { message, recoverable } });
		},
		reset() {
			set({ ...EMPTY });
		},
	}));
}
export function deriveDesignStage(
	state: ProgressData,
): DesignBuildStage | null {
	if (!state.designSessionId) return null;
	if (state.failure) return state.failure.recoverable ? "incomplete" : "failed";
	if (state.awaitingInput) return "needs-input";
	return state.stage ?? "planning";
}
export interface DesignProgressView {
	readonly active: boolean;
	readonly designSessionId: string | null;
	readonly stage: DesignBuildStage | null;
	readonly stageLabel: string | null;
	readonly working: boolean;
	readonly plan: AppPlanProjection | null;
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
		stageLabel: stage ? designStageLabel(stage) : null,
		working: stage !== null && designStageIsWorking(stage),
		plan: state.plan,
		materialized: state.materializedAppId !== null,
		failure: state.failure?.message ?? null,
	};
}
export function useDesignProgressView(
	store: DesignProgressStoreApi,
): DesignProgressView {
	const state = useStore(store);
	return useMemo(() => deriveDesignProgressView(state), [state]);
}
