#!/usr/bin/env node
// Codex 적대 리뷰 3건 수정의 exploit-재현 검증
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs'; import path from 'path'; import os from 'os';
import { execFileSync } from 'child_process';
const REPO = '/Users/jung-wankim/Project/Claude/memory-bank';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-fix-'));
let pass = 0, fail = 0;
const check = (name, ok) => { console.log((ok?'✅':'❌'), name); ok?pass++:fail++; };

// === Fix3 (MEDIUM): dtype는 sqlite_master 실스키마에서 파생 ===
{
  process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 'dtype.sqlite');
  const { initDatabase, getVecQuant } = await import(REPO + '/dist/db.js');
  const db = initDatabase(); // fresh → int8
  check('fresh DB → int8 (flag 없이 스키마 파생)', getVecQuant(db, 'vec_exchanges').dtype === 'int8');
  db.close();
  // 레거시 float 테이블 시뮬레이션
  const p2 = path.join(tmp, 'legacy.sqlite');
  const raw = new Database(p2); sqliteVec.load(raw);
  raw.exec('CREATE VIRTUAL TABLE vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])');
  raw.close();
  process.env.MEMORY_BANK_DB_PATH = p2;
  const db2 = initDatabase(); // 기존 float 테이블 → IF NOT EXISTS 스킵
  check('레거시 float 테이블 → float32 감지 (스키마 보존)', getVecQuant(db2, 'vec_exchanges').dtype === 'float32');
  db2.close();
}

// === Fix2 (HIGH): 연결 캐시가 파일 교체를 감지 ===
{
  const p = path.join(tmp, 'cache.sqlite');
  process.env.MEMORY_BANK_DB_PATH = p;
  const { searchConversations } = await import(REPO + '/dist/search.js');
  const { initDatabase, insertExchange } = await import(REPO + '/dist/db.js');
  const mk = (id, msg) => ({ id, project:'t', timestamp:new Date().toISOString(), userMessage:msg, assistantMessage:'a', archivePath:'/tmp/x.jsonl', lineStart:1, lineEnd:2 });
  const emb = Array(384).fill(0.05);
  let db = initDatabase(); insertExchange(db, mk('old1','OLDROW unique marker'), emb); db.close();
  const r1 = await searchConversations('OLDROW', { limit: 5, mode: 'text' });
  // 파일 교체 (unlink + 재생성, 다른 내용)
  fs.unlinkSync(p); try{fs.unlinkSync(p+'-wal')}catch{} try{fs.unlinkSync(p+'-shm')}catch{}
  db = initDatabase(); insertExchange(db, mk('new1','NEWROW unique marker'), emb); db.close();
  const r2old = await searchConversations('OLDROW', { limit: 5, mode: 'text' });
  const r2new = await searchConversations('NEWROW', { limit: 5, mode: 'text' });
  check('교체 전 검색 동작', r1.length === 1);
  check('파일 교체 후 삭제행 미반환 (stale 핸들 아님)', r2old.length === 0);
  check('파일 교체 후 신규행 검색됨', r2new.length === 1);
}

