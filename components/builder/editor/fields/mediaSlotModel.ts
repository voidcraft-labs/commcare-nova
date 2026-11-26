/**
 * Whether a question's label or help media holds files of a language's own.
 * It reads the stored field: the worker language's projection gives each
 * role the one file that language sees and carries no `mediaByLanguage`, so
 * it would always answer no.
 */

import type { Field } from "@/lib/domain";

export function mediaSlotHoldsLanguageFiles(
	stored: Field | undefined,
	slot: "label_media" | "help_media",
): boolean {
	if (stored === undefined || !(slot in stored)) return false;
	const media = Reflect.get(stored, slot) as
		| { readonly mediaByLanguage?: object }
		| undefined;
	return (
		media?.mediaByLanguage !== undefined &&
		Object.keys(media.mediaByLanguage).length > 0
	);
}
