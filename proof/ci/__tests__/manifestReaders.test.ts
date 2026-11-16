// What the surface manifest and the lane's manifest check must say alike.
//
// A REFUSED entry that splits a key by value class is held only where the lane
// can read that class of a use: the check asks the class's reader, by the
// entry's id, in proof/checks/manifest_value_classes.py (VALUE_CLASSES), and a
// REFUSED class with no reader leaves every use of its keys undecided
// (proof/checks/manifest_usage.py::standing), a difference no register entry
// may hold. Its one exception is an entry refused only because HQ's build
// refuses its state, whose uses the bar reports
// (manifest_usage.py::Entry.refused_by_hq_build). The lane's own test holds the
// same rule (test_manifest_value_classes.py::
// test_every_keyed_refused_class_has_a_reader_or_is_a_known_gap), but it runs
// only where the lane runs its packages, so an entry added without its reader
// passed a pull request and failed every document that uses its keys a night
// later. The plausible failure held here: a new REFUSED entry with a value
// class, and no reader registered for it nor its keys listed as one no export
// uses (KNOWN_GAPS).
//
// The two Python names are read through Python's own parser (`ast`), which
// the machine's Python has with nothing but its standard library, never by
// matching their source text.

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { loadManifest } from "@/lib/commcare/surface/__tests__/loadManifest";
import type { InventoryEntry } from "@/lib/commcare/surface/schema";

const run = promisify(execFile);
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..");
const CHECKS = join(WORKTREE, "proof", "checks");

// Prints the keys of a module-level dict literal, or the members of a module-level frozenset({...}) literal, as
// JSON: argv is the file and the name.
const READ_NAME = `
import ast, json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    tree = ast.parse(handle.read())
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
        value = node.value
        if isinstance(value, ast.Call) and value.args:
            value = value.args[0]
        members = value.keys if isinstance(value, ast.Dict) else value.elts
        if not all(isinstance(m, ast.Constant) and isinstance(m.value, str) for m in members):
            sys.exit(f"{name} in {path} holds a member that is no string literal")
        print(json.dumps([m.value for m in members]))
        break
else:
    sys.exit(f"{path} assigns no {name} at its top level")
`;

async function pythonNames(file: string, name: string): Promise<Set<string>> {
	const { stdout } = await run(
		"python3",
		["-I", "-c", READ_NAME, join(CHECKS, file), name],
		{ cwd: WORKTREE },
	);
	return new Set(JSON.parse(stdout) as string[]);
}

/** Whether the lane needs a reader of the entry's value class to decide a use of its keys. */
function needsReader(entry: InventoryEntry): boolean {
	if (entry.disposition !== "REFUSED" || entry.valueClass === undefined) {
		return false;
	}
	return !entry.reasons.every((reason) => reason.kind === "not-hq-buildable");
}

/** The entries the lane cannot decide a use of: needing a reader, with none and not a known gap. */
function undecidable(
	inventory: readonly InventoryEntry[],
	readers: ReadonlySet<string>,
	gaps: ReadonlySet<string>,
): string[] {
	return inventory
		.filter(
			(entry) =>
				needsReader(entry) && !readers.has(entry.id) && !gaps.has(entry.id),
		)
		.map((entry) => entry.id)
		.sort();
}

it("gives every refused value class the lane must read a reader there", async () => {
	const { inventory } = loadManifest();
	const [readers, gaps] = await Promise.all([
		pythonNames("manifest_value_classes.py", "VALUE_CLASSES"),
		pythonNames("test_manifest_value_classes.py", "KNOWN_GAPS"),
	]);
	expect(undecidable(inventory, readers, gaps)).toEqual([]);
	// A reader is consulted by its entry's id, so one whose entry was renamed or removed reads nothing.
	const ids = new Set(inventory.map((entry) => entry.id));
	expect([...readers].filter((id) => !ids.has(id)).sort()).toEqual([]);
	// A known gap names an entry that still needs a reader and has none; one given a reader leaves the list.
	const needing = new Set(
		inventory.filter(needsReader).map((entry) => entry.id),
	);
	expect(
		[...gaps].filter((id) => !needing.has(id) || readers.has(id)).sort(),
	).toEqual([]);
});

it("names an entry by its id when its refused class has no reader, and not one the bar reports", async () => {
	const { inventory } = loadManifest();
	const [readers, gaps] = await Promise.all([
		pythonNames("manifest_value_classes.py", "VALUE_CLASSES"),
		pythonNames("test_manifest_value_classes.py", "KNOWN_GAPS"),
	]);
	const read = inventory.find(
		(entry) => needsReader(entry) && readers.has(entry.id),
	);
	if (read === undefined || read.disposition !== "REFUSED") {
		throw new Error("The manifest holds no REFUSED entry with a reader.");
	}
	// The same entry with its reader gone is named; refused only because HQ's build refuses it, it is the bar's.
	const unread = new Set([...readers].filter((id) => id !== read.id));
	expect(undecidable(inventory, unread, gaps)).toEqual([read.id]);
	const barOnly: InventoryEntry = {
		...read,
		reasons: [
			{
				kind: "not-hq-buildable",
				named: "the build's refusal",
			},
		],
	};
	expect(
		undecidable(
			inventory.map((entry) => (entry === read ? barOnly : entry)),
			unread,
			gaps,
		),
	).toEqual([]);
});
