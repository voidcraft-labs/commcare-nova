"""HQ's regeneration of Nova's forms: ``container``, ``navigation``, ``xml`` and ``connect`` families.

Each step imports every export of its family (``Application.from_source``)
and regenerates its forms with HQ's case and meta blocks
(``hq_support.regenerate_form``), writing each beside its input.

- ``containers``: each container scenario's form.
- ``navigations``: every form of the first module (``<scenario>.<i>.hq.xml``),
  with the new-case datums HQ allocates for each.
- ``xml_text``: HQ's parse of each scenario's source (``XForm.xml``), which
  the refused pre-fix sources fail, and the accepted ones regenerated.
- ``connect_forms``: the Connect scenarios, with Connect's own metadata
  extractors (``commcare_connect/opportunity/app_xml.py`` at the pin,
  fetched by ``NativeSession.connect_checkout``) run over HQ's source, the
  CCZ form and HQ's regenerated form.
"""

import importlib.util
import json
import sys
import types
from dataclasses import asdict
from unittest.mock import patch

from proof.native.hq_support import import_source, native_check, regenerate_form, sha256


def containers(session):
    domain = "nova-container-evidence"
    exports = session.family("container")
    records = []
    with native_check(domain, validate=session.validate_form):
        for source in sorted(exports.glob("container-*.json")):
            raw = source.read_bytes()
            form = import_source(raw, domain).get_module(0).get_form(0)
            native = regenerate_form(form, domain)
            source.with_suffix(".hq.xml").write_bytes(native)
            records.append({"scenario": source.stem, "sourceSha256": sha256(raw), "hqXmlSha256": sha256(native)})
    return records


def navigations(session):
    from corehq.apps.app_manager.suite_xml.sections.entries import EntriesHelper

    domain = "nova-navigation-evidence"
    exports = session.family("navigation")
    sources = sorted(exports.glob("*.json"))
    records = []
    with native_check(domain, validate=session.validate_form):
        for source in sources:
            raw = source.read_bytes()
            app = import_source(raw, domain)
            for index, form in enumerate(app.get_module(0).get_forms()):
                native = regenerate_form(form, domain)
                (exports / f"{source.stem}.{index}.hq.xml").write_bytes(native)
                datums = EntriesHelper.get_new_case_id_datums_meta(form)
                records.append(
                    {
                        "scenario": source.stem,
                        "form": index,
                        "inputSha256": sha256(raw),
                        "nativeFormSha256": sha256(native),
                        "newCaseDatums": [(meta.datum.id, str(meta.datum.function)) for meta in datums],
                    }
                )
    return {"sources": [source.stem for source in sources], "records": records}


def xml_text(session):
    from corehq.apps.app_manager.xform import XForm
    from lxml import etree

    domain = "nova-xml-evidence"
    exports = session.family("xml")
    records = []
    with native_check(domain, validate=session.validate_form):
        for scenario in json.loads((exports / "scenarios.json").read_bytes()):
            raw = (exports / f"{scenario['name']}.json").read_bytes()
            form = import_source(raw, domain).get_module(0).get_form(0)
            record = {"scenario": scenario, "inputSha256": sha256(raw), "error": None, "source": None}
            try:
                record["source"] = etree.tostring(XForm(form.source, domain=domain).xml)
            except Exception as error:
                record["error"] = type(error).__name__
            if record["source"] is not None:
                native = regenerate_form(form, domain)
                (exports / f"{scenario['name']}.hq.xml").write_bytes(native)
            records.append(record)
    return records


def _connect_extractors(checkout):
    """Connect's ``app_xml`` module at the pin, with the imports its XML extraction never uses supplied.

    Only the unused database model, HQ API exception and HTTP client imports
    are stood in for; the module and all its extraction functions execute
    unchanged. The HTTP client refuses, as every network reach here does.
    """
    from proof.hq.boot import GUARD

    models = types.ModuleType("commcare_connect.opportunity.models")
    models.CommCareApp = object
    api = types.ModuleType("commcare_connect.utils.commcarehq_api")
    api.CommCareHQAPIException = type("CommCareHQAPIException", (Exception,), {})
    httpx = types.ModuleType("httpx")

    def refuse(*_args, **_kwargs):
        GUARD.refuse_service("Connect's HQ download (httpx.get)")

    httpx.get = refuse
    source = checkout / "commcare_connect/opportunity/app_xml.py"
    spec = importlib.util.spec_from_file_location("nova_native_connect_app_xml", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    with patch.dict(
        sys.modules,
        {"commcare_connect.opportunity.models": models, "commcare_connect.utils.commcarehq_api": api, "httpx": httpx},
    ):
        spec.loader.exec_module(module)
    return module, source


def connect_forms(session):
    domain = "nova-connect-evidence"
    exports = session.family("connect")
    checkout = session.connect_checkout()
    extractors, extractor_source = _connect_extractors(checkout.path)
    scenarios = json.loads((exports / "scenarios.json").read_bytes())
    records = []
    with native_check(domain, validate=session.validate_form):
        for scenario in scenarios:
            name = scenario["name"]
            raw = (exports / f"{name}.json").read_bytes()
            form = import_source(raw, domain).get_module(0).get_form(0)
            native = regenerate_form(form, domain)
            (exports / f"{name}.hq.xml").write_bytes(native)
            artifacts = {"hq-source": form.source.encode(), "ccz": (exports / f"{name}.xml").read_bytes()}
            artifacts["hq-regenerated"] = native
            metadata = {
                path: {
                    "modules": [asdict(item) for item in extractors.extract_connect_blocks(xml)],
                    "deliver": [asdict(item) for item in extractors.extract_deliver_units(xml)],
                    "tasks": [asdict(item) for item in extractors.extract_task_units(xml)],
                }
                for path, xml in artifacts.items()
            }
            records.append(
                {
                    "name": name,
                    "inputSha256": sha256(raw),
                    "artifacts": {path: sha256(xml) for path, xml in artifacts.items()},
                    "metadata": metadata,
                }
            )
    return {
        "scenarios": [scenario["name"] for scenario in scenarios],
        "records": records,
        "connectCommit": checkout.commit,
        "connectSourceSha256": sha256(extractor_source.read_bytes()),
    }


def case_choices(session):
    domain = "nova-case-choice-evidence"
    exports = session.family("case-choice")
    records = []
    with native_check(domain, validate=session.validate_form):
        app = import_source((exports / "app.json").read_bytes(), domain)
        for index, name in enumerate(("directory", "attendance")):
            native = regenerate_form(app.get_module(index).get_form(0), domain)
            (exports / f"{name}.hq.xml").write_bytes(native)
            records.append({"form": name, "hqXmlSha256": sha256(native)})
    return records
