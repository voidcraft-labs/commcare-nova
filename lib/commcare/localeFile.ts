/** CommCare Core locale-file value rules, shared by validation and emission. */

export function localeFileValueIssue(value: string): string | undefined {
	if (value.includes("\\n")) {
		return "contains the literal sequence \\n, which the locale-file grammar changes into a line break";
	}
	if (value.includes("\r")) {
		return "contains a carriage return, which the locale-file grammar cannot represent";
	}
	if (value.trim() === "") return undefined;
	const firstCodeUnit = value.charCodeAt(0);
	const lastCodeUnit = value.charCodeAt(value.length - 1);
	if (firstCodeUnit <= 0x20 || lastCodeUnit <= 0x20) {
		return "starts or ends with whitespace that the locale-file grammar discards";
	}
	return undefined;
}

/** Serialize a value exactly as Core's `LocalizationUtils` reads it. */
export function serializeLocaleFileValue(
	localeId: string,
	value: string,
): string {
	const issue = localeFileValueIssue(value);
	if (issue !== undefined) {
		throw new Error(`App string ${JSON.stringify(localeId)} ${issue}.`);
	}
	// HQ uses a non-breaking space to keep an intentionally blank locale id in
	// the table; Core discards a bare `key=` line entirely.
	if (value.trim() === "") return "\u00a0";
	return value.replaceAll("#", "\\#").replaceAll("\n", "\\n");
}
