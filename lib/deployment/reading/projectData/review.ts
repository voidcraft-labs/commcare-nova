/**
 * What a bring-in's review shows of project data: each table the app reads,
 * with the question a table that meets a Project table asks, and the places
 * the app will hold.
 *
 * Pure.
 */

import {
	buildLookupFixtures,
	type CompiledLookupFixture,
	MAX_LOOKUP_FIXTURE_BYTES,
	MAX_LOOKUP_FIXTURE_CELLS,
	MAX_LOOKUP_FIXTURE_ROWS,
} from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { lookupSelectSourceRowFindings } from "@/lib/commcare/lookup/selectSourceRows";
import type { IdentityResolver } from "@/lib/commcare/reader/identity";
import type { BlueprintDoc } from "@/lib/domain";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import {
	bornPlaces,
	keptColumnsOf,
	type ReaderProjectDataReads,
	type ReadingLookupTable,
	type ReadingProjectData,
	underTableChoices,
} from "./index";
import {
	type LookupTableStanding,
	lookupTableStanding,
	readingLookupSnapshot,
} from "./lookupTables";
import type {
	LookupChoiceOffer,
	LookupTableChoice,
	ReviewPlaces,
	ReviewTable,
} from "./reviewTypes";

type ChoiceStanding = Extract<LookupTableStanding, { readonly kind: "choice" }>;

/** The offer `use-project` takes where the app could not be born on the Project's table. */
const FAILS_A_PROJECT_SPACE_RULE: LookupChoiceOffer = {
	offered: false,
	why: "fails-a-project-space-rule",
	name: null,
};

/** Code-unit order: the same answer on every machine, unlike a locale's. */
function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Each table's compiled fixture in `snapshot`, by its id. */
function fixturesOf(
	snapshot: LookupFixtureDataSnapshot,
): ReadonlyMap<string, CompiledLookupFixture> {
	const set = buildLookupFixtures(
		lookupWireNaming(snapshot.definitions),
		snapshot.rowsByTable,
	);
	return new Map(set.fixtures.map((fixture) => [fixture.tableId, fixture]));
}

/**
 * The review of the tables the app reads (the tags of `reads.lookupFields`,
 * in tag order) and, where it reads places, of the places it will hold. A
 * table carries CommCare HQ's digest and the revisions of the Project table
 * its tag met, so a row edited in CommCare HQ, or a Project table edited in
 * Nova, since the review changes what it digests to.
 *
 * A `choice` holds its standing as judged with the fields the reader read,
 * and its `use-project` offer is then closed by what only the document can
 * say: the Project's rows must be able to be the choices of every question
 * and search field that takes them from the table, and the tables the app
 * reads, each `choice` table at the larger of its two forms, must fit in one
 * `.ccz` together. An offer that fails either is `fails-a-project-space-rule`.
 *
 * Called on a read with no finding. `resolver` is this call's own.
 */
