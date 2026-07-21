"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import * as React from "react";
import {
	type DayButton,
	DayPicker,
	getDefaultClassNames,
	type Locale,
} from "react-day-picker";
import { Button, buttonVariants } from "@/components/shadcn/button";
import { cn } from "@/lib/utils";

function Calendar({
	className,
	classNames,
	showOutsideDays = true,
	captionLayout = "label",
	buttonVariant = "ghost",
	locale,
	formatters,
	components,
	...props
}: React.ComponentProps<typeof DayPicker> & {
	buttonVariant?: React.ComponentProps<typeof Button>["variant"];
}) {
	const defaultClassNames = getDefaultClassNames();

	return (
		<DayPicker
			showOutsideDays={showOutsideDays}
			className={cn(
				// Calendar rows keep a 44px interaction height while their width can
				// contract only when a phone viewport cannot physically fit seven
				// square targets plus the popover gutter. On ordinary viewports the
				// cells are 44px square; on the constrained path only the horizontal
				// measure changes, so every day remains a full-height touch target and
				// the calendar never needs horizontal scrolling.
				"group/calendar max-w-[calc(100dvw-2rem)] bg-background p-2 [--cell-radius:var(--radius-md)] [--cell-size:min(2.75rem,calc((100dvw-3rem)/7))] [--cell-target-size:2.75rem] in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent",
				props.showWeekNumber &&
					"[--cell-size:min(2.75rem,calc((100dvw-3rem)/8))]",
				String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
				String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
				className,
			)}
			captionLayout={captionLayout}
			locale={locale}
			formatters={{
				formatMonthDropdown: (date) =>
					date.toLocaleString(locale?.code, { month: "short" }),
				...formatters,
			}}
			classNames={{
				root: cn("w-fit", defaultClassNames.root),
				months: cn(
					"relative flex flex-col gap-4 md:flex-row",
					defaultClassNames.months,
				),
				month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
				nav: cn(
					"absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
					defaultClassNames.nav,
				),
				button_previous: cn(
					buttonVariants({ variant: buttonVariant }),
					"size-(--cell-target-size) p-0 select-none aria-disabled:opacity-40",
					defaultClassNames.button_previous,
				),
				button_next: cn(
					buttonVariants({ variant: buttonVariant }),
					"size-(--cell-target-size) p-0 select-none aria-disabled:opacity-40",
					defaultClassNames.button_next,
				),
				month_caption: cn(
					"flex h-(--cell-target-size) w-full items-center justify-center px-(--cell-target-size)",
					defaultClassNames.month_caption,
				),
				dropdowns: cn(
					"flex h-(--cell-target-size) w-full items-center justify-center gap-1.5 text-sm font-medium",
					defaultClassNames.dropdowns,
				),
				dropdown_root: cn(
					"relative flex h-(--cell-target-size) items-center rounded-(--cell-radius)",
					defaultClassNames.dropdown_root,
				),
				dropdown: cn(
					"absolute inset-0 bg-popover opacity-0",
					defaultClassNames.dropdown,
				),
				caption_label: cn(
					"font-medium select-none",
					captionLayout === "label"
						? "text-sm"
						: "flex h-(--cell-target-size) items-center gap-1 rounded-(--cell-radius) px-2.5 text-sm [&>svg]:size-3.5 [&>svg]:text-muted-foreground",
					defaultClassNames.caption_label,
				),
				month_grid: cn("w-full border-collapse", defaultClassNames.month_grid),
				weekdays: cn("flex", defaultClassNames.weekdays),
				weekday: cn(
					"flex-1 rounded-(--cell-radius) text-[0.8rem] font-normal text-muted-foreground select-none",
					defaultClassNames.weekday,
				),
				week: cn("flex w-full", defaultClassNames.week),
				week_number_header: cn(
					"w-(--cell-size) select-none",
					defaultClassNames.week_number_header,
				),
				week_number: cn(
					"text-[0.8rem] text-muted-foreground select-none",
					defaultClassNames.week_number,
				),
				day: cn(
					"group/day relative h-(--cell-target-size) w-(--cell-size) rounded-(--cell-radius) p-0 text-center select-none [&:last-child[data-selected=true]_button]:rounded-r-(--cell-radius)",
					props.showWeekNumber
						? "[&:nth-child(2)[data-selected=true]_button]:rounded-l-(--cell-radius)"
						: "[&:first-child[data-selected=true]_button]:rounded-l-(--cell-radius)",
					defaultClassNames.day,
				),
				range_start: cn(
					"relative isolate z-0 rounded-l-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-muted",
					defaultClassNames.range_start,
				),
				range_middle: cn("rounded-none", defaultClassNames.range_middle),
				range_end: cn(
					"relative isolate z-0 rounded-r-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:left-0 after:w-4 after:bg-muted",
					defaultClassNames.range_end,
				),
				today: cn(
					"rounded-(--cell-radius) text-foreground data-[selected=true]:rounded-none",
					defaultClassNames.today,
				),
				outside: cn(
					"text-muted-foreground aria-selected:text-muted-foreground",
					defaultClassNames.outside,
				),
				disabled: cn(
					"text-muted-foreground opacity-40",
					defaultClassNames.disabled,
				),
				hidden: cn("invisible", defaultClassNames.hidden),
				...classNames,
			}}
			components={{
				Root: ({ className, rootRef, ...props }) => {
					return (
						<div
							data-slot="calendar"
							ref={rootRef}
							className={cn(className)}
							{...props}
						/>
					);
				},
				Chevron: ({ className, orientation, size: _size, ...props }) => {
					const icon =
						orientation === "left"
							? tablerChevronLeft
							: orientation === "right"
								? tablerChevronRight
								: tablerChevronDown;
					return (
						<Icon icon={icon} className={cn("size-4", className)} {...props} />
					);
				},
				DayButton: ({ ...props }) => (
					<CalendarDayButton locale={locale} {...props} />
				),
				WeekNumber: ({ children, ...props }) => {
					return (
						<td {...props}>
							<div className="flex h-(--cell-target-size) w-(--cell-size) items-center justify-center text-center">
								{children}
							</div>
						</td>
					);
				},
				...components,
			}}
			{...props}
		/>
	);
}

