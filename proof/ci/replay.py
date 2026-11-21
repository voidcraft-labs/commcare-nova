"""Bind one hosted diagnostic to its original Actions checkpoint, queue, corpus and native runtime."""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def artifact_names(checkpoint, attempt):
    match = re.fullmatch(r"proof-progress-((?:([a-zA-Z0-9_-]{1,64})-)?shard-[1-9][0-9]*)-([1-9][0-9]*)-([1-9][0-9]*)\.json", checkpoint)
    require(match and match[3] == attempt, "Name a finalized reader checkpoint from the requested attempt.")
    suffix = f"{match[2]}-{attempt}" if match[2] else attempt
    return match[1], f"proof-queue-{suffix}.json", f"proof-corpus-{suffix}.tar.zst"


def recorded_commit(run, repo, sha, shard):
    # Reusable lanes may check out a different ref from the dispatch wrapper. GitHub also names the
    # ephemeral PR merge commit here, even though head_sha on a pull_request run is the PR head.
    if run["repository"]["full_name"] != repo or (run.get("head_repository") or {}).get("full_name") != repo:
        return False
    reusable = any(
        workflow["sha"] == sha and workflow["path"].startswith(repo + "/.github/workflows/proof-lane.yml@")
        for workflow in run.get("referenced_workflows", []) or []
    )
    if re.fullmatch(r"shard-[0-9]+", shard):
        return run["path"] == ".github/workflows/ci.yml" and (sha == run["head_sha"] or reusable)
    return reusable


def source_job(jobs, shard):
    label, number = shard.rsplit("shard-", 1)
    expected = (rf"(?:.* / )?Shard {number}/[1-9][0-9]* \({re.escape(label[:-1])}\)" if label
                else rf"Proof {number}/[1-9][0-9]*")
    matched = [j for j in jobs if re.fullmatch(expected, j["name"])]
    require(len(matched) == 1 and matched[0].get("runner_name"), "GitHub has no matching original shard and runner.")
    return {key: matched[0][key] for key in ("id", "name", "runner_name")}


def selection(checkpoint, queue_bytes, emission, *, run, attempt, shard, commit, group, configuration, stage, operation, seconds):
    require(checkpoint.get("kind") == "reader-progress" and checkpoint.get("version") == 1, "Expected a reader progress checkpoint.")
    source = checkpoint["source"]
    require(all(source[k] == v for k, v in {"run": run, "attempt": attempt, "shard": shard, "commit": commit}.items()),
            "The checkpoint names another run, attempt, shard or checkout.")
    require(1 <= seconds <= 1200, "The operation deadline must be 1 to 1200 seconds.")
    require(checkpoint["queues"].get("main") == hashlib.sha256(queue_bytes).hexdigest(), "The main queue differs from the checkpoint.")
    queue = json.loads(queue_bytes)
    document = re.fullmatch(r"corpus:([a-z0-9][a-z0-9-]*)(?:@([^~]+)(?:~[0-9]+of[0-9]+)?)?", group)
    # The full PR/nightly queue omits selection. A targeted queue records its selected subset.
    require(document and ("selection" not in queue or document[1] in queue["selection"]["documents"]),
            "Choose a queued corpus document.")
    require(not document[2] or document[2] == configuration, "The piece belongs to another configuration.")
    docs = [doc for doc in emission["documents"] if doc["id"] == document[1]]
    require(len(docs) == 1 and configuration in docs[0]["configurations"], "The original emission lacks this configuration.")
    label = configuration
    if label not in ("minimum", "maximum"):
        single = sorted(set(docs[0]["configurations"]) - {"minimum", "maximum"})
        label = f"single flag {single.index(configuration) + 1}"
    rows = [row for kind in ("active", "finished", "workerLost") for row in checkpoint[kind] if row["group"] == group]
    require(len(rows) == 1 and rows[0]["phase"] == "main", "The checkpoint has no single main-queue record for this group.")
    row = rows[0]
    require(any(b["id"] == row["block"] and any(g["group"] == group for g in b["groups"]) for b in queue["blocks"]),
            "The checkpoint group is absent from its recorded block.")
    require(operation in ("active", "last-completed"), "Select the active or last-completed operation.")
    field = "input" if operation == "active" else "lastInput"
    require(row.get(field + "Scope") == stage and f"{label}/b" in row.get(field + "Stage", []),
            "The checkpoint has no matching B operation in this configuration.")
    digest = row.get(field + "Sha256")
    require(isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest), "The operation has no input digest.")
    env = queue["environment"]
    require(env["PROOF_HQ_DETERMINISM"] == "on" and env["PROOF_HQ_SPEED"] in ("on", "off")
            and env["PYTHONHASHSEED"] == "0" and env["TZ"] == "UTC", "This replay needs the seeded lane environment.")
    return {
        "request": {"document": document[1], "configuration": configuration, "stage": stage,
                    "inputSha256": digest, "seconds": seconds},
        "source": source, "operation": operation, "group": group, "block": row["block"],
        "queueSha256": checkpoint["queues"]["main"], "fingerprints": queue["fingerprints"], "environment": env,
    }


