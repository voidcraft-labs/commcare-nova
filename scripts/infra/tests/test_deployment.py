"""Offline failure-path tests for deployment, infrastructure, and cache handling."""
import argparse
from contextlib import redirect_stdout
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from deployment_fixtures import ROOT, IMAGE, load, http_responses, requests

cache = load("nova_build_cache", "scripts/rollout/build-cache.py")
infra = load("nova_deployment_infra", "scripts/infra/manage-deployment.py")
image_metadata = load("nova_image_metadata", "scripts/rollout/image-metadata.py")


class BuildCacheTests(unittest.TestCase):
    def arguments(self, root):
        return argparse.Namespace(root=ROOT, directory=root / "cache", environment=root / "cache.env",
            bucket="private-cache", repository="registry/cache/compiler", profile="benchmark", cold=False,
            build_id="00000000-0000-0000-0000-000000000001")

    def test_cache_key_reuses_source_changes_but_invalidates_dependencies_and_profiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in (".nvmrc", ".npmrc", "package-lock.json", "Dockerfile", "next.config.ts", "tsconfig.production.json", "scripts/build-app.mjs"):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(name)
            initial = cache.cache_key(root)
            (root / "page.tsx").write_text("changed component")
            self.assertEqual(initial, cache.cache_key(root))
            self.assertNotEqual(initial, cache.cache_key(root, "benchmark"))
            (root / "package-lock.json").write_text("changed dependency")
            self.assertNotEqual(initial, cache.cache_key(root))

    def test_unavailable_cache_emits_cold_environment_and_removes_stale_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.arguments(Path(tmp))
            args.directory.mkdir()
            (args.directory / "next-image.json").write_text("stale")
            with patch.object(cache, "gcloud", side_effect=subprocess.CalledProcessError(1, "gcloud")), redirect_stdout(io.StringIO()):
                cache.restore(args)
            self.assertEqual(list((args.directory / "input").iterdir()), [])
            self.assertFalse((args.directory / "next-image.json").exists())
            self.assertNotIn("NOVA_DOCKER_CACHE_FROM", args.environment.read_text())
            self.assertIn("NOVA_NEXT_CACHE_TO", args.environment.read_text())

    def test_restore_reads_only_manifest_and_selects_an_immutable_registry_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.arguments(Path(tmp))
            manifest = {"buildId": args.build_id, "key": cache.cache_key(ROOT, args.profile), "nextDigest": "sha256:" + "a" * 64}
            with patch.object(cache, "gcloud", side_effect=["gs://private-cache/snapshot.json", json.dumps(manifest)]) as cloud, redirect_stdout(io.StringIO()):
                cache.restore(args)
            self.assertEqual([c.args[1] for c in cloud.call_args_list], ["ls", "cat"])
            self.assertIn("registry/cache/next@sha256:" + "a" * 64, args.environment.read_text())
            self.assertEqual(list((args.directory / "input").iterdir()), [])

    def test_invalid_snapshot_identity_falls_back_without_fetching_bytes(self):
        for mutation in ({"nextDigest": "https://foreign/bytes"}, {"key": "other-profile"}, {"buildId": "../other"}):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                args = self.arguments(Path(tmp))
                manifest = {"buildId": args.build_id, "key": cache.cache_key(ROOT, args.profile), "nextDigest": "sha256:" + "a" * 64, **mutation}
                with patch.object(cache, "gcloud", side_effect=["gs://private-cache/snapshot.json", json.dumps(manifest)]), redirect_stdout(io.StringIO()):
                    cache.restore(args)
                self.assertNotIn("NOVA_NEXT_CACHE_FROM", args.environment.read_text())

    def test_publication_is_one_small_create_only_completion_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.arguments(Path(tmp))
            args.directory.mkdir()
            (args.directory / "next-image.json").write_text(json.dumps({"containerimage.digest": "sha256:" + "a" * 64}))
            with patch.object(cache, "gcloud") as cloud, redirect_stdout(io.StringIO()):
                cache.publish(args)
            self.assertEqual(cloud.call_count, 1)
            self.assertIn("--if-generation-match=0", cloud.call_args.args)
            self.assertLess((args.directory / "manifest.json").stat().st_size, 512)
            (args.directory / "next-image.json").unlink()
            with patch.object(cache, "gcloud") as cloud, redirect_stdout(io.StringIO()):
                cache.publish(args)
            cloud.assert_not_called()


