// components/builder/case-list-config/primitives/RelationPathBuilder.tsx
//
// Typed `RelationPath` composer. The data model carries the full
// AST shape (single-step + multi-hop ancestor walks, single-step
// subcase walks, direction-agnostic walks); this composer exposes
// the three load-bearing forms (`self`, single-step `ancestor`,
// single-step `subcase`) so authors compose the common case in one
// click. Multi-hop ancestor walks ride on the SA tool surface.
//
// The "kind" segment of the path is always picked first; the
// identifier slot reveals only when the kind expects one
// (`subcase` / `any-relation` / `ancestor`'s first step).

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerArrowsRight from "@iconify-icons/tabler/arrow-narrow-right";
import tablerHierarchy from "@iconify-icons/tabler/hierarchy";
import tablerLink from "@iconify-icons/tabler/link";
import { useId, useRef } from "react";
import {
	ancestorPath,
	type RelationPath,
	relationStep,
	selfPath,
	subcasePath,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";

interface RelationPathBuilderProps {
	readonly value: RelationPath;
	readonly onChange: (next: RelationPath) => void;
	readonly invalid?: boolean;
}

/** Picker state — collapses both `ancestor` and `any-relation` into
 *  one "ancestor" mode; the subcase mode covers reverse walks. */
type RelationKind = "self" | "ancestor" | "subcase";

function kindOf(path: RelationPath): RelationKind {
	switch (path.kind) {
		case "self":
			return "self";
		case "ancestor":
			return "ancestor";
		case "subcase":
		case "any-relation":
			return "subcase";
	}
}

function defaultIdentifier(kind: RelationKind): string {
	// CCHQ's most common index name is `parent`; pre-fill so the
	// editor doesn't surface an empty-identifier error on initial
	// kind switch.
	return kind === "ancestor" ? "parent" : "parent";
}

function buildRelation(kind: RelationKind, identifier: string): RelationPath {
	switch (kind) {
		case "self":
			return selfPath();
		case "ancestor":
			// Single-step ancestor walk — the structural common case
			// (most case-list filters reach `parent` via one hop).
			// Multi-hop walks live at the AST level for the SA tool
			// surface.
			return ancestorPath(relationStep(identifier));
		case "subcase":
			return subcasePath(identifier);
	}
}

function currentIdentifier(path: RelationPath): string {
	switch (path.kind) {
		case "self":
			return "";
		case "ancestor":
			return path.via[0]?.identifier ?? "parent";
		case "subcase":
		case "any-relation":
			return path.identifier;
	}
}

/**
 * Inline `RelationPath` composer. Two segments — kind picker
 * (Self / Ancestor / Subcase) and (when applicable) an identifier
 * input — laid out as a tight horizontal row.
 */
export function RelationPathBuilder({
	value,
	onChange,
	invalid = false,
}: RelationPathBuilderProps) {
	const kind = kindOf(value);
	const identifier = currentIdentifier(value);

	const setKind = (next: RelationKind) => {
		const ident = identifier === "" ? defaultIdentifier(next) : identifier;
		onChange(buildRelation(next, ident));
	};

	const setIdentifier = (next: string) => {
		onChange(buildRelation(kind, next));
	};

	return (
		<div className="flex items-center gap-2">
			<KindMenu kind={kind} setKind={setKind} />
			{kind !== "self" && (
				<>
					<Icon
						icon={kind === "subcase" ? tablerLink : tablerArrowsRight}
						width="14"
						height="14"
						className="text-nova-text-muted/60 shrink-0"
					/>
					<IdentifierInput
						value={identifier}
						onChange={setIdentifier}
						invalid={invalid}
					/>
				</>
			)}
		</div>
	);
}

function KindMenu({
	kind,
	setKind,
}: {
	readonly kind: RelationKind;
	readonly setKind: (kind: RelationKind) => void;
}) {
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const items: readonly {
		kind: RelationKind;
		label: string;
		icon: IconifyIcon;
		description: string;
	}[] = [
		{
			kind: "self",
			label: "Self",
			icon: tablerHierarchy,
			description: "No traversal — same case",
		},
		{
			kind: "ancestor",
			label: "Ancestor",
			icon: tablerHierarchy,
			description: "Walk up via the parent index",
		},
		{
			kind: "subcase",
			label: "Subcase",
			icon: tablerLink,
			description: "Walk down via the reverse index",
		},
	];
	const current = items.find((i) => i.kind === kind) ?? items[0];

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				id={triggerId}
				aria-label={`Relation kind: ${current.label}`}
				className="group flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<Icon
					icon={current.icon}
					width="14"
					height="14"
					className="text-nova-violet-bright/70"
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
									<span className="flex-1 text-left">
										<div>{it.label}</div>
										<div
											className={`text-[10px] ${
												isActive
													? "text-nova-violet-bright/60"
													: "text-nova-text-muted"
											}`}
										>
											{it.description}
										</div>
									</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function IdentifierInput({
	value,
	onChange,
	invalid,
}: {
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly invalid: boolean;
}) {
	const cls = [
		"w-32 px-2 py-1.5 text-xs rounded-md border bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 transition-colors font-mono",
		invalid
			? "border-nova-error/40 focus:border-nova-error/60 focus:ring-nova-error/30"
			: "border-white/[0.06] focus:border-nova-violet/40 focus:ring-nova-violet/30",
	].join(" ");
	return (
		<input
			type="text"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder="parent"
			aria-label="Relation index name"
			aria-invalid={invalid || undefined}
			autoComplete="off"
			data-1p-ignore
			className={cls}
		/>
	);
}
