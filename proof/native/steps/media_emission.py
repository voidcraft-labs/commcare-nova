"""HQ's media pass over Nova's media exports (``media`` family), in the order the chain needs.

``validation_sources`` is HQ's first pass: each scenario's form source with
HQ's own ``XForm.strip_vellum_ns_attributes``, the bytes HQ sends Formplayer
to validate (``<scenario>.validation.xml``). Core then parses exactly those
bytes (``MediaRuntimeTest.sourceFormsParseWithRealCoreBeforeHqMatching``,
run by ``NativeSession.media_certificate``) and writes their digests to
``core-validated-sources.properties``.

``media`` is HQ's main pass, one project space per scenario. HQ imports the
scenario, regenerates its form, suite (no remote requests), English app
strings, profile and media suite (``<scenario>.hq.*``), and, where the
scenario carries media, runs its whole bulk multimedia upload task
(``hqmedia/tasks.py::process_bulk_upload_zip``) over Nova's upload zip, on the
harness's Couch and blob store: HQ holds the app, stores each media object and
its bytes, and saves the app's multimedia map. Formplayer's form validation
is the session's Core runner, and HQ may send it only forms Core certified
(``UncertifiedSource`` refuses any other).
"""

from dataclasses import dataclass, field

from lxml import etree

from proof.hq.boot import HarnessRefusal
from proof.native.hq_support import (
    NOVA_SERVER_ORIGIN,
    hand_assembled_suite,
    import_source,
    native_check,
    regenerate_form,
    sha256,
)

DOMAIN = "nova-media-proof"
SCENARIOS = ["media-rich-on", "media-rich-off", "media-only-on", "media-only-off"]
HQ_SOURCES = [
    "corehq/apps/hqmedia/tasks.py",
    "corehq/apps/hqmedia/models.py",
    "corehq/apps/hqmedia/cache.py",
    "corehq/apps/app_manager/suite_xml/generator.py",
    "corehq/apps/app_manager/xform.py",
]
# The privileges HQ reads on this path, granted as a project space that
# uploads media and a logo holds them: the profile's logo properties
# (models/applications.py::Application.create_profile reads
# COMMCARE_LOGO_UPLOADER) and its app dependencies (APP_DEPENDENCIES, read by
# create_profile and app_strings.py::_create_dependencies_app_strings, which
# write nothing for an app that declares none). USERCASE stays refused:
# Nova's media forms write no worker record.
PRIVILEGES = {"COMMCARE_LOGO_UPLOADER", "APP_DEPENDENCIES"}


class UncertifiedSource(HarnessRefusal):
    """HQ asked Formplayer to validate a form whose exact source Core has not certified."""


def _canonical(xml: bytes) -> bytes:
    return etree.tostring(etree.fromstring(xml), method="c14n")


@dataclass
class Certificate:
    """Core's certificate: each certified source's digest, and the validations HQ asked for."""

    digests: dict[str, str]
    mismatched: list[str]
    by_canonical: dict[bytes, str]
    calls: list[str] = field(default_factory=list)

    def validator(self, validate):
        def certified(xml: bytes) -> str:
            name = self.by_canonical.get(_canonical(xml))
            if name is None:
                raise UncertifiedSource(
                    "HQ asked Formplayer to validate a form source that Core did not certify "
                    "(core-validated-sources.properties names only the sources HQ's first pass prepared), "
                    "so the media pass cannot claim Core parsed what HQ validated."
                )
            self.calls.append(name)
            return validate(xml)

        return certified


def read_certificate(exports, path):
    digests = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            name, digest = line.strip().split("=", 1)
            digests[name] = digest
    mismatched = [name for name, digest in digests.items() if sha256((exports / name).read_bytes()) != digest]
    by_canonical = {_canonical((exports / name).read_bytes()): name for name in digests}
    return Certificate(digests, mismatched, by_canonical)


