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
import { HiddenItemsReveal } from "@/components/preview/shared/HiddenItemsReveal";
import { Badge } from "@/components/shadcn/badge";
import { Skeleton } from "@/components/shadcn/skeleton";
import { useAppLogo } from "@/lib/doc/hooks/useAppLogo";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useAppStructure } from "@/lib/doc/hooks/useAppStructure";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import {
	useCaseFirstModuleUuids,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { makeTranslationUnitId } from "@/lib/domain";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { useSelectedPreviewIdentity } from "@/lib/preview/hooks/useSelectedPreviewIdentity";
import {
	moduleHasChildren,
	previewMenuCaseContext,
	previewMenuModuleUuids,
	previewModuleVisibility,
} from "@/lib/preview/menuProjection";
import { useNavigate } from "@/lib/routing/hooks";
import {
	useBuilderIsReady,
	useEditMode,
	usePreviewMenuCaseSelections,
	useSetPreviewParentCaseRequest,
} from "@/lib/session/hooks";
import { moduleLanding, openModuleLanding } from "./moduleLanding";

export function HomeScreen() {
	const canonicalAppName = useAppName();
	const language = useBuilderLanguage();
	const localizedValues = useLocalizedValues();
	const appNameUnitId = makeTranslationUnitId("app", "name");
	const appName =
		(localizedValues.get(appNameUnitId) as string | undefined) ??
		canonicalAppName;
	const appNameEditor = useTranslationUnitEditor(appNameUnitId);
	/* Read only the `formOrder` slice of the app structure: the module
	 * sequence is served separately by `useOrderedModules()` below.
	 * `useAppStructure` returns a shallow-stable pair, so destructuring
	 * one field keeps the reference cheap. */
	const { formOrder } = useAppStructure();
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
	const modules = useMemo(() => {
		const roots = new Set(previewMenuModuleUuids(menuSource, null));
		return orderedModules.filter((mod) => roots.has(mod.uuid));
	}, [menuSource, orderedModules]);
	/* Case-first modules (every form case-loading) land on the case list,
	 * not a form menu: the running app hoists the shared case selection. */
	const caseFirstModules = useCaseFirstModuleUuids();
	const logo = useAppLogo();
	const lookup = usePreviewLookupStatus();
	/* Whoever Preview is running as: the member, or the persona they
	 * picked. The hook owns the hydration rule (Better Auth resolves a
	 * cached session synchronously on the browser's first paint while SSR
	 * has none) so every preview surface reads one identity. */
	const identity = useSelectedPreviewIdentity();
	const session = useMemo(() => previewSessionValues(identity), [identity]);

	/* The running preview gates the module list exactly as a device would
	 * (`<menu relevant>`); edit mode ("authoring surfaces never hide")
	 * shows everything. Hidden modules stay reachable through the reveal
	 * affordance below: ghosted, with each condition's summary. */
	const moduleVisibility = useMemo(() => {
		return previewModuleVisibility(menuSource, {
			authoring: mode === "edit",
			session,
			lookup,
		});
	}, [mode, session, lookup, menuSource]);
	const hiddenModules = useMemo(
		() =>
			modules
				.filter((mod) => moduleVisibility.get(mod.uuid) === "hidden")
				.map((mod) => ({
					key: mod.uuid,
					name:
						(localizedValues.get(
							makeTranslationUnitId("module", mod.uuid, "name"),
						) as string | undefined) ?? mod.name,
					summary: summarizeFilter(mod.displayCondition, {
						...(mod.caseType !== undefined && {
							currentCaseType: mod.caseType,
						}),
						projectProse,
					}),
				})),
		[modules, moduleVisibility, projectProse, localizedValues],
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
			{/* The web-apps logo banner: CommCare shows the app logo at the top
			    of the home screen. */}
			{logo && (
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
			<div className="grid gap-3">
				{modules.map((mod, mIdx) => {
					const localizedModuleName =
						(localizedValues.get(
							makeTranslationUnitId("module", mod.uuid, "name"),
						) as string | undefined) ?? mod.name;
					const visibility = moduleVisibility.get(mod.uuid) ?? "shown";
					if (visibility === "hidden") return null;
					if (visibility === "pending") {
						return (
							<Skeleton key={mod.uuid} className="h-[74px] w-full rounded-xl" />
						);
					}
					const formCount = formOrder[mod.uuid]?.length ?? 0;
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
									});
									navigate.openModule(
										menuCaseContext.requiredParentCase.moduleUuid,
									);
									return;
								}
								/* Case-first modules land on the case list (the running
								 * app hoists the shared case selection); a caseListOnly
								 * module has no form menu at all, so it too opens straight
								 * to its case list. `moduleLanding` is the one rule, shared
								 * with a form's after-submit link to a module. */
								openModuleLanding(
									navigate,
									mod.uuid,
									moduleLanding({
										isCaseFirst: caseFirstModules.has(mod.uuid),
										isBareCaseList: mod.caseListOnly === true,
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
								{mod.caseType && (
									<Badge variant="muted" className="mt-1">
										{mod.caseType}
									</Badge>
								)}
							</div>
							<span className="text-xs text-nova-text-muted shrink-0">
								{formCount} form{formCount !== 1 ? "s" : ""}
							</span>
						</motion.button>
					);
				})}
			</div>
			<HiddenItemsReveal items={hiddenModules} />
		</ContentFrame>
	);
}
