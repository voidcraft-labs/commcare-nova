// components/builder/shared/primitives/PatternSourceMenu.tsx
//
// The pattern's source menu for `matches-pattern` and `format-date`: a
// written pattern or a calculated one. Each choice is judged by the whole
// rule's verdict, so a source the gate refuses is disabled with its reason.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAbc from "@iconify-icons/tabler/abc";
import tablerCalculator from "@iconify-icons/tabler/calculator";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { useId, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import type { ExpressionChangeAdmission } from "../editorContext";
import {
	PATTERN_SOURCE_LABELS,
	type PatternSource,
} from "../patternSourceModel";

const SOURCE_ICONS = { text: tablerAbc, calculated: tablerCalculator } as const;
const SOURCES: readonly PatternSource[] = ["text", "calculated"];

export function PatternSourceMenu({
	source,
	admission,
	onSelect,
	label,
	replaces,
}: {
	readonly source: PatternSource;
	readonly admission: Readonly<
		Record<PatternSource, ExpressionChangeAdmission>
	>;
	readonly onSelect: (source: PatternSource) => void;
	/** What the pattern is called on the card, for the trigger's name. */
	readonly label: string;
	/** What choosing `source` would discard, if anything: a sentence such
	 *  as "the calculated pattern". The choice then asks first. */
	readonly replaces?: (source: PatternSource) => string | undefined;
}) {
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [pending, setPending] = useState<{
		readonly source: PatternSource;
		readonly replaced: string;
	} | null>(null);
	const choose = (next: PatternSource) => {
		if (next === source) return;
		const replaced = replaces?.(next);
		if (replaced === undefined) onSelect(next);
		else setPending({ source: next, replaced });
	};
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={triggerRef}
					id={triggerId}
					aria-label={`${label} source: ${PATTERN_SOURCE_LABELS[source]}`}
					render={
						<Button
							type="button"
							variant="field"
							className="group justify-start"
						/>
					}
				>
					<Icon
						icon={SOURCE_ICONS[source]}
						width="14"
						height="14"
						className="text-nova-violet-bright"
					/>
					<span>{PATTERN_SOURCE_LABELS[source]}</span>
					<Icon
						icon={tablerChevronDown}
						width="14"
						height="14"
						className="ml-auto shrink-0 transition-transform group-data-[popup-open]:rotate-180"
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
							<DropdownMenuRadioGroup
								value={source}
								onValueChange={(next) => choose(next as PatternSource)}
							>
								{SOURCES.map((item) => {
									const verdict = admission[item];
									const isActive = item === source;
									return (
										<DropdownMenuRadioItem
											key={item}
											value={item}
											disabled={!verdict.admitted}
											closeOnClick
											className={
												isActive
													? "bg-nova-violet/10 text-nova-violet-bright"
													: ""
											}
										>
											<Icon
												icon={SOURCE_ICONS[item]}
												width="14"
												height="14"
												className={
													isActive
														? "text-nova-violet-bright"
														: "text-nova-text-muted"
												}
											/>
											<span className="flex-1 text-left min-w-0">
												<span className="block break-words">
													{PATTERN_SOURCE_LABELS[item]}
												</span>
												{verdict.admitted === false && (
													<span className="block break-words text-xs text-nova-text-muted">
														{verdict.reason}
													</span>
												)}
											</span>
										</DropdownMenuRadioItem>
									);
								})}
							</DropdownMenuRadioGroup>
						</DropdownMenuPopup>
					</DropdownMenuPositioner>
				</DropdownMenuPortal>
			</DropdownMenu>
			<AlertDialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) setPending(null);
				}}
			>
				<AlertDialogContent finalFocus={triggerRef} className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{pending === null
								? null
								: `Use ${PATTERN_SOURCE_LABELS[pending.source].replace(/^./, (letter) => letter.toLocaleLowerCase())} instead?`}
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left">
							{pending === null
								? null
								: `This replaces ${pending.replaced}. You can undo this change.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (pending !== null) onSelect(pending.source);
								setPending(null);
							}}
						>
							Replace
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
