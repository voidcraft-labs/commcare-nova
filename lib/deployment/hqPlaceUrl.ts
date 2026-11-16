/**
 * The page of CommCare HQ that holds a place in an app, for a link a person
 * follows in their own CommCare HQ session. Nova sends no credential with it.
 *
 * A place holds positions in HQ's lists and not ids, so a menu and a form are
 * linked by HQ's position addresses (`apps/view/<app>/modules-<n>/` and
 * `…/modules-<n>/forms-<m>/`), which HQ keeps on purpose
 * (`corehq/apps/app_manager/views/modules.py::view_module_legacy`,
 * `views/forms.py::view_form_legacy`: "PLEASE DO NOT DELETE"). Its view parses
 * each index from the address (`view_generic.py::_get_module_and_form`).
 *
 * Client-safe: its one run-time import is the server table, which is plain data.
 * Components reach it through `@/lib/deployment`, since they may not import
 * `lib/commcare`.
 */

import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import type { HqPlace } from "@/lib/publish/hqFindings";

/** The page of CommCare HQ that holds a place, or null where there is no one page. */
export function hqPlaceUrl(
	target: {
		readonly server: CommCareServer;
		readonly domain: string;
		readonly remoteAppId: string;
	},
	place: HqPlace,
): string | null {
	const space = `${COMMCARE_SERVERS[target.server].baseUrl}/a/${encodeURIComponent(target.domain)}`;
	const app = `${space}/apps/view/${encodeURIComponent(target.remoteAppId)}`;
	switch (place.kind) {
		case "app":
			return `${app}/`;
		case "app-settings":
			return `${app}/settings/`;
		case "languages":
			return `${app}/languages/`;
		case "menu":
		case "case-list":
		case "case-detail":
		case "search":
			return `${app}/modules-${place.menu}/`;
		case "form":
		case "question":
			return `${app}/modules-${place.menu}/forms-${place.form}/`;
		case "lookup-table":
			return `${space}/fixtures/`;
		case "organization":
			return `${space}/settings/locations/list/`;
		case "media":
			return null;
	}
}