def validation_sources(session):
    from corehq.apps.app_manager.xform import XForm

    exports = session.family("media")
    with native_check(DOMAIN):
        for name in SCENARIOS:
            form = XForm((exports / f"{name}.source.xml").read_bytes())
            form.strip_vellum_ns_attributes()
            (exports / f"{name}.validation.xml").write_bytes(etree.tostring(form.xml))
    return SCENARIOS


def _bulk_upload(name, exports, app):
    from corehq.apps.app_manager.dbaccessors import get_app
    from corehq.apps.hqmedia.cache import BulkMultimediaStatusCache, BulkMultimediaStatusCacheNfs
    from corehq.apps.hqmedia.models import CommCareMultimedia
    from corehq.apps.hqmedia.tasks import process_bulk_upload_zip

    # HQ's task reads the app it maps media into back from HQ.
    app.save()
    status = BulkMultimediaStatusCacheNfs(name, str(exports / f"{name}.multimedia.zip"))
    status.save()
    process_bulk_upload_zip.run(name, DOMAIN, app._id, username="proof")
    result = BulkMultimediaStatusCache.get(name).get_response()
    held = get_app(DOMAIN, app._id)
    mapped = {}
    for reference, mapping in held.multimedia_map.items():
        media_class = CommCareMultimedia.get_doc_class(mapping.media_type)
        media = media_class.get(mapping.multimedia_id)
        mapped[reference] = {
            "mediaType": mapping.media_type,
            "bytes": media.get_display_file(return_type=False),
            "fileHash": media.file_hash,
            "owners": list(media.owners),
            "heldByHash": media_class.get_by_hash(media.file_hash)._id == media._id,
        }
    return result, mapped


def _classify(data, path):
    from corehq.apps.hqmedia.models import CommCareMultimedia

    media_class = CommCareMultimedia.get_class_by_data(data, filename=path)
    return {
        "class": media_class.__name__,
        "reference": media_class.get_form_path(path),
        "hash": media_class.generate_hash(data),
    }


def media(session):
    from corehq.apps.app_manager.suite_xml.generator import MediaSuiteGenerator

    session.step("media-validation")
    exports = session.family("media")
    certificate = read_certificate(exports, session.media_certificate())
    records = []
    for name in SCENARIOS:
        enabled = name.endswith("-on")
        check = native_check(
            DOMAIN,
            validate=certificate.validator(session.validate_form),
            privileges=PRIVILEGES,
            server_origin=NOVA_SERVER_ORIGIN,
        )
        with check as (_, seams):
            app = import_source((exports / f"{name}.json").read_bytes(), DOMAIN)
            app._id = name
            app.version = 1
            app.custom_base_url = NOVA_SERVER_ORIGIN
            form = app.get_module(0).get_form(0)
            (exports / f"{name}.hq.xml").write_bytes(regenerate_form(form, DOMAIN))
            (exports / f"{name}.hq.suite.xml").write_bytes(hand_assembled_suite(app, remote_requests=False))
            (exports / f"{name}.hq.strings.properties").write_text(app.create_app_strings("en"))
            (exports / f"{name}.hq.profile.xml").write_bytes(app.create_profile(with_media=enabled))
            native_media = etree.tostring(etree.fromstring(MediaSuiteGenerator(app).generate_suite()))
            (exports / f"{name}.hq.media-suite.xml").write_bytes(native_media)
            record = {
                "scenario": name,
                "enabled": enabled,
                "nativeMediaSuite": native_media,
                "localMediaSuite": (exports / f"{name}.media-suite.xml").read_bytes(),
                "multimediaMapBeforeUpload": len(app.multimedia_map),
                "privilegesRead": seams.privilege_slugs_read(),
            }
            if enabled:
                import zipfile

                with zipfile.ZipFile(exports / f"{name}.multimedia.zip") as archive:
                    uploaded = {path: archive.read(path) for path in archive.namelist()}
                record["uploaded"] = {path: {**_classify(data, path), "bytes": data} for path, data in uploaded.items()}
                record["bulkStatus"], record["mapped"] = _bulk_upload(name, exports, app)
        records.append(record)
    return {"certificate": certificate, "records": records}
