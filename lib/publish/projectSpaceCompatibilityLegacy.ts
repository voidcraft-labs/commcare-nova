/**
 * One-way rollout adapter for clients loaded before semantic compatibility.
 *
 * The old browser bundle and the currently released Nova plugin both require
 * the former response envelope. This projection keeps those clients operable
 * while deliberately refusing to reconstruct CommCare HQ's private setting
 * catalog: every legacy entry below is a semantic app capability, and its
 * `slug` is the same public capability id rather than an HQ setting name.
 * New code must consume `ProjectSpaceCompatibilityReport` directly.
 */

import type {
	ProjectSpaceCapabilityCheck,
	ProjectSpaceCompatibilityReport,
} from "./projectSpaceCompatibility";

interface LegacyCapabilityRequirement {
	readonly id: string;
	readonly slug: string;
	readonly label: string;
	readonly description: string;
	readonly required_for: string;
	readonly docs_url: string;
	readonly namespaces: readonly string[];
	readonly reasons: readonly string[];
}

export interface LegacyFeatureFlagCompatibilityReport {
	readonly verification:
		| "not_required"
		| "not_checked"
		| "verified"
		| "partial"
		| "unavailable";
	readonly target_domain?: string;
	readonly required_flags: readonly LegacyCapabilityRequirement[];
	readonly missing_flags: readonly LegacyCapabilityRequirement[];
	readonly unverified_flags: readonly LegacyCapabilityRequirement[];
	readonly support_email: string;
	readonly docs_url: string;
	readonly message: string;
}

function legacyRequirement(
	report: ProjectSpaceCompatibilityReport,
	capability: ProjectSpaceCapabilityCheck,
): LegacyCapabilityRequirement {
	return {
		id: capability.id,
		/* Required by the old decoder. This is a Nova capability id, never the
		 * private CommCare HQ setting used to prove it. */
		slug: capability.id,
		label: capability.label,
		description: capability.description,
		required_for: capability.reasons.join(" "),
		docs_url: `${report.docs_url}#${capability.id}`,
		namespaces: [],
		reasons: capability.reasons,
	};
}

/** Project the semantic report into the exact collection names old clients read. */
export function legacyFeatureFlagCompatibilityReport(
	report: ProjectSpaceCompatibilityReport,
): LegacyFeatureFlagCompatibilityReport {
	const byId = new Map(
		report.required_capabilities.map((capability) => [
			capability.id,
			legacyRequirement(report, capability),
		]),
	);
	const requirements = [...byId.values()];
	const missing = report.blockers
		.flatMap((blocker) =>
			blocker.state === "missing" ? [byId.get(blocker.id)] : [],
		)
		.filter((item): item is LegacyCapabilityRequirement => item !== undefined);
	const unverified = report.blockers
		.flatMap((blocker) =>
			blocker.state === "unverified" ? [byId.get(blocker.id)] : [],
		)
		.filter((item): item is LegacyCapabilityRequirement => item !== undefined);

	const verification: LegacyFeatureFlagCompatibilityReport["verification"] =
		report.status === "not_needed"
			? "not_required"
			: report.status === "not_checked"
				? "not_checked"
				: unverified.length === 0
					? "verified"
					: missing.length === 0 && unverified.length === requirements.length
						? "unavailable"
						: "partial";

	return {
		verification,
		...(report.target_domain === undefined
			? {}
			: { target_domain: report.target_domain }),
		required_flags: requirements,
		missing_flags: missing,
		unverified_flags: unverified,
		support_email: report.support_email,
		docs_url: report.docs_url,
		message: report.message,
	};
}
