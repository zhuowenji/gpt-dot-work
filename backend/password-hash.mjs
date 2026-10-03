// Pipe a secret from a trusted password manager or a no-echo shell prompt.
// This tool never accepts password arguments/environment and prints only a hash.
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
if (process.argv.length !== 2 || process.stdin.isTTY) {
  process.stderr.write('Provide the password on standard input through a secure no-echo prompt; arguments are not accepted.\n');
  process.exit(1);
}
const chunks = [];
let length = 0;
for await (const chunk of process.stdin) {
  chunks.push(chunk);
  length += chunk.length;
  if (length > 1026) { process.stderr.write('Password is too long.\n'); process.exit(1); }
}
// One terminal line ending from printf/read is allowed; internal newlines rejected.
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
if (Buffer.byteLength(password) < 16 || Buffer.byteLength(password) > 1024 || /[\r\n]/.test(password)) {
  process.stderr.write('Use a unique password of 16–1024 bytes without line breaks.\n'); process.exit(1);
}
const salt = randomBytes(32);
const hash = await promisify(scrypt)(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
process.stdout.write(`scrypt$32768$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}\n`);