def extract_corpus(stream, destination):
    destination.mkdir()
    # No archive permissions or links reach the host. The corpus contains only relative directories and files.
    with tarfile.open(fileobj=stream, mode="r|") as tar:
        for item in tar:
            relative = Path(item.name)
            require(not relative.is_absolute() and ".." not in relative.parts, "Unexpected corpus path.")
            target = destination / relative
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                require(item.isreg() and not item.issparse(), "The corpus must contain plain files.")
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as out, tar.extractfile(item) as data:
                    shutil.copyfileobj(data, out)


def unpack_corpus(archive, destination):
    with subprocess.Popen(["zstd", "-dc", archive], stdout=subprocess.PIPE) as decoder:
        try:
            extract_corpus(decoder.stdout, destination)
            # tar may stop after the first end marker while zstd is still writing padding.
            while decoder.stdout.read(1024 * 1024):
                pass
        finally:
            decoder.stdout.close()
        require(decoder.wait() == 0, "The corpus archive did not decompress.")


def single_file(directory):
    entries = list(directory.iterdir())
    require(len(entries) == 1 and entries[0].is_file() and not entries[0].is_symlink(), "Expected one downloaded artifact file.")
    return entries[0]


def file_digest(path):
    h = hashlib.sha256()
    with path.open("rb") as data:
        for chunk in iter(lambda: data.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def prepare(root):
    env = os.environ
    checkpoint_name = env["CHECKPOINT"]
    shard, _, _ = artifact_names(checkpoint_name, env["ATTEMPT"])
    checkpoint_file = single_file(root / "checkpoint")
    corpus_file = single_file(root / "archive")
    with zipfile.ZipFile(checkpoint_file) as archive:
        members = archive.infolist()
        require(len(members) == 1 and members[0].filename == checkpoint_name and members[0].file_size <= 2 * 1024 * 1024,
                "The checkpoint archive must contain its single named progress record.")
        checkpoint = json.loads(archive.read(members[0]))
    job = json.loads((root / "source-job.json").read_text())
    require(checkpoint["source"].get("runner") == job["runner_name"], "The checkpoint names another hosted runner.")
    unpack_corpus(corpus_file, root / "corpus")
    emission = json.loads((root / "corpus" / "index.json").read_text())
    receipt = selection(checkpoint, single_file(root / "queue").read_bytes(), emission, run=env["SOURCE_RUN"], attempt=env["ATTEMPT"],
                        shard=shard, commit=env["COMMIT"], group=env["GROUP"], configuration=env["CONFIGURATION"],
                        stage=env["STAGE"], operation=env["OPERATION"], seconds=int(env["STAGE_SECONDS"]))
    receipt["checkpoint"] = checkpoint_name
    receipt["job"] = job
    receipt["checkpointSha256"] = file_digest(checkpoint_file)
    receipt["corpusSha256"] = file_digest(corpus_file)
    mode = env["MODE"]
    require(mode in ("reproduce", "fresh"), "Choose reproduce or fresh.")
    receipt["request"]["mode"] = mode
    receipt["emission"] = {k: emission[k] for k in ("seed", "sample", "entropy")}
    (root / "receipt.json").write_text(json.dumps(receipt))


def runtime(root):
    from proof.lane import readers
    from proof.store import fingerprints

    receipt = json.loads((root / "receipt.json").read_text())
    strict = receipt["request"]["mode"] == "reproduce"
    checked = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    wanted = receipt["source"]["commit"] if strict else os.environ["GITHUB_SHA"]
    require(checked == wanted, "The checked-out commit differs from the requested source.")
    image = json.loads(Path("proof/image.lock").read_text())["image"]
    digest = re.search(r"@(sha256:[0-9a-f]{64})$", image)
    require(digest, "The replay needs a digest-pinned proof image.")
    subprocess.run(["docker", "pull", "--platform", "linux/amd64", image], check=True)
    identity = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}} {{.Id}}", image], text=True).strip()
    require(re.fullmatch(r"linux/amd64 sha256:[a-f0-9]{64}", identity), "The replay requires the pinned Linux amd64 image.")
    current = fingerprints.compute(Path.cwd(), arch="amd64", image=digest[1])
    encoded = "PROOF_FINGERPRINTS=" + json.dumps(current, sort_keys=True, separators=(",", ":"))
    key = hashlib.sha256(encoded.encode()).hexdigest()
    if strict:
        require(identity == "linux/amd64 " + receipt["source"]["image"], "The native image differs from the original worker.")
        require(current == receipt["fingerprints"] and key == receipt["source"]["fingerprints"],
                "The checkout, reader dependencies or pinned database differ from the original worker.")
    receipt["replay"] = {"commit": checked, "image": identity.split()[1], "fingerprints": key}
    (root / "receipt.json").write_text(json.dumps(receipt))
    profile = receipt["environment"]["PROOF_READERS"]
    selected = readers.parse(profile)
    require(readers.canonical(selected) == profile, "Expected a canonical reader profile.")
    # The stage scope matched a recorded checkpoint. JSON escapes newline characters before it crosses the runner protocol.
    with open(os.environ["GITHUB_ENV"], "a") as out:
        print("PROOF_REPLAY_STAGE=" + json.dumps(receipt["request"]), file=out)
        print("PROOF_READERS=" + profile, file=out)
        print("PROOF_CORPUS=" + str(root / ("corpus" if strict else "fresh")), file=out)
        print("PROOF_HQ_SPEED=" + ("0" if receipt["environment"]["PROOF_HQ_SPEED"] == "off" else "1"), file=out)
    with open(os.environ["GITHUB_OUTPUT"], "a") as out:
        print(f"android={str('android' in selected).lower()}", file=out)


