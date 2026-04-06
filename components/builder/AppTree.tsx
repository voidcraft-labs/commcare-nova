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
	use,
	useCallback,
	useDeferredValue,
	useMemo,
	useState,
} from "react";
import { ConnectLogomark } from "@/components/icons/ConnectLogomark";
import {
	filterTree,
	highlightSegments,
	type MatchIndices,
} from "@/lib/filterTree";
import { formTypeIcons, questionTypeIcons } from "@/lib/questionTypeIcons";
import { textWithChips } from "@/lib/references/LabelContent";
import type { Question } from "@/lib/schemas/blueprint";
import {
	BuilderPhase,
	type SelectedElement,
	type TreeData,
} from "@/lib/services/builder";
import { type QuestionPath, qpath } from "@/lib/services/questionPath";

/**
 * Per-form context carrying a question ID → type icon map. Lets QuestionRow
 * render chips with correct question-type icons without prop drilling through
 * the recursive tree or depending on the ReferenceProvider.
 */
const FormIconContext = createContext<Map<string, IconifyIcon>>(new Map());

interface AppTreeProps {
	data: TreeData | undefined;
	selected:
		| {
				type: string;
				moduleIndex: number;
				formIndex?: number;
				questionPath?: QuestionPath;
		  }
		| undefined;
	onSelect: (selected: SelectedElement) => void;
	phase: BuilderPhase;
	actions?: React.ReactNode;
	hideHeader?: boolean;
}

