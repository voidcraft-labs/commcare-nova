import {
	type AuthoredXPathCarrier,
	authoredXPathCarriers,
	type XPathCarrierProfile,
	xpathCarrierAllowedInstanceIds,
} from "@/lib/commcare/xpath/carriers";
import {
	analyzeXPathCompatibility,
	analyzeXPathInstanceCompatibility,
	type XPathCompatibilityFinding,
} from "@/lib/commcare/xpath/compatibility";
import {
	inspectXPathFunctionCalls,
	type XPathFunctionCallCapability,
} from "@/lib/commcare/xpath/functionCapabilities";
import type { BlueprintDoc } from "@/lib/domain";

export interface XPathCarrierOccurrence extends AuthoredXPathCarrier {
	readonly calls: readonly XPathFunctionCallCapability[];
	readonly findings: readonly XPathCompatibilityFinding[];
}

export interface XPathCompatibilityAggregate {
	readonly profile: XPathCarrierProfile;
	readonly code: XPathCompatibilityFinding["code"];
	readonly severity: XPathCompatibilityFinding["severity"];
	readonly count: number;
}

export interface XPathCompatibilityScanSummary {
	readonly expressions: number;
	readonly functionCalls: number;
	readonly javaRosaLoweredCalls: number;
	readonly errorFindings: number;
	readonly findings: readonly XPathCompatibilityAggregate[];
}

/** Every persisted XPath carrier in a hydrated blueprint. */
export function scanBlueprintXPathCarriers(
	doc: BlueprintDoc,
): XPathCarrierOccurrence[] {
	return authoredXPathCarriers(doc).map((carrier) => ({
		...carrier,
		calls: inspectXPathFunctionCalls(carrier.source),
		findings: [
			...analyzeXPathCompatibility(carrier.source, carrier.profile),
			...analyzeXPathInstanceCompatibility(
				carrier.source,
				carrier.profile,
				xpathCarrierAllowedInstanceIds(carrier.profile),
			),
		],
	}));
}

/** Aggregate diagnostics without retaining app ids, carrier paths, or source. */
export function summarizeXPathCompatibility(
	occurrences: readonly XPathCarrierOccurrence[],
): XPathCompatibilityScanSummary {
	const aggregate = new Map<string, XPathCompatibilityAggregate>();
	let functionCalls = 0;
	let javaRosaLoweredCalls = 0;
	let errorFindings = 0;

	for (const occurrence of occurrences) {
		functionCalls += occurrence.calls.length;
		javaRosaLoweredCalls += occurrence.calls.filter(
			(call) => call.javaRosa === "lowered",
		).length;
		for (const finding of occurrence.findings) {
			if (finding.severity === "error") errorFindings += 1;
			const key = `${occurrence.profile}\u0000${finding.severity}\u0000${finding.code}`;
			const previous = aggregate.get(key);
			aggregate.set(key, {
				profile: occurrence.profile,
				code: finding.code,
				severity: finding.severity,
				count: (previous?.count ?? 0) + 1,
			});
		}
	}

	return {
		expressions: occurrences.length,
		functionCalls,
		javaRosaLoweredCalls,
		errorFindings,
		findings: [...aggregate.values()].sort(
			(a, b) =>
				a.profile.localeCompare(b.profile) ||
				a.severity.localeCompare(b.severity) ||
				a.code.localeCompare(b.code),
		),
	};
}

/** Fleet scans fail closed on either incompatibility or unreadable state. */
export function xpathCompatibilityScanShouldFail(
	summary: Pick<XPathCompatibilityScanSummary, "errorFindings">,
	unreadableApps: number,
): boolean {
	return summary.errorFindings > 0 || unreadableApps > 0;
}
