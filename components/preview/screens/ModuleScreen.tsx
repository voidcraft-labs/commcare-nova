"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import tablerListDetails from "@iconify-icons/tabler/list-details";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { summarizeFilter } from "@/components/builder/case-list-config/predicateSummary";
import { ModuleSettingsButton } from "@/components/builder/detail/moduleSettings/ModuleSettingsButton";
import { EditableTitle } from "@/components/builder/EditableTitle";
import {
	useBuilderLanguage,
	useLocalizedValues,
	useTranslationUnitEditor,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { previewParentCaseResumeLocation } from "@/components/preview/screens/moduleScreenNavigation";
import { HiddenItemsReveal } from "@/components/preview/shared/HiddenItemsReveal";
import { Skeleton } from "@/components/shadcn/skeleton";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import {
	useCaseFirstModuleUuids,
	useIsBareCaseListModule,
	useIsCaseFirstModule,
} from "@/lib/doc/hooks/useModuleIds";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { Uuid } from "@/lib/doc/types";
import {
	formLaunch,
	type MenuScreenEntry,
	makeTranslationUnitId,
	moduleFormsReadSearch,
	moduleLanding,
	moduleParent,
	moduleScreenLanding,
	reachableCaseTypes,
} from "@/lib/domain";
import { caseListMenuItemSelection } from "@/lib/preview/caseListMenuItemRoute";
import { caseDatabaseToFormPreloads } from "@/lib/preview/engine/caseDataBindingClient";
import { navigationSelectedCase } from "@/lib/preview/engine/displayConditionEvaluation";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import { withNavigationWidth } from "@/lib/preview/engine/previewDevice";
import { previousTaskFormSelectors } from "@/lib/preview/engine/previousTask";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import { useNavigationDeviceCases } from "@/lib/preview/engine/useNavigationDeviceCases";
import { useClaimSearchedCases } from "@/lib/preview/hooks/useClaimSearchedCases";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import {
	authoringScreenEntries,
	menuScreenEntryKey,
	moduleHasChildren,
	OFF_THE_MENU_SUMMARY,
	previewCaseListMenuEntry,
	previewHiddenScreenEntries,
	previewMenuCaseContext,
	previewModuleOwnVisibility,
	previewModuleScreenIsBareCaseList,
	previewScreenEntries,
	previewScreenEntryVisibility,
} from "@/lib/preview/menuProjection";
import {
	claimableCaseIds,
	parentSelectClaimChoices,
} from "@/lib/preview/searchClaims";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import {
	useBuilderIsReady,
	useEditMode,
	usePreviewDevice,
	usePreviewEntryPointLaunch,
	usePreviewMenuCaseSelections,
	usePreviewParentCaseRequest,
	usePreviewPlatformRules,
	usePreviewTaskContinuation,
	useSetPreviewAtDeviceHome,
	useSetPreviewCaseTarget,
	useSetPreviewParentCaseRequest,
	useSetPreviewTaskContinuation,
} from "@/lib/session/hooks";
import { showToast } from "@/lib/ui/toastStore";
import { useWorkerMessage } from "../shared/WorkerText";
import { PreviewCaseListRow, PreviewFormRow } from "./MenuScreenRows";
import { openModuleLanding } from "./moduleLanding";

interface ModuleScreenProps {
	/** This screen's identity, which module is being displayed. Passed from
	 *  PreviewShell so the component remains valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "module" }>;
}

export function ModuleScreen({ screen }: ModuleScreenProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	const projectProse = useProseProjection();
	const { inline } = useBlueprintMutations();
	const docApi = useBlueprintDocApi();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();
	const setPreviewCaseTarget = useSetPreviewCaseTarget();
	const setPreviewParentCaseRequest = useSetPreviewParentCaseRequest();
	const previewParentCaseRequest = usePreviewParentCaseRequest();
	const menuSource = usePreviewMenuSource();
	const menuCaseSelections = usePreviewMenuCaseSelections();
	const taskContinuation = usePreviewTaskContinuation();
	const setTaskContinuation = useSetPreviewTaskContinuation();
	const caseFirstModules = useCaseFirstModuleUuids();
	const platformRules = usePreviewPlatformRules();
	const setPreviewAtDeviceHome = useSetPreviewAtDeviceHome();
	const { claim: claimSearchedCases } = useClaimSearchedCases();

	/** Activity keeps a visited module mounted after the URL moves elsewhere,
	 * so this component must read its own stable screen identity. */
	const moduleUuid = screen.moduleUuid;

	const mod = useModuleEntity(moduleUuid);
	const language = useBuilderLanguage();
	const message = useWorkerMessage();
	const localizedValues = useLocalizedValues();
	const moduleNameUnitId = makeTranslationUnitId(
		"module",
		moduleUuid ?? "missing",
		"name",
	);
	const moduleNameEditor = useTranslationUnitEditor(moduleNameUnitId);
	const lookup = usePreviewLookupStatus();
	/* Whoever Preview is running as: the member, or the persona they
	 * picked. One identity across every preview surface. */
	const identity = useSelectedPreviewIdentity();
	const device = usePreviewDevice();
	const session = useMemo(
		() => previewSessionValues(identity, withNavigationWidth(device)),
		[identity, device],
	);
	/* The screen lists its own forms, the forms and case lists of every
	 * submenu that shows its forms here, and the tiles of submenus that keep
	 * their screen; edit mode keeps the menu the container of its own forms. */
	const entries = useMemo(
		() =>
			mode === "edit"
				? authoringScreenEntries(menuSource.doc, {
						kind: "menu",
						moduleUuid,
					})
				: previewScreenEntries(menuSource.doc, { kind: "menu", moduleUuid }),
		[menuSource.doc, mode, moduleUuid],
	);
	const rowEntries = useMemo(
		() => entries.filter((entry) => entry.kind !== "menu"),
		[entries],
	);
	const tileEntries = useMemo(
		() => entries.filter((entry) => entry.kind === "menu"),
		[entries],
	);
	const children = useMemo(
		() =>
			tileEntries.flatMap(
				(entry) => menuSource.modules[entry.moduleUuid] ?? [],
			),
		[tileEntries, menuSource.modules],
	);
	/* A submenu that shows its forms here is still this menu's child: it
	 * needs the case chosen here before its forms open. */
	const hasChildren = moduleHasChildren(menuSource, moduleUuid);
	const menuCaseContext = useMemo(
		() => previewMenuCaseContext(menuSource, moduleUuid, menuCaseSelections),
		[menuSource, moduleUuid, menuCaseSelections],
	);
	const selectedMenuCase = menuCaseContext.selectedCase;
	const selectedMenuChoices = selectedMenuCase?.cases ?? [];
	const requiredParentCase = menuCaseContext.requiredParentCase;
	const deviceCases = useNavigationDeviceCases(menuSource.caseTypes);

	/* The running preview gates the screen exactly as a device would
	 * (`<menu relevant>`, `<command relevant>`), over the device's cases with
	 * each form's menu's chosen case under its session datum. Forms-first
	 * conditions read the session only (the validator admits property reads
	 * only on a case-first screen). Edit mode shows everything. */
	const ownModuleVisibility = useMemo(
		() =>
			previewModuleOwnVisibility(menuSource.doc, {
				authoring: mode === "edit",
				session,
				lookup,
				deviceCases,
			}),
		[lookup, menuSource, mode, session, deviceCases],
	);
	const entryVisibility = useMemo(
		() =>
			previewScreenEntryVisibility({
				doc: menuSource.doc,
				entries,
				ownModuleVisibility,
				authoring: mode === "edit",
				session,
				lookup,
				deviceCases,
				selectedCaseOf: (entry) => {
					const chosen = previewMenuCaseContext(
						menuSource,
						entry.moduleUuid,
						menuCaseSelections,
					).selectedCase?.cases;
					return chosen?.length === 1
						? navigationSelectedCase(
								menuSource.doc,
								entry.moduleUuid,
								entry.formUuid,
								chosen[0].caseId,
							)
						: undefined;
				},
			}),
		[
			entries,
			ownModuleVisibility,
			menuSource,
			menuCaseSelections,
			mode,
			session,
			lookup,
			deviceCases,
		],
	);
	const hiddenItemsOf = useCallback(
		(listed: readonly MenuScreenEntry[]) =>
			previewHiddenScreenEntries({
				doc: menuSource.doc,
				entries: listed,
				visibility: entryVisibility,
				ownModuleVisibility,
				name: (entry) =>
					(localizedValues.get(
						entry.kind === "form"
							? makeTranslationUnitId("form", entry.formUuid, "name")
							: makeTranslationUnitId("module", entry.moduleUuid, "name"),
					) as string | undefined) ??
					(entry.kind === "form"
						? menuSource.forms[entry.formUuid]?.name
						: menuSource.modules[entry.moduleUuid]?.name) ??
					"",
				summary: (owner) =>
					owner.hiddenFromMenu === true
						? OFF_THE_MENU_SUMMARY
						: summarizeFilter(owner.displayCondition, {
								...(owner.caseType !== undefined && {
									currentCaseType: owner.caseType,
								}),
								projectProse,
							}),
			}),
		[
			menuSource,
			entryVisibility,
			ownModuleVisibility,
			localizedValues,
			projectProse,
		],
	);
	const hiddenRows = useMemo(
		() => hiddenItemsOf(rowEntries),
		[hiddenItemsOf, rowEntries],
	);
	const hiddenChildren = useMemo(
		() => hiddenItemsOf(tileEntries),
		[hiddenItemsOf, tileEntries],
	);

	/* The home screen already routes both redirecting shapes; this covers landing
	 * on the module URL directly (deep link, breadcrumb, flipping to preview).
	 * `moduleScreenNavigation.ts` owns which landing applies and why. */
	const isCaseFirst = useIsCaseFirstModule(moduleUuid);
	const isBareCaseList = useIsBareCaseListModule(moduleUuid);
	const endpointLaunch = usePreviewEntryPointLaunch();
	const preserveEntryPointMenu =
		mode !== "edit" &&
		endpointLaunch?.location.kind === "module" &&
		endpointLaunch.location.moduleUuid === moduleUuid;
	const landing = moduleScreenLanding({
		preserveEntryPointMenu,
		hasModule: !!moduleUuid,
		hasChildren,
		hasSelectedCase: selectedMenuCase !== undefined,
		isBareCaseList,
		isCaseFirst,
		mode: mode === "edit" ? "edit" : "preview",
	});
	useEffect(() => {
		if (!moduleUuid) return;
		if (
			mode !== "edit" &&
			requiredParentCase &&
			taskContinuation?.moduleUuid !== moduleUuid
		) {
			setPreviewCaseTarget(undefined);
			const continuingRequest =
				previewParentCaseRequest?.selectingModuleUuid === moduleUuid
					? previewParentCaseRequest
					: undefined;
			const onward = continuingRequest?.returnModuleUuids ?? [];
			const structuralParentUuid = moduleParent(menuSource, moduleUuid);
			const resumeLocation =
				continuingRequest?.resumeLocation ??
				previewParentCaseResumeLocation(loc, moduleUuid);
			setPreviewParentCaseRequest({
				selectingModuleUuid: requiredParentCase.moduleUuid,
				returnModuleUuids: [moduleUuid, ...onward],
				...(resumeLocation !== undefined && { resumeLocation }),
				cancelLocation:
					continuingRequest?.cancelLocation ??
					(structuralParentUuid
						? { kind: "module", moduleUuid: structuralParentUuid }
						: { kind: "home" }),
			});
			navigate.replace({
				kind: "module",
				moduleUuid: requiredParentCase.moduleUuid,
			});
			return;
		}
		if (
			mode !== "edit" &&
			previewParentCaseRequest?.selectingModuleUuid === moduleUuid
		) {
			navigate.replace({ kind: "cases", moduleUuid });
			return;
		}
		if (landing.kind === "replace-with-case-list") {
			navigate.replace({ kind: "cases", moduleUuid });
		} else if (landing.kind === "open-case-list") {
			navigate.openCaseList(moduleUuid);
		}
	}, [
		landing.kind,
		loc,
		menuSource,
		mode,
		moduleUuid,
		navigate,
		previewParentCaseRequest,
		requiredParentCase,
		setPreviewCaseTarget,
		setPreviewParentCaseRequest,
		taskContinuation,
	]);

	/* Forward the gated dispatch's outcome: a rename the commit gate
	 * refuses (e.g. duplicating another module's name) keeps the editor
	 * open with the draft and surfaces the finding inline; the saved
	 * checkmark only fires on a committed rename. */
	const saveModuleName = useCallback(
		(name: string) =>
			moduleUuid
				? language.isSource
					? inline.updateModule(moduleUuid, { name })
					: moduleNameEditor.saveTarget(name)
				: undefined,
		[inline, language.isSource, moduleNameEditor, moduleUuid],
	);

	/* In a menu whose forms read the search the claim sits in each case
	 * form's entry: opening one posts it for the menu's chosen cases and,
	 * under a selected parent, the entry's other case datums. The form opens
	 * once it has landed, so its device holds them. */
	const openFormWithMenuCase = async (
		formModuleUuid: Uuid,
		formUuid: Uuid,
		cases: NonNullable<typeof selectedMenuCase>["cases"],
	) => {
		const formModule = menuSource.modules[formModuleUuid];
		const claimIds =
			formModule !== undefined && moduleFormsReadSearch(formModule)
				? claimableCaseIds([
						...cases,
						...parentSelectClaimChoices(
							menuSource.doc,
							formModuleUuid,
							menuCaseSelections,
						),
					])
				: [];
		if (claimIds.length > 0) {
			const outcome = await claimSearchedCases(claimIds);
			if (outcome.kind === "superseded") return;
			if (outcome.kind !== "claimed") {
				showToast(
					"error",
					"message" in outcome
						? outcome.message
						: "Couldn't open this case. Try again in a moment.",
				);
				return;
			}
		}
		setPreviewCaseTarget({
			formUuid,
			cases: cases.map(({ caseId, caseName }) => ({
				caseId,
				...(caseName !== undefined && { caseName }),
			})),
		});
		navigate.openForm(formModuleUuid, formUuid);
	};

	/* A menu's case list as its own entry, after its menu's forms. On a
	 * case-first screen it is listed once the case is chosen, and choosing it
	 * then is the selection: Web Apps steps back to this menu, Android goes
	 * to the phone's home screen. Edit mode lists it after the forms and
	 * opens the case list. */
	const caseListEntryOf = (entryModuleUuid: Uuid) =>
		previewCaseListMenuEntry(menuSource.doc, entryModuleUuid, {
			isCaseFirst: mode !== "edit" && isCaseFirst,
			hasSelectedCase: selectedMenuCase !== undefined,
		});
	const chooseCaseListEntry = (
		entryModuleUuid: Uuid,
		caseListEntry: NonNullable<ReturnType<typeof caseListEntryOf>>,
	) => {
		if (caseListEntry.action === "open-case-list") {
			setPreviewCaseTarget(undefined);
			navigate.openCaseList(entryModuleUuid);
			return;
		}
		if (caseListMenuItemSelection(platformRules).kind === "device-home") {
			navigate.goHome();
			setPreviewAtDeviceHome(true);
		}
	};

	if (!mod) return null;
	/* Suppress the form-menu flash while the redirect above navigates away. */
	if (
		landing.kind !== "form-menu" ||
		(mode !== "edit" &&
			(requiredParentCase ||
				previewParentCaseRequest?.selectingModuleUuid === moduleUuid))
	) {
		return null;
	}

	const hasCase = !!mod.caseType;
	const canEdit = mode === "edit" && isReady;
	const localizedModuleName =
		(localizedValues.get(moduleNameUnitId) as string | undefined) ?? mod.name;

	return (
		<ContentFrame width="5xl" className="p-6 space-y-4">
			<div className="flex items-center gap-2">
				{canEdit ? (
					<EditableTitle
						value={localizedModuleName}
						onSave={saveModuleName}
						ariaLabel="Module name"
					/>
				) : (
					<EditableTitle
						value={localizedModuleName}
						readOnly
						ariaLabel="Module name"
					/>
				)}
				{/* Module-settings gear: the module-level analog of
				 *  `FormScreen`'s `FormSettingsButton` on the form header.
				 *  Edit-mode only (matches the form-header gate) and only once
				 *  the module uuid has resolved from the URL. Its `ml-auto`
				 *  trigger pushes it to the right edge of this header row. */}
				{canEdit && moduleUuid && (
					<ModuleSettingsButton moduleUuid={moduleUuid} />
				)}
			</div>

			{mode !== "edit" &&
				hasChildren &&
				hasCase &&
				(isCaseFirst || isBareCaseList) && (
					<button
						type="button"
						onClick={() => {
							setPreviewCaseTarget(undefined);
							navigate.openCaseList(moduleUuid);
						}}
						className="w-full flex items-center gap-3 p-3 rounded-lg bg-pv-surface border border-pv-input-border hover:border-pv-input-focus transition-all duration-200 cursor-pointer text-left group"
					>
						<Icon
							icon={tablerListDetails}
							width="18"
							height="18"
							className="text-nova-text-muted group-hover:text-pv-accent-bright shrink-0"
						/>
						<div className="flex-1 min-w-0">
							<div className="text-sm font-medium text-nova-text">
								{message("cases")}
							</div>
							{selectedMenuCase && (
								<div className="text-xs text-nova-text-muted truncate">
									{selectedMenuChoices.length === 1
										? message("selectedCase", {
												name:
													selectedMenuChoices[0]?.caseName || message("case"),
											})
										: message("selectedCountMany", {
												count: selectedMenuChoices.length,
											})}
								</div>
							)}
						</div>
					</button>
				)}

			<div className="space-y-2">
				{rowEntries.map((entry, fIdx) => {
					if (
						mode !== "edit" &&
						hasChildren &&
						isCaseFirst &&
						selectedMenuCase === undefined
					) {
						return null;
					}
					const key = menuScreenEntryKey(entry);
					const visibility = entryVisibility.get(key) ?? "shown";
					if (visibility === "hidden") return null;
					if (visibility === "pending") {
						return (
							<Skeleton key={key} className="h-[58px] w-full rounded-lg" />
						);
					}
					if (entry.kind === "case-list") {
						const caseListEntry = caseListEntryOf(entry.moduleUuid);
						if (caseListEntry === undefined) return null;
						return (
							<PreviewCaseListRow
								key={key}
								entry={caseListEntry}
								index={fIdx}
								label={
									(localizedValues.get(caseListEntry.labelUnitId) as
										| string
										| undefined) ?? caseListEntry.label
								}
								onClick={() =>
									chooseCaseListEntry(entry.moduleUuid, caseListEntry)
								}
							/>
						);
					}
					if (entry.kind !== "form") return null;
					const form = menuSource.forms[entry.formUuid];
					if (form === undefined) return null;
					const formModuleUuid = entry.moduleUuid;
					const localizedFormName =
						(localizedValues.get(
							makeTranslationUnitId("form", form.uuid, "name"),
						) as string | undefined) ?? form.name;

					const handleClick = () => {
						const formModule = menuSource.modules[formModuleUuid];
						const launch = formLaunch({
							formType: form.type,
							moduleHasCaseType: formModule?.caseType !== undefined,
						});
						/* The case chosen on this screen, as the form's own menu
						 * reads it: its own selection, the same-type selection of
						 * this menu, or this menu's case as its parent case. */
						const formMenuCase = previewMenuCaseContext(
							menuSource,
							formModuleUuid,
							menuCaseSelections,
						).selectedCase;
						const continuedWorld =
							taskContinuation?.moduleUuid === moduleUuid
								? taskContinuation.caseDatabase
								: undefined;
						if (continuedWorld) {
							const selectingModuleUuids = previousTaskFormSelectors(
								docApi.getState(),
								form.uuid,
								menuCaseSelections,
							);
							setTaskContinuation({
								moduleUuid: formModuleUuid,
								formUuid: form.uuid,
								returnModuleUuid: moduleUuid,
								selectingModuleUuids,
								caseDatabase: continuedWorld,
							});
							setPreviewCaseTarget({
								formUuid: form.uuid,
								...(launch.kind === "select-case-first"
									? formMenuCase && { cases: formMenuCase.cases }
									: { cases: [] }),
								caseDatabase: continuedWorld,
								caseData:
									formMenuCase?.cases.length === 1
										? caseDatabaseToFormPreloads(
												continuedWorld,
												formMenuCase.cases[0].caseId,
												reachableCaseTypes(
													formModule?.caseType,
													menuSource.caseTypes,
												),
											)
										: undefined,
							});
							const [first, ...remaining] = selectingModuleUuids;
							if (first === undefined)
								navigate.openForm(formModuleUuid, form.uuid);
							else {
								if (remaining.length > 0 || first !== formModuleUuid)
									setPreviewParentCaseRequest({
										selectingModuleUuid: first,
										returnModuleUuids:
											remaining.length > 0 ? remaining : [formModuleUuid],
										resumeLocation:
											remaining.length > 0
												? { kind: "cases", moduleUuid: formModuleUuid }
												: {
														kind: "form",
														moduleUuid: formModuleUuid,
														formUuid: form.uuid,
													},
										cancelLocation: { kind: "module", moduleUuid },
									});
								navigate.openCaseList(first);
							}
							return;
						}
						if (launch.kind === "select-case-first") {
							if (formMenuCase) {
								void openFormWithMenuCase(
									formModuleUuid,
									form.uuid,
									formMenuCase.cases,
								);
							} else {
								setPreviewCaseTarget({ formUuid: form.uuid });
								navigate.openCaseList(formModuleUuid);
							}
						} else {
							navigate.openForm(formModuleUuid, form.uuid);
						}
					};

					return (
						<PreviewFormRow
							key={key}
							form={form}
							index={fIdx}
							label={localizedFormName}
							onClick={handleClick}
						/>
					);
				})}
			</div>
			<HiddenItemsReveal items={hiddenRows} />

			{children.length > 0 && (
				<div className="space-y-2">
					{children.map((child, index) => {
						const visibility =
							entryVisibility.get(
								menuScreenEntryKey({ kind: "menu", moduleUuid: child.uuid }),
							) ?? "shown";
						if (visibility === "hidden") return null;
						if (visibility === "pending") {
							return (
								<Skeleton
									key={child.uuid}
									className="h-[58px] w-full rounded-lg"
								/>
							);
						}
						const childName =
							(localizedValues.get(
								makeTranslationUnitId("module", child.uuid, "name"),
							) as string | undefined) ?? child.name;
						const childCase = previewMenuCaseContext(
							menuSource,
							child.uuid,
							menuCaseSelections,
						);
						return (
							<motion.button
								key={child.uuid}
								type="button"
								initial={{ opacity: 0, y: 12 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ delay: index * 0.06, duration: 0.3 }}
								onClick={() => {
									setPreviewCaseTarget(undefined);
									if (childCase.requiredParentCase) {
										setPreviewParentCaseRequest({
											selectingModuleUuid:
												childCase.requiredParentCase.moduleUuid,
											returnModuleUuids: [child.uuid],
											cancelLocation: { kind: "module", moduleUuid },
										});
										navigate.openModule(
											childCase.requiredParentCase.moduleUuid,
										);
										return;
									}
									openModuleLanding(
										navigate,
										child.uuid,
										moduleLanding({
											isCaseFirst: caseFirstModules.has(child.uuid),
											isBareCaseList: previewModuleScreenIsBareCaseList(
												menuSource.doc,
												child.uuid,
											),
											hasChildren: moduleHasChildren(menuSource, child.uuid),
											hasSelectedCase: childCase.selectedCase !== undefined,
										}),
									);
								}}
								className="w-full flex items-center gap-3 p-3 rounded-lg bg-pv-surface border border-pv-input-border hover:border-pv-input-focus transition-all duration-200 cursor-pointer text-left group"
							>
								<Icon
									icon={tablerGridDots}
									width="18"
									height="18"
									className="text-nova-text-muted group-hover:text-pv-accent-bright shrink-0"
								/>
								<div className="text-sm font-medium text-nova-text">
									{childName}
								</div>
							</motion.button>
						);
					})}
				</div>
			)}
			<HiddenItemsReveal items={hiddenChildren} />
		</ContentFrame>
	);
}
