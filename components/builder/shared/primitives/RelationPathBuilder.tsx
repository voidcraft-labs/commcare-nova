// components/builder/shared/primitives/RelationPathBuilder.tsx
//
// Typed `RelationPath` composer.
//
// Authoring vocabulary: this composer EDITS the three canonical
// shapes — `selfPath()`, single-step `ancestorPath(relationStep(id))`,
// and `subcasePath(id)` (with no `ofCaseType` qualifier). Authors
// compose the common case in one click.
//
// Round-trip contract: the `RelationPath` schema admits more
// shapes than the composer produces — multi-hop ancestor walks
// (`ancestorPath(stepA, stepB, ...)`), `any-relation` (the
// direction-agnostic discriminator), and `subcase` /
// `any-relation` walks with an `ofCaseType` qualifier. When the
// composer receives a non-canonical shape, it renders a read-only
// badge ("Multi-hop ancestor", "Direction-agnostic", "Qualified
// subcase") plus an explicit "Replace" affordance. No `onChange`
// fires until the user clicks Replace, at which point the path
// resets to a canonical `ancestorPath(relationStep("parent"))`.
// Any caller producing a higher-fidelity walk at this slot — every
// other consumer that emits relation paths into the AST — mounts
// the editor over its output and saves without silent destruction.

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

/** Picker state — only the three canonical shapes the composer
 *  produces. Non-canonical input shapes (multi-hop ancestor,
 *  any-relation, subcase-with-ofCaseType) route through the
 *  read-only badge instead of this enum. */
type RelationKind = "self" | "ancestor" | "subcase";

/** CCHQ's most common index name is `parent` for both ancestor
 *  and subcase walks; pre-fill so the editor doesn't surface an
 *  empty-identifier error on initial kind switch. */
const DEFAULT_IDENTIFIER = "parent";

function buildRelation(kind: RelationKind, identifier: string): RelationPath {
	switch (kind) {
		case "self":
			return selfPath();
		case "ancestor":
			// Single-step ancestor walk — the canonical authoring
			// shape. Multi-hop walks live at the AST level and route
			// through the read-only badge.
			return ancestorPath(relationStep(identifier));
		case "subcase":
			return subcasePath(identifier);
	}
}

/** Categorize the incoming `RelationPath` against the composer's
 *  edit-vs-read-only contract. Returns either the matching
 *  canonical kind (the composer renders the picker + identifier
 *  input) or the badge label that names the non-canonical shape
 *  (the composer renders read-only with a Replace affordance). */
type PathClassification =
	| { readonly kind: "canonical"; readonly canonical: RelationKind }
	| { readonly kind: "badge"; readonly label: string };

function classify(path: RelationPath): PathClassification {
	switch (path.kind) {
		case "self":
			return { kind: "canonical", canonical: "self" };
		case "ancestor":
			// Multi-hop ancestor walks (>1 step) and steps carrying a
			// `throughCaseType` qualifier are non-canonical for this
			// composer.
			if (path.via.length === 1 && path.via[0].throughCaseType === undefined) {
				return { kind: "canonical", canonical: "ancestor" };
			}
			return {
				kind: "badge",
				label:
					path.via.length > 1
						? "Multi-hop ancestor walk"
						: "Qualified ancestor walk",
			};
		case "subcase":
			// `subcase` with an `ofCaseType` qualifier is non-canonical
			// — the composer's identifier input doesn't surface the
			// qualifier slot, so editing in place would silently drop
			// it.
			if (path.ofCaseType === undefined) {
				return { kind: "canonical", canonical: "subcase" };
			}
			return { kind: "badge", label: "Qualified subcase walk" };
		case "any-relation":
			// `any-relation` is structurally distinct from `subcase` at
			// the wire-emission boundary — collapsing it onto the
			// composer's `subcase` mode would flip the discriminator.
			return { kind: "badge", label: "Direction-agnostic walk" };
	}
}

function canonicalIdentifier(path: RelationPath): string {
	switch (path.kind) {
		case "self":
			return "";
		case "ancestor":
			// Only reached for canonical (single-step) ancestor walks;
			// the badge branch handles multi-hop.
			return path.via[0].identifier;
		case "subcase":
			return path.identifier;
		case "any-relation":
			// Unreachable — the badge branch handles `any-relation`.
			return path.identifier;
	}
}

/**
 * Inline `RelationPath` composer. Renders one of two surfaces:
 *
 *   1. **Canonical** — kind picker (Self / Ancestor / Subcase) +
 *      (when applicable) an identifier input. Tight horizontal
 *      row.
 *   2. **Non-canonical** — read-only badge with a Replace
 *      affordance. Surfaced when the incoming path carries
 *      structure the composer can't faithfully edit (multi-hop
 *      ancestor walks, qualified ancestor / subcase, `any-relation`).
 *      Replace overwrites the slot with a canonical
 *      `ancestorPath(relationStep("parent"))`.
 */
export function RelationPathBuilder({
	value,
	onChange,
	invalid = false,
}: RelationPathBuilderProps) {
	const classification = classify(value);

	if (classification.kind === "badge") {
		return (
			<NonCanonicalBadge
				label={classification.label}
				onReplace={() =>
					onChange(ancestorPath(relationStep(DEFAULT_IDENTIFIER)))
				}
			/>
		);
	}

	const canonical = classification.canonical;
	const identifier = canonicalIdentifier(value);

	const setKind = (next: RelationKind) => {
		const ident = identifier === "" ? DEFAULT_IDENTIFIER : identifier;
		onChange(buildRelation(next, ident));
	};

	const setIdentifier = (next: string) => {
		onChange(buildRelation(canonical, next));
	};

	return (
		<div className="flex items-center gap-2">
			<KindMenu kind={canonical} setKind={setKind} />
			{canonical !== "self" && (
				<>
					<Icon
						icon={canonical === "subcase" ? tablerLink : tablerArrowsRight}
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

/**
 * Read-only badge rendered when the composer receives a non-
 * canonical `RelationPath` shape (multi-hop ancestor walks,
 * qualified ancestor / subcase, `any-relation`). The label names
 * the shape so authors know what they have; Replace overwrites
 * the slot only on explicit click. The badge does not call
 * `onChange` on mount or render.
 */
function NonCanonicalBadge({
	label,
	onReplace,
}: {
	readonly label: string;
	readonly onReplace: () => void;
}) {
	return (
		<div className="flex items-center gap-2 px-2 py-1.5 text-xs rounded-md border border-dashed border-white/[0.10] bg-nova-deep/30">
			<span className="text-nova-text-muted shrink-0">Relation:</span>
			<span className="font-mono text-nova-violet-bright/80 truncate">
				{label}
			</span>
			<div className="flex-1" />
			<button
				type="button"
				onClick={onReplace}
				className="text-[10px] uppercase tracking-wider text-nova-text-muted/70 hover:text-nova-violet-bright transition-colors cursor-pointer"
			>
				Replace
			</button>
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
