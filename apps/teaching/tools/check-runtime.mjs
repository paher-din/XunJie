const approvedVersion = 'v24.21.0';

if (process.version !== approvedVersion) {
  process.stderr.write(`Expected Node ${approvedVersion}; found ${process.version}. Use the approved runtime.\n`);
  process.exitCode = 1;
}
