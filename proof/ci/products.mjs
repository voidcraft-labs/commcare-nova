// Compares two productions of the native proofs' products (python3 -m
// proof.native.produce), as proof-image.yml's weekly check does across the
// two architectures and between the runner and the pinned image:
//
//   node proof/ci/products.mjs compare LEFT RIGHT
//
// CI's quality job produces them once, on an x64 runner with the runner's own
// Node, and the lane's shards read them on arm64 in the image; so a product
// must be the same wherever it is produced, but for the identities its
// producers mint afresh in every production (they export outside the corpus's
// seeded operations, proof/corpus/entropy.mts): Nova's 40- and 16-digit hex
// ids (lib/commcare/ids.ts) and UUIDs (crypto.randomUUID), the shapes in
// which two productions differ. Within each product (a top-level directory),
// such a token that only one side holds is renamed, on that side, after its
// first appearance across the product's files in path order; so the two are
// equal exactly when they differ by a one-to-one renaming of the ids each one
// minted. A token both sides hold is compared as written, and ids that relate
// differently across a product's files differ. A zip archive (a .ccz, an
// .xlsx) is compared entry by entry, in its own order, by name and content.
// logs/ and timings.json say how a production went and are not compared;
// produced.json is, and a product that failed on either side fails the
// comparison.
//
// Exits 0 when the two are equal, 1 naming every file that differs and where
// it first does, and 2 when either side cannot be read. Node's standard
// library only, so the comparing job installs nothing.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const PRODUCED = "produced.json";
const NOT_COMPARED = new Set(["logs", "timings.json"]);
const MINTED =
	/(?<![0-9A-Za-z])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{40}|[0-9a-f]{16})(?![0-9A-Za-z])/g;
const ZIP_ENTRY = 0x04034b50;
const ZIP_DIRECTORY = 0x02014b50;
const ZIP_END = 0x06054b50;
// How many differing files are shown, each with its first difference.
const SHOWN = 40;

class Unreadable extends Error {}

/** Every file under `root` but what is not compared, as [path relative to root, in / form], in path order. */
async function files(root) {
	let entries;
	try {
		entries = await readdir(root, { recursive: true, withFileTypes: true });
	} catch (error) {
		throw new Unreadable(`${root} cannot be read (${error.code ?? error}).`);
	}
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) =>
			relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"),
		)
		.filter((path) => !NOT_COMPARED.has(path.split("/")[0]))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The entries of the zip archive `bytes` (`where` names it), as [{name, content}], in the archive's order. */
function zipEntries(bytes, where) {
	let end = -1;
	for (
		let at = bytes.length - 22;
		at >= Math.max(0, bytes.length - 22 - 0xffff);
		at--
	) {
		if (bytes.readUInt32LE(at) === ZIP_END) {
			end = at;
			break;
		}
	}
	if (end < 0) {
		throw new Unreadable(
			`${where} begins as a zip archive but has no end of its central directory, so its entries cannot be read.`,
		);
	}
	const count = bytes.readUInt16LE(end + 10);
	let at = bytes.readUInt32LE(end + 16);
	if (count === 0xffff || at === 0xffffffff) {
		throw new Unreadable(
			`${where} is a ZIP64 archive, which the comparison does not read; the products are small archives.`,
		);
	}
	const entries = [];
	for (let index = 0; index < count; index++) {
		if (bytes.readUInt32LE(at) !== ZIP_DIRECTORY) {
			throw new Unreadable(
				`${where}'s central directory breaks off at entry ${index + 1} of ${count}.`,
			);
		}
		const method = bytes.readUInt16LE(at + 10);
		const size = bytes.readUInt32LE(at + 20);
		const nameLength = bytes.readUInt16LE(at + 28);
		const local = bytes.readUInt32LE(at + 42);
		const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
		at +=
			46 +
			nameLength +
			bytes.readUInt16LE(at + 30) +
			bytes.readUInt16LE(at + 32);
		if (bytes.readUInt32LE(local) !== ZIP_ENTRY) {
			throw new Unreadable(
				`${where}'s entry ${name} points at no entry of the archive.`,
			);
		}
		const start =
			local +
			30 +
			bytes.readUInt16LE(local + 26) +
			bytes.readUInt16LE(local + 28);
		const stored = bytes.subarray(start, start + size);
		if (method !== 0 && method !== 8) {
			throw new Unreadable(
				`${where}'s entry ${name} is compressed by method ${method}; the comparison reads stored and deflated entries.`,
			);
		}
		entries.push({
			name,
			content: method === 8 ? inflateRawSync(stored) : stored,
		});
	}
	return entries;
}

/** `bytes` as what is compared: itself, or each entry of it (recursively) when it is a zip archive. */
function* expanded(path, bytes) {
	if (bytes.length >= 4 && bytes.readUInt32LE(0) === ZIP_ENTRY) {
		for (const entry of zipEntries(bytes, path)) {
			yield* expanded(`${path}!${entry.name}`, entry.content);
		}
	} else {
		yield [path, bytes];
	}
}

