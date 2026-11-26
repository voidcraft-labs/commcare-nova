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
import {
	effectiveCaseTypes,
	entryPointInventory,
	type Uuid,
} from "@/lib/domain";
import { withNavigationWidth } from "@/lib/preview/engine/previewDevice";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { readBuilderHistoryMove } from "@/lib/routing/useClientPath";
import {
	usePreviewDevice,
	usePreviewEntryPointLaunch,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { launchEntryPointAction } from "../entryPointLaunchAction";
import type {
	EntryPointLaunchResult,
	EntryPointSelection,
	ListIconSource,
} from "../entryPointLaunchTypes";
import { invalidateCaseData } from "./caseDataInvalidation";
import { showFrameFirstMenu } from "./showFrameFirstMenu";

export function useEntryPointLaunch() {
	const session = useBuilderSessionApi();
	const doc = useBlueprintDocApi();
	const device = usePreviewDevice();
	const reconciler = useReconcilerContext()?.reconciler;
	const navigate = useNavigate();
	const origin = useLocation();
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
			creations?: readonly import("@/lib/domain").SuppliedCaseCreation[],
			listIcon?: ListIconSource,
		): Promise<EntryPointLaunchResult> => {
			const request = ++generation.current;
			const before = session.getState();
			const move = readBuilderHistoryMove();
			const ownsList = () =>
				!listIcon ||
				(move === readBuilderHistoryMove() &&
					session.getState().previewSessionId === before.previewSessionId &&
					session.getState().previewing);
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
			if (!ownsList())
				return { kind: "refused", message: "This list is no longer open." };
			const capturedDoc = doc.getState();
			const expectedSeq = reconciler.getSnapshot().baseSeq;
			const result = await launchEntryPointAction({
				appId: before.appId,
				entryPointUuid,
				selections,
				creations,
				personaUuid,
				listIcon,
				expectedSeq,
				device: withNavigationWidth(device),
			});
			const current = session.getState();
			if (
				request !== generation.current ||
				!ownsList() ||
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
				/* Web Apps' claim frame claimed the chosen cases before the
				 * launch answered: claim rows the worker owns, so its device is
				 * read again, as a device restores after a new claim. */
				if (result.claimCaseIds.length > 0)
					for (const caseType of effectiveCaseTypes(capturedDoc))
						invalidateCaseData(before.appId, caseType.name);
				/* A case the phone lacks opens with blank preloads: the form reads
				 * no saved values for it (Android). */
				const blank = new Set(result.blankCaseIds);
				const formTarget = result.launch.formTarget;
				const launch =
					blank.size === 0
						? result.launch
						: {
								...result.launch,
								blankCaseIds: result.blankCaseIds,
								...(formTarget !== undefined &&
								(formTarget.cases ?? []).some((choice) =>
									blank.has(choice.caseId),
								)
									? { formTarget: { ...formTarget, caseData: new Map() } }
									: {}),
							};
				if (listIcon) {
					const {
						previewSessionId,
						previewMenuCaseSelections,
						previewSearchStates,
						previewCaseTarget,
						previewSelectedCase,
						previewParentCaseRequest,
						previewTaskContinuation,
						previewAfterSubmitStack,
						previewCaseListRegistrationEntry,
					} = current;
					current.installEntryPointLaunch({
						...launch,
						listIconReturn: {
							location: origin,
							state: {
								previewSessionId,
								previewMenuCaseSelections,
								previewSearchStates,
								previewCaseTarget,
								previewSelectedCase,
								previewParentCaseRequest,
								previewTaskContinuation,
								previewAfterSubmitStack,
								previewCaseListRegistrationEntry,
							},
						},
					});
					navigate.replace(launch.location);
					return result;
				}
				current.installEntryPointLaunch(launch);
				/* Back from a form an Android deep link opened ends the visit
				 * (`previewEntryPointVisit`), so only a menu or case list
				 * destination steps back to the first menu. */
				if (
					launch.firstMenuSelections !== undefined &&
					launch.location.kind !== "form"
				)
					showFrameFirstMenu(navigate, session, launch.firstMenuSelections);
				navigate.push(launch.location);
			}
			return result;
		},
		[device, doc, navigate, origin, reconciler, session],
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
				const active = session.getState().previewEntryPointLaunch;
				if (!active) return;
				if (active.listIconReturn) {
					session.setState({
						...active.listIconReturn.state,
						previewEntryPointLaunch: undefined,
					});
					navigate.replace(active.listIconReturn.location);
					return;
				}
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
			!previous.listIconReturn &&
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
			creations: projection?.available ? projection.requiredCreations : [],
			personas: Object.values(doc.personas ?? {}),
			requirements: projection?.available
				? projection.requiredSelections.map((requirement) => {
						const parentModuleUuid =
							doc.modules[requirement.moduleUuid]?.parentCaseModuleUuid;
						const parentCaseType = parentModuleUuid
							? doc.modules[parentModuleUuid]?.caseType
							: undefined;
						return {
							...requirement,
							name:
								doc.modules[requirement.moduleUuid]?.name ??
								requirement.caseType,
							parentCaseType,
							parentModuleUuid,
						};
					})
				: undefined,
		};
	}, [doc, uuid]);
}
