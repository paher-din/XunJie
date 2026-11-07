#!/usr/bin/env bash
# Development build of a clean tree already processed by port.py.
# Not a release builder until the two-clean-build reproducibility gate is added.
set -eu
if [ "$#" -ne 3 ]; then
  echo 'usage: build-port.sh <patched-source> <emsdk> <output>' >&2
  exit 2
fi
src=$(realpath "$1")
sdk=$(realpath "$2")
scripts=$(cd "$(dirname "$0")" && pwd)
python3 "$scripts/verify-sdk.py" "$sdk"
mkdir -p "$3"
out=$(realpath "$3")
# shellcheck disable=SC1091
source "$sdk/emsdk_env.sh"
emcc --version | head -1
export LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=0
cd "$src"
sh autoconf.sh
emconfigure ./configure --host=wasm32-unknown-emscripten --prefix=/runtime \
  CC_FOR_BUILD=gcc CFLAGS='-O2' CXXFLAGS='-O2 -std=c++11' \
  ac_cv_lib_readline_readline=no ac_cv_lib_termcap_tputs=no \
  ac_cv_lib_readline_add_history=no ac_cv_lib_history_add_history=no \
  ac_cv_lib_z_gzwrite=no ac_cv_lib_bz2_main=no ac_cv_lib_bz2_BZ2_bzdopen=no
flags="-O2 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=268435456 -sSTACK_SIZE=1048576 -sEXPORTED_RUNTIME_METHODS=FS,callMain -sFORCE_FILESYSTEM=1"
make -j4 version_base.h version_tag.h _pli_types.h
make -C vpi -j4 xunjie-static.a AR=emar
make -C tgt-vvp -j4 xunjie-static.a AR=emar
make -j4 ivl.js EXEEXT=.js LDFLAGS="$flags" dllib='tgt-vvp/xunjie-static.a vpi/xunjie-static.a'
make -C ivlpp -j4 ivlpp.js EXEEXT=.js LDFLAGS="$flags"
make -C vvp -j4 vvp.js EXEEXT=.js LDFLAGS="$flags" LIBS='../vpi/xunjie-static.a'
cp ivl.js ivl.wasm ivlpp/ivlpp.js ivlpp/ivlpp.wasm vvp/vvp.js vvp/vvp.wasm "$out/"
(cd "$out" && sha256sum ivl.js ivl.wasm ivlpp.js ivlpp.wasm vvp.js vvp.wasm) > "$out/checksums.txt"
