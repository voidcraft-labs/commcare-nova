// One row per file a worker attaches to a form in the running preview.
//
// This is a SUBMISSION-SCOPED lane, deliberately separate from
// `media_assets`. A worker-captured photo is data, not an authoring
// asset: putting it in the library would surface it in the media picker,
// count it against the export budget, and make it deletable through the
// library UI. CommCare's own model agrees — staged capture bytes live
// under the form session and are disposable
// (`FormSession::getMediaDirectoryPath`, `V26__init_media_meta_data`'s
// `ON DELETE SET NULL`).
//
// Tenancy matches case rows, `(app_id, project_id)`, because a capture is
// evidence attached to a submission and every member of the app's Project
// sees the same submissions. `created_by` is a second, narrower axis: it
// exists so submit-time reconciliation can only ever reconcile away the
// acting member's OWN staged rows. Without it, a co-member in a shared
// Project could delete another member's in-flight captures by sending
// their `entry_key` — reachable, not theoretical.
//
// Three statuses, and the reason each exists:
//
//   - `pending`   — the row is minted and a signed PUT URL issued, but
//     the bytes are unverified. A form answer must NOT reference a
//     pending row; the client sets the answer only after confirm.
//   - `staged`    — the object exists and its size is known. The answer
//     may reference it, and it may be replaced or removed.
//   - `submitted` — the form submitted and named this attachment, so the
//     bytes have been promoted out of the TTL'd staging prefix to a
//     durable per-Project key.
//
// `expires_at` bounds only the first two. It is metadata hygiene, not the
// retention guarantee: the bytes are reaped independently by a GCS bucket
// lifecycle rule on the staging prefix, so a Project that never writes
// again still stops holding photographs. See
// `lib/storage/media.ts::applyMediaBucketLifecycle`.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS form_attachments (
			attachment_id text PRIMARY KEY,
			attachment_name text NOT NULL,
			app_id text NOT NULL,
			project_id text NOT NULL,
			created_by text NOT NULL,
			entry_key text NOT NULL,
			field_uuid text NOT NULL,
			instance_path text NOT NULL,
			original_filename text NOT NULL,
			extension text NOT NULL,
			content_type text NOT NULL,
			size_bytes bigint NOT NULL,
			gcs_object_key text NOT NULL,
			status text NOT NULL,
			created_at timestamptz(3) NOT NULL DEFAULT now(),
			expires_at timestamptz(3) NOT NULL DEFAULT (now() + interval '1 day'),
			submitted_at timestamptz(3),
			CONSTRAINT form_attachments_status_check
				CHECK (status IN ('pending', 'staged', 'submitted')),
			CONSTRAINT form_attachments_size_check CHECK (size_bytes >= 0),
			CONSTRAINT form_attachments_expiry_check CHECK (expires_at > created_at),
			CONSTRAINT form_attachments_submitted_stamp_check
				CHECK ((status = 'submitted') = (submitted_at IS NOT NULL))
		)`.execute(db);

	// Submit-time reconciliation and clear/replace both scope by the form
	// entry plus the acting member, so that pair leads.
	await sql`
		CREATE INDEX IF NOT EXISTS form_attachments_entry
			ON form_attachments (entry_key, created_by)`.execute(db);

	// The opportunistic purge sweeps expired non-submitted rows only. A
	// partial index keeps it off the submitted rows, which never expire and
	// are the ones that accumulate.
	await sql`
		CREATE INDEX IF NOT EXISTS form_attachments_expiry
			ON form_attachments (expires_at, attachment_id)
			WHERE status <> 'submitted'`.execute(db);

	// A whole-tenant walk (a Project move, an eventual Project deletion)
	// reaches an app's captures by this pair, the same axis case rows use.
	await sql`
		CREATE INDEX IF NOT EXISTS form_attachments_tenant
			ON form_attachments (app_id, project_id)`.execute(db);

	// The submitted-attachment lookup a downstream consumer performs is by
	// name within a tenant, never by the primary key alone: the answer a
	// form carries is the NAME.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS form_attachments_name
			ON form_attachments (project_id, attachment_name)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Teardown only — a deployed schema change always fixes forward.
	await sql`DROP TABLE IF EXISTS form_attachments`.execute(db);
}
