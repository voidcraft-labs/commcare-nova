import type { CaseOperation } from "@/lib/domain";
import type { OrganizationView } from "@/lib/organization/useOrganization";

export type CaseOwnerAction = Exclude<CaseOperation["action"], "close">;

export function caseOwnerCopy(action: CaseOwnerAction): {
	readonly description: string;
	readonly clearLabel: string;
	readonly clearTitle: string;
	readonly clearConsequence: string;
} {
	return action === "create"
		? {
				description:
					"Ownership decides whose device the case reaches. Without this, a new case belongs to the person who submitted the form.",
				clearLabel: "Use the default owner",
				clearTitle: "Use the default owner?",
				clearConsequence: "The case will belong to whoever submits the form.",
			}
		: {
				description:
					"Ownership decides whose device the case reaches. Leave it unchanged to keep the case's current owner.",
				clearLabel: "Leave the owner alone",
				clearTitle: "Leave the owner alone?",
				clearConsequence: "This change will stop changing the case's owner.",
			};
}

type OrganizationReadState = Pick<
	OrganizationView,
	"loading" | "error" | "warning" | "refreshing"
>;

export function organizationOwnerModeIssue(
	organization: OrganizationReadState,
): string | undefined {
	if (organization.loading) return "Places are still loading.";
	if (organization.error !== undefined) return "Places could not be loaded.";
	if (organization.warning !== undefined || organization.refreshing) {
		return "Saved places are being refreshed.";
	}
	return undefined;
}

export function fixedOwnerModeIssue(
	organization: OrganizationReadState,
	candidateCount: number,
): string | undefined {
	return (
		organizationOwnerModeIssue(organization) ??
		(candidateCount === 0
			? "Add a live place at a level that owns cases first."
			: undefined)
	);
}

/** Copy for a controlled fixed-owner UUID while the row catalog is not yet an
 * authoritative answer. `undefined` means a completed read may truthfully use
 * LocationChoiceSelect's ordinary unavailable-state copy. */
export function pendingFixedOwnerLabel(
	organization: OrganizationReadState,
): string | undefined {
	if (organization.loading) return "Loading saved place";
	if (organization.error !== undefined) {
		return "Saved place unavailable until places reload";
	}
	if (organization.warning !== undefined || organization.refreshing) {
		return "Refreshing saved place";
	}
	return undefined;
}