export function projectDataReview(
	data: ReadingProjectData,
	reads: ReaderProjectDataReads,
	doc: BlueprintDoc,
	resolver: IdentityResolver,
): {
	readonly tables: readonly ReviewTable[];
	readonly places: ReviewPlaces | null;
} {
	const byTag = new Map(
		data.gathered.tables.map((table) => [table.read.table.tag, table]),
	);
	const tags = Object.keys(reads.lookupFields).sort(compareCodeUnits);
	const entries = tags.map((tag) => {
		const table = byTag.get(tag);
		if (
			table === undefined ||
			table.read.kind !== "read" ||
			table.standing === null ||
			table.binding === null
		) {
			throw new Error(
				`The document reads the lookup table ${tag}, which cannot come in.`,
			);
		}
		return {
			tag,
			table,
			standing:
				table.standing.kind === "choice"
					? standingWithReads(data, table, reads.lookupFields[tag])
					: table.standing,
		};
	});

	// Each `choice` the Project's rows cannot be the choices of a question that reads them.
	const offers = new Map<
		string,
		Record<LookupTableChoice, LookupChoiceOffer>
	>();
	for (const { tag, standing } of entries) {
		if (standing.kind !== "choice") continue;
		let useProject = standing.options["use-project"];
		if (useProject.offered) {
			const asTheProjects = readingLookupSnapshot(
				underTableChoices(data, { [tag]: "use-project" }),
				reads,
			);
			const refused = lookupSelectSourceRowFindings(doc, asTheProjects).some(
				(error) => error.details?.tableId === standing.table.id,
			);
			if (refused) useProject = FAILS_A_PROJECT_SPACE_RULE;
		}
		offers.set(tag, { ...standing.options, "use-project": useProject });
	}

	// The tables together, each `choice` at the larger of the forms it may take.
	const choiceTags = entries
		.filter(({ standing }) => standing.kind === "choice")
		.map(({ tag }) => tag);
	if (choiceTags.length > 0) {
		const asHqs = fixturesOf(
			readingLookupSnapshot(
				underTableChoices(
					data,
					Object.fromEntries(
						choiceTags.map((tag) => [tag, "use-commcare-hq" as const]),
					),
				),
				reads,
			),
		);
		const projectTags = choiceTags.filter(
			(tag) => offers.get(tag)?.["use-project"].offered === true,
		);
		const asProjects = fixturesOf(
			readingLookupSnapshot(
				underTableChoices(
					data,
					Object.fromEntries(
						projectTags.map((tag) => [tag, "use-project" as const]),
					),
				),
				reads,
			),
		);
		let rows = 0;
		let cells = 0;
		let bytes = 0;
		for (const { tag, table } of entries) {
			const tableId = table.binding?.tableId ?? "";
			const forms = [asHqs.get(tableId)];
			if (projectTags.includes(tag)) forms.push(asProjects.get(tableId));
			const present = forms.filter(
				(form): form is CompiledLookupFixture => form !== undefined,
			);
			if (present.length === 0) {
				throw new Error(`The lookup table ${tag} built no fixture.`);
			}
			rows += Math.max(...present.map((form) => form.rowCount));
			cells += Math.max(...present.map((form) => form.cellCount));
			bytes += Math.max(...present.map((form) => form.bytes));
		}
		if (
			rows > MAX_LOOKUP_FIXTURE_ROWS ||
			cells > MAX_LOOKUP_FIXTURE_CELLS ||
			bytes > MAX_LOOKUP_FIXTURE_BYTES
		) {
			for (const tag of projectTags) {
				const options = offers.get(tag);
				if (options !== undefined) {
					offers.set(tag, {
						...options,
						"use-project": FAILS_A_PROJECT_SPACE_RULE,
					});
				}
			}
		}
	}

	const tables = entries.map(({ tag, table, standing }): ReviewTable => {
		if (table.read.kind !== "read") {
			throw new Error(`The lookup table ${tag} was never read.`);
		}
		const options = offers.get(tag);
		return {
			tag,
			standing: standing.kind,
			hqDigest: table.read.canonical.digest,
			projectTable: table.projectTable,
			choice:
				standing.kind === "choice" && options !== undefined
					? { differs: standing.differs, apps: standing.apps, options }
					: null,
		};
	});

	const places = reads.readsPlaces ? bornPlaces(data, doc, resolver) : null;
	return {
		tables,
		places:
			places === null
				? null
				: { count: places.places.length, digest: places.digest },
	};
}

/** A `choice` table's standing judged again, with the fields the reader read of it. */
function standingWithReads(
	data: ReadingProjectData,
	table: ReadingLookupTable,
	appReads: readonly string[],
): ChoiceStanding {
	const { read, standing } = table;
	if (read.kind !== "read" || standing?.kind !== "choice") {
		throw new Error("Only a read table that asks a choice is judged again.");
	}
	const { project, origin } = data.gathered;
	const existing = standing.table;
	if (!Object.hasOwn(project.rowsByTable, existing.id)) {
		throw new Error(
			`The Project's lookup table ${existing.tag} was read without its rows.`,
		);
	}
	const again = lookupTableStanding({
		read,
		origin,
		existing: { table: existing, rows: project.rowsByTable[existing.id] },
		apps: Object.hasOwn(project.apps, existing.id)
			? project.apps[existing.id]
			: [],
		siblings: project.siblings.filter(
			(sibling) => sibling.tableId === existing.id,
		),
		appReads,
		mayAdminister: project.mayAdminister,
		keptColumnIds: keptColumnsOf(project.keptColumns, existing),
	});
	if (again.kind !== "choice") {
		throw new Error(
			`The lookup table ${existing.tag} stood otherwise once the fields read were known.`,
		);
	}
	return again;
}
