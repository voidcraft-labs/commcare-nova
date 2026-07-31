"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { preflightCasePropertyRenamesAction } from "@/lib/preview/engine/casePropertyRenamePreflight";
import type {
	CasePropertyRenameInput,
	CasePropertyRenamePreflightResult,
} from "@/lib/preview/engine/casePropertyRenamePreflightTypes";
import {
	useAccessPhase,
	useAppId,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { useOptionalBuilderSessionApi } from "@/lib/session/provider";

export type CasePropertyRenamePreflightState =
	| { readonly kind: "idle" }
	| { readonly kind: "checking" }
	| { readonly kind: "error"; readonly message: string }
	| CasePropertyRenamePreflightResult;

const IDLE: CasePropertyRenamePreflightState = { kind: "idle" };

/**
 * Run one explanatory rename preflight against the current builder scope.
 *
 * A Project move, access refresh/revocation, app replacement, or a newer
 * request invalidates an in-flight result before it reaches state or the
 * caller. Viewers may run the review; edit capability is required only by the
 * later authoritative save.
 */
export function useCasePropertyRenamePreflight(): {
	readonly state: CasePropertyRenamePreflightState;
	readonly preflight: (
		renames: readonly CasePropertyRenameInput[],
	) => Promise<CasePropertyRenamePreflightResult | undefined>;
} {
	const session = useOptionalBuilderSessionApi();
	const appId = useAppId();
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const requestIdRef = useRef(0);
	const [state, setState] = useState<CasePropertyRenamePreflightState>(IDLE);

	useEffect(() => {
		void accessPhase;
		void appId;
		void scopeEpoch;
		requestIdRef.current += 1;
		setState(IDLE);
	}, [accessPhase, appId, scopeEpoch]);

	const preflight = useCallback(
		async (
			renames: readonly CasePropertyRenameInput[],
		): Promise<CasePropertyRenamePreflightResult | undefined> => {
			const start = session?.getState();
			const requestAppId = start?.appId ?? appId;
			const requestEpoch = start?.scopeEpoch ?? scopeEpoch;
			const requestPhase = start?.accessPhase ?? accessPhase;
			if (requestAppId === undefined || requestPhase !== "authorized") {
				setState(IDLE);
				return undefined;
			}

			const isCurrent = (): boolean => {
				const current = session?.getState();
				return current
					? current.accessPhase === "authorized" &&
							current.appId === requestAppId &&
							current.scopeEpoch === requestEpoch
					: accessPhase === "authorized" &&
							appId === requestAppId &&
							scopeEpoch === requestEpoch;
			};

			const requestId = ++requestIdRef.current;
			setState({ kind: "checking" });
			try {
				const result = await preflightCasePropertyRenamesAction({
					appId: requestAppId,
					renames,
				});
				if (requestId !== requestIdRef.current || !isCurrent()) {
					return undefined;
				}
				setState(result);
				return result;
			} catch {
				if (requestId === requestIdRef.current && isCurrent()) {
					setState({
						kind: "error",
						message: "Case-property impact could not be checked. Try again.",
					});
				}
				return undefined;
			}
		},
		[accessPhase, appId, scopeEpoch, session],
	);

	return { state, preflight };
}
