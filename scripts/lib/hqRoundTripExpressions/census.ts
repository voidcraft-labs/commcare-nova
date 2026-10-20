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
 * a named change names, or be an XForm whose secondary instances alone moved
 * (part 04 §5.2), or the app is `unexplained`, a defect of the stack.
 */

import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { type Document, type Element, isTag } from "domhandler";
import { z } from "zod";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { derivedFormXmlns, derivedUniqueId } from "@/lib/commcare/wireIdentity";
import { relinkSiblings } from "@/lib/commcare/xform/domSplice";
import { parseXml } from "@/lib/commcare/xmlParse";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formOfField } from "@/lib/domain/fieldForm";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import {
	CENSUS_ATTACHMENT_TARGET,
	CENSUS_COMPILE_OPTIONS,
	CENSUS_RUNTIME_TARGET,
	type EmissionFragment,
	normalizeEmittedApp,
	normalizeXForm,
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

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function localName(name: string): string {
	return name.slice(name.indexOf(":") + 1);
}

/** The XForm's one model, the first in document order, which sits in its head. */
function modelOf(node: Document | Element): Element | undefined {
	for (const child of node.children) {
		if (!isTag(child)) continue;
		if (localName(child.name) === "model") return child;
		const found = modelOf(child);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The secondary `<instance>` elements of a model: every one after the primary. */
function secondaryInstances(model: Element): Element[] {
	return model.children
		.filter(isTag)
		.filter((child) => localName(child.name) === "instance")
		.slice(1);
}

function* permutations<T>(items: readonly T[]): Generator<T[]> {
	if (items.length <= 1) {
		yield [...items];
		return;
	}
	for (let i = 0; i < items.length; i++)
		for (const rest of permutations([
			...items.slice(0, i),
			...items.slice(i + 1),
		]))
			yield [items[i], ...rest];
}

/**
 * The most secondary instances the frozen normalizer keeps whose orders the
 * comparison tries: 6! orders, each one normalization of the form. A form
 * that keeps more keeps its difference, an `unexplained` file the operator
 * reads with `--debug-details`.
 */
export const INSTANCE_ORDER_MAX = 6;

/**
 * Whether some order of an XForm's secondary instances, normalized by the
 * frozen `normalizeXForm` under the file's `prefix`, digests to `digest`.
 *
 * The head declares secondary instances in the instance table's order
 * (`casedb`, `commcaresession`, then other ids lexically,
 * `lib/commcare/xform/domSplice.ts::ensureInstance`), while pull request
 * 2's head appended each generated read's declaration after the last
 * instance (part 04 §5.2). Which declarations the base appended, and in
 * what order, is not in the head's emission, so the comparison tries each
 * order of the instances the normalizer keeps (an unread one is dropped,
 * wherever it sits), every other child where it is. The head's own order
 * must normalize to the head's own digest, so a serialization the
 * normalizer does not see through explains nothing.
 */
export function instanceOrderExplains(
	xml: string,
	prefix: string,
	headDigest: string,
	baseDigest: string,
): boolean {
	const normalized = (doc: Document) =>
		sha256(`${prefix}${normalizeXForm(serializeXml(doc))}`);
	const doc = parseXml(xml);
	const model = modelOf(doc);
	if (model === undefined || normalized(doc) !== headDigest) return false;
	const kept = new Set<string>();
	const normalModel = modelOf(parseXml(normalizeXForm(xml)));
	if (normalModel === undefined) return false;
	for (const instance of secondaryInstances(normalModel))
		kept.add(instance.attribs.id ?? "");
	const moving = secondaryInstances(model).filter((instance) =>
		kept.has(instance.attribs.id ?? ""),
	);
	if (moving.length < 2 || moving.length > INSTANCE_ORDER_MAX) return false;
	const slots = moving.map((instance) => model.children.indexOf(instance));
	for (const order of permutations(moving)) {
		if (order.every((instance, index) => instance === moving[index])) continue;
		order.forEach((instance, index) => {
			model.children[slots[index]] = instance;
		});
		relinkSiblings(model.children);
		if (normalized(doc) === baseDigest) return true;
	}
	return false;
}

/** What the census reads of one target's emission. */
export interface HeadCensus {
	readonly fragments: readonly EmissionFragment[];
	/**
	 * Whether a moved file is an XForm whose difference from the base digest
	 * is the order of its secondary instances alone.
	 */
	readonly instanceOrderOnly: (file: string, baseDigest: string) => boolean;
}

/**
 * One target's census fragments, and the order-only comparison over its
 * XForms: each XForm's raw text by the raw digest its fragment carries,
 * under the prefix the frozen normalizer digests it with (the local
 * archive path for a local XForm, none for an HQ attachment).
 */
export function emitHeadCensus(
	doc: BlueprintDoc,
	lookupDefinitions: readonly LookupTableDefinition[],
): HeadCensus {
	const { hqApp, localFiles } = emitCensusFiles(doc, lookupDefinitions);
	const fragments = normalizeEmittedApp(hqApp, localFiles);
	const xforms = new Map<string, { prefix: string; xml: string }>();
	const attachments = (hqApp as { _attachments?: Record<string, unknown> })
		._attachments;
	for (const xml of Object.values(attachments ?? {}))
		if (typeof xml === "string") xforms.set(sha256(xml), { prefix: "", xml });
	for (const [name, xml] of localFiles)
		if (name !== "suite.xml") {
			const prefix = `${JSON.stringify(name)}\n`;
			xforms.set(sha256(`${prefix}${xml}`), { prefix, xml });
		}
	const byFile = new Map(fragments.map((entry) => [entry.file, entry]));
	return {
		fragments,
		instanceOrderOnly(file, baseDigest) {
			const head = byFile.get(file);
			if (
				head === undefined ||
				!(file.startsWith("hq/xforms/") || file.startsWith("local/xforms/"))
			)
				return false;
			const source = xforms.get(head.rawDigest);
			return (
				source !== undefined &&
				instanceOrderExplains(
					source.xml,
					source.prefix,
					head.digest,
					baseDigest,
				)
			);
		},
	};
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
	 * XForms that differ after normalization only by the order of their
	 * secondary instances (part 04 §5.2), and no named change explains.
	 */
	readonly instanceOrderFiles: number;
	/**
	 * The file keys no named change explains, by their position in the
	 * emission: derived wire ids only. A file only one half holds is one.
	 */
	readonly unexplainedFiles: readonly string[];
}

/**
 * One app's verdict, file by file: `unchanged` (every raw digest equal),
 * `respelled-only` (every normalized digest equal, or an XForm's equal in
 * some order of its secondary instances: a respelling of the declarations
 * the normalizer keeps, counted apart as `instanceOrderFiles`), `named`
 * (every other file that differs after normalization is one a named change
 * explains), else `unexplained`. A file present in one half only differs
 * after normalization, so it too must be explained.
 */
export function appCensus(
	appId: string,
	base: readonly EmissionFragment[],
	head: readonly EmissionFragment[],
	explained: ExplainedFiles,
	instanceOrderOnly: HeadCensus["instanceOrderOnly"] = () => false,
): AppCensus {
	const baseByFile = new Map(base.map((entry) => [entry.file, entry]));
	const headByFile = new Map(head.map((entry) => [entry.file, entry]));
	const keys = [...new Set([...baseByFile.keys(), ...headByFile.keys()])].sort(
		(a, b) => (a < b ? -1 : a > b ? 1 : 0),
	);
	let respelled = 0;
	let named = 0;
	let instanceOrder = 0;
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
		else if (
			before !== undefined &&
			after !== undefined &&
			instanceOrderOnly(key, before.digest)
		)
			instanceOrder++;
		else unexplained.push(key);
	}
	const verdict: CensusVerdict =
		unexplained.length > 0
			? "unexplained"
			: named > 0
				? "named"
				: respelled > 0 || instanceOrder > 0
					? "respelled-only"
					: "unchanged";
	return {
		appId,
		verdict,
		respelledFiles: respelled,
		namedFiles: named,
		instanceOrderFiles: instanceOrder,
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
		let head: HeadCensus;
		try {
			head = emitHeadCensus(
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
				instanceOrderFiles: 0,
				unexplainedFiles: [],
			});
			continue;
		}
		apps.push(
			appCensus(
				app.appId,
				base,
				head.fragments,
				explainedFiles(target, app.changes),
				head.instanceOrderOnly,
			),
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
