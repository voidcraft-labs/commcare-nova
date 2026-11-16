/**
 * The links an account of a reading gives into CommCare HQ. The plausible
 * failures: a link to another server's host, a position address written with
 * an index the place does not carry (`modules-undefined`), and a place kind
 * with no address decided for it.
 */
import { describe, expect, it } from "vitest";
import {
	COMMCARE_SERVER_IDS,
	COMMCARE_SERVERS,
	type CommCareServer,
} from "@/lib/commcare/servers";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { hqPlaceUrl } from "../hqPlaceUrl";

type PlaceKind = HqPlace["kind"];

/** One place of each kind at index 0, and the address after the server's base. */
const PLACES = {
	app: { place: { kind: "app" }, path: "/a/demo-space/apps/view/abc123/" },
	"app-settings": {
		place: { kind: "app-settings" },
		path: "/a/demo-space/apps/view/abc123/settings/",
	},
	languages: {
		place: { kind: "languages" },
		path: "/a/demo-space/apps/view/abc123/languages/",
	},
	menu: {
		place: { kind: "menu", menu: 0, name: "Patients" },
		path: "/a/demo-space/apps/view/abc123/modules-0/",
	},
	"case-list": {
		place: { kind: "case-list", menu: 0, name: "Patients" },
		path: "/a/demo-space/apps/view/abc123/modules-0/",
	},
	"case-detail": {
		place: { kind: "case-detail", menu: 0, name: "Patients" },
		path: "/a/demo-space/apps/view/abc123/modules-0/",
	},
	search: {
		place: { kind: "search", menu: 0, name: "Patients" },
		path: "/a/demo-space/apps/view/abc123/modules-0/",
	},
	form: {
		place: {
			kind: "form",
			menu: 0,
			form: 0,
			menuName: "Patients",
			name: "Register",
		},
		path: "/a/demo-space/apps/view/abc123/modules-0/forms-0/",
	},
	question: {
		place: {
			kind: "question",
			menu: 0,
			form: 0,
			menuName: "Patients",
			formName: "Register",
			path: "age",
		},
		path: "/a/demo-space/apps/view/abc123/modules-0/forms-0/",
	},
	"lookup-table": {
		place: { kind: "lookup-table", tag: "districts" },
		path: "/a/demo-space/fixtures/",
	},
	media: {
		place: { kind: "media", path: "jr://file/commcare/image/logo.png" },
		path: null,
	},
	organization: {
		place: { kind: "organization" },
		path: "/a/demo-space/settings/locations/list/",
	},
} as const satisfies {
	readonly [K in PlaceKind]: {
		readonly place: HqPlace & { readonly kind: K };
		readonly path: string | null;
	};
};

function target(server: CommCareServer) {
	return { server, domain: "demo-space", remoteAppId: "abc123" };
}

describe("hqPlaceUrl", () => {
	for (const server of COMMCARE_SERVER_IDS) {
		it(`gives every place's page on ${server}'s own host`, () => {
			const base = COMMCARE_SERVERS[server].baseUrl;
			for (const [kind, { place, path }] of Object.entries(PLACES)) {
				const url = hqPlaceUrl(target(server), place);
				expect(url, kind).toBe(path === null ? null : `${base}${path}`);
				if (url !== null) {
					expect(new URL(url).host, kind).toBe(COMMCARE_SERVERS[server].host);
					expect(url, kind).not.toContain("undefined");
				}
			}
		});
	}

	it("writes the positions a menu and a form carry, not the first one", () => {
		expect(
			hqPlaceUrl(target("production"), {
				kind: "question",
				menu: 3,
				form: 12,
				menuName: "Visits",
				formName: "Follow up",
				path: "group/age",
			}),
		).toBe(
			"https://www.commcarehq.org/a/demo-space/apps/view/abc123/modules-3/forms-12/",
		);
		expect(
			hqPlaceUrl(target("eu"), { kind: "search", menu: 7, name: "Visits" }),
		).toBe(
			"https://eu.commcarehq.org/a/demo-space/apps/view/abc123/modules-7/",
		);
	});
});
