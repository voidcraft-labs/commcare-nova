/**
 * The one writer of an archive's members: each written once, under a name no
 * other member shares in any letter case and that names no other member's
 * directory. A `.ccz` (`compiler.ts`) and the HQ import file
 * (`multimedia/hqJsonExportArchive.ts`) are packed by it.
 *
 * Node-only (the zip library), and outside the barrel.
 */

import AdmZip from "adm-zip";
import { memberKey } from "./cczMembers";

/** One member of an archive: its name and its bytes. */
export interface ArchiveMember {
	readonly path: string;
	readonly bytes: Buffer;
}

/**
 * A zip archive holding `members`, each written once under its name. A
 * member whose name another's shares in any letter case (`memberKey`), or
 * whose name stands at or above another's directory (`a/b` beside `a/b/c`),
 * throws: two producers met in one name, and a zip writer would keep one of
 * them silently. `where` names the caller for the message.
 */
export function zipMembers(
	members: readonly ArchiveMember[],
	where: string,
): Buffer {
	checkArchivePaths(members, where);
	const zip = new AdmZip();
	for (const { path, bytes } of members) zip.addFile(path, bytes);
	return zip.toBuffer();
}

export function checkArchivePaths(
	members: readonly { path: string }[],
	where: string,
	workspace = Number.POSITIVE_INFINITY,
) {
	const files = new Set<string>(),
		directories = new Set<string>();
	let bytes = 0;
	const charge = (amount: number) => {
		bytes += amount;
		if (bytes > workspace)
			throw new Error(
				"The file directory exceeds the available export workspace. You can publish directly to your project space.",
			);
	};
	const conflict = (): never => {
		throw new Error(
			`${where} was given two archive members that are one file to a phone: their names differ only by letter case, or one names the other's directory. ` +
				"The compiler names its own files through lib/commcare/cczMembers.ts and a media path is never one of those shapes (isHoldableWirePath), so look at what produced the second member.",
		);
	};
	for (const { path } of members) {
		const key = memberKey(path);
		if (files.has(key) || directories.has(key)) conflict();
		// Include the lazy entry descriptor and its encoded central-directory name.
		charge(512 + 3 * Buffer.byteLength(path));
		files.add(key);
		for (
			let slash = key.indexOf("/");
			slash >= 0;
			slash = key.indexOf("/", slash + 1)
		) {
			const parent = key.slice(0, slash);
			if (files.has(parent)) conflict();
			if (directories.has(parent)) continue;
			charge(96 + 2 * parent.length);
			directories.add(parent);
		}
	}
}
