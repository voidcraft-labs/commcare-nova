"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
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
	choosePreviewMenuTile,
	previewModuleAsksParentCase,
	previewParentCaseRequestFor,
	previewTargetKeptForParentCase,
} from "@/components/preview/screens/moduleScreenNavigation";
import { HiddenItemsReveal } from "@/components/preview/shared/HiddenItemsReveal";
import {
	PinnedCaseTile,
	usePinnedCaseTile,
} from "@/components/preview/shared/PinnedCaseTile";
import { PreviewDataRefusalPanel } from "@/components/preview/shared/PreviewDataRefusal";
import { Badge } from "@/components/shadcn/badge";
import { Skeleton } from "@/components/shadcn/skeleton";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import {
	useCaseFirstModuleUuids,
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
	reachableCaseTypes,
} from "@/lib/domain";
import { generatedWordingId } from "@/lib/domain/generatedWording";
import { caseDatabaseToFormPreloads } from "@/lib/preview/engine/caseDataBindingClient";
import { readPreviewScreen } from "@/lib/preview/engine/dataRefusal";
import {
	type NavigationItemVisibility,
	navigationSelectedCase,
} from "@/lib/preview/engine/displayConditionEvaluation";
import { entryWalksChoices } from "@/lib/preview/engine/entrySessionData";
import { previewSessionValues } from "@/lib/preview/engine/identity";
import { previewParentCaseBeforeMenu } from "@/lib/preview/engine/parentCaseSelection";
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
	caseListMenuEntryOf,
	menuScreenEntryKey,
	moduleHasChildren,
	OFF_THE_MENU_SUMMARY,
	previewCaseListMenuEntry,
	previewHiddenScreenEntries,
	previewMenuCaseContext,
	previewMenuHeldSelections,
	previewMenuScreenChoice,
	previewMenuScreenLanding,
	previewModuleOwnVisibility,
	previewModuleScreenIsBareCaseList,
	previewScreenEntries,
	previewScreenWithBadges,
} from "@/lib/preview/menuProjection";
import { parentCaseSelectorLocation } from "@/lib/preview/screenProjection";
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
	usePreviewTaskContinuation,
	useSetPreviewCaseTarget,
	useSetPreviewParentCaseRequest,
	useSetPreviewTaskContinuation,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { showToast } from "@/lib/ui/toastStore";
import { PreviewMenuChoice, PreviewMenuChoices } from "./MenuLayout";
import { PreviewCaseListRow, PreviewFormRow } from "./MenuScreenRows";

/** No entry's place, while the screen shows a refusal in place of its list. */
const NO_ENTRY_VISIBILITY: ReadonlyMap<string, NavigationItemVisibility> =
	new Map();

interface ModuleScreenProps {
	/** This screen's identity, which module is being displayed. Passed from
	 *  PreviewShell so the component remains valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "module" }>;
	/** The location on show is this screen's. While a step away renders,
	 *  PreviewShell keeps the old screen visible (`useDeferredValue`) over
	 *  the session the step already changed, so the screen being left must
	 *  not route: a crumb to Home that lets this menu's case go would
	 *  otherwise send the worker to this menu's list. */
	current: boolean;
}

