/**
 * The sentence for a form behavior text that would stop working, shared by
 * the validator's message and the builder's copy so both say the same thing.
 * Each issue names the texts by their breadcrumb, never by a wire id.
 */
import {
	type FormBehaviorRole,
	formBehaviorRoleNames,
} from "@/lib/domain/forms";

export type FormBehaviorTextIssue =
	/** A title or a time window is set without a shared activity key. */
	| { readonly reason: "needs-activity-key" }
	/** The same text is chosen twice for one setting. */
	| {
			readonly reason: "chosen-twice";
			readonly role: FormBehaviorRole;
			readonly text: string;
	  }
	/** One text is chosen for two settings. */
	| {
			readonly reason: "held-by-another";
			readonly role: FormBehaviorRole;
			readonly heldBy: FormBehaviorRole;
			readonly text: string;
	  }
	/** The chosen text is not written into the form (removed, hidden or blank). */
	| {
			readonly reason: "text-missing";
			readonly role: FormBehaviorRole;
			readonly formName: string;
	  }
	/** A slot sharing the text no longer agrees with it. */
	| {
			readonly reason: "shared-text-differs";
			readonly role: FormBehaviorRole;
			readonly text: string;
			readonly carrier: string;
	  }
	/** CommCare HQ would merge the text into an equal one and lose the setting. */
	| {
			readonly reason: "merged-away";
			readonly role: FormBehaviorRole;
			readonly text: string;
			readonly carrier: string;
	  };

const roleName = (role: FormBehaviorRole): string =>
	formBehaviorRoleNames[role].toLowerCase();

export function formBehaviorTextSentence(issue: FormBehaviorTextIssue): string {
	switch (issue.reason) {
		case "needs-activity-key":
			return "Choose a shared activity key to use a title or time window, or remove those settings together.";
		case "chosen-twice":
			return `"${issue.text}" already uses ${roleName(issue.role)}. Choose it once.`;
		case "held-by-another":
			return `"${issue.text}" already holds ${roleName(issue.heldBy)}. Choose a different text for ${roleName(issue.role)}.`;
		case "text-missing":
			return `"${issue.formName}" needs a text that appears in the form for ${roleName(issue.role)}. Choose another text or remove the setting.`;
		case "shared-text-differs":
			return `"${issue.text}" shares the ${roleName(issue.role)} text with "${issue.carrier}". The text, formatting and media must agree in every language. Change both texts together or stop sharing them.`;
		case "merged-away":
			return `"${issue.text}" has the same text, formatting and media as "${issue.carrier}" in every language. CommCare HQ combines them and loses ${roleName(issue.role)}. Change either text.`;
	}
}

const ROLES = new Set<string>(Object.keys(formBehaviorRoleNames));
const isRole = (value: string | undefined): value is FormBehaviorRole =>
	value !== undefined && ROLES.has(value);

/** The issue as validator details (string values only), and back. */
export function formBehaviorTextDetails(
	issue: FormBehaviorTextIssue,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(issue).filter(([, value]) => typeof value === "string"),
	);
}

export function formBehaviorTextIssueFromDetails(
	details: Readonly<Record<string, string>> | undefined,
): FormBehaviorTextIssue | undefined {
	if (!details) return undefined;
	const { reason, role, heldBy, text, carrier, formName } = details;
	if (reason === "needs-activity-key") return { reason };
	if (!isRole(role)) return undefined;
	switch (reason) {
		case "chosen-twice":
			return text === undefined ? undefined : { reason, role, text };
		case "held-by-another":
			return text === undefined || !isRole(heldBy)
				? undefined
				: { reason, role, heldBy, text };
		case "text-missing":
			return formName === undefined ? undefined : { reason, role, formName };
		case "shared-text-differs":
		case "merged-away":
			return text === undefined || carrier === undefined
				? undefined
				: { reason, role, text, carrier };
		default:
			return undefined;
	}
}
