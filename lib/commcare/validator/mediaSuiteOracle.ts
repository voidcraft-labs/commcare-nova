/**
 * Post-emission checks for Core SuiteParser/ResourceParser and Nova's local
 * archive resource joins. MediaRuntimeTest exercises the actual native readers,
 * resource table and installer. This is not a rendered-client or playback gate.
 *
 * Core accepts an empty media block and ignores its path attribute in
 * InstallerFactory.getMediaInstaller; neither is a runtime refusal. Nova's
 * compiler tests independently assert the intended emitted descriptor shape.
 */

import { type Element, isTag } from "domhandler";
import { findAll, getAttributeValue, getChildren } from "domutils";
import { tryParseXml } from "../xmlParse";
import {
	type ValidationError,
	type ValidationLocation,
	validationError,
} from "./errors";

/**
 * Validate a generated `media_suite.xml` against CommCare's parse + install
 * contract. Returns structured errors (empty array on a clean suite).
 *
 * `bundledPaths`, when supplied, is the closed set of zip entry paths the
 * compiler wrote into the `.ccz` archive. With it, the oracle additionally
 * proves every `<location>` text resolves to a bundled file (Category 2 —
 * the install-time path-existence check). Omit when the caller has no
 * bundle to compare against; the parse contract (Category 1) still runs.
 *
 * The oracle is app-scoped — no per-form / per-module location attaches to
 * findings.
 */
export function validateMediaSuite(
	mediaSuiteXml: string,
	bundledPaths?: ReadonlySet<string>,
): ValidationError[] {
	const loc: ValidationLocation = {};

	// Syntax and decoded values come from one namespace-aware XML parse.
	const parsed = tryParseXml(mediaSuiteXml);
	if ("issue" in parsed) {
		return [
			validationError(
				"MEDIA_SUITE_PARSE_ERROR",
				"app",
				`The generator produced malformed media_suite.xml that CommCare will reject: ${parsed.issue}. This is a bug in the media-suite generator.`,
				loc,
			),
		];
	}

	const { doc } = parsed;

	const suiteEl = doc.children.find(
		(child): child is Element => isTag(child) && child.name === "suite",
	);
	if (suiteEl === undefined) {
		return [
			validationError(
				"MEDIA_SUITE_NO_SUITE_ELEMENT",
				"app",
				`The generated media_suite.xml has no <suite> root element. CommCare's SuiteParser expects this as the document root. This is a bug in the media-suite generator.`,
				loc,
			),
		];
	}

	const errors: ValidationError[] = [];

	// Category 1 — suite version (`SuiteParser::parse` calls `Integer.parseInt`
	// on the attribute, raising NumberFormatException on a non-integer value).
	const version = getAttributeValue(suiteEl, "version");
	if (version === undefined) {
		// `Integer.parseInt(null)` throws NumberFormatException — same fatal
		// shape as a non-integer present value, so the missing-attribute case
		// rides the same code.
		errors.push(
			validationError(
				"MEDIA_SUITE_VERSION_NOT_INTEGER",
				"app",
				`The generated media_suite.xml's <suite> element has no version attribute. CommCare's SuiteParser parses the version as an integer and fails when it's missing. This is a bug in the media-suite generator.`,
				loc,
			),
		);
	} else if (!isJavaInteger(version)) {
		errors.push(
			validationError(
				"MEDIA_SUITE_VERSION_NOT_INTEGER",
				"app",
				`The generated media_suite.xml declares <suite version="${version}">, but CommCare's SuiteParser parses the version as an integer. This is a bug in the media-suite generator.`,
				loc,
			),
		);
	}

	const seenResourceIds = new Set<string>();

	for (const media of findAll((el) => el.name === "media", suiteEl.children)) {
		const resources = getChildren(media).filter(
			(c): c is Element => isTag(c) && c.name === "resource",
		);

		for (const resource of resources) {
			checkResource(resource, seenResourceIds, bundledPaths, loc, errors);
		}
	}

	return errors;
}

