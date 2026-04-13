/**
 * AppTree — structure sidebar with per-entity subscriptions.
 *
 * Each tree component (ModuleCard, FormCard, QuestionRow) subscribes to its
 * own entity in the builder store by ID/UUID. Immer structural sharing means
 * editing question A's label only re-renders QuestionRow(A) in the sidebar —
 * not the other 166 QuestionRows, not the FormCards, not the ModuleCards.
 *
 * Selection uses boolean selectors — only the old and new selected components
 * re-render on selection change (2 total), not every tree item.
 *
 * Search filtering operates directly on entity maps — no assembled TreeData.
 */
"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerGridDots from "@iconify-icons/tabler/grid-dots";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerTable from "@iconify-icons/tabler/table";
import tablerX from "@iconify-icons/tabler/x";
import { AnimatePresence, motion } from "motion/react";
import {
	createContext,
	memo,
	use,
	useCallback,
	useDeferredValue,
	useMemo,
	useState,
} from "react";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import {
	useBuilderEngine,
	useBuilderPhase,
	useBuilderStore,
} from "@/hooks/useBuilder";
import {
	useBlueprintDoc,
	useBlueprintDocShallow,
} from "@/lib/doc/hooks/useBlueprintDoc";
import { useForm as useFormDoc } from "@/lib/doc/hooks/useEntity";
import { useModuleIds } from "@/lib/doc/hooks/useModuleIds";
import type {
	FormEntity,
	ModuleEntity,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import { highlightSegments, type MatchIndices } from "@/lib/filterTree";
import { formTypeIcons, questionTypeIcons } from "@/lib/questionTypeIcons";
import { textWithChips } from "@/lib/references/LabelContent";
import { BuilderPhase, type SelectedElement } from "@/lib/services/builder";
import type { NForm, NModule, NQuestion } from "@/lib/services/normalizedState";
import { type QuestionPath, qpath } from "@/lib/services/questionPath";

/**
 * Per-form context carrying a question ID → type icon map. Lets QuestionRow
 * render chips with correct question-type icons without prop drilling through
 * the recursive tree or depending on the ReferenceProvider.
 */
const FormIconContext = createContext<Map<string, IconifyIcon>>(new Map());

/** Handler for tree item selection — passed down through the recursive tree. */
type TreeSelectHandler = (selected: SelectedElement) => void;

interface AppTreeProps {
	actions?: React.ReactNode;
	hideHeader?: boolean;
}

export function AppTree({ actions, hideHeader }: AppTreeProps) {
	const moduleOrder = useModuleIds();
	const appName = useBlueprintDoc((s) => s.appName);
	const phase = useBuilderPhase();
	const engine = useBuilderEngine();

	const locked =
		phase !== BuilderPhase.Ready && phase !== BuilderPhase.Completed;

	const handleSelect: TreeSelectHandler = useCallback(
		(sel: SelectedElement) => engine.navigateToSelection(sel),
		[engine],
	);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [searchQuery, setSearchQuery] = useState("");
	const deferredQuery = useDeferredValue(searchQuery);

	const toggle = useCallback((key: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	/* Search: compute match indices from entity maps.
	 * Only fires when the deferred query or entities change. */
	const searchResult = useSearchFilter(deferredQuery);

	if (!moduleOrder || moduleOrder.length === 0) {
		return (
			<div className="h-full flex items-center justify-center text-nova-text-muted text-sm">
				Waiting for generation...
			</div>
		);
	}

	return (
		<div className="h-full flex flex-col">
			{!hideHeader && (
				<div className="flex items-center justify-between px-6 h-12 border-b border-nova-border shrink-0">
					<div className="flex items-center min-w-0">
						<span className="text-sm font-medium text-nova-text truncate">
							{appName}
						</span>
					</div>
					{actions && (
						<div className="flex items-center gap-2 shrink-0">{actions}</div>
					)}
				</div>
			)}

			{/* Search input */}
			<div
				className={`px-3 py-3 shrink-0 ${locked ? "pointer-events-none opacity-40" : ""}`}
			>
				<div className="relative">
					<Icon
						icon={tablerSearch}
						width="14"
						height="14"
						className="absolute left-2.5 top-1/2 -translate-y-1/2 text-nova-text-muted pointer-events-none"
					/>
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								if (searchQuery) setSearchQuery("");
								else (e.target as HTMLInputElement).blur();
							}
						}}
						placeholder="Filter questions..."
						autoComplete="off"
						data-1p-ignore
						className="w-full pl-8 pr-7 py-1.5 text-xs bg-nova-surface border border-nova-border rounded-lg text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:border-nova-violet transition-colors"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
						>
							<Icon icon={tablerX} width="12" height="12" />
						</button>
					)}
				</div>
			</div>

			{/* Scrollable module cards */}
			<div className="flex-1 overflow-auto">
				{searchResult && searchResult.visibleModuleIndices.size === 0 ? (
					<div className="flex items-center justify-center py-8 text-nova-text-muted text-xs">
						No matches
					</div>
				) : (
					<div>
						<AnimatePresence mode="sync">
							{moduleOrder.map((_moduleId, mIdx) => {
								if (
									searchResult &&
									!searchResult.visibleModuleIndices.has(mIdx)
								)
									return null;
								return (
									<ModuleCard
										key={_moduleId}
										moduleIndex={mIdx}
										onSelect={handleSelect}
										collapsed={collapsed}
										toggle={toggle}
										searchResult={searchResult}
										locked={locked}
									/>
								);
							})}
						</AnimatePresence>
					</div>
				)}
			</div>
		</div>
	);
}

