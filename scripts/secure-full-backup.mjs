// Encrypted D1 + R2 backup for a Sites Timelyo deployment.
// Keep the token file and snapshots outside Git. DPAPI binds them to this Windows user.
//   node scripts/secure-full-backup.mjs save-token --out C:\backups\token.dpapi
//   node scripts/secure-full-backup.mjs backup --url https://site.example --token-file C:\backups\token.dpapi --out C:\backups\snapshot
//   node scripts/secure-full-backup.mjs verify --in C:\backups\snapshot
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const command = args.shift();
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Expected ${name} VALUE`);
  return args[index + 1];
}
function outsideGit(value) {
  const path = resolve(value);
  if (path.toLowerCase().startsWith(root.toLowerCase() + sep)) throw new Error('Keep credentials and backups outside the source repository');
  return path;
}
function getMachineKey() {
  const keyPath = resolve(process.env.HOME || '~', '.timelyo_backup_key');
  if (existsSync(keyPath)) return readFileSync(keyPath);
  const newKey = randomBytes(32);
  writeFileSync(keyPath, newKey, { mode: 0o600 });
  return newKey;
}
function dpapi(mode, value) {
  if (process.platform === 'win32') {
    const method = mode === 'protect' ? 'Protect' : 'Unprotect';
    const script = [
      '$ErrorActionPreference = "Stop"', 'Add-Type -AssemblyName System.Security',
      '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
      `$out = [System.Security.Cryptography.ProtectedData]::${method}($data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
      '[Console]::Out.Write([Convert]::ToBase64String($out))',
    ].join('; ');
    return Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: value.toString('base64'), encoding: 'utf8', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
    }).trim(), 'base64');
  }
  const key = getMachineKey();
  if (mode === 'protect') {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(value), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]);
  } else {
    const iv = value.subarray(0, 12);
    const tag = value.subarray(12, 28);
    const enc = value.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function seal(bytes, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encrypted };
}
function open(bytes, key, iv, tag) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(bytes), decipher.final()]);
}
function recoverySecret(path) {
  const secret = dpapi('unprotect', Buffer.from(readFileSync(outsideGit(path), 'utf8'), 'base64'));
  if (secret.length !== 32) throw new Error('Invalid recovery key file');
  return secret;
}
function checkPortableDatabase(bytes) {
  const temp = mkdtempSync(join(tmpdir(), 'timelyo-restore-check-'));
  try {
    const restored = spawnSync(process.execPath, [join(root, 'scripts', 'secure-d1-backup.mjs'), 'backup', '--out', join(temp, 'database.dpapi')], {
      input: Buffer.concat([bytes, Buffer.from('\n')]), cwd: root, encoding: 'utf8', windowsHide: true,
    });
    if (restored.status !== 0) throw new Error(`Portable database restore check failed: ${restored.stderr.trim()}`);
    return JSON.parse(restored.stdout.trim()).counts;
  } finally {
    if (temp.startsWith(tmpdir())) rmSync(temp, { recursive: true, force: true });
  }
}
function validateSnapshot(path, recovery = null) {
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
  if (!['timelyo-full-backup-v1', 'timelyo-full-backup-v2'].includes(manifest.format) || !Array.isArray(manifest.files)) throw new Error('Invalid full backup manifest');
  let key;
  if (recovery) {
    if (!manifest.recovery) throw new Error('This backup lacks a portable recovery key');
    key = open(Buffer.from(manifest.recovery.encrypted, 'base64'), recovery, manifest.recovery.iv, manifest.recovery.tag);
  } else key = dpapi('unprotect', Buffer.from(manifest.wrappedKey, 'base64'));
  try {
    let counts;
    if (manifest.format === 'timelyo-full-backup-v2') {
      const plain = open(readFileSync(join(path, 'database.json.aes')), key, manifest.database.iv, manifest.database.tag);
      if (sha(plain) !== manifest.database.sha256) throw new Error('Portable database checksum mismatch');
      counts = checkPortableDatabase(plain);
      plain.fill(0);
    } else {
      const db = spawnSync(process.execPath, [join(root, 'scripts', 'secure-d1-backup.mjs'), 'verify', '--in', join(path, 'database.json.dpapi')], {
        cwd: root, encoding: 'utf8', windowsHide: true,
      });
      if (db.status !== 0) throw new Error(`Database restore check failed: ${db.stderr.trim()}`);
      counts = JSON.parse(db.stdout.trim()).counts;
    }
    for (const file of manifest.files) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(file.id) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid PDF manifest entry');
      const data = open(readFileSync(join(path, `${file.id}.pdf.dpapi`)), key, file.iv, file.tag);
      if (data.length !== file.bytes || sha(data) !== file.sha256 || data.subarray(0, 5).toString() !== '%PDF-') {
        throw new Error(`PDF restore check failed for ${file.id}`);
      }
      data.fill(0);
    }
    if (counts.pdf_files !== manifest.files.length) throw new Error('PDF object count does not match restored database');
    return { databaseTables: Object.keys(counts).length, pdfCount: manifest.files.length, pdfBytes: manifest.files.reduce((n, f) => n + f.bytes, 0), restore: 'memory-and-files-ok' };
  } finally { key.fill(0); }
}
async function fetchExport(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!response.ok) throw new Error(`Remote backup export returned HTTP ${response.status}`);
  return response;
}
async function main() {
  if (command === 'save-recovery-key') {
    const target = outsideGit(option('--out'));
    const secret = randomBytes(32);
    writeFileSync(target, dpapi('protect', secret).toString('base64'), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ recoveryKey: secret.toString('hex'), keyFile: target }));
    secret.fill(0);
  } else if (command === 'save-token') {
    const target = outsideGit(option('--out'));
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const chunks = [];
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const end = bytes.findIndex((n) => n === 10 || n === 13);
      chunks.push(end < 0 ? bytes : bytes.subarray(0, end));
      if (end >= 0) break;
    }
    const token = Buffer.concat(chunks);
    if (token.length < 32 || token.length > 256) throw new Error('Backup token must be 32-256 bytes');
    writeFileSync(target, dpapi('protect', token).toString('base64'), { flag: 'wx', mode: 0o600 });
    token.fill(0);
    console.log(JSON.stringify({ tokenFile: target, protection: 'Windows CurrentUser DPAPI' }));
  } else if (command === 'backup') {
    const site = new URL(option('--url'));
    const localTest = site.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(site.hostname);
    if ((!localTest && site.protocol !== 'https:') || site.username || site.password || site.search || site.hash || site.pathname !== '/') throw new Error('Expected HTTPS site origin');
    const target = outsideGit(option('--out'));
    const tokenPath = outsideGit(option('--token-file'));
    if (existsSync(target) || existsSync(`${target}.incomplete`)) throw new Error('Backup target already exists');
    const token = dpapi('unprotect', Buffer.from(readFileSync(tokenPath, 'utf8'), 'base64')).toString('utf8');
    const stage = `${target}.incomplete`;
    mkdirSync(stage);
    const dbResponse = await fetchExport(new URL('/api/backup-export', site), token);
    const dbBytes = Buffer.from(await dbResponse.arrayBuffer());
    if (dbBytes.length > 20 * 1024 * 1024) throw new Error('Database export exceeds expected size');
    const database = JSON.parse(dbBytes.toString('utf8'));
    const expectedTables = ['accounts','assignments','audit','lessons','local_credentials','login_attempts','plans','reschedule_requests','sessions','students','teachers','pdf_files','storage_quota','teaching_materials','material_recipients','homework','homework_recipients','homework_submissions','study_blocks'];
    if (['timelyo-d1-v2','timelyo-d1-v3','timelyo-d1-v4','timelyo-d1-v5','timelyo-d1-v6','timelyo-d1-v7'].includes(database.format)) expectedTables.push('classrooms','classroom_members','classroom_announcements');
    if (['timelyo-d1-v3','timelyo-d1-v4','timelyo-d1-v5','timelyo-d1-v6','timelyo-d1-v7'].includes(database.format)) expectedTables.push('google_identities');
    if (['timelyo-d1-v4','timelyo-d1-v5','timelyo-d1-v6','timelyo-d1-v7'].includes(database.format)) expectedTables.push('academic_terms');
    if (database.format === 'timelyo-d1-v7') expectedTables.push('notification_items','notification_deliveries','push_subscriptions','notification_runtime');
    if (!['timelyo-d1-v1','timelyo-d1-v2','timelyo-d1-v3','timelyo-d1-v4','timelyo-d1-v5','timelyo-d1-v6','timelyo-d1-v7'].includes(database.format) || JSON.stringify(Object.keys(database.tables || {}).sort()) !== JSON.stringify(expectedTables.sort())) {
      throw new Error(`Unexpected database export format=${String(database.format)} tables=${Object.keys(database.tables || {}).join(',')}`);
    }
    for (const name of expectedTables) {
      const table = database.tables[name];
      if (!Array.isArray(table?.columns) || !Array.isArray(table?.rows)) throw new Error(`Invalid export table structure: ${name}`);
      for (const row of table.rows) {
        const missing = table.columns.filter((column) => !Object.hasOwn(row, column));
        if (missing.length) throw new Error(`Incomplete export row: ${name} missing ${missing.join(',')}`);
      }
    }
    const fileRows = database?.tables?.pdf_files?.rows;
    if (!Array.isArray(fileRows)) throw new Error('Database export lacks PDF metadata');
    const recovery = args.includes('--recovery-file') ? recoverySecret(option('--recovery-file')) : null;
    const key = randomBytes(32);
    const manifest = { format: recovery ? 'timelyo-full-backup-v2' : 'timelyo-full-backup-v1', createdAt: new Date().toISOString(), site: site.origin,
      wrappedKey: dpapi('protect', key).toString('base64'), files: [] };
    try {
      if (recovery) {
        const wrapped = seal(key, recovery);
        manifest.recovery = { iv: wrapped.iv, tag: wrapped.tag, encrypted: wrapped.encrypted.toString('base64') };
        const sealedDatabase = seal(dbBytes, key);
        manifest.database = { iv: sealedDatabase.iv, tag: sealedDatabase.tag, sha256: sha(dbBytes) };
        writeFileSync(join(stage, 'database.json.aes'), sealedDatabase.encrypted, { flag: 'wx', mode: 0o600 });
        checkPortableDatabase(dbBytes);
      } else {
        const backedUp = spawnSync(process.execPath, [join(root, 'scripts', 'secure-d1-backup.mjs'), 'backup', '--out', join(stage, 'database.json.dpapi')], {
          input: Buffer.concat([dbBytes, Buffer.from('\n')]), cwd: root, encoding: 'utf8', windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        if (backedUp.status !== 0) throw new Error(`Database backup failed: ${backedUp.stderr.trim()}`);
      }
      dbBytes.fill(0);
      const seen = new Set();
      for (const row of fileRows) {
        const id = String(row.id);
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || seen.has(id)) throw new Error('Invalid or duplicate PDF ID');
        seen.add(id);
        const response = await fetchExport(new URL(`/api/backup-export?file=${encodeURIComponent(id)}`, site), token);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== Number(row.bytes) || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`PDF size or signature mismatch for ${id}`);
        const sealed = seal(bytes, key);
        writeFileSync(join(stage, `${id}.pdf.dpapi`), sealed.encrypted, { flag: 'wx', mode: 0o600 });
        manifest.files.push({ id, bytes: bytes.length, sha256: sha(bytes), iv: sealed.iv, tag: sealed.tag });
        bytes.fill(0);
      }
      writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    } finally { key.fill(0); }
    const result = validateSnapshot(stage);
    if (readdirSync(stage).length !== manifest.files.length + 2) throw new Error('Backup file count mismatch');
    if (recovery) {
      const recovered = validateSnapshot(stage, recovery);
      if (JSON.stringify(result) !== JSON.stringify(recovered)) throw new Error('Portable recovery differs from local recovery');
      recovery.fill(0);
    }
    renameSync(stage, target);
    console.log(JSON.stringify({ backup: target, ...result }));
  } else if (command === 'verify') {
    let recovery = args.includes('--recovery-file') ? recoverySecret(option('--recovery-file')) : null;
    if (args.includes('--recovery-key-stdin')) {
      const supplied = readFileSync(0, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/i.test(supplied)) throw new Error('Expected 64-character recovery key on stdin');
      recovery = Buffer.from(supplied, 'hex');
    }
    const result = validateSnapshot(outsideGit(option('--in')), recovery);
    if (recovery) recovery.fill(0);
    console.log(JSON.stringify({ backup: outsideGit(option('--in')), ...result }));
  } else throw new Error('Expected save-token, save-recovery-key, backup, or verify');
}
main().catch((error) => { console.error(`Full backup failed: ${error.message}`); process.exitCode = 1; });
