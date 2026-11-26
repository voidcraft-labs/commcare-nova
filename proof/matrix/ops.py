"""The changes a base's builder and a variant make in HQ, each through HQ's own code.

- ``post``: a request to one of HQ's views, as a person's page sends it,
  built as an editor's request is (``proof.hq.requests``), resolved through
  HQ's URLconf and answered by the view with its decorators;
- ``upload_form_source``: a form's source posted through the form page's own
  upload (``views/forms.py::_edit_form_attr``, the ``xform`` file), and held
  to land as posted;
- ``set_form_source``: a form's source parsed with lxml, edited, and posted
  through that upload, or, where the view refuses it, stored as HQ's import
  stores every form;
- ``builder_save``: a form opened and saved in HQ's form builder
  (``proof/editors/vellum.py::open_and_save``), with the one edit a person
  makes there between the open and the save where a step names it;
- ``set_json``: a value set at a pointer of the stored app's JSON, the whole
  document wrapped by HQ (``dbaccessors.py::wrap_app``) and saved, which is
  how a value no page writes enters HQ: its import and its update both wrap
  the document they are handed before they store it
  (``models/applications.py::import_app_from_doc``,
  ``overwrite_app_from_source``). A value names a menu or a form of the app
  by its position (``{"$menu": m}``, ``{"$form": [m, f]}``, and a form's
  ``xmlns`` by ``{"$xmlns": [m, f]}``), which ``set_json`` resolves to what
  the stored app holds there before the change, so no row or change carries
  an id a later authoring of the base mints anew.

Each opens its own determinism operation through the ``Authoring`` it is
handed (``matrix:<base>:<step>``) but ``builder_save``, whose operation reads
what HQ's form designer gives the builder and whose run follows it between
scopes, each of the builder's requests its own (``unit.request``), as
``proof/observe/hqside.py::_form_builder_save`` runs one.
"""

from __future__ import annotations

import hashlib
import json
from urllib.parse import urlencode

from proof.hq.boot import HarnessRefusal

FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8"


class MatrixChangeRefused(HarnessRefusal):
    """HQ refused a change the lane makes in a person's place while it authors a base."""


class SourceNotHeld(MatrixChangeRefused):
    """HQ's view took a form's source and holds other bytes."""


def _digest(value) -> bytes:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).digest()


def form_body(pairs):
    """A form-encoded body of ``pairs``, as a page's form posts it."""
    return urlencode(list(pairs)).encode(), FORM_CONTENT_TYPE


def json_body(value):
    return json.dumps(value).encode(), "application/json"


def post(authoring, view, args, body: bytes, content_type: str, what, *, method="POST", redirects=False):
    """HQ's answer to one request to the view named ``view`` (its URL reversed from ``[domain, *args]``), as a
    person's page sends it. A view that raises, or answers with an error, refuses the change
    (``MatrixChangeRefused``); ``redirects`` admits the redirect a view whose page posts a form answers with
    (``views/utils.py::back_to_main``). Returns the response."""
    from django.urls import resolve, reverse

    from proof.hq import requests as hq_requests

    state = authoring.state
    path = reverse(view, args=[state.domain, *args])
    match = resolve(path)
    request = hq_requests.raw(state, method, path, body, content_type)
    try:
        response = match.func(request, *match.args, **match.kwargs)
    except HarnessRefusal:
        raise
    except Exception as error:
        raise MatrixChangeRefused(
            f"HQ's view refused {what} the lane makes while it authors {authoring.base} ({method} {path}):"
            f" {type(error).__module__}.{type(error).__name__}: {error}. The lane makes it as HQ's page does; look at"
            " what the view now asks of the request or of the project space."
        ) from error
    if not (200 <= response.status_code < 300 or (redirects and response.status_code == 302)):
        raise MatrixChangeRefused(
            f"HQ answered {what} the lane makes while it authors {authoring.base} ({method} {path}) with"
            f" {response.status_code}: {response.content[:400]!r}. The lane makes it as HQ's page does; look at what"
            " the view now asks of the request."
        )
    return response


