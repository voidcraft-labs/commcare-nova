"""HQ's case list details for Nova's tile exports (``tile`` family).

HQ imports each tile scenario and regenerates only its details, with HQ's own
``DetailContributor``, into ``<scenario>.hq-details.xml`` (a ``<suite>`` of
the regenerated ``<detail>`` elements), which ``TileSuiteRuntimeTest`` parses
beside the CCZ suite.
"""

from proof.native.hq_support import import_source, native_check, sha256

DOMAIN = "nova-tile-evidence"


def tiles(session):
    from corehq.apps.app_manager.suite_xml.sections.details import DetailContributor
    from corehq.apps.app_manager.suite_xml.xml_models import Suite
    from lxml import etree

    exports = session.family("tile")
    sources = sorted(exports.glob("*.json"))
    records = []
    with native_check(DOMAIN):
        for source in sources:
            raw = source.read_bytes()
            app = import_source(raw, DOMAIN)
            details = DetailContributor(Suite(), app, list(app.get_modules())).get_section_elements()
            root = etree.Element("suite", version="1")
            for detail in details:
                root.append(etree.fromstring(detail.serialize()))
            native = etree.tostring(root)
            (exports / f"{source.stem}.hq-details.xml").write_bytes(native)
            records.append(
                {
                    "scenario": source.stem,
                    "sourceSha256": sha256(raw),
                    "local": (exports / f"{source.stem}.suite.xml").read_bytes(),
                    "native": native,
                }
            )
    return {"sources": [source.stem for source in sources], "records": records}
