/**
 * The capture's local archive follows Nova's download for a project space
 * whose app in CommCare HQ keeps a custom base URL.
 *
 * Contract: `localCcz` makes no archive where the project space's app keeps a
 * custom base URL whose origin is not the server's own, and answers the
 * download's refusal (`workers-sent-elsewhere`, the host named and never the
 * user information before it), as `lib/deployment/downloadTarget.ts`
 * answers the browser and MCP; where the base is the server's own origin (in
 * any letter case, with its default port, with a path) or there is none, it
 * makes the archive, and the profile's three server URLs (`ota-restore-url`,
 * `PostURL`, `key_server`) are on the deployment's server. This is what the
 * base `hq-kept-settings`, which keeps a second origin, states in place of
 * its archive (`entryWriter.ts`, `inputs.ts::LOCAL_REFUSED`), and what its
 * variant `hq-kept-settings/custom-base-url-on-the-server-s-own-origin`
 * reads at the server's own origin.
 *
 * The plausible failures: a capture that makes an archive Nova's download
 * refuses, so the lane judges a file no worker can have; one that refuses at
 * the server's own address; and an archive that names the custom base where
 * it is made.
 */

import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { expect, it } from "vitest";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { targetFactsFromSource } from "@/lib/commcare/targetFacts";
import { parseXml } from "@/lib/commcare/xmlParse";
import { clinicVisitsDocument } from "@/lib/deployment/__tests__/publishFixtures";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	localCcz,
	PROOF_DOMAIN,
	PROOF_SERVER,
	type PublishDocument,
} from "../publish";

const DOCUMENT: PublishDocument = {
	id: "clinic-visits",
	doc: toPersistableDoc(clinicVisitsDocument()),
	compiledAtSeq: 1,
};

const SERVER = COMMCARE_SERVERS[PROOF_SERVER].baseUrl;

/** What the project space keeps, as a stored baseline of its app's source gives it. */
function keeping(customBaseUrl: string | undefined) {
	return targetFactsFromSource(
		{
			langs: ["en"],
			...(customBaseUrl !== undefined && { custom_base_url: customBaseUrl }),
		},
		{
			observedAt: "2026-11-01T00:00:00.000Z",
			novaOwnsAutoGpsCapture: false,
			adopted: false,
		},
	);
}

function elements(parent: { readonly children: readonly unknown[] }) {
	return parent.children.filter((child): child is Element =>
		isTag(child as Element),
	);
}

/** Each `<property>` of an archive's profile, by its key. */
function profileProperties(archive: Buffer): ReadonlyMap<string, string> {
	const bytes = new AdmZip(archive).readFile("profile.ccpr");
	if (bytes === null) throw new Error("The archive holds no profile.ccpr.");
	const [profile] = elements(parseXml(bytes.toString("utf8"))).filter(
		(element) => element.name === "profile",
	);
	if (profile === undefined) throw new Error("profile.ccpr holds no profile.");
	return new Map(
		elements(profile)
			.filter((element) => element.name === "property")
			.map((element) => [
				element.attribs.key ?? "",
				element.attribs.value ?? "",
			]),
	);
}

it.each([
	["https://example.org/hq/", "example.org"],
	["https://worker:secret@example.org/", "example.org"],
	["http://www.commcarehq.org/", "www.commcarehq.org"],
	["https://www.commcarehq.org:8443/", "www.commcarehq.org:8443"],
	["https://india.commcarehq.org/", "india.commcarehq.org"],
])(
	"makes no archive for a project space whose app sends phones to %s, and answers the download's refusal",
	async (base, host) => {
		const answer = await localCcz(DOCUMENT, PROOF_DOMAIN, undefined, {
			targetFacts: keeping(base),
		});
		expect(answer).toEqual({
			refused: { reason: "workers-sent-elsewhere", host },
		});
	},
);

it.each([
	"https://www.commcarehq.org/",
	"https://WWW.CommCareHQ.org:443/hq/",
	undefined,
])(
	"makes the archive where the custom base URL is %s, every server URL on the deployment's server",
	async (base) => {
		const archive = await localCcz(DOCUMENT, PROOF_DOMAIN, undefined, {
			targetFacts: keeping(base),
		});
		if (!Buffer.isBuffer(archive))
			throw new Error(`No archive was made: ${JSON.stringify(archive)}`);
		const properties = profileProperties(archive);
		for (const key of ["ota-restore-url", "PostURL", "key_server"]) {
			const url = properties.get(key);
			expect(
				url?.startsWith(`${SERVER}/a/${PROOF_DOMAIN}/`),
				`${key}: ${url}`,
			).toBe(true);
		}
	},
);
