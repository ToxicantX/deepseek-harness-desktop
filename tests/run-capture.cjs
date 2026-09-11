
const { spawn } = require('child_process');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBinary = require('electron');
const child = spawn(electronBinary, [path.resolve(__dirname, 'capture-showcase.cjs')], {
  env,
  stdio: 'inherit'
});

child.on('exit', (code) => {
  console.log('Electron process exited with code ' + code);
  process.exit(code);
});
