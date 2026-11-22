"use client";
import { useState } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import {
	runtimeDateLocale,
	runtimeMessage,
} from "@/lib/preview/runtimeMessages";
import {
	calendarDayOfIso,
	calendarMonth,
	calendarText,
	isoOfCalendarDay,
	localToday,
	type WorkerCalendar,
} from "@/lib/preview/workerCalendar";

/** A date in the selected worker calendar submits the same ISO civil day. */
export function AlternateDatePicker({
	calendar,
	value,
	onChange,
	onBlur,
	labelledBy,
	invalid,
	allowCancel,
}: {
	calendar: WorkerCalendar;
	value: string;
	onChange: (value: string) => void;
	onBlur: () => void;
	labelledBy?: string;
	invalid?: boolean;
	allowCancel?: boolean;
}) {
	const { language } = useBuilderLanguage();
	const locale = runtimeDateLocale(language);
	const selected = calendarDayOfIso(value);
	const [month, setMonth] = useState(localToday);
	const [open, setOpen] = useState(false);
	const choices = calendarMonth(month, calendar);
	const label =
		selected !== undefined
			? calendarText(selected, calendar, locale, true)
			: undefined;
	const choose = (value: string) => {
		onChange(value);
		onBlur();
		setOpen(false);
	};
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (next) {
					const initial = selected ?? localToday();
					setMonth(calendarMonth(initial, calendar) ? initial : localToday());
				}
				setOpen(next);
			}}
		>
			<PopoverTrigger
				aria-labelledby={labelledBy}
				aria-invalid={invalid || undefined}
				onBlur={onBlur}
				render={<Button type="button" variant="field" className="w-full" />}
			>
				{label ?? (value || runtimeMessage(language, "pickDate"))}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72 p-3">
				{choices && (
					<>
						<div className="mb-2 flex items-center justify-between gap-2">
							<Button
								type="button"
								variant="ghost"
								aria-label={runtimeMessage(language, "previousMonth")}
								disabled={choices.previous === undefined}
								onClick={() =>
									choices.previous !== undefined && setMonth(choices.previous)
								}
							>
								‹
							</Button>
							<span aria-live="polite" className="text-sm font-medium">
								{calendarText(month, calendar, locale, false)}
							</span>
							<Button
								type="button"
								variant="ghost"
								aria-label={runtimeMessage(language, "nextMonth")}
								disabled={choices.next === undefined}
								onClick={() =>
									choices.next !== undefined && setMonth(choices.next)
								}
							>
								›
							</Button>
						</div>
						<div className="grid grid-cols-7 gap-0.5">
							{choices.dates.map((day, i) => (
								<button
									key={day}
									type="button"
									aria-label={calendarText(day, calendar, locale, true)}
									aria-pressed={day === selected}
									className="nova-focusable min-h-8 rounded text-sm hover:bg-accent aria-pressed:bg-primary aria-pressed:text-primary-foreground"
									style={
										i === 0
											? {
													gridColumnStart:
														new Date(day * 86400000).getUTCDay() + 1,
												}
											: undefined
									}
									onClick={() => choose(isoOfCalendarDay(day))}
								>
									{new Intl.NumberFormat(locale).format(i + 1)}
								</button>
							))}
						</div>
					</>
				)}
				<div className="mt-2 flex justify-end gap-2">
					{value && (
						<Button type="button" variant="ghost" onClick={() => choose("")}>
							{runtimeMessage(language, "clear")}
						</Button>
					)}
					{allowCancel && (
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							{runtimeMessage(language, "cancel")}
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