def _held_form(state, app_id, menu, form):
    from proof.hq import operations

    app = operations.held_app(state, app_id)
    return app, app.get_module(menu).get_form(form)


def _upload(authoring, app_id, form_unique_id, text, what):
    """The form page's upload of ``text`` as the form's source (``views/forms.py::_edit_form_attr``: a multipart
    post of the ``xform`` file with ``ajax`` ``false``, ``form_view_modals.html``); returns the source HQ holds
    after it."""
    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart

    from proof.hq import operations

    body = encode_multipart(
        BOUNDARY,
        {
            "xform": SimpleUploadedFile("form.xml", text.encode("utf-8"), content_type="text/xml"),
            "ajax": "false",
        },
    )
    post(authoring, "edit_form_attr", [app_id, form_unique_id, "xform"], body, MULTIPART_CONTENT, what, redirects=True)
    return operations.held_app(authoring.state, app_id).get_form(form_unique_id).source


def upload_form_source(authoring, app_id, menu, form, write, what):
    """The source ``write(form name)`` returns stored as the source of the form at ``(menu, form)`` through the
    form page's own upload, in the operation ``build:<what>`` (``write`` runs inside it, so the ``xmlns`` HQ's form
    writer draws is the operation's own), and held to land as posted: ``util.py::save_xform`` stores the bytes as
    posted where no other form holds the source's ``xmlns``, and the form takes that ``xmlns``
    (``models/forms.py::FormSource.__set__``), so a source that does not land is one the builder wrote wrongly
    (``SourceNotHeld``). Returns the form's unique id."""
    with authoring.step(f"build:{what}"):
        _app, held = _held_form(authoring.state, app_id, menu, form)
        text = write(held.default_name())
        stored = _upload(authoring, app_id, held.unique_id, text, what)
    if stored != text:
        raise SourceNotHeld(
            f"HQ's form page upload of {what} for {authoring.base} left another source than the lane posted. A"
            " builder writes a source no other form of the app holds, so look at what the builder wrote."
        )
    return held.unique_id


def _store_as_imported(state, app_id, form_unique_id, text):
    """``text`` stored as the form's source the way HQ's import stores every form: as an attachment of the app,
    with no parse (``models/applications.py::_import_app``, through ``save_attachments``)."""
    from proof.hq import operations

    app = operations.held_app(state, app_id)
    app.save_attachments({f"{form_unique_id}.xml": text})


def set_form_source(authoring, app_id, menu, form, edit, *, what="the form's source", label="variant"):
    """The source of the form at ``(menu, form)`` parsed with lxml, edited, and posted through the form page's own
    upload, so the change is one a person can make, all in the operation ``<label>:<what>`` (``variant`` for a
    variant's change, ``build`` for a step of a base's own build). ``edit(root, form)`` is
    handed the parsed root and HQ's form, and either changes the root in place (returning None) or returns the
    whole new text, for a change no tree holds (a document type declaration). Where the view refuses the source
    (``_edit_form_attr`` answers a source ``xform.py::parse_xml`` raises ``DangerousXmlException`` for with its own
    error, which no ``XFormException`` handler takes), it is stored the way HQ's import stores every form, which
    takes any text with no parse (``FormSource.__set__``, ``_import_app`` through ``save_attachments``): either way
    HQ holds the source and Nova's reader meets it. Returns the text stored."""
    from lxml import etree

    with authoring.step(f"{label}:{what}"):
        _app, held = _held_form(authoring.state, app_id, menu, form)
        root = etree.fromstring(held.source.encode("utf-8"))
        returned = edit(root, held)
        text = returned if isinstance(returned, str) else etree.tostring(root, encoding="unicode")
        try:
            stored = _upload(authoring, app_id, held.unique_id, text, what)
        except MatrixChangeRefused:
            # The page answered the upload with an error of its own.
            stored = None
        if stored != text:
            _store_as_imported(authoring.state, app_id, held.unique_id, text)
    return text


