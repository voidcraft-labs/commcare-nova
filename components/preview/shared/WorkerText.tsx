"use client";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import {
	type RuntimeMessage,
	runtimeMessage,
} from "@/lib/preview/runtimeMessages";

/** Platform copy follows the worker's selected app language. */
export function WorkerText({ message }: { message: RuntimeMessage }) {
	const { language } = useBuilderLanguage();
	return runtimeMessage(language, message);
}
