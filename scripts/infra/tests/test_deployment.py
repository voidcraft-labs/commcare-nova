"""Offline failure-path tests for deployment, infrastructure, and cache handling."""
import argparse
from contextlib import redirect_stdout
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cache = load("nova_build_cache", "scripts/rollout/build-cache.py")
infra = load("nova_deployment_infra", "scripts/infra/manage-deployment.py")
deploy = load("nova_deploy", "scripts/rollout/deploy-cloud-run.py")
IMAGE = "us-central1-docker.pkg.dev/commcare-nova/repo/app@sha256:" + "a" * 64
JOB = "projects/commcare-nova/locations/us-central1/jobs/commcare-nova-migrate"


def job_fixture():
    c = deploy.JOB_TEMPLATE_CONTRACTS["commcare-nova-migrate"]
    return {"name": JOB, "generation": "3", "observedGeneration": "3", "reconciling": False,
        "terminalCondition": {"state": "CONDITION_SUCCEEDED"}, "etag": "generation-3",
        "template": {"taskCount": 1, "parallelism": 1, "template": {
            "containers": [{"image": IMAGE, "command": ["node"], "args": ["migrate.cjs"],
                "env": [{"name": k, "value": v} for k, v in c.environment],
                "resources": {"limits": {"cpu": c.cpu, "memory": c.memory}}}],
            "serviceAccount": c.service_account, "maxRetries": 0, "timeout": "3000s",
            "vpcAccess": {"egress": "PRIVATE_RANGES_ONLY", "networkInterfaces": [{"network": "default", "subnetwork": "default"}]}}}}


class BuildCacheTests(unittest.TestCase):
    def test_archive_rejects_escape_links_and_oversized_members_before_writing(self):
        for name, kind, size in (("../escape", tarfile.REGTYPE, 0),
                                 ("/absolute", tarfile.REGTYPE, 0),
                                 ("link", tarfile.SYMTYPE, 0),
                                 ("link", tarfile.LNKTYPE, 0),
                                 ("oversized", tarfile.REGTYPE, cache.MAX_CACHE_BYTES + 1)):
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / "cache.tgz"
                # For a large member use a mocked tar directory instead of allocating it.
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = size
                with patch.object(cache.tarfile, "open") as source:
                    source.return_value.__enter__.return_value.getmembers.return_value = [member]
                    destination = Path(tmp) / "output"
                    with self.assertRaises(ValueError):
                        cache.extract_cache(archive, destination)
                    self.assertFalse(destination.exists())

    def test_archive_restores_only_cache_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "cache.tgz"
            with tarfile.open(archive, "w:gz") as output:
                member = tarfile.TarInfo("turbopack/tasks.db")
                member.size = 4
                output.addfile(member, io.BytesIO(b"warm"))
            cache.extract_cache(archive, root / "output")
            self.assertEqual((root / "output/turbopack/tasks.db").read_bytes(), b"warm")

    def test_cache_key_reuses_source_changes_but_invalidates_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in (".nvmrc", ".npmrc", "package-lock.json", "Dockerfile", "next.config.ts"):
                (root / name).write_text(name)
            initial = cache.cache_key(root)
            (root / "page.tsx").write_text("changed component")
            self.assertEqual(initial, cache.cache_key(root))
            (root / "package-lock.json").write_text("changed dependency")
            self.assertNotEqual(initial, cache.cache_key(root))

    def test_unavailable_cache_emits_cold_build_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = argparse.Namespace(root=ROOT, directory=root / "cache", environment=root / "cache.env",
                bucket="private-cache", repository="registry/cache", build_id="00000000-0000-0000-0000-000000000001")
            with patch.object(cache, "gcloud", side_effect=subprocess.CalledProcessError(1, "gcloud")), redirect_stdout(io.StringIO()):
                cache.restore(args)
            self.assertTrue((args.directory / "input").is_dir())
            self.assertNotIn("NOVA_DOCKER_CACHE_FROM", args.environment.read_text())
            self.assertIn("NOVA_DOCKER_CACHE_TO", args.environment.read_text())


    def test_corrupt_snapshot_clears_partial_input_and_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = argparse.Namespace(root=ROOT, directory=root / "cache", environment=root / "cache.env",
                bucket="private-cache", repository="registry/cache", build_id="00000000-0000-0000-0000-000000000001")
            seed = args.directory / "input"
            seed.mkdir(parents=True)
            (seed / "stale").write_text("previous failed extraction")
            (args.directory / "restored.tgz").write_bytes(b"corrupt")
            manifest = {"buildId": args.build_id, "key": cache.cache_key(ROOT), "sha256": "bad"}
            with patch.object(cache, "gcloud", side_effect=["gs://private-cache/snapshot.json", json.dumps(manifest), ""]), redirect_stdout(io.StringIO()):
                cache.restore(args)
            self.assertEqual(list(seed.iterdir()), [])
            self.assertNotIn("NOVA_DOCKER_CACHE_FROM", args.environment.read_text())


