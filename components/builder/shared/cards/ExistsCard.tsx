// components/builder/shared/cards/ExistsCard.tsx
//
// Renders the relational quantifiers `exists` and `missing`. Both
// share one body — `via` (RelationPath) + optional inner `where`
// predicate. The card surfaces a kind toggle (Has / No related
// case) at the top so authors can flip between the two without
// rebuilding the relation walk; the `defaultValue` factories on
// the schema entries seed each kind's initial shape.
//
// Inside the inner `where` clause, the editor flips its
// `currentCaseType` to the relation walk's destination so nested
// property pickers show the destination's properties — mirrors
// the type checker's `checkInDestinationScope` contract.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerLink from "@iconify-icons/tabler/link";
import tablerUnlink from "@iconify-icons/tabler/unlink";
import { useId, useMemo, useRef } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { FieldDescription } from "@/components/shadcn/field";
import {
	exists,
	missing,
	type Predicate,
	type RelationPath,
} from "@/lib/domain/predicate";
import {
	CONDITION_SEED_UNAVAILABLE_REASON,
	firstConditionSeed,
} from "../conditionSeed";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	WithCurrentCaseType,
} from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendKindSlot, type EditorPath } from "../path";
import { RelationPathBuilder } from "../primitives/RelationPathBuilder";
import { resolveRelationDestination } from "../relationDestination";
import { relatedCasePathDefault } from "../relationSeed";
import { ChildPredicateEditor } from "./ChildPredicateEditor";

export function existsDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "exists" }> {
	return exists(relatedCasePathDefault(ctx));
}

export function missingDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "missing" }> {
	return missing(relatedCasePathDefault(ctx));
}

interface ExistsCardProps {
	readonly value: Extract<Predicate, { kind: "exists" | "missing" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function ExistsCard({ value, onChange, path }: ExistsCardProps) {
	const ctx = usePredicateEditContext();
	const operatorErrors = useEditorErrorsAt(path);
	const unavailableReasonId = useId();

	const setKind = (nextKind: "exists" | "missing") => {
		const builder = nextKind === "missing" ? missing : exists;
		onChange(builder(value.via, value.where));
	};

	const setVia = (next: RelationPath) => {
		const builder = value.kind === "missing" ? missing : exists;
		// Changing the connection must never destroy an authored condition.
		// If its property refs do not resolve in the new destination, the
		// checker keeps the exact tree visible with an inline repair finding.
		onChange(
			value.where === undefined ? builder(next) : builder(next, value.where),
		);
	};

	const setWhere = (next: Predicate | undefined) => {
		const builder = value.kind === "missing" ? missing : exists;
		onChange(
			next === undefined ? builder(value.via) : builder(value.via, next),
		);
	};

	// Resolve the destination case type from the relation path so
	// nested property pickers show the correct properties. Matches
	// the type checker's resolution rules — an unresolved walk
	// means the inner where can't be type-checked, but the editor
	// still allows authoring; the surfaced inline error tells the
	// user the walk is broken.
	const destinationCaseType = useMemo(
		() =>
			resolveRelationDestination(value.via, ctx.currentCaseType, ctx.caseTypes),
		[value.via, ctx.currentCaseType, ctx.caseTypes],
	);
	const whereSeed = useMemo(
		() =>
			destinationCaseType === undefined
				? undefined
				: firstConditionSeed({
						caseTypes: ctx.caseTypes,
						currentCaseType: destinationCaseType,
						knownInputs: ctx.knownInputs,
						// A relation walk's `where` always runs against the
						// destination case row, whatever the outer slot's scope.
						caseDataScope: "per-case",
					}),
		[destinationCaseType, ctx.caseTypes, ctx.knownInputs],
	);
	const addWhere = () => {
		if (whereSeed === undefined) return;
		setWhere(whereSeed);
	};
	const addWhereUnavailable =
		value.where === undefined && whereSeed === undefined;

	return (
		<div className="space-y-2">
			<div className="space-y-2">
				<KindMenu kind={value.kind} setKind={setKind} />
				<RelationPathBuilder
					value={value.via}
					onChange={setVia}
					invalid={operatorErrors.length > 0}
					allowSelf={false}
				/>
			</div>

			<div>
				<div className="mb-1 flex min-h-11 items-center justify-between gap-2">
					<div className="text-[13px] font-medium text-nova-text-secondary">
						Related case condition
					</div>
					<Button
						type="button"
						variant="ghost"
						size="xl"
						disabled={addWhereUnavailable}
						aria-describedby={
							addWhereUnavailable ? unavailableReasonId : undefined
						}
						onClick={() =>
							value.where === undefined ? addWhere() : setWhere(undefined)
						}
						className={`px-2 text-sm ${
							value.where === undefined
								? "text-nova-text-muted not-disabled:hover:text-nova-violet-bright"
								: "text-nova-rose not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose"
						}`}
					>
						{value.where === undefined ? "Add condition" : "Delete condition"}
					</Button>
				</div>
				{addWhereUnavailable ? (
					<FieldDescription
						id={unavailableReasonId}
						className="text-[13px] leading-relaxed text-nova-text-muted"
					>
						{CONDITION_SEED_UNAVAILABLE_REASON}
					</FieldDescription>
				) : null}
				{value.where !== undefined && destinationCaseType !== undefined && (
					<WithCurrentCaseType caseType={destinationCaseType}>
						<ChildPredicateEditor
							value={value.where}
							onChange={(next) => setWhere(next)}
							path={appendKindSlot(path, value.kind, "where")}
							variant="nested"
						/>
					</WithCurrentCaseType>
				)}
				{value.where !== undefined && destinationCaseType === undefined && (
					<div className="rounded-md border border-dashed border-white/[0.06] px-3 py-2 text-[13px] text-nova-text-muted">
						Choose a valid connection before adding a condition
					</div>
				)}
			</div>
		</div>
	);
}

function KindMenu({
	kind,
	setKind,
}: {
	readonly kind: "exists" | "missing";
	readonly setKind: (kind: "exists" | "missing") => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items: readonly {
		kind: "exists" | "missing";
		label: string;
		icon: IconifyIcon;
	}[] = [
		{ kind: "exists", label: "Has a related case", icon: tablerLink },
		{ kind: "missing", label: "Has no related case", icon: tablerUnlink },
	];
	const current = items.find((i) => i.kind === kind) ?? items[0];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`Related case requirement ${current.label}`}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="group gap-1.5 border-white/[0.06] bg-nova-deep/50 px-3 text-sm text-nova-violet-bright not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-deep/50 dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50 @max-md:justify-self-start"
					/>
				}
			>
				<Icon
					icon={current.icon}
					width="14"
					height="14"
					className="text-nova-violet-bright"
				/>
				<span>{current.label}</span>
				<Icon
					icon={tablerChevronDown}
					aria-hidden="true"
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
				>
					<DropdownMenuPopup>
						{items.map((it) => {
							const isActive = it.kind === kind;
							return (
								<DropdownMenuItem
									key={it.kind}
									onClick={() => setKind(it.kind)}
									className={
										isActive
											? "bg-nova-violet/10 text-nova-violet-bright"
											: undefined
									}
								>
									<Icon
										icon={it.icon}
										width="14"
										height="14"
										className={
											isActive
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}
									/>
									<span>{it.label}</span>
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}
