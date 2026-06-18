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
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerLink from "@iconify-icons/tabler/link";
import tablerUnlink from "@iconify-icons/tabler/unlink";
import { useMemo, useRef } from "react";
import {
	ancestorPath,
	exists,
	matchAll,
	missing,
	type Predicate,
	type RelationPath,
	relationStep,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import {
	useEditorErrorsAt,
	usePredicateEditContext,
	WithCurrentCaseType,
} from "../editorContext";
import { appendKindSlot, type EditorPath } from "../path";
import { RelationPathBuilder } from "../primitives/RelationPathBuilder";
import { resolveRelationDestination } from "../relationDestination";
import { ChildPredicateEditor } from "./ChildPredicateEditor";
import { rescopeWhereForVia } from "./reseed";

export function existsDefault(): Extract<Predicate, { kind: "exists" }> {
	// Default to a single-step ancestor walk via `parent` — the
	// CommCare-canonical relation. Authors who need a different
	// shape pivot via the relation-path picker.
	return exists(ancestorPath(relationStep("parent")));
}

export function missingDefault(): Extract<Predicate, { kind: "missing" }> {
	return missing(ancestorPath(relationStep("parent")));
}

interface ExistsCardProps {
	readonly value: Extract<Predicate, { kind: "exists" | "missing" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function ExistsCard({ value, onChange, path }: ExistsCardProps) {
	const ctx = usePredicateEditContext();
	const operatorErrors = useEditorErrorsAt(path);

	const setKind = (nextKind: "exists" | "missing") => {
		const builder = nextKind === "missing" ? missing : exists;
		onChange(builder(value.via, value.where));
	};

	const setVia = (next: RelationPath) => {
		const builder = value.kind === "missing" ? missing : exists;
		// A new walk can change the destination scope; a `where` whose
		// property refs no longer resolve there resets to `matchAll()`
		// in the same onChange so the committed quantifier stays sound.
		const where = rescopeWhereForVia(value.where, next, ctx);
		onChange(where === undefined ? builder(next) : builder(next, where));
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

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[auto_1fr] gap-2 items-start">
				<KindMenu kind={value.kind} setKind={setKind} />
				<div>
					<div className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-1">
						Connection
					</div>
					<RelationPathBuilder
						value={value.via}
						onChange={setVia}
						invalid={operatorErrors.length > 0}
					/>
				</div>
			</div>

			<div>
				<div className="flex items-center justify-between mb-1">
					<div className="text-[10px] text-nova-text-muted uppercase tracking-wider">
						Where (optional)
					</div>
					<button
						type="button"
						onClick={() =>
							setWhere(value.where === undefined ? matchAll() : undefined)
						}
						className="min-h-11 px-2 text-[10px] uppercase tracking-wider text-nova-text-muted hover:text-nova-violet-bright transition-colors cursor-pointer"
					>
						{value.where === undefined ? "+ Add filter" : "Remove filter"}
					</button>
				</div>
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
					<div className="text-[11px] text-nova-text-muted italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06]">
						Pick a valid connection before narrowing it with a condition.
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
		{ kind: "exists", label: "Has", icon: tablerLink },
		{ kind: "missing", label: "No", icon: tablerUnlink },
	];
	const current = items.find((i) => i.kind === kind) ?? items[0];

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Quantifier: ${current.label}`}
				className="group flex items-center gap-1.5 px-3 min-h-11 text-[13px] rounded-lg border border-white/[0.06] bg-nova-deep/50 text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer @max-md:justify-self-start"
			>
				<Icon
					icon={current.icon}
					width="14"
					height="14"
					className="text-nova-violet-bright"
				/>
				<span>{current.label}</span>
				<svg
					aria-hidden="true"
					width="10"
					height="10"
					viewBox="0 0 10 10"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.2"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{items.map((it, i) => {
							const isActive = it.kind === kind;
							const last = items.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							return (
								<Menu.Item
									key={it.kind}
									onClick={() => setKind(it.kind)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
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
									<span>{it.label} a related case</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
