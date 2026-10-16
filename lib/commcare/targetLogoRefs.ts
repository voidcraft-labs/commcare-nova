/**
 * The `logo_refs` an update sends to an app a CommCare HQ target holds.
 *
 * An update that names `logo_refs` replaces HQ's whole dict, and one that
 * names none keeps it (`models/applications.py::_merge_source_into_app`).
 * Publish writes no logo of its own, so the key is sent only to take out
 * path-only entries: an entry whose only key is `path`. HQ's linked-app
 * pull reads `m_id` from every entry and fails on one without it
 * (`models/applications.py::LinkedApplication.reapply_overrides`), and
 * HQ's own uploader never writes one without it
 * (`hqmedia/views.py::ProcessLogoFileUploadView`).
 *
 * Built from the publish's last read of the app's source before the
 * import, like the overlays of `targetOverlay.ts`, so a logo uploaded in
 * HQ before that read is kept. Pure: no I/O.
 */

function isPathOnlyEntry(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return false;
	}
	const keys = Object.keys(entry);
	return keys.length === 1 && keys[0] === "path";
}

/**
 * The target's `logo_refs` without its path-only entries, every other
 * entry kept as HQ holds it; `null` when it holds no path-only entry, so
 * the update leaves the key out and HQ keeps the dict.
 */
export function withoutPathOnlyLogoRefs(
	logoRefs: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
	const kept = Object.entries(logoRefs).filter(
		([, entry]) => !isPathOnlyEntry(entry),
	);
	if (kept.length === Object.keys(logoRefs).length) return null;
	return Object.fromEntries(kept);
}
