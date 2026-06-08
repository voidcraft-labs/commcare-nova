// lib/commcare/multimedia/mediaSuiteXml.ts
//
// media_suite.xml — the archive descriptor that tells CommCare which
// media files the app bundles and where they install. One `<media>`
// block per referenced asset:
//
//   <suite version="1" descriptor="Media Suite File">
//     <media path="../../commcare">
//       <resource id="media-<uid>-<hash>.png" version="1">
//         <location authority="local">./commcare/<hash>.png</location>
//       </resource>
//     </media>
//   </suite>
//
// Verified against commcare-core `MediaSuite.java` / `ResourceParser`
// (the `id` / `version` / `lazy` resource attributes; the
// `<location authority>` child) and the generator at
// `commcare-hq/.../suite_xml/generator.py::media_resources` (the
// `path = '../../' + dir` "hack" — CommCare aliases `jr://media/` to
// `jr://file/commcare/media/`, so it rewrites the `jr://file/` prefix to
// `../../` for the on-device install root) plus the fixture
// `tests/data/suite/form_media_suite.xml`.
//
// `authority="local"` is mandatory: commcare-core `BasicInstaller::install`
// returns false for a remote-authority resource (the remote branch is an
// unimplemented `// TODO: Implement local cache code`), so a media file
// referenced but not bundled locally fails to install. The compiler
// writes each asset's bytes into the CCZ at its wire path; this descriptor
// points the runtime at them.

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS, text } from "@/lib/commcare/elementBuilders";
import type { ResolvedMediaAsset } from "./assetWirePath";

/**
 * Empty-suite placeholder for a media-free app. The `descriptor`
 * attribute carries no semantics for an empty suite, so it is
 * dropped — both the descriptor-present and descriptor-absent forms
 * parse identically through commcare-core's `ResourceParser` (the
 * descriptor is a human-readable label the parser reads as optional).
 */
const EMPTY_MEDIA_SUITE = '<?xml version="1.0"?>\n<suite version="1"/>';

/**
 * The install directory the `<media path>` points at, relative to the
 * media-suite file. All Nova media lives flat under `commcare/`, so the
 * path is constant. (CCHQ varies it per media subdirectory; Nova has one.)
 */
const MEDIA_INSTALL_PATH = "../../commcare";

/**
 * Build the complete `media_suite.xml` string for the referenced
 * assets. An empty list yields the byte-identical empty placeholder;
 * otherwise one `<media>` block per asset, ordered by wire path for
 * deterministic output (same inputs → same bytes).
 *
 * Constructed as a `domhandler` tree and serialized once — the
 * serializer is the sole escaping authority, matching every other
 * emitter in this package. The `<?xml?>` declaration is the one literal
 * the serializer doesn't emit, prepended here (as `compiler.ts` does).
 */
export function buildMediaSuiteXml(
	assets: readonly ResolvedMediaAsset[],
): string {
	if (assets.length === 0) return EMPTY_MEDIA_SUITE;

	const ordered = [...assets].sort((a, b) =>
		a.wirePath < b.wirePath ? -1 : a.wirePath > b.wirePath ? 1 : 0,
	);

	const mediaBlocks: Element[] = ordered.map((asset) => {
		// `wirePath` is `commcare/<hash><ext>`; the basename after the
		// final slash is the resource filename, and `./<wirePath>` is the
		// local install location relative to the suite.
		const filename = asset.wirePath.slice(asset.wirePath.lastIndexOf("/") + 1);
		// The resource id only needs to be unique within the suite (the
		// runtime resolves the jr:// reference by its location PATH, not by
		// id). The content hash is unique per asset, so `media-<hash>-<file>`
		// is a stable, collision-free id. CCHQ's template is
		// `media-<uid>-<name>` where `<name>` is the original upload
		// filename; Nova's asset rows are content-addressed and carry no
		// original filename, so the `<name>` slot collapses to the wire
		// filename (`<hash><ext>`). The doubled hash is cosmetic noise in
		// the id; behavior is identical.
		const resourceId = `media-${asset.contentHash}-${filename}`;
		return el("media", { path: MEDIA_INSTALL_PATH }, [
			el("resource", { id: resourceId, version: "1" }, [
				el("location", { authority: "local" }, [text(`./${asset.wirePath}`)]),
			]),
		]);
	});

	const suite = el("suite", { version: "1", descriptor: "Media Suite File" }, [
		...mediaBlocks,
	]);
	return `<?xml version="1.0"?>\n${render(suite, RENDER_OPTS)}`;
}
