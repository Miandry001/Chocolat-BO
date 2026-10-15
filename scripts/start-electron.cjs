// Lance Electron sans ELECTRON_RUN_AS_NODE : cette variable, héritée des terminaux
// VS Code/Cursor, fait tourner Electron comme un simple Node et casse require('electron').
const { spawn } = require('node:child_process');
const path = require('node:path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(require('electron'), [path.resolve(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
