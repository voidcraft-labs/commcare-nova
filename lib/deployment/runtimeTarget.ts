// lib/deployment/runtimeTarget.ts
//
// Which project space a download is made for, as one pure rule.
//
// Pure, with no store import, so the two compile surfaces, the publish
// dialog's action and the proof capture read the same choice and the same
// copy. `downloadTarget.ts` applies it to the ledger.

import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";

/** A project space this app's content is on, with the HQ app that holds it. */
export interface ReachedDeploymentTarget {
	readonly server: CommCareServer;
	readonly domain: string;
	readonly hqAppId: string;
}

export interface DownloadTargetInput {
	readonly format: "ccz" | "json";
	readonly server?: CommCareServer;
	readonly domain?: string;
	/**
	 * For a `.ccz` with no reached deployment: one line per selection of the
	 * document that CommCare HQ cannot take. Absent or empty where there is none.
	 */
	readonly heldFromHq?: readonly string[];
}

export type DownloadTargetRefusalReason =
	| "unknown-project-space"
	| "pick-project-space"
	| "needs-published-project-space"
	| "selection-held-from-hq"
	| "domain-not-for-import-file";

export type DownloadTargetChoice =
	| {
			readonly kind: "project-space";
			readonly target: ReachedDeploymentTarget;
	  }
	/** Only for the import file: no reached deployment scopes its attachment links. */
	| { readonly kind: "none" }
	| {
			readonly kind: "refused";
			readonly reason: DownloadTargetRefusalReason;
			readonly message: string;
			readonly reached: readonly ReachedDeploymentTarget[];
			/** The lines of `selection-held-from-hq`; empty for every other reason. */
			readonly heldFromHq: readonly string[];
	  };

export type DownloadTargetRefusal = Extract<
	DownloadTargetChoice,
	{ kind: "refused" }
>;

const CCZ_SIGNS_IN =
	"A CCZ signs workers in to one project space and sends their forms there";

/** Why an app published nowhere has no CCZ yet. */
export const NEEDS_PUBLISHED_PROJECT_SPACE = `${CCZ_SIGNS_IN}, so it is made for a project space this app is published to. Once the app is published, you can download the CCZ for that space.`;

const PICK_PROJECT_SPACE = `${CCZ_SIGNS_IN}. This app is published to several, so you can pick the one this CCZ is for.`;

const DOMAIN_NOT_FOR_IMPORT_FILE =
	"The CommCare HQ import file works in any project space, so it isn't made for one. You can download it again without a project space.";

/** Why an app CommCare HQ cannot take as it stands has no CCZ yet. */
export const SELECTION_HELD_FROM_HQ = `${CCZ_SIGNS_IN}, so it is made for a project space this app is published to. This app can't be published to CommCare HQ as it is, so it has no CCZ yet.`;

function unknownProjectSpace(domain?: string, server?: CommCareServer): string {
	const label =
		server === undefined ? undefined : COMMCARE_SERVERS[server].label;
	const named =
		domain === undefined
			? `a project space on ${label}`
			: label === undefined
				? `"${domain}"`
				: `"${domain}" on ${label}`;
	return `This app isn't published to ${named}, so there's no CCZ for it there. You can pick one of the project spaces it's published to.`;
}

function refused(
	reason: DownloadTargetRefusalReason,
	message: string,
	reached: readonly ReachedDeploymentTarget[],
	heldFromHq: readonly string[] = [],
): DownloadTargetRefusal {
	return { kind: "refused", reason, message, reached, heldFromHq };
}

/**
 * Choose the reached deployment a download is made for.
 *
 * A `.ccz` is always made for exactly one: the one the inputs name, or the
 * only one there is. The HQ import file is made for none; a reached
 * deployment only scopes its attachment links, and only when `server`
 * leaves exactly one.
 */
export function chooseDownloadTarget(
	reached: readonly ReachedDeploymentTarget[],
	input: DownloadTargetInput,
): DownloadTargetChoice {
	const { server, domain } = input;
	if (input.format === "json") {
		if (domain !== undefined) {
			return refused(
				"domain-not-for-import-file",
				DOMAIN_NOT_FOR_IMPORT_FILE,
				reached,
			);
		}
		const onServer = reached.filter(
			(target) => server === undefined || target.server === server,
		);
		const only = onServer.length === 1 ? onServer[0] : undefined;
		return only === undefined
			? { kind: "none" }
			: { kind: "project-space", target: only };
	}
	if (reached.length === 0) {
		const held = input.heldFromHq ?? [];
		return held.length > 0
			? refused("selection-held-from-hq", SELECTION_HELD_FROM_HQ, reached, held)
			: refused(
					"needs-published-project-space",
					NEEDS_PUBLISHED_PROJECT_SPACE,
					reached,
				);
	}
	const candidates = reached.filter(
		(target) =>
			(server === undefined || target.server === server) &&
			(domain === undefined || target.domain === domain),
	);
	const only = candidates.length === 1 ? candidates[0] : undefined;
	if (only !== undefined) return { kind: "project-space", target: only };
	return candidates.length === 0
		? refused(
				"unknown-project-space",
				unknownProjectSpace(domain, server),
				reached,
			)
		: refused("pick-project-space", PICK_PROJECT_SPACE, reached);
}

/** How a project space reads in a list: `<domain> on <server label>`. */
export function projectSpaceLabel(target: {
	readonly server: CommCareServer;
	readonly domain: string;
}): string {
	return `${target.domain} on ${COMMCARE_SERVERS[target.server].label}`;
}

/**
 * The lines a refusal lists under its message: the selections CommCare HQ
 * cannot take, every reached deployment where the person picks one, and
 * nothing where there is nothing to pick from.
 */
export function downloadRefusalLines(refusal: DownloadTargetRefusal): string[] {
	switch (refusal.reason) {
		case "selection-held-from-hq":
			return [...refusal.heldFromHq];
		case "pick-project-space":
		case "unknown-project-space":
			return refusal.reached.map(projectSpaceLabel);
		case "needs-published-project-space":
		case "domain-not-for-import-file":
			return [];
	}
}
