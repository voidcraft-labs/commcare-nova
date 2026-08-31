/**
 * Public, semantic CommCare HQ project-space compatibility contract.
 *
 * This module is safe for browser, HTTP, and MCP consumers. The private HQ
 * settings that prove each capability live behind `lib/commcare`; their
 * names, namespaces, and probe inventory must never enter this vocabulary.
 */

export const PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL = "support@dimagi.com";
export const PROJECT_SPACE_COMPATIBILITY_DOCS_URL =
	"https://docs.commcare.app/project-space-compatibility";
export const PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER =
	"X-Nova-Project-Space-Compatibility";

export type ProjectSpaceCapabilityId =
	| "case-search"
	| "commcare-connect"
	| "case-attachments"
	| "attachment-links";

export type ProjectSpaceAdvisoryId = "large-search-performance";

export interface ProjectSpaceCapabilityDefinition {
	readonly id: ProjectSpaceCapabilityId;
	readonly label: string;
	readonly description: string;
}

export interface ProjectSpaceAdvisoryDefinition {
	readonly id: ProjectSpaceAdvisoryId;
	readonly title: string;
	readonly description: string;
}

export const PROJECT_SPACE_CAPABILITIES: Readonly<
	Record<ProjectSpaceCapabilityId, ProjectSpaceCapabilityDefinition>
> = {
	"case-search": {
		id: "case-search",
		label: "Case search",
		description:
			"Lets workers search across cases that are not already available in the app.",
	},
	"commcare-connect": {
		id: "commcare-connect",
		label: "CommCare Connect",
		description:
			"Lets the app run CommCare Connect Learn or Deliver workflows and send Connect messages or surveys.",
	},
	"case-attachments": {
		id: "case-attachments",
		label: "Attachments saved to cases",
		description: "Lets a captured file be stored on a case.",
	},
	"attachment-links": {
		id: "attachment-links",
		label: "Links to captured files",
		description:
			"Lets workers open a captured file from the link saved on a case.",
	},
};

export const PROJECT_SPACE_ADVISORIES: Readonly<
	Record<ProjectSpaceAdvisoryId, ProjectSpaceAdvisoryDefinition>
> = {
	"large-search-performance": {
		id: "large-search-performance",
		title: "Large searches may open more slowly",
		description:
			"Large Search results may take longer to open when the faster path is unavailable.",
	},
};

export interface ProjectSpaceCapabilityUse
	extends ProjectSpaceCapabilityDefinition {
	readonly reasons: readonly string[];
}

export interface ProjectSpaceAdvisoryUse
	extends ProjectSpaceAdvisoryDefinition {
	readonly reasons: readonly string[];
}

export type ProjectSpaceCapabilityState =
	| "not_checked"
	| "available"
	| "missing"
	| "unverified";

/** Why an otherwise reachable project space could not be checked. Public and
 * semantic: clients can offer the right recovery without seeing HQ internals. */
export type ProjectSpaceCompatibilityIssue = "connected-account-permission";

export interface ProjectSpaceCapabilityCheck extends ProjectSpaceCapabilityUse {
	readonly state: ProjectSpaceCapabilityState;
	readonly issue?: ProjectSpaceCompatibilityIssue;
}

export interface ProjectSpaceAdvisoryCheck extends ProjectSpaceAdvisoryUse {
	readonly state: ProjectSpaceCapabilityState;
	readonly message: string;
}

export interface ProjectSpaceCapabilityProbe {
	readonly capability: ProjectSpaceCapabilityUse;
	readonly state: Exclude<ProjectSpaceCapabilityState, "not_checked">;
	readonly issue?: ProjectSpaceCompatibilityIssue;
}

export interface ProjectSpaceAdvisoryProbe {
	readonly advisory: ProjectSpaceAdvisoryUse;
	readonly state: Exclude<ProjectSpaceCapabilityState, "not_checked">;
}

export type ProjectSpaceCompatibilityStatus =
	| "not_needed"
	| "not_checked"
	| "ready"
	| "blocked";

/** Stable public object shared by HTTP and MCP publish surfaces. */
export interface ProjectSpaceCompatibilityReport {
	readonly status: ProjectSpaceCompatibilityStatus;
	readonly target_domain?: string;
	readonly required_capabilities: readonly ProjectSpaceCapabilityCheck[];
	readonly blockers: readonly ProjectSpaceCapabilityCheck[];
	readonly advisories: readonly ProjectSpaceAdvisoryCheck[];
	readonly support_email: typeof PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL;
	readonly docs_url: typeof PROJECT_SPACE_COMPATIBILITY_DOCS_URL;
	readonly message: string;
}

