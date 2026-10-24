export function parseKeyValueArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--')) throw new Error(`Unexpected argument: ${argv[index]}`);
    args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}
