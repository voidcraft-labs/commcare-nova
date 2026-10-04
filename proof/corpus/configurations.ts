/**
 * The configurations each corpus document is checked under
 * (`<id>/configurations.json`): the project spaces the harness builds and
 * runs it against, in the shape `proof/hq/configuration.py` reads.
 *
 * - `minimum`: the feature flags Nova's publish check requires of a project
 *   space for the document (its verdict's required capabilities' flags) and
 *   whether case search must be on. The document's edit batch is published
 *   under the same configuration, so the flags are those of D and D′
 *   together: a configuration Nova's publish refuses for either is never
 *   checked (decision 19).
 * - `maximum`: the minimum plus every app-building flag a gate entry
 *   (`lib/commcare/surface/entries/gates.json`) classes as target-owned.
 * - `singleFlag`: the minimum plus one flag, for each flag a reproduction
 *   names for the document.
 *
 * Every configuration builds at the harness's CommCare version
 * (`CORPUS_COMMCARE_VERSION`), with CommTrack off, and sync cases on form
 * entry off unless a reproduction turns it on for the document
 * (`CorpusDocument.projectSettings`). A configuration names only the
 * privileges a reproduction asks for
 * (`namedPrivileges`): the ones the document's content needs are HQ's to
 * say, from the apps Nova sends, so the lane derives them where HQ runs
 * (`proof/checks/configurations.py::privileges_for`) and the emission never
 * starts HQ. They decide nothing Nova sends: a capture reads only the flags
 * and case search (`./publish.ts::PublishConfiguration`).
 */

import gateEntries from "@/lib/commcare/surface/entries/gates.json";
import { gateEntriesFileSchema } from "@/lib/commcare/surface/schema";

/**
 * The CommCare version every configuration builds at: the harness's own,
 * `proof/hq/configuration.py::DEFAULT_COMMCARE_VERSION`
 * (`proof/checks/test_corpus.py` holds the two equal).
 */
export const CORPUS_COMMCARE_VERSION = "2.57.0";

/**
 * A project space as the corpus states it: `proof/hq/configuration.py::Configuration`
 * once the lane adds the privileges the document's content needs.
 */
export interface CorpusConfiguration {
	/** Toggle symbols from `corehq/toggles/__init__.py`, sorted. */
	readonly flags: readonly string[];
	/**
	 * Privilege constants from `corehq/privileges.py` a reproduction names
	 * beyond those the content needs (`CorpusDocument.privileges`), sorted.
	 */
	readonly namedPrivileges: readonly string[];
	readonly commcareVersion: string;
	readonly commtrack: boolean;
	readonly syncCasesOnFormEntry: boolean;
	readonly caseSearchEnabled: boolean;
}

export interface DocumentConfigurations {
	readonly minimum: CorpusConfiguration;
	readonly maximum: CorpusConfiguration;
	readonly singleFlag: Readonly<Record<string, CorpusConfiguration>>;
}

/**
 * The directory a configuration's publish captures sit in, under `export/`:
 * `minimum`, `maximum`, or a single-flag configuration's flag symbol (an
 * upper-case HQ constant, so never either of the others).
 */
export function configurationDirectory(
	name: "minimum" | "maximum" | { readonly singleFlag: string },
): string {
	return typeof name === "string" ? name : name.singleFlag;
}

/** Every toggle a gate entry classes as target-owned, by symbol, sorted. */
export const TARGET_OWNED_FLAGS: readonly string[] = [
	...new Set(
		gateEntriesFileSchema
			.parse(gateEntries)
			.flatMap((gate) =>
				gate.kind === "toggle" && gate.class.kind === "target-owned"
					? gate.symbols
					: [],
			),
	),
].sort();

function sorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort();
}

/** What Nova's publish reads of a configuration: its flags and whether case search is on. */
export interface ConfigurationFlags {
	readonly flags: readonly string[];
	readonly caseSearchEnabled: boolean;
}

/** The flags and case search a document's publish needs, and the flags its reproductions name. */
export interface FlagsInput {
	readonly flags: readonly string[];
	readonly caseSearchEnabled: boolean;
	readonly singleFlags?: readonly string[];
}

/** Each configuration's flags: the minimum's, the maximum's, and each single flag's. */
function flagSets(input: FlagsInput) {
	const minimum = sorted(input.flags);
	return {
		minimum,
		maximum: sorted([...minimum, ...TARGET_OWNED_FLAGS]),
		singleFlag: sorted(input.singleFlags ?? []).map(
			(flag) => [flag, sorted([...minimum, flag])] as const,
		),
	};
}

/**
 * Each of a document's configurations as Nova's publish reads it, by its
 * directory under `export/`: `minimum`, `maximum`, then each single flag.
 */
export function configurationFlags(
	input: FlagsInput,
): [string, ConfigurationFlags][] {
	const sets = flagSets(input);
	const of = (flags: readonly string[]): ConfigurationFlags => ({
		flags,
		caseSearchEnabled: input.caseSearchEnabled,
	});
	return [
		[configurationDirectory("minimum"), of(sets.minimum)],
		[configurationDirectory("maximum"), of(sets.maximum)],
		...sets.singleFlag.map(([flag, flags]): [string, ConfigurationFlags] => [
			configurationDirectory({ singleFlag: flag }),
			of(flags),
		]),
	];
}

/**
 * A document's configurations: the flags `configurationFlags` names, each
 * with the privileges and the sync cases on form entry setting a
 * reproduction names, and the CommCare version the harness builds at.
 */
export function documentConfigurations(
	input: FlagsInput & {
		readonly namedPrivileges: readonly string[];
		readonly syncCasesOnFormEntry?: boolean;
	},
): DocumentConfigurations {
	const sets = flagSets(input);
	const of = (flags: readonly string[]): CorpusConfiguration => ({
		flags,
		namedPrivileges: sorted(input.namedPrivileges),
		commcareVersion: CORPUS_COMMCARE_VERSION,
		commtrack: false,
		syncCasesOnFormEntry: input.syncCasesOnFormEntry ?? false,
		caseSearchEnabled: input.caseSearchEnabled,
	});
	return {
		minimum: of(sets.minimum),
		maximum: of(sets.maximum),
		singleFlag: Object.fromEntries(
			sets.singleFlag.map(([flag, flags]) => [flag, of(flags)]),
		),
	};
}