function CalendarDayButton({
	className,
	day,
	modifiers,
	locale,
	...props
}: React.ComponentProps<typeof DayButton> & { locale?: Partial<Locale> }) {
	const defaultClassNames = getDefaultClassNames();

	const ref = React.useRef<HTMLButtonElement>(null);
	React.useEffect(() => {
		if (modifiers.focused) ref.current?.focus();
	}, [modifiers.focused]);

	return (
		<Button
			variant="ghost"
			size="icon"
			data-day={day.date.toLocaleDateString(locale?.code)}
			data-today={modifiers.today}
			data-selected-single={
				modifiers.selected &&
				!modifiers.range_start &&
				!modifiers.range_end &&
				!modifiers.range_middle
			}
			data-range-start={modifiers.range_start}
			data-range-end={modifiers.range_end}
			data-range-middle={modifiers.range_middle}
			className={cn(
				// The painted plate (hover / today / selected) is INSET from the
				// 44px hit target: a transparent 2px border + the Button base's
				// `bg-clip-padding` keep every fill 4px narrower than the cell,
				// so adjacent days always have visible breathing room and a
				// hovered plate never presses against its neighbors' numbers.
				// The plate's radius is the calendar's own `--cell-radius`, not
				// the Button base's `rounded-lg`, so hover, today, and selected
				// all share one corner geometry. Hover and today use violet
				// tints, not `bg-muted` — muted sits at the popover glass's own
				// luminance and paints an invisible plate there. Range fills
				// opt back into full-bleed (border-0) — a band must run
				// continuous across cells.
				"relative isolate z-10 flex h-(--cell-target-size) w-(--cell-size) min-w-(--cell-size) flex-col gap-1 rounded-(--cell-radius) border-2 border-transparent leading-none font-normal not-disabled:hover:bg-nova-violet/[0.14] group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-ring/50 data-[range-end=true]:rounded-(--cell-radius) data-[range-end=true]:rounded-r-(--cell-radius) data-[range-end=true]:border-0 data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-middle=true]:rounded-none data-[range-middle=true]:border-0 data-[range-middle=true]:bg-muted data-[range-middle=true]:text-foreground data-[range-start=true]:rounded-(--cell-radius) data-[range-start=true]:rounded-l-(--cell-radius) data-[range-start=true]:border-0 data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground data-[today=true]:not-data-[selected-single=true]:bg-nova-violet/[0.09] dark:not-disabled:hover:bg-nova-violet/[0.14] dark:hover:text-foreground [&>span]:text-xs [&>span]:opacity-70",
				defaultClassNames.day,
				className,
			)}
			{...props}
		/>
	);
}

export { Calendar, CalendarDayButton };
