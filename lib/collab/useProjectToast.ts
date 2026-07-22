/** Builder-Project provenance adapter for the app-global toast singleton. */

"use client";

import { useCallback } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { useProjectScopeEpoch } from "@/lib/session/hooks";
import { useOptionalBuilderSessionApi } from "@/lib/session/provider";
import {
	showProjectToast,
	showToast,
	type ToastOptions,
	type ToastSeverity,
} from "@/lib/ui/toastStore";

/** Use for notices that contain Project data or invoke a Project-scoped action.
 * Outside a live builder (standalone previews/tests), it degrades to a normal
 * global toast because there is no reversible Project boundary to cross. */
export function useProjectToast(): (
	severity: ToastSeverity,
	title: string,
	message?: string,
	options?: ToastOptions,
) => string {
	const reconciler = useReconcilerContext();
	const scopeEpoch = useProjectScopeEpoch();
	return useCallback(
		(severity, title, message, options) => {
			if (!reconciler) return showToast(severity, title, message, options);
			return showProjectToast(
				{ scopeId: reconciler.projectScopeId, epoch: scopeEpoch },
				severity,
				title,
				message,
				options,
			);
		},
		[reconciler, scopeEpoch],
	);
}

/**
 * Save-owner variant: resolve the epoch at CALL time.
 *
 * Most async Project work must capture its starting epoch, so
 * {@link useProjectToast} intentionally rejects a late callback after a scope
 * transition. Autosave is different: preserved local batches deliberately
 * cross a reversible viewer/editor transition, and their later retry outcome
 * belongs to the CURRENT save surface. This hook is reserved for that owner.
 */
export function useCurrentProjectToast(): (
	severity: ToastSeverity,
	title: string,
	message?: string,
	options?: ToastOptions,
) => string {
	const reconciler = useReconcilerContext();
	const session = useOptionalBuilderSessionApi();
	return useCallback(
		(severity, title, message, options) => {
			if (!reconciler || !session)
				return showToast(severity, title, message, options);
			return showProjectToast(
				{
					scopeId: reconciler.projectScopeId,
					epoch: session.getState().scopeEpoch,
				},
				severity,
				title,
				message,
				options,
			);
		},
		[reconciler, session],
	);
}