export function AppTree({
	data,
	selected,
	onSelect,
	phase,
	actions,
	hideHeader,
}: AppTreeProps) {
	const locked = phase !== BuilderPhase.Ready;
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [searchQuery, setSearchQuery] = useState("");
	const deferredQuery = useDeferredValue(searchQuery);
	const filtered = useMemo(
		() =>
			data && deferredQuery.trim()
				? filterTree(data, deferredQuery.trim())
				: null,
		[data, deferredQuery],
	);

	const toggle = useCallback((key: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	if (!data) {
		return (
			<div className="h-full flex items-center justify-center text-nova-text-muted text-sm">
				Waiting for generation...
			</div>
		);
	}

	const displayModules = filtered ? filtered.data.modules : data.modules;

	return (
		<div className="h-full flex flex-col">
			{!hideHeader && (
				<div className="flex items-center justify-between px-6 h-12 border-b border-nova-border shrink-0">
					<div className="flex items-center min-w-0">
						<span className="text-sm font-medium text-nova-text truncate">
							{data.app_name}
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
				{filtered && displayModules.length === 0 ? (
					<div className="flex items-center justify-center py-8 text-nova-text-muted text-xs">
						No matches
					</div>
				) : (
					<div>
						<AnimatePresence mode="sync">
							{displayModules.map((mod, mIdx) => (
								<ModuleCard
									// biome-ignore lint/suspicious/noArrayIndexKey: modules have no unique ID — name is user-editable and not unique
									key={mIdx}
									module={mod}
									moduleIndex={mIdx}
									selected={selected}
									onSelect={onSelect}
									collapsed={collapsed}
									toggle={toggle}
									forceExpand={filtered?.forceExpand}
									matchMap={filtered?.matchMap}
									appConnectType={data?.connect_type}
									locked={locked}
								/>
							))}
						</AnimatePresence>
					</div>
				)}
			</div>
		</div>
	);
}

/** Reusable disclosure chevron — rotates 90deg when expanded */
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
				style={{ transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)" }}
			/>
		</button>
	);
}

/**
 * Accessible interactive wrapper for tree items. Uses a native `<div>` with
 * ARIA treeitem semantics so the layout can contain nested interactive children
 * (collapse chevrons) without violating the "no button inside button" rule.
 * Handles Enter/Space keyboard activation for keyboard-only navigation.
 */
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

function ModuleCard({
	module: mod,
	moduleIndex,
	selected,
	onSelect,
	collapsed,
	toggle,
	forceExpand,
	matchMap,
	appConnectType,
	locked,
}: {
	module: TreeData["modules"][number];
	moduleIndex: number;
	selected: AppTreeProps["selected"];
	onSelect: AppTreeProps["onSelect"];
	collapsed: Set<string>;
	toggle: (key: string) => void;
	forceExpand?: Set<string>;
	matchMap?: Map<string, MatchIndices>;
	appConnectType?: string;
	locked?: boolean;
}) {
	const isSelected =
		selected?.type === "module" && selected.moduleIndex === moduleIndex;
	const collapseKey = `m${moduleIndex}`;
	const isCollapsed = forceExpand?.has(collapseKey)
		? false
		: collapsed.has(collapseKey);
	const nameIndices = matchMap?.get(collapseKey);

	return (
		<motion.div
			initial={{ opacity: 0, y: 24 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
			className={`transition-colors border-b border-nova-border last:border-b-0 ${isSelected ? "bg-nova-violet/[0.04]" : ""}`}
		>
			{/* Module header */}
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
						{mod.case_type && (
							<span className="text-xs text-nova-text-muted font-mono">
								{mod.case_type}
							</span>
						)}
					</div>
				</div>
			</TreeItemRow>

			{!isCollapsed && (
				<>
					{/* Case list columns */}
					{mod.case_list_columns && mod.case_list_columns.length > 0 && (
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
								{mod.case_list_columns.map((col, colIdx) => (
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

					{/* Forms */}
					<div className="border-t border-nova-border">
						<AnimatePresence mode="sync">
							{mod.forms.map((form, fIdx) => (
								<FormCard
									// biome-ignore lint/suspicious/noArrayIndexKey: TreeData forms have no unique ID field
									key={fIdx}
									form={form}
									moduleIndex={moduleIndex}
									formIndex={fIdx}
									selected={selected}
									onSelect={onSelect}
									delay={fIdx * 0.08}
									collapsed={collapsed}
									toggle={toggle}
									forceExpand={forceExpand}
									matchMap={matchMap}
									appConnectType={appConnectType}
									locked={locked}
								/>
							))}
						</AnimatePresence>
					</div>
				</>
			)}
		</motion.div>
	);
}

function FormCard({
	form,
	moduleIndex,
	formIndex,
	selected,
	onSelect,
	delay,
	collapsed,
	toggle,
	forceExpand,
	matchMap,
	appConnectType,
	locked,
}: {
	form: TreeData["modules"][number]["forms"][number];
	moduleIndex: number;
	formIndex: number;
	selected: AppTreeProps["selected"];
	onSelect: AppTreeProps["onSelect"];
	delay: number;
	collapsed: Set<string>;
	toggle: (key: string) => void;
	forceExpand?: Set<string>;
	matchMap?: Map<string, MatchIndices>;
	appConnectType?: string;
	locked?: boolean;
}) {
	const isSelected =
		selected?.type === "form" &&
		selected.moduleIndex === moduleIndex &&
		selected.formIndex === formIndex;
	const formIcon = formTypeIcons[form.type] ?? formTypeIcons.survey;
	const collapseKey = `f${moduleIndex}_${formIndex}`;
	const isCollapsed = forceExpand?.has(collapseKey)
		? false
		: collapsed.has(collapseKey);
	const hasQuestions = form.questions && form.questions.length > 0;
	const oddPaths = hasQuestions
		? buildOddPaths(form.questions ?? [], collapsed)
		: undefined;
	const questionIcons = useMemo(
		() =>
			form.questions?.length
				? buildQuestionIconMap(form.questions)
				: new Map<string, IconifyIcon>(),
		[form.questions],
	);
	const nameIndices = matchMap?.get(collapseKey);

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
						{form.connect && appConnectType && (
							<ConnectLogomark
								size={11}
								className="text-nova-violet-bright shrink-0"
							/>
						)}
					</div>
				</div>
				{hasQuestions && (
					<span className="text-xs text-nova-text-muted shrink-0">
						{countQuestions(form.questions ?? [])} q
					</span>
				)}
			</TreeItemRow>

			{/* Questions */}
			{hasQuestions && !isCollapsed && (
				<FormIconContext value={questionIcons}>
					<div className="pb-2">
						<AnimatePresence mode="sync">
							{form.questions?.map((q, qIdx) => (
								<QuestionRow
									// biome-ignore lint/suspicious/noArrayIndexKey: positional key is intentional — questions have no stable UUID, and using q.id causes remount + animation flash on rename
									key={qIdx}
									question={q}
									questionPath={qpath(q.id)}
									moduleIndex={moduleIndex}
									formIndex={formIndex}
									onSelect={onSelect}
									selected={selected}
									depth={0}
									delay={delay + qIdx * 0.02}
									collapsed={collapsed}
									toggle={toggle}
									oddPaths={oddPaths ?? new Set()}
									forceExpand={forceExpand}
									matchMap={matchMap}
									locked={locked}
								/>
							))}
						</AnimatePresence>
					</div>
				</FormIconContext>
			)}
		</motion.div>
	);
}

function QuestionRow({
	question: q,
	questionPath,
	moduleIndex,
	formIndex,
	onSelect,
	selected,
	depth,
	delay,
	collapsed,
	toggle,
	oddPaths,
	forceExpand,
	matchMap,
	locked,
}: {
	question: Question;
	questionPath: QuestionPath;
	moduleIndex: number;
	formIndex: number;
	onSelect: AppTreeProps["onSelect"];
	selected: AppTreeProps["selected"];
	/** Nesting depth — used to extend row backgrounds to the full container width */
	depth: number;
	delay: number;
	collapsed: Set<string>;
	toggle: (key: string) => void;
	oddPaths: Set<string>;
	forceExpand?: Set<string>;
	matchMap?: Map<string, MatchIndices>;
	locked?: boolean;
}) {
	const iconOverrides = use(FormIconContext);
	const isSelected =
		selected?.type === "question" &&
		selected.moduleIndex === moduleIndex &&
		selected.formIndex === formIndex &&
		selected.questionPath === questionPath;
	const iconData = questionTypeIcons[q.type];
	const hasChildren = q.children && q.children.length > 0;
	const isCollapsed =
		hasChildren &&
		(forceExpand?.has(questionPath) ? false : collapsed.has(questionPath));
	const isOdd = oddPaths.has(questionPath);
	const labelIndices = matchMap?.get(questionPath);
	const idIndices = matchMap?.get(`${questionPath}__id`);
	// Show the ID badge when the match came from the ID (and question has a separate label)
	const showIdMatch = !!(idIndices && q.label);
	// Highlight the main display text: label match, or id match when there's no label
	const textIndices = labelIndices ?? (!q.label ? idIndices : undefined);
	const displayText = q.label || q.id;
	/* Search uses HighlightedText — skip chip rendering when active. */
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
							: `cursor-pointer ${isOdd ? "bg-nova-violet/[0.02]" : ""} hover:bg-nova-violet/[0.06] text-nova-text-secondary`
				}`}
				style={{ paddingLeft: `${28 + depth * 8}px` }}
				onClick={(e) => {
					e.stopPropagation();
					onSelect({
						type: "question",
						moduleIndex,
						formIndex,
						questionPath,
						questionUuid: q.uuid,
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
							(<HighlightedText text={q.id} indices={idIndices} />)
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
						{countQuestions(q.children ?? [])}
					</span>
				)}
			</TreeItemRow>

			{/* Nested children for groups/repeats */}
			{hasChildren && !isCollapsed && (
				<div>
					{q.children?.map((child, cIdx) => (
						<QuestionRow
							// biome-ignore lint/suspicious/noArrayIndexKey: positional key — same rationale as parent QuestionRow
							key={cIdx}
							question={child}
							questionPath={qpath(child.id, questionPath)}
							moduleIndex={moduleIndex}
							formIndex={formIndex}
							onSelect={onSelect}
							selected={selected}
							depth={depth + 1}
							delay={delay + (cIdx + 1) * 0.02}
							collapsed={collapsed}
							toggle={toggle}
							oddPaths={oddPaths}
							forceExpand={forceExpand}
							matchMap={matchMap}
							locked={locked}
						/>
					))}
				</div>
			)}
		</motion.div>
	);
}

/**
 * Inline highlighted text with match indices. Each segment is keyed by its
 * character offset within the source string — a stable identity that doesn't
 * depend on array position and survives changes to surrounding segments.
 */
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

function countQuestions(questions: Question[]): number {
	let count = 0;
	for (const q of questions) {
		count++;
		if (q.children) count += countQuestions(q.children);
	}
	return count;
}

/**
 * Build a flat map from question ID to its type icon for all questions in a form.
 * Used by sidebar chip rendering to show the correct question type icon without
 * going through the ReferenceProvider (which only knows the selected form).
 */
function buildQuestionIconMap(questions: Question[]): Map<string, IconifyIcon> {
	const map = new Map<string, IconifyIcon>();
	function walk(qs: Question[], parent?: QuestionPath) {
		for (const q of qs) {
			const p = qpath(q.id, parent);
			const icon = questionTypeIcons[q.type];
			if (icon) map.set(p, icon);
			if (q.children) walk(q.children, p);
		}
	}
	walk(questions);
	return map;
}

/** Pre-flatten visible question paths and return the set of odd-indexed ones. */
function buildOddPaths(
	questions: Question[],
	collapsed: Set<string>,
	parentPath?: QuestionPath,
): Set<string> {
	const flat: string[] = [];
	function walk(qs: Question[], parent?: QuestionPath) {
		for (const q of qs) {
			const p = qpath(q.id, parent);
			flat.push(p);
			if (q.children && q.children.length > 0 && !collapsed.has(p)) {
				walk(q.children, p);
			}
		}
	}
	walk(questions, parentPath);
	const odd = new Set<string>();
	for (let i = 1; i < flat.length; i += 2) odd.add(flat[i]);
	return odd;
}
