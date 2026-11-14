import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA } from './schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');
export const DATA_DIR = path.join(ROOT, 'data');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
export const TRUTH_DIR = path.join(DATA_DIR, 'truth');

fs.mkdirSync(DATA_DIR, { recursive: true });

let instance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (instance) return instance;
  const file = process.env.TRACE_DB ?? path.join(DATA_DIR, 'trace.db');
  instance = new Database(file);
  instance.exec(SCHEMA);
  return instance;
}

export function resetDb(): Database.Database {
  if (instance) {
    instance.close();
    instance = null;
  }
  const file = process.env.TRACE_DB ?? path.join(DATA_DIR, 'trace.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
  }
  return getDb();
}