def report(root, output, *, successful):
    """Keep only the selected native record and its content-addressed bytes after the host has sealed output."""
    dest = root / "report"
    dest.mkdir()
    source = root / "receipt.json"
    request = json.loads(source.read_text())["request"]
    shutil.copyfile(source, dest / "source.json")
    host = output / "host-status.json"
    if host.is_file():
        shutil.copyfile(host, dest / host.name)
    stages = list(output.glob("blocks/*/diagnostics/stage-*"))
    if not stages:
        require(not successful, "The runner succeeded without a native stage receipt.")
        (dest / "status.json").write_text(json.dumps({"status": "no-native-stage-recorded"}))
        return
    require(len(stages) == 1, "The single operation wrote multiple stage records.")
    stage = stages[0]
    require(stage.is_dir() and re.fullmatch(r"stage-[0-9]+", stage.name)
            and re.fullmatch(r"[a-f0-9]{64}", stage.parents[1].name), "Unexpected diagnostic stage path.")
    status = json.loads((stage / "stage.json").read_text())
    require(all(status.get(k) == v for k, v in request.items()), "The native stage receipt identifies another operation.")
    require(not successful or status["status"] == "observed", "The runner succeeded without a native observation.")
    held = dest / stage.name
    held.mkdir()
    shutil.copyfile(stage / "stage.json", held / "stage.json")
    if status["status"] == "observed":
        actual = status["observedInputSha256"]
        require(isinstance(actual, str) and re.fullmatch("[a-f0-9]{64}", actual)
                and status["inputMatchesReference"] is (actual == request["inputSha256"]), "Invalid native input comparison.")
        require(request.get("mode") == "fresh" or status["inputMatchesReference"], "The native operation observed a different input.")
        native = stage / "native.json"
        require(file_digest(native) == status["outputSha256"], "Native result digest differs.")
        shutil.copyfile(native, held / native.name)
        blobs = list((stage / "blobs").iterdir())
        require(len(blobs) == status["blobs"], "The diagnostic lacks its native attachments.")
        (held / "blobs").mkdir()
        for blob in blobs:
            require(blob.is_file() and re.fullmatch("[a-f0-9]{64}", blob.name)
                    and file_digest(blob) == blob.name, "Native attachment digest differs.")
            shutil.copyfile(blob, held / "blobs" / blob.name)


