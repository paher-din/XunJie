import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import uuid

launcher = Path(sys.argv[1]).resolve()
fixture = launcher.parent / ("appcontainer-" + uuid.uuid4().hex)
allowed = fixture / "allowed"
allowed.mkdir(parents=True)
executable = allowed / "worker.exe"
shutil.copyfile(launcher, executable)
inside = allowed / "inside.txt"
sibling = fixture / "other-session"
sibling.mkdir()
outside = sibling / "outside.txt"
inside.write_text("inside", encoding="utf-8")
outside.write_text("outside", encoding="utf-8")
def grant_fixture(directory, profile_env):
    sid = subprocess.check_output(
        [launcher, "sid"], text=True, timeout=10, env=profile_env,
    ).strip()
    subprocess.run(
        ["icacls", directory, "/grant", "*" + sid + ":(OI)(CI)M", "/T"],
        check=True, stdout=subprocess.DEVNULL, timeout=10,
    )
    return sid


first_sid = grant_fixture(allowed, None)
second_sid = grant_fixture(sibling, {**os.environ, "XJ_PROBE_SECOND_PROFILE": "1"})
if first_sid == second_sid:
    raise RuntimeError("Expected distinct AppContainer identities")
arguments = sys.argv[2:]
node_source = None
if "--node" in arguments:
    index = arguments.index("--node")
    node_source = Path(arguments[index + 1]).resolve()
    del arguments[index:index + 2]

addresses = ["127.0.0.1", *arguments]
for address in addresses:
    with socket.socket() as listener:
        listener.bind((address, 0))
        listener.listen()
        args = [inside, outside, address, str(listener.getsockname()[1])]
        baseline = subprocess.run([executable, "worker", *args], timeout=10)
        if baseline.returncode != 39:
            raise RuntimeError(f"Ordinary process fixture failed: {baseline.returncode}")
        listener.settimeout(1)
        connection, _ = listener.accept()
        connection.close()
        restricted = subprocess.run([launcher, executable, *args], timeout=10)
        print(f"{address}: ordinary={baseline.returncode} appcontainer={restricted.returncode}")
        if restricted.returncode not in (9, 25):
            raise RuntimeError(f"AppContainer access differed from expectation: {restricted.returncode}")
        try:
            connection, _ = listener.accept()
        except TimeoutError:
            continue
        connection.close()
        raise RuntimeError("Listener received a connection from the restricted process")


if node_source:
    node = allowed / "node.exe"
    script = allowed / "probe.cjs"
    shutil.copyfile(node_source, node)
    script.write_text(
        """const fs = require('node:fs');
const allowed = fs.readFileSync(__filename, 'utf8').includes('probe');
try {
  fs.readFileSync(process.argv[2]);
  process.exit(42);
} catch (error) {
  process.exit(allowed && ['EACCES', 'EPERM'].includes(error.code) ? 43 : 1);
}
""",
        encoding="utf-8",
    )
    baseline = subprocess.run([node, script, outside], timeout=10)
    restricted = subprocess.run([launcher, node, "node", script, outside], timeout=10)
    print(f"Node ordinary={baseline.returncode} appcontainer={restricted.returncode}")
    if (baseline.returncode, restricted.returncode) != (42, 43):
        raise RuntimeError("Node runtime launch/access probe failed")


    adapter = Path(__file__).resolve().parents[1] / "packages/learning-space/dist/learning-data/native-process.js"
    source = subprocess.check_output(
        [node_source, "--input-type=module", "-e",
         "import {fourStateAccumulatorSource} from " + json.dumps(adapter.as_uri())
         + "; process.stdout.write(fourStateAccumulatorSource);"],
        encoding="utf-8", timeout=10,
    )
    messages = [{"type": "ready"}]
    messages.extend(
        {"type": "input", "seq": seq, "controlId": f"probe-{seq}", "parameters": {"value": value}}
        for seq, value in enumerate([1, 2, 2], start=1)
    )
    messages.append({"type": "stop"})
    command = subprocess.list2cmdline([str(node), "--max-old-space-size=32", "--input-type=module", "-e", source])
    instance_id = "appcontainer-probe"
    system_root = os.environ["SystemRoot"]
    output = subprocess.run(
        [launcher, node, "adapter", command, allowed], timeout=10, check=True,
        input="".join(json.dumps(message) + "\n" for message in messages),
        encoding="utf-8", stdout=subprocess.PIPE,
        env={"SystemRoot": system_root, "USERPROFILE": os.environ["USERPROFILE"],
             "LOCALAPPDATA": os.environ["LOCALAPPDATA"], "TEMP": str(allowed), "TMP": str(allowed),
             "XJ_SESSION_INSTANCE": instance_id},
    ).stdout
    replies = [json.loads(line) for line in output.splitlines()]
    if (
        [reply["type"] for reply in replies] != ["ready", "observation", "observation", "observation", "stopped"]
        or replies[0]["instanceId"] != instance_id
        or [reply["state"]["value"] for reply in replies[1:-1]] != [1, 3, 1]
    ):
        raise RuntimeError(f"Unexpected fixed adapter replies: {replies}")
    print("Fixed adapter through AppContainer Job pipes: ready, 1, 3, 1, stopped")
