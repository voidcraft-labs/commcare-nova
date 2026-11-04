/**
 * The builder's answer to a placement conflict: a publish recorded where
 * CommCare HQ keeps some answers while this tab's edits were on their way,
 * so the server refused them (`placement-recorded`), and the reconciler hands
 * them back once the reload ends with the person still an editor
 * (`lib/collab/reconciler.ts::onPlacementConflict`).
 *
 * `replayAfterPlacementConflict` plans those edits again over the reloaded
 * document as one batch (`lib/doc/identityMoves.ts::planConflictReplay`) and
 * runs the builder's commit gate on it: the same pre-verdict admission and
 * the same verdict `useBlueprintMutations`' dispatch runs. The batch was
 * projected into the worker language when it was first made, so it is not
 * projected again. Where the gate admits it and it moves at least one held
 * identity, it waits in `IdentityMoveDialog` with origin `conflict`, and
 * **Make the change** commits it as one new edit (`commitStated`). Otherwise
 * nothing is dispatched, and a toast says the app reloaded and the change can
 * be made again.
 *
 * `useRegisterPlacementConflictReplay` registers it with the reconciler for
 * as long as the builder layout is mounted, and offers each replay once the
 * reload that brought it has given the builder its edit access back.
 */

"use client";

import {
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import type { PlacementConflictReplay } from "@/lib/collab/reconciler";
import { useCurrentProjectToast } from "@/lib/collab/useProjectToast";
import { builderWriteAdmission } from "@/lib/doc/builderWriteAdmission";
import {
	mutationCommitVerdictWithPrevalidation,
	preparedCommitVerdictWithPrevalidation,
} from "@/lib/doc/commitVerdicts";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import {
	type IdentityMovePlan,
	planConflictReplay,
} from "@/lib/doc/identityMoves";
import {
	type LookupCommitState,
	useLookupCommitState,
} from "@/lib/doc/lookupCommitContext";
import type { PendingIdentityMove } from "@/lib/doc/pendingIdentityMove";
import { BlueprintEditableContext } from "@/lib/doc/provider";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type { ToastSeverity } from "@/lib/ui/toastStore";

/** The toast where nothing can be offered again. */
export const PLACEMENT_CONFLICT_TOAST_TITLE = "App reloaded";
export const PLACEMENT_CONFLICT_TOAST_BODY =
	"A publish just recorded where CommCare HQ keeps some answers your change moves. We loaded the latest version; make the change again to see what it moves.";

/** What the handler reads at the moment the replay arrives. */
export interface PlacementConflictReplayDeps {
	/** The reloaded document, with the holds its latest recordings wrote. */
	readonly doc: () => ReturnType<
		ReturnType<typeof useBlueprintDocApi>["getState"]
	>;
	readonly canEdit: () => boolean;
	readonly lookupCommitState: () => LookupCommitState;
	/** The change already waiting in the identity-move dialog, if any. */
	readonly pending: () => PendingIdentityMove | null;
	readonly setPending: (pending: PendingIdentityMove) => void;
	readonly toast: (
		severity: ToastSeverity,
		title: string,
		message: string,
	) => void;
}

/**
 * Offer a placement conflict's edits again: plan them over the reloaded
 * document, gate the planned batch, and set it waiting in the identity-move
 * dialog where it is admitted and moves something; otherwise dispatch
 * nothing and say so.
 */
export function replayAfterPlacementConflict(
	replay: PlacementConflictReplay,
	deps: PlacementConflictReplayDeps,
): void {
	const doc = deps.doc();
	const plan = planConflictReplay(doc, replay, doc.recordedHolds);
	if (plan.batch.length === 0) return;
	const offer = gatedOffer(doc, plan, deps);
	if (offer === null) {
		deps.toast(
			"warning",
			PLACEMENT_CONFLICT_TOAST_TITLE,
			PLACEMENT_CONFLICT_TOAST_BODY,
		);
		return;
	}
	deps.setPending(offer);
}

/** The planned batch as the dialog offers it, or null where it moves
 *  nothing or the builder's gate refuses it. */
function gatedOffer(
	doc: ReturnType<PlacementConflictReplayDeps["doc"]>,
	plan: IdentityMovePlan,
	deps: PlacementConflictReplayDeps,
): PendingIdentityMove | null {
	if (plan.moves.length === 0) return null;
	const lookupCommitState = deps.lookupCommitState();
	const admission = builderWriteAdmission({
		canEdit: deps.canEdit(),
		lookupCommitState,
		identityMovePending: deps.pending() !== null,
	});
	if (!admission.ok) return null;
	const verdict =
		plan.prepared === undefined
			? mutationCommitVerdictWithPrevalidation(
					doc,
					plan.batch,
					lookupCommitState.lookupContext,
				)
			: preparedCommitVerdictWithPrevalidation(
					doc,
					plan.prepared,
					lookupCommitState.lookupContext,
				);
	if (!verdict.ok) return null;
	return { batch: verdict.mutations, moves: plan.moves, origin: "conflict" };
}

/**
 * Register `replayAfterPlacementConflict` with the reconciler while the
 * caller is mounted. The reconciler hands a replay over as its reload lands,
 * before the builder has rendered what that reload published: edit access
 * comes back through the session store, and the Project's data-table catalog
 * is read again. So a replay waits here until the builder can take an edit
 * again (edit access, and a catalog that is not loading), then is offered;
 * a second replay that arrives meanwhile joins the first. The registration
 * holds across access and lookup-catalog changes without re-registering.
 */
export function useRegisterPlacementConflictReplay(): void {
	const reconciler = useReconcilerContext();
	const docStore = useBlueprintDocApi();
	const session = useBuilderSessionApi();
	const toast = useCurrentProjectToast();
	const canEdit = useContext(BlueprintEditableContext);
	const lookupCommitState = useLookupCommitState();
	const live = useRef({ canEdit, lookupCommitState, toast });
	useLayoutEffect(() => {
		live.current = { canEdit, lookupCommitState, toast };
	});
	const [waiting, setWaiting] = useState<PlacementConflictReplay | null>(null);
	const register = reconciler?.registerPlacementConflictHandler;
	useEffect(() => {
		if (register === undefined) return;
		return register((replay) =>
			setWaiting((earlier) => [...(earlier ?? []), ...replay]),
		);
	}, [register]);
	const lookupLoading = lookupCommitState.kind === "loading";
	useEffect(() => {
		if (waiting === null || !canEdit || lookupLoading) return;
		setWaiting(null);
		replayAfterPlacementConflict(waiting, {
			doc: () => docStore.getState(),
			canEdit: () => live.current.canEdit,
			lookupCommitState: () => live.current.lookupCommitState,
			pending: () => session.getState().pendingIdentityMove,
			setPending: (pending) =>
				session.getState().setPendingIdentityMove(pending),
			toast: (severity, title, message) => {
				live.current.toast(severity, title, message);
			},
		});
	}, [waiting, canEdit, lookupLoading, docStore, session]);
}
