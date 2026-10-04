"""HQ's side of the native proofs, on the harness's shared boot, state and seams.

``native_check`` opens one ``proof.hq.check.hq_check`` for a project space
the proof names: its domain, the flags and privileges HQ answers on, and the
CommCare version HQ builds at (``NATIVE_COMMCARE_VERSION``, which HQ reads as
its default build through the check's build configuration). Everything else
HQ reads from outside its state goes through the seams ``hq_check`` opens:
every flag not named is off, every privilege not named is refused,
Formplayer's form validation is the Core runner, and Elasticsearch, Couch,
Redis and the network are the harness's.

The rest are HQ's own calls the proofs share: importing an app the way
``Application.from_source`` does, regenerating a form's case and meta blocks,
and the suite contributors the proofs assemble by hand.
"""

import hashlib
import json
import subprocess
from contextlib import ExitStack, contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from proof.hq.boot import HQ_ROOT
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration

# The CommCare version the native proofs build Nova's exports at (HQ's
# default build spec for the check's project space).
NATIVE_COMMCARE_VERSION = "2.53.0"
# The server Nova's exports target. HQ writes its own address into the remote
# requests it builds (view_utils.absolute_reverse -> dimagi/utils/web.py::get_url_base).
NOVA_SERVER_ORIGIN = "https://www.commcarehq.org"


@contextmanager
def hq_server_origin(origin: str):
    """HQ's own address (``DEFAULT_PROTOCOL`` and ``BASE_ADDRESS``) is ``origin`` inside the block."""
    from django.test import override_settings

    parts = urlsplit(origin)
    with override_settings(DEFAULT_PROTOCOL=parts.scheme, BASE_ADDRESS=parts.netloc):
        yield


@contextmanager
def native_check(
    domain: str,
    *,
    validate,
    flags=(),
    privileges=(),
    commcare_version: str = NATIVE_COMMCARE_VERSION,
    server_origin: str | None = None,
):
    """One HQ check for the named project space; yields ``(state, record)``."""
    configuration = Configuration(
        flags=frozenset(flags),
        privileges=frozenset(privileges),
        commcare_version=commcare_version,
        domain=domain,
    )
    with hq_check(configuration, validate=validate) as (state, record), ExitStack() as stack:
        if server_origin is not None:
            stack.enter_context(hq_server_origin(server_origin))
        yield state, record


def import_source(raw: bytes, domain: str):
    """The app HQ makes of an exported app source (``Application.from_source``)."""
    from corehq.apps.app_manager.models import Application

    return Application.from_source(json.loads(raw), domain)


def regenerate_form(form, domain: str) -> bytes:
    """The form's source with HQ's case and meta blocks, as HQ's build writes them before rendering."""
    from corehq.apps.app_manager.xform import XForm
    from lxml import etree

    xform = XForm(form.source, domain=domain)
    xform.add_case_and_meta(form)
    xform.strip_vellum_ns_attributes()
    return etree.tostring(xform.xml)


def hand_assembled_suite(app, *, remote_requests: bool = True, endpoints: bool = False) -> bytes:
    """HQ's detail, entry and menu contributors and the post-processors the proofs name, serialized.

    This is part of ``SuiteGenerator.generate_suite``, assembled as the native
    proofs have always assembled it: details, then each module's entries and
    menus, then remote requests (optional), endpoints (optional), workflow and
    instances.
    """
    from corehq.apps.app_manager.suite_xml.generator import SuiteGenerator
    from corehq.apps.app_manager.suite_xml.post_process.endpoints import EndpointsHelper
    from corehq.apps.app_manager.suite_xml.post_process.instances import InstancesHelper
    from corehq.apps.app_manager.suite_xml.post_process.remote_requests import RemoteRequestsHelper
    from corehq.apps.app_manager.suite_xml.post_process.workflow import WorkflowHelper
    from corehq.apps.app_manager.suite_xml.sections.details import DetailContributor
    from corehq.apps.app_manager.suite_xml.sections.entries import EntriesContributor
    from corehq.apps.app_manager.suite_xml.sections.menus import MenuContributor

    generator = SuiteGenerator(app)
    details = generator.add_section(DetailContributor)
    entries = EntriesContributor(generator.suite, app, generator.modules, None)
    menus = MenuContributor(generator.suite, app, generator.modules, None)
    for module in generator.modules:
        generator.suite.entries.extend(entries.get_module_contributions(module))
        generator.suite.menus.extend(menus.get_module_contributions(module, None))
    if remote_requests:
        RemoteRequestsHelper(generator.suite, app, generator.modules).update_suite(details)
    if endpoints:
        EndpointsHelper(generator.suite, app, generator.modules).update_suite()
    WorkflowHelper(generator.suite, app, generator.modules).update_suite()
    InstancesHelper(generator.suite, app, generator.modules).update_suite()
    return generator.suite.serializeDocument(pretty=True)


def known_app_strings(app, lang: str) -> str:
    """HQ's authored app strings for ``lang`` with no stock UI translation catalog."""
    from corehq.apps.app_manager.app_strings import SelectKnownAppStrings

    return SelectKnownAppStrings(lambda *_args, **_kwargs: {}).create_app_strings(app, lang)


def shape(element):
    """An element as its tag, attributes, text and children, in order.

    Attribute order and indentation between elements have no XML meaning; a
    leaf's text, every attribute and the complete element sequence survive.
    """
    return (
        element.tag,
        dict(element.attrib),
        (element.text or "") if len(element) == 0 else (element.text or "").strip(),
        [shape(child) for child in element],
    )


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hq_commit() -> str:
    return subprocess.check_output(["git", "-C", str(HQ_ROOT), "rev-parse", "HEAD"], text=True).strip()


def hq_source_hashes(paths):
    return {path: sha256((Path(HQ_ROOT) / path).read_bytes()) for path in paths}


def write_evidence(directory: Path, name: str, evidence: dict) -> Path:
    """Write a proof's evidence record (what ran, on which inputs, with which result) beside its artifacts."""
    path = directory / f"{name}.evidence.json"
    path.write_text(json.dumps(evidence, indent=2, default=str) + "\n")
    return path
