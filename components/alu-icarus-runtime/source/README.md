# Corresponding Icarus source and build instructions

This directory contains the exact upstream source archive, explicit port and
fixed toolchain/environment identities used for this candidate. Icarus source
notices and COPYING.icarus govern the upstream code; retain these on distribution.

On the recorded Ubuntu environment, prepare the Emsdk commit/version in
toolchain.lock.json. Run doctor.sh and compare ubuntu-packages.lock with
LC_ALL=C dpkg-query -W. Do not substitute a rolling SDK.

Extract iverilog.tar.gz into a new empty directory, run:

    python3 port.py /absolute/clean-source
    bash build-port.sh /absolute/clean-source /absolute/emsdk /absolute/new-output

Repeat in a second empty source directory with the same environment. All six
resource digests must match. SOURCE_DATE_EPOCH=0, UTC, C locale, fixed /runtime
installation prefix and optimization flags are set by build-port.sh.

rebuild.sh is the equivalent two-directory gate when the original pinned Git
repository is available. The archive above is sufficient to build without Git.
The XunJie adapter's source modules are supplied alongside the runtime assets.
The archive is generated with `git archive` from the pinned commit and preserves
upstream line endings. Apple Silicon Mac acceptance is recorded in
`docs/student-agent-implementation/wp04-205-mac-acceptance.md`; product
integration is not claimed by this candidate.
