// lib/commcare/multimedia/mediaSuiteXml.ts
//
// media_suite.xml — the archive descriptor that tells CommCare which
// media files the app bundles and where they install. One `<media>`
// block per referenced asset, its `path` the file's own directory:
//
//   <suite version="1" descriptor="Media Suite File">
//     <media path="../../commcare">
//       <resource id="media-<hash>-<hash>.png" version="1">
//         <location authority="local">./commcare/<hash>.png</location>
//       </resource>
//     </media>
//     <media path="../../media">
//       <resource id="media-<hash>-logo.png" version="1">
//         <location authority="local">./media/logo.png</location>
//       </resource>
//     </media>
//   </suite>
//
// Verified against commcare-core `MediaSuite.java` / `ResourceParser`
// (the `id` / `version` / `lazy` resource attributes; the
// `<location authority>` child) and the generator at
// `commcare-hq/.../suite_xml/generator.py::media_resources`, whose rule this
// is: for a reference `jr://file/<dir>/<name>`, `install_path` is
// `'../../' + <dir>` and the location `'./' + <dir> + '/' + <name>`, for
// whatever directory the path names (`app_manager/util.py::split_path`
// splits at the last slash, so `<dir>` may be nested), plus the fixture
// `tests/data/suite/form_media_suite.xml`.
//
// Where the path is read: Core's own installer ignores it
// (`InstallerFactory.getMediaInstaller` returns a `MediaInstaller` that
// takes no path). CommCare Android installs each file into
// `jr://file/commcare/media/` + `/` + path + `/` + the location's file name
// (`AndroidResourceInstallerFactory.getMediaInstaller`,
// `MediaFileAndroidInstaller`, `FileSystemInstaller.resolveEmptyLocalReference`;
// `GlobalConstants.MEDIA_REF`), and `jr://file/` is the app's storage root
// (`CommCareApp.initializeFileRoots`), so `../../<dir>` puts the file at
// `<root>/<dir>/<name>`: where the reference `jr://file/<dir>/<name>` reads
// it, nested or not, under `commcare/` or not.
//
// `authority="local"` is mandatory: commcare-core `BasicInstaller::install`
// returns false for a remote-authority resource (the remote branch is an
// unimplemented `// TODO: Implement local cache code`). The compiler
// writes each asset's bytes into the CCZ at its wire path; this descriptor
// points the runtime at them. Whether a referenced file is in the archive
// matters on one runtime alone: an archive install on Core and on Formplayer does not notice a missing
// media file (commcare-core `ArchiveFileReference.doesBinaryExist` answers
// true; formplayer `FormplayerArchiveFileRoot.derive` hands every path an
// `ArchiveFileReference`), while Android unzips the archive and copies each
// file (commcare-android `InstallArchiveActivity`,
// `FileSystemInstaller.install`), so a missing file fails the install there.
// The bundling proof is therefore the media-suite oracle's own
// `bundledPaths` join (`lib/commcare/validator/mediaSuiteOracle.ts`), not
// an install on Core.

import type { Element } from "domhandler";
import { el, text } from "@/lib/commcare/elementBuilders";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { compilerBugMessage } from "@/lib/domain/expression/errors";
import type { ResolvedMediaAsset } from "./assetWirePath";

/**
 * The `<media path>` of one file: `../../` and the directory of its wire
 * path, everything before the last slash. A wire path always has a
 * directory (a content-hash path is under `commcare/`, and a held path is
 * held only with one), so a path without one is a bug in whoever built the
 * manifest.
 */
function mediaInstallPath(asset: ResolvedMediaAsset): string {
	const slash = asset.wirePath.lastIndexOf("/");
	if (slash <= 0) {
		throw new Error(
			compilerBugMessage({
				where: "buildMediaSuiteXml",
				invariant: `media asset "${asset.assetId}" has the wire path "${asset.wirePath}", which names no directory`,
				detail:
					"Every wire path is a directory and a file name: a content-hash path is under commcare/, and a path a project space holds is held only with a directory. The manifest was built with a path no export holds.",
			}),
		);
	}
	return `../../${asset.wirePath.slice(0, slash)}`;
}

/**
 * Render a `<suite>` element to the wire string. `serializeXml` doesn't
 * emit the XML declaration, so it's prepended here (as `compiler.ts` does);
 * the serializer stays the sole escaping authority.
 */
function serializeSuite(suite: Element): string {
	return `<?xml version="1.0"?>\n${serializeXml(suite)}`;
}

/**
 * Build the complete `media_suite.xml` for the referenced assets. An empty
 * list yields a bare `<suite version="1"/>`; otherwise one `<media>` block
 * per asset, ordered by wire path for deterministic output (same inputs →
 * same bytes).
 *
 * Both shapes are built through `el()` and serialized once — no XML rides as
 * a string literal, matching every other emitter in this package.
 */
export function buildMediaSuiteXml(
	assets: readonly ResolvedMediaAsset[],
): string {
	// The empty suite drops `descriptor` (the populated case sets it): it's a
	// human-readable label commcare-core's `ResourceParser` reads as optional,
	// so the descriptor-present and -absent forms parse identically.
	if (assets.length === 0) return serializeSuite(el("suite", { version: "1" }));

	const ordered = [...assets].sort((a, b) =>
		a.wirePath < b.wirePath ? -1 : a.wirePath > b.wirePath ? 1 : 0,
	);

	const mediaBlocks: Element[] = ordered.map((asset) => {
		// The basename after the wire path's final slash is the resource
		// filename, and `./<wirePath>` is the local install location
		// relative to the suite.
		const filename = asset.wirePath.slice(asset.wirePath.lastIndexOf("/") + 1);
		// The resource id only needs to be unique within the suite (the
		// runtime resolves the jr:// reference by its location PATH, not by
		// id). `media-<hash>-<file>` is a stable, collision-free id: a
		// content-hash path's file name is its hash, and a target holds one
		// path per asset and one asset per content hash. CCHQ's template is
		// `media-<uid>-<name>` where `<name>` is the path's file name; for a
		// content-hash path that name is `<hash><ext>`, so the hash shows
		// twice, which is cosmetic noise in the id; behavior is identical.
		const resourceId = `media-${asset.contentHash}-${filename}`;
		return el("media", { path: mediaInstallPath(asset) }, [
			el("resource", { id: resourceId, version: "1" }, [
				el("location", { authority: "local" }, [text(`./${asset.wirePath}`)]),
			]),
		]);
	});

	const suite = el("suite", { version: "1", descriptor: "Media Suite File" }, [
		...mediaBlocks,
	]);
	return serializeSuite(suite);
}
