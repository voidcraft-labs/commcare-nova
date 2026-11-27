// components/builder/shared/cards/expression/CountCard.tsx
//
// Renders the `count` Expression: relational aggregation. Two
// slots:
//
//   - `via`: `RelationPath` to walk along. Routes through the
//     shared `RelationPathBuilder` primitive so non-canonical walks
//     (multi-hop ancestor, qualified subcase, any-relation) remain
//     editable through the complete path builder.
//   - `where`: optional `Expression`. When present, the count is
//     filtered to related cases where the predicate holds. Routes
//     through `ChildPredicateEditor` so the full Expression-side
//     editor is reachable inline.
//
// Type-checker rules (per `checkExpression`'s `case "count":`):
//   - The `via` walk must resolve to a destination case type.
//   - The `where` clause type-checks in the destination scope (per
//     `checkInDestinationScope`).
//   - `via.kind === "self"` counts the current case (1, or 0/1 when
//     filtered) and is valid across the expression emitters.
//
// Path encoding: errors emit at `[..., "count"]` (operator-level,
// e.g. "missing scope"), `[..., "count", "via"]`, `[..., "count",
// "where"]`. Use `appendKind(path, "count")` for operator-level and
// `appendKindSlot(path, "count", slot)` for sub-slots.

"use client";

import { useId, useMemo } from "react";
import { Button } from "@/components/shadcn/button";
import { FieldDescription } from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	ancestorPath,
	count,
	type Expression,
	eq,
	isRelationPath,
	type RelationPath,
	relationStep,
	selfPath,
	subcasePath,
} from "@/lib/domain/expression";
import { expressionRowScope } from "@/lib/domain/expression/typeChecker";
import {
	CONDITION_SEED_UNAVAILABLE_REASON,
	relatedConditionSeed,
} from "../../conditionSeed";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	WithCurrentCaseType,
} from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendKind, appendKindSlot, type EditorPath } from "../../path";
import { InlineError } from "../../primitives/CardShell";
import { RelationPathBuilder } from "../../primitives/RelationPathBuilder";
import {
	relatedPathEditAdmission,
	replaceRelatedPath,
} from "../../relatedPathEdit";
import { resolveRelationDestination } from "../../relationDestination";
import { useStableListIdentity } from "../../useStableListIdentity";
import { PredicateFocusBoundary } from "../ChildPredicateEditor";

function menuCountSources(
	ctx: Pick<ExpressionEditContext, "expressionContext">,
) {
	const slot = ctx.expressionContext.slot.slot;
	return [
		"module_badge",
		"form_badge",
		"module_display_condition",
		"form_display_condition",
	].includes(slot);
}

function deviceCaseCountAvailable(
	ctx: Pick<ExpressionEditContext, "expressionContext">,
) {
	return (
		ctx.expressionContext.slot.slot === "search_button_display_condition" ||
		(menuCountSources(ctx) && ctx.expressionContext.profile.caseData)
	);
}

function typeRows(caseType: string): ExpressionOfKind<"cases"> {
	return {
		kind: "cases",
		source: "casedb",
		where: [eq({ kind: "case-row-type" }, { kind: "case-type", caseType })],
	};
}

export function hasCountableRelation(ctx: ExpressionEditContext): boolean {
	if (ctx.expressionContext.slot.slot === "search_input_required_when")
		return ctx.caseTypes.length > 0;
	const current = ctx.caseTypes.find(
		(caseType) => caseType.name === ctx.currentCaseType,
	);
	const hasParent =
		current?.parent_type !== undefined &&
		ctx.caseTypes.some((caseType) => caseType.name === current.parent_type);
	const hasChild = ctx.caseTypes.some(
		(caseType) => caseType.parent_type === ctx.currentCaseType,
	);
	return (
		hasParent ||
		hasChild ||
		deviceCaseCountAvailable(ctx) ||
		(menuCountSources(ctx) && Boolean(ctx.lookupTables?.length))
	);
}

/** Seed the first real catalog connection: parent first, then the first child.
 * A no-relation fallback remains valid for the total registry factory, but the
 * new-target menu disables Count in that scope with a specific explanation. */
