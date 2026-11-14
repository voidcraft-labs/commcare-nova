"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import { motion } from "motion/react";
import { useCallback, useMemo } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { summarizeFilter } from "@/components/builder/case-list-config/predicateSummary";
import { EditableTitle } from "@/components/builder/EditableTitle";
import {
	useBuilderLanguage,
	useLocalizedValues,
	useTranslationUnitEditor,
} from "@/components/builder/localization/BuilderLocalizationProvider";
import { ProjectMediaImage } from "@/components/builder/media/ProjectMediaResource";
import { PreviewSetupNotice } from "@/components/builder/PreviewSetupNotice";
import { HiddenItemsReveal } from "@/components/preview/shared/HiddenItemsReveal";
import { Badge } from "@/components/shadcn/badge";
import { Skeleton } from "@/components/shadcn/skeleton";
import { useAppLogo } from "@/lib/doc/hooks/useAppLogo";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import {
	useCaseFirstModuleUuids,
	useMenuFormCounts,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	formLaunch,
	type MenuScreen,
	makeTranslationUnitId,
	moduleLanding,
} from "@/lib/domain";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import { withNavigationWidth } from "@/lib/preview/engine/previewDevice";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import { useNavigationDeviceCases } from "@/lib/preview/engine/useNavigationDeviceCases";
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
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import { useNavigate } from "@/lib/routing/hooks";
import {
	useBuilderIsReady,
	useEditMode,
	usePreviewAtDeviceHome,
	usePreviewDevice,
	usePreviewMenuCaseSelections,
	usePreviewPlatformRules,
	useSetPreviewCaseTarget,
	useSetPreviewParentCaseRequest,
} from "@/lib/session/hooks";
import { DeviceHomeScreen } from "./DeviceHomeScreen";
import { PreviewCaseListRow, PreviewFormRow } from "./MenuScreenRows";
import { openModuleLanding } from "./moduleLanding";

const FIRST_MENU: MenuScreen = { kind: "first-menu" };

/** The app's home: Android's device home screen while Preview running as
 *  Android is there, else the module list. Edit mode always shows the
 *  module list. */
export function HomeScreen() {
	const mode = useEditMode();
	const rules = usePreviewPlatformRules();
	const atDeviceHome = usePreviewAtDeviceHome();
	if (mode !== "edit" && rules.appHome === "device-home" && atDeviceHome)
		return <DeviceHomeScreen />;
	return <ModuleListHome />;
}

