"use client";
import { Icon } from "@iconify/react/offline";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import { motion } from "motion/react";
import { useCallback } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { EditableTitle } from "@/components/builder/EditableTitle";
import { mediaSrc } from "@/components/builder/media/mediaClient";
import { Badge } from "@/components/ui/Badge";
import { useAppLogo } from "@/lib/doc/hooks/useAppLogo";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useAppStructure } from "@/lib/doc/hooks/useAppStructure";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import {
	useCaseFirstModuleUuids,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { useNavigate } from "@/lib/routing/hooks";
import { useBuilderIsReady, useEditMode } from "@/lib/session/hooks";

export function HomeScreen() {
	const appName = useAppName();
	/* Read only the `formOrder` slice of the app structure — the module
	 * sequence is served separately by `useOrderedModules()` below.
	 * `useAppStructure` returns a shallow-stable pair, so destructuring
	 * one field keeps the reference cheap. */
	const { formOrder } = useAppStructure();
	const navigate = useNavigate();
	const { inline } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();
	const hasData = useDocHasData();
	const modules = useOrderedModules();
	/* Case-first modules (every form case-loading) land on the case list,
	 * not a form menu — the running app hoists the shared case selection. */
	const caseFirstModules = useCaseFirstModuleUuids();
	const logo = useAppLogo();

	/* Forward the gated dispatch's outcome — a refused rename keeps the
	 * editor open with the draft and surfaces the finding inline; the
	 * saved checkmark only fires on a committed rename. */
	const saveAppName = useCallback(
		(name: string) => inline.updateApp({ app_name: name }),
		[inline],
	);

	if (!hasData) return null;

	const canEdit = mode === "edit" && isReady;

	return (
		<ContentFrame width="5xl" className="p-6 space-y-4">
			{/* The web-apps logo banner — CommCare shows the app logo at the top
			    of the home screen. */}
			{logo && (
				// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
				<img
					src={mediaSrc(logo)}
					alt=""
					className="max-h-16 max-w-full rounded-md object-contain"
				/>
			)}
			<div className="flex items-center gap-2">
				{canEdit ? (
					<EditableTitle value={appName} onSave={saveAppName} />
				) : (
					<EditableTitle value={appName} readOnly />
				)}
			</div>
			<div className="grid gap-3">
				{modules.map((mod, mIdx) => {
					const formCount = formOrder[mod.uuid]?.length ?? 0;
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
							onClick={() =>
								/* Case-first modules land on the case list (the running
								 * app hoists the shared case selection); a caseListOnly
								 * module has no form menu at all, so it too opens straight
								 * to its case list. */
								caseFirstModules.has(mod.uuid) || mod.caseListOnly
									? navigate.openCaseList(mod.uuid)
									: navigate.openModule(mod.uuid)
							}
							className="w-full flex items-center gap-4 p-4 rounded-xl bg-pv-surface border border-pv-input-border hover:border-pv-input-focus hover:translate-y-[-1px] transition-all duration-200 cursor-pointer text-left group"
						>
							{mod.icon ? (
								// Module menu-tile icon — CommCare shows it on the
								// module's home-screen tile.
								// biome-ignore lint/performance/noImgElement: session-authed proxy; next/image can't carry the cookie auth
								<img
									src={mediaSrc(mod.icon)}
									alt=""
									className="w-10 h-10 rounded-lg object-cover shrink-0"
								/>
							) : (
								<div className="w-10 h-10 rounded-lg bg-pv-accent/10 flex items-center justify-center shrink-0">
									<Icon
										icon={tablerGridDots}
										width="20"
										height="20"
										className="text-pv-accent"
									/>
								</div>
							)}
							<div className="flex-1 min-w-0">
								<div className="font-medium text-nova-text group-hover:text-pv-accent-bright transition-colors">
									{mod.name}
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
		</ContentFrame>
	);
}