def media_fixture():
    return {
        "lifecycle": {"rule": [
            {"action": {"type": "Delete"}, "condition": {"age": 1, "matchesPrefix": ["pending/"]}},
            {"action": {"type": "Delete"}, "condition": {"age": 7, "matchesPrefix": ["captures-staged/"]}},
        ]},
        "softDeletePolicy": {"retentionDurationSeconds": "0"},
        "versioning": {"enabled": False}, "defaultEventBasedHold": False,
        "cors": [{"origin": ["https://commcare.app"], "method": ["PUT", "OPTIONS"],
                  "responseHeader": ["Content-Type", "x-goog-content-length-range", "x-goog-if-generation-match"],
                  "maxAgeSeconds": 3600}],
    }


def scheduler_fixture():
    return {
        "state": "ENABLED", "schedule": "*/5 * * * *", "timeZone": "Etc/UTC",
        "httpTarget": {
            "uri": "https://run.googleapis.com/v2/projects/commcare-nova/locations/us-central1/jobs/commcare-nova-capture-cleanup:run",
            "httpMethod": "POST", "body": "e30=",
            "headers": {"Content-Type": "application/json"},
            "oauthToken": {
                "serviceAccountEmail": "nova-capture-scheduler@commcare-nova.iam.gserviceaccount.com",
                "scope": "https://www.googleapis.com/auth/cloud-platform",
            },
        },
    }


