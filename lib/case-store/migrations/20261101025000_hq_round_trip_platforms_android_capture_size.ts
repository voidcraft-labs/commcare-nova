// A worker's capture on Android may be as large as Android sends: 15 MiB less
// 1 KiB (`utils/FormUploadUtil.java::MAX_BYTES`), where Web Apps stops at
// 4,000,000 bytes. The upload route applies the platform's own limit
// (`lib/domain/captureFormats.ts::CAPTURE_LIMITS`); this widens the row's size
// check to the larger of the two so an Android capture can be stored.
//
// It only widens, so it is safe under the previous image too. It is one of the
// HQ round trip's platform migrations, applied with the others inside the
// cutover window so the ledger moves once.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE form_attachments DROP CONSTRAINT form_attachments_size_check
	`.execute(db);
	await sql`
		ALTER TABLE form_attachments ADD CONSTRAINT form_attachments_size_check
			CHECK (size_bytes > 0 AND size_bytes <= 15727616)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE form_attachments DROP CONSTRAINT form_attachments_size_check
	`.execute(db);
	await sql`
		ALTER TABLE form_attachments ADD CONSTRAINT form_attachments_size_check
			CHECK (size_bytes > 0 AND size_bytes <= 4000000)
	`.execute(db);
}
