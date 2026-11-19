/**
 * The emission's `hq-authored` source over `hq-plain`, the one base a person
 * also wrote by hand (`proof/matrix/hand/hq-plain/document.ts`), from what
 * its builder authors and the reader's rules, never from a reading.
 *
 * Contract: Nova's reading of the retained base is the hand-written
 * document, compared by external key (a read back under a resolver over the
 * hand-written document's identities, `externalIdentityMap`, so each thing
 * the reading holds takes the hand-written UUID of the thing HQ keys alike),
 * and the hand-written document names exactly one identity row for each
 * menu and form of HQ's app. The plausible failures: a reader that
 * misreads a shape the base holds the same way every time, which neither
 * acceptance nor proof 6 can see since such a misreading reads back to
 * itself; and a hand-written document whose identity rows leave a menu or
 * form of HQ's app out, so the read back keys it to nothing.
 *
 * The base is written by a lane run (`proof/matrix/test_retained.py`) and
 * adopted into `proof/hq-apps/hq-plain/`; a tree without it fails here by
 * name. The message for a missing identity row is held over a base laid out from HQ's retained
 * answers for an app Nova published (`./controlledBase.ts`), and the
 * hand-written document and its edit are held to Nova's commit gate, which
 * needs no base.
 *
 * A base's document carries its Project's lookup data as a bring-in leaves
 * it. Contract: a base whose form reads a lookup table gives D that table,
 * with HQ's rows, managed in CommCare HQ from the base's project space under
 * the id HQ gave it, and D is admitted under it; a base that reads none
 * gives none. The plausible failures: a document with no lookup data, whose
 * republish would push a workbook over HQ's own table and whose local
 * archive and restores carry no rows; and tables with no CommCare HQ origin,
 * which a publish to that project space sends again as Nova's own.
 */

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { retainedBodyText } from "@/__tests__/helpers/retainedHqReads";
import type { WireIdentityOverride } from "@/lib/commcare/wireIdentity";
import {
	counterOf,
	FIXTURE_TABLE_ID,
	fixtureResource,
} from "@/lib/deployment/reading/__tests__/adoptionFixture";
import { readBackDifferences } from "@/lib/deployment/reading/readBack";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { LANE_BROUGHT_IN_AT, readForLane } from "@/proof/reader/laneReading";
import { LANE_TARGET } from "@/proof/reader/retainedPeer";
import {
	BASE,
	document,
	handDocument,
} from "../../matrix/hand/hq-plain/document";
import { edit } from "../../matrix/hand/hq-plain/edit";
import { lookupContextOf, storedDocument } from "../documents";
import { hydrateAdmittedDocument } from "../editBatches";
import { WORKTREE } from "../emissionProcess";
import {
	BaseSetAside,
	HQ_APPS,
	hqAuthoredDocument,
	hqAuthoredDocuments,
	laneInputFor,
	loadRetainedHqApp,
} from "../hqAuthored";
import { CONTROLLED_BASE, writeControlledBase } from "./controlledBase";

/** A reading of a base, and the readings of `hq-plain`, are about a second each, more under load. */
const BUDGET_MS = 60_000;

interface StoredApp {
	readonly modules?: readonly {
		readonly unique_id?: string;
		readonly forms?: readonly { readonly unique_id?: string }[];
	}[];
}

/**
 * The message for identity rows a hand-written document names that leave a
 * menu or a form of HQ's stored app without exactly one row; null where each has
 * one.
 */
