// components/builder/case-operations/CaseOperationLinks.tsx
//
// How a change connects its case to another one — and how it breaks a
// connection.
//
// The wire calls this an index and the platform's own UI calls it
// "Link / Unlink"; both name the mechanism. An author is deciding
// something about their data ("this referral belongs to this client"),
// so the surface asks about relationships and treats unlinking as a
// target choice rather than a separate mode, which is also exactly what
// the wire does — an empty target removes the connection.
//
// The two relationship kinds are genuinely different and an author has
// to be able to tell them apart, so each states its consequence rather
// than its name: a child belongs to its parent, while an extension
// rides along with its host and is closed with it.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useMemo, useRef, useState } from "react";
import { CaseTypePicker } from "@/components/builder/shared/CaseTypePicker";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { FieldError } from "@/components/shadcn/field";
import { caseOperationLinkIdentifierVerdict } from "@/lib/doc/identifierVerdicts";
import type { CaseOperation, CaseOperationLink } from "@/lib/domain";
import { CaseTargetPicker, type TargetChoiceContext } from "./CaseTargetPicker";

/** What a LINK's target picker needs: everything but the two axes the link
 *  itself fixes (never a new case, always able to unlink). */
type LinkTargetContext = Omit<TargetChoiceContext, "newOnly" | "allowsNone">;

import { nextLinkIdentifier, seedCaseOperationLink } from "./seeds";

const RELATIONSHIP_LABEL = {
	child: "Belongs to that case",
	extension: "Rides along with that case",
} as const;

const RELATIONSHIP_DETAIL = {
	child: "The connected case is this one's parent. Ordinary ownership.",
	extension:
		"The case travels wherever its host does, and closing the host closes it too.",
} as const;

export function CaseOperationLinks({
	operation,
	targetContext,
	defaultTargetType,
	canEdit,
	onChange,
}: {
	readonly operation: CaseOperation;
	readonly targetContext: LinkTargetContext;
	/** The case type at the other end of a fresh connection — the module's,
	 *  not this change's. Defaulting to the change's own type would make the
	 *  next click a mismatch the author never asked for. */
	readonly defaultTargetType: string;
	readonly canEdit: boolean;
	/** The stored slot is a mutable array, so the callback hands one back
	 *  rather than a readonly view the document could not hold. */
	readonly onChange: (links: CaseOperationLink[] | undefined) => void;
}) {
	const links = operation.links ?? [];
	const identifiers = useMemo(
		() => new Set(links.map((link) => link.identifier)),
		[links],
	);

	const replace = (index: number, next: CaseOperationLink) =>
		onChange(links.map((link, i) => (i === index ? next : link)));

	return (
		<div className="space-y-3">
			{links.map((link, index) => (
				<LinkRow
					key={link.identifier}
					link={link}
					siblings={identifiers}
					targetContext={targetContext}
					canEdit={canEdit}
					onChange={(next) => replace(index, next)}
					onRemove={() => {
						const remaining = links.filter((_, i) => i !== index);
						onChange(remaining.length === 0 ? undefined : remaining);
					}}
				/>
			))}
			{canEdit && (
				<Button
					type="button"
					variant="outline"
					size="xl"
					data-case-operation-add-link
					onClick={() =>
						onChange([
							...links,
							seedCaseOperationLink(
								nextLinkIdentifier(identifiers),
								defaultTargetType,
							),
						])
					}
					className="min-h-11 w-full gap-2 rounded-lg border-dashed border-nova-border-bright bg-transparent px-4 text-sm text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.06] dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.06]"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					<span className="flex-1 text-left">Connect to another case</span>
				</Button>
			)}
		</div>
	);
}

