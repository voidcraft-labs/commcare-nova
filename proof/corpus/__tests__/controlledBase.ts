/**
 * A base directory, laid out as `proof/hq-apps/<base>/` lays one out, made
 * of CommCare HQ's own retained answers for an app Nova published
 * (`proof/hq-reads/`): `navigation-base`'s source read, HQ's application
 * resource and version read for it (`proof/hq-reads/reading/`), and a lookup
 * table list (`proof/hq-reads/lookups/lookup-tables.json`), each copied byte
 * for byte. It is a base no lane run wrote, so the tests that read it hold
 * the emission's own handling of a base (what it copies, what it writes,
 * what it publishes over), never that a base is HQ's: the lane holds that
 * (`proof/matrix/test_retained.py`).
 *
 * `app.json` is the source answer's body, standing in for the stored app the
 * unit makes A of, which the emission copies and no reading reads. The hand
 * directory holds one value expectation on the registration form and its
 * restore.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKTREE } from "../emissionProcess";

/** The controlled base's id, its directory's name. */
export const CONTROLLED_BASE = "navigation-base";

const HQ_READS = join(WORKTREE, "proof", "hq-reads");

/** The value expectation the controlled base's hand directory holds. */
export const CONTROLLED_EXPECTATION = {
	id: "registration-opens",
	entry: "questions/text-input-xsd-string",
	form: { menu: 0, form: 0 },
	restore: "restore.xml",
	request: { expressions: ["1 + 1"] },
	expect: [{ pointer: "/values/0/value", value: "2" }],
} as const;

export const CONTROLLED_RESTORE = `<?xml version="1.0" encoding="UTF-8"?>
<OpenRosaResponse xmlns="http://openrosa.org/http/response"><message nature="ota_restore_success">Successfully restored account worker!</message></OpenRosaResponse>
`;

/**
 * Write the controlled base under `root/<id>/` and its hand directory under
 * `handRoot/<id>/`, authored under `flags` with case search off. Returns the
 * base's directory.
 */
export async function writeControlledBase(
	root: string,
	handRoot: string,
	flags: readonly string[] = [],
): Promise<string> {
	const directory = join(root, CONTROLLED_BASE);
	const hand = join(handRoot, CONTROLLED_BASE);
	await mkdir(directory, { recursive: true });
	await mkdir(hand, { recursive: true });
	await writeFile(
		join(directory, "base.json"),
		`${JSON.stringify(
			{
				id: CONTROLLED_BASE,
				configuration: {
					flags: [...flags].sort(),
					namedPrivileges: [],
					commcareVersion: "2.57.0",
					commtrack: false,
					syncCasesOnFormEntry: false,
					caseSearchEnabled: false,
				},
				declaration: "preselected",
				exhibits: [],
			},
			null,
			"\t",
		)}\n`,
	);
	for (const [from, to] of [
		["navigation-base/app-source.json", "app-source.json"],
		["reading/application.json", "application.json"],
		["reading/current-version.json", "current-version.json"],
		["lookups/lookup-tables.json", "lookup-tables.json"],
	] as const) {
		await copyFile(join(HQ_READS, from), join(directory, to));
	}
	/* HQ's source read re-mints every form's id (`Application.scrub_source`),
	 * and the stored app holds the ids HQ's application resource serves, so
	 * each form takes its id from that resource, by position. */
	const answerBody = async (name: string) =>
		JSON.parse(
			(
				JSON.parse(await readFile(join(HQ_READS, name), "utf8")) as {
					readonly body: string;
				}
			).body,
		);
	const app = await answerBody("navigation-base/app-source.json");
	const resource = await answerBody("reading/application.json");
	for (const [m, module] of app.modules.entries())
		for (const [f, form] of module.forms.entries())
			form.unique_id = resource.modules[m].forms[f].unique_id;
	await writeFile(join(directory, "app.json"), JSON.stringify(app));
	await writeFile(
		join(directory, "seed.json"),
		`${JSON.stringify(
			{ catalog: [], values: {}, userData: [], worker: { location: null } },
			null,
			"\t",
		)}\n`,
	);
	await writeFile(
		join(directory, "expected.json"),
		`${JSON.stringify(
			{
				reads: true,
				declaration: { runsOnlyOn: null, splitDatetime: false },
				claimed: [],
				firstPublish: [],
			},
			null,
			"\t",
		)}\n`,
	);
	await writeFile(
		join(hand, "expectations.json"),
		`${JSON.stringify([CONTROLLED_EXPECTATION], null, "\t")}\n`,
	);
	await writeFile(join(hand, "restore.xml"), CONTROLLED_RESTORE);
	return directory;
}