/**
 * Validate one `<resource>` element. Required attributes: `id`, `version`
 * (integer). Each child `<location>` must carry an `authority` (`local` for
 * Nova), text content (the resource path), and — when `bundledPaths` is
 * supplied — that path must point at a bundled zip entry. Duplicate `id`
 * siblings within the suite are also flagged (the runtime keys resources
 * by id and retains the first definition).
 */
function checkResource(
	resource: Element,
	seenResourceIds: Set<string>,
	bundledPaths: ReadonlySet<string> | undefined,
	loc: ValidationLocation,
	errors: ValidationError[],
): void {
	const id = getAttributeValue(resource, "id");
	if (id === undefined) {
		errors.push(
			validationError(
				"MEDIA_RESOURCE_NO_ID",
				"app",
				`The generated media_suite.xml has a <resource> with no id attribute. CommCare's ResourceParser reads the id directly off the attribute; a missing id has no resource handle to install against. This is a bug in the media-suite generator.`,
				loc,
			),
		);
	} else {
		// C2 — duplicate resource ids. The runtime keys the resource table by
		// id; ResourceTable.addResource retains the first definition, so a
		// later duplicate never receives its own installed resource.
		if (seenResourceIds.has(id)) {
			errors.push(
				validationError(
					"MEDIA_RESOURCE_DUPLICATE_ID",
					"app",
					`The generated media_suite.xml declares resource id "${id}" more than once. CommCare keys the resource table by id and keeps the first definition, leaving later resource definitions unused. This is a bug in the media-suite generator.`,
					loc,
				),
			);
		} else {
			seenResourceIds.add(id);
		}
	}

	const version = getAttributeValue(resource, "version");
	if (version === undefined) {
		errors.push(
			validationError(
				"MEDIA_RESOURCE_VERSION_NOT_INTEGER",
				"app",
				`The generated media_suite.xml has a <resource${id ? ` id="${id}"` : ""}> with no version attribute. CommCare's ResourceParser parses the version as an integer and fails when it's missing. This is a bug in the media-suite generator.`,
				loc,
			),
		);
	} else if (!isJavaInteger(version)) {
		errors.push(
			validationError(
				"MEDIA_RESOURCE_VERSION_NOT_INTEGER",
				"app",
				`The generated media_suite.xml has a <resource${id ? ` id="${id}"` : ""} version="${version}">, but CommCare's ResourceParser parses the version as an integer. This is a bug in the media-suite generator.`,
				loc,
			),
		);
	}

	const locations = getChildren(resource).filter(
		(c): c is Element => isTag(c) && c.name === "location",
	);

	// C1 — `<resource>` must carry ≥1 `<location>`. ResourceParser's
	// `nextTagInBlock` builds an empty `Vector<ResourceLocation>` on a
	// childless resource; the installer then has no path to resolve. Treat
	// the empty case as a generator bug so a missing-emission slip surfaces.
	if (locations.length === 0) {
		errors.push(
			validationError(
				"MEDIA_RESOURCE_NO_LOCATION",
				"app",
				`The generated media_suite.xml has a <resource${id ? ` id="${id}"` : ""}> with no <location> children. CommCare's installer needs a location to read the resource's bytes from. This is a bug in the media-suite generator.`,
				loc,
			),
		);
	}

	for (const location of locations) {
		checkLocation(location, id, bundledPaths, loc, errors);
	}
}

/**
 * Validate one `<location>` element. The `authority` attribute is required
 * and must be `local` — Nova's only authored value, and the only value
 * `BasicInstaller::install` reads bundled bytes for; any other value
 * (absent, remote, or unrecognized) fails install. The text content is
 * the resource path; an empty value leaves the installer with nothing to
 * resolve. When the path starts with `./`, the suffix is checked against
 * the bundled-file set.
 */
