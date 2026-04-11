/**
 * Shared Firestore client for diagnostic scripts.
 *
 * Uses Application Default Credentials (`gcloud auth application-default login`).
 * Import `db` directly — no lazy init needed outside the server runtime.
 *
 * Formatting utilities (tok, truncate, tsToISO, usd) live in ./format.ts.
 */
import "dotenv/config";
import { Firestore } from "@google-cloud/firestore";

export const db = new Firestore({
	projectId: process.env.GOOGLE_CLOUD_PROJECT,
	ignoreUndefinedProperties: true,
	preferRest: true,
});