function LinkRow({
	link,
	siblings,
	targetContext,
	canEdit,
	onChange,
	onRemove,
}: {
	readonly link: CaseOperationLink;
	readonly siblings: ReadonlySet<string>;
	readonly targetContext: LinkTargetContext;
	readonly canEdit: boolean;
	readonly onChange: (next: CaseOperationLink) => void;
	readonly onRemove: () => void;
}) {
	const [rejection, setRejection] = useState<string | undefined>(undefined);
	const taken = useMemo(() => {
		const others = new Set(siblings);
		others.delete(link.identifier);
		return others;
	}, [siblings, link.identifier]);

	return (
		<div className="space-y-3 rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3 @sm:p-4">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0 flex-1 space-y-1.5">
					<p className="text-[13px] font-medium text-nova-text-secondary">
						What this connection is called
					</p>
					{canEdit ? (
						<BlurCommitTextInput
							value={link.identifier}
							ariaLabel="Name of this connection"
							onCommit={(next) => {
								const verdict = caseOperationLinkIdentifierVerdict(next, taken);
								if (!verdict.ok) {
									setRejection(verdict.userMessage);
									return;
								}
								setRejection(undefined);
								onChange({ ...link, identifier: next.trim() });
							}}
						/>
					) : (
						<p className="text-[14px] text-nova-text">{link.identifier}</p>
					)}
					{rejection !== undefined && (
						<FieldError className="text-[13px] text-nova-rose">
							{rejection}
						</FieldError>
					)}
				</div>
				{canEdit && (
					<Button
						type="button"
						variant="ghost"
						size="xl"
						onClick={onRemove}
						className="px-3 text-sm text-nova-rose not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose"
					>
						<Icon icon={tablerTrash} width="14" height="14" />
						Remove
					</Button>
				)}
			</div>

			<div className="space-y-1.5">
				<p className="text-[13px] font-medium text-nova-text-secondary">
					Connect to
				</p>
				<CaseTargetPicker
					value={link.target}
					ariaLabel="Connect to"
					context={{ ...targetContext, newOnly: false, allowsNone: true }}
					onChange={(target) => onChange({ ...link, target })}
				/>
				{link.target === null && (
					<p className="text-[13px] leading-relaxed text-nova-text-muted">
						Submitting this form breaks the “{link.identifier}” connection
						instead of making one.
					</p>
				)}
			</div>

			<div className="space-y-1.5">
				<p className="text-[13px] font-medium text-nova-text-secondary">
					Kind of case at the other end
				</p>
				<CaseTypePicker
					value={link.targetType}
					ariaLabel="Kind of case at the other end"
					onChange={(targetType) => onChange({ ...link, targetType })}
				/>
			</div>

			<div className="space-y-1.5">
				<p className="text-[13px] font-medium text-nova-text-secondary">
					How they are related
				</p>
				<RelationshipMenu
					value={link.relationship}
					canEdit={canEdit}
					onChange={(relationship) => onChange({ ...link, relationship })}
				/>
			</div>
		</div>
	);
}

function RelationshipMenu({
	value,
	canEdit,
	onChange,
}: {
	readonly value: CaseOperationLink["relationship"];
	readonly canEdit: boolean;
	readonly onChange: (next: CaseOperationLink["relationship"]) => void;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				disabled={!canEdit}
				aria-label={`How they are related: ${RELATIONSHIP_LABEL[value]}`}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className="group h-auto min-h-11 w-full justify-between rounded-lg border border-white/[0.06] bg-nova-deep/50 px-3 py-2 text-sm whitespace-normal not-disabled:hover:border-nova-violet/30 dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50"
					/>
				}
			>
				<span className="min-w-0 flex-1 break-words text-left text-nova-violet-bright">
					{RELATIONSHIP_LABEL[value]}
				</span>
				<Icon
					icon={tablerChevronDown}
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
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<DropdownMenuPopup className="min-w-0">
						{(["child", "extension"] as const).map((relationship) => (
							<DropdownMenuItem
								key={relationship}
								onClick={() => onChange(relationship)}
								className={
									relationship === value
										? "bg-nova-violet/10 text-nova-violet-bright"
										: ""
								}
							>
								<span className="min-w-0 flex-1 text-left">
									<span className="block break-words">
										{RELATIONSHIP_LABEL[relationship]}
									</span>
									<span className="block break-words text-xs text-nova-text-muted">
										{RELATIONSHIP_DETAIL[relationship]}
									</span>
								</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}
