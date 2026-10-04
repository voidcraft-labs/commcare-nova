"""Fixtures for the Core runner's own tests."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from proof.core.artifacts import BASIC_APP
from proof.core.client import AppHandle, CoreRunner


@pytest.fixture(scope="module")
def basic_app(core_runner: CoreRunner) -> Iterator[AppHandle]:
    report = core_runner.admit(BASIC_APP)
    assert report["admitted"], report["problems"]
    yield report["app"]
    if core_runner.holds(report["app"]):
        core_runner.release(report["app"])
