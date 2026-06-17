"use client";
import { Icon } from "@iconify/react/offline";
import { motion } from "motion/react";
import { useCallback, useEffect } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { ModuleSettingsButton } from "@/components/builder/detail/moduleSettings/ModuleSettingsButton";
import { EditableTitle } from "@/components/builder/EditableTitle";
import { mediaSrc } from "@/components/builder/media/mediaClient";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import {
	useIsBareCaseListModule,
	useIsCaseFirstModule,
	useOrderedForms,
} from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import type { PreviewScreen } from "@/lib/preview/engine/types";
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

	/** Module uuid from the URL — used for uuid-first mutations and navigation. */
	const moduleUuid = loc.kind === "module" ? loc.moduleUuid : undefined;

	const mod = useModuleEntity(moduleUuid);
	const forms = useOrderedForms((moduleUuid ?? "") as Uuid);

	/* Two reasons this form menu isn't the right landing:
	 *  - A `caseListOnly` module is a bare case list — it has NO forms in any
	 *    mode, so the menu is always empty. Its home is the case list, in both
	 *    edit and preview. Replace history so {kind:"module"} never becomes a
	 *    back-button stop for a formless module.
	 *  - A case-first module (every form case-loading) lands on the case list
	 *    in the running app (the shared case selection hoists). Edit mode keeps
	 *    the form menu — it's the authoring surface — so this is preview-only,
	 *    and pushes (the module is a real, reachable screen in edit).
	 * The home screen already routes both; this redirect covers landing on the
	 * module URL directly (deep link, breadcrumb, flipping to preview). */
	const isCaseFirst = useIsCaseFirstModule(moduleUuid);
	const isBareCaseList = useIsBareCaseListModule(moduleUuid);
	const redirectToCaseList =
		!!moduleUuid && (isBareCaseList || (mode !== "edit" && isCaseFirst));
	useEffect(() => {
		if (!redirectToCaseList || !moduleUuid) return;
		if (isBareCaseList) navigate.replace({ kind: "cases", moduleUuid });
		else navigate.openCaseList(moduleUuid);
	}, [redirectToCaseList, isBareCaseList, moduleUuid, navigate]);

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
	if (redirectToCaseList) return null;

	const hasCase = !!mod.caseType;
	const canEdit = mode === "edit" && isReady;

	return (
		<ContentFrame width="5xl" className="p-6 space-y-4">
			<div className="flex items-center gap-2">
				{canEdit ? (
					<EditableTitle value={mod.name} onSave={saveModuleName} />
				) : (
					<EditableTitle value={mod.name} readOnly />
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
					const icon = formTypeIcons[form.type];

					const handleClick = () => {
						if (!moduleUuid) return;
						if (CASE_LOADING_FORM_TYPES.has(form.type) && hasCase) {
							/* Case-loading forms select a case first. Name this form
							 * as the case list's continue target so picking a case
							 * leads back to THIS form (not the module's first
							 * case-loading form), then open the list. */
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
								// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
								<img
									src={mediaSrc(form.icon)}
									alt=""
									className="size-7 rounded object-cover shrink-0"
								/>
							) : (
								<Icon
									icon={icon}
									width="18"
									height="18"
									className="text-nova-text-muted group-hover:text-pv-accent transition-colors shrink-0"
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
		</ContentFrame>
	);
}
