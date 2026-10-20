/**
 * The emission census's head half (part 09 §7): each lifted target emitted
 * through the head emitter exactly as the base half emitted the stored app at
 * pull request 2's head (`scripts/emit-hq-round-trip-expressions-base.ts`),
 * normalized by the same frozen `emissionNormal.ts`, and compared with the
 * base half's digests file by file.
 *
 * Content-free: only file keys (derived wire ids, never a name), digests and
 * verdicts leave this module. The comparison is a gate on unexplained
 * differences: a file whose normalized digest moved must belong to an entity
 * a named change names, or the app is `unexplained`, a defect of the stack.
 */

import AdmZip from "adm-zip";
import { z } from "zod";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formOfField } from "@/lib/domain/fieldForm";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import {
	CENSUS_ATTACHMENT_TARGET,
	CENSUS_COMPILE_OPTIONS,
	CENSUS_RUNTIME_TARGET,
	type EmissionFragment,
	normalizeEmittedApp,
} from "./emissionNormal";

/**
 * The two local-archive carriers the census measures, as the base emitter
 * keeps them. Embedded fixture blocks are removed by the frozen normalizer.
 */
function localExpressionFiles(archive: Buffer): ReadonlyMap<string, string> {
	const files = new Map<string, string>();
	for (const entry of new AdmZip(archive).getEntries()) {
		if (
			entry.entryName === "suite.xml" ||
			/^modules-\d+\/forms-\d+\.xml$/.test(entry.entryName)
		) {
			files.set(entry.entryName, entry.getData().toString("utf8"));
		}
	}
	return files;
}

/** What the census emits of one target, before normalization. */
export interface CensusEmission {
	/** The HQ import body's app JSON, its XForms in `_attachments`. */
	readonly hqApp: unknown;
	/** The local archive's `suite.xml` and XForms, by archive path. */
	readonly localFiles: ReadonlyMap<string, string>;
}

/**
 * One target's census emission: the HQ import body and the local archive's
 * suite and XForms, with the Project's lookup definitions and empty rows, the
 * frozen synthetic runtime target, attachment target and compiler version.
 * Every call the base emitter makes, in its order, with its options.
 */
export function emitCensusFiles(
	doc: BlueprintDoc,
	lookupDefinitions: readonly LookupTableDefinition[],
): CensusEmission {
	const naming = lookupWireNaming(lookupDefinitions);
	const options = {
		lookupNaming: naming,
		attachmentTarget: CENSUS_ATTACHMENT_TARGET,
	};
	const hqApp = expandDoc(doc, options);
	const localApp = expandDoc(doc, {
		...options,
		runtimeTarget: CENSUS_RUNTIME_TARGET,
	});
	const archive = compileCcz(localApp, doc.appName, doc, {
		...CENSUS_COMPILE_OPTIONS,
		lookup: {
			naming,
			fixtures: buildLookupFixtures(
				naming,
				new Map(naming.tables.map((table) => [table.tableId, []])),
			),
		},
	});
	return { hqApp, localFiles: localExpressionFiles(archive) };
}

/** One target's census files, normalized and digested as the base half's. */
export function emitCensusFragments(
	doc: BlueprintDoc,
	lookupDefinitions: readonly LookupTableDefinition[],
): EmissionFragment[] {
	const { hqApp, localFiles } = emitCensusFiles(doc, lookupDefinitions);
	return normalizeEmittedApp(hqApp, localFiles);
}

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const fileLineSchema = z.strictObject({
	app: z.string().min(1),
	file: z.string().min(1),
	rawDigest: digestSchema,
	digest: digestSchema,
});
const fleetLineSchema = z.strictObject({
	kind: z.literal("fleet"),
	fleetSeqDigest: digestSchema,
});

/** The base digests cannot be read: the base half must run again. */
export class BaseCensusError extends Error {
	readonly name = "BaseCensusError";
}

/** The base half's output, as `--base-digests <file>` reads it. */
export interface BaseCensus {
	readonly files: ReadonlyMap<string, readonly EmissionFragment[]>;
	readonly fleetSeqDigest: string;
}

/**
 * Read the base emitter's JSON Lines: one line per app and file, then one
 * `fleet` line. A malformed line, a repeated file or a missing fleet line
 * refuses the whole input, since a partial base census proves nothing.
 */