/** One side's products: {product name: [[path, bytes as latin1 text], ...]} in path order. */
async function production(root) {
	const products = new Map();
	for (const path of await files(root)) {
		const product = path.includes("/") ? path.split("/")[0] : "";
		const bytes = await readFile(join(root, path));
		if (!products.has(product)) products.set(product, []);
		for (const [name, content] of expanded(path, bytes)) {
			products.get(product).push([name, content.toString("latin1")]);
		}
	}
	return products;
}

async function outcomes(root) {
	try {
		return JSON.parse(await readFile(join(root, PRODUCED), "utf8"));
	} catch (error) {
		throw new Unreadable(
			`${join(root, PRODUCED)} cannot be read (${error.code ?? error.message}); python3 -m proof.native.produce writes it with every production.`,
		);
	}
}

/** The product's files with every id-shaped token `other` does not hold renamed after its first appearance. */
function masked(items, other) {
	const names = new Map();
	return new Map(
		items.map(([path, text]) => [
			path,
			text.replace(MINTED, (token) => {
				if (other.has(token)) return token;
				if (!names.has(token)) names.set(token, `<minted-${names.size + 1}>`);
				return names.get(token);
			}),
		]),
	);
}

function tokens(items) {
	const held = new Set();
	for (const [, text] of items) {
		for (const match of text.matchAll(MINTED)) held.add(match[0]);
	}
	return held;
}

/** Where `left` and `right` first differ, with a little of each around it. */
function firstDifference(left, right) {
	let at = 0;
	while (at < left.length && at < right.length && left[at] === right[at]) at++;
	const around = (text) =>
		JSON.stringify(text.slice(Math.max(0, at - 30), at + 50));
	return `at byte ${at}: left ${around(left)}, right ${around(right)}`;
}

async function compare(left, right) {
	const problems = [];
	const [leftOutcomes, rightOutcomes] = [
		await outcomes(left),
		await outcomes(right),
	];
	for (const name of [
		...new Set([...Object.keys(leftOutcomes), ...Object.keys(rightOutcomes)]),
	].sort()) {
		for (const [side, recorded] of [
			["left", leftOutcomes],
			["right", rightOutcomes],
		]) {
			const outcome = recorded[name];
			if (outcome === undefined) {
				problems.push(
					`the ${name} product is not recorded on the ${side} (${PRODUCED}).`,
				);
			} else if (outcome.error) {
				problems.push(
					`the ${name} product failed on the ${side}: it ${outcome.error}.`,
				);
			}
		}
	}
	const [leftProducts, rightProducts] = [
		await production(left),
		await production(right),
	];
	const differing = [];
	for (const product of [
		...new Set([...leftProducts.keys(), ...rightProducts.keys()]),
	].sort()) {
		const leftItems = leftProducts.get(product) ?? [];
		const rightItems = rightProducts.get(product) ?? [];
		const leftMasked = masked(leftItems, tokens(rightItems));
		const rightMasked = masked(rightItems, tokens(leftItems));
		const leftPaths = [...leftMasked.keys()];
		const rightPaths = [...rightMasked.keys()];
		for (const path of [...new Set([...leftPaths, ...rightPaths])].sort()) {
			if (!rightMasked.has(path)) {
				differing.push(`${path}: only on the left.`);
			} else if (!leftMasked.has(path)) {
				differing.push(`${path}: only on the right.`);
			} else if (leftMasked.get(path) !== rightMasked.get(path)) {
				differing.push(
					`${path}: differs ${firstDifference(leftMasked.get(path), rightMasked.get(path))}.`,
				);
			}
		}
		const common = leftPaths.filter((path) => rightMasked.has(path));
		const commonRight = rightPaths.filter((path) => leftMasked.has(path));
		if (common.join("\n") !== commonRight.join("\n")) {
			differing.push(
				`${product}: its archives hold the same entries in another order.`,
			);
		}
	}
	return { problems, differing };
}

async function main(argv) {
	const [command, left, right, ...rest] = argv;
	if (command !== "compare" || !left || !right || rest.length > 0) {
		throw new Unreadable(
			"products.mjs takes `compare LEFT RIGHT`, two directories that python3 -m proof.native.produce wrote.",
		);
	}
	const { problems, differing } = await compare(left, right);
	if (problems.length === 0 && differing.length === 0) {
		process.stdout.write(
			`The products in ${left} and ${right} are the same, but for the ids each production minted.\n`,
		);
		return 0;
	}
	const lines = [
		`The products in ${left} (left) and ${right} (right) are not the same:`,
		...problems.map((problem) => `  ${problem}`),
	];
	if (differing.length > 0) {
		lines.push(
			`  ${differing.length} files differ once the ids each production minted are renamed alike:`,
			...differing.slice(0, SHOWN).map((line) => `    ${line}`),
		);
		if (differing.length > SHOWN) {
			lines.push(`    and ${differing.length - SHOWN} more.`);
		}
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return 1;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	process.stderr.write(
		`${error instanceof Unreadable ? error.message : (error?.stack ?? error)}\n`,
	);
	process.exitCode = 2;
}
