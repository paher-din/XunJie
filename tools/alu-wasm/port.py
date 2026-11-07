#!/usr/bin/env python3
"""Apply the explicit static-module port to a clean, pinned Icarus source tree."""
from pathlib import Path
import sys

root = Path(sys.argv[1])

for file in ['t-dll.cc', 'vpi_modules.cc']:
    path = root / file
    path.write_text('#define XUNJIE_COMPILER 1\n' + path.read_text())


def replace(file, old, new):
    path = root / file
    text = path.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"Port context changed: {file}: {old[:70]!r}")
    path.write_text(text.replace(old, new))


# Keep module declarations and both upstream startup loops intact. Resolve only
# the explicitly bundled module; unknown module names retain failure diagnostics.
replace('ivl_dlfcn.h', '#if defined(__MINGW32__)\n# include <windows.h>',
        '#if defined(__EMSCRIPTEN__)\ntypedef void* ivl_dll_t;\n'
        '#elif defined(__MINGW32__)\n# include <windows.h>')
replace('ivl_dlfcn.h', '#if defined(__MINGW32__)\nstatic inline ivl_dll_t', r'''#if defined(__EMSCRIPTEN__)
#include <cstring>
extern "C" { extern void (*vlog_startup_routines[])(void); }
#ifdef XUNJIE_COMPILER
#include "ivl_target.h"
#endif
static inline ivl_dll_t ivl_dlopen(const char* name, bool)
{
      const char* base = strrchr(name, '/');
      base = base ? base + 1 : name;
      if (strcmp(base, "system.vpi") == 0 || strcmp(base, "system") == 0)
            return reinterpret_cast<void*>(1);
#ifdef XUNJIE_COMPILER
      if (strcmp(base, "vvp.tgt") == 0) return reinterpret_cast<void*>(2);
#endif
      return 0;
}
static inline void* ivl_dlsym(ivl_dll_t dll, const char* name)
{
      if (dll == reinterpret_cast<void*>(1) && strcmp(name, "vlog_startup_routines") == 0)
            return reinterpret_cast<void*>(vlog_startup_routines);
#ifdef XUNJIE_COMPILER
      if (dll == reinterpret_cast<void*>(2)) {
            if (strcmp(name, "target_design") == 0) return reinterpret_cast<void*>(target_design);
            if (strcmp(name, "target_query") == 0) return reinterpret_cast<void*>(target_query);
      }
#endif
      return 0;
}
static inline void ivl_dlclose(ivl_dll_t) {}
static inline const char* xunjie_module_error() { return "module is not in the fixed WASM runtime"; }
#define dlerror xunjie_module_error
#elif defined(__MINGW32__)
static inline ivl_dll_t''')

# The upstream VVP loader first stats dynamic libraries. Builtins have no file;
# execute the same registration sequence, in the same VPI mode, before that path.
replace('vvp/vpi_modules.cc', 'void vpip_load_module(const char*name)\n{', r'''void vpip_load_module(const char*name)
{
#ifdef __EMSCRIPTEN__
      ivl_dll_t builtin = ivl_dlopen(name, false);
      if (builtin) {
            auto routines = reinterpret_cast<vlog_startup_routines_t*>(ivl_dlsym(builtin, "vlog_startup_routines"));
            assert(routines);
            vpi_mode_flag = VPI_MODE_REGISTER;
            for (unsigned idx = 0; routines[idx]; ++idx) routines[idx]();
            vpi_mode_flag = VPI_MODE_NONE;
            return;
      }
#endif''')

# Static archives reuse upstream object lists and generated parser dependencies.
for directory, objects in [('vpi', '$O $(OPP)'), ('tgt-vvp', '$O')]:
    path = root / directory / 'Makefile.in'
    with path.open('a') as out:
        out.write(f'\nxunjie-static.a: {objects}\n\t$(AR) rcs $@ {objects}\n')

for file in ['Makefile.in', 'ivlpp/Makefile.in', 'vvp/Makefile.in']:
    path = root / file
    path.write_text(path.read_text().replace('@EXEEXT@', '.js'))

replace('vvp/Makefile.in', '$(BUILDCC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o draw_tt',
        '$(BUILDCC) $(CPPFLAGS) $(CFLAGS) -o draw_tt')

print('Applied static system.vpi/compiler target port; upstream startup tables retained.')