export function parseBaseCensus(text: string): BaseCensus {
	const files = new Map<string, EmissionFragment[]>();
	let fleetSeqDigest: string | undefined;
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	lines.forEach((line, index) => {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new BaseCensusError(
				`Line ${index + 1} of the base digests is not JSON. Run the base emitter again and pass its whole output.`,
			);
		}
		const fleet = fleetLineSchema.safeParse(value);
		if (fleet.success) {
			if (fleetSeqDigest !== undefined || index !== lines.length - 1)
				throw new BaseCensusError(
					"The base digests hold a fleet line that is not their one last line. Run the base emitter again and pass its whole output.",
				);
			fleetSeqDigest = fleet.data.fleetSeqDigest;
			return;
		}
		const file = fileLineSchema.safeParse(value);
		if (!file.success)
			throw new BaseCensusError(
				`Line ${index + 1} of the base digests is neither a file line nor the fleet line. Run the base emitter again and pass its whole output.`,
			);
		const list = files.get(file.data.app) ?? [];
		if (list.some((entry) => entry.file === file.data.file))
			throw new BaseCensusError(
				`The base digests name one file of app ${file.data.app} twice. Run the base emitter again and pass its whole output.`,
			);
		list.push({
			file: file.data.file,
			rawDigest: file.data.rawDigest,
			digest: file.data.digest,
		});
		files.set(file.data.app, list);
	});
	if (fleetSeqDigest === undefined)
		throw new BaseCensusError(
			"The base digests end without their fleet line, so the base emitter stopped early. Run it again and pass its whole output.",
		);
	return { files, fleetSeqDigest };
}

/** What a named change makes of an app's emission, as census file keys. */
export interface ExplainedFiles {
	/** A declaration or an inference typing: binds and listings are app-wide. */
	readonly all: boolean;
	readonly files: ReadonlySet<string>;
}

/** The census reads only a change's reason and entity. */
export interface CensusChange {
	readonly reason: string;
	readonly entity: { readonly type: string; readonly uuid?: string };
}

/** Changes whose emission reaches any file of the app (part 09 §7). */
const APP_WIDE: ReadonlySet<string> = new Set([
	"case-property-declared",
	"case-property-type-now-known",
]);
/** Changes whose emission reaches their entity's own files. */
const ENTITY_SCOPED: ReadonlySet<string> = new Set([
	"repeat-read-takes-first-row",
	"date-time-comparison-compares-moments",
	"search-today-is-workers-day",
	"search-date-time-equality-matches",
]);

const SUITE = "local/suite.xml";

function moduleKey(moduleUuid: Uuid): string {
	return `hq/modules/${encodeURIComponent(derivedUniqueId(moduleUuid))}`;
}

/** A form's XForm in both exports and its HQ form entry. */
function formFiles(doc: BlueprintDoc, formUuid: Uuid): string[] {
	const moduleUuid = doc.moduleOrder.find((uuid) =>
		(doc.formOrder[uuid] ?? []).includes(formUuid),
	);
	const id = encodeURIComponent(derivedUniqueId(formUuid));
	return [
		`hq/xforms/${id}.xml`,
		`local/xforms/${encodeURIComponent(derivedFormXmlns(formUuid))}.xml`,
		...(moduleUuid === undefined
			? []
			: [`${moduleKey(moduleUuid)}/forms/${id}/form.json`]),
	];
}

/**
 * The files each named change explains: a form's XForm and HQ form entry for
 * a field's change; those and `suite.xml` for a form's (its display
 * condition and links sit in the suite); `suite.xml` and the HQ module entry
 * for a module's; every file for a declaration or an inference typing.
 */
export function explainedFiles(
	target: BlueprintDoc,
	changes: readonly CensusChange[],
): ExplainedFiles {
	const files = new Set<string>();
	let all = false;
	for (const change of changes) {
		if (APP_WIDE.has(change.reason)) {
			all = true;
			continue;
		}
		if (!ENTITY_SCOPED.has(change.reason)) continue;
		const uuid = change.entity.uuid as Uuid | undefined;
		if (uuid === undefined) continue;
		switch (change.entity.type) {
			case "field": {
				const form = formOfField(target, uuid);
				if (form !== undefined)
					for (const file of formFiles(target, form)) files.add(file);
				break;
			}
			case "form":
				for (const file of formFiles(target, uuid)) files.add(file);
				files.add(SUITE);
				break;
			case "module":
				files.add(`${moduleKey(uuid)}/module.json`);
				files.add(SUITE);
				break;
			default:
				break;
		}
	}
	return { all, files };
}

export type CensusVerdict =
	| "unchanged"
	| "respelled-only"
	| "named"
	| "unexplained";

/** One app's census: content-free. */
export interface AppCensus {
	readonly appId: string;
	readonly verdict: CensusVerdict;
	/** Files whose raw bytes differ, whatever normalization makes of them. */
	readonly respelledFiles: number;
	/** Files that differ after normalization and a named change explains. */
	readonly namedFiles: number;
	/**
	 * The file keys no named change explains, by their position in the
	 * emission: derived wire ids only. A file only one half holds is one.
	 */
	readonly unexplainedFiles: readonly string[];
}

/**
 * One app's verdict, file by file: `unchanged` (every raw digest equal),
 * `respelled-only` (every normalized digest equal), `named` (every file that
 * differs after normalization is one a named change explains), else
 * `unexplained`. A file present in one half only differs after
 * normalization, so it too must be explained.
 */
