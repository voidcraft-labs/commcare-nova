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
import { ProjectMediaImage } from "@/components/builder/media/ProjectMediaResource";
import {
	formLaunch,
	moduleScreenLanding,
} from "@/components/preview/screens/moduleScreenNavigation";
import { HiddenItemsReveal } from "@/components/preview/shared/HiddenItemsReveal";
import { Skeleton } from "@/components/shadcn/skeleton";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import {
	useCaseFirstModuleUuids,
	useIsBareCaseListModule,
	useIsCaseFirstModule,
	useOrderedMenuForms,
} from "@/lib/doc/hooks/useModuleIds";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { Uuid } from "@/lib/doc/types";
import { makeTranslationUnitId, moduleParent } from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import { formDisplayVisibility } from "@/lib/preview/engine/displayConditionEvaluation";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import {
	moduleHasChildren,
	previewMenuCaseContext,
	previewMenuModuleUuids,
	previewModuleVisibility,
} from "@/lib/preview/menuProjection";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import type { Location } from "@/lib/routing/types";
import {
	useBuilderIsReady,
	useEditMode,
	usePreviewEntryPointLaunch,
	usePreviewMenuCaseSelections,
	usePreviewParentCaseRequest,
	useSetPreviewCaseTarget,
	useSetPreviewParentCaseRequest,
} from "@/lib/session/hooks";
import { moduleLanding, openModuleLanding } from "./moduleLanding";

