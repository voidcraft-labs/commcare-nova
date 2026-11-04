// A publish asks a person to confirm that a project space has CommCare Supply turned off, for an app
// with an advanced menu whose case list is its own menu item, or a form whose source text names the
// session's supply point: a fifth confirmation kind, `commtrack-off`, stored under its own name as
// subject. Additive in effect: every row the revision before writes still passes both constraints.

import { type Kysely, sql } from "kysely";

/** A person may confirm that a project space has CommCare Supply turned off. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE public.app_deployment_confirmations
		DROP CONSTRAINT app_deployment_confirmations_kind_check,
		ADD CONSTRAINT app_deployment_confirmations_kind_check CHECK (kind IN
			('plan-feature', 'flat-location-fixture', 'connect-forwarder', 'form-entry-sync-off', 'commtrack-off')),
		ADD CONSTRAINT app_deployment_confirmations_commtrack_subject
			CHECK (kind <> 'commtrack-off' OR subject = 'commtrack-off')`.execute(db);
}

/** Forward only: undoing it would delete what people confirmed. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: undoing it would delete what people confirmed about their project spaces.",
	);
}
