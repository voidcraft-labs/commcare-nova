/**
 * Public CommCare HQ feature-flag catalog and publish-report contract.
 *
 * This module is intentionally free of CommCare wire emitters. Browser UI,
 * public docs, MCP prompts, and the server-side emission boundary all consume
 * the same serializable vocabulary without letting React reach into
 * `lib/commcare`. Wire-specific requirement detection remains in
 * `lib/commcare/featureFlags.ts`.
 */

import manifest from "@/config/commcare-hq-feature-flags.json";

export const HQ_FEATURE_FLAG_SUPPORT_EMAIL = "support@dimagi.com";
export const HQ_FEATURE_FLAGS_DOCS_URL =
	"https://docs.commcare.app/feature-flags";
export const HQ_FEATURE_FLAG_REPORT_HEADER = "X-Nova-Hq-Feature-Flag-Report";

type ManifestFlag = (typeof manifest.flags)[number];
export type HqFeatureFlagId = ManifestFlag["id"];

/** Public, serializable description safe for browser and MCP responses. */
export interface HqFeatureFlagRequirement {
	readonly id: HqFeatureFlagId;
	readonly slug: string;
	readonly label: string;
	readonly description: string;
	readonly required_for: string;
	readonly docs_url: string;
	/** All current entries are domain-only. Kept explicit to prevent a later
	 * user-namespaced toggle from silently inheriting domain-probe semantics. */
	readonly namespaces: readonly string[];
}

export const HQ_FEATURE_FLAG_REQUIREMENTS: readonly HqFeatureFlagRequirement[] =
	manifest.flags.map((flag) => ({
		id: flag.id,
		slug: flag.slug,
		label: flag.label,
		description: flag.description,
		required_for: flag.requiredFor,
		docs_url: `${HQ_FEATURE_FLAGS_DOCS_URL}#${flag.docsAnchor}`,
		namespaces: flag.expectedNamespaces.map((namespace) =>
			namespace === "NAMESPACE_DOMAIN" ? "domain" : namespace,
		),
	}));

export type HqFeatureFlagVerification =
	| "not_required"
	| "not_checked"
	| "verified"
	| "partial"
	| "unavailable";

/** Stable wire object shared by HTTP and MCP publish surfaces. */
export interface HqFeatureFlagReport {
	readonly verification: HqFeatureFlagVerification;
	readonly target_domain?: string;
	readonly required_flags: readonly HqFeatureFlagRequirement[];
	readonly missing_flags: readonly HqFeatureFlagRequirement[];
	readonly unverified_flags: readonly HqFeatureFlagRequirement[];
	readonly support_email: typeof HQ_FEATURE_FLAG_SUPPORT_EMAIL;
	readonly docs_url: typeof HQ_FEATURE_FLAGS_DOCS_URL;
	readonly message: string;
}

/** Header-safe encoding for binary HTTP export responses. */
export function encodeHqFeatureFlagReport(report: HqFeatureFlagReport): string {
	return encodeURIComponent(JSON.stringify(report));
}

/** Decode an export header. Invalid/missing metadata is absent so it can never
 * turn a successful download into a failure. */