export function countDefault(
	ctx: ExpressionEditContext,
): ExpressionOfKind<"count"> {
	if (ctx.expressionContext.slot.slot === "search_input_required_when") {
		const caseType =
			ctx.caseTypes.find((type) => type.name === ctx.currentCaseType) ??
			ctx.caseTypes[0];
		if (caseType !== undefined) return count(typeRows(caseType.name));
	}
	if (deviceCaseCountAvailable(ctx))
		return {
			kind: "count",
			via: { kind: "cases", source: "casedb", where: [] },
		};
	if (menuCountSources(ctx)) {
		const first = ctx.lookupTables?.[0];
		if (first)
			return {
				kind: "count",
				via: { kind: "table-rows", tableId: first.id, where: [] },
			};
	}
	const current = ctx.caseTypes.find(
		(caseType) => caseType.name === ctx.currentCaseType,
	);
	if (
		current?.parent_type !== undefined &&
		ctx.caseTypes.some((caseType) => caseType.name === current.parent_type)
	) {
		return count(ancestorPath(relationStep("parent")));
	}

	const child = ctx.caseTypes.find(
		(caseType) => caseType.parent_type === ctx.currentCaseType,
	);
	if (child !== undefined) {
		return count(subcasePath("parent", child.name));
	}

	return count(selfPath());
}

interface CountCardProps {
	readonly value: ExpressionOfKind<"count">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

/** The worker can count all restored cases, one case type, or a data table.
 * Conditions on the source rows stay alongside the source that binds them. */
function DeviceCountCard({
	value,
	onChange,
	path,
}: CountCardProps & {
	value: CountCardProps["value"] & {
		via: ExpressionOfKind<"cases"> | ExpressionOfKind<"table-rows">;
	};
}) {
	const ctx = usePredicateEditContext();
	const rows = value.via;
	const conditionIdentity = useStableListIdentity(rows.where);
	const kinds = ctx.caseTypes ?? [];
	const slot = ctx.expressionContext?.slot.slot;
	const isSearchButton = slot === "search_button_display_condition";
	const singleCaseType = slot === "search_input_required_when";
	const allCases = isSearchButton || ctx.expressionContext?.profile.caseData;
	const tables =
		isSearchButton || singleCaseType ? [] : (ctx.lookupTables ?? []);
	const options = [
		...(allCases && !singleCaseType
			? [
					{
						id: "all",
						label: "All cases on this device",
						rows: {
							kind: "cases" as const,
							source: "casedb" as const,
							where: [],
						},
					},
				]
			: []),
		...(allCases || singleCaseType
			? kinds.map((type) => ({
					id: `case:${type.name}`,
					label: type.name,
					rows: typeRows(type.name),
				}))
			: []),
		...tables.map((table) => ({
			id: `table:${table.id}`,
			label: table.name,
			rows: { kind: "table-rows" as const, tableId: table.id, where: [] },
		})),
	];
	const scope =
		ctx.expressionContext && expressionRowScope(rows, ctx.expressionContext);
	const sourceId =
		rows.kind === "table-rows"
			? `table:${rows.tableId}`
			: scope?.kind === "case" && scope.caseType
				? `case:${scope.caseType}`
				: "all";
	const chosen = options.find((option) => option.id === sourceId);
	const setRows = (
		where: Expression[],
		edit: Parameters<typeof conditionIdentity.stage>[1],
	) => {
		conditionIdentity.stage(where, edit);
		onChange({ ...value, via: { ...rows, where } });
	};
	return (
		<div className="space-y-2">
			<Select
				value={chosen?.id ?? ""}
				onValueChange={(id) => {
					const next = options.find((option) => option.id === id);
					if (!next) return;
					conditionIdentity.stage(next.rows.where, { kind: "replace" });
					onChange({ ...value, via: next.rows });
				}}
			>
				<SelectTrigger aria-label="Records to count">
					<SelectValue>{chosen?.label ?? "Choose records"}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.id} value={option.id}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{!singleCaseType && (
				<>
					{rows.where.map((condition, index) => (
						<div key={conditionIdentity.keys[index]}>
							<PredicateFocusBoundary
								value={condition}
								path={[...path, "count", "via", rows.kind, "where", index]}
								onChange={(next) =>
									setRows(
										rows.where.map((old, i) => (index === i ? next : old)),
										{ kind: "replace" },
									)
								}
							/>
							<Button
								type="button"
								variant="ghost"
								onClick={() =>
									setRows(
										rows.where.filter((_, i) => i !== index),
										{ kind: "splice", index, deleteCount: 1, insertCount: 0 },
									)
								}
							>
								Remove condition
							</Button>
						</div>
					))}
					<Button
						type="button"
						variant="ghost"
						onClick={() =>
							setRows([...rows.where, { kind: "match-all" }], {
								kind: "splice",
								index: rows.where.length,
								deleteCount: 0,
								insertCount: 1,
							})
						}
					>
						Add condition
					</Button>
				</>
			)}
		</div>
	);
}

