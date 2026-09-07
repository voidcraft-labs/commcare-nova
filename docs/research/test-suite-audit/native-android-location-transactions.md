# Native owner guard transaction evidence

Read-only verification against local CommCare Android commit
79d8418ab2dcd9846ae297c8f1edd189393b8e35.

- app/src/org/commcare/android/database/user/models/FormRecord.java:383–415:
  synchronous completed-form processing opens the user DB transaction, invokes
  FormRecordProcessor.process, marks success only when the entire parse returns,
  and always ends the transaction. InvalidStructureException is rethrown as
  IllegalStateException before success is marked.
- app/src/org/commcare/sync/FormSubmissionHelper.java:195–207:
  background pending-form processing owns the same transaction boundary. The
  outer exception handler quarantines only after endTransaction rolls it back.
- app/src/org/commcare/models/FormRecordProcessor.java:78–97:
  production uses AndroidTransactionParserFactory and actual
  XmlFormRecordProcessor, and changes form status only after successful parsing.
- app/src/org/commcare/models/database/AndroidSandbox.java:34–35,
  app/src/org/commcare/CommCareApplication.java:672–695 and
  app/src/org/commcare/xml/AndroidCaseXmlParser.java:88–104:
  case storage and parser writes resolve the same user DB handle. Per-case
  commits are nested within the complete-form transaction.
- app/src/org/commcare/models/database/EncryptedDatabaseAdapter.java:33–44:
  beginTransaction/setTransactionSuccessful/endTransaction delegate to the
  actual net.zetetic.database.sqlcipher.SQLiteDatabase implementation.

Conclusion: source verification supports complete-form rollback on the trailing
invalid-case scalar guard. This is distinct from executed native Core evidence:
Core's MockUserDataSandbox has immediate in-memory writes and no transaction
rollback, so its parser can update an owner before the later guard rejects the
form. The native location tests assert the exact evaluation/rejection boundary,
not storage rollback. No Android runtime or remote HQ transaction was executed.
Nova Postgres independently proves ambiguous location writes roll back rows and
revision through its actual organization service.
