"use client";

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { entryPointRequirements } from "@/lib/doc/entryPointProjection";
import {
	useBlueprintDoc,
	useBlueprintDocApi,
} from "@/lib/doc/hooks/useBlueprintDoc";
import { entryPointInventory, type Uuid } from "@/lib/domain";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { usePreviewEntryPointLaunch } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { launchEntryPointAction } from "../entryPointLaunchAction";
import type {
	EntryPointLaunchResult,
	EntryPointSelection,
} from "../entryPointLaunchTypes";

export function useEntryPointLaunch() {
	const session = useBuilderSessionApi();
	const doc = useBlueprintDocApi();
	const reconciler = useReconcilerContext()?.reconciler;
	const navigate = useNavigate();
	const generation = useRef(0);
	useEffect(
		() => () => {
			generation.current++;
		},
		[],
	);
	return useCallback(
		async (
			entryPointUuid: string,
			selections: readonly EntryPointSelection[],
			personaUuid?: string,
		): Promise<EntryPointLaunchResult> => {
			const request = ++generation.current;
			const before = session.getState();
			if (!before.appId || before.accessPhase !== "authorized" || !reconciler)
				return {
					kind: "refused",
					message: "Wait for the app to finish loading and try again.",
				};
			const saved = await reconciler.waitForHumanSaveBarrier();
			if (saved.kind !== "saved")
				return {
					kind: "refused",
					message: "Wait for the app to finish saving and try again.",
				};
			const capturedDoc = doc.getState();
			const expectedSeq = reconciler.getSnapshot().baseSeq;
			const result = await launchEntryPointAction({
				appId: before.appId,
				entryPointUuid,
				selections,
				personaUuid,
				expectedSeq,
			});
			const current = session.getState();
			if (
				request !== generation.current ||
				current.appId !== before.appId ||
				current.scopeEpoch !== before.scopeEpoch ||
				current.accessPhase !== "authorized" ||
				current.previewPersonaUuid !== before.previewPersonaUuid ||
				doc.getState() !== capturedDoc ||
				reconciler.getSnapshot().baseSeq !== expectedSeq
			)
				return {
					kind: "refused",
					message: "The app or Preview worker changed. Try again.",
				};
			if (result.kind === "ready") {
				current.installEntryPointLaunch(result.launch);
				navigate.push(result.launch.location);
			}
			return result;
		},
		[doc, navigate, reconciler, session],
	);
}

/** Mounted with PreviewShell so leaving the setup screen does not retire a
 * successful launch. A document edit retires its exact binding before another
 * form can inherit the display-condition bypass. */
export function useEntryPointLaunchLifecycle() {
	const doc = useBlueprintDocApi();
	const session = useBuilderSessionApi();
	const launch = usePreviewEntryPointLaunch();
	const location = useLocation();
	const previousLaunch = useRef(launch);
	const navigate = useNavigate();
	useEffect(
		() =>
			doc.subscribe(() => {
				if (!session.getState().previewEntryPointLaunch) return;
				session.getState().setPreviewing(false);
				navigate.replace({ kind: "app-setup", section: "deep-links" });
			}),
		[doc, navigate, session],
	);
	useLayoutEffect(() => {
		const previous = previousLaunch.current;
		previousLaunch.current = launch;
		if (
			previous &&
			!launch &&
			session.getState().previewing &&
			JSON.stringify(location) === JSON.stringify(previous.location)
		) {
			session.getState().setPreviewing(false);
			navigate.replace({ kind: "app-setup", section: "deep-links" });
		}
	}, [launch, location, navigate, session]);
	useEffect(() => {
		if (launch && JSON.stringify(location) !== JSON.stringify(launch.location))
			session.getState().clearEntryPointLaunch();
	}, [launch, location, session]);
}

/** Read model for the local launch picker; components never subscribe to raw document state. */
export function useEntryPointPreviewSetup(uuid: Uuid) {
	const doc = useBlueprintDoc((s) => s);
	return useMemo(() => {
		const item = entryPointInventory(doc).find(
			(item) => item.entryPoint.uuid === uuid,
		);
		const projection = item
			? entryPointRequirements(doc, item.target)
			: undefined;
		return {
			item,
			personas: Object.values(doc.personas ?? {}),
			requirements: projection?.available
				? projection.requiredSelections.map((requirement) => {
						const parentCaseType = (doc.caseTypes ?? []).find(
							(type) => type.name === requirement.caseType,
						)?.parent_type;
						return {
							...requirement,
							name:
								doc.modules[requirement.moduleUuid]?.name ??
								requirement.caseType,
							parentCaseType,
							parentModuleUuid: projection.requiredSelections.find(
								(candidate) => candidate.caseType === parentCaseType,
							)?.moduleUuid,
						};
					})
				: undefined,
		};
	}, [doc, uuid]);
}
