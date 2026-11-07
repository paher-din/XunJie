// Stateless computation adapter. Business acceptance/retention belongs to WP03.
import { bundleIdentity, compilerConfiguration as config, dependencyIdentity, sha256 as hash } from './identity.mjs';
const encoder = new TextEncoder();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const validPath = path => typeof path === 'string' && path.length <= 200 && /^[a-zA-Z0-9_.\-/]+$/.test(path) && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');
function files(input) {
  if (!Array.isArray(input) || input.length > 64) fail('invalid-input', 'At most 64 fixed files are allowed');
  const seen = new Set(); let bytes = 0;
  for (const file of input) {
    if (!validPath(file.path) || seen.has(file.path) || typeof file.content !== 'string') fail('invalid-input', 'Invalid or duplicate file');
    if (file.content.length > 1024 * 1024) fail('input-budget', 'A fixed file exceeds 1 MiB');
    seen.add(file.path); bytes += encoder.encode(file.content).length;
    if (bytes > 1024 * 1024) fail('input-budget', 'Fixed files exceed 1 MiB');
  }
  if (bytes > 1024 * 1024) fail('input-budget', 'Fixed files exceed 1 MiB');
  return input;
}
function writeFiles(fs, input) {
  for (const file of input) {
    const path = '/' + file.path, parent = path.slice(0, path.lastIndexOf('/'));
    if (parent) fs.mkdirTree(parent);
    fs.writeFile(path, file.content);
  }
}
self.onmessage = async ({ data }) => {
  let stage = 'validate';
  const diagnostics = [], output = [], flushers = [];
  const flushText = () => { for (const flush of flushers) flush(); };
  try {
    const { task, bundle } = data;
    if (!['compile', 'simulate'].includes(task.kind)) fail('invalid-input', 'Unknown operation');
    if (!/^[a-f0-9]{64}$/.test(bundle.identity)) fail('invalid-input', 'Invalid runtime identity');
    if (await bundleIdentity(bundle.assets, bundle.adapters) !== bundle.identity) fail('resource-integrity', 'Runtime manifest identity mismatch');
    let textBytes = 0;
    let budgetNotified = false;
    const exceedOutput = message => {
      // Native stdio/syscall layers may catch an exception and continue looping.
      // Notify the owner immediately; it terminates this Worker on first result.
      if (!budgetNotified) {
        budgetNotified = true;
        flushText();
        postMessage({ kind: 'result', status: 'budget-exceeded', code: 'output-budget', stage, message, diagnostics, output });
      }
      fail('output-budget', message);
    };
    // Count raw TTY bytes below, before Emscripten's newline buffer. Decoded callbacks
    // only retain the bounded text; counting here again would charge each byte twice.
    const print = lines => line => { lines.push(line); };
    // A run either reads the fixed files the calling owner already verified, or fetches them from the
    // package's own base URL. The two modes never mix: once a fixed byte set is declared, a file it
    // does not carry fails the run instead of quietly reaching the network.
    const fixed = bundle.resources;
    async function readAsset(name, ext) {
      const asset = bundle.assets[`${name}.${ext}`];
      if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 16 * 1024 * 1024) fail('invalid-input', 'Invalid asset manifest');
      if (fixed) {
        const supplied = fixed[`${name}.${ext}`];
        if (!(supplied instanceof Uint8Array) || supplied.length !== asset.bytes) fail('resource-unavailable', `${name}.${ext}: fixed bytes missing`);
        // The owner hashed them, but this Worker is the process that executes them, so it re-verifies.
        if (await hash(supplied) !== asset.sha256) fail('resource-integrity', `${name}.${ext}: digest mismatch`);
        return supplied;
      }
      let response;
      try { response = await fetch(new URL(`${name}.${ext}`, bundle.baseUrl)); }
      catch { fail('resource-unavailable', `${name}.${ext}: network failure`); }
      if (!response.ok) fail('resource-unavailable', `${name}.${ext}: ${response.status}`);
      const reader = response.body.getReader(); const parts = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > asset.bytes) { await reader.cancel(); fail('resource-integrity', 'Asset larger than manifest'); }
        parts.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      if (size !== asset.bytes || await hash(bytes) !== asset.sha256) fail('resource-integrity', 'Asset digest mismatch');
      return bytes;
    }
    async function load(name, output) {
      stage = 'load-' + name; postMessage({ kind: 'stage', stage });
      const resources = await Promise.all(['js', 'wasm'].map(ext => readAsset(name, ext)));
      const url = URL.createObjectURL(new Blob([resources[0]], { type: 'text/javascript' }));
      try {
        const factory = (await import(url)).default;
        // The module is always handed its own bytes. `locateFile` only names the binary here: the glue
        // needs a stable key, and resolving a URL against this Blob module would throw. Nothing fetches it,
        // because `wasmBinary` is present; in served mode the name resolves to the package's own base URL.
        const module = await factory({ wasmBinary: resources[1],
          locateFile: bundle.baseUrl ? file => new URL(file, bundle.baseUrl).href : file => file,
          print: print(output), printErr: print(diagnostics) });
        flushers.push(() => {
          const ttys = new Set([module.FS.getStream(1)?.tty, module.FS.getStream(2)?.tty]);
          for (const tty of ttys) if (tty?.output?.length) tty.ops.fsync(tty);
        });
        // Enforce the MEMFS file extent while native writes occur, including seek.
        // Emscripten syscalls dispatch through FS.write; checking only readback
        // would allow an unbounded VCD before the observer can react.
        const write = module.FS.write;
        const extents = new Map(); let totalExtent = 0;
        module.FS.write = function (stream, buffer, offset, length, position, ...rest) {
          const start = position === undefined ? stream.position : position;
          if (stream.tty) {
            if (textBytes + length > 2 * 1024 * 1024) exceedOutput('Text output exceeds 2 MiB');
            textBytes += length;
          }
          if (module.FS.isFile(stream.node.mode)) {
            const previous = extents.get(stream.node.id) ?? 0;
            const extent = Math.max(previous, start + length);
            if (extent > 8 * 1024 * 1024) exceedOutput('A generated file exceeds 8 MiB');
            if (totalExtent + extent - previous > 16 * 1024 * 1024) exceedOutput('Generated file extents exceed 16 MiB');
            totalExtent += extent - previous; extents.set(stream.node.id, extent);
          }
          return write.call(this, stream, buffer, offset, length, position, ...rest);
        };
        return module;
      } finally { URL.revokeObjectURL(url); }
    }
    function run(module, args) {
      const code = module.callMain(args);
      if (code !== undefined && code !== 0) fail(stage === 'simulate' ? 'simulation-failed' : 'compile-failed', `Tool exit ${code}`);
    }
    let result;
    if (task.kind === 'compile') {
      const sources = files(task.sources);
      if (sources.some(file => file.path === 'pp.conf')) fail('invalid-input', 'Reserved compiler configuration path');
      if (!sources.length || typeof task.top !== 'string' || task.top.length > 200 || !/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(task.top)) fail('invalid-input', 'Source set and top are required');
      const entries = task.entryFiles ?? sources.filter(file => /\.(sv|v)$/.test(file.path)).map(file => file.path);
      if (!Array.isArray(entries) || !entries.length || entries.length > 64 || new Set(entries).size !== entries.length
        || entries.some(path => !validPath(path) || !sources.some(file => file.path === path))) fail('invalid-input', 'Invalid compilation entry files');
      const options = task.options ?? {};
      if (Object.keys(options).some(key => !['includeDirs', 'strictExprWidth'].includes(key))) fail('invalid-input', 'Unsupported compiler option');
      const includes = options.includeDirs ?? [];
      if (!Array.isArray(includes) || includes.length > 32 || includes.some(path => !validPath(path))) fail('invalid-input', 'Invalid include path');
      if (options.strictExprWidth !== undefined && typeof options.strictExprWidth !== 'boolean') fail('invalid-input', 'Invalid width option');
      const dependencyId = await dependencyIdentity(bundle.identity, task);
      const preprocessed = [], pp = await load('ivlpp', preprocessed);
      writeFiles(pp.FS, sources);
      pp.FS.writeFile('/pp.conf', includes.map(path => 'I:/' + path).join('\n') + '\n');
      stage = 'preprocess'; postMessage({ kind: 'stage', stage });
      run(pp, ['-L', '-F/pp.conf', ...entries.map(path => '/' + path)]);
      const compiler = await load('ivl', []);
      compiler.FS.writeFile('/src.v', preprocessed.join('\n') + '\n');
      compiler.FS.writeFile('/ivl.conf', ['basedir:/', 'module:' + config.systemModule, ...config.generations.map(value => 'generation:' + value),
        ...(options.strictExprWidth ? ['generation:strict-expr-width'] : []), 'root:' + task.top,
        'out:/out.vvp', 'iwidth:' + config.iwidth, 'widthcap:' + config.widthcap, ...config.functors.map(value => 'functor:' + value), 'flag:DLL=' + config.target, ''].join('\n'));
      stage = 'compile'; postMessage({ kind: 'stage', stage });
      run(compiler, ['-C/ivl.conf', '--', '/src.v']);
      const program = compiler.FS.readFile('/out.vvp');
      if (program.length > 8 * 1024 * 1024) fail('output-budget', 'Compiled program too large');
      result = { artifact: { version: 1, dependencyId, bundleIdentity: bundle.identity, program, programSha256: await hash(program) } };
    } else {
      const artifact = task.artifact;
      if (artifact?.version !== 1 || artifact.bundleIdentity !== bundle.identity || !/^[a-f0-9]{64}$/.test(artifact.dependencyId) || !(artifact.program instanceof Uint8Array) || artifact.program.length > 8 * 1024 * 1024 || await hash(artifact.program) !== artifact.programSha256) fail('invalid-input', 'Incompatible or corrupt compilation artifact');
      const input = files(task.files ?? []), plusargs = task.plusargs ?? [];
      if (!Array.isArray(plusargs) || plusargs.length > 32 || plusargs.some(arg => typeof arg !== 'string' || !/^\+[a-zA-Z0-9_]+=.{0,256}$/.test(arg))) fail('invalid-input', 'Invalid plusargs');
      const runtime = await load('vvp', output);
      if (input.some(file => ['sim.vvp', 'trace.vcd', 'xunjie-observations.txt'].includes(file.path))) fail('invalid-input', 'Reserved program/output path');
      writeFiles(runtime.FS, input);
      runtime.FS.writeFile('/sim.vvp', artifact.program);
      stage = 'simulate'; postMessage({ kind: 'stage', stage });
      run(runtime, ['/sim.vvp', ...plusargs]);
      let vcd = null;
      try { vcd = runtime.FS.readFile('/trace.vcd', { encoding: 'utf8' }); }
      catch (error) { if (error.errno !== 44) throw error; }
      let observationText = null;
      try { observationText = runtime.FS.readFile('/xunjie-observations.txt', { encoding: 'utf8' }); }
      catch (error) { if (error.errno !== 44) throw error; }
      const observations = (observationText === null ? [] : observationText.split(/\r?\n/).filter(line => line.length)).map(line => {
        const match = /^ROW (\d+) ([01xz]{4}) ([01xz])$/.exec(line);
        return match ? { index: Number(match[1]), f: match[2], cout: match[3] } : { invalid: line };
      });
      let observationState = observations.some(row => row.invalid) ? 'invalid' : observations.length ? 'unverified-coverage' : 'unavailable';
      if (task.expectedIndices !== undefined) {
        const expected = task.expectedIndices;
        if (!Array.isArray(expected) || !expected.length || expected.length > 4096 || expected.some(index => !Number.isInteger(index) || index < 0 || index > 4095) || new Set(expected).size !== expected.length) fail('invalid-input', 'Invalid expected observation indices');
        observationState = observations.length === expected.length && observations.every((row, position) => !row.invalid && row.index === expected[position])
          ? observations.some(row => /[xz]/.test(row.f + row.cout)) ? 'complete-with-unknown' : 'complete'
          : 'incomplete';
      }
      result = { dependencyId: artifact.dependencyId, output, vcd, observations, observationState };
    }
    postMessage({ kind: 'result', status: 'completed', stage, diagnostics, ...result });
  } catch (error) {
    flushText();
    postMessage({ kind: 'result', status: 'failed', stage, code: error.code ?? 'tool-failed', message: String(error.message ?? error), diagnostics, output });
  }
};
