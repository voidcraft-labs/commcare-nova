// components/builder/case-list-config/useSampleData.ts
//
// Generate / Reset sample case data from the authoring surfaces.
// Sample data is an ACTION against the user's real case store (not a
// preview-mode shape), so the affordances live wherever the need
// shows up — the case-list canvas's empty state, the live preview's
// empty state, and the list-panel inspector — all driving this one
// status machine.

"use client";

import { useState } from "react";
import {
	describePopulateError,
	type SampleDataStatus,
} from "@/components/preview/shared/sampleData";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";
import {
	usePopulateSampleCases,
	useResetSampleCases,
} from "@/lib/preview/hooks/useCaseDataBinding";

export interface SampleDataAction {
	readonly status: SampleDataStatus;
	readonly run: () => Promise<void>;
}

/**
 * Generate + Reset actions over the workspace's case type. `onDone`
 * fires after a successful run so the caller can reload whatever live
 * view it owns.
 */
export function useSampleData(args: {
	appId: string;
	caseType: string | undefined;
	/** Refresh the caller's live view. Awaited before the running state
	 *  clears, so return a promise that settles once the fresh rows are on
	 *  screen (the `reload` from `useCases` / `useCaseListPreview` does). */
	onDone: () => void | Promise<void>;
}): { generate: SampleDataAction; reset: SampleDataAction } {
	const { appId, caseType, onDone } = args;
	const docApi = useBlueprintDocApi();
	const blueprint = pickBlueprintDoc(docApi.getState());

	const populate = usePopulateSampleCases({ appId, caseType, blueprint });
	const resetCases = useResetSampleCases({ appId, caseType, blueprint });

	const [generateStatus, setGenerateStatus] = useState<SampleDataStatus>({
		kind: "idle",
	});
	const [resetStatus, setResetStatus] = useState<SampleDataStatus>({
		kind: "idle",
	});

	const runAction = async (
		action: () => Promise<
			Awaited<ReturnType<ReturnType<typeof usePopulateSampleCases>>>
		>,
		verb: "Generate" | "Reset",
		setStatus: (s: SampleDataStatus) => void,
	) => {
		setStatus({ kind: "running" });
		try {
			const result = await action();
			if (result.kind === "ok") {
				/* Hold the running state until the reloaded rows are actually on
				 * screen — `onDone` settles when the live view does, not merely
				 * when the write returned — so the button never flickers back to
				 * its idle label in the gap before the data appears. */
				await onDone();
				setStatus({ kind: "idle" });
				return;
			}
			setStatus({
				kind: "error",
				message: describePopulateError(result, verb),
			});
		} catch {
			/* Wire-level failures (RSC serialization, transport) bypass the
			 * typed result arms; map to the same shape so the button never
			 * sticks on its running label. */
			setStatus({
				kind: "error",
				message: `Could not ${verb.toLowerCase()} sample data. Try again.`,
			});
		}
	};

	return {
		generate: {
			status: generateStatus,
			run: () => runAction(populate, "Generate", setGenerateStatus),
		},
		reset: {
			status: resetStatus,
			run: () => runAction(resetCases, "Reset", setResetStatus),
		},
	};
}
