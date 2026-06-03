"use client";
import { Icon } from "@iconify/react/offline";
import tablerListDetails from "@iconify-icons/tabler/list-details";
import tablerListSearch from "@iconify-icons/tabler/list-search";
import { motion } from "motion/react";
import { useCallback, useState } from "react";
import { ModuleSettingsButton } from "@/components/builder/detail/moduleSettings/ModuleSettingsButton";
import { EditableTitle, SavedCheck } from "@/components/builder/EditableTitle";
import { mediaSrc } from "@/components/builder/media/mediaClient";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseListSummary } from "@/lib/doc/hooks/useCaseListSummary";
import { useModule as useModuleEntity } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { useBuilderIsReady, useEditMode } from "@/lib/session/hooks";

interface ModuleScreenProps {
	/** This screen's identity — which module is being displayed. Passed from
	 *  PreviewShell so the component remains valid while Activity hides it. */
	screen: Extract<PreviewScreen, { type: "module" }>;
}

export function ModuleScreen({ screen: _screen }: ModuleScreenProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	const { updateModule } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();

	/** Module uuid from the URL — used for uuid-first mutations and navigation. */
	const moduleUuid = loc.kind === "module" ? loc.moduleUuid : undefined;

	const mod = useModuleEntity(moduleUuid);
	const forms = useOrderedForms((moduleUuid ?? "") as Uuid);

	const [saved, setSaved] = useState(false);
	const saveModuleName = useCallback(
		(name: string) => {
			if (moduleUuid) updateModule(moduleUuid, { name });
		},
		[updateModule, moduleUuid],
	);
	const handleSaved = useCallback(() => {
		setSaved(true);
		setTimeout(() => setSaved(false), 1500);
	}, []);

	if (!mod) return null;

	const hasCase = !!mod.caseType;
	const canEdit = mode === "edit" && isReady;

	return (
		<div className="p-6 space-y-4 max-w-3xl mx-auto">
			<div className="flex items-center gap-2">
				{canEdit ? (
					<EditableTitle
						value={mod.name}
						onSave={saveModuleName}
						onSaved={handleSaved}
					/>
				) : (
					<EditableTitle value={mod.name} readOnly />
				)}
				<SavedCheck visible={saved} />
				{/* Module-settings gear — the module-level analog of
				 *  `FormScreen`'s `FormSettingsButton` on the form header.
				 *  Edit-mode only (matches the form-header gate) and only once
				 *  the module uuid has resolved from the URL. Its `ml-auto`
				 *  trigger pushes it to the right edge of this header row. */}
				{canEdit && moduleUuid && (
					<ModuleSettingsButton moduleUuid={moduleUuid} />
				)}
			</div>

			{/*
			 * Case List affordance card.
			 *
			 * Surfaces only for case-typed modules — registers the
			 * authoring entry-point for the module's case list (which
			 * lives at /build/[id]/{moduleUuid}/cases). Visually
			 * violet-gradient + violet-pill icon so the card reads as
			 * a different KIND of affordance from the gray-toned form
			 * rows beneath it: this configures the case list, not a
			 * form to open.
			 *
			 * The status density (column / filter / search-input
			 * counts) mirrors the workspace's section-header lines —
			 * users see the same vocabulary on both sides of the
			 * navigation jump.
			 */}
			{hasCase && moduleUuid ? (
				<CaseListCard
					moduleUuid={moduleUuid}
					caseType={mod.caseType ?? ""}
					onClick={() => navigate.openCaseList(moduleUuid)}
				/>
			) : null}

			{/*
			 * Search Config affordance card.
			 *
			 * Sibling affordance to Case List, opening the per-module
			 * case-search authoring workspace at
			 * /build/[id]/{moduleUuid}/search-config. The card always
			 * renders so the affordance path stays discoverable; when
			 * the module has no case type, the card greys out with a
			 * hover hint pointing at the unblocking action — case-
			 * search authoring needs a declared case type to scope
			 * property references.
			 */}
			{moduleUuid ? (
				<SearchConfigCard
					hasCase={hasCase}
					onClick={() => navigate.openSearchConfig(moduleUuid)}
				/>
			) : null}

			<div className="space-y-2">
				{forms.map((form, fIdx) => {
					const icon = formTypeIcons[form.type];

					const handleClick = () => {
						if (!moduleUuid) return;
						if (CASE_LOADING_FORM_TYPES.has(form.type) && hasCase) {
							/* Case-loading forms show the case list first — selecting a row opens the form */
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
		</div>
	);
}

// ── Case List affordance ─────────────────────────────────────────

interface CaseListCardProps {
	readonly moduleUuid: Uuid;
	readonly caseType: string;
	readonly onClick: () => void;
}

/**
 * Violet-gradient affordance card that mounts above the form list
 * for case-typed modules. The card opens the case-list authoring
 * workspace at /build/[id]/{moduleUuid}/cases. Status density
 * mirrors the workspace's section-header lines — the user sees
 * the same column / filter / search-input counts on both surfaces.
 *
 * Lives inside ModuleScreen.tsx because its data dependencies
 * (single module summary read against the doc store) are tightly
 * scoped to this screen and there's no other consumer. The
 * named-hook contract (`useCaseListSummary`) keeps the doc-store
 * boundary rule clean — components consume a domain hook, not the
 * raw shallow selector.
 */
function CaseListCard({ moduleUuid, caseType, onClick }: CaseListCardProps) {
	const { columnCount, hasFilter, searchInputCount } =
		useCaseListSummary(moduleUuid);

	return (
		<motion.button
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
			onClick={onClick}
			className="w-full flex items-center gap-3 p-4 rounded-lg bg-gradient-to-r from-nova-violet/[0.08] to-transparent border border-nova-violet/[0.2] hover:border-nova-violet/[0.4] hover:from-nova-violet/[0.12] transition-all duration-200 cursor-pointer text-left group"
		>
			{/* Violet pill icon — visually distinguishes the affordance
			 *  from gray-toned form rows. */}
			<div className="p-2 rounded-md bg-nova-violet/[0.15] border border-nova-violet/[0.3] shrink-0">
				<Icon
					icon={tablerListDetails}
					width="20"
					height="20"
					className="text-nova-violet-bright"
				/>
			</div>
			<div className="flex-1 min-w-0">
				<div className="text-base font-display font-medium text-nova-text">
					Case List
				</div>
				<div className="text-xs text-nova-text-muted mt-0.5">
					{`${columnCount} ${columnCount === 1 ? "column" : "columns"} · ${
						hasFilter ? "1 filter" : "no filter"
					} · ${searchInputCount} search ${searchInputCount === 1 ? "input" : "inputs"}`}
				</div>
			</div>
			{/* Case-type badge — monospace pill so the user immediately
			 *  knows which case-type's case list this affordance opens. */}
			<span className="px-2 py-0.5 rounded text-[11px] font-mono bg-nova-violet/[0.12] text-nova-violet-bright border border-nova-violet/[0.25]">
				{caseType}
			</span>
		</motion.button>
	);
}

// ── Search Config affordance ─────────────────────────────────────

interface SearchConfigCardProps {
	/** Whether the module has a case type. Drives the active /
	 *  greyed visual variant + the click handler's enabled state.
	 *  When `false`, the card renders disabled with a hover hint
	 *  surfacing the unblocking action. */
	readonly hasCase: boolean;
	readonly onClick: () => void;
}

/**
 * Sibling affordance to `CaseListCard`. Opens the case-search
 * authoring workspace at /build/[id]/{moduleUuid}/search-config.
 *
 * Always renders — the affordance path stays discoverable even on
 * a case-less module. When the module has no case type, the card
 * greys out, drops its hover state, and surfaces a native `title`
 * hint pointing at the unblocking action ("Set a case type on this
 * module to enable search authoring."). Click is suppressed in the
 * disabled state via the button's `disabled` attribute so screen
 * readers report the disabled state alongside the visual cue.
 */
function SearchConfigCard({ hasCase, onClick }: SearchConfigCardProps) {
	const baseClass =
		"w-full flex items-center gap-3 p-4 rounded-lg border transition-all duration-200 text-left";
	const enabledClass =
		"bg-gradient-to-r from-nova-violet/[0.08] to-transparent border-nova-violet/[0.2] hover:border-nova-violet/[0.4] hover:from-nova-violet/[0.12] cursor-pointer group";
	const disabledClass =
		"bg-nova-surface/30 border-white/[0.06] opacity-60 cursor-not-allowed";

	return (
		<motion.button
			type="button"
			initial={{ opacity: 0, y: 12 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
			onClick={hasCase ? onClick : undefined}
			disabled={!hasCase}
			title={
				hasCase
					? undefined
					: "Set a case type on this module to enable search authoring."
			}
			className={`${baseClass} ${hasCase ? enabledClass : disabledClass}`}
		>
			{/* Violet pill icon mirrors the Case List card's chrome —
			 *  the two affordances read as siblings of the same family. */}
			<div
				className={`p-2 rounded-md shrink-0 ${
					hasCase
						? "bg-nova-violet/[0.15] border border-nova-violet/[0.3]"
						: "bg-white/[0.04] border border-white/[0.06]"
				}`}
			>
				<Icon
					icon={tablerListSearch}
					width="20"
					height="20"
					className={
						hasCase ? "text-nova-violet-bright" : "text-nova-text-muted"
					}
				/>
			</div>
			<div className="flex-1 min-w-0">
				<div className="text-base font-display font-medium text-nova-text">
					Search Config
				</div>
				<div className="text-xs text-nova-text-muted mt-0.5">
					{hasCase
						? "Author display labels and advanced search filters."
						: "Requires a case type."}
				</div>
			</div>
		</motion.button>
	);
}