// === Fix1 (CRITICAL) + R2-HIGH: 마이그레이션 레이스 (삽입/삭제/업데이트) 보존 ===
{
  const p = path.join(tmp, 'migr.sqlite');
  const raw = new Database(p); sqliteVec.load(raw);
  raw.exec('CREATE VIRTUAL TABLE vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])');
  raw.exec(`CREATE TABLE exchanges (id TEXT PRIMARY KEY, last_indexed INTEGER)`);
  const insV = raw.prepare('INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)');
  const insE = raw.prepare('INSERT INTO exchanges(id, last_indexed) VALUES (?, ?)');
  const femb = (v) => Buffer.from(new Float32Array(Array(384).fill(v)).buffer);
  const past = Date.now() - 3600_000;
  for (let i = 0; i < 10; i++) { insV.run('row'+i, femb(0.01*(i+1))); insE.run('row'+i, past); }
  raw.close();

  const { migrateVecInt8 } = await import(REPO + '/scripts/migrate-vec-int8.mjs');
  const res = await migrateVecInt8(p, {
    log: () => {},
    onBeforeSwap: (db) => {
      // 스크래치 빌드와 스왑 사이의 레이스 시뮬레이션 (실코드 경로):
      // 삽입 + 삭제 + 같은 id 벡터 업데이트(재인덱스: last_indexed 갱신)
      db.prepare('INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)').run('raced-new', femb(0.5));
      db.prepare('INSERT INTO exchanges(id, last_indexed) VALUES (?, ?)').run('raced-new', Date.now());
      db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run('row3');
      db.prepare('DELETE FROM exchanges WHERE id = ?').run('row3');
      db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run('row0');
      db.prepare('INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)').run('row0', femb(0.5));
      db.prepare('UPDATE exchanges SET last_indexed = ? WHERE id = ?').run(Date.now(), 'row0');
    },
  });
  const v = new Database(p); sqliteVec.load(v);
  const ids = v.prepare('SELECT id FROM vec_exchanges').all().map(r=>r.id);
  const sql = v.prepare(`SELECT sql FROM sqlite_master WHERE name='vec_exchanges'`).get().sql;
  check('마이그레이션 성공 (int8 스키마)', res.migrated && /int8\s*\[/i.test(sql));
  check('레이스 유입 행 보존 (raced-new)', ids.includes('raced-new'));
  check('레이스 삭제 행 제거 반영 (row3 없음)', !ids.includes('row3'));
  check('행 수 정합 (10 -1 +1 = 10)', ids.length === 10);
  // 업데이트 반영: row0 벡터가 새 값(0.5*127=64)으로 재양자화됐는지
  const row0 = v.prepare('SELECT embedding FROM vec_exchanges WHERE id = ?').get('row0');
  const i8 = new Int8Array(row0.embedding.buffer, row0.embedding.byteOffset, 384);
  check('레이스 벡터 업데이트 재양자화 (row0=64, 구값 1 아님)', i8[0] === 64);
  v.close();
}

// === R2-CRITICAL: env 기반 SQL 주입 훅 제거 확인 ===
{
  const src = fs.readFileSync(REPO + '/scripts/migrate-vec-int8.mjs', 'utf-8');
  check('MIGRATE_TEST_INJECT_SQL env 백도어 없음', !src.includes('MIGRATE_TEST_INJECT_SQL'));
  check('env 경유 임의 SQL exec 없음', !/process\.env\.[A-Z_]+\s*\)?\s*;?\s*$/m.test(src.split('\n').filter(l=>l.includes('db.exec(process.env')).join('')) && !src.includes('db.exec(process.env'));
}

// === R3-CRITICAL: insertExchange 원자성 (부분 상태 관측 불가) ===
{
  const p3 = path.join(tmp, 'atomic.sqlite');
  process.env.MEMORY_BANK_DB_PATH = p3;
  const { initDatabase, insertExchange } = await import(REPO + '/dist/db.js');
  const db = initDatabase();
  const emb = Array(384).fill(0.1);
  const mk = (id) => ({ id, project:'t', timestamp:new Date().toISOString(), userMessage:'u', assistantMessage:'a', archivePath:'/tmp/x.jsonl', lineStart:1, lineEnd:2 });
  // vec 쓰기를 강제로 실패시킴 (vec 테이블 제거) → exchanges 행도 남으면 안 됨
  db.exec('DROP TABLE vec_exchanges');
  let threw = false;
  try { insertExchange(db, mk('atomic1'), emb); } catch { threw = true; }
  const exRow = db.prepare("SELECT 1 FROM exchanges WHERE id='atomic1'").get();
  check('vec 실패 시 예외 발생 (silent 아님)', threw);
  check('vec 실패 시 exchanges 행도 롤백 (부분 상태 없음)', exRow === undefined);
  db.close();
}

// === R3-HIGH: reembed-worker가 마이그레이션 진행 중 양보 ===
{
  const src = fs.readFileSync(REPO + '/scripts/reembed-worker.js', 'utf-8');
  check('reembed: migrate 락 확인(migrationActive) 존재', src.includes('migrationActive') && src.includes('migrate-vec-int8.lock'));
  check('reembed: dtype 읽기가 트랜잭션 내부', /db\.transaction\(\(\) => \{\s*\n\s*const vecQuant = getVecQuant\(db, 'vec_exchanges'\)/.test(src));
  const msrc = fs.readFileSync(REPO + '/scripts/migrate-vec-int8.mjs', 'utf-8');
  check('migration: reembed 락 생존 확인 후 거부', msrc.includes('REEMBED_LOCK') && msrc.includes('pidAlive(REEMBED_LOCK)'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