interface ModuleScreenProps {
	/** This screen's identity, which module is being displayed. Passed from
	 *  PreviewShell so the component remains valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "module" }>;
}

/** A configuration URL runs its owning Form/Results surface in Preview, so
 * it is as resumable as the canonical running URL. Module and module-condition
 * locations are already menu checkpoints and need no leaf restoration. */
export function previewParentCaseResumeLocation(
	loc: Location,
	moduleUuid: Uuid,
): Location | undefined {
	if (
		loc.kind === "home" ||
		loc.kind === "app-setup" ||
		loc.kind === "project-data" ||
		loc.kind === "module" ||
		loc.kind === "module-condition" ||
		loc.moduleUuid !== moduleUuid
	) {
		return undefined;
	}
	return loc;
}

export function ModuleScreen({ screen }: ModuleScreenProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	const projectProse = useProseProjection();
	const { inline } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();
	const setPreviewCaseTarget = useSetPreviewCaseTarget();
	const setPreviewParentCaseRequest = useSetPreviewParentCaseRequest();
	const previewParentCaseRequest = usePreviewParentCaseRequest();
	const menuSource = usePreviewMenuSource();
	const menuCaseSelections = usePreviewMenuCaseSelections();
	const caseFirstModules = useCaseFirstModuleUuids();

	/** Activity keeps a visited module mounted after the URL moves elsewhere,
	 * so this component must read its own stable screen identity. */
	const moduleUuid = screen.moduleUuid;

	const mod = useModuleEntity(moduleUuid);
	/* The menu lists menu forms only: a no-matches registration form opens
	 * from Results after an empty search, never from here. */
	const forms = useOrderedMenuForms(moduleUuid);
	const language = useBuilderLanguage();
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
	const session = useMemo(() => previewSessionValues(identity), [identity]);
	const childUuids = useMemo(
		() => previewMenuModuleUuids(menuSource, moduleUuid),
		[menuSource, moduleUuid],
	);
	const children = useMemo(
		() => childUuids.flatMap((uuid) => menuSource.modules[uuid] ?? []),
		[childUuids, menuSource.modules],
	);
	const hasChildren = children.length > 0;
	const menuCaseContext = useMemo(
		() => previewMenuCaseContext(menuSource, moduleUuid, menuCaseSelections),
		[menuSource, moduleUuid, menuCaseSelections],
	);
	const selectedMenuCase = menuCaseContext.selectedCase;
	const selectedMenuChoices = selectedMenuCase?.cases ?? [];
	const onlySelectedMenuCase =
		selectedMenuChoices.length === 1 ? selectedMenuChoices[0] : undefined;
	const requiredParentCase = menuCaseContext.requiredParentCase;
	const selectedCaseProjection = useMemo(
		() =>
			onlySelectedMenuCase?.caseProperties
				? new Map(Object.entries(onlySelectedMenuCase.caseProperties))
				: undefined,
		[onlySelectedMenuCase?.caseProperties],
	);

	/* The running preview gates the forms-first form menu exactly as a
	 * device would (`<command relevant>`). Forms-first conditions are
	 * session-only (the validator admits property reads only in the
	 * case-first flow, whose menu lives on the case-list screen), so no
	 * case projection exists here. Edit mode shows everything. */
	const formVisibility = useMemo(
		() =>
			new Map(
				forms.map((form) => [
					form.uuid,
					mode === "edit"
						? ("shown" as const)
						: formDisplayVisibility({
								condition: form.displayCondition,
								session,
								...(mod?.caseType ? { currentCaseType: mod.caseType } : {}),
								caseProjection: selectedCaseProjection,
								lookup,
							}),
				]),
			),
		[forms, mode, session, lookup, mod?.caseType, selectedCaseProjection],
	);
	const hiddenForms = useMemo(
		() =>
			forms
				.filter((form) => formVisibility.get(form.uuid) === "hidden")
				.map((form) => ({
					key: form.uuid,
					name:
						(localizedValues.get(
							makeTranslationUnitId("form", form.uuid, "name"),
						) as string | undefined) ?? form.name,
					summary: summarizeFilter(form.displayCondition, { projectProse }),
				})),
		[forms, formVisibility, projectProse, localizedValues],
	);
	const moduleVisibility = useMemo(() => {
		return previewModuleVisibility(menuSource, {
			authoring: mode === "edit",
			session,
			lookup,
		});
	}, [lookup, menuSource, mode, session]);
	const hiddenChildren = useMemo(
		() =>
			children
				.filter((child) => moduleVisibility.get(child.uuid) === "hidden")
				.map((child) => ({
					key: child.uuid,
					name:
						(localizedValues.get(
							makeTranslationUnitId("module", child.uuid, "name"),
						) as string | undefined) ?? child.name,
					summary: summarizeFilter(child.displayCondition, {
						...(child.caseType ? { currentCaseType: child.caseType } : {}),
						projectProse,
					}),
				})),
		[children, localizedValues, moduleVisibility, projectProse],
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
		if (mode !== "edit" && requiredParentCase) {
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
							<div className="text-sm font-medium text-nova-text">Cases</div>
							{selectedMenuCase && (
								<div className="text-xs text-nova-text-muted truncate">
									{selectedMenuChoices.length === 1
										? `Selected: ${selectedMenuChoices[0]?.caseName ?? "Case"}`
										: `${selectedMenuChoices.length} cases selected`}
								</div>
							)}
						</div>
					</button>
				)}

			<div className="space-y-2">
				{forms.map((form, fIdx) => {
					if (
						mode !== "edit" &&
						hasChildren &&
						isCaseFirst &&
						selectedMenuCase === undefined
					) {
						return null;
					}
					const localizedFormName =
						(localizedValues.get(
							makeTranslationUnitId("form", form.uuid, "name"),
						) as string | undefined) ?? form.name;
					const visibility = formVisibility.get(form.uuid) ?? "shown";
					if (visibility === "hidden") return null;
					if (visibility === "pending") {
						return (
							<Skeleton
								key={form.uuid}
								className="h-[58px] w-full rounded-lg"
							/>
						);
					}
					const icon = formTypeIcons[form.type];

					const handleClick = () => {
						if (!moduleUuid) return;
						const launch = formLaunch({
							formType: form.type,
							moduleHasCaseType: hasCase,
						});
						if (launch.kind === "select-case-first") {
							if (selectedMenuCase) {
								setPreviewCaseTarget({
									formUuid: form.uuid,
									cases: selectedMenuCase.cases.map(({ caseId, caseName }) => ({
										caseId,
										...(caseName !== undefined && { caseName }),
									})),
								});
								navigate.openForm(moduleUuid, form.uuid);
							} else {
								setPreviewCaseTarget({ formUuid: form.uuid });
								navigate.openCaseList(moduleUuid);
							}
						} else {
							navigate.openForm(moduleUuid, form.uuid);
						}
					};

					return (
						<motion.button
							key={form.uuid}
							initial={{ opacity: 0, y: 12 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{
								delay: fIdx * 0.06,
								duration: 0.3,
								ease: [0.16, 1, 0.3, 1],
							}}
							onClick={handleClick}
							className="w-full flex items-center gap-3 p-3 rounded-lg bg-pv-surface border border-pv-input-border hover:border-pv-input-focus transition-all duration-200 cursor-pointer text-left group"
						>
							{form.icon ? (
								// Form menu-tile icon: CommCare shows it on the form's
								// command in the module menu.
								<ProjectMediaImage
									assetId={form.icon}
									alt=""
									className="size-7 rounded-lg object-cover shrink-0"
								/>
							) : (
								<Icon
									icon={icon}
									width="18"
									height="18"
									className="text-nova-text-muted group-hover:text-pv-accent-bright transition-colors shrink-0"
								/>
							)}
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium text-nova-text">
									{localizedFormName}
								</div>
							</div>
						</motion.button>
					);
				})}
			</div>
			<HiddenItemsReveal items={hiddenForms} />

			{children.length > 0 && (
				<div className="space-y-2">
					{children.map((child, index) => {
						const visibility = moduleVisibility.get(child.uuid) ?? "shown";
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
											isBareCaseList: child.caseListOnly === true,
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
