"use client";

import type { ComponentProps } from "react";
import { es } from "react-day-picker/locale/es";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { DatePicker } from "@/components/shadcn/date-picker";
import {
	runtimeDateLocale,
	runtimeLanguage,
	runtimeMessage,
} from "@/lib/preview/runtimeMessages";

type WorkerDatePickerProps = Omit<
	ComponentProps<typeof DatePicker>,
	"locale" | "formatLocale" | "clearLabel" | "placeholder"
>;

/** Worker copy follows the selected app language; authoring keeps its own
 * defaults. DayPicker supplies generic English/Spanish calendar conventions. */
export function WorkerDatePicker(props: WorkerDatePickerProps) {
	const { language } = useBuilderLanguage();
	return (
		<DatePicker
			{...props}
			locale={
				runtimeLanguage(language).catalogLanguage === "spa" ? es : undefined
			}
			formatLocale={runtimeDateLocale(language)}
			placeholder={runtimeMessage(language, "pickDate")}
			clearLabel={runtimeMessage(language, "clear")}
		/>
	);
}