// ── Search filter (entity-map-based) ─────────────────────────────────

interface SearchResult {
	matchMap: Map<string, MatchIndices>;
	forceExpand: Set<string>;
	visibleModuleIndices: Set<number>;
	visibleFormIds: Set<string>;
	visibleQuestionUuids: Set<string>;
}

/** Shape returned by the search entity selector. Extracted to a named type
 *  so the SEARCH_IDLE sentinel and the selector share the same contract. */
interface SearchEntityData {
	moduleOrder: Uuid[];
	formOrder: Record<Uuid, Uuid[]>;
	questionOrder: Record<Uuid, Uuid[]>;
	modules: Record<Uuid, ModuleEntity>;
	forms: Record<Uuid, FormEntity>;
	questions: Record<Uuid, QuestionEntity>;
}

/** Stable empty data for when search is inactive — same reference every time.
 *  Prevents `useBlueprintDocShallow` from firing on entity map changes when
 *  the user isn't searching. Without this, every entity edit triggers the
 *  search subscription (6 entity maps changed) → AppTree re-renders. */
const SEARCH_IDLE: SearchEntityData = {
	moduleOrder: [],
	formOrder: {} as Record<Uuid, Uuid[]>,
	questionOrder: {} as Record<Uuid, Uuid[]>,
	modules: {} as Record<Uuid, ModuleEntity>,
	forms: {} as Record<Uuid, FormEntity>,
	questions: {} as Record<Uuid, QuestionEntity>,
};

/**
 * Compute search filter results directly from entity maps.
 * No assembled TreeData needed — iterates normalized entities.
 *
 * When query is empty, returns SEARCH_IDLE from the selector — a stable
 * reference that shallow comparison sees as unchanged. This means entity
 * edits during normal (non-search) use cause zero work in this hook.
 */