function identityRowsMissing(
	base: string,
	app: StoredApp,
	identity: readonly WireIdentityOverride[],
): string | null {
	const held: { readonly what: string; readonly uniqueId: string }[] = [];
	for (const [m, module] of (app.modules ?? []).entries()) {
		held.push({ what: `menu ${m}`, uniqueId: module.unique_id ?? "" });
		for (const [f, form] of (module.forms ?? []).entries())
			held.push({ what: `form ${m}.${f}`, uniqueId: form.unique_id ?? "" });
	}
	const missing = held.filter(
		(entity) =>
			identity.filter((row) => row.uniqueId === entity.uniqueId).length !== 1,
	);
	if (missing.length === 0 && identity.length === held.length) return null;
	return `The hand-written document for ${base} names ${identity.length} menus and forms, and CommCare HQ's app holds ${held.length}. Each menu and form of proof/hq-apps/${base}/app.json needs exactly one identity row in proof/matrix/hand/${base}/document.ts. The ones without a row: ${missing.map((entity) => `${entity.what} (${entity.uniqueId})`).join(", ")}.`;
}

it(
	"reads hq-plain as the document a person wrote from its builder, by external key, with one identity row a menu and form",
	async () => {
		const root = join(WORKTREE, HQ_APPS);
		if (!existsSync(join(root, BASE)))
			throw new Error(
				`proof/hq-apps/${BASE}/ does not exist, and the hand-written document is held to Nova's reading of it. A lane run writes it (proof/matrix/test_retained.py); copy it in with python3 -m proof.matrix.adopt over that run's output.`,
			);
		const app = loadRetainedHqApp(BASE);
		const hand = document();
		const stored = JSON.parse(
			readFileSync(join(app.directory, "app.json"), "utf8"),
		) as StoredApp;
		const uncovered = identityRowsMissing(BASE, stored, hand.identity);
		if (uncovered !== null) throw new Error(uncovered);

		const reading = await readForLane({
			appId: BASE,
			document: {
				doc: storedDocument(hand.doc),
				hqAuthored: { identity: hand.identity },
			},
			source: app.source,
			application: app.application,
			currentVersion: app.currentVersion,
			...(app.projectSpaces !== undefined && {
				projectSpaces: app.projectSpaces,
			}),
			identity: "match",
			claims: "counts",
		});
		if (reading.kind !== "read")
			throw new Error(
				`Nova's reading of ${BASE} is no document: ${JSON.stringify(reading)}`,
			);
		expect(
			readBackDifferences(hand.doc, { doc: reading.doc, choices: null }),
		).toEqual([]);

		// The emission's own first reading ties the same menus and forms to HQ's ids.
		const first = await readForLane(laneInputFor(app));
		if (first.kind !== "read")
			throw new Error(`The first reading of ${BASE} is no document.`);
		const ids = (rows: readonly WireIdentityOverride[]) =>
			rows
				.map((row) => `${row.entityKind} ${row.uniqueId} ${row.xmlns}`)
				.sort();
		expect(ids(first.identity)).toEqual(ids(hand.identity));
	},
	BUDGET_MS,
);

