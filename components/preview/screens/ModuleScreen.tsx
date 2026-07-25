"use client";
import { Icon } from "@iconify/react/offline";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { summarizeFilter } from "@/components/builder/case-list-config/predicateSummary";
import { ModuleSettingsButton } from "@/components/builder/detail/moduleSettings/ModuleSettingsButton";
import { EditableTitle } from "@/components/builder/EditableTitle";
import { ProjectMediaImage } from "@/components/builder/media/ProjectMediaResource";
import {
	formLaunch,
	moduleScreenLanding,
} from "@/components/preview/screens/moduleScreenNavigation";
import { HiddenItemsReveal } from "@/components/preview/shared/HiddenItemsReveal";
import { Skeleton } from "@/components/shadcn/skeleton";
import { useAuth } from "@/lib/auth/hooks/useAuth";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import {
	useIsBareCaseListModule,
	useIsCaseFirstModule,
	useOrderedForms,
} from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import { formDisplayVisibility } from "@/lib/preview/engine/displayConditionEvaluation";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { usePreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import {
	useBuilderIsReady,
	useEditMode,
	useSetPreviewCaseTarget,
} from "@/lib/session/hooks";

interface ModuleScreenProps {
	/** This screen's identity — which module is being displayed. Passed from
	 *  PreviewShell so the component remains valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "module" }>;
}

export function ModuleScreen({ screen: _screen }: ModuleScreenProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	const { inline } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();
	const setPreviewCaseTarget = useSetPreviewCaseTarget();

	/** Module uuid from the URL — used for uuid-first mutations and
	 *  navigation. Deliberately NOT widened to `module-condition`: a
	 *  module's condition previews as the HOME screen (the screen the
	 *  condition decides), so this screen is never the one shown there,
	 *  and claiming the module would only arm this screen's own
	 *  bare-case-list redirect from a hidden render. */
	const moduleUuid = loc.kind === "module" ? loc.moduleUuid : undefined;

	const mod = useModuleEntity(moduleUuid);
	const forms = useOrderedForms((moduleUuid ?? "") as Uuid);
	const lookup = usePreviewLookupStatus();
	const { user } = useAuth();
	// Better Auth resolves a cached session synchronously on the browser's
	// first paint while SSR has none — keep the first render identity-free
	// (the shared hydration rule) and apply session gating after mount.
	const [authMounted, setAuthMounted] = useState(false);
	useEffect(() => setAuthMounted(true), []);
	const session = useMemo(
		() => previewSessionValues(previewAsMe(authMounted ? user : null)),
		[authMounted, user],
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
								lookup,
							}),
				]),
			),
		[forms, mode, session, lookup],
	);
	const hiddenForms = useMemo(
		() =>
			forms
				.filter((form) => formVisibility.get(form.uuid) === "hidden")
				.map((form) => ({
					key: form.uuid,
					name: form.name,
					summary: summarizeFilter(form.displayCondition, {}),
				})),
		[forms, formVisibility],
	);

	/* The home screen already routes both redirecting shapes; this covers landing
	 * on the module URL directly (deep link, breadcrumb, flipping to preview).
	 * `moduleScreenNavigation.ts` owns which landing applies and why. */
	const isCaseFirst = useIsCaseFirstModule(moduleUuid);
	const isBareCaseList = useIsBareCaseListModule(moduleUuid);
	const landing = moduleScreenLanding({
		hasModule: !!moduleUuid,
		isBareCaseList,
		isCaseFirst,
		mode: mode === "edit" ? "edit" : "preview",
	});
	useEffect(() => {
		if (!moduleUuid) return;
		if (landing.kind === "replace-with-case-list") {
			navigate.replace({ kind: "cases", moduleUuid });
		} else if (landing.kind === "open-case-list") {
			navigate.openCaseList(moduleUuid);
		}
	}, [landing.kind, moduleUuid, navigate]);

	/* Forward the gated dispatch's outcome — a rename the commit gate
	 * refuses (e.g. duplicating another module's name) keeps the editor
	 * open with the draft and surfaces the finding inline; the saved
	 * checkmark only fires on a committed rename. */
	const saveModuleName = useCallback(
		(name: string) =>
			moduleUuid ? inline.updateModule(moduleUuid, { name }) : undefined,
		[inline, moduleUuid],
	);

	if (!mod) return null;
	/* Suppress the form-menu flash while the redirect above navigates away. */
	if (landing.kind !== "form-menu") return null;

	const hasCase = !!mod.caseType;
	const canEdit = mode === "edit" && isReady;

	return (
		<ContentFrame width="5xl" className="p-6 space-y-4">
			<div className="flex items-center gap-2">
				{canEdit ? (
					<EditableTitle
						value={mod.name}
						onSave={saveModuleName}
						ariaLabel="Module name"
					/>
				) : (
					<EditableTitle value={mod.name} readOnly ariaLabel="Module name" />
				)}
				{/* Module-settings gear — the module-level analog of
				 *  `FormScreen`'s `FormSettingsButton` on the form header.
				 *  Edit-mode only (matches the form-header gate) and only once
				 *  the module uuid has resolved from the URL. Its `ml-auto`
				 *  trigger pushes it to the right edge of this header row. */}
				{canEdit && moduleUuid && (
					<ModuleSettingsButton moduleUuid={moduleUuid} />
				)}
			</div>

			<div className="space-y-2">
				{forms.map((form, fIdx) => {
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
							setPreviewCaseTarget({ formUuid: form.uuid });
							navigate.openCaseList(moduleUuid);
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
								// Form menu-tile icon — CommCare shows it on the form's
								// command in the module menu.
								<ProjectMediaImage
									assetId={form.icon}
									alt=""
									className="size-7 rounded object-cover shrink-0"
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
									{form.name}
								</div>
							</div>
						</motion.button>
					);
				})}
			</div>
			<HiddenItemsReveal items={hiddenForms} />
		</ContentFrame>
	);
}
