import { z } from "zod";
import { FORM_SOURCE_READER_NAMES } from "./questionId";

/** The form's root must be both an XML element name and a name in Core's
 * XPath lexer. Core tests each UTF-16 unit for a lower/uppercase letter
 * or an underscore, allowing a digit, dot or hyphen after the first. */
const xmlName =
	/^[A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][A-Z_a-z0-9.\-\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]*$/u;
const workerName =
	/^[_\p{Lowercase}\p{Uppercase}][_.\p{Lowercase}\p{Uppercase}\p{Nd}-]*$/u;
export const formRootNameSchema = z
	.string()
	.refine(
		(name) =>
			xmlName.test(name) && workerName.test(name) && name.trim() === name,
		"Use a letter or underscore first, then letters, numbers, underscores, dots or hyphens.",
	)
	.refine(
		(name) => !FORM_SOURCE_READER_NAMES.has(name),
		"The form designer uses this name to read the form itself. Choose another answer root, such as survey.",
	);

export function formRootName(
	form: { readonly dataRootName?: string } | undefined,
): string {
	return form?.dataRootName ?? "data";
}
