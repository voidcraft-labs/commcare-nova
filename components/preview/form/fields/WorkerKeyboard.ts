import type { FocusEvent, KeyboardEvent } from "react";
import type { Field, Platform } from "@/lib/domain";
import { hasOtherDisplay } from "@/lib/domain/questionDisplay";

/** Android's QuestionsView marks the final StringWidget on its current screen.
 * Integer and Decimal always expose the action, and other text boxes expose
 * it for a compact screen or the single short display setting. */
export function workerKeyboard(field: Field, platform: Platform) {
	if (platform !== "android") return {};
	function action(input: HTMLInputElement) {
		const eligible =
			field.kind === "int" ||
			field.kind === "decimal" ||
			("inputWidth" in field &&
				field.inputWidth === "short" &&
				!hasOtherDisplay(field, "inputWidth")) ||
			input.closest("[data-compact-entries]") !== null;
		if (!eligible) return undefined;
		const page = input.closest("section") ?? input.closest("fieldset");
		const boxes = Array.from(
			page?.querySelectorAll<HTMLInputElement>("[data-worker-text-entry]") ??
				[],
		);
		const index = boxes.indexOf(input);
		return { next: index < 0 ? undefined : boxes[index + 1] };
	}
	return {
		"data-worker-text-entry": "",
		onFocus(event: FocusEvent<HTMLInputElement>) {
			const target = event.currentTarget,
				position = action(target);
			if (position) target.enterKeyHint = position.next ? "next" : "done";
		},
		onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
			if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
			const target = event.currentTarget,
				position = action(target);
			if (!position) return;
			event.preventDefault();
			if (position.next) position.next.focus();
			else target.blur();
		},
	};
}