export function decodeHqFeatureFlagReport(
	value: string | null,
): HqFeatureFlagReport | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(value));
		return isHqFeatureFlagReport(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const HQ_FEATURE_FLAG_VERIFICATIONS = new Set<HqFeatureFlagVerification>([
	"not_required",
	"not_checked",
	"verified",
	"partial",
	"unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHqFeatureFlagRequirement(
	value: unknown,
): value is HqFeatureFlagRequirement {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.slug === "string" &&
		typeof value.label === "string" &&
		typeof value.description === "string" &&
		typeof value.required_for === "string" &&
		typeof value.docs_url === "string" &&
		Array.isArray(value.namespaces) &&
		value.namespaces.every((namespace) => typeof namespace === "string")
	);
}

function isRequirementList(
	value: unknown,
): value is HqFeatureFlagRequirement[] {
	return Array.isArray(value) && value.every(isHqFeatureFlagRequirement);
}

function isHqFeatureFlagReport(value: unknown): value is HqFeatureFlagReport {
	return (
		isRecord(value) &&
		typeof value.verification === "string" &&
		HQ_FEATURE_FLAG_VERIFICATIONS.has(
			value.verification as HqFeatureFlagVerification,
		) &&
		(value.target_domain === undefined ||
			typeof value.target_domain === "string") &&
		isRequirementList(value.required_flags) &&
		isRequirementList(value.missing_flags) &&
		isRequirementList(value.unverified_flags) &&
		value.support_email === HQ_FEATURE_FLAG_SUPPORT_EMAIL &&
		value.docs_url === HQ_FEATURE_FLAGS_DOCS_URL &&
		typeof value.message === "string"
	);
}

export type HqFeatureFlagProbe = Readonly<{
	requirement: HqFeatureFlagRequirement;
	state: "enabled" | "missing" | "unavailable";
}>;

/** Report for an artifact whose eventual HQ domain is unknown. */
export function featureFlagReportForUnverifiedRequirements(
	required: readonly HqFeatureFlagRequirement[],
): HqFeatureFlagReport {
	if (required.length === 0) return noRequirementsReport();
	return {
		verification: "not_checked",
		required_flags: required,
		missing_flags: [],
		unverified_flags: required,
		support_email: HQ_FEATURE_FLAG_SUPPORT_EMAIL,
		docs_url: HQ_FEATURE_FLAGS_DOCS_URL,
		message: `This app requires ${flagNames(required)} in the CommCare HQ project space where it will be used. Nova cannot check a downloaded file's destination. If a required flag is not enabled, contact ${HQ_FEATURE_FLAG_SUPPORT_EMAIL} and name the project space.`,
	};
}

/** Report after probing a known HQ upload target. */
export function featureFlagReportForUpload(
	domain: string,
	probes: readonly HqFeatureFlagProbe[],
): HqFeatureFlagReport {
	if (probes.length === 0) return noRequirementsReport(domain);
	const required = probes.map((probe) => probe.requirement);
	const missing = probes
		.filter((probe) => probe.state === "missing")
		.map((probe) => probe.requirement);
	const unverified = probes
		.filter((probe) => probe.state === "unavailable")
		.map((probe) => probe.requirement);
	const verification: HqFeatureFlagVerification =
		unverified.length === 0
			? "verified"
			: unverified.length === required.length
				? "unavailable"
				: "partial";

	let message: string;
	if (verification === "verified" && missing.length === 0) {
		message = `Nova verified that every required feature flag is enabled for the “${domain}” project space.`;
	} else {
		const parts: string[] = [];
		if (missing.length > 0) {
			parts.push(
				`${flagNames(missing)} ${missing.length === 1 ? "is" : "are"} not enabled for the “${domain}” project space`,
			);
		}
		if (unverified.length > 0) {
			parts.push(`Nova could not verify ${flagNames(unverified)}`);
		}
		message = `${parts.join(". ")}. The app was still published. Contact ${HQ_FEATURE_FLAG_SUPPORT_EMAIL}, name the “${domain}” project space, and include the flags above.`;
	}

	return {
		verification,
		target_domain: domain,
		required_flags: required,
		missing_flags: missing,
		unverified_flags: unverified,
		support_email: HQ_FEATURE_FLAG_SUPPORT_EMAIL,
		docs_url: HQ_FEATURE_FLAGS_DOCS_URL,
		message,
	};
}

function noRequirementsReport(domain?: string): HqFeatureFlagReport {
	return {
		verification: "not_required",
		...(domain && { target_domain: domain }),
		required_flags: [],
		missing_flags: [],
		unverified_flags: [],
		support_email: HQ_FEATURE_FLAG_SUPPORT_EMAIL,
		docs_url: HQ_FEATURE_FLAGS_DOCS_URL,
		message:
			"This app does not use a Nova feature that needs an HQ feature flag.",
	};
}

function flagNames(flags: readonly HqFeatureFlagRequirement[]): string {
	const names = flags.map((flag) => `${flag.label} (${flag.slug})`);
	if (names.length < 2) return names[0] ?? "no feature flags";
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** Model-facing FYI used by autonomous plugin runs. It is intentionally
 * advisory: it asks the model to use an existing completion surface only. */
export const AUTONOMOUS_FEATURE_FLAG_GUIDANCE = `If the app you built uses case search or CommCare Connect, add a brief FYI to your normal completion message: the target CommCare HQ project space may need the corresponding feature flags enabled. Name ${HQ_FEATURE_FLAG_REQUIREMENTS.map((flag) => `${flag.label} (${flag.slug})`).join(", ")}, but mention only the ones the app actually uses. Say that ${HQ_FEATURE_FLAG_SUPPORT_EMAIL} can enable them for a named project space. This is non-blocking: do not create a document or invent another communication channel just for this note.`;
