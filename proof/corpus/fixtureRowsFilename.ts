/** Retain a table's spelling even on case-insensitive, Unicode-normalizing filesystems.
 * The portable lowercase ASCII spelling keeps existing witness paths readable. For
 * other tags each scalar is written in lowercase hex, bounded by HQ's tag length. */
export function fixtureRowsFilename(tag: string): string {
	const stem = /^[a-z_][a-z0-9_.-]*$/.test(tag)
		? `-${tag}`
		: `~${Array.from(tag, (unit) => unit.codePointAt(0)?.toString(16)).join("-")}`;
	return `fixture-rows${stem}.json`;
}

export function fixtureRowsTag(name: string): string | undefined {
	const plain = /^fixture-rows-([A-Za-z_][A-Za-z0-9_.-]*)\.json$/.exec(name);
	if (plain) return plain[1];
	const encoded =
		/^fixture-rows~([0-9a-f]{1,6}(?:-[0-9a-f]{1,6}){0,31})\.json$/.exec(name);
	if (!encoded) return undefined;
	const units = encoded[1].split("-").map((unit) => Number.parseInt(unit, 16));
	if (
		units.some((unit) => unit > 0x10ffff || (unit >= 0xd800 && unit <= 0xdfff))
	)
		throw new Error(
			`Invalid Unicode scalar in retained fixture rows filename ${name}`,
		);
	const tag = String.fromCodePoint(...units);
	if (fixtureRowsFilename(tag) !== name)
		throw new Error(`Noncanonical retained fixture rows filename ${name}`);
	return tag;
}