class InfrastructureTests(unittest.TestCase):
    def cli(self, *args):
        with patch.object(sys, "argv", ["manage-deployment.py", *args]):
            infra.main()

    def test_media_policy_handles_api_defaults_but_detects_retention_and_cors_drift(self):
        current = media_fixture()
        current["metageneration"] = "7"
        self.assertEqual(infra.media_findings(current), [])
        del current["softDeletePolicy"]
        del current["versioning"]
        del current["defaultEventBasedHold"]
        current["cors"][0]["method"].reverse()
        current["cors"][0]["responseHeader"].reverse()
        self.assertEqual(infra.media_findings(current), [])
        for mutation in (
            {"lifecycle": {"rule": []}}, {"cors": []},
            {"softDeletePolicy": {"retentionDurationSeconds": "604800"}},
            {"versioning": {"enabled": True}}, {"defaultEventBasedHold": True},
            {"retentionPolicy": {"retentionPeriod": "100"}},
        ):
            with self.subTest(mutation=mutation):
                self.assertTrue(infra.media_findings({**current, **mutation}))

    def test_media_cli_defaults_to_reads_and_apply_serializes_a_generation_fenced_patch(self):
        current = {**media_fixture(), "cors": [], "metageneration": "7"}
        for apply in (False, True):
            with self.subTest(apply=apply), patch.object(infra, "_token", "synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(
                    current, *([{}, media_fixture()] if apply else []),
                ),
            ) as http, redirect_stdout(io.StringIO()):
                self.cli("media", *(["--apply"] if apply else []))
                sent = requests(http)
                self.assertEqual([request.get_method() for request in sent], ["GET", "PATCH", "GET"] if apply else ["GET"])
                if apply:
                    self.assertEqual(sent[1].full_url, "https://storage.googleapis.com/storage/v1/b/nova-multimedia-prod?ifMetagenerationMatch=7")
                    self.assertEqual(json.loads(sent[1].data), media_fixture())

    def test_media_refuses_operator_retention_or_missing_generation_without_any_write(self):
        for mutation in ({"retentionPolicy": {}}, {"metageneration": None}, {"metageneration": "1.5"}):
            current = {**media_fixture(), "cors": [], "metageneration": "7", **mutation}
            with self.subTest(mutation=mutation), patch.object(infra, "_token", "synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(current),
            ) as http, redirect_stdout(io.StringIO()):
                with self.assertRaises(ValueError):
                    self.cli("media", "--apply")
                self.assertEqual([request.get_method() for request in requests(http)], ["GET"])

    def test_check_reads_real_scheduler_response_and_never_repairs_drift(self):
        paused = {**scheduler_fixture(), "state": "PAUSED"}
        with patch.object(infra, "_token", "synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(media_fixture()),
        ) as http, patch("subprocess.run", return_value=subprocess.CompletedProcess(
            ["gcloud"], 0, stdout=json.dumps(paused),
        )) as process, redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "scheduler drift"):
                self.cli("check")
        self.assertEqual([request.get_method() for request in requests(http)], ["GET"])
        self.assertEqual([call.args[0][1:4] for call in process.call_args_list], [["scheduler", "jobs", "describe"]])

    def test_scheduler_plan_is_read_only_and_explicit_apply_updates_then_resumes_and_verifies(self):
        for apply in (False, True):
            snapshots = iter([{**scheduler_fixture(), "state": "PAUSED"}, scheduler_fixture()])

            def gcloud(command, **_kwargs):
                output = json.dumps(next(snapshots)) if command[1:4] == ["scheduler", "jobs", "describe"] else ""
                return subprocess.CompletedProcess(command, 0, stdout=output)

            with self.subTest(apply=apply), patch("subprocess.run", side_effect=gcloud) as process, redirect_stdout(io.StringIO()):
                self.cli("scheduler", *(["--apply"] if apply else []))
                commands = [call.args[0] for call in process.call_args_list]
                self.assertEqual([command[1:4] for command in commands], [
                    ["scheduler", "jobs", "describe"],
                    *([["run", "jobs", "add-iam-policy-binding"], ["scheduler", "jobs", "update"],
                       ["scheduler", "jobs", "resume"], ["scheduler", "jobs", "describe"]] if apply else []),
                ])
                if apply:
                    self.assertIn("--message-body={}", commands[2])
                    self.assertIn("--schedule=*/5 * * * *", commands[2])
                    self.assertIn("--oauth-service-account-email=nova-capture-scheduler@commcare-nova.iam.gserviceaccount.com", commands[2])

    def test_job_cli_rejects_mutable_images_and_defaults_to_a_nonexecuting_plan(self):
        with patch("subprocess.run") as process, redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(ValueError):
                self.cli("job", "--job", "commcare-nova-migrate", "--image", "repo:latest")
            self.cli("job", "--job", "commcare-nova-legacy-preplan-repair", "--image", IMAGE)
            process.assert_not_called()
        self.assertIn("PLAN gcloud run jobs deploy", output.getvalue())
        self.assertIn("--args=legacy-preplan-repair.cjs", output.getvalue())
        self.assertNotIn("--execute", output.getvalue())


class ImageMetadataTests(unittest.TestCase):
    def test_emitted_push_digest_is_required_and_cannot_inject_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); metadata = root / "metadata.json"; output = root / "image.env"
            repository = IMAGE.split("@")[0]
            metadata.write_text(json.dumps({"containerimage.digest": "sha256:" + "a" * 64}))
            self.assertEqual(image_metadata.write_image_environment(metadata, repository, output), IMAGE)
            self.assertIn(IMAGE, output.read_text())
            metadata.write_text(json.dumps({"containerimage.digest": "sha256:bad\nINJECTED=true"}))
            with self.assertRaises(ValueError): image_metadata.write_image_environment(metadata, repository, output)
            with self.assertRaises(ValueError): image_metadata.write_image_environment(metadata, "registry; echo wrong", output)


if __name__ == "__main__":
    unittest.main()
