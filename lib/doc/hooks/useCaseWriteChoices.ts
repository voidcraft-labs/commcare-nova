"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createBrowserCaseWriteVerdictWorker } from "@/lib/doc/browserCaseWriteVerdictWorker";
import {
	type CaseWriteChoiceVerdict,
	caseWriteCandidateMutations,
} from "@/lib/doc/caseWriteChoices";
import {
	CASE_WRITE_VERDICT_WORKER_VERSION,
	type CaseWriteVerdictCandidate,
	type CaseWriteVerdictWorkerResponse,
} from "@/lib/doc/caseWriteVerdictWorkerProtocol";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useLookupCommitState } from "@/lib/doc/lookupCommitContext";
import { registerMutationPrevalidation } from "@/lib/doc/mutationPrevalidation";
import type { Field } from "@/lib/domain";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";

interface CaseWriteChoiceVerdictState {
	readonly verdicts: ReadonlyMap<string, CaseWriteChoiceVerdict>;
	readonly evaluating: boolean;
}

interface CaseWriteChoiceVerdictResult extends CaseWriteChoiceVerdictState {
	/** Ensure one concrete choice has an exact snapshot-bound verdict. The
	 * highlighted row starts this work and the selected row awaits the same
	 * promise, so validation never moves back onto the interaction thread. */
	readonly ensureVerdict: (
		candidate: CaseWriteVerdictCandidate,
	) => Promise<CaseWriteChoiceVerdict | undefined>;
}

interface ExactVerdictTask {
	readonly key: string;
	readonly promise: Promise<CaseWriteChoiceVerdict | undefined>;
	readonly finish: (
		verdict: CaseWriteChoiceVerdict | undefined,
		publish: boolean,
		retireWorker?: boolean,
	) => void;
}

const EMPTY_VERDICTS = new Map<string, CaseWriteChoiceVerdict>();
const PERSISTABLE_DOC_CACHE = new WeakMap<
	object,
	ReturnType<typeof toPersistableDoc>
>();

function persistableDocFor(doc: Parameters<typeof toPersistableDoc>[0]) {
	const cached = PERSISTABLE_DOC_CACHE.get(doc);
	if (cached !== undefined) return cached;
	const persistable = toPersistableDoc(doc);
	PERSISTABLE_DOC_CACHE.set(doc, persistable);
	return persistable;
}

/**
 * Validate case destinations on demand, one at a time.
 *
 * A full catalog can contain hundreds of properties. Running the complete
 * mutation gate once per row saturated four workers long after the popup was
 * usable, then made the author's chosen row compete with work they had not
 * asked for. The highlighted row now gets the only worker; selection awaits
 * that same exact verdict. Unknown rows remain selectable, and every commit
 * still crosses the synchronous gate with the worker's snapshot-bound proof.
 */