function ModuleListHome() {
	const canonicalAppName = useAppName();
	const language = useBuilderLanguage();
	const localizedValues = useLocalizedValues();
	const appNameUnitId = makeTranslationUnitId("app", "name");
	const appName =
		(localizedValues.get(appNameUnitId) as string | undefined) ??
		canonicalAppName;
	const appNameEditor = useTranslationUnitEditor(appNameUnitId);
	const projectProse = useProseProjection();
	const navigate = useNavigate();
	const { inline } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();
	const hasData = useDocHasData();
	const orderedModules = useOrderedModules();
	const menuSource = usePreviewMenuSource();
	const menuCaseSelections = usePreviewMenuCaseSelections();
	const setPreviewParentCaseRequest = useSetPreviewParentCaseRequest();
	const setPreviewCaseTarget = useSetPreviewCaseTarget();
	/* The first menu lists, in place, the forms and case lists of every menu
	 * that shows its forms there; edit mode keeps every top-level menu as the
	 * container of its forms. */
	const entries = useMemo(
		() =>
			mode === "edit"
				? authoringScreenEntries(menuSource.doc, FIRST_MENU)
				: previewScreenEntries(menuSource.doc, FIRST_MENU),
		[menuSource.doc, mode],
	);
	const modulesByUuid = useMemo(
		() => new Map(orderedModules.map((mod) => [mod.uuid, mod] as const)),
		[orderedModules],
	);
	/* Case-first modules (every form case-loading) land on the case list,
	 * not a form menu: the running app hoists the shared case selection. */
	const caseFirstModules = useCaseFirstModuleUuids();
	const menuFormCounts = useMenuFormCounts();
	const logo = useAppLogo();
	const platformRules = usePreviewPlatformRules();
	const lookup = usePreviewLookupStatus();
	const deviceCases = useNavigationDeviceCases(menuSource.caseTypes);
	/* Whoever Preview is running as: the member, or the persona they
	 * picked. The hook owns the hydration rule (Better Auth resolves a
	 * cached session synchronously on the browser's first paint while SSR
	 * has none) so every preview surface reads one identity. */
	const identity = useSelectedPreviewIdentity();
	const device = usePreviewDevice();
	const session = useMemo(
		() => previewSessionValues(identity, withNavigationWidth(device)),
		[identity, device],
	);

	/* The running preview gates the module list exactly as a device would
	 * (`<menu relevant>`); edit mode ("authoring surfaces never hide")
	 * shows everything. Hidden modules stay reachable through the reveal
	 * affordance below: ghosted, with each condition's summary. */
	const ownModuleVisibility = useMemo(
		() =>
			previewModuleOwnVisibility(menuSource.doc, {
				authoring: mode === "edit",
				session,
				lookup,
				deviceCases,
			}),
		[mode, session, lookup, menuSource, deviceCases],
	);
	/* Each entry's place on the running menu: a tile by its menu's tile
	 * visibility; a form or case list row by the menus whose condition it
	 * carries, then a form by its own condition. The first menu chooses no
	 * case, so a form condition reads the session alone. */
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
				selectedCaseOf: () => undefined,
			}),
		[
			entries,
			ownModuleVisibility,
			menuSource,
			mode,
			session,
			lookup,
			deviceCases,
		],
	);
	const hiddenEntries = useMemo(
		() =>
			previewHiddenScreenEntries({
				doc: menuSource.doc,
				entries,
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
			entries,
			entryVisibility,
			menuSource,
			ownModuleVisibility,
			localizedValues,
			projectProse,
		],
	);

	/* Forward the gated dispatch's outcome: a refused rename keeps the
	 * editor open with the draft and surfaces the finding inline; the
	 * saved checkmark only fires on a committed rename. */
	const saveAppName = useCallback(
		(name: string) =>
			language.isSource
				? inline.updateApp({ app_name: name })
				: appNameEditor.saveTarget(name),
		[appNameEditor, inline, language.isSource],
	);

	if (!hasData) return null;

	const canEdit = mode === "edit" && isReady;

	return (
		<ContentFrame width="5xl" className="p-6 space-y-4">
			{/* The logo banner stands in for the places Web Apps shows the app's
			    logo (its app list tile and its menu header), since Preview opens
			    inside the app. Running as Android draws none, as Android ignores
			    the logo; edit mode always draws it. */}
			{logo && (mode === "edit" || platformRules.logo) && (
				<ProjectMediaImage
					assetId={logo}
					alt=""
					className="max-h-16 max-w-full rounded-md object-contain"
				/>
			)}
			<div className="flex items-center gap-2">
				{canEdit ? (
					<EditableTitle
						value={appName}
						onSave={saveAppName}
						ariaLabel="Application name"
					/>
				) : (
					<EditableTitle
						value={appName}
						readOnly
						ariaLabel="Application name"
					/>
				)}
			</div>
			{mode !== "edit" && <PreviewSetupNotice />}
			<div className="grid gap-3">
				{entries.map((entry, mIdx) => {
					const key = menuScreenEntryKey(entry);
					const visibility = entryVisibility.get(key) ?? "shown";
					if (visibility === "hidden") return null;
					if (visibility === "pending") {
						return (
							<Skeleton
								key={key}
								className={
									entry.kind === "menu"
										? "h-[74px] w-full rounded-xl"
										: "h-[58px] w-full rounded-lg"
								}
							/>
						);
					}
					if (entry.kind === "form") {
						const form = menuSource.forms[entry.formUuid];
						if (form === undefined) return null;
						return (
							<PreviewFormRow
								key={key}
								form={form}
								index={mIdx}
								label={
									(localizedValues.get(
										makeTranslationUnitId("form", form.uuid, "name"),
									) as string | undefined) ?? form.name
								}
								onClick={() => {
									/* The first menu chooses no case: a form that opens one
									 * opens its own menu's case list first. */
									const launch = formLaunch({
										formType: form.type,
										moduleHasCaseType:
											menuSource.modules[entry.moduleUuid]?.caseType !==
											undefined,
									});
									if (launch.kind === "select-case-first") {
										setPreviewCaseTarget({ formUuid: form.uuid });
										navigate.openCaseList(entry.moduleUuid);
									} else navigate.openForm(entry.moduleUuid, form.uuid);
								}}
							/>
						);
					}
					if (entry.kind === "case-list") {
						const caseList = previewCaseListMenuEntry(
							menuSource.doc,
							entry.moduleUuid,
							{ isCaseFirst: false, hasSelectedCase: false },
						);
						if (caseList === undefined) return null;
						return (
							<PreviewCaseListRow
								key={key}
								entry={caseList}
								index={mIdx}
								label={
									(localizedValues.get(caseList.labelUnitId) as
										| string
										| undefined) ?? caseList.label
								}
								onClick={() => {
									setPreviewCaseTarget(undefined);
									navigate.openCaseList(entry.moduleUuid);
								}}
							/>
						);
					}
					const mod = modulesByUuid.get(entry.moduleUuid);
					if (mod === undefined) return null;
					const localizedModuleName =
						(localizedValues.get(
							makeTranslationUnitId("module", mod.uuid, "name"),
						) as string | undefined) ?? mod.name;
					const formCount = menuFormCounts[mod.uuid] ?? 0;
					const hasChildren = moduleHasChildren(menuSource, mod.uuid);
					const menuCaseContext = previewMenuCaseContext(
						menuSource,
						mod.uuid,
						menuCaseSelections,
					);
					return (
						<motion.button
							key={mod.uuid}
							initial={{ opacity: 0, y: 12 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{
								delay: mIdx * 0.06,
								duration: 0.3,
								ease: [0.16, 1, 0.3, 1],
							}}
							onClick={() => {
								if (menuCaseContext.requiredParentCase) {
									setPreviewParentCaseRequest({
										selectingModuleUuid:
											menuCaseContext.requiredParentCase.moduleUuid,
										returnModuleUuids: [mod.uuid],
										cancelLocation: { kind: "home" },
									});
									navigate.openModule(
										menuCaseContext.requiredParentCase.moduleUuid,
									);
									return;
								}
								/* Case-first modules land on the case list (the running
								 * app hoists the shared case selection); a bare case list
								 * (its case list menu entry and no forms) has no form menu
								 * at all, so it too opens straight to its case list.
								 * `moduleLanding` is the one rule, shared with a form's
								 * after-submit link to a module. */
								openModuleLanding(
									navigate,
									mod.uuid,
									moduleLanding({
										isCaseFirst: caseFirstModules.has(mod.uuid),
										isBareCaseList: previewModuleScreenIsBareCaseList(
											menuSource.doc,
											mod.uuid,
										),
										hasChildren,
										hasSelectedCase: menuCaseContext.selectedCase !== undefined,
									}),
								);
							}}
							className="nova-focusable w-full flex items-center gap-4 p-4 rounded-xl bg-pv-surface border border-pv-input-border hover:border-pv-input-focus hover:translate-y-[-1px] transition-all duration-200 cursor-pointer text-left group"
						>
							{mod.icon ? (
								// Module menu-tile icon: CommCare shows it on the
								// module's home-screen tile.
								<ProjectMediaImage
									assetId={mod.icon}
									alt=""
									className="w-10 h-10 rounded-lg object-cover shrink-0"
								/>
							) : (
								<div className="w-10 h-10 rounded-lg bg-pv-accent/10 flex items-center justify-center shrink-0">
									<Icon
										icon={tablerGridDots}
										width="20"
										height="20"
										className="text-pv-accent-bright"
									/>
								</div>
							)}
							<div className="flex-1 min-w-0">
								<div className="font-medium text-nova-text group-hover:text-pv-accent-bright transition-colors">
									{localizedModuleName}
								</div>
								{mode === "edit" && mod.caseType && (
									<Badge variant="muted" className="mt-1">
										{mod.caseType}
									</Badge>
								)}
							</div>
							<span className="text-xs text-nova-text-muted shrink-0">
								{runtimeMessage(
									mode === "edit" ? undefined : language.language,
									formCount === 1 ? "formCountOne" : "formCountMany",
									{
										count: formCount,
									},
								)}
							</span>
						</motion.button>
					);
				})}
			</div>
			<HiddenItemsReveal items={hiddenEntries} />
		</ContentFrame>
	);
}