def main():
    command, path = sys.argv[1:]
    root = Path(path)
    if command == "names":
        env = os.environ
        require(re.fullmatch("[1-9][0-9]*", env["SOURCE_RUN"]) and re.fullmatch("[1-9][0-9]*", env["ATTEMPT"])
                and re.fullmatch("[0-9a-f]{40}", env["COMMIT"]), "Name the run ID, attempt and full original commit.")
        shard, queue, corpus = artifact_names(env["CHECKPOINT"], env["ATTEMPT"])
        repo = env["GITHUB_REPOSITORY"]
        attempt = f"repos/{repo}/actions/runs/{env['SOURCE_RUN']}/attempts/{env['ATTEMPT']}"
        run = json.loads(subprocess.check_output(["gh", "api", attempt]))
        require(str(run["id"]) == env["SOURCE_RUN"] and str(run["run_attempt"]) == env["ATTEMPT"]
                and recorded_commit(run, repo, env["COMMIT"], shard), "GitHub did not record this proof source for the requested attempt.")
        pages = json.loads(subprocess.check_output(["gh", "api", "--paginate", "--slurp", attempt + "/jobs?per_page=100"]))
        job = source_job([j for page in pages for j in page["jobs"]], shard)
        root.mkdir(exist_ok=True)
        (root / "source-job.json").write_text(json.dumps(job))
        with open(env["GITHUB_OUTPUT"], "a") as out:
            print(f"queue={queue}", file=out)
            print(f"corpus={corpus}", file=out)
    elif command == "prepare":
        prepare(root)
    elif command == "runtime":
        # Launch from the verified historical checkout even when this host helper came from a newer workflow.
        sys.path.insert(0, str(Path.cwd()))
        runtime(root)
    elif command == "emit":
        receipt = json.loads((root / "receipt.json").read_text())
        emission = receipt["emission"]
        require(receipt["request"]["mode"] == "fresh" and emission["entropy"] == "seeded"
                and type(emission["seed"]) is int and type(emission["sample"]) is int,
                "Generating new diagnostic inputs needs the original seeded corpus sample.")
        subprocess.run(["node", "--conditions=react-server", "--import", "./proof/corpus/entropy.mts", "--import", "tsx",
                        "proof/corpus/emit.ts", "--out", root / "fresh", "--seed", str(emission["seed"]),
                        "--sample", str(emission["sample"]), "--jobs", "4"], check=True)
    elif command == "report":
        report(root, Path(os.environ["PROOF_OUT_DIR"]), successful=os.environ["OBSERVATION_OUTCOME"] == "success")
    else:
        raise ValueError("Choose names, prepare, runtime, emit or report.")


if __name__ == "__main__":
    main()