export function ModuleScreen({ screen, current }: ModuleScreenProps) {
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
	const language = useBuilderLanguage();
	const menuSource = usePreviewMenuSource(language.language);
	const menuCaseSelections = usePreviewMenuCaseSelections();
	const taskContinuation = usePreviewTaskContinuation();
	const setTaskContinuation = useSetPreviewTaskContinuation();
	const sessionApi = useBuilderSessionApi();
	const caseFirstModules = useCaseFirstModuleUuids();
	const { claim: claimSearchedCases } = useClaimSearchedCases();

	/** Activity keeps a visited module mounted after the URL moves elsewhere,
	 * so this component must read its own stable screen identity. */
	const moduleUuid = screen.moduleUuid;

	const mod = useModuleEntity(moduleUuid);
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
	const menuCaseContext = useMemo(
		() => previewMenuCaseContext(menuSource, moduleUuid, menuCaseSelections),
		[menuSource, moduleUuid, menuCaseSelections],
	);
	const selectedMenuCase = menuCaseContext.selectedCase;
	/* Core asks for the menu's parent case before it lists the screen only
	 * where every entry the screen lists asks for it first; a menu that lists
	 * its forms first asks for it after the command of a form that needs it
	 * (`parentCaseSelection.ts::previewParentCaseBeforeMenu`). */
	const parentCaseBeforeMenu = useMemo(
		() => previewParentCaseBeforeMenu(menuSource.doc, moduleUuid),
		[menuSource.doc, moduleUuid],
	);
	const requiredParentCase =
		menuCaseContext.requiredParentCase !== undefined &&
		previewModuleAsksParentCase({
			loc,
			moduleUuid,
			parentCaseBeforeMenu,
		})
			? menuCaseContext.requiredParentCase
			: undefined;
	/* The cases this menu's session holds pin the tile of the first whose
	 * list keeps its tile on screen (`lib/preview/pinnedCaseTile.ts`). */
	const heldCases = useMemo(
		() =>
			mode === "edit"
				? []
				: previewMenuHeldSelections(menuSource, moduleUuid, menuCaseSelections),
		[menuCaseSelections, menuSource, mode, moduleUuid],
	);
	const pinnedTile = usePinnedCaseTile(heldCases, "menu");
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
	/* Core reads the menu's own condition and every condition its entries
	 * carry as it lists the screen; one that reads data the device lacks is
	 * Core's refusal of the whole screen, which takes the list's place
	 * (`readPreviewScreen`). */
	const screenRead = useMemo(
		() =>
			readPreviewScreen(() => {
				ownModuleVisibility.get(moduleUuid);
				return previewScreenWithBadges({
					platform: device.platform,
					localizedValues,
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
				});
			}),
		[
			device.platform,
			localizedValues,
			moduleUuid,
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
	const entryVisibility =
		screenRead.kind === "read"
			? screenRead.value.visibility
			: NO_ENTRY_VISIBILITY;
	const badges =
		screenRead.kind === "read" ? screenRead.value.badges : undefined;
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
	const hiddenEntries = useMemo(
		() => hiddenItemsOf(entries),
		[hiddenItemsOf, entries],
	);

	/* The home screen already routes both redirecting shapes; this covers landing
	 * on the module URL directly (deep link, breadcrumb, flipping to preview).
	 * `moduleScreenNavigation.ts` owns which landing applies and why. */
	const isCaseFirst = useIsCaseFirstModule(moduleUuid);
	const endpointLaunch = usePreviewEntryPointLaunch();
	const preserveEntryPointMenu =
		mode !== "edit" &&
		endpointLaunch?.location.kind === "module" &&
		endpointLaunch.location.moduleUuid === moduleUuid;
	const landing = previewMenuScreenLanding(
		menuSource,
		moduleUuid,
		menuCaseSelections,
		{ mode: mode === "edit" ? "edit" : "preview", preserveEntryPointMenu },
	);
	useEffect(() => {
		if (!moduleUuid || !current) return;
		if (
			mode !== "edit" &&
			requiredParentCase &&
			taskContinuation?.moduleUuid !== moduleUuid
		) {
			const request = previewParentCaseRequestFor({
				loc,
				moduleUuid,
				selectorModuleUuid: requiredParentCase.moduleUuid,
				structuralParentUuid: moduleParent(menuSource, moduleUuid),
				pending: previewParentCaseRequest,
				listsBeforeParentCase: !parentCaseBeforeMenu,
			});
			setPreviewCaseTarget(
				previewTargetKeptForParentCase(
					menuSource,
					sessionApi.getState().previewCaseTarget,
					request,
				),
			);
			setPreviewParentCaseRequest(request);
			navigate.replace(
				parentCaseSelectorLocation(requiredParentCase.moduleUuid),
			);
			return;
		}
		/* Both land in place of the module URL, which the running app never
		 * stops on for them: Back from the list reaches the screen before it, as
		 * a device's step back from a menu that asks for its case first does
		 * (Web Apps' address names the menu once, and its list answers it),
		 * rather than this URL routing the worker forward to the list again. */
		if (
			landing.kind === "replace-with-case-list" ||
			landing.kind === "open-case-list"
		)
			navigate.replace({ kind: "cases", moduleUuid });
	}, [
		current,
		landing.kind,
		loc,
		menuSource,
		mode,
		moduleUuid,
		navigate,
		parentCaseBeforeMenu,
		previewParentCaseRequest,
		requiredParentCase,
		sessionApi,
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
		/* The case was chosen before the form, so the form's command sits
		 * above it: a route back to a list goes to the list that chose it,
		 * this menu's or a parent's whose case the form's menu goes on with,
		 * and holds no form. */
		setPreviewCaseTarget({
			formUuid,
			cases: cases.map(({ caseId, caseName }) => ({
				caseId,
				...(caseName !== undefined && { caseName }),
			})),
			formChosenAfterCase: previewMenuScreenChoice(
				menuSource,
				formModuleUuid,
				menuCaseSelections,
			),
		});
		navigate.openForm(formModuleUuid, formUuid);
	};

	/* A menu's case list as its own entry, after its menu's forms. The
	 * running screen lists it only while it still needs a case the screen
	 * has not chosen (`previewCaseListMenuEntry`): on a case-first screen
	 * that is an entry that goes on past the chosen case, never the menu's
	 * own. Edit mode lists every entry. Choosing it opens its case list. */
	const caseListEntryOf = (entryModuleUuid: Uuid) =>
		mode === "edit"
			? caseListMenuEntryOf(menuSource.doc, entryModuleUuid)
			: previewCaseListMenuEntry(menuSource.doc, entryModuleUuid, {
					isCaseFirst,
					hasSelectedCase: selectedMenuCase !== undefined,
				});
	const chooseCaseListEntry = (entryModuleUuid: Uuid) => {
		setPreviewCaseTarget(undefined);
		navigate.openCaseList(entryModuleUuid);
	};

	/* A submenu that keeps its own screen, as a tile in its place. */
	const renderTile = (
		entry: Extract<MenuScreenEntry, { kind: "menu" }>,
		index: number,
	) => {
		const child = menuSource.modules[entry.moduleUuid];
		if (child === undefined) return null;
		const key = menuScreenEntryKey(entry);
		const visibility = entryVisibility.get(key) ?? "shown";
		if (visibility === "hidden") return null;
		if (visibility === "pending") {
			return <Skeleton key={key} className="h-[58px] w-full rounded-lg" />;
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
			<PreviewMenuChoice
				key={key}
				audioLabel={child.audioLabel}
				label={childName}
			>
				<motion.button
					type="button"
					initial={{ opacity: 0, y: 12 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ delay: index * 0.06, duration: 0.3 }}
					onClick={() =>
						choosePreviewMenuTile(
							{ setPreviewCaseTarget, setPreviewParentCaseRequest, navigate },
							{
								source: menuSource,
								moduleUuid: child.uuid,
								selections: menuCaseSelections,
								cancelLocation: { kind: "module", moduleUuid },
								landing: moduleLanding({
									isCaseFirst: caseFirstModules.has(child.uuid),
									isBareCaseList: previewModuleScreenIsBareCaseList(
										menuSource.doc,
										child.uuid,
									),
									hasChildren: moduleHasChildren(menuSource, child.uuid),
									hasSelectedCase: childCase.selectedCase !== undefined,
								}),
							},
						)
					}
					className="nova-focusable w-full flex items-center gap-3 p-3 rounded-lg bg-pv-surface border border-pv-input-border hover:border-pv-input-focus transition-all duration-200 cursor-pointer text-left group"
				>
					{child.icon ? (
						<ProjectMediaImage
							assetId={child.icon}
							alt=""
							className="size-7 rounded-lg object-cover shrink-0"
						/>
					) : (
						<Icon
							icon={tablerGridDots}
							width="18"
							height="18"
							className="text-nova-text-muted group-hover:text-pv-accent-bright shrink-0"
						/>
					)}
					<div className="text-sm font-medium text-nova-text">{childName}</div>
					{badges?.get(key) && <Badge variant="muted">{badges.get(key)}</Badge>}
				</motion.button>
			</PreviewMenuChoice>
		);
	};

	if (!mod) return null;
	/* Suppress the form-menu flash while the redirect above navigates away. */
	if (landing.kind !== "form-menu" || (mode !== "edit" && requiredParentCase)) {
		return null;
	}

	if (screenRead.kind === "refused")
		return (
			<PreviewDataRefusalPanel
				surface="menu"
				moduleUuid={moduleUuid}
				reason={screenRead.refusal.reason}
			/>
		);

	const canEdit = mode === "edit" && isReady;
	const localizedModuleName =
		(localizedValues.get(moduleNameUnitId) as string | undefined) ?? mod.name;

	return (
		<>
			{pinnedTile !== undefined && <PinnedCaseTile pinned={pinnedTile} />}
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

				{/* One list in the projection's order, as a device lists the
				 *  screen: a submenu's tile stands where its module stands among
				 *  the forms of the menus that show them here. */}
				<PreviewMenuChoices
					doc={menuSource.doc}
					screen={{ kind: "menu", moduleUuid }}
				>
					{entries.map((entry, fIdx) => {
						if (entry.kind === "menu") return renderTile(entry, fIdx);
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
										(localizedValues.get(
											generatedWordingId(entry.moduleUuid, "caseListEntry"),
										) as string | undefined) ?? caseListEntry.label
									}
									onClick={() => chooseCaseListEntry(entry.moduleUuid)}
								/>
							);
						}
						const form = menuSource.forms[entry.formUuid];
						if (form === undefined) return null;
						const formModuleUuid = entry.moduleUuid;
						const localizedFormName =
							(localizedValues.get(
								generatedWordingId(form.uuid, "formTitle"),
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
							if (form.shadowOf || form.caseSelections !== undefined) {
								setPreviewCaseTarget({ formUuid: form.uuid, entryChoices: [] });
								navigate.openForm(formModuleUuid, form.uuid);
							} else if (launch.kind === "select-case-first") {
								if (formMenuCase) {
									void openFormWithMenuCase(
										formModuleUuid,
										form.uuid,
										formMenuCase.cases,
									);
								} else if (entryWalksChoices(menuSource.doc, form.uuid)) {
									/* A datum that opens its single match automatically
									 * is walked step by step, as the entry asks for it. */
									setPreviewCaseTarget({
										formUuid: form.uuid,
										entryChoices: [],
									});
									navigate.openForm(formModuleUuid, form.uuid);
								} else {
									setPreviewCaseTarget({ formUuid: form.uuid });
									navigate.openCaseList(formModuleUuid);
								}
							} else {
								/* A form opened from its menu is no Register launch,
								 * whatever an earlier visit left on the target. */
								setPreviewCaseTarget(undefined);
								navigate.openForm(formModuleUuid, form.uuid);
							}
						};

						return (
							<PreviewFormRow
								badge={badges?.get(key)}
								key={key}
								form={form}
								index={fIdx}
								label={localizedFormName}
								onClick={handleClick}
							/>
						);
					})}
				</PreviewMenuChoices>
				<HiddenItemsReveal items={hiddenEntries} />
			</ContentFrame>
		</>
	);
}
