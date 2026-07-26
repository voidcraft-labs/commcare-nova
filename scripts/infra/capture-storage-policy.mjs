const STAGED_PREFIX = "captures-staged/";

/**
 * Domain-side mirror of the IAM condition. Tests enumerate every object-key
 * family because IAM Conditions provide no regex and a shared bucket also
 * holds authoring media.
 */
export function captureCleanupObjectKeyAllowed(objectKey) {
	if (objectKey.startsWith(STAGED_PREFIX)) return true;
	const segments = objectKey.split("/");
	return (
		segments.length >= 4 &&
		segments[0] === "projects" &&
		segments[1] !== "" &&
		segments[2] === "captures" &&
		segments[3] !== ""
	);
}

export function captureCleanupIamCondition(bucket) {
	if (!/^[a-z0-9][a-z0-9._-]+$/.test(bucket)) {
		throw new Error(`Invalid storage bucket name: ${bucket}`);
	}
	const objectRoot = `projects/_/buckets/${bucket}/objects/`;
	const projectRoot = `${objectRoot}projects/`;
	const projectBeforeCaptures = `${projectRoot}{project}/captures/`;
	const firstProjectSegment = `${projectRoot}{project}/`;
	return [
		`resource.type == 'storage.googleapis.com/Object'`,
		"&&",
		"(",
		`resource.name.startsWith('${objectRoot}${STAGED_PREFIX}')`,
		"||",
		"(",
		`resource.name.startsWith('${projectRoot}')`,
		"&&",
		`resource.name.extract('${projectBeforeCaptures}') != ''`,
		"&&",
		`resource.name.extract('${projectBeforeCaptures}') == resource.name.extract('${firstProjectSegment}')`,
		"&&",
		`resource.name != '${projectRoot}' + resource.name.extract('${firstProjectSegment}') + '/captures/'`,
		")",
		")",
	].join(" ");
}

if (process.argv[1]?.endsWith("capture-storage-policy.mjs")) {
	const bucket = process.argv[2];
	if (!bucket) throw new Error("Usage: capture-storage-policy.mjs <bucket>");
	process.stdout.write(captureCleanupIamCondition(bucket));
}
