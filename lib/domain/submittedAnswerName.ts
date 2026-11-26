/** Which submission action a worker would execute on an ordinary answer.
 * Android FormRecordProcessor offers only cases and stock to its parser.
 * Formplayer delegates to CommCareTransactionParserFactory in both case modes.
 * The receiver starts below the primary envelope and consumes a complete
 * subtree when it recognizes an action.
 */
export type SubmittedAction =
	| "stock"
	| "case"
	| "registration"
	| "fixture"
	| "schema"
	| "sync";

export function submittedAction(
	name: string,
	namespace?: string | null,
): SubmittedAction | undefined {
	if (namespace === "http://commcarehq.org/ledger/v1") return "stock";
	switch (name.toLowerCase()) {
		case "case":
			return "case";
		case "registration":
			return "registration";
		case "fixture":
			return "fixture";
		case "schema":
			return "schema";
		case "sync":
			return namespace === "http://commcarehq.org/sync" ? "sync" : undefined;
		default:
			return undefined;
	}
}

export function answerRequiresAndroid(
	name: string,
	namespace?: string | null,
): boolean {
	const action = submittedAction(name, namespace);
	return action !== undefined && action !== "case" && action !== "stock";
}

/** The receiving service's namespace may be a URL or another URI such as a
 * URN. XML reserves its own two namespace names, and a URI cannot contain
 * unescaped whitespace. Clearing this setting leaves the value in its
 * form's namespace. */
export function answerNamespaceProblem(namespace: string): string | undefined {
	if (
		namespace === "http://www.w3.org/XML/1998/namespace" ||
		namespace === "http://www.w3.org/2000/xmlns/"
	) {
		return "That namespace is reserved by XML.";
	}
	if (
		!namespace ||
		/[\s<>"{}|\\^`]/u.test(namespace) ||
		/%(?![0-9a-f]{2})/iu.test(namespace)
	) {
		return "This namespace needs a URI without spaces or unescaped characters.";
	}
	return undefined;
}
