// A publish asks a person to confirm that a project space has Sync Cases On
// Form Entry turned off, for an app that declares Android and holds a form
// working on a case chosen in a menu with Search: a fourth confirmation kind,
// `form-entry-sync-off`, stored under its own name as subject.
//
// Additive in effect: every row the revision before it writes still passes
// both constraints.

import { type Kysely, sql } from "kysely";

/** A person may confirm that a project space has sync on form entry turned off. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE app_deployment_confirmations
		DROP CONSTRAINT app_deployment_confirmations_kind_check,
		ADD CONSTRAINT app_deployment_confirmations_kind_check CHECK (kind IN
			('plan-feature', 'flat-location-fixture', 'connect-forwarder', 'form-entry-sync-off')),
		ADD CONSTRAINT app_deployment_confirmations_form_entry_sync_subject
			CHECK (kind <> 'form-entry-sync-off' OR subject = 'form-entry-sync-off')`.execute(
		db,
	);
}

/** Forward only: undoing it would delete what people confirmed. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: undoing it would delete what people confirmed about their project spaces.",
	);
}
