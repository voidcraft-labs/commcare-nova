"use client";

import { useMemo } from "react";
import { useAppStructure } from "@/lib/doc/hooks/useAppStructure";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import {
	previewMenuCaseContext,
	previewModuleVisibility,
} from "@/lib/preview/menuProjection";
import { locationToPreviewScreen } from "@/lib/preview/screenProjection";
import type { Location } from "@/lib/routing/types";
import { useEditMode, usePreviewMenuCaseSelections } from "@/lib/session/hooks";
import { usePreviewMenuSource } from "./usePreviewMenuSource";
import { useSelectedPreviewIdentityState } from "./useSelectedPreviewIdentity";

/**
 * Project a URL location through the same running-menu and case-admission
 * rules everywhere that needs to describe the visible preview screen.
 */
export function usePreviewScreenForLocation(loc: Location): PreviewScreen {
	const { moduleOrder, formOrder } = useAppStructure();
	const menuSource = usePreviewMenuSource();
	const mode = useEditMode();
	const menuCaseSelections = usePreviewMenuCaseSelections();
	const identityState = useSelectedPreviewIdentityState();
	const identity =
		identityState.kind === "ready" ? identityState.identity : null;
	const session = useMemo(() => previewSessionValues(identity), [identity]);
	const lookup = usePreviewLookupStatus();
	const moduleVisibility = useMemo(
		() =>
			previewModuleVisibility(menuSource, {
				authoring: mode === "edit",
				session,
				lookup,
			}),
		[lookup, menuSource, mode, session],
	);
	const atCaseRecord = loc.kind === "cases" && loc.caseId !== undefined;
	const directRunningModuleUuid =
		(mode === "preview" || atCaseRecord) &&
		loc.kind !== "home" &&
		loc.kind !== "app-setup" &&
		loc.kind !== "project-data" &&
		loc.kind !== "module" &&
		loc.kind !== "module-condition"
			? loc.moduleUuid
			: undefined;
	const requiredCaseAdmissionModuleUuid = useMemo(() => {
		if (directRunningModuleUuid === undefined) return undefined;
		return previewMenuCaseContext(
			menuSource,
			directRunningModuleUuid,
			menuCaseSelections,
		).requiredParentCase
			? directRunningModuleUuid
			: undefined;
	}, [directRunningModuleUuid, menuCaseSelections, menuSource]);

	return useMemo(
		() =>
			locationToPreviewScreen(
				loc,
				moduleOrder,
				menuSource.modules,
				formOrder,
				moduleVisibility,
				requiredCaseAdmissionModuleUuid,
			),
		[
			loc,
			moduleOrder,
			menuSource.modules,
			formOrder,
			moduleVisibility,
			requiredCaseAdmissionModuleUuid,
		],
	);
}
