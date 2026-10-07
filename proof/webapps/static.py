"""HQ's stylesheets and static files for the Web Apps page, compiled and served by HQ's own code.

What a worker sees is the client's markup under HQ's stylesheets, so the
page gets them. An HQ page names its stylesheets as SCSS sources inside
``{% compress css %}`` blocks, and HQ compiles each with its own precompiler
(``settings.py::AVAILABLE_COMPRESS_PRECOMPILERS``,
``hqwebapp/precompilers.py::SassFilter``: ``sass <file> --load-path=
node_modules/bootstrap5/scss``, run from HQ's root). HQ's test settings
switch the precompilers off, which is why an editor page of the lane loads
no stylesheet; HQ's own note there says how a test that needs them turns
them on, and ``compiled`` does exactly that for the Web Apps page:

- ``COMPRESS_PRECOMPILERS`` is HQ's own list again, so the page's template
  tags compile each SCSS source and name the compiled file, as HQ's
  development server does on every page (compression itself stays off, as
  it is there);
- ``COMPRESS_ROOT`` is a directory of this process's own, where the
  compiled files are written;
- ``sass`` is the image's (``proof/image/tools``; HQ names no version of it
  and installs whichever its deployment has), found on the ``PATH`` for the
  block, and each HQ request is answered from HQ's root (``in_hq_root``),
  where the precompiler's load path points.

``serve`` answers a request under HQ's static URL with the file HQ's own
finders hold for it (``STATICFILES_FINDERS``: HQ's node packages, each
app's ``static`` directory, and the compiled files), which is how HQ's
development server finds what it serves. A path no finder holds is not
answered here, and the caller's HQ answers give it HQ's 404.

Nothing is fetched: a stylesheet that names another host (HQ's page links
one web font) is refused by the browser's resolver, as every request to
another origin is.
"""

from __future__ import annotations

import atexit
import mimetypes
import os
import posixpath
import re
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import unquote

from proof.editors.client import TOOLS_DIR, PageResponse

_ROOT: Path | None = None


def compiled_root() -> Path:
    """This process's directory for compiled stylesheets, made once and removed when the process ends."""
    global _ROOT
    if _ROOT is None:
        _ROOT = Path(tempfile.mkdtemp(prefix="proof-webapps-static-"))
        atexit.register(shutil.rmtree, _ROOT, ignore_errors=True)
    return _ROOT


@contextmanager
def compiled():
    """HQ's stylesheet precompilers on for the block, writing under ``compiled_root``, with the image's sass."""
    from django.conf import settings
    from django.test import override_settings

    sass = Path(TOOLS_DIR) / "node_modules" / ".bin"
    if not (sass / "sass").exists():
        raise RuntimeError(
            f"HQ's stylesheet precompiler runs `sass`, and the image's Node tools hold none at {sass / 'sass'}."
            " The proof image installs it from proof/image/tools/package.json; check that the image was built"
            " from this recipe."
        )
    held = os.environ.get("PATH", "")
    os.environ["PATH"] = f"{sass}{os.pathsep}{held}"
    try:
        with override_settings(
            COMPRESS_PRECOMPILERS=settings.AVAILABLE_COMPRESS_PRECOMPILERS, COMPRESS_ROOT=str(compiled_root())
        ):
            yield
    finally:
        os.environ["PATH"] = held


@contextmanager
def in_hq_root():
    """The working directory HQ runs from (its root), which its precompiler's relative load path is read against."""
    from django.conf import settings

    held = os.getcwd()
    os.chdir(settings.BASE_DIR)
    try:
        yield
    finally:
        os.chdir(held)


# The digest HQ's compressor writes into a compiled file's name (settings.py::COMPRESS_CSS_HASHING_METHOD).
_COMPILED_NAME = re.compile(r"\.[0-9a-f]{12}(\.css)$")


def unhashed(path: str) -> str:
    """A compiled stylesheet's path without the digest in its name.

    The digest is of the compiled file's bytes, and those end with a comment naming the source map sass wrote
    beside its output, a temporary file whose name is drawn afresh on every compile. So two compiles of one
    source hold the same rules under two names, and a comparison of two pages' stylesheets names them without it.
    """
    return _COMPILED_NAME.sub(r"\1", path)


def serve(path: str) -> PageResponse | None:
    """The file HQ's own finders hold for a path under HQ's static URL, or None where none holds it.

    Django's static view (``django.contrib.staticfiles.views.serve``) does the same two things, a find and a
    read with the type the file's name gives; it is not called here because closing its response announces a
    finished request, on which Django closes the database connection the unit's transaction lives on.
    """
    from django.conf import settings
    from django.contrib.staticfiles import finders
    from django.core.exceptions import SuspiciousFileOperation

    if not path.startswith(settings.STATIC_URL):
        return None
    relative = posixpath.normpath(unquote(path[len(settings.STATIC_URL) :])).lstrip("/")
    if relative.startswith(".."):
        return None
    try:
        found = finders.find(relative)
    except SuspiciousFileOperation:
        return None
    if not found or not Path(found).is_file():
        return None
    content_type, encoding = mimetypes.guess_type(found)
    headers = [("Content-Type", content_type or "application/octet-stream")]
    if encoding:
        headers.append(("Content-Encoding", encoding))
    return PageResponse(200, headers, Path(found).read_bytes())
