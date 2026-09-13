/** A field's exact path keeps its meaning. A short name also works when it
 * identifies one field in the supplied scope. Rename aliases for the same
 * identity do not make a name ambiguous. */
export function fieldNameCandidates<T extends { uuid: string; path: string }>(
	name: string,
	fields: readonly T[],
): T[] {
	const identity = fields.find((field) => field.uuid === name);
	if (identity) return [identity];
	const exact = fields.filter((field) => field.path === name);
	const candidates = exact.length
		? exact
		: fields.filter((field) => field.path.split("/").at(-1) === name);
	return [...new Map(candidates.map((field) => [field.uuid, field])).values()];
}
