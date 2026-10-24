#!/usr/bin/env python3
"""Bounded, standalone experiment for the new ALU activity; no app services needed."""
import argparse
import hashlib
import json
import platform
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path


DUT = """`timescale 1ns/1ps
module alu(input logic [3:0] A, B, input logic M,
  input logic [1:0] S, input logic Cin, output logic [3:0] F,
  output logic Cout);
always_comb begin
  F = 4'b0000;
  Cout = 1'b0;
  case ({M,S})
    3'b000: F = ~A;
    3'b001: F = A & B;
    3'b010: F = A | B;
    3'b011: F = A ^ B;
    3'b100: {Cout,F} = {1'b0,A} + {1'b0,B} + {4'b0000,Cin};
    default: begin F = 4'b0000; Cout = 1'b0; end
  endcase
end
endmodule
"""

TESTBENCH = """`timescale 1ns/1ps
module tb;
logic [3:0] A, B;
logic M, Cin;
logic [1:0] S;
wire [3:0] F;
wire Cout;
integer i;
alu dut(A, B, M, S, Cin, F, Cout);
initial begin
  $dumpfile("trace.vcd");
  $dumpvars(0, tb);
  for (i = 0; i < 4096; i = i + 1) begin
    {M,S,A,B,Cin} = i[11:0];
    #1;
    $display("ROW %0d %b %b", i, F, Cout);
  end
  $finish;
end
endmodule
"""


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def run(argv, cwd, timeout=10):
    started = time.perf_counter()
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return result, round((time.perf_counter() - started) * 1000, 3)


def expected(i):
    cin, b, a, control = i & 1, (i >> 1) & 15, (i >> 5) & 15, i >> 9
    if control == 4:
        value = a + b + cin
        return value & 15, value >> 4
    return {0: (~a) & 15, 1: a & b, 2: a | b, 3: a ^ b}.get(control, 0), 0


def probe_case(folder, compiler, runtime, source):
    folder.mkdir()
    (folder / "alu.sv").write_text(source)
    (folder / "tb.sv").write_text(TESTBENCH)
    compile_result, compile_ms = run(
        [compiler, "-g2012", "-Wall", "-s", "tb", "-o", "design.vvp", "alu.sv", "tb.sv"], folder
    )
    if compile_result.returncode:
        raise RuntimeError(compile_result.stderr)
    result, run_ms = run([runtime, "design.vvp"], folder)
    if result.returncode:
        raise RuntimeError(result.stderr)
    rows = re.findall(r"^ROW (\d+) ([01xz]{4}) ([01xz])$", result.stdout, re.MULTILINE)
    if [int(row[0]) for row in rows] != list(range(4096)):
        raise RuntimeError("Incomplete or duplicate vector output")
    unknown = sum("x" in f + c or "z" in f + c for _, f, c in rows)
    mismatches = sum(
        "x" in f + c or "z" in f + c or (int(f, 2), int(c, 2)) != expected(int(i))
        for i, f, c in rows
    )
    trace = (folder / "trace.vcd").read_bytes()
    vcd_valid = all(part in trace for part in [b"$enddefinitions", b"$var", b"#4096000"])
    normalized_rows = "\n".join(" ".join(row) for row in rows).encode()
    return {
        "vectors": len(rows), "mismatches": mismatches, "unknown_outputs": unknown,
        "compile_ms": compile_ms, "simulation_and_output_ms": run_ms,
        "source_sha256": sha256(source.encode()), "rows_sha256": sha256(normalized_rows),
        "vcd_bytes": len(trace), "vcd_has_definitions_and_final_timestamp": vcd_valid,
        "diagnostics": compile_result.stderr.strip(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    compiler, runtime = shutil.which("iverilog"), shutil.which("vvp")
    if not compiler or not runtime:
        raise SystemExit("This probe needs an existing iverilog and vvp; it never installs them.")
    with tempfile.TemporaryDirectory(prefix="xunjie-alu-probe-") as directory:
        root = Path(directory)
        compiler_version, _ = run([compiler, "-V"], root)
        runtime_version, _ = run([runtime, "-V"], root)
        good = probe_case(root / "correct", compiler, runtime, DUT)
        lost_carry = probe_case(root / "lost-carry", compiler, runtime,
                               DUT.replace("{Cout,F} =", "F ="))
        unknown = probe_case(root / "unknown-reserved", compiler, runtime,
                            DUT.replace("default: begin F = 4'b0000;", "default: begin F = 4'bxxxx;"))
        spin_source = "module spin; reg bit_value; initial begin bit_value=0; forever #1 bit_value=~bit_value; end endmodule\n"
        (root / "spin.sv").write_text(spin_source)
        compiled, _ = run([compiler, "-g2012", "-s", "spin", "-o", "spin.vvp", "spin.sv"], root)
        if compiled.returncode:
            raise RuntimeError(compiled.stderr)
        timeout_confirmed = False
        started = time.perf_counter()
        try:
            run([runtime, "spin.vvp"], root, timeout=0.25)
        except subprocess.TimeoutExpired:
            # subprocess.run kills and waits for this direct child before raising.
            timeout_confirmed = True
        timeout_ms = round((time.perf_counter() - started) * 1000, 3)
        report = {
            "scope": "CLI on this host only; no browser, Windows, installer, network or sandbox acceptance",
            "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
            "compiler": compiler_version.stdout.splitlines()[0],
            "runtime": (runtime_version.stderr or runtime_version.stdout).splitlines()[0],
            "testbench_sha256": sha256(TESTBENCH.encode()),
            "compiler_arguments": ["-g2012", "-Wall", "-s", "tb"],
            "correct": good, "lost_carry_negative_control": lost_carry,
            "unknown_reserved_negative_control": unknown,
            "bounded_process_probe": {"timeout_ms": 250, "observed_ms": timeout_ms, "direct_child_terminated": timeout_confirmed},
        }
        assert good["mismatches"] == 0 and good["vcd_has_definitions_and_final_timestamp"]
        assert lost_carry["mismatches"] > 0
        assert unknown["unknown_outputs"] == 1536
        assert timeout_confirmed
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