export function projectSpaceCapabilityUse(
	id: ProjectSpaceCapabilityId,
	reasons: readonly string[],
): ProjectSpaceCapabilityUse {
	return { ...PROJECT_SPACE_CAPABILITIES[id], reasons };
}

export function projectSpaceAdvisoryUse(
	id: ProjectSpaceAdvisoryId,
	reasons: readonly string[],
): ProjectSpaceAdvisoryUse {
	return { ...PROJECT_SPACE_ADVISORIES[id], reasons };
}

/** Compatibility information for an artifact with no selected destination. */
export function projectSpaceCompatibilityForUnknownTarget(
	required: readonly ProjectSpaceCapabilityUse[],
	advisories: readonly ProjectSpaceAdvisoryUse[],
	context: "download" | "prepublish" = "download",
): ProjectSpaceCompatibilityReport {
	if (required.length === 0 && advisories.length === 0) {
		return noCompatibilityNeeded();
	}

	const message =
		context === "download"
			? "Nova hasn't checked where you'll import this file. Choose a project space that supports everything this app uses."
			: "Choose a project space that supports everything this app uses.";
	return {
		status: "not_checked",
		required_capabilities: required.map((capability) => ({
			...capability,
			state: "not_checked",
		})),
		blockers: [],
		advisories: advisories.map((advisory) => ({
			...advisory,
			state: "not_checked",
			message:
				"Nova can check this after you choose a CommCare HQ project space.",
		})),
		support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
		docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
		message,
	};
}

/** Compatibility information after checking one selected destination. */
export function projectSpaceCompatibilityForTarget(
	domain: string,
	capabilityProbes: readonly ProjectSpaceCapabilityProbe[],
	advisoryProbes: readonly ProjectSpaceAdvisoryProbe[],
): ProjectSpaceCompatibilityReport {
	if (capabilityProbes.length === 0 && advisoryProbes.length === 0) {
		return noCompatibilityNeeded(domain);
	}

	const requiredCapabilities: ProjectSpaceCapabilityCheck[] =
		capabilityProbes.map(({ capability, state, issue }) => ({
			...capability,
			state,
			...(issue === undefined ? {} : { issue }),
		}));
	const blockers = requiredCapabilities.filter(
		(capability) =>
			capability.state === "missing" || capability.state === "unverified",
	);
	const advisories = advisoryProbes.map(({ advisory, state }) => ({
		...advisory,
		state,
		message: advisoryMessage(state),
	}));

	let message: string;
	if (blockers.length === 0) {
		message = "This project space supports everything this app uses.";
	} else {
		const missing = blockers.filter((blocker) => blocker.state === "missing");
		const unverified = blockers.filter(
			(blocker) => blocker.state === "unverified",
		);
		const parts = ["This project space isn't ready for this app."];
		if (missing.length > 0) {
			parts.push(
				`It doesn't support ${friendlyList(missing.map((item) => item.label))}. Ask a project-space administrator or Dimagi Support to enable that support, then check again.`,
			);
		}
		if (unverified.length > 0) {
			const permissionBlocked = unverified.filter(
				(item) => item.issue === "connected-account-permission",
			);
			const otherwiseUnverified = unverified.filter(
				(item) => item.issue !== "connected-account-permission",
			);
			if (permissionBlocked.length > 0) {
				parts.push(
					`Nova couldn't confirm ${friendlyList(permissionBlocked.map((item) => item.label))} because the connected CommCare HQ account does not have Mobile App Access. Nothing has been sent. Ask a project-space administrator to add that permission to the connected account, then check again.`,
				);
			}
			if (otherwiseUnverified.length > 0) {
				parts.push(
					`Nova couldn't confirm ${friendlyList(otherwiseUnverified.map((item) => item.label))}. Nothing has been sent. Check your CommCare HQ connection, then try again.`,
				);
			}
		}
		message = parts.join(" ");
	}

	return {
		status: blockers.length === 0 ? "ready" : "blocked",
		target_domain: domain,
		required_capabilities: requiredCapabilities,
		blockers,
		advisories,
		support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
		docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
		message,
	};
}

/** Header-safe encoding for binary HTTP export responses. */
export function encodeProjectSpaceCompatibilityReport(
	report: ProjectSpaceCompatibilityReport,
): string {
	return encodeURIComponent(JSON.stringify(report));
}

