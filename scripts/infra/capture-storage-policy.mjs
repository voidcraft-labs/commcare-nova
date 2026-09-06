const STAGED_PREFIX = "captures-staged/";

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
		`!resource.name.endsWith('/')`,
		"&&",
		`resource.name.extract('//{afterDoubleSlash}') == ''`,
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
		")",
		")",
	].join(" ");
}

if (process.argv[1]?.endsWith("capture-storage-policy.mjs")) {
	const bucket = process.argv[2];
	if (!bucket) throw new Error("Usage: capture-storage-policy.mjs <bucket>");
	process.stdout.write(captureCleanupIamCondition(bucket));
}
