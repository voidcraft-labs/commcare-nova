import "server-only";

/**
 * The bring-in picker's list: the apps of one project space the caller's
 * stored key reaches, each with who already holds it in Nova.
 *
 * Four reads in order, and no write: the stored credentials, CommCare HQ's
 * app list, whether the project space's plan and the account let the key
 * read an app through HQ's API, then the claims Nova holds on the listed
 * apps. The API access check runs only after the list answered, because
 * `probeHqApiAccess` reads a 403 as the account's missing Access APIs on the
 * strength of that answer: a key that is no member's never reaches it.
 *
 * Every read that ends without a list is a stop, made by
 * `circumstanceFinding` at the app's place. A list row says nothing of
 * whether an app is linked, remote or built, so the picker shows the name
 * alone and the app's own read says the rest.
 */

import { listHqApps, probeHqApiAccess } from "@/lib/commcare/hq/apps";
import {
	classifyHqFailure,
	hqReadCircumstance,
} from "@/lib/commcare/hq/failure";
import { getHqCredentials } from "@/lib/db/settings";
import {
	circumstanceFinding,
	type HqAppClaimDetail,
	type HqPlace,
	type ReadCircumstance,
} from "@/lib/publish/hqFindings";
import { type HqAppClaimView, readHqAppClaims } from "../store";
import type { HqAppPicker } from "./pickerTypes";

/** Every stop the picker meets is about the app as a whole. */
const APP_PLACE: HqPlace = { kind: "app" };

function stop(code: ReadCircumstance): HqAppPicker {
	return { kind: "stop", finding: circumstanceFinding(code, APP_PLACE, {}) };
}

/** The view's claim with the id it was keyed by dropped. */
export function claimDetail(view: HqAppClaimView): HqAppClaimDetail {
	if (view.kind === "open") {
		return { kind: "open", appId: view.appId, appName: view.appName };
	}
	return { kind: "elsewhere", at: view.at, contact: view.contact };
}

/** The apps of `input.domain` the caller can choose from, or why there are none to show. */
export async function listHqAppsForPicker(
	actor: { readonly userId: string },
	input: { readonly domain: string },
): Promise<HqAppPicker> {
	const credentials = await getHqCredentials(actor.userId, input.domain);
	if (!credentials.ok) {
		if (credentials.error === "not_configured")
			return { kind: "not-connected" };
		/* The project spaces Nova holds for the stored key do not hold this
		 * one. That is the key's limit, not CommCare HQ's answer, so nothing is
		 * asked of HQ. */
		if (credentials.error === "not_authorized")
			return stop("key-cannot-reach-space");
		throw new Error(
			"listHqAppsForPicker asked for the credentials of one named project space and was told the choice is ambiguous, which a named project space cannot be. Look at lib/db/settings.ts::getHqCredentials.",
		);
	}
	const { creds } = credentials;
	const domain = credentials.domain.name;

	const listed = await listHqApps(creds, domain);
	if ("success" in listed)
		return stop(hqReadCircumstance(classifyHqFailure(listed, "app-list")));

	const access = await probeHqApiAccess(creds, domain);
	switch (access.kind) {
		case "plan-lacks-api-access":
			return stop("plan-lacks-api-access");
		case "account-lacks-access-apis":
			return stop("cannot-access-apis");
		case "failed":
			return stop(hqReadCircumstance(access.failure));
		case "available":
			break;
	}

	const claims = await readHqAppClaims({
		viewerUserId: actor.userId,
		seen: listed.seen,
	});
	const claimOf = new Map(
		claims.map((view) => [view.remoteAppId, claimDetail(view)]),
	);
	return {
		kind: "apps",
		server: creds.server,
		domain,
		apps: listed.listings.map((app) => ({
			remoteAppId: app.appId,
			name: app.name,
			claim: claimOf.get(app.appId) ?? null,
		})),
	};
}
