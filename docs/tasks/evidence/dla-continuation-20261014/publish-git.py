"""Non-forced Git API fallback after failed Git transport; upload exact trees and preserve merge parents."""
import base64, datetime, json, pathlib, subprocess, sys, tempfile

repo = "paher-din/XunJie"
root = pathlib.Path(__file__).resolve().parents[4]
branch = "codex/dl-a-mainline-closeout"
target, expected, receipt = sys.argv[1:4]

def git(*args):
    return subprocess.check_output(["git", *args], cwd=root)

def api(path, payload=None):
    command = ["gh", "api", "repos/" + repo + "/" + path]
    if payload is not None:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".json", delete=False) as file:
            json.dump(payload, file, ensure_ascii=False)
            filename = file.name
        # Retain the non-secret request artifact; no destructive cleanup.
        command += ["--method", "PATCH" if path.startswith("git/refs/") else "POST", "--input", filename]
    result = subprocess.run(command, cwd=root, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError("GitHub API failed: " + path + "; " + result.stderr.decode("utf-8", errors="replace"))
    return json.loads(result.stdout)

def entries(commit):
    result = {}
    for item in git("ls-tree", "-r", "-z", commit).split(b"\0"):
        if not item:
            continue
        metadata, path = item.split(b"\t", 1)
        mode, kind, sha = metadata.decode().split()
        result[path.decode()] = (mode, kind, sha)
    return result

mapping_path = pathlib.Path(receipt)
records = json.loads(mapping_path.read_text()) if mapping_path.exists() else {"commits": {}, "uploadedTrees": [], "branch": branch}
remote = api("git/ref/heads/" + branch)["object"]["sha"]
if remote != expected:
    raise RuntimeError("Remote branch moved; inspect before retry: " + remote)
known = set(value[2] for value in entries(expected).values())

def person(line):
    name, email = line.rsplit(" <", 1)
    email, timestamp, zone = email.split()
    offset = (int(zone[1:3]) * 60 + int(zone[3:])) * (1 if zone[0] == "+" else -1)
    moment = datetime.datetime.fromtimestamp(int(timestamp), datetime.timezone(datetime.timedelta(minutes=offset)))
    return {"name": name, "email": email.rstrip(">"), "date": moment.isoformat()}

def upload(commit):
    if commit in records["commits"]:
        return records["commits"][commit]
    raw = git("cat-file", "commit", commit).decode()
    headers, message = raw.split("\n\n", 1)
    values = headers.splitlines()
    parents = [line[7:] for line in values if line.startswith("parent ")]
    if subprocess.run(["git", "merge-base", "--is-ancestor", commit, expected], cwd=root, capture_output=True).returncode == 0:
        return commit
    remote_parents = []
    for parent in parents:
        # Source commits reachable from the current remote main already exist on GitHub.
        on_main = subprocess.run(["git", "merge-base", "--is-ancestor", parent, "origin/main"], cwd=root, capture_output=True).returncode == 0
        if on_main:
            known.update(value[2] for value in entries(parent).values())
            remote_parents.append(parent)
        else:
            remote_parents.append(upload(parent))
    before, after = entries(parents[0]), entries(commit)
    known.update(value[2] for value in before.values())
    changes = []
    for path, item in after.items():
        if before.get(path) == item:
            continue
        mode, kind, sha = item
        entry = {"path": path, "mode": mode, "type": kind}
        if sha in known:
            entry["sha"] = sha
        else:
            data = git("cat-file", "blob", sha)
            try:
                entry["content"] = data.decode("utf-8")
            except UnicodeDecodeError:
                blob = api("git/blobs", {"encoding": "base64", "content": base64.b64encode(data).decode()})
                if blob["sha"] != sha:
                    raise RuntimeError("Binary blob mismatch: " + path)
                entry["sha"] = sha
        changes.append(entry)
    for path in before.keys() - after.keys():
        raise RuntimeError("Unexpected deletion requires separate approval: " + path)
    base_tree = next(line[5:] for line in git("cat-file", "commit", parents[0]).decode().splitlines() if line.startswith("tree "))
    tree = api("git/trees", {"base_tree": base_tree, "tree": changes})["sha"]
    local_tree = next(line[5:] for line in values if line.startswith("tree "))
    if tree != local_tree:
        raise RuntimeError("Exact Git tree mismatch")
    body = {"message": message, "tree": tree, "parents": remote_parents,
            "author": person(next(line[7:] for line in values if line.startswith("author "))),
            "committer": person(next(line[10:] for line in values if line.startswith("committer ")))}
    remote_commit = api("git/commits", body)["sha"]
    records["commits"][commit] = remote_commit
    records["uploadedTrees"].append({"localCommit": commit, "remoteCommit": remote_commit, "tree": tree, "changedEntries": len(changes)})
    mapping_path.write_text(json.dumps(records, indent=2) + "\n")
    known.update(value[2] for value in after.values())
    print("Uploaded exact tree:", commit[:7], "->", remote_commit[:7], flush=True)
    return remote_commit

final = upload(target)
if api("git/ref/heads/" + branch)["object"]["sha"] != expected:
    raise RuntimeError("Remote moved during upload; did not update ref")
updated = api("git/refs/heads/" + branch, {"sha": final, "force": False})["object"]["sha"]
assert updated == final
assert api("git/ref/heads/" + branch)["object"]["sha"] == final
records.update({"expectedHead": expected, "publishedHead": final, "localHead": target, "force": False, "treeVerified": True})
mapping_path.write_text(json.dumps(records, indent=2) + "\n")
print("Non-forced branch update verified:", final)
