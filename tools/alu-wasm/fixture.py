#!/usr/bin/env python3
"""Materialize engineering-only HDL; never import this into student scaffolds."""
import json
from pathlib import Path
import runpy
import sys

probe = runpy.run_path(str(Path(__file__).parent.parent / 'research/probe-alu-iverilog.py'))
Path(sys.argv[1]).write_text(json.dumps({'dut': probe['DUT'], 'testbench': probe['TESTBENCH']}), encoding='utf-8')
