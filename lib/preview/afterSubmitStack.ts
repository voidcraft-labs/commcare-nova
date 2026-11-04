// lib/preview/afterSubmitStack.ts
//
// The stack of after-submit frames a running session holds, as CommCare
// Core's session holds it. A submission pushes every frame whose condition
// holds, in emitted order, and the frame pushed last runs first
// (`session/CommCareSession.java::finishExecuteAndPop` →
// `finishAndPop`). When frames remain beneath the one that pops, the popped
// frame's steps become a snapshot (`SessionFrame.java::captureSnapshot`),
// and at the next completion every remaining frame is dropped when the
// worker's path no longer begins with it (`CommCareSession.java::cleanStack`
// over `SessionFrame.java::isSnapshotIncompatible`). Formplayer rebuilds its
// session from the frame on top and keeps nothing beneath it
// (`services/MenuSessionFactory.java::rebuildSessionFromFrame` →
// `session/MenuSession.java::resetSession`), which is the `"top"` mode.
//
// Pure: no React, no store. Preview's form screen and App Tests both read it,
// each with its own route type.

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { moduleParent } from "@/lib/domain/moduleHierarchy";
import type { PreviewPlatformRules } from "./platform";

/** One step of a session path, as Core's frame steps name them. */
export type AfterSubmitPathStep =
	| { readonly kind: "menu"; readonly moduleUuid: Uuid }
	| {
			readonly kind: "case";
			readonly moduleUuid: Uuid;
			readonly caseIds: readonly string[];
	  }
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
	  };

/** A pushed frame: where it goes, computed when it is pushed (Core fixes a
 *  frame's datums then, `StackFrameStep.defineStep`), and the steps it
 *  installs, which become the snapshot when it is popped with frames left. */
export interface PendingAfterSubmitFrame<Route> {
	readonly route: Route;
	readonly landing: readonly AfterSubmitPathStep[];
}

export interface AfterSubmitStackState<Route> {
	/** In push order: the last is on top. */
	readonly pending: readonly PendingAfterSubmitFrame<Route>[];
	/** The landing of the frame popped last while frames remained. */
	readonly snapshot: readonly AfterSubmitPathStep[] | undefined;
}

export const EMPTY_AFTER_SUBMIT_STACK: AfterSubmitStackState<never> =
	Object.freeze({ pending: Object.freeze([]), snapshot: undefined });

function sameStep(a: AfterSubmitPathStep, b: AfterSubmitPathStep): boolean {
	switch (a.kind) {
		case "menu":
			return b.kind === "menu" && a.moduleUuid === b.moduleUuid;
		case "form":
			return (
				b.kind === "form" &&
				a.moduleUuid === b.moduleUuid &&
				a.formUuid === b.formUuid
			);
		case "case":
			return (
				b.kind === "case" &&
				a.moduleUuid === b.moduleUuid &&
				a.caseIds.length === b.caseIds.length &&
				a.caseIds.every((caseId, index) => caseId === b.caseIds[index])
			);
	}
}

/** Whether `path` begins with `snapshot`, step by step (`caseIds` compared
 *  as ordered lists); an empty snapshot is always compatible
 *  (`SessionFrame.isSnapshotIncompatible`). */
export function pathBeginsWith(
	path: readonly AfterSubmitPathStep[],
	snapshot: readonly AfterSubmitPathStep[],
): boolean {
	if (snapshot.length > path.length) return false;
	return snapshot.every((step, index) => {
		const at = path[index];
		return at !== undefined && sameStep(step, at);
	});
}

/** One completion: drop the pending frames when `submittedPath` does not
 *  begin with the snapshot (Core's `cleanStack`), push this submission's
 *  frames in push order, pop the top. `next` is undefined when nothing is
 *  left, which is the app home (`postSubmitAppHome`). Under `"top"` nothing
 *  stays pending. */