def builder_save(authoring, app_id, menu, form, *, edit=None):
    """The form at ``(menu, form)`` opened in HQ's form builder and saved by its own Save
    (``proof/editors/vellum.py::open_and_save``), with ``edit`` made between the open and the save where it is
    given (``{path, label, way}`` or ``{path, property, value, way}``, ``driver/steps/vellum/edit.js``): the one
    thing only a person's typing in the form builder writes, such as a Default Value reading
    ``#case/<property>``. The operation ``vellum:<m>.<f>`` reads what HQ's form designer page gives the builder;
    the run follows it, between scopes. A save the builder did not make refuses the change."""
    from proof.editors import vellum

    if authoring.driver is None:
        raise ValueError(f"{authoring.base} saves a form in HQ's form builder, and the authoring has no editor driver.")
    with authoring.step(f"vellum:{menu}.{form}", _digest({"menu": menu, "form": form, "edit": edit})):
        app, held = _held_form(authoring.state, app_id, menu, form)
        options = vellum.vellum_options(authoring.state, app_id, held.unique_id, lang=app.langs[0])
    run = vellum.open_and_save(authoring.driver, authoring.state, app_id, held.unique_id, options, edit=edit)
    if not run.saved or run.save_refusal is not None:
        raise MatrixChangeRefused(
            f"HQ's form builder did not save form {menu}.{form} of {authoring.base} ({run.save_refusal}); the lane"
            " saves it as a person does, so look at what the builder now reports of the form."
        )
    return run


class ValueNotSet(MatrixChangeRefused):
    """A pointer of ``set_json`` names no place in the stored app."""


def _pointer_tokens(pointer: str):
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise ValueNotSet(f"{pointer!r} is no JSON pointer; one starts with '/'.")
    return [token.replace("~1", "/").replace("~0", "~") for token in pointer[1:].split("/")]


def set_at(document, pointer: str, value):
    """``document`` with ``value`` set at ``pointer`` (RFC 6901), the last token added where its object lacks it."""
    tokens = _pointer_tokens(pointer)
    if not tokens:
        raise ValueNotSet("set_json sets a value inside the app, and the pointer names the whole document.")
    here = document
    for token in tokens[:-1]:
        here = here[int(token)] if isinstance(here, list) else here[token]
    last = tokens[-1]
    if isinstance(here, list):
        index = len(here) if last == "-" else int(last)
        if index == len(here):
            here.append(value)
        else:
            here[index] = value
    else:
        here[last] = value
    return document


# The references a value may hold in place of an id: an object with this one key, naming a menu by its position
# (``{"$menu": m}``), a form by its menu's and its own (``{"$form": [m, f]}``), or that form's xmlns
# (``{"$xmlns": [m, f]}``), which an external key of a form or of what a form holds names it by.
MENU_REFERENCE = "$menu"
FORM_REFERENCE = "$form"
XMLNS_REFERENCE = "$xmlns"
# A held value naming a file of the base's Project by its path (``{"$projectFile": "jr://file/..."}``), which a
# reading keys by the media id HQ minted for it when the base was authored (``retain.py::hold_value``). It is no
# menu or form reference, and only a holds value may be one (``registry.py::_check_references``).
PROJECT_FILE = "$projectFile"


def project_file_of(value):
    """The path a held value names as a Project file (``{"$projectFile": path}``), or None where it names none."""
    if isinstance(value, dict) and set(value) == {PROJECT_FILE} and isinstance(value[PROJECT_FILE], str):
        return value[PROJECT_FILE]
    return None