export function CountCard(props: CountCardProps) {
	if (
		props.value.via.kind === "table-rows" ||
		(props.value.via.kind === "cases" && props.value.via.source === "casedb")
	)
		return (
			<DeviceCountCard
				{...props}
				value={{ ...props.value, via: props.value.via }}
			/>
		);
	if (!isRelationPath(props.value.via))
		return (
			<p role="status">This saved expression cannot be edited here yet.</p>
		);
	return (
		<EditableCountCard
			{...props}
			value={{ ...props.value, via: props.value.via }}
		/>
	);
}

function EditableCountCard({
	value,
	onChange,
	path,
}: CountCardProps & {
	readonly value: CountCardProps["value"] & { readonly via: RelationPath };
}) {
	const ctx = usePredicateEditContext();
	const operatorErrors = useEditorErrorsAt(appendKind(path, "count"));
	const viaErrors = useEditorErrorsAt(appendKindSlot(path, "count", "via"));
	const unavailableReasonId = useId();

	const admitVia = (next: RelationPath) => {
		const local = relatedPathEditAdmission(value, next, ctx);
		return local.admitted
			? (ctx.admitExpressionChange?.(path, replaceRelatedPath(value, next)) ??
					local)
			: local;
	};
	const setVia = (next: RelationPath) => {
		if (admitVia(next).admitted) onChange(replaceRelatedPath(value, next));
	};

	const setWhere = (next: Expression | undefined) => {
		// `count` builder's absent-not-undefined contract: passing
		// undefined produces `{ kind: "count", via }` with no `where`
		// key (rather than `where: undefined`), matching the schema's
		// `.optional()` strip behavior on parse.
		onChange(next === undefined ? count(value.via) : count(value.via, next));
	};

	// Resolve the destination case type from the relation path so
	// nested property pickers in the `where` clause show the
	// destination's properties. Same shared helper drives the
	// destination resolution in `ExistsCard`.
	const destinationCaseType = useMemo(
		() =>
			resolveRelationDestination(value.via, ctx.currentCaseType, ctx.caseTypes),
		[value.via, ctx.currentCaseType, ctx.caseTypes],
	);
	const whereSeed = useMemo(
		() => relatedConditionSeed(ctx, destinationCaseType, value.via),
		[ctx, destinationCaseType, value.via],
	);
	const addWhere = () => {
		if (whereSeed === undefined) return;
		setWhere(whereSeed);
	};
	const addWhereUnavailable =
		value.where === undefined && whereSeed === undefined;

	return (
		<div className="space-y-2">
			<div>
				<RelationPathBuilder
					value={value.via}
					onChange={setVia}
					admitChange={admitVia}
					invalid={operatorErrors.length > 0 || viaErrors.length > 0}
					allowSelf
				/>
				<InlineError errors={viaErrors} />
				{operatorErrors.length > 0 && <InlineError errors={operatorErrors} />}
			</div>

			<div className="space-y-1.5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<p className="text-[13px] font-medium text-nova-text-secondary">
							Cases to count
						</p>
						<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-muted">
							Without a condition, every case on this connection is counted
						</p>
					</div>
					<Button
						type="button"
						variant="ghost"
						disabled={addWhereUnavailable}
						aria-describedby={
							addWhereUnavailable ? unavailableReasonId : undefined
						}
						onClick={() =>
							value.where === undefined ? addWhere() : setWhere(undefined)
						}
						className={
							value.where === undefined
								? "text-nova-text-secondary"
								: "text-nova-rose not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose"
						}
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
						<PredicateFocusBoundary
							value={value.where}
							onChange={(next) => setWhere(next)}
							path={appendKindSlot(path, "count", "where")}
							variant="nested"
						/>
					</WithCurrentCaseType>
				)}
				{value.where !== undefined && destinationCaseType === undefined && (
					<div className="rounded-lg border border-dashed border-white/[0.06] px-3 py-2 text-[13px] text-nova-text-muted">
						Pick a valid connection before narrowing it with a condition
					</div>
				)}
			</div>
		</div>
	);
}