/** Invalid or stale metadata is absent so a successful download stays usable. */
export function decodeProjectSpaceCompatibilityReport(
	value: string | null,
): ProjectSpaceCompatibilityReport | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(value));
		return isProjectSpaceCompatibilityReport(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function noCompatibilityNeeded(
	domain?: string,
): ProjectSpaceCompatibilityReport {
	return {
		status: "not_needed",
		...(domain && { target_domain: domain }),
		required_capabilities: [],
		blockers: [],
		advisories: [],
		support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
		docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
		message: "This app can run without any additional project-space support.",
	};
}

function advisoryMessage(
	state: Exclude<ProjectSpaceCapabilityState, "not_checked">,
): string {
	if (state === "available") {
		return "This project space can optimize large Search results.";
	}
	if (state === "missing") {
		return "This project space doesn't support the faster path for large Search results. Large results may take longer to open.";
	}
	return "Nova couldn't confirm the faster path for large Search results. Large results may take longer to open.";
}

function friendlyList(values: readonly string[]): string {
	if (values.length < 2) return values[0] ?? "the features this app uses";
	if (values.length === 2) return `${values[0]} and ${values[1]}`;
	return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

const COMPATIBILITY_STATUSES = new Set<ProjectSpaceCompatibilityStatus>([
	"not_needed",
	"not_checked",
	"ready",
	"blocked",
]);
const CAPABILITY_STATES = new Set<ProjectSpaceCapabilityState>([
	"not_checked",
	"available",
	"missing",
	"unverified",
]);
const COMPATIBILITY_ISSUES = new Set<ProjectSpaceCompatibilityIssue>([
	"connected-account-permission",
]);
const CAPABILITY_IDS = new Set<ProjectSpaceCapabilityId>([
	"case-search",
	"commcare-connect",
	"case-attachments",
	"attachment-links",
]);
const ADVISORY_IDS = new Set<ProjectSpaceAdvisoryId>([
	"large-search-performance",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isCapabilityCheck(
	value: unknown,
): value is ProjectSpaceCapabilityCheck {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		!CAPABILITY_IDS.has(value.id as ProjectSpaceCapabilityId)
	) {
		return false;
	}
	const definition =
		PROJECT_SPACE_CAPABILITIES[value.id as ProjectSpaceCapabilityId];
	return (
		value.label === definition.label &&
		value.description === definition.description &&
		isStringList(value.reasons) &&
		typeof value.state === "string" &&
		CAPABILITY_STATES.has(value.state as ProjectSpaceCapabilityState) &&
		(value.issue === undefined ||
			(typeof value.issue === "string" &&
				COMPATIBILITY_ISSUES.has(
					value.issue as ProjectSpaceCompatibilityIssue,
				)))
	);
}

function isAdvisoryCheck(value: unknown): value is ProjectSpaceAdvisoryCheck {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		!ADVISORY_IDS.has(value.id as ProjectSpaceAdvisoryId)
	) {
		return false;
	}
	const definition =
		PROJECT_SPACE_ADVISORIES[value.id as ProjectSpaceAdvisoryId];
	return (
		value.title === definition.title &&
		value.description === definition.description &&
		isStringList(value.reasons) &&
		typeof value.state === "string" &&
		CAPABILITY_STATES.has(value.state as ProjectSpaceCapabilityState) &&
		typeof value.message === "string"
	);
}

function isProjectSpaceCompatibilityReport(
	value: unknown,
): value is ProjectSpaceCompatibilityReport {
	if (
		!isRecord(value) ||
		typeof value.status !== "string" ||
		!COMPATIBILITY_STATUSES.has(
			value.status as ProjectSpaceCompatibilityStatus,
		) ||
		(value.target_domain !== undefined &&
			typeof value.target_domain !== "string") ||
		!Array.isArray(value.required_capabilities) ||
		!value.required_capabilities.every(isCapabilityCheck) ||
		!Array.isArray(value.blockers) ||
		!value.blockers.every(isCapabilityCheck) ||
		!Array.isArray(value.advisories) ||
		!value.advisories.every(isAdvisoryCheck) ||
		value.support_email !== PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL ||
		value.docs_url !== PROJECT_SPACE_COMPATIBILITY_DOCS_URL ||
		typeof value.message !== "string"
	) {
		return false;
	}

	const required = value.required_capabilities;
	const blockers = value.blockers;
	const advisories = value.advisories;
	if (
		blockers.some(
			(item) => item.state !== "missing" && item.state !== "unverified",
		)
	) {
		return false;
	}
	if (
		blockers.some(
			(blocker) =>
				!required.some(
					(item) => item.id === blocker.id && item.state === blocker.state,
				),
		)
	) {
		return false;
	}

	switch (value.status) {
		case "not_needed":
			return (
				required.length === 0 &&
				blockers.length === 0 &&
				advisories.length === 0
			);
		case "not_checked":
			return (
				blockers.length === 0 &&
				required.every((item) => item.state === "not_checked") &&
				advisories.every((item) => item.state === "not_checked")
			);
		case "ready":
			return (
				typeof value.target_domain === "string" &&
				blockers.length === 0 &&
				required.every((item) => item.state === "available")
			);
		case "blocked":
			return typeof value.target_domain === "string" && blockers.length > 0;
	}
	return false;
}
