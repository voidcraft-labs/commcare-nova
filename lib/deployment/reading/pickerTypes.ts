/**
 * What the bring-in picker is answered: the apps of one project space, each
 * with who holds it in Nova, or why there is no list to show.
 *
 * Client-safe: it imports types alone.
 */

import type { CommCareServer } from "@/lib/commcare/servers";
import type {
	CircumstanceFinding,
	HqAppClaimDetail,
} from "@/lib/publish/hqFindings";

export interface HqAppPickerRow {
	readonly remoteAppId: string;
	/** CommCare HQ's name for the app. May be empty. */
	readonly name: string;
	/** Who holds it in Nova, or null where it is free. */
	readonly claim: HqAppClaimDetail | null;
}

export type HqAppPicker =
	| {
			readonly kind: "apps";
			readonly server: CommCareServer;
			readonly domain: string;
			readonly apps: readonly HqAppPickerRow[];
	  }
	/** The caller has no CommCare HQ connection at all. */
	| { readonly kind: "not-connected" }
	/** A read of CommCare HQ ended at a circumstance whose standing is `stop`. */
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding };
