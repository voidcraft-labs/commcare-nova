// components/builder/shared/CaseTypeValuePicker.tsx
//
// A case type picked as a value: the object of a comparison whose subject is
// "Case type" (`case-row-type`), stored as a `case-type` leaf. It lists the
// app's existing case types, the ones the compared row can be first, and
// never creates one: a comparison names a type the app already has. It is
// separate from `CaseTypePicker.tsx`, the module case-type picker with
// create-new, which it neither reuses nor changes.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerCategory from "@iconify-icons/tabler/category";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { Fragment, useRef } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { caseTypeValueGroups, caseTypeValueLabel } from "./caseTypeValueModel";
import type { ExpressionChangeAdmission } from "./editorContext";

interface CaseTypeValuePickerProps {
	/** The stored case type, or undefined while none is chosen. */
	readonly value: string | undefined;
	readonly onChange: (caseType: string) => void;
	/** Every case type of the app, in catalog order. */
	readonly caseTypes: readonly string[];
	/** The types the compared row can be, listed first. */
	readonly possible: readonly string[];
	/** Whole-rule verdict for one choice. */
	readonly admit?: (caseType: string) => ExpressionChangeAdmission;
	readonly invalid?: boolean;
}

export function CaseTypeValuePicker({
	value,
	onChange,
	caseTypes,
	possible,
	admit,
	invalid = false,
}: CaseTypeValuePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const groups = caseTypeValueGroups(caseTypes, possible);
	const known = value !== undefined && caseTypes.includes(value);
	const label =
		value === undefined
			? "Choose a case type"
			: known
				? caseTypeValueLabel(value, caseTypes)
				: "Unavailable case type";
	const sections = [
		{ key: "likely", title: "Types this case can be", names: groups.likely },
		{ key: "others", title: "Other case types", names: groups.others },
	].filter((section) => section.names.length > 0);
	const triggerClass = [
		"group min-h-11 w-full justify-between rounded-lg border bg-nova-deep/50 px-3 text-sm text-nova-text dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50",
		invalid || (value !== undefined && !known)
			? "border-nova-rose/40"
			: "border-white/[0.06] not-disabled:hover:border-nova-violet/30",
	].join(" ");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`Case type to compare with: ${label}`}
				aria-invalid={invalid || undefined}
				render={
					<Button type="button" variant="outline" className={triggerClass} />
				}
			>
				<span className="flex min-w-0 items-center gap-1.5">
					<Icon
						icon={tablerCategory}
						width="14"
						height="14"
						className={
							known ? "text-nova-violet-bright" : "text-nova-text-muted"
						}
					/>
					<span
						className={`break-words ${known ? "text-nova-violet-bright" : "text-nova-text-muted"}`}
					>
						{label}
					</span>
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
					style={{ minWidth: "var(--anchor-width)", maxHeight: 360 }}
				>
					<DropdownMenuPopup className="max-h-80 min-w-0 overflow-y-auto">
						{caseTypes.length === 0 ? (
							<div className="px-3 py-4 text-center text-[13px] leading-5 text-nova-text-muted">
								This app has no case types yet
							</div>
						) : null}
						{sections.map((section, index) => (
							<Fragment key={section.key}>
								{sections.length > 1 ? (
									<div
										className={`px-3 pt-2.5 pb-1 text-xs font-medium text-nova-text-muted ${index > 0 ? "mt-1 border-t border-white/[0.06]" : ""}`}
										role="presentation"
									>
										{section.title}
									</div>
								) : null}
								{section.names.map((name) => {
									const isActive = name === value;
									const verdict = admit?.(name) ?? { admitted: true as const };
									return (
										<DropdownMenuItem
											key={name}
											disabled={!verdict.admitted}
											onClick={() => onChange(name)}
											className={
												isActive
													? "bg-nova-violet/10 text-nova-violet-bright"
													: ""
											}
										>
											<span className="min-w-0 flex-1 text-left">
												<span className="block break-words">
													{caseTypeValueLabel(name, caseTypes)}
												</span>
												{verdict.admitted === false ? (
													<span className="block break-words text-xs text-nova-text-muted">
														{verdict.reason}
													</span>
												) : null}
											</span>
											{isActive && (
												<Icon
													icon={tablerCheck}
													width="14"
													height="14"
													className="shrink-0 text-nova-violet-bright"
												/>
											)}
										</DropdownMenuItem>
									);
								})}
							</Fragment>
						))}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}
