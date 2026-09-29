/** Allocate a calculated count beside its repeat without hiding authored data. */
export function repeatCountNodeName(
	fieldId: string,
	existingNames: ReadonlySet<string>,
): string {
	const base = `nova_count_${fieldId}`;
	let name = base;
	for (let n = 1; existingNames.has(name); n++) name = `${base}_${n}`;
	return name;
}
