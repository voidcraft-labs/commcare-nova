"use client";
import { useCallback } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import {
	type RuntimeMessage,
	runtimeMessage,
} from "@/lib/preview/runtimeMessages";

/** Platform copy follows the worker's selected app language. */
export function useWorkerMessage() {
	const { language } = useBuilderLanguage();
	return useCallback(
		(
			message: RuntimeMessage,
			values?: Readonly<Record<string, string | number>>,
		) => runtimeMessage(language, message, values),
		[language],
	);
}

export function WorkerText({
	message,
	values,
}: {
	message: RuntimeMessage;
	values?: Readonly<Record<string, string | number>>;
}) {
	return useWorkerMessage()(message, values);
}