function checkLocation(
	location: Element,
	resourceId: string | undefined,
	bundledPaths: ReadonlySet<string> | undefined,
	loc: ValidationLocation,
	errors: ValidationError[],
): void {
	const authority = getAttributeValue(location, "authority");
	const where = resourceId !== undefined ? ` for "${resourceId}"` : "";

	if (authority === undefined) {
		errors.push(
			validationError(
				"MEDIA_LOCATION_NO_AUTHORITY",
				"app",
				`The generated media_suite.xml has a <location>${where} with no authority attribute. CommCare's ResourceParser lowercases this attribute without a null check, so an absent authority aborts the media_suite parse before the installer ever runs. This is a bug in the media-suite generator.`,
				loc,
			),
		);
	} else if (authority.toLowerCase() !== "local") {
		// CommCare reads bundled bytes only for `local` authority, via
		// `BasicInstaller::install`'s local branch (`ref.doesBinaryExist()`).
		// A non-local authority — explicit `remote`, or any unrecognized
		// literal, which `ResourceParser::parse` leaves at its `REMOTE` enum
		// default — is added as a remote location and routed through the
		// installer's remote branch, which never installs a resource: its
		// cache-write path is unimplemented and returns false. Nova bundles
		// every media file into the CCZ, so the only correct authority is
		// `local`; any other value is a generator bug.
		errors.push(
			validationError(
				"MEDIA_LOCATION_UNKNOWN_AUTHORITY",
				"app",
				`The generated media_suite.xml has a <location authority="${authority}">${where}, but CommCare's installer only reads bundled bytes for "local" authority. Anything else fails install, the path isn't bundled and the installer can never fetch it. This is a bug in the media-suite generator.`,
				loc,
			),
		);
	}

	const pathText = readElementText(location);
	if (pathText === "") {
		errors.push(
			validationError(
				"MEDIA_LOCATION_NO_PATH",
				"app",
				`The generated media_suite.xml has a <location>${where} with no path text. CommCare reads the path via parser.nextText() and the installer can't resolve an empty path. This is a bug in the media-suite generator.`,
				loc,
			),
		);
		return;
	}

	// C2 — local-path resolution. Nova emits `./commcare/<hash><ext>`; the
	// location resolves relative to the archive root. Core ignores the media
	// path attribute when choosing its installer. The compiler writes
	// the bytes at that path. A mismatch means the suite points the runtime
	// at a file that isn't in the archive — the installer's `doesBinaryExist()`
	// returns false and the resource fails install.
	if (bundledPaths !== undefined) {
		const normalized = pathText.startsWith("./") ? pathText.slice(2) : pathText;
		if (!bundledPaths.has(normalized)) {
			errors.push(
				validationError(
					"MEDIA_LOCATION_PATH_NOT_BUNDLED",
					"app",
					`The generated media_suite.xml has a <location>${where} pointing at "${pathText}", but the compiler bundled no file at "${normalized}". CommCare's installer calls doesBinaryExist() on the location and refuses the resource when the file isn't there. This is a bug in the media-suite generator.`,
					loc,
				),
			);
		}
	}
}

/**
 * Concatenate every direct text-child of an element. Mirrors KXmlParser's
 * `nextText()` read — adjacent text segments collapse into one returned
 * string; `domhandler` keeps them as sibling `Text` nodes, so the
 * equivalent is a children sweep with `.data` concatenation.
 */
function readElementText(el: Element): string {
	let acc = "";
	for (const child of getChildren(el)) {
		if (isTag(child)) continue;
		const data = (child as { data?: string }).data;
		if (typeof data === "string") acc += data;
	}
	return acc;
}

/** Integer.parseInt accepts a sign and rejects values outside signed int32. */
function isJavaInteger(value: string): boolean {
	return (
		/^[+-]?\d+$/.test(value) &&
		Number(value) >= -2147483648 &&
		Number(value) <= 2147483647
	);
}
