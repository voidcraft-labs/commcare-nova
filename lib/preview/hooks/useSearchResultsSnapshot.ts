/**
 * useSearchResultsSnapshot — what a search-first module's completed search
 * returned, for a form of that module that reads it.
 *
 * The read is the completed attempt's own Results read without a page window
 * (`loadSearchResultsSnapshotAction`), so the form reads the cases Results
 * showed for that search, up to `SEARCH_RESULTS_CAP`. It is keyed by the
 * attempt, its answers, the worker and the parent selection. A search reads
 * the Project's open cases, not the worker's restore, so a claim the form's
 * entry posts reads nothing again. It is never keyed by the document's
 * identity either: an edit elsewhere in the app
 * does not read the search again, and the form keeps the snapshot it opened
 * with for the whole entry, as a device's session keeps its query step.
 */
"use client";
import { useEffect, useRef, useState } from "react";
import { toRscSerializableDoc } from "@/lib/doc/ownRecords";
import type { BlueprintDoc, CaseType, Uuid } from "@/lib/domain";
import { loadSearchResultsSnapshotAction } from "@/lib/preview/engine/caseDataBinding";
import { viewerTimeZone } from "@/lib/preview/engine/caseDataBindingClient";
import type { ParentCaseSelection } from "@/lib/preview/engine/caseDataBindingTypes";
import type { SearchResultsSnapshot } from "@/lib/preview/engine/xpathInstances";
import {
	useAccessPhase,
	usePreviewClaimedCaseIds,
	usePreviewPersonaUuid,
} from "@/lib/session/hooks";
import type { PreviewSearchState } from "@/lib/session/types";

export type SearchResultsSnapshotState =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| { readonly kind: "data"; readonly snapshot: SearchResultsSnapshot }
	| { readonly kind: "error"; readonly message: string };

export function useSearchResultsSnapshot(args: {
	/** The form reads what its module's search found. */
	readonly enabled: boolean;
	readonly appId: string | undefined;
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid | undefined;
	readonly searchState: PreviewSearchState | undefined;
	readonly parentCase?: ParentCaseSelection;
	readonly caseTypes: readonly CaseType[];
	readonly language: string;
}): { readonly state: SearchResultsSnapshotState; readonly retry: () => void } {
	const accessPhase = useAccessPhase();
	const personaUuid = usePreviewPersonaUuid();
	const claimedCaseIds = usePreviewClaimedCaseIds(personaUuid);
	const [retries, setRetries] = useState(0);
	const completed =
		args.searchState?.kind === "completed" ? args.searchState : undefined;
	const module =
		args.moduleUuid === undefined
			? undefined
			: args.doc.modules[args.moduleUuid];
	const key =
		args.enabled &&
		accessPhase === "authorized" &&
		args.appId !== undefined &&
		module?.caseType !== undefined &&
		completed !== undefined
			? JSON.stringify([
					args.appId,
					args.moduleUuid,
					module.caseType,
					completed.attempt,
					completed.answers,
					completed.registeredCaseId ?? null,
					personaUuid ?? null,
					args.parentCase ?? null,
					retries,
				])
			: undefined;
	/* The latest inputs, read when a load starts; the key alone decides
	 * whether one starts. */
	const latest = useRef({ ...args, claimedCaseIds, personaUuid });
	latest.current = { ...args, claimedCaseIds, personaUuid };
	const [result, setResult] = useState<{
		readonly key: string;
		readonly state: SearchResultsSnapshotState;
	}>();

	useEffect(() => {
		if (key === undefined) return;
		let current = true;
		const input = latest.current;
		const mod =
			input.moduleUuid === undefined
				? undefined
				: input.doc.modules[input.moduleUuid];
		const search =
			input.searchState?.kind === "completed" ? input.searchState : undefined;
		if (
			input.appId === undefined ||
			input.moduleUuid === undefined ||
			mod?.caseType === undefined ||
			search === undefined
		)
			return;
		setResult({ key, state: { kind: "loading" } });
		loadSearchResultsSnapshotAction({
			appId: input.appId,
			caseType: mod.caseType,
			moduleUuid: input.moduleUuid,
			blueprint: toRscSerializableDoc(input.doc),
			caseListConfig: mod.caseListConfig,
			excludedOwnerIdsExpression: mod.caseSearchConfig?.excludedOwnerIds,
			/* After the no-matches form registers a case, the search is that
			 * one case, as the wire's return frame keys it. */
			...(search.registeredCaseId === undefined
				? { inputValues: { ...search.answers } }
				: { caseIds: [search.registeredCaseId] }),
			...(input.parentCase === undefined
				? {}
				: { parentCase: input.parentCase }),
			caseTypes: input.caseTypes,
			language: input.language,
			viewerTimeZone: viewerTimeZone(),
			...(input.personaUuid === undefined
				? {}
				: { personaUuid: input.personaUuid }),
			claimedCaseIds: [...input.claimedCaseIds],
		}).then(
			(loaded) => {
				if (!current) return;
				setResult({
					key,
					state:
						loaded.kind === "data"
							? { kind: "data", snapshot: loaded.snapshot }
							: {
									kind: "error",
									message:
										"message" in loaded
											? loaded.message
											: "You're signed out, so what the search found can't load.",
								},
				});
			},
			() => {
				if (current)
					setResult({
						key,
						state: {
							kind: "error",
							message: "We couldn't load what the search found. Try again.",
						},
					});
			},
		);
		return () => {
			current = false;
		};
	}, [key]);

	const state: SearchResultsSnapshotState =
		key === undefined
			? { kind: "idle" }
			: result?.key === key
				? result.state
				: { kind: "loading" };
	return { state, retry: () => setRetries((count) => count + 1) };
}
