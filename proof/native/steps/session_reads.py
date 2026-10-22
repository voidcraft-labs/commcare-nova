"""Native session reads use the targeted corpus's exports, outside balanced fixture edits."""

import shutil

from proof.checks.corpus import corpus_root, load
from proof.hq.operations import PLACEHOLDER_APP_ID, upload_field
from proof.native.hq_support import (
    NOVA_SERVER_ORIGIN,
    hand_assembled_suite,
    import_source,
    native_check,
    regenerate_form,
    sha256,
    write_evidence,
)

# The exact corpus trees this adapter reads. The native package's cache key
# reads this declaration without importing HQ or the adapter.
DOCUMENTS = (
    "targeted-form-link-session-reads",
    "targeted-nested-menu-session-reads",
    "targeted-tile-session-reads",
)


def session_reads(session, family, document_id, domain, *, endpoints=False):
    """Copy the target's exact local archive and regenerate its captured content through HQ.

    Core opens the copied CCZ itself. Neither the family's producer nor this
    adapter builds a separate local form or suite for the targeted scenario.
    """
    if document_id not in DOCUMENTS:
        raise ValueError(f"The native session witness {document_id} is not named in this adapter's DOCUMENTS.")
    document = load(corpus_root()).document(document_id)
    if not document.targeted:
        raise ValueError(f"The native session witness {document_id} must be a targeted corpus document.")
    archive = document.local_ccz
    if archive is None:
        raise ValueError(f"The targeted session witness {document_id} has no local.ccz archive.")
    export = document.exports["minimum"]
    if export.content is None:
        raise ValueError(f"The targeted session witness {document_id} has no captured minimum app content.")
    source = upload_field(export.content.upload(), "app_file")
    output = session.family(family) / "targeted" / document_id
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(archive, output / "local.ccz")
    configuration = export.configuration
    with native_check(
        domain,
        flags=configuration.flags,
        privileges=configuration.privileges,
        commcare_version=configuration.commcare_version,
        server_origin=NOVA_SERVER_ORIGIN,
    ):
        app = import_source(source, domain)
        app._id = PLACEHOLDER_APP_ID
        app.version = 1
        app.custom_base_url = NOVA_SERVER_ORIGIN
        suite = hand_assembled_suite(app, endpoints=endpoints)
        (output / "hq.suite.xml").write_bytes(suite)
        for index in (0, 1):
            form = app.get_module(1).get_form(index)
            (output / f"hq.{index}.xml").write_bytes(regenerate_form(form, domain))
    write_evidence(
        output,
        "session-reads",
        {
            "document": document_id,
            "configuration": configuration.name,
            "localArchiveSha256": sha256(archive.read_bytes()),
            "capturedSourceSha256": sha256(source),
            "hqSuiteSha256": sha256(suite),
        },
    )