function useSearchFilter(query: string): SearchResult | null {
	const isSearching = query.trim().length > 0;

	const { moduleOrder, formOrder, questionOrder, modules, forms, questions } =
		useBlueprintDocShallow((s) =>
			isSearching
				? {
						moduleOrder: s.moduleOrder,
						formOrder: s.formOrder,
						questionOrder: s.questionOrder,
						modules: s.modules,
						forms: s.forms,
						questions: s.questions,
					}
				: SEARCH_IDLE,
		);

	return useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return null;

		const matchMap = new Map<string, MatchIndices>();
		const forceExpand = new Set<string>();
		const visibleModuleIndices = new Set<number>();
		const visibleFormIds = new Set<string>();
		const visibleQuestionUuids = new Set<string>();

		for (let mIdx = 0; mIdx < moduleOrder.length; mIdx++) {
			const moduleId = moduleOrder[mIdx];
			const mod = modules[moduleId];
			if (!mod) continue;

			/* Check module name */
			const moduleKey = `m${mIdx}`;
			const modIndices = findMatchIndices(mod.name, q);
			if (modIndices) matchMap.set(moduleKey, modIndices);

			const formIds = formOrder[moduleId] ?? [];
			let moduleHasMatch = !!modIndices;

			for (let fIdx = 0; fIdx < formIds.length; fIdx++) {
				const formId = formIds[fIdx];
				const form = forms[formId];
				if (!form) continue;

				const formKey = `f${mIdx}_${fIdx}`;
				const formIndices = findMatchIndices(form.name, q);
				if (formIndices) matchMap.set(formKey, formIndices);

				/* Check questions recursively */
				let formHasMatch = !!formIndices;
				const checkQuestions = (parentId: Uuid, parentPath?: QuestionPath) => {
					const uuids = questionOrder[parentId] ?? [];
					for (const uuid of uuids) {
						const question = questions[uuid];
						if (!question) continue;
						const questionPath = qpath(question.id, parentPath);

						const labelIndices = findMatchIndices(question.label ?? "", q);
						const idIndices = findMatchIndices(question.id, q);

						if (labelIndices) matchMap.set(questionPath, labelIndices);
						if (idIndices) matchMap.set(`${questionPath}__id`, idIndices);

						if (labelIndices || idIndices) {
							visibleQuestionUuids.add(uuid);
							formHasMatch = true;
							/* Force-expand parent groups */
							if (parentPath) forceExpand.add(parentPath);
						}

						/* Recurse into children */
						checkQuestions(uuid, questionPath);
					}
				};
				checkQuestions(formId);

				if (formHasMatch) {
					visibleFormIds.add(formId);
					forceExpand.add(formKey);
					moduleHasMatch = true;
				}
			}

			if (moduleHasMatch) {
				visibleModuleIndices.add(mIdx);
				forceExpand.add(moduleKey);
			}
		}

		return {
			matchMap,
			forceExpand,
			visibleModuleIndices,
			visibleFormIds,
			visibleQuestionUuids,
		};
	}, [query, moduleOrder, formOrder, questionOrder, modules, forms, questions]);
}

/** Find match indices for a fuzzy substring search. */
function findMatchIndices(
	text: string,
	query: string,
): MatchIndices | undefined {
	const lower = text.toLowerCase();
	const idx = lower.indexOf(query);
	if (idx === -1) return undefined;
	return [[idx, idx + query.length]];
}

// ── Shared components ────────────────────────────────────────────────

function CollapseChevron({
	isCollapsed,
	onClick,
	hidden,
}: {
	isCollapsed: boolean;
	onClick: (e: React.MouseEvent) => void;
	hidden?: boolean;
}) {
	return (
		<button
			type="button"
			className={`w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer rounded text-nova-text-muted hover:text-nova-text transition-colors ${hidden ? "invisible" : ""}`}
			onClick={onClick}
		>
			<Icon
				icon={tablerChevronRight}
				width="10"
				height="10"
				className="transition-transform duration-150"
				style={{
					transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)",
				}}
			/>
		</button>
	);
}

function TreeItemRow({
	onClick,
	className,
	style,
	children,
	...rest
}: {
	onClick: (e: React.MouseEvent | React.KeyboardEvent) => void;
	className?: string;
	style?: React.CSSProperties;
	children: React.ReactNode;
	"data-tree-question"?: string;
}) {
	return (
		<div
			role="treeitem"
			tabIndex={0}
			className={className}
			style={style}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick(e);
				}
			}}
			{...rest}
		>
			{children}
		</div>
	);
}

