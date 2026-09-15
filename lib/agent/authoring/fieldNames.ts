/** A field's exact path keeps its meaning. A short name also works when it
 * identifies one field in the supplied scope. Rename aliases for the same
 * identity do not make a name ambiguous. */
export function fieldNameCandidates<T extends { uuid: string; path: string }>(
	name: string,
	fields: readonly T[],
): T[] {
	const exact = fieldPathCandidates(name, fields);
	if (exact.length) return exact;
	const candidates = fields.filter(
		(field) => field.path.split("/").at(-1) === name,
	);
	return [...new Map(candidates.map((field) => [field.uuid, field])).values()];
}

/** Native XPath paths do not inherit shorthand name lookup. */
export function fieldPathCandidates<T extends { uuid: string; path: string }>(
	path: string,
	fields: readonly T[],
): T[] {
	const identity = fields.find((field) => field.uuid === path);
	if (identity) return [identity];
	const candidates = fields.filter((field) => field.path === path);
	return [...new Map(candidates.map((field) => [field.uuid, field])).values()];
}