def _position(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def reference_of(value):
    """The menu or form a value names by position: ``("menu", (m,))``, ``("form", (m, f))``, ``("xmlns", (m, f))``
    for the form's xmlns, or None where the value is no reference. An object holding a key that starts with ``$`` and
    is not exactly one well-formed reference is refused (``ValueNotSet``): a misspelled reference would otherwise be
    stored as data."""
    if not isinstance(value, dict) or not any(isinstance(key, str) and key.startswith("$") for key in value):
        return None
    if project_file_of(value) is not None:
        return None
    if set(value) == {MENU_REFERENCE} and _position(value[MENU_REFERENCE]):
        return "menu", (value[MENU_REFERENCE],)
    for key, kind in ((FORM_REFERENCE, "form"), (XMLNS_REFERENCE, "xmlns")):
        held = value.get(key)
        if set(value) == {key} and isinstance(held, list) and len(held) == 2 and all(map(_position, held)):
            return kind, tuple(held)
    raise ValueNotSet(
        f"{value!r} is no reference: a menu is named {{{MENU_REFERENCE!r}: <menu position>}}, a form"
        f" {{{FORM_REFERENCE!r}: [<menu position>, <form position>]}} and its xmlns"
        f" {{{XMLNS_REFERENCE!r}: [<menu position>, <form position>]}}, each object holding that one key."
    )


def references_in(value):
    """Every reference ``value`` holds, at any depth, in document order."""
    found = reference_of(value)
    if found is not None:
        return [found]
    children = value.values() if isinstance(value, dict) else value if isinstance(value, list) else ()
    return [one for child in children for one in references_in(child)]


def resolve_references(value, resolve):
    """``value`` with each reference it holds replaced by ``resolve(kind, position)``, a new value."""
    found = reference_of(value)
    if found is not None:
        return resolve(*found)
    if isinstance(value, dict):
        return {key: resolve_references(item, resolve) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_references(item, resolve) for item in value]
    return value


def ids_at(document):
    """A ``resolve`` for ``resolve_references`` over an app's JSON: the ``unique_id`` of the menu or form it holds at
    a position, or that form's ``xmlns``. A position the app holds nothing at refuses (``ValueNotSet``)."""

    def resolve(kind, position):
        try:
            menu = document["modules"][position[0]]
            held = menu if kind == "menu" else menu["forms"][position[1]]
            return held["xmlns" if kind == "xmlns" else "unique_id"]
        except (KeyError, IndexError, TypeError) as error:
            raise ValueNotSet(
                f"The {kind} at {list(position)} is none the app holds ({error!r}); a reference names a menu or form"
                " the app holds before the change, by its position as HQ's source read serves it."
            ) from error

    return resolve


def set_json(authoring, app_id, pointer: str, value):
    """``value`` set at ``pointer`` in the stored app's JSON, the whole document wrapped by HQ
    (``dbaccessors.py::wrap_app``) and saved. The pointer addresses the app as HQ's source read serves it; the
    stored document's form ids and attachments are where the source read's are. Each reference ``value`` holds
    (``{"$menu": m}``, ``{"$form": [m, f]}``, ``{"$xmlns": [m, f]}``) is what the stored app holds at that position
    before the change, an id or a form's xmlns: a form's id as the stored app holds it, since HQ's source read gives
    every form a new id on every read and moves each reference it knows of to it
    (``util.py::update_form_unique_ids``). HQ refusing the value is the wrap or the
    save raising, which propagates for the variant's row to hold (``hqNeverServes.raised``)."""
    from corehq.apps.app_manager.dbaccessors import wrap_app

    from proof.hq import operations

    with authoring.step(f"variant:set-json:{pointer}", _digest({"pointer": pointer, "value": value})):
        held = operations.held_app(authoring.state, app_id)
        document = json.loads(json.dumps(held.to_json()))
        try:
            set_at(document, pointer, resolve_references(value, ids_at(document)))
        except (KeyError, IndexError, ValueError, TypeError) as error:
            raise ValueNotSet(
                f"The pointer {pointer} names no place in the app {authoring.base} holds ({error!r}); a set-json row"
                " addresses the app as HQ's source read serves it."
            ) from error
        wrap_app(document).save()
