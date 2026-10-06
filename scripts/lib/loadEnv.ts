/**
 * Loads `.env` from the working directory into `process.env`, leaving any
 * variable the shell already exported untouched. Import it for its side
 * effect, first, so the values exist before any other module evaluates.
 *
 * A missing `.env` is fine: the script then runs on the shell's environment
 * alone. Any other failure to read the file is reported.
 */
try {
	process.loadEnvFile();
} catch (error) {
	const missing =
		error instanceof Error && "code" in error && error.code === "ENOENT";
	if (!missing) throw error;
}