export function useCaseWriteChoiceVerdicts(
	field: Field,
	candidates: readonly CaseWriteVerdictCandidate[],
	enabled: boolean,
): CaseWriteChoiceVerdictResult {
	const [state, setState] = useState<CaseWriteChoiceVerdictState>({
		verdicts: EMPTY_VERDICTS,
		evaluating: false,
	});
	/* Closed idle editors subscribe to no document entity. An already-started
	 * proof retains its snapshot subscription while Base UI closes the popup as
	 * part of selection; otherwise that close would retire the proof before its
	 * response could authorize the commit. */
	const active = enabled || state.evaluating;
	const doc = useBlueprintDoc((current) => (active ? current : undefined));
	const docApi = useBlueprintDocApi();
	const lookupCommitState = useLookupCommitState();
	const lookupCommitStateRef = useRef(lookupCommitState);
	lookupCommitStateRef.current = lookupCommitState;
	const requestIdRef = useRef(0);
	const exactTaskRef = useRef<ExactVerdictTask | null>(null);
	const workerRef = useRef<Worker | null>(null);
	const mountedRef = useRef(true);

	const ensureVerdict = useCallback(
		(candidate: CaseWriteVerdictCandidate) => {
			const known = state.verdicts.get(candidate.key);
			if (known !== undefined) return Promise.resolve(known);
			if (
				!active ||
				doc === undefined ||
				lookupCommitState.kind === "loading" ||
				lookupCommitState.kind === "error"
			) {
				return Promise.resolve(undefined);
			}

			const existing = exactTaskRef.current;
			if (existing?.key === candidate.key) return existing.promise;
			/* Keyboard and pointer highlighting may move quickly. Retire the older
			 * row instead of building an unbounded queue of complete validators. */
			existing?.finish(undefined, false, true);

			const capturedDoc = doc;
			const capturedLookupContext = lookupCommitState.lookupContext;
			const requestId = ++requestIdRef.current;
			let worker = workerRef.current;
			if (worker === null) {
				try {
					worker = createBrowserCaseWriteVerdictWorker();
					workerRef.current = worker;
				} catch {
					return Promise.resolve(undefined);
				}
			}
			let resolvePromise: (
				verdict: CaseWriteChoiceVerdict | undefined,
			) => void = () => {};
			const promise = new Promise<CaseWriteChoiceVerdict | undefined>(
				(resolve) => {
					resolvePromise = resolve;
				},
			);
			let settled = false;
			const task: ExactVerdictTask = {
				key: candidate.key,
				promise,
				finish(verdict, publish, retireWorker = false) {
					if (settled) return;
					settled = true;
					worker.onmessage = null;
					worker.onerror = null;
					if (retireWorker) {
						worker.terminate();
						if (workerRef.current === worker) workerRef.current = null;
					}
					if (exactTaskRef.current === task) exactTaskRef.current = null;
					if (mountedRef.current) {
						setState((current) => {
							const verdicts = publish
								? new Map(current.verdicts).set(
										candidate.key,
										verdict as CaseWriteChoiceVerdict,
									)
								: current.verdicts;
							if (!current.evaluating && verdicts === current.verdicts) {
								return current;
							}
							return { verdicts, evaluating: false };
						});
					}
					resolvePromise(verdict);
				},
			};
			exactTaskRef.current = task;
			setState((current) =>
				current.evaluating ? current : { ...current, evaluating: true },
			);

			worker.onmessage = (
				event: MessageEvent<CaseWriteVerdictWorkerResponse>,
			) => {
				const response = event.data;
				if (response.requestId !== requestId || !response.ok) {
					task.finish(undefined, false);
					return;
				}
				const verdict = response.verdicts.find(
					([key]) => key === candidate.key,
				)?.[1];
				const liveLookupState = lookupCommitStateRef.current;
				const snapshotStillCurrent =
					docApi.getState() === capturedDoc &&
					liveLookupState.kind !== "loading" &&
					liveLookupState.kind !== "error" &&
					liveLookupState.lookupContext === capturedLookupContext;
				if (verdict === undefined || !snapshotStillCurrent) {
					task.finish(undefined, false);
					return;
				}
				if (verdict.ok) {
					registerMutationPrevalidation(
						capturedDoc,
						capturedLookupContext,
						caseWriteCandidateMutations(
							capturedDoc,
							field,
							candidate.caseWrite,
						),
					);
				}
				task.finish(verdict, true);
			};
			worker.onerror = (event) => {
				event.preventDefault();
				task.finish(undefined, false, true);
			};
			try {
				worker.postMessage({
					version: CASE_WRITE_VERDICT_WORKER_VERSION,
					requestId,
					doc: persistableDocFor(capturedDoc),
					fieldUuid: field.uuid,
					lookupContext: capturedLookupContext,
					candidates: [candidate],
				});
			} catch {
				task.finish(undefined, false, true);
			}
			return promise;
		},
		[active, doc, docApi, field, lookupCommitState, state.verdicts],
	);

	/* Worker construction starts its module fetch/evaluation. Begin that work on
	 * open, while the author is finding a destination, rather than adding cold
	 * worker startup to the selected row's response time. A settled worker stays
	 * warm for the next choice; cancellation/error retires it because JavaScript
	 * workers cannot abort one queued validation in place. */
	useEffect(() => {
		if (!enabled || workerRef.current !== null) return;
		try {
			workerRef.current = createBrowserCaseWriteVerdictWorker();
		} catch {
			// `ensureVerdict` reports an unavailable proof without blocking the UI.
		}
	}, [enabled]);

	/* A new snapshot/catalog invalidates displayed row reasons as well as the
	 * in-flight proof. Loading/error remains fail-closed exactly as before. */
	useEffect(() => {
		// A same-document route change can reuse this editor for another field.
		// Its proof belongs to the previous field identity and must be retired.
		void field.uuid;
		exactTaskRef.current?.finish(undefined, false, true);
		if (!active || doc === undefined) {
			setState({ verdicts: EMPTY_VERDICTS, evaluating: false });
			return;
		}
		if (
			lookupCommitState.kind === "loading" ||
			lookupCommitState.kind === "error"
		) {
			const reason =
				lookupCommitState.kind === "loading"
					? "Project data is still loading. Wait before changing this."
					: "Project data could not be loaded. Try again before changing this.";
			setState({
				verdicts: new Map(
					candidates.map((candidate) => [
						candidate.key,
						{ ok: false as const, reason },
					]),
				),
				evaluating: false,
			});
			return;
		}
		setState({ verdicts: EMPTY_VERDICTS, evaluating: false });
	}, [active, candidates, doc, field, lookupCommitState]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			exactTaskRef.current?.finish(undefined, false, true);
			workerRef.current?.terminate();
			workerRef.current = null;
		};
	}, []);

	return { ...state, ensureVerdict };
}
