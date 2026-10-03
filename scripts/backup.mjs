import { DatabaseSync, backup } from 'node:sqlite';
import { realpath, stat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Consistent SQLite backup to a NEW path. Never overwrites an existing backup. */
export async function createBackup(source, destination) {
  if (!isAbsolute(source || '') || !isAbsolute(destination || '')) throw new Error('Use absolute source and destination paths');
  const from = await realpath(source);
  const parent = await realpath(dirname(destination));
  const to = resolve(destination);
  if (parent !== dirname(to)) throw new Error('Backup destination must not contain symlink directories');
  if (to === repository || to.startsWith(repository + sep)) throw new Error('Backups must be outside the source repository');
  if (from === to) throw new Error('Source and destination must differ');
  const directory = await stat(parent);
  if ((directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())) throw new Error('Backup directory must be owned by the current user and have mode 0700');
  const reserved = await open(to, 'wx', 0o600);
  await reserved.close();
  let sourceDb;
  try {
    sourceDb = new DatabaseSync(from, { readOnly: true });
    await backup(sourceDb, to);
    sourceDb.close(); sourceDb = null;
    const check = new DatabaseSync(to, { readOnly: true });
    let integrity;
    try { integrity = check.prepare('PRAGMA quick_check').all(); } finally { check.close(); }
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') throw new Error('Backup integrity check failed');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(to)) hash.update(chunk);
    const digest = hash.digest('hex');
    return { path: to, sha256: digest, bytes: (await stat(to)).size };
  } catch (error) {
    sourceDb?.close();
    await unlink(to).catch(() => {});
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await createBackup(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; }
}
