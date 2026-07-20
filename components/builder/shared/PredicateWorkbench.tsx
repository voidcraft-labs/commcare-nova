// Focus-and-context authoring for the complete recursive Predicate AST.
// Only the focused structure and its immediate children render at once;
// deeper structures are semantic rows that open full-width. This keeps deeply
// nested rules legible without flattening or discarding their authored shape.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import {
	useCallback,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { caseSearchPredicateEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import type { CaseType } from "@/lib/domain";
import {
	checkPredicate,
	exists,
	missing,
	type Predicate,
	type RelationPath,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	ChildPredicateEditor,
	PredicateKindReplaceMenu,
} from "./cards/ChildPredicateEditor";
import { firstComparisonDefault } from "./cards/comparisonSeed";
import { SearchInputMenu } from "./cards/WhenInputPresentCard";
import {
	buildValidityIndex,
	PredicateEditProvider,
	useEditorErrorsAt,
	usePredicateEditContext,
	WithCurrentCaseType,
} from "./editorContext";
import {
	type CaseDataScope,
	type PredicateEditContext,
	predicateCardSchemas,
	predicateUnavailableReason,
} from "./editorSchemas";
import {
	appendKindIndex,
	appendKindSlot,
	type EditorPath,
	serializePath,
} from "./path";
import {
	isStructuralPredicate,
	type StructuralPredicate,
} from "./predicateNavigation";
import { ExpressionPicker } from "./primitives/ExpressionPicker";
import { RelationPathBuilder } from "./primitives/RelationPathBuilder";
import { pathsEqual, RuleFocusProvider } from "./RuleFocusContext";
import { resolveRelationDestination } from "./relationDestination";
import {
	nearestRuleLocation,
	type RuleLocation,
	type RuleNavigationContext,
	replaceRuleNodeAtPath,
} from "./ruleNavigation";
import {
	type EditorSearchInputDecl,
	searchInputDisplayLabel,
} from "./searchInputPresentation";
import {
	type StableListOperation,
	useStableListIdentity,
} from "./useStableListIdentity";

const STRUCTURE_KINDS = [
	"and",
	"or",
	"not",
	"when-input-present",
	"exists",
	"missing",
] as const;

type StructureKind = (typeof STRUCTURE_KINDS)[number];

type WorkbenchFocusFallback = "condition" | "related-condition";

type NavigationFocusRequest =
	| {
			readonly kind: "enter";
			readonly destination: EditorPath;
			readonly focusTarget?: "heading" | "first-control";
	  }
	| {
			readonly kind: "return";
			readonly destination: EditorPath;
			readonly returnTarget: EditorPath;
			readonly scrollTop: number | undefined;
	  };

const WORKBENCH_FOCUS_SELECTOR = [
	"[data-rule-focus-summary]",
	"[data-removal-primary-focus]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
].join(",");

function focusWorkbenchAfterRemoval(
	root: HTMLElement | null,
	preferredPath: EditorPath | undefined,
	fallback: WorkbenchFocusFallback,
): void {
	queueMicrotask(() => {
		if (root === null || !root.isConnected) return;
		const preferred =
			preferredPath === undefined
				? undefined
				: [
						...root.querySelectorAll<HTMLElement>("[data-workbench-focus-id]"),
					].find(
						(candidate) =>
							candidate.dataset.workbenchFocusId ===
							workbenchFocusId(preferredPath),
					);
		const preferredControl = preferred?.querySelector<HTMLElement>(
			WORKBENCH_FOCUS_SELECTOR,
		);
		if (preferredControl !== undefined && preferredControl !== null) {
			preferredControl.focus({ preventScroll: true });
			return;
		}

		const fallbackControl = [
			...root.querySelectorAll<HTMLElement>("[data-workbench-focus-fallback]"),
		].find(
			(candidate) => candidate.dataset.workbenchFocusFallback === fallback,
		);
		fallbackControl?.focus({ preventScroll: true });
	});
}

/** DOM-visible focus identity must be deterministic across server render and
 * hydration. Sidecar list keys remain React-local; attributes use the editor
 * path that already uniquely locates a visible node. */
function workbenchFocusId(path: EditorPath): string {
	return JSON.stringify(path);
}

function findRuleFocusTarget(
	root: HTMLElement | null,
	path: EditorPath,
): HTMLElement | undefined {
	const targetId = workbenchFocusId(path);
	return [
		...(root?.querySelectorAll<HTMLElement>("[data-rule-focus-target]") ?? []),
	].find((candidate) => candidate.dataset.ruleFocusTarget === targetId);
}

function workspaceScroller(root: HTMLElement | null): HTMLElement | null {
	return (
		root?.closest<HTMLElement>("[data-case-workspace-scroll-body]") ?? null
	);
}

/** Promote a newly opened rule to the top of the frozen-tab body. Focus uses
 * preventScroll, so this deliberate scroll is the only movement and never
 * drags the tab strip itself. */
function scrollWorkbenchStartIntoView(root: HTMLElement | null): void {
	const scroller = workspaceScroller(root);
	if (root === null || scroller === null) return;
	const rootRect = root.getBoundingClientRect();
	const scrollerRect = scroller.getBoundingClientRect();
	const target = scroller.scrollTop + rootRect.top - scrollerRect.top;
	scroller.scrollTop = Math.max(0, target);
}

const STRUCTURE_ACTION_LABELS: Record<StructureKind, string> = {
	and: "Require every condition",
	or: "Require any condition",
	not: "Exclude when",
	"when-input-present": "Apply after a search answer",
	exists: "Require a related case",
	missing: "Require no related case",
};

function buildStructure(
	kind: StructureKind,
	ctx: PredicateEditContext,
): StructuralPredicate {
	return predicateCardSchemas[kind].defaultValue(ctx) as StructuralPredicate;
}

interface AddConditionMenuProps {
	readonly ctx: PredicateEditContext;
	readonly onAdd: (value: Predicate) => void;
	readonly disabled?: boolean;
	readonly className?: string;
	readonly triggerLabel?: string;
	readonly menuLabel?: string;
	readonly focusFallback?: WorkbenchFocusFallback;
	/** The caller moves focus into the newly rendered condition. Suppress the
	 * menu's ordinary return-to-trigger step so it cannot overwrite that handoff. */
	readonly suppressReturnFocusAfterAdd?: boolean;
}

/**
 * One progressive entry point for adding a condition. The ordinary comparison
 * comes first; every recursive structural shape follows in the same menu so a
 * simpler first choice never narrows what an experienced author can express.
 */
export function AddConditionMenu({
	ctx,
	onAdd,
	disabled = false,
	className = "",
	triggerLabel = "Add condition",
	menuLabel = "Choose a condition",
	focusFallback = "condition",
	suppressReturnFocusAfterAdd = false,
}: AddConditionMenuProps) {
	const comparisonSchema = predicateCardSchemas.eq;
	const comparisonApplicable = comparisonSchema.applicable(ctx);
	const addedConditionRef = useRef(false);
	const add = (next: Predicate) => {
		addedConditionRef.current = true;
		onAdd(next);
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				disabled={disabled}
				data-workbench-focus-fallback={focusFallback}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className={`border-white/[0.09] px-4 text-sm text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright ${className}`}
					/>
				}
			>
				<Icon icon={tablerPlus} width="15" height="15" />
				<span className="min-w-0 flex-1 text-left">{triggerLabel}</span>
				<Icon icon={tablerChevronDown} width="14" height="14" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				preferredMinWidth="18rem"
				finalFocus={
					suppressReturnFocusAfterAdd
						? () => {
								const addedCondition = addedConditionRef.current;
								addedConditionRef.current = false;
								return !addedCondition;
							}
						: undefined
				}
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
					<DropdownMenuItem
						disabled={!comparisonApplicable}
						closeOnClick
						onClick={() => add(firstComparisonDefault(ctx))}
						className="min-h-11"
					>
						<Icon icon={comparisonSchema.icon} />
						<span className="min-w-0">
							<span className="block text-sm font-medium">
								Compare case information
							</span>
							<span className="block text-[13px] text-nova-text-muted">
								{comparisonApplicable
									? "Choose what to compare, how it should match, and the value"
									: "Add case information before comparing it"}
							</span>
						</span>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					{STRUCTURE_KINDS.map((kind) => {
						const schema = predicateCardSchemas[kind];
						const applicable = schema.applicable(ctx);
						return (
							<DropdownMenuItem
								key={kind}
								disabled={!applicable}
								closeOnClick
								onClick={() => add(buildStructure(kind, ctx))}
								className="min-h-11"
							>
								<Icon icon={schema.icon} />
								<span className="min-w-0">
									<span className="block text-sm font-medium">
										{STRUCTURE_ACTION_LABELS[kind]}
									</span>
									<span className="block text-[13px] leading-snug text-nova-text-muted">
										{applicable
											? schema.description
											: predicateUnavailableReason(kind, ctx)}
									</span>
								</span>
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export interface PredicateWorkbenchProps {
	readonly value: Predicate;
	readonly onChange: (next: Predicate) => void;
	readonly onRemoveRoot?: () => void;
	readonly removeRootLabel?: string;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs?: readonly EditorSearchInputDecl[];
	/** Runtime that evaluates this rule. Search-backed rules consult the
	 *  boundary verdict before offering a guaranteed-invalid value source. */
	readonly evaluationTarget?: "on-device" | "case-search";
	/** When the rule evaluates relative to a case row. `"global"` slots
	 *  (the search-button display condition) resolve once, before any
	 *  case is selected — verbs, seeds, and value sources drop every
	 *  case-property / relationship read there. */
	readonly caseDataScope?: CaseDataScope;
	/** A semantic navigation request from another surface. The token makes a
	 * repeat request for the same AST path observable after the author returns
	 * to a dependency review. */
	readonly focusRequest?: {
		readonly token: number;
		readonly path: EditorPath;
		readonly focusTarget?: "heading" | "first-control";
	};
}

export function PredicateWorkbench({
	value,
	onChange,
	onRemoveRoot,
	removeRootLabel = "Delete condition",
	caseTypes,
	currentCaseType,
	knownInputs = [],
	evaluationTarget = "on-device",
	caseDataScope = "per-case",
	focusRequest,
}: PredicateWorkbenchProps) {
	const [requestedPath, setRequestedPath] = useState<EditorPath>(
		() => focusRequest?.path ?? [],
	);
	const workbenchRef = useRef<HTMLDivElement>(null);
	const navigationFocusRef = useRef<NavigationFocusRequest | null>(null);
	const handledFocusRequestRef = useRef<number | null>(null);
	const returnScrollPositionsRef = useRef(new Map<string, number>());
	const activeHeadingId = `${useId()}-active-condition`;
	const navigationContext = useMemo<RuleNavigationContext>(
		() => ({ caseTypes, currentCaseType, knownInputs }),
		[caseTypes, currentCaseType, knownInputs],
	);
	// Canonical AST reductions can remove the node that was open. Relation edits
	// can also make a nested destination temporarily unknowable. In both cases,
	// recover to the nearest still-meaningful ancestor while preserving the
	// authored subtree for repair.
	const location = nearestRuleLocation(value, requestedPath, navigationContext);
	const activePath = location.path;
	const focusedCaseType = location.currentCaseType;
	const activeBreadcrumb = workbenchBreadcrumb(
		location.trail.at(-1),
		location.trail.length - 1,
		knownInputs,
	);

	const typeContext = useMemo(
		() => ({
			caseTypes: [...caseTypes],
			knownInputs: [...knownInputs],
			currentCaseType,
		}),
		[caseTypes, currentCaseType, knownInputs],
	);
	const validity = useMemo(
		() => checkPredicate(value, typeContext),
		[value, typeContext],
	);
	const validityIndex = useMemo(
		() => buildValidityIndex(validity.ok ? [] : validity.errors),
		[validity],
	);

	const editContext = useMemo<PredicateEditContext>(
		() => ({
			caseTypes,
			currentCaseType: focusedCaseType,
			knownInputs,
			caseDataScope,
		}),
		[caseTypes, focusedCaseType, knownInputs, caseDataScope],
	);
	const admitCaseSearchExpression = useCallback(
		(path: EditorPath, next: ValueExpression) => {
			const candidate = replaceRuleNodeAtPath(value, path, {
				family: "expression",
				value: next,
			});
			const verdict = caseSearchPredicateEditVerdict(value, candidate);
			return verdict.ok
				? ({ admitted: true } as const)
				: ({ admitted: false, reason: verdict.reason } as const);
		},
		[value],
	);

	const updateFocusedPredicate = (next: Predicate) => {
		onChange(
			replaceRuleNodeAtPath(value, activePath, {
				family: "predicate",
				value: next,
			}),
		);
	};
	const updateFocusedExpression = (next: ValueExpression) => {
		// Re-check inside the callback: TypeScript does not retain the JSX
		// branch's discriminant narrowing across an event-handler closure.
		if (location.node.family !== "expression") return;
		onChange(
			replaceRuleNodeAtPath(value, activePath, {
				family: "expression",
				value: next,
			}),
		);
	};

	const restoreAfterRemoval = (
		preferredPath: EditorPath | undefined,
		fallback: WorkbenchFocusFallback = "condition",
	) => {
		focusWorkbenchAfterRemoval(workbenchRef.current, preferredPath, fallback);
	};
	const addPeer = (next: Predicate) => {
		if (location.node.family !== "predicate") return;
		updateFocusedPredicate({
			kind: "and",
			clauses: [location.node.value, next],
		});
		restoreAfterRemoval(appendKindIndex(activePath, "and", 1));
	};
	const enterRule = useCallback((path: EditorPath) => {
		const scroller = workspaceScroller(workbenchRef.current);
		if (scroller !== null) {
			returnScrollPositionsRef.current.set(
				workbenchFocusId(path),
				scroller.scrollTop,
			);
		}
		navigationFocusRef.current = { kind: "enter", destination: path };
		setRequestedPath(path);
	}, []);
	const returnToRule = useCallback(
		(destination: EditorPath, returnTarget: EditorPath) => {
			navigationFocusRef.current = {
				kind: "return",
				destination,
				returnTarget,
				scrollTop: returnScrollPositionsRef.current.get(
					workbenchFocusId(returnTarget),
				),
			};
			setRequestedPath(destination);
		},
		[],
	);
	const focusActiveRegion = useCallback(
		(node: HTMLElement | null) => {
			if (node === null) return;
			const request = navigationFocusRef.current;
			if (request === null || !pathsEqual(request.destination, activePath)) {
				return;
			}
			navigationFocusRef.current = null;
			queueMicrotask(() => {
				if (!node.isConnected) return;
				if (request.kind === "enter") {
					scrollWorkbenchStartIntoView(workbenchRef.current);
				} else if (request.scrollTop !== undefined) {
					const scroller = workspaceScroller(workbenchRef.current);
					if (scroller !== null) scroller.scrollTop = request.scrollTop;
				}
				const target =
					request.kind === "return"
						? findRuleFocusTarget(workbenchRef.current, request.returnTarget)
						: request.focusTarget === "first-control"
							? node.querySelector<HTMLElement>(WORKBENCH_FOCUS_SELECTOR)
							: node.querySelector<HTMLElement>(
									"[data-workbench-active-heading]",
								);
				(
					target ??
					node.querySelector<HTMLElement>("[data-workbench-active-heading]")
				)?.focus({ preventScroll: true });
			});
		},
		[activePath],
	);

	/* Dependency review can enter this editor at an arbitrarily deep operand.
	 * Reuse the workbench's own path recovery and focus handoff so the request
	 * opens every structural ancestor, scrolls only the tab body, and lands on
	 * the active condition heading. A fresh token intentionally replays the
	 * focus even when the path itself has not changed. */
	useLayoutEffect(() => {
		if (
			focusRequest === undefined ||
			handledFocusRequestRef.current === focusRequest.token
		) {
			return;
		}
		handledFocusRequestRef.current = focusRequest.token;
		const destination = nearestRuleLocation(
			value,
			focusRequest.path,
			navigationContext,
		).path;
		navigationFocusRef.current = {
			kind: "enter",
			destination,
			focusTarget: focusRequest.focusTarget,
		};
		if (!pathsEqual(destination, activePath)) {
			setRequestedPath(focusRequest.path);
			return;
		}
		queueMicrotask(() => {
			const root = workbenchRef.current;
			if (root === null || !root.isConnected) return;
			scrollWorkbenchStartIntoView(root);
			const target =
				focusRequest.focusTarget === "first-control"
					? root.querySelector<HTMLElement>(WORKBENCH_FOCUS_SELECTOR)
					: root.querySelector<HTMLElement>("[data-workbench-active-heading]");
			target?.focus({ preventScroll: true });
			navigationFocusRef.current = null;
		});
	}, [activePath, focusRequest, navigationContext, value]);

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={focusedCaseType}
			knownInputs={knownInputs}
			caseDataScope={caseDataScope}
			validityIndex={validityIndex}
			admitExpressionChange={
				evaluationTarget === "case-search"
					? admitCaseSearchExpression
					: undefined
			}
		>
			<RuleFocusProvider activePath={activePath} open={enterRule}>
				<div ref={workbenchRef} className="@container space-y-3">
					<WorkbenchNavigation
						location={location}
						knownInputs={knownInputs}
						onReturn={returnToRule}
					/>
					<section
						key={workbenchFocusId(activePath)}
						ref={focusActiveRegion}
						aria-labelledby={activeHeadingId}
						className="space-y-3"
						data-workbench-focus-id={workbenchFocusId(activePath)}
					>
						<h3
							id={activeHeadingId}
							tabIndex={-1}
							data-workbench-active-heading
							className="sr-only"
						>
							Editing {activeBreadcrumb.toLocaleLowerCase()}
						</h3>
						{location.node.family === "expression" ? (
							<ExpressionPicker
								key={`expression:${serializePath(activePath)}`}
								value={location.node.value}
								onChange={updateFocusedExpression}
								path={activePath}
								constraint={location.constraint}
								presentation={location.presentation}
							/>
						) : isStructuralPredicate(location.node.value) ? (
							<>
								<FocusedStructure
									key={`predicate:${serializePath(activePath)}`}
									value={location.node.value}
									path={activePath}
									onChange={updateFocusedPredicate}
									onFocus={enterRule}
									onRestoreAfterRemoval={restoreAfterRemoval}
									onRemove={activePath.length === 0 ? onRemoveRoot : undefined}
									removeLabel={removeRootLabel}
									editContext={editContext}
								/>
								{location.node.value.kind !== "and" &&
									location.node.value.kind !== "or" && (
										<WorkbenchAddActions
											onAdd={addPeer}
											editContext={editContext}
										/>
									)}
							</>
						) : (
							<>
								<ChildPredicateEditor
									value={location.node.value}
									onChange={updateFocusedPredicate}
									path={activePath}
								/>
								{activePath.length === 0 && onRemoveRoot !== undefined ? (
									<div className="flex justify-end">
										<Button
											type="button"
											variant="destructive"
											size="xl"
											onClick={onRemoveRoot}
											className="px-3 text-sm"
										>
											{removeRootLabel}
										</Button>
									</div>
								) : null}
								<WorkbenchAddActions
									onAdd={addPeer}
									editContext={editContext}
								/>
							</>
						)}
					</section>
				</div>
			</RuleFocusProvider>
		</PredicateEditProvider>
	);
}

function WorkbenchNavigation({
	location,
	knownInputs,
	onReturn,
}: {
	readonly location: RuleLocation;
	readonly knownInputs: readonly EditorSearchInputDecl[];
	readonly onReturn: (
		destination: EditorPath,
		returnTarget: EditorPath,
	) => void;
}) {
	const { path: activePath, trail } = location;
	if (activePath.length === 0) return null;
	const labels = trail.map((item, index) =>
		workbenchBreadcrumb(item, index, knownInputs),
	);
	const parent = trail.at(-2);
	const parentPath = parent?.path ?? [];
	const parentLabel = labels.at(-2) ?? "Cases available";
	return (
		<div className="flex min-w-0 flex-col items-start gap-0.5 @sm:flex-row @sm:gap-1">
			<Button
				type="button"
				variant="ghost"
				size="xl"
				onClick={() => onReturn(parentPath, activePath)}
				aria-label={`Back to ${parentLabel.toLocaleLowerCase()}`}
				className="shrink-0 self-start text-nova-text-secondary"
			>
				<Icon icon={tablerArrowLeft} />
				Back
			</Button>
			<nav
				aria-label="Condition location"
				className="min-w-0 w-full flex-1 p-1"
			>
				<ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
					{trail.map((item, index) => {
						const isCurrent = index === trail.length - 1;
						const label = labels[index] ?? item.breadcrumb;
						const returnTarget = trail[index + 1]?.path ?? activePath;
						return (
							<li
								key={serializePath(item.path)}
								className="flex min-w-0 items-center gap-1"
							>
								{index > 0 && (
									<Icon
										icon={tablerChevronRight}
										aria-hidden="true"
										className="size-3 shrink-0 text-nova-text-muted"
									/>
								)}
								{isCurrent ? (
									<span
										aria-current="location"
										className="min-w-0 break-words px-1 text-[12px] font-medium text-nova-text-secondary"
									>
										{label}
									</span>
								) : (
									<Button
										type="button"
										variant="link"
										size="xl"
										onClick={() => onReturn(item.path, returnTarget)}
										className="h-auto min-h-11 min-w-0 shrink break-words px-2 py-2 text-left text-[13px] leading-snug whitespace-normal"
									>
										{label}
									</Button>
								)}
							</li>
						);
					})}
				</ol>
			</nav>
		</div>
	);
}

function FocusedStructure({
	value,
	path,
	onChange,
	onFocus,
	onRestoreAfterRemoval,
	onRemove,
	removeLabel,
	editContext,
}: {
	readonly value: StructuralPredicate;
	readonly path: EditorPath;
	readonly onChange: (next: Predicate) => void;
	readonly onFocus: (path: EditorPath) => void;
	readonly onRestoreAfterRemoval: (
		preferredPath: EditorPath | undefined,
		fallback?: WorkbenchFocusFallback,
	) => void;
	readonly onRemove?: () => void;
	readonly removeLabel: string;
	readonly editContext: PredicateEditContext;
}) {
	const errors = useEditorErrorsAt(path);
	const schema = predicateCardSchemas[value.kind];
	const logicalGroup = value.kind === "and" || value.kind === "or";
	const groupLabel = logicalGroup
		? `${value.clauses.length} ${value.clauses.length === 1 ? "condition" : "conditions"}`
		: undefined;
	return (
		<section
			className={`rounded-2xl border bg-nova-deep/25 ${
				errors.length > 0 ? "border-nova-rose/35" : "border-white/[0.08]"
			}`}
		>
			{logicalGroup ? (
				<header className="space-y-2 border-b border-white/[0.07] px-4 py-3.5">
					<div
						data-logical-group-header
						className="flex min-w-0 flex-col items-stretch gap-2 @sm:min-h-11 @sm:flex-row @sm:items-center @sm:gap-3"
					>
						<div className="min-w-0 flex-1">
							<h4 className="break-words text-[14px] font-semibold text-nova-text">
								{groupLabel}
							</h4>
							{errors.length > 0 ? (
								<span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-nova-rose">
									<Icon icon={tablerAlertCircle} />
									Needs attention
								</span>
							) : null}
						</div>
						{onRemove !== undefined ? (
							<Button
								type="button"
								variant="destructive"
								size="xl"
								onClick={onRemove}
								className="min-h-11 w-full shrink-0 justify-start px-3 text-sm @sm:w-auto @sm:justify-center"
							>
								{removeLabel}
							</Button>
						) : null}
					</div>
					<GroupConnectorMenu
						kind={value.kind}
						onChange={(kind) => {
							onChange({ ...value, kind });
							onRestoreAfterRemoval(path);
						}}
					/>
				</header>
			) : (
				<header className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-4 py-3.5">
					<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-nova-violet/[0.08] text-nova-violet-bright">
						<Icon icon={schema.icon} width="17" height="17" />
					</span>
					<div className="min-w-0 flex-1">
						<h4 className="text-[14px] font-semibold text-nova-text">
							{structureLabel(value, editContext.knownInputs)}
						</h4>
						<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-muted">
							{structureDescription(value)}
						</p>
					</div>
					{errors.length > 0 ? (
						<span className="inline-flex items-center gap-1 text-xs font-medium text-nova-rose">
							<Icon icon={tablerAlertCircle} />
							Needs attention
						</span>
					) : null}
					<PredicateKindReplaceMenu
						currentValue={value}
						onChange={onChange}
						label="Change condition"
					/>
					{onRemove !== undefined ? (
						<Button
							type="button"
							variant="destructive"
							size="xl"
							onClick={onRemove}
							className="px-3 text-sm"
						>
							{removeLabel}
						</Button>
					) : null}
				</header>
			)}
			<div className="p-3 @sm:p-4">
				<FocusedStructureBody
					value={value}
					path={path}
					onChange={onChange}
					onFocus={onFocus}
					onRestoreAfterRemoval={onRestoreAfterRemoval}
					editContext={editContext}
				/>
			</div>
		</section>
	);
}

function FocusedStructureBody({
	value,
	path,
	onChange,
	onFocus,
	onRestoreAfterRemoval,
	editContext,
}: {
	readonly value: StructuralPredicate;
	readonly path: EditorPath;
	readonly onChange: (next: Predicate) => void;
	readonly onFocus: (path: EditorPath) => void;
	readonly onRestoreAfterRemoval: (
		preferredPath: EditorPath | undefined,
		fallback?: WorkbenchFocusFallback,
	) => void;
	readonly editContext: PredicateEditContext;
}) {
	switch (value.kind) {
		case "and":
		case "or":
			return (
				<FocusedLogicalGroup
					value={value}
					path={path}
					onChange={onChange}
					onFocus={onFocus}
					onRestoreAfterRemoval={onRestoreAfterRemoval}
					editContext={editContext}
				/>
			);
		case "not": {
			const childPath = appendKindSlot(path, "not", "clause");
			return (
				<ImmediatePredicate
					value={value.clause}
					path={childPath}
					onChange={(clause) => onChange({ ...value, clause })}
					onFocus={onFocus}
				/>
			);
		}
		case "when-input-present": {
			const childPath = appendKindSlot(path, value.kind, "clause");
			return (
				<div className="space-y-4">
					<div className="space-y-1.5">
						<p className="text-[13px] font-medium text-nova-text-secondary">
							Search answer
						</p>
						<SearchInputMenu
							value={value.input.name || undefined}
							onChange={(name) =>
								onChange({ ...value, input: { kind: "input", name } })
							}
							invalid={false}
						/>
					</div>
					<div className="space-y-1.5">
						<p className="text-[13px] font-medium text-nova-text-secondary">
							Condition to apply
						</p>
						<ImmediatePredicate
							value={value.clause}
							path={childPath}
							onChange={(clause) => onChange({ ...value, clause })}
							onFocus={onFocus}
						/>
					</div>
				</div>
			);
		}
		case "exists":
		case "missing":
			return (
				<FocusedRelation
					value={value}
					path={path}
					onChange={onChange}
					onFocus={onFocus}
					onRestoreAfterRemoval={onRestoreAfterRemoval}
					editContext={editContext}
				/>
			);
	}
}

function FocusedLogicalGroup({
	value,
	path,
	onChange,
	onFocus,
	onRestoreAfterRemoval,
	editContext,
}: {
	readonly value: Extract<Predicate, { kind: "and" | "or" }>;
	readonly path: EditorPath;
	readonly onChange: (next: Predicate) => void;
	readonly onFocus: (path: EditorPath) => void;
	readonly onRestoreAfterRemoval: (
		preferredPath: EditorPath | undefined,
		fallback?: WorkbenchFocusFallback,
	) => void;
	readonly editContext: PredicateEditContext;
}) {
	const rowIdentity = useStableListIdentity(value.clauses);
	const updateClauses = (
		clauses: readonly Predicate[],
		operation: StableListOperation,
	) => {
		rowIdentity.stage(clauses, operation);
		if (clauses.length === 0) {
			onChange(
				predicateCardSchemas[
					value.kind === "and" ? "match-all" : "match-none"
				].defaultValue(editContext),
			);
			return;
		}
		if (clauses.length === 1) {
			onChange(clauses[0]);
			return;
		}
		onChange({ ...value, clauses: clauses as [Predicate, ...Predicate[]] });
	};

	const updateAt = (index: number, next: Predicate) => {
		updateClauses(
			value.clauses.map((clause, clauseIndex) =>
				clauseIndex === index ? next : clause,
			),
			{ kind: "replace" },
		);
	};

	const move = (index: number, direction: -1 | 1) => {
		const destination = index + direction;
		if (destination < 0 || destination >= value.clauses.length) return;
		const moved = value.clauses[index];
		if (moved === undefined) return;
		const clauses = [...value.clauses];
		clauses.splice(index, 1);
		clauses.splice(destination, 0, moved);
		updateClauses(clauses, {
			kind: "move",
			fromIndex: index,
			toIndex: destination,
		});
		onRestoreAfterRemoval(appendKindIndex(path, value.kind, destination));
	};

	const groupWithNext = (index: number) => {
		const first = value.clauses[index];
		const second = value.clauses[index + 1];
		if (first === undefined || second === undefined) return;
		const nested: Predicate = {
			kind: value.kind === "and" ? "or" : "and",
			clauses: [first, second],
		};
		updateClauses(
			[
				...value.clauses.slice(0, index),
				nested,
				...value.clauses.slice(index + 2),
			],
			{
				kind: "splice",
				index,
				deleteCount: 2,
				insertCount: 1,
			},
		);
		onRestoreAfterRemoval(appendKindIndex(path, value.kind, index));
	};

	const ungroup = (index: number) => {
		const child = value.clauses[index];
		if (child?.kind !== "and" && child?.kind !== "or") return;
		updateClauses(
			[
				...value.clauses.slice(0, index),
				...child.clauses,
				...value.clauses.slice(index + 1),
			],
			{
				kind: "splice",
				index,
				deleteCount: 1,
				insertCount: child.clauses.length,
			},
		);
		onRestoreAfterRemoval(appendKindIndex(path, value.kind, index));
	};

	return (
		<div className="space-y-3">
			<ol
				aria-label={
					value.kind === "and"
						? "Conditions where all must match"
						: "Conditions where any can match"
				}
				className="m-0 list-none space-y-3 p-0"
			>
				{value.clauses.map((clause, index) => (
					<li key={rowIdentity.keys[index]}>
						<ImmediatePredicate
							value={clause}
							path={appendKindIndex(path, value.kind, index)}
							onChange={(next) => updateAt(index, next)}
							onRemove={() => {
								const remaining = value.clauses.filter(
									(_, clauseIndex) => clauseIndex !== index,
								);
								updateClauses(remaining, {
									kind: "splice",
									index,
									deleteCount: 1,
									insertCount: 0,
								});
								onRestoreAfterRemoval(
									remaining.length === 1
										? path
										: remaining.length > 1
											? appendKindIndex(
													path,
													value.kind,
													Math.min(index, remaining.length - 1),
												)
											: undefined,
								);
							}}
							onFocus={onFocus}
							actions={{
								canMoveEarlier: index > 0,
								canMoveLater: index < value.clauses.length - 1,
								canGroupWithNext: index < value.clauses.length - 1,
								canUngroup: clause.kind === "and" || clause.kind === "or",
								onMoveEarlier: () => move(index, -1),
								onMoveLater: () => move(index, 1),
								onGroupWithNext: () => groupWithNext(index),
								onUngroup: () => ungroup(index),
								groupLabel:
									value.kind === "and"
										? "Let either of these conditions match"
										: "Require both of these conditions",
								ungroupLabel:
									value.kind === "and"
										? "Require every condition separately"
										: "Let any condition match separately",
							}}
						/>
					</li>
				))}
			</ol>

			<WorkbenchAddActions
				onAdd={(next) => {
					updateClauses([...value.clauses, next], {
						kind: "splice",
						index: value.clauses.length,
						deleteCount: 0,
						insertCount: 1,
					});
					onRestoreAfterRemoval(
						appendKindIndex(path, value.kind, value.clauses.length),
					);
				}}
				editContext={editContext}
			/>
		</div>
	);
}

function GroupConnectorMenu({
	kind,
	onChange,
}: {
	readonly kind: "and" | "or";
	readonly onChange: (kind: "and" | "or") => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="w-full justify-between border-white/[0.09] px-3 text-sm text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:text-nova-violet-bright"
					/>
				}
			>
				{kind === "and"
					? "All conditions must match"
					: "Any condition can match"}
				<Icon icon={tablerChevronDown} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" preferredMinWidth="14rem">
				<DropdownMenuRadioGroup
					value={kind}
					onValueChange={(next) => onChange(next as "and" | "or")}
				>
					<DropdownMenuRadioItem value="and" closeOnClick className="min-h-11">
						All conditions must match
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="or" closeOnClick className="min-h-11">
						Any condition can match
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

interface RowActions {
	readonly canMoveEarlier: boolean;
	readonly canMoveLater: boolean;
	readonly canGroupWithNext: boolean;
	readonly canUngroup: boolean;
	readonly onMoveEarlier: () => void;
	readonly onMoveLater: () => void;
	readonly onGroupWithNext: () => void;
	readonly onUngroup: () => void;
	readonly groupLabel: string;
	readonly ungroupLabel: string;
}

function ImmediatePredicate({
	value,
	path,
	onChange,
	onRemove,
	onFocus,
	actions,
}: {
	readonly value: Predicate;
	readonly path: EditorPath;
	readonly onChange: (next: Predicate) => void;
	readonly onRemove?: () => void;
	readonly onFocus: (path: EditorPath) => void;
	readonly actions?: RowActions;
}) {
	if (isStructuralPredicate(value)) {
		return (
			<div data-workbench-focus-id={workbenchFocusId(path)}>
				<StructuralSummaryRow
					value={value}
					path={path}
					onEdit={() => onFocus(path)}
					onRemove={onRemove}
					actions={actions}
				/>
			</div>
		);
	}
	return (
		<div
			className="space-y-1.5"
			data-workbench-focus-id={workbenchFocusId(path)}
		>
			<ChildPredicateEditor
				value={value}
				onChange={onChange}
				onRemove={onRemove}
				path={path}
				variant="nested"
				footerAction={
					actions === undefined ? undefined : (
						<PredicateRowActions actions={actions} />
					)
				}
			/>
		</div>
	);
}

function StructuralSummaryRow({
	value,
	path,
	onEdit,
	onRemove,
	actions,
}: {
	readonly value: StructuralPredicate;
	readonly path: EditorPath;
	readonly onEdit: () => void;
	readonly onRemove?: () => void;
	readonly actions?: RowActions;
}) {
	const schema = predicateCardSchemas[value.kind];
	const { knownInputs } = usePredicateEditContext();
	const context = structuralActionContext(value, path, knownInputs);
	return (
		<div className="@container rounded-xl border border-white/[0.08] bg-nova-surface/25 p-3">
			<div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 @lg:grid-cols-[auto_minmax(0,1fr)_auto] @lg:items-center">
				<span className="grid size-9 shrink-0 place-items-center rounded-lg bg-nova-violet/[0.08] text-nova-violet-bright">
					<Icon icon={schema.icon} width="16" height="16" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="break-words text-sm font-semibold text-nova-text [overflow-wrap:anywhere]">
						{structureLabel(value, knownInputs)}
					</p>
					<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-muted">
						{structureDescription(value)}
					</p>
				</div>
				<div className="col-span-2 flex min-w-0 flex-wrap justify-end gap-2 @lg:col-span-1 @lg:col-start-3 @lg:row-start-1">
					<Button
						type="button"
						variant="outline"
						size="xl"
						onClick={onEdit}
						aria-label={`Edit ${context}`}
						data-rule-focus-summary
						data-rule-focus-target={workbenchFocusId(path)}
					>
						Edit condition
						<Icon icon={tablerChevronRight} />
					</Button>
					{(actions !== undefined || onRemove !== undefined) && (
						<PredicateRowActions
							actions={actions}
							onRemove={onRemove}
							removeLabel="Delete group"
							triggerLabel={`Organize ${context}`}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

function PredicateRowActions({
	actions,
	onRemove,
	removeLabel = "Delete condition",
	triggerLabel = "Organize condition",
}: {
	readonly actions?: RowActions;
	readonly onRemove?: () => void;
	readonly removeLabel?: string;
	readonly triggerLabel?: string;
}) {
	if (actions === undefined && onRemove !== undefined) {
		return (
			<div className="flex justify-end">
				<Button
					type="button"
					variant="ghost"
					size="xl"
					onClick={onRemove}
					className="px-3 text-sm text-nova-rose not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose"
				>
					<Icon icon={tablerTrash} />
					{removeLabel}
				</Button>
			</div>
		);
	}

	return (
		<div className="flex justify-end">
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="xl"
							aria-label={triggerLabel}
							className="px-3 text-sm text-nova-text-muted not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-text"
						/>
					}
				>
					Organize condition
					<Icon icon={tablerChevronDown} />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" preferredMinWidth="16rem">
					{actions !== undefined && (
						<>
							<DropdownMenuItem
								disabled={!actions.canMoveEarlier}
								onClick={actions.onMoveEarlier}
								closeOnClick
								className="min-h-11"
							>
								Move earlier
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={!actions.canMoveLater}
								onClick={actions.onMoveLater}
								closeOnClick
								className="min-h-11"
							>
								Move later
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								disabled={!actions.canGroupWithNext}
								onClick={actions.onGroupWithNext}
								closeOnClick
								className="min-h-11"
							>
								{actions.groupLabel}
							</DropdownMenuItem>
							{actions.canUngroup && (
								<DropdownMenuItem
									onClick={actions.onUngroup}
									closeOnClick
									className="min-h-11"
								>
									{actions.ungroupLabel}
								</DropdownMenuItem>
							)}
						</>
					)}
					{onRemove !== undefined && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onClick={onRemove}
								closeOnClick
								className="min-h-11"
							>
								{removeLabel}
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

function FocusedRelation({
	value,
	path,
	onChange,
	onFocus,
	onRestoreAfterRemoval,
	editContext,
}: {
	readonly value: Extract<Predicate, { kind: "exists" | "missing" }>;
	readonly path: EditorPath;
	readonly onChange: (next: Predicate) => void;
	readonly onFocus: (path: EditorPath) => void;
	readonly onRestoreAfterRemoval: (
		preferredPath: EditorPath | undefined,
		fallback?: WorkbenchFocusFallback,
	) => void;
	readonly editContext: PredicateEditContext;
}) {
	const destination = resolveRelationDestination(
		value.via,
		editContext.currentCaseType,
		editContext.caseTypes,
	);
	const setVia = (via: RelationPath) => {
		const builder = value.kind === "exists" ? exists : missing;
		// Changing the connection must not silently reseed a carefully authored
		// nested rule. If the new destination makes that rule invalid, the
		// type-checker keeps it visible and explains what needs attention.
		onChange(
			value.where === undefined ? builder(via) : builder(via, value.where),
		);
	};
	const setWhere = (where: Predicate | undefined) => {
		const builder = value.kind === "exists" ? exists : missing;
		onChange(
			where === undefined ? builder(value.via) : builder(value.via, where),
		);
	};
	const destinationContext =
		destination === undefined
			? undefined
			: { ...editContext, currentCaseType: destination };

	return (
		<div className="space-y-4">
			<div className="space-y-1.5">
				<p className="text-[13px] font-medium text-nova-text-secondary">
					Connection
				</p>
				<RelationPathBuilder
					value={value.via}
					onChange={setVia}
					allowSelf={false}
				/>
			</div>
			<div className="space-y-2 border-t border-white/[0.07] pt-4">
				<div>
					<p className="text-[13px] font-medium text-nova-text-secondary">
						Related cases to match
					</p>
					<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-muted">
						Without a condition, every case on this connection is considered
					</p>
				</div>
				{value.where !== undefined && destination !== undefined && (
					<WithCurrentCaseType caseType={destination}>
						<ImmediatePredicate
							value={value.where}
							path={appendKindSlot(path, value.kind, "where")}
							onChange={(next) => setWhere(next)}
							onRemove={() => {
								setWhere(undefined);
								onRestoreAfterRemoval(undefined, "related-condition");
							}}
							onFocus={onFocus}
						/>
					</WithCurrentCaseType>
				)}
				{value.where !== undefined && destination === undefined && (
					<div className="flex items-start gap-3 rounded-xl border border-nova-amber/30 bg-nova-amber/[0.05] px-4 py-3">
						<span className="grid size-9 shrink-0 place-items-center rounded-lg bg-nova-amber/[0.10] text-nova-amber">
							<Icon
								icon={predicateCardSchemas[value.where.kind].icon}
								width="16"
								height="16"
							/>
						</span>
						<div className="min-w-0">
							<p className="text-sm font-semibold text-nova-text">
								{structureLabel(value.where, editContext.knownInputs)}
							</p>
							<p className="mt-1 text-[13px] leading-relaxed text-nova-text-secondary">
								This condition still applies. Fix the connection above to edit
								it.
							</p>
						</div>
					</div>
				)}
				{value.where === undefined && destinationContext !== undefined && (
					<WorkbenchAddActions
						onAdd={(where) => {
							setWhere(where);
							onRestoreAfterRemoval(
								appendKindSlot(path, value.kind, "where"),
								"related-condition",
							);
						}}
						editContext={destinationContext}
						triggerLabel="Add condition for related cases"
						menuLabel="Choose a condition for related cases"
						focusFallback="related-condition"
					/>
				)}
			</div>
		</div>
	);
}

function WorkbenchAddActions({
	onAdd,
	editContext,
	triggerLabel,
	menuLabel,
	focusFallback,
}: {
	readonly onAdd: (next: Predicate) => void;
	readonly editContext: PredicateEditContext;
	readonly triggerLabel?: string;
	readonly menuLabel?: string;
	readonly focusFallback?: WorkbenchFocusFallback;
}) {
	return (
		<div className="border-t border-white/[0.07] pt-3">
			<AddConditionMenu
				ctx={editContext}
				onAdd={onAdd}
				className="w-full"
				triggerLabel={triggerLabel}
				menuLabel={menuLabel}
				focusFallback={focusFallback}
				suppressReturnFocusAfterAdd
			/>
		</div>
	);
}

/** Breadcrumbs name the authored structure, not the implementation slot that
 * contains it. Keep group labels short enough to scan when a deep trail wraps
 * on a narrow canvas. */
function workbenchBreadcrumb(
	item: RuleLocation["trail"][number] | undefined,
	index: number,
	knownInputs: readonly EditorSearchInputDecl[],
): string {
	if (item === undefined) return "Condition";
	if (index === 0 || item.node.family === "expression") {
		return item.breadcrumb;
	}
	const value = item.node.value;
	switch (value.kind) {
		case "and":
			return "All conditions";
		case "or":
			return "Any condition";
		case "not":
			return "Exclude cases when";
		case "when-input-present":
			return value.input.name
				? `When ${searchInputDisplayLabel(value.input.name, knownInputs)} is answered`
				: "After a search answer";
		case "exists":
			return "Related case";
		case "missing":
			return "No related case";
		default:
			return predicateCardSchemas[value.kind].label;
	}
}

function structuralActionContext(
	value: StructuralPredicate,
	path: EditorPath,
	knownInputs: readonly EditorSearchInputDecl[],
): string {
	const base = (() => {
		switch (value.kind) {
			case "and":
				return "group where all conditions match";
			case "or":
				return "group where any condition can match";
			case "not":
				return "condition that excludes cases";
			case "when-input-present":
				return value.input.name
					? `condition after ${searchInputDisplayLabel(value.input.name, knownInputs)} is answered`
					: "condition after a search answer";
			case "exists":
				return "related case condition";
			case "missing":
				return "missing related case condition";
		}
	})();
	const position = [...path]
		.reverse()
		.find((segment): segment is number => typeof segment === "number");
	return position === undefined ? base : `${base} at position ${position + 1}`;
}

function structureLabel(
	value: Predicate,
	knownInputs: readonly EditorSearchInputDecl[] = [],
): string {
	switch (value.kind) {
		case "and":
			return "All conditions match";
		case "or":
			return "Any condition matches";
		case "not":
			return "Exclude cases when";
		case "when-input-present":
			return value.input.name
				? `When ${searchInputDisplayLabel(value.input.name, knownInputs)} is answered`
				: "When a search field is answered";
		case "exists":
			return "Has a related case";
		case "missing":
			return "Has no related case";
		default:
			return predicateCardSchemas[value.kind].label;
	}
}

function structureDescription(value: StructuralPredicate): string {
	switch (value.kind) {
		case "and":
			return `${value.clauses.length} ${value.clauses.length === 1 ? "condition" : "conditions"}, all must match`;
		case "or":
			return `${value.clauses.length} ${value.clauses.length === 1 ? "condition" : "conditions"}, at least one must match`;
		case "not":
			return "Exclude cases when the condition inside matches";
		case "when-input-present":
			return "Apply this condition only after someone answers that search field";
		case "exists":
			return value.where === undefined
				? "Require at least one case on the chosen connection"
				: "Require at least one connected case to match the condition inside";
		case "missing":
			return value.where === undefined
				? "Require no cases on the chosen connection"
				: "Require that no connected case matches the condition inside";
	}
}