function HighlightedText({
	text,
	indices,
}: {
	text: string;
	indices: MatchIndices;
}) {
	const segments = highlightSegments(text, indices);
	let offset = 0;
	return (
		<>
			{segments.map((seg) => {
				const key = offset;
				offset += seg.text.length;
				return seg.highlight ? (
					<mark key={key} className="bg-nova-violet/20 text-inherit rounded-sm">
						{seg.text}
					</mark>
				) : (
					<span key={key}>{seg.text}</span>
				);
			})}
		</>
	);
}

// ── ModuleCard ───────────────────────────────────────────────────────

const ModuleCard = memo(function ModuleCard({
	moduleIndex,
	onSelect,
	collapsed,
	toggle,
	searchResult,
	locked,
}: {
	moduleIndex: number;
	onSelect: TreeSelectHandler;
	collapsed: Set<string>;
	toggle: (key: string) => void;
	searchResult: SearchResult | null;
	locked?: boolean;
}) {
	/** Subscribe to this module's entity from the doc store. Only re-renders
	 *  when THIS module changes (Immer structural sharing on the entity ref). */
	const mod = useBlueprintDoc((s) => {
		const moduleId = s.moduleOrder[moduleIndex];
		return moduleId ? s.modules[moduleId] : undefined;
	}) as NModule | undefined;

	/** Subscribe to this module's form IDs from the doc store. */
	const formIds = useBlueprintDoc((s) => {
		const moduleId = s.moduleOrder[moduleIndex];
		return moduleId ? s.formOrder[moduleId] : undefined;
	});

	const connectType = useBlueprintDoc((s) => s.connectType);

	/** Boolean selection — only this module + the previously selected re-render. */
	const isSelected = useBuilderStore(
		(s) =>
			s.selected?.type === "module" && s.selected.moduleIndex === moduleIndex,
	);

	const collapseKey = `m${moduleIndex}`;
	const isCollapsed = searchResult?.forceExpand?.has(collapseKey)
		? false
		: collapsed.has(collapseKey);
	const nameIndices = searchResult?.matchMap?.get(collapseKey);

	if (!mod || !formIds) return null;

	return (
		<motion.div
			initial={{ opacity: 0, y: 24 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
			className={`transition-colors border-b border-nova-border last:border-b-0 ${isSelected ? "bg-nova-violet/[0.04]" : ""}`}
		>
			<TreeItemRow
				className={`pl-3 pr-3 py-2.5 flex items-center justify-between ${locked ? "pointer-events-none" : "cursor-pointer"}`}
				onClick={() => onSelect({ type: "module", moduleIndex })}
			>
				<div className="flex items-center gap-2">
					<CollapseChevron
						isCollapsed={isCollapsed}
						onClick={(e) => {
							e.stopPropagation();
							toggle(collapseKey);
						}}
						hidden={locked}
					/>
					<div className="w-8 h-8 rounded-lg bg-nova-violet/10 flex items-center justify-center">
						<Icon
							icon={tablerGridDots}
							width="16"
							height="16"
							className="text-nova-violet-bright"
						/>
					</div>
					<div>
						<h3 className="font-medium text-sm">
							{nameIndices ? (
								<HighlightedText text={mod.name} indices={nameIndices} />
							) : (
								mod.name
							)}
						</h3>
						{mod.caseType && (
							<span className="text-xs text-nova-text-muted font-mono">
								{mod.caseType}
							</span>
						)}
					</div>
				</div>
			</TreeItemRow>

			{!isCollapsed && (
				<>
					{mod.caseListColumns && mod.caseListColumns.length > 0 && (
						<div className="mx-4 mb-3 rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden">
							<div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-white/[0.04]">
								<Icon
									icon={tablerTable}
									width="12"
									height="12"
									className="text-nova-text-muted"
								/>
								<span className="text-[10px] font-medium text-nova-text-muted uppercase tracking-widest">
									Case List
								</span>
							</div>
							<div className="flex">
								{mod.caseListColumns.map((col, colIdx) => (
									<div
										key={`${col.header}-${col.field}`}
										className={`flex-1 px-3 py-2 text-xs font-medium text-nova-text-secondary ${
											colIdx > 0 ? "border-l border-white/[0.04]" : ""
										}`}
									>
										{col.header}
									</div>
								))}
							</div>
						</div>
					)}

					<div className="border-t border-nova-border">
						<AnimatePresence mode="sync">
							{formIds.map((formId, fIdx) => {
								if (searchResult && !searchResult.visibleFormIds.has(formId))
									return null;
								return (
									<FormCard
										key={formId}
										formId={formId}
										moduleIndex={moduleIndex}
										formIndex={fIdx}
										onSelect={onSelect}
										delay={fIdx * 0.08}
										collapsed={collapsed}
										toggle={toggle}
										searchResult={searchResult}
										connectType={connectType ?? undefined}
										locked={locked}
									/>
								);
							})}
						</AnimatePresence>
					</div>
				</>
			)}
		</motion.div>
	);
});

// ── FormCard ─────────────────────────────────────────────────────────

const FormCard = memo(function FormCard({
	formId,
	moduleIndex,
	formIndex,
	onSelect,
	delay,
	collapsed,
	toggle,
	searchResult,
	connectType,
	locked,
}: {
	formId: string;
	moduleIndex: number;
	formIndex: number;
	onSelect: TreeSelectHandler;
	delay: number;
	collapsed: Set<string>;
	toggle: (key: string) => void;
	searchResult: SearchResult | null;
	connectType?: string;
	locked?: boolean;
}) {
	/** Subscribe to this form's entity from the doc store. */
	const form = useFormDoc(formId as Uuid) as NForm | undefined;

	/** Subscribe to this form's question UUIDs from the doc store. */
	const questionUuids = useBlueprintDoc((s) => s.questionOrder[formId as Uuid]);

	/** Full questionOrder for recursive question counting. */
	const questionOrder = useBlueprintDoc((s) => s.questionOrder);

	/** Boolean selection. */
	const isSelected = useBuilderStore(
		(s) =>
			s.selected?.type === "form" &&
			s.selected.moduleIndex === moduleIndex &&
			s.selected.formIndex === formIndex,
	);

	const collapseKey = `f${moduleIndex}_${formIndex}`;
	const isCollapsed = searchResult?.forceExpand?.has(collapseKey)
		? false
		: collapsed.has(collapseKey);
	const hasQuestions = questionUuids && questionUuids.length > 0;
	const nameIndices = searchResult?.matchMap?.get(collapseKey);

	/** Build icon map for reference chips in question labels. */
	const questionIcons = useQuestionIconMap(formId);

	if (!form) return null;

	const formIcon = formTypeIcons[form.type] ?? formTypeIcons.survey;

	return (
		<motion.div
			initial={{ opacity: 0, x: -8 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ delay, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
			className={`border-b border-nova-border last:border-b-0 ${
				isSelected ? "bg-nova-violet/[0.04]" : ""
			}`}
		>
			<TreeItemRow
				className={`pl-5 pr-3 py-2.5 transition-colors flex items-center gap-2 ${locked ? "pointer-events-none" : "cursor-pointer hover:bg-nova-violet/[0.06]"}`}
				onClick={() => onSelect({ type: "form", moduleIndex, formIndex })}
			>
				{hasQuestions ? (
					<CollapseChevron
						isCollapsed={isCollapsed}
						onClick={(e) => {
							e.stopPropagation();
							toggle(collapseKey);
						}}
						hidden={locked}
					/>
				) : (
					<span className="w-3.5 shrink-0" />
				)}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<Icon
							icon={formIcon}
							width="14"
							height="14"
							className="text-nova-text-muted shrink-0"
						/>
						<span className="text-sm font-medium truncate">
							{nameIndices ? (
								<HighlightedText text={form.name} indices={nameIndices} />
							) : (
								form.name
							)}
						</span>
						{form.connect && connectType && (
							<ConnectLogomark
								size={11}
								className="text-nova-violet-bright shrink-0"
							/>
						)}
					</div>
				</div>
				{hasQuestions && (
					<span className="text-xs text-nova-text-muted shrink-0">
						{countQuestionsFromOrder(formId, questionOrder)} q
					</span>
				)}
			</TreeItemRow>

			{hasQuestions && !isCollapsed && (
				<FormIconContext value={questionIcons}>
					<div className="pb-2">
						<AnimatePresence mode="sync">
							{questionUuids?.map((uuid, qIdx) => {
								if (
									searchResult &&
									!searchResult.visibleQuestionUuids.has(uuid)
								)
									return null;
								return (
									<QuestionRow
										key={uuid}
										uuid={uuid}
										moduleIndex={moduleIndex}
										formIndex={formIndex}
										onSelect={onSelect}
										depth={0}
										delay={delay + qIdx * 0.02}
										collapsed={collapsed}
										toggle={toggle}
										searchResult={searchResult}
										locked={locked}
									/>
								);
							})}
						</AnimatePresence>
					</div>
				</FormIconContext>
			)}
		</motion.div>
	);
});

/** Build a question ID → type icon map for a form's questions (recursive). */
function useQuestionIconMap(formId: string): Map<string, IconifyIcon> {
	const { questions, questionOrder } = useBlueprintDocShallow((s) => ({
		questions: s.questions,
		questionOrder: s.questionOrder,
	}));

	return useMemo(() => {
		const map = new Map<string, IconifyIcon>();
		function walk(parentId: Uuid, parentPath?: QuestionPath) {
			const uuids = questionOrder[parentId] ?? [];
			for (const uuid of uuids) {
				const q = questions[uuid];
				if (!q) continue;
				const p = qpath(q.id, parentPath);
				const icon = questionTypeIcons[q.type];
				if (icon) map.set(p, icon);
				walk(uuid, p);
			}
		}
		walk(formId as Uuid);
		return map;
	}, [formId, questions, questionOrder]);
}

/** Count questions recursively from questionOrder. Pure function —
 *  takes the questionOrder map directly (read from store by the caller). */
function countQuestionsFromOrder(
	parentId: string,
	questionOrder: Record<Uuid, Uuid[]>,
): number {
	let count = 0;
	function walk(pid: Uuid) {
		const uuids = questionOrder[pid] ?? [];
		count += uuids.length;
		for (const uuid of uuids) {
			walk(uuid);
		}
	}
	walk(parentId as Uuid);
	return count;
}

// ── QuestionRow ──────────────────────────────────────────────────────

const QuestionRow = memo(function QuestionRow({
	uuid,
	moduleIndex,
	formIndex,
	onSelect,
	depth,
	delay,
	collapsed,
	toggle,
	searchResult,
	locked,
	parentPath,
}: {
	uuid: string;
	moduleIndex: number;
	formIndex: number;
	onSelect: TreeSelectHandler;
	depth: number;
	delay: number;
	collapsed: Set<string>;
	toggle: (key: string) => void;
	searchResult: SearchResult | null;
	locked?: boolean;
	parentPath?: QuestionPath;
}) {
	/** Subscribe to this question's entity by UUID from the doc store. */
	const q = useBlueprintDoc((s) => s.questions[uuid as Uuid]) as
		| NQuestion
		| undefined;

	/** Subscribe to children UUIDs (for groups/repeats) from the doc store. */
	const childUuids = useBlueprintDoc((s) => s.questionOrder[uuid as Uuid]);

	/** Boolean selection — only this question + the old selection re-render. */
	const isSelected = useBuilderStore(
		(s) => s.selected?.type === "question" && s.selected.questionUuid === uuid,
	);

	const iconOverrides = use(FormIconContext);

	if (!q) return null;

	const questionPath = qpath(q.id, parentPath);
	const iconData = questionTypeIcons[q.type];
	const hasChildren = childUuids && childUuids.length > 0;
	const isCollapsed =
		hasChildren &&
		(searchResult?.forceExpand?.has(questionPath)
			? false
			: collapsed.has(questionPath));
	const labelIndices = searchResult?.matchMap?.get(questionPath);
	const idIndices = searchResult?.matchMap?.get(`${questionPath}__id`);
	const showIdMatch = !!(idIndices && q.label);
	const textIndices = labelIndices ?? (!q.label ? idIndices : undefined);
	const displayText = q.label || q.id;
	const chipContent = !textIndices
		? textWithChips(displayText, null, iconOverrides)
		: null;

	return (
		<motion.div
			initial={{ opacity: 0, x: -5 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ delay, duration: 0.2 }}
		>
			<TreeItemRow
				data-tree-question={questionPath}
				className={`flex items-center gap-1 py-2.5 transition-colors text-xs ${
					locked
						? "pointer-events-none text-nova-text-secondary"
						: isSelected
							? "cursor-pointer bg-nova-violet/[0.08] text-nova-text shadow-[inset_2px_0_0_var(--nova-violet)]"
							: "cursor-pointer hover:bg-nova-violet/[0.06] text-nova-text-secondary"
				}`}
				style={{ paddingLeft: `${28 + depth * 8}px` }}
				onClick={(e) => {
					e.stopPropagation();
					onSelect({
						type: "question",
						moduleIndex,
						formIndex,
						questionPath,
						questionUuid: uuid,
					});
				}}
			>
				{hasChildren && (
					<CollapseChevron
						isCollapsed={!!isCollapsed}
						onClick={(e) => {
							e.stopPropagation();
							toggle(questionPath);
						}}
						hidden={locked}
					/>
				)}
				<span className="w-4 text-center text-nova-text-muted shrink-0 flex items-center justify-center">
					{iconData ? <Icon icon={iconData} width="12" height="12" /> : "?"}
				</span>
				{showIdMatch ? (
					<span className="flex items-center gap-1.5 min-w-0 flex-1">
						<span
							className={`truncate shrink ${hasChildren ? "font-medium text-[#b8b8dd]" : ""}`}
						>
							{textIndices ? (
								<HighlightedText text={displayText} indices={textIndices} />
							) : (
								chipContent
							)}
						</span>
						<span className="truncate shrink-0 max-w-[45%] font-mono text-[10px] text-nova-text-muted">
							(
							<HighlightedText text={q.id} indices={idIndices} />)
						</span>
					</span>
				) : (
					<span
						className={`truncate ${hasChildren ? "font-medium text-[#b8b8dd]" : ""}`}
					>
						{textIndices ? (
							<HighlightedText text={displayText} indices={textIndices} />
						) : (
							chipContent
						)}
					</span>
				)}
				{hasChildren && isCollapsed && (
					<span className="text-[10px] text-nova-text-muted ml-auto shrink-0">
						{childUuids?.length ?? 0}
					</span>
				)}
			</TreeItemRow>

			{/* Nested children for groups/repeats */}
			{hasChildren && !isCollapsed && (
				<div>
					{childUuids?.map((childUuid, cIdx) => (
						<QuestionRow
							key={childUuid}
							uuid={childUuid}
							moduleIndex={moduleIndex}
							formIndex={formIndex}
							onSelect={onSelect}
							depth={depth + 1}
							delay={delay + (cIdx + 1) * 0.02}
							collapsed={collapsed}
							toggle={toggle}
							searchResult={searchResult}
							locked={locked}
							parentPath={questionPath}
						/>
					))}
				</div>
			)}
		</motion.div>
	);
});