it(
	"names each menu and form of HQ's app a hand-written document gives no identity row",
	async () => {
		const scratch = await mkdtemp(join(tmpdir(), "nova-hq-authored-rows-"));
		try {
			const root = join(scratch, "hq-apps");
			await writeControlledBase(root, join(scratch, "hand"));
			const app = loadRetainedHqApp(CONTROLLED_BASE, root);
			const stored = JSON.parse(
				readFileSync(join(app.directory, "app.json"), "utf8"),
			) as StoredApp;
			const reading = await readForLane(laneInputFor(app));
			if (reading.kind !== "read")
				throw new Error(`The controlled base read to ${reading.kind}.`);
			expect(
				identityRowsMissing(CONTROLLED_BASE, stored, reading.identity),
			).toBeNull();
			const module = stored.modules?.[0];
			const form = module?.forms?.[1];
			if (module?.unique_id === undefined || form?.unique_id === undefined)
				throw new Error("The controlled base holds no second form.");
			const short = reading.identity.filter(
				(row) => row.uniqueId !== form.unique_id,
			);
			expect(identityRowsMissing(CONTROLLED_BASE, stored, short)).toBe(
				`The hand-written document for ${CONTROLLED_BASE} names 2 menus and forms, and CommCare HQ's app holds 3. Each menu and form of proof/hq-apps/${CONTROLLED_BASE}/app.json needs exactly one identity row in proof/matrix/hand/${CONTROLLED_BASE}/document.ts. The ones without a row: form 0.1 (${form.unique_id}).`,
			);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	},
	BUDGET_MS,
);

/** A base whose one form takes its choices from CommCare HQ's lookup table `district`. */
const LOOKUP_BASE = "lookup-base";

/**
 * Write `LOOKUP_BASE` under `root`: `targeted-hq-side-lookup`'s source read,
 * table list and rows of `district`, each copied byte for byte, with the
 * application resource HQ summarizes that source as and its version read
 * (`lib/deployment/reading/__tests__/adoptionFixture.ts`).
 */
async function writeLookupBase(root: string): Promise<void> {
	const directory = join(root, LOOKUP_BASE);
	await mkdir(directory, { recursive: true });
	const json = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;
	await writeFile(
		join(directory, "base.json"),
		json({
			id: LOOKUP_BASE,
			configuration: {
				flags: [],
				namedPrivileges: [],
				commcareVersion: "2.57.0",
				commtrack: false,
				syncCasesOnFormEntry: false,
				caseSearchEnabled: false,
			},
			declaration: "preselected",
			exhibits: [],
		}),
	);
	const reads = join(WORKTREE, "proof", "hq-reads", "targeted-hq-side-lookup");
	for (const name of [
		"app-source.json",
		"lookup-tables.json",
		"fixture-rows-district.json",
	])
		await copyFile(join(reads, name), join(directory, name));
	const resource = fixtureResource();
	for (const [answer, name] of [
		[resource, "application.json"],
		[counterOf(resource), "current-version.json"],
	] as const)
		await writeFile(
			join(directory, name),
			json({
				status: answer.status,
				headers: answer.headers,
				body: retainedBodyText(answer),
			}),
		);
	await writeFile(
		join(directory, "expected.json"),
		json({
			reads: true,
			declaration: { runsOnlyOn: null, splitDatetime: false },
			claimed: [],
			firstPublish: [],
		}),
	);
}

it(
	"gives a base that reads a lookup table its table as the birth leaves it: HQ's rows, managed in CommCare HQ from the base's project space",
	async () => {
		const scratch = await mkdtemp(join(tmpdir(), "nova-hq-authored-lookup-"));
		try {
			const root = join(scratch, "hq-apps");
			await writeLookupBase(root);
			const app = loadRetainedHqApp(LOOKUP_BASE, root);
			const base = await hqAuthoredDocument(app, join(scratch, "hand"));
			const lookup = base.lookup;
			if (lookup === undefined)
				throw new Error(
					"The base's document holds no lookup data, though its form reads a table.",
				);
			const rows = JSON.parse(
				JSON.parse(
					readFileSync(
						join(app.directory, "fixture-rows-district.json"),
						"utf8",
					),
				).body,
			) as { readonly objects: readonly unknown[] };
			const [table] = lookup.definitions;
			expect(lookup.definitions.map((one) => one.tag)).toEqual(["district"]);
			expect(table?.hq).toEqual({
				server: LANE_TARGET.server,
				domain: LANE_TARGET.domain,
				remoteId: FIXTURE_TABLE_ID,
				managedBy: "commcare-hq",
				broughtInAt: LANE_BROUGHT_IN_AT,
				takenOverAt: null,
				takenOverBy: null,
				refreshedAt: LANE_BROUGHT_IN_AT,
				goneColumnIds: [],
			});
			expect(
				table === undefined ? undefined : lookup.rowsByTable.get(table.id),
			).toHaveLength(rows.objects.length);
			// The document's reads name the table and its columns: Nova's validator
			// and its gate admit it under this lookup data.
			const doc = hydrateAdmittedDocument(base);
			expect(mutationCommitVerdict(doc, [], lookupContextOf(lookup)).ok).toBe(
				true,
			);
			// A base whose app reads no table holds none.
			await writeControlledBase(root, join(scratch, "hand"));
			const plain = await hqAuthoredDocument(
				loadRetainedHqApp(CONTROLLED_BASE, root),
				join(scratch, "hand"),
			);
			expect(plain.lookup).toBeUndefined();
			expect(plain.hqAuthored?.keyedCaseIds).toEqual([]);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	},
	BUDGET_MS,
);

/** The controlled base copied as `id`, its source answer's app changed by `change`. */
async function writeChangedBase(
	root: string,
	id: string,
	change: (app: Record<string, unknown>) => void,
): Promise<void> {
	const from = join(root, CONTROLLED_BASE);
	const directory = join(root, id);
	await mkdir(directory, { recursive: true });
	for (const name of [
		"application.json",
		"current-version.json",
		"lookup-tables.json",
		"expected.json",
	])
		await copyFile(join(from, name), join(directory, name));
	const base = JSON.parse(readFileSync(join(from, "base.json"), "utf8"));
	await writeFile(
		join(directory, "base.json"),
		`${JSON.stringify({ ...base, id }, null, "\t")}\n`,
	);
	const answer = JSON.parse(
		readFileSync(join(from, "app-source.json"), "utf8"),
	);
	const app = JSON.parse(answer.body) as Record<string, unknown>;
	change(app);
	await writeFile(
		join(directory, "app-source.json"),
		`${JSON.stringify({ ...answer, body: JSON.stringify(app) }, null, "\t")}\n`,
	);
}

/*
 * Contract: a base Nova's reading takes no document of is set aside by name,
 * and the rest of the corpus's bases are still read, so the lane runs and
 * authors that base again instead of the emission stopping before any test
 * (`hqAuthored.ts::hqAuthoredDocuments`). The plausible failures: a refused
 * base that stops the emission (the lane then cannot author it again), one
 * dropped with no notice (a run that quietly lacks a base), and a broken
 * retained tree set aside as though the reader had refused it.
 */
it(
	"sets aside a base its reading refuses, naming it, reads the others, and stops on a base it cannot read at all",
	async () => {
		const scratch = await mkdtemp(join(tmpdir(), "nova-hq-authored-aside-"));
		try {
			const root = join(scratch, "hq-apps");
			const hand = join(scratch, "hand");
			await writeControlledBase(root, hand);
			await writeChangedBase(root, "refused-base", (app) => {
				app.doc_type = "LinkedApplication";
			});
			await expect(
				hqAuthoredDocument(loadRetainedHqApp("refused-base", root), hand),
			).rejects.toBeInstanceOf(BaseSetAside);
			const part = await hqAuthoredDocuments(root, hand);
			expect(part.documents.map((one) => one.id)).toEqual([CONTROLLED_BASE]);
			expect(
				part.setAside.map(({ base, reading }) => ({ base, reading })),
			).toEqual([{ base: "refused-base", reading: "account" }]);
			const [aside] = part.setAside;
			expect(aside?.notice).toContain(
				"The corpus sets the base refused-base aside. The base refused-base did not come in:",
			);
			expect(aside?.notice).toContain(
				"proof/matrix/test_retained.py[refused-base]",
			);
			// A retained directory that cannot be read is no refusal of the reader's: it stops the emission.
			await rm(join(root, "refused-base", "app-source.json"));
			await expect(hqAuthoredDocuments(root, hand)).rejects.toThrow(
				/refused-base holds no readable app-source\.json/,
			);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	},
	BUDGET_MS,
);

it("holds the hand-written document of hq-plain and its edit to Nova's commit gate", () => {
	const doc = handDocument();
	const born = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
	if (!born.ok)
		throw new Error(
			`Nova's gate refuses the hand-written document of ${BASE}: ${born.findings.map((finding) => finding.code).join(", ")}`,
		);
	const edited = mutationCommitVerdict(
		doc,
		edit(doc),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!edited.ok)
		throw new Error(
			`Nova's gate refuses the edit of ${BASE}: ${edited.findings.map((finding) => finding.code).join(", ")}`,
		);
	expect(edited.mutations.length).toBeGreaterThan(0);
});
