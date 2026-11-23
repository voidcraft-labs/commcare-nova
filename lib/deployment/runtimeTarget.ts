// lib/deployment/runtimeTarget.ts
//
// Which project space a download is made for, as one pure rule.
//
// Pure, with no store import, so the two compile surfaces, the publish
// dialog's action and the proof capture read the same choice and the same
// copy. `downloadTarget.ts` applies it to the ledger.

import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import type { HeldBaseUrl } from "@/lib/commcare/targetFacts";

/** A project space this app's content is on, with the HQ app that holds it. */
export interface ReachedDeploymentTarget {
	readonly server: CommCareServer;
	readonly domain: string;
	readonly hqAppId: string;
	/**
	 * The target holds `USH_EMPTY_CASE_LIST_TEXT`, as the last publish read
	 * it: a `.ccz` made for it writes the empty-list text where HQ's build
	 * there does. False where no publish has read it.
	 */
	readonly emptyCaseListText: boolean;
	/**
	 * How many HQ apps the deployment held before the one it holds now. A
	 * `.ccz`'s version is the document's sequence plus this, so the file
	 * made after the target's HQ app was made afresh is newer to a phone.
	 */
	readonly earlierHqApps: number;
	/**
	 * The live app mapping is one Nova brought in: a `.ccz` made for it
	 * seeds no profile setting, as no publish there does.
	 */
	readonly adopted: boolean;
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
	/**
	 * For a `.ccz`: whether the app declares Android. A `.ccz` installs an
	 * app on Android and nothing else, so an app that does not declare it
	 * has none. The import file ignores it.
	 */
	readonly declaresAndroid: boolean;
}

export type DownloadTargetRefusalReason =
	| "unknown-project-space"
	| "pick-project-space"
	| "needs-published-project-space"
	| "selection-held-from-hq"
	| "project-search-target"
	| "domain-not-for-import-file"
	| "not-declared-for-android"
	| CczUnavailable["reason"];

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

/** Why an app that runs in Web Apps only has no CCZ. */
export const WEB_APPS_ONLY_HAS_NO_CCZ =
	"A CCZ installs this app on Android phones, and this app runs in Web Apps only, so it has no CCZ. If its workers use phones too, you can set it to run on Android as well, in App settings.";

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
 * Whether a project space's app keeps a custom base URL that sends its
 * phones to another address than the server it is published on: one that is
 * not exactly that server's own origin (`https`, the same host, its default
 * port, no user information). A base that is the server's own address sends
 * a phone nowhere else and refuses nothing.
 */
function sendsWorkersElsewhere(
	server: CommCareServer,
	held: HeldBaseUrl | null,
): held is HeldBaseUrl {
	if (held === null) return false;
	return held.origin !== new URL(COMMCARE_SERVERS[server].baseUrl).origin;
}

/**
 * Why a project space this app is published to has no `.ccz`: its app in
 * CommCare HQ keeps a custom base URL that sends phones to `host`. The one
 * reason a published space has none, so the publish dialog's list and the
 * download read the same value.
 */
export interface CczUnavailable {
	readonly reason: "workers-sent-elsewhere";
	/** The host the base names, never the user information before it. */
	readonly host: string;
}

/**
 * Whether a project space's app, in CommCare HQ, keeps a custom base URL
 * elsewhere, or null where it keeps none or keeps the server's own. Such a
 * setting is how CommCare HQ moves a project space's phones to another
 * environment: HQ's own build then signs workers in and sends their forms at
 * that address, while a `.ccz` from Nova always names the server the app is
 * published on (`lib/commcare/runtimeTarget.ts::profileServerProperties`), so
 * neither file is one Nova can stand behind and none is made.
 */
export function workersSentElsewhere(
	target: { readonly server: CommCareServer },
	held: HeldBaseUrl | null,
): CczUnavailable | null {
	if (!sendsWorkersElsewhere(target.server, held)) return null;
	return { reason: "workers-sent-elsewhere", host: held.host };
}

/**
 * A download's refusal of a `.ccz` for a project space that has none, as
 * the compile routes and MCP answer it. The sentence names the host, never
 * what is stored before it.
 */
export function cczUnavailableRefusal(
	target: ReachedDeploymentTarget,
	unavailable: CczUnavailable,
	reached: readonly ReachedDeploymentTarget[],
): DownloadTargetRefusal {
	const server = COMMCARE_SERVERS[target.server].label;
	return refused(
		unavailable.reason,
		`In CommCare HQ, this project space's app has a custom base URL, so phones that install it sign in and send forms at ${unavailable.host}. ` +
			`A CCZ from Nova signs workers in on the ${server} server, where this app is published, so there isn't one for "${target.domain}" while that setting is there. ` +
			"Workers can install the app from CommCare HQ. If the project space moved to another CommCare server, you can publish there and download its CCZ.",
		reached,
	);
}

/**
 * Why a project space has no `.ccz`, as the publish dialog says it beside
 * that space, before anyone chooses it.
 */
export function cczUnavailableLine(unavailable: CczUnavailable): string {
	return `Its app in CommCare HQ has a custom base URL that sends phones to ${unavailable.host}, so Nova doesn't make a CCZ for this project space. Workers can install the app from CommCare HQ.`;
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
	/* First, because no project space choice would change the answer. */
	if (!input.declaresAndroid) {
		return refused(
			"not-declared-for-android",
			WEB_APPS_ONLY_HAS_NO_CCZ,
			reached,
		);
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
		case "project-search-target":
		case "domain-not-for-import-file":
		case "not-declared-for-android":
		case "workers-sent-elsewhere":
			return [];
	}
}