export function completeAfterSubmit<Route>(
	state: AfterSubmitStackState<Route>,
	submittedPath: readonly AfterSubmitPathStep[],
	pushed: readonly PendingAfterSubmitFrame<Route>[],
	mode: PreviewPlatformRules["afterSubmitFrames"],
): {
	readonly next: Route | undefined;
	readonly state: AfterSubmitStackState<Route>;
} {
	const kept =
		state.snapshot !== undefined &&
		!pathBeginsWith(submittedPath, state.snapshot)
			? []
			: state.pending;
	const stack = [...kept, ...pushed];
	const top = stack.pop();
	if (top === undefined)
		return { next: undefined, state: EMPTY_AFTER_SUBMIT_STACK };
	if (mode === "top" || stack.length === 0)
		return { next: top.route, state: EMPTY_AFTER_SUBMIT_STACK };
	return { next: top.route, state: { pending: stack, snapshot: top.landing } };
}

/** One completion whose frame its caller routes itself (the return frame of
 *  a case list registration form, `caseListFormReturnFrame`): the frame is
 *  pushed and pops like any other, so it is the snapshot over what stays
 *  pending, and the state left is returned. */
export function completeAfterSubmitWithOwnFrame<Route>(
	state: AfterSubmitStackState<Route>,
	submittedPath: readonly AfterSubmitPathStep[],
	landing: readonly AfterSubmitPathStep[],
	mode: PreviewPlatformRules["afterSubmitFrames"],
): AfterSubmitStackState<Route> {
	const own = completeAfterSubmit<{ readonly route: Route } | null>(
		{
			pending: state.pending.map((frame) => ({
				route: { route: frame.route },
				landing: frame.landing,
			})),
			snapshot: state.snapshot,
		},
		submittedPath,
		[{ route: null, landing }],
		mode,
	).state;
	return own.pending.length === 0
		? EMPTY_AFTER_SUBMIT_STACK
		: {
				pending: own.pending.flatMap((frame) =>
					frame.route === null
						? []
						: [{ route: frame.route.route, landing: frame.landing }],
				),
				snapshot: own.snapshot,
			};
}

/** The cases one session step holds for a module: the ids it selected, in
 *  order. A blank datum installs no case. */
export interface AfterSubmitPathCases {
	readonly moduleUuid: Uuid;
	readonly caseIds: readonly string[];
}

/**
 * A session path in Core's step order: each menu of the chain from the root
 * down to `target.moduleUuid`, each followed by the cases selected in it,
 * then the cases selected in menus outside the chain (a parent menu chosen
 * by case type), then the form when there is one. The landing of a frame and
 * the path of a submitted entry are both built here, so the stack compares
 * like with like (`afterSubmitStack.ts::pathBeginsWith`).
 */
export function afterSubmitPath(
	doc: Pick<BlueprintDoc, "modules" | "moduleOrder">,
	target: { readonly moduleUuid: Uuid; readonly formUuid?: Uuid },
	cases: readonly AfterSubmitPathCases[],
): AfterSubmitPathStep[] {
	const chain: Uuid[] = [];
	for (
		let moduleUuid: Uuid | null | undefined = target.moduleUuid;
		moduleUuid && !chain.includes(moduleUuid);
		moduleUuid = moduleParent(doc, moduleUuid)
	)
		chain.unshift(moduleUuid);
	const held = new Map<Uuid, readonly string[]>();
	for (const entry of cases) {
		if (entry.caseIds.length === 0 || held.has(entry.moduleUuid)) continue;
		held.set(entry.moduleUuid, entry.caseIds);
	}
	const steps: AfterSubmitPathStep[] = [];
	for (const moduleUuid of chain) {
		steps.push({ kind: "menu", moduleUuid });
		const caseIds = held.get(moduleUuid);
		if (caseIds !== undefined)
			steps.push({ kind: "case", moduleUuid, caseIds });
	}
	for (const [moduleUuid, caseIds] of held)
		if (!chain.includes(moduleUuid))
			steps.push({ kind: "case", moduleUuid, caseIds });
	if (target.formUuid !== undefined)
		steps.push({
			kind: "form",
			moduleUuid: target.moduleUuid,
			formUuid: target.formUuid,
		});
	return steps;
}