class InfrastructureTests(unittest.TestCase):
    def test_media_policy_handles_api_defaults_but_detects_each_retention_failure(self):
        current = copy.deepcopy(infra.MEDIA_POLICY)
        current["metageneration"] = "7"
        self.assertEqual(infra.media_findings(current), [])
        current["softDeletePolicy"]["retentionDurationSeconds"] = 0
        self.assertEqual(infra.media_findings(current), [])
        for mutation in (
            {"lifecycle": {"rule": []}}, {"cors": []},
            {"softDeletePolicy": {"retentionDurationSeconds": "604800"}},
            {"versioning": {"enabled": True}}, {"defaultEventBasedHold": True},
            {"retentionPolicy": {"retentionPeriod": "100"}},
        ):
            self.assertTrue(infra.media_findings({**current, **mutation}))

    def test_media_plan_never_writes_and_apply_uses_generation_fence(self):
        current = {**infra.MEDIA_POLICY, "cors": [], "metageneration": "7"}
        with patch.object(infra, "api", return_value=current) as api, redirect_stdout(io.StringIO()):
            infra.media(False)
            self.assertEqual([call.args[0] for call in api.call_args_list], ["GET"])
        with patch.object(infra, "api", side_effect=[current, {}, infra.MEDIA_POLICY]) as api, redirect_stdout(io.StringIO()):
            infra.media(True)
            self.assertEqual(api.call_args_list[1].args[0], "PATCH")
            self.assertIn("ifMetagenerationMatch=7", api.call_args_list[1].args[1])
        with patch.object(infra, "api", return_value={**current, "retentionPolicy": {}}) as api:
            with self.assertRaises(ValueError):
                infra.media(True)
            self.assertEqual(api.call_count, 1)

    def test_scheduler_drift_check_never_mutates(self):
        with patch.object(infra, "scheduler_facts", return_value={"state": "PAUSED"}), patch.object(infra, "command") as command:
            with self.assertRaises(ValueError):
                infra.scheduler(False, check=True)
            command.assert_not_called()

    def test_job_provisioning_rejects_mutable_images_and_defaults_to_dry_run(self):
        with self.assertRaises(ValueError):
            infra.job_arguments("commcare-nova-migrate", "repo:latest")
        arguments = infra.job_arguments("commcare-nova-legacy-preplan-repair", IMAGE)
        self.assertIn("--args=legacy-preplan-repair.cjs", arguments)
        self.assertNotIn("--execute", " ".join(arguments))
        with patch.object(infra, "command") as command, redirect_stdout(io.StringIO()):
            infra.run_or_plan(arguments, False)
            command.assert_not_called()


class JobExecutionTests(unittest.TestCase):
    def test_configuration_drift_refuses_before_execution(self):
        for variant in ("image", "identity", "environment", "network", "generation", "retries"):
            job = job_fixture()
            task = job["template"]["template"]
            if variant == "image":
                task["containers"][0]["image"] = IMAGE.replace("a" * 64, "b" * 64)
            elif variant == "identity":
                task["serviceAccount"] = "wrong@example.com"
            elif variant == "environment":
                task["containers"][0]["env"][0]["value"] = "wrong-database"
            elif variant == "network":
                task["vpcAccess"]["egress"] = "ALL_TRAFFIC"
            elif variant == "generation":
                job["generation"] = "4"
            else:
                task["maxRetries"] = 1
            with self.subTest(variant=variant), patch.object(deploy, "_access_token", return_value="synthetic"), patch.object(deploy, "_run_api_request", return_value=job) as api:
                with self.assertRaises(deploy.DeploymentPolicyError):
                    deploy._execute_job_exact(project="commcare-nova", region="us-central1", job="commcare-nova-migrate", expected_image=IMAGE, execution_args=[], wait_seconds=1)
                self.assertEqual([call.args[1] for call in api.call_args_list], ["GET"])

    def test_execution_post_is_not_retried_after_transport_failure(self):
        with patch.object(deploy, "_access_token", return_value="synthetic"), patch.object(deploy, "_run_api_request", side_effect=[job_fixture(), OSError("connection lost")]) as api:
            with self.assertRaises(OSError):
                deploy._execute_job_exact(project="commcare-nova", region="us-central1", job="commcare-nova-migrate", expected_image=IMAGE, execution_args=[], wait_seconds=1)
            self.assertEqual([call.args[1] for call in api.call_args_list], ["GET", "POST"])
            self.assertEqual(api.call_args_list[1].args[3], {"etag": "generation-3"})

    def test_retired_migration_overrides_are_not_accepted(self):
        for flag in ("--terminate-runtime-sessions-only", "--finalize-better-auth-17"):
            with self.assertRaises(deploy.DeploymentPolicyError):
                deploy._effective_execution_args(JOB, ["migrate.cjs", flag])


if __name__ == "__main__":
    unittest.main()
