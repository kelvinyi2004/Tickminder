// Back up a bounded Sites D1 export without writing plaintext to disk.
// Windows DPAPI protects a random AES-256-GCM key for the current Windows user.
// Usage: stream a trusted in-memory export to `backup --out PATH` on stdin.
//        node scripts/secure-d1-backup.mjs verify --in C:\\...\\snapshot.json.dpapi
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const command = process.argv[2];
const option = process.argv[3];
const target = process.argv[4];
const baseTables = [
  'accounts', 'assignments', 'audit', 'lessons', 'local_credentials',
  'login_attempts', 'plans', 'reschedule_requests', 'sessions', 'students', 'teachers',
  'pdf_files', 'storage_quota', 'teaching_materials', 'material_recipients',
  'homework', 'homework_recipients', 'homework_submissions', 'study_blocks',
];
const classroomTables = ['classrooms', 'classroom_members', 'classroom_announcements'];
const baseMigrations = ['0000', '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009'];
const projectRoot = resolve(import.meta.dirname, '..').toLowerCase();

function targetPath(flag) {
  if (option !== flag || !target) throw new Error(`Expected ${flag} PATH`);
  const resolved = resolve(target);
  if (resolved.toLowerCase().startsWith(projectRoot + sep)) {
    throw new Error('Database backups must remain outside the source repository');
  }
  return resolved;
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
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      '$inputText = [Console]::In.ReadToEnd().Trim()',
      '$bytes = [Convert]::FromBase64String($inputText)',
      `$result = [System.Security.Cryptography.ProtectedData]::${method}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
      '[Console]::Out.Write([Convert]::ToBase64String($result))',
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

function validateExport(data) {
  const expectedTables = data?.format === 'timelyo-d1-v8'
    ? [...baseTables, ...classroomTables, 'google_identities', 'academic_terms', 'notification_items', 'notification_deliveries', 'push_subscriptions', 'notification_runtime', 'ai_jobs', 'ai_job_events']
    : data?.format === 'timelyo-d1-v7'
    ? [...baseTables, ...classroomTables, 'google_identities', 'academic_terms', 'notification_items', 'notification_deliveries', 'push_subscriptions', 'notification_runtime']
    : ['timelyo-d1-v4', 'timelyo-d1-v5', 'timelyo-d1-v6'].includes(data?.format)
    ? [...baseTables, ...classroomTables, 'google_identities', 'academic_terms']
    : data?.format === 'timelyo-d1-v3'
    ? [...baseTables, ...classroomTables, 'google_identities']
    : data?.format === 'timelyo-d1-v2'
    ? [...baseTables, ...classroomTables]
    : baseTables;
  if (!data || !['timelyo-d1-v1', 'timelyo-d1-v2', 'timelyo-d1-v3', 'timelyo-d1-v4', 'timelyo-d1-v5', 'timelyo-d1-v6', 'timelyo-d1-v7', 'timelyo-d1-v8'].includes(data.format) || !data.tables ||
      Object.keys(data.tables).sort().join('|') !== expectedTables.slice().sort().join('|')) {
    throw new Error('Incomplete database export');
  }
  for (const name of expectedTables) {
    const table = data.tables[name];
    if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) throw new Error(`Invalid ${name} table`);
    for (const row of table.rows) {
      if (table.columns.some((column) => !Object.hasOwn(row, column))) throw new Error(`Incomplete ${name} row`);
    }
  }
  return expectedTables;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function restoreInMemory(data) {
  const expectedTables = validateExport(data);
  const db = new DatabaseSync(':memory:');
  try {
    for (const prefix of [
      ...baseMigrations,
      ...(data.format !== 'timelyo-d1-v1' ? ['0010'] : []),
      ...(['timelyo-d1-v3', 'timelyo-d1-v4', 'timelyo-d1-v5', 'timelyo-d1-v6', 'timelyo-d1-v7', 'timelyo-d1-v8'].includes(data.format) ? ['0011'] : []),
      ...(['timelyo-d1-v4', 'timelyo-d1-v5', 'timelyo-d1-v6', 'timelyo-d1-v7', 'timelyo-d1-v8'].includes(data.format) ? ['0012'] : []),
      ...(['timelyo-d1-v5', 'timelyo-d1-v6', 'timelyo-d1-v7', 'timelyo-d1-v8'].includes(data.format) ? ['0013'] : []),
      ...(['timelyo-d1-v6', 'timelyo-d1-v7', 'timelyo-d1-v8'].includes(data.format) ? ['0014'] : []),
      ...(data.format === 'timelyo-d1-v8' ? ['0015', '0016'] : data.format === 'timelyo-d1-v7' ? ['0015'] : []),
    ]) {
      const file = readdirSync(resolve(projectRoot, 'drizzle')).find((name) => name.startsWith(prefix + '_') && name.endsWith('.sql'));
      if (!file) throw new Error(`Missing migration ${prefix}`);
      db.exec(readFileSync(resolve(projectRoot, 'drizzle', file), 'utf8'));
    }
    db.exec('BEGIN');
    try {
      for (const name of expectedTables) {
        const { columns, rows } = data.tables[name];
        const dbColumns = db.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name);
        if (columns.slice().sort().join('|') !== dbColumns.slice().sort().join('|')) {
          throw new Error(`Schema mismatch for ${name}`);
        }
        const names = columns.map((column) => `"${column}"`).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const insert = db.prepare(`INSERT INTO "${name}" (${names}) VALUES (${placeholders})`);
        for (const row of rows) insert.run(...columns.map((column) => row[column]));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    for (const name of expectedTables) {
      const count = db.prepare(`SELECT count(*) AS count FROM "${name}"`).get().count;
      if (count !== data.tables[name].rows.length) throw new Error(`Restore count mismatch for ${name}`);
      const { columns, rows } = data.tables[name];
      const encode = (row) => JSON.stringify(columns.map((column) => row[column]));
      const original = rows.map(encode).sort();
      const restored = db.prepare(`SELECT * FROM "${name}"`).all().map(encode).sort();
      if (JSON.stringify(original) !== JSON.stringify(restored)) throw new Error(`Restore content mismatch for ${name}`);
    }
    if (data.format === 'timelyo-d1-v1') {
      const releaseMigration = readdirSync(resolve(projectRoot, 'drizzle')).find((name) => name.startsWith('0010_') && name.endsWith('.sql'));
      if (releaseMigration) db.exec(readFileSync(resolve(projectRoot, 'drizzle', releaseMigration), 'utf8'));
    }
    for (const name of expectedTables) {
      const count = db.prepare(`SELECT count(*) AS count FROM "${name}"`).get().count;
      if (count !== data.tables[name].rows.length) throw new Error(`Migration changed ${name} rows`);
    }
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error('SQLite integrity check failed');
    const counts = Object.fromEntries(expectedTables.map((name) => [name, data.tables[name].rows.length]));
    return counts;
  } finally { db.close(); }
}

async function readPayloadLine() {
  // Unified terminal sessions keep stdin open. Raw mode prevents the terminal
  // from echoing the private database export into command output.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const newline = bytes.indexOf(10);
    const carriageReturn = bytes.indexOf(13);
    const end = newline < 0 ? carriageReturn : carriageReturn < 0 ? newline : Math.min(newline, carriageReturn);
    chunks.push(end >= 0 ? bytes.subarray(0, end) : bytes);
    size += chunks.at(-1).length;
    if (size > 20 * 1024 * 1024) throw new Error('Export exceeds expected size');
    if (end >= 0) break;
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  return Buffer.concat(chunks);
}

try {
  if (command === 'backup') {
    const output = targetPath('--out');
    const plain = await readPayloadLine();
    const parsed = JSON.parse(plain.toString('utf8'));
    validateExport(parsed);
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const document = {
      format: 'timelyo-d1-dpapi-v1',
      createdAt: new Date().toISOString(),
      algorithm: 'AES-256-GCM',
      keyScope: 'Windows CurrentUser DPAPI',
      wrappedKey: dpapi('protect', key).toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: encrypted.toString('base64'),
    };
    key.fill(0);
    writeFileSync(output, JSON.stringify(document), { flag: 'wx', mode: 0o600 });
    const counts = restoreInMemory(parsed);
    console.log(JSON.stringify({ output, encryptedSha256: sha256(readFileSync(output)), counts, restore: 'memory-ok' }));
    plain.fill(0);
  } else if (command === 'verify') {
    const input = targetPath('--in');
    const document = JSON.parse(readFileSync(input, 'utf8'));
    if (document.format !== 'timelyo-d1-dpapi-v1') throw new Error('Unrecognized backup format');
    const key = dpapi('unprotect', Buffer.from(document.wrappedKey, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(document.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(document.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(document.ciphertext, 'base64')), decipher.final()]);
    key.fill(0);
    const counts = restoreInMemory(JSON.parse(plain.toString('utf8')));
    plain.fill(0);
    console.log(JSON.stringify({ input, encryptedSha256: sha256(readFileSync(input)), counts, restore: 'memory-ok' }));
  } else { throw new Error('Expected backup or verify command'); }
} catch (error) {
  console.error(`Backup operation failed: ${error.message}`);
  process.exitCode = 1;
}
