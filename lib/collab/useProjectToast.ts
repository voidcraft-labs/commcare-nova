/** Builder-Project provenance adapter for the app-global toast singleton. */

"use client";

import { useCallback } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { useProjectScopeEpoch } from "@/lib/session/hooks";
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
