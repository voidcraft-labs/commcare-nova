/** Old snapshots could omit a search name that the adopted HQ menu still carried.
 * The outer exact-source conversion authenticates the frozen facts and reruns
 * their selector inside the fenced transaction. */
export function convertSearchResults(
	snapshot,
	settings,
	{ appId, projectId, purpose },
) {
	if (purpose === "private-genesis") return snapshot;
	if (
		snapshot.appId !== appId ||
		!projectId ||
		!Array.isArray(settings.searchResults?.targets)
	)
		throw new Error(
			"Search name conversion requires its app, Project and verified adoption sources.",
		);
	const names = new Map();
	for (const target of settings.searchResults.targets) {
		if (target.app_id !== appId || target.project_id !== projectId) continue;
		for (const { menu, name } of target.menus) {
			if (names.has(menu) && names.get(menu) !== name)
				throw new Error(
					"Two active adoptions disagree about a search name. Compare the retained sources before cutover.",
				);
			names.set(menu, name);
		}
	}
	let modules = snapshot.modules;
	for (const [id, name] of names) {
		const menu = Object.hasOwn(modules, id) ? modules[id] : undefined;
		if (!menu || name === null || menu.searchResultsName !== undefined)
			continue;
		if (modules === snapshot.modules) modules = { ...modules };
		modules[id] = { ...menu, searchResultsName: name };
	}
	return modules === snapshot.modules ? snapshot : { ...snapshot, modules };
}