export function appCensus(
	appId: string,
	base: readonly EmissionFragment[],
	head: readonly EmissionFragment[],
	explained: ExplainedFiles,
): AppCensus {
	const baseByFile = new Map(base.map((entry) => [entry.file, entry]));
	const headByFile = new Map(head.map((entry) => [entry.file, entry]));
	const keys = [...new Set([...baseByFile.keys(), ...headByFile.keys()])].sort(
		(a, b) => (a < b ? -1 : a > b ? 1 : 0),
	);
	let respelled = 0;
	let named = 0;
	const unexplained: string[] = [];
	for (const key of keys) {
		const before = baseByFile.get(key);
		const after = headByFile.get(key);
		if (
			before !== undefined &&
			after !== undefined &&
			before.digest === after.digest
		) {
			if (before.rawDigest !== after.rawDigest) respelled++;
			continue;
		}
		if (explained.all || explained.files.has(key)) named++;
		else unexplained.push(key);
	}
	const verdict: CensusVerdict =
		unexplained.length > 0
			? "unexplained"
			: named > 0
				? "named"
				: respelled > 0
					? "respelled-only"
					: "unchanged";
	return {
		appId,
		verdict,
		respelledFiles: respelled,
		namedFiles: named,
		unexplainedFiles: unexplained,
	};
}

/** The census over the planned live apps, as the scan's `census` section counts it. */
export interface FleetCensus {
	readonly apps: readonly AppCensus[];
	/**
	 * Live apps the census did not compare because a blocker holds them, by
	 * app id: no publish emits a target the plan refuses, and the cutover
	 * stops on the blocker itself.
	 */
	readonly notCompared: readonly string[];
	/**
	 * Live apps the plan admits that the base half holds no file of, by app
	 * id: every live app emits at least its HQ root, so the base census does
	 * not cover this fleet and proves nothing about these apps.
	 */
	readonly missingBase: readonly string[];
	/** Live apps whose target the head emitter refused: a defect of the stack. */
	readonly emissionFailed: readonly string[];
	/** The base half read the same fleet sequences the plan read. */
	readonly fleetSeqDigestMatches: boolean;
}

/** What the census reads of one planned app. */
export interface CensusApp {
	readonly appId: string;
	readonly projectId: string;
	readonly changes: readonly CensusChange[];
	readonly blockers: readonly unknown[];
}

/**
 * The head half over every planned live app, against the base half. Only
 * the planned apps are compared (one under `--app`); a deleted app is in
 * neither half, and an app a blocker holds is left out. A target the plan
 * admits that the head emitter throws on is `unexplained`, since every such
 * target must emit; its error, which can hold authored text, is never kept.
 */
export function fleetCensus(input: {
	readonly apps: readonly CensusApp[];
	readonly deleted: ReadonlySet<string>;
	readonly targets: ReadonlyMap<string, BlueprintDoc>;
	readonly lookupDefinitions: ReadonlyMap<
		string,
		readonly LookupTableDefinition[]
	>;
	readonly fleetSeqDigest: string;
	readonly base: BaseCensus;
}): FleetCensus {
	const apps: AppCensus[] = [];
	const notCompared: string[] = [];
	const missingBase: string[] = [];
	const emissionFailed: string[] = [];
	for (const app of input.apps) {
		if (input.deleted.has(app.appId)) continue;
		const target = input.targets.get(app.appId);
		if (target === undefined || app.blockers.length > 0) {
			notCompared.push(app.appId);
			continue;
		}
		const base = input.base.files.get(app.appId);
		if (base === undefined) {
			missingBase.push(app.appId);
			continue;
		}
		let head: EmissionFragment[];
		try {
			head = emitCensusFragments(
				target,
				input.lookupDefinitions.get(app.projectId) ?? [],
			);
		} catch {
			emissionFailed.push(app.appId);
			apps.push({
				appId: app.appId,
				verdict: "unexplained",
				respelledFiles: 0,
				namedFiles: 0,
				unexplainedFiles: [],
			});
			continue;
		}
		apps.push(
			appCensus(app.appId, base, head, explainedFiles(target, app.changes)),
		);
	}
	return {
		apps,
		notCompared,
		missingBase,
		emissionFailed,
		fleetSeqDigestMatches: input.base.fleetSeqDigest === input.fleetSeqDigest,
	};
}

/** Counts per verdict, for the report. */
export function censusCounts(
	census: FleetCensus,
): Readonly<Record<CensusVerdict, number>> {
	const counts: Record<CensusVerdict, number> = {
		unchanged: 0,
		"respelled-only": 0,
		named: 0,
		unexplained: 0,
	};
	for (const app of census.apps) counts[app.verdict]++;
	return counts;
}

/** What in a census stops the cutover. */
export type CensusStop = "unexplained" | "census-incomplete" | "census-stale";

/**
 * Every reason the census stops the cutover, in this order: some app's
 * difference has no named reason (`unexplained`); a live app the plan
 * admits has no base file (`census-incomplete`); the base half read other
 * fleet sequences than the plan (`census-stale`), so its digests are of
 * other documents. Only `ok` with none of them proves the emission.
 */
export function censusStops(census: FleetCensus): CensusStop[] {
	return [
		...(census.apps.some((app) => app.verdict === "unexplained")
			? (["unexplained"] as const)
			: []),
		...(census.missingBase.length > 0 ? (["census-incomplete"] as const) : []),
		...(census.fleetSeqDigestMatches ? [] : (["census-stale"] as const)),
	];
}
