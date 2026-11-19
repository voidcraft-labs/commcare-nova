// components/preview/shared/CaseListSortMenu.tsx
//
// The running case list's Sort by. It draws the entries the platform Preview
// plays lists (`lib/preview/caseListSortMenu.ts::caseListSortOptions`) with
// their arrows and numbers, and hands a pick back; what a pick does to the
// order is the model's, and the rows come back ordered by the case store.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerArrowsSort from "@iconify-icons/tabler/arrows-sort";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import type { CaseListSortOption } from "@/lib/preview/caseListSortMenu";
import { useWorkerMessage } from "./WorkerText";

export function CaseListSortMenu({
	options,
	nameOf,
	onPick,
}: {
	readonly options: readonly CaseListSortOption[];
	/** The name an entry shows where the device shows none: the name the
	 *  list gives its column. */
	readonly nameOf: (option: CaseListSortOption) => string;
	readonly onPick: (column: string) => void;
}) {
	const message = useWorkerMessage();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				data-case-list-sort
				render={<Button type="button" variant="outline" className="shrink-0" />}
			>
				<Icon icon={tablerArrowsSort} width="16" height="16" />
				{message("sortBy")}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" preferredMinWidth="14rem">
				{options.map((option) => {
					const name = option.name.trim() === "" ? nameOf(option) : option.name;
					const marks = [
						...(option.priority === undefined
							? []
							: [
									message("sortPriority", {
										priority: option.priority.toLocaleString(),
									}),
								]),
						...(option.arrow === undefined
							? []
							: [message(option.arrow === "up" ? "sortedUp" : "sortedDown")]),
					];
					return (
						<DropdownMenuItem
							key={option.column.uuid}
							data-case-list-sort-option={option.column.uuid}
							aria-label={[name, ...marks].join(", ")}
							onClick={() => onPick(option.column.uuid)}
						>
							<span className="flex w-full min-w-0 items-center justify-between gap-3">
								<span className="min-w-0 break-words [overflow-wrap:anywhere]">
									{name}
								</span>
								{(option.priority !== undefined ||
									option.arrow !== undefined) && (
									<span
										aria-hidden="true"
										className="flex shrink-0 items-center gap-1 text-xs text-nova-text-muted"
									>
										{option.priority !== undefined && (
											<span>{option.priority.toLocaleString()}</span>
										)}
										{option.arrow !== undefined && (
											<Icon
												icon={
													option.arrow === "up"
														? tablerArrowUp
														: tablerArrowDown
												}
												width="14"
												height="14"
											/>
										)}
									</span>
								)}
							</span>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
