# 로컬 검색 속도 개선 (v1.7.7)

진단 근거: 2026-10-16 성능 진단(조사 4갈래 + 반박 검증). 프롬프트마다 도는 사실 주입 검색이 float32 사실 벡터 표 두 개(약 108MB)를
전수 비교하고, 그 페이지가 OS 캐시에서 밀려나면 첫 검색이 약 505ms(따뜻하면 25ms)다.

## Spec (목표/제약/용어)

- **목표**: 주입 검색의 콜드 첫 검색을 505ms → 100ms 이하로 줄이고, 시간이 지나도 다시 느려지지 않게 한다.
- **제약**
  - 결과가 바뀌는 변경(int8 배율)은 정확한 float32 대비 일치도를 측정해 근거로 남긴다.
  - 라이브 DB 변경은 백업 뒤에만 한다. 이전 코드가 새 형식을 잘못 읽는 창이 없어야 한다(이전 버전 프로세스가 DB를 열고 있으면 이행 거부).
  - 실패는 조용히 넘기지 않는다(fail-loud). 기존 테스트 전부 통과.
  - 공개 플러그인이다. 다른 사용자의 DB(이미 int8@127인 사실 표)는 그대로 읽혀야 한다.
- **용어**
  - *콜드 첫 검색*: 벡터 페이지가 OS 캐시에 없는 상태의 searchSimilarFacts 1회(새 APFS 클론에서 측정).
  - *채움률*: vec0 표의 유효 행 수 ÷ 할당 슬롯 수(청크 수 × 청크 크기).
  - *배율(scale)*: int8 양자화 계수. q = clamp(round(x × scale), −127, 127). 대화 표는 127 유지, 사실 표는 표별 기록값.

## Plan Summary

**Scope:** 7 tasks across ~16 files — complexity HIGH (라이브 DB 이행 포함)

**Key Deliverables:**
1. MCP `search` 지식 섹션이 캐시 연결을 재사용(쓰기 문장·새 연결 없음), 실패는 stderr 로 표면화
2. SessionStart 유지보수 탐침 실행 빈도 제한(스탬프 파일)
3. 훅이 Node ABI 불일치를 만나면 호환 node 를 찾아 재실행
4. 사실 벡터 표 빈 슬롯 압축(채움률 기준, 유지보수에서 자동)
5. int8 배율을 표별로 기록·사용(대화 127, 사실 600) + 이행 스크립트(백업·복원·이전 버전 프로세스 거부)
6. v1.7.7 릴리스(버전 4곳 + CHANGELOG + push + 플러그인 갱신)
7. 라이브 DB: 압축 → int8@600 이행 → VACUUM, 각 단계 실측

**Acceptance Criteria:**
- AC-001 지식 섹션은 다른 연결이 쓰기 락을 쥔 상태에서도 1초 안에 결과를 돌려준다.
  verify: `npx vitest run test/knowledge-graph.test.ts` → 새 테스트 'returns under a held write lock' 통과 / evidence: 테스트 이름
- AC-002 지식 섹션 실패는 stderr 에 기록된다(빈 catch 없음).
  verify: `npx vitest run test/search-perf-guards.test.ts` (정적 검사) / evidence: 테스트 이름
- AC-003 유지보수는 간격 안 재실행 시 탐침을 건너뛰고 그 사실을 stderr 에 남긴다. 간격은 env 로 조정.
  verify: `npx vitest run test/session-start-maintenance.test.ts` / evidence: 테스트 이름
- AC-004 ABI 오류 문구에서 필요한 ABI 를 읽고, 후보 중 맞는 node 를 고르며, 훅 7곳이 시작 시 검사를 호출한다.
  verify: `npx vitest run test/node-abi.test.ts` + 실기 재현 `/opt/homebrew/bin/node scripts/sync-export-hook.js` rc=0·ABI 오류 0 / evidence: 테스트 이름·명령 출력
- AC-005 압축은 id·벡터 바이트·형식·배율을 보존하고 KNN 결과가 동일하며 청크 수가 준다.
  verify: `npx vitest run test/vec-compact.test.ts` / evidence: 테스트 이름
- AC-006 int8 배율은 표별 기록값을 쓰고(기록 없음 = 127), 새 DB 의 사실 표는 1.7.6 과 같은 127(기록 없음)로 만들고 600 은 이행 스크립트만 기록한다(F10). 모든 읽기·쓰기 지점이 표별 코덱을 쓰고, 배율은 쓰기 트랜잭션(BEGIN IMMEDIATE) 안에서 읽는다(문자열 dtype 호출 0건).
  verify: `npx vitest run test/vec-quant.test.ts test/search-perf-guards.test.ts` / evidence: 테스트 이름
- AC-007 이행 스크립트: float32 → int8@600, 백업 파일 행 수·체크섬 검증, 복원 모드, 이전 버전 프로세스·미식별 프로세스가 DB 를 열고 있으면 거부.
  verify: `npx vitest run test/migrate-vec-facts-int8.test.ts` / evidence: 테스트 이름
- AC-008 `npm run build` rc=0, `npm test` 전체 통과.
  verify: 두 명령 / evidence: 저장소 밖 QA 로그 폴더(`mktemp -d`, 경로는 /tmp/mb-qa-dir.txt — 저장소에 `.qa-artifacts/` 무시 규칙이 없어 상태 지문 오염을 피함)
- AC-009 릴리스: package.json·plugin.json·marketplace.json 버전 1.7.7, CHANGELOG 항목, origin/main 에 push, 설치 캐시 1.7.7 디렉터리 존재·gitCommitSha 일치.
  verify: `git show HEAD:package.json` · `installed_plugins.json` 조회 / evidence: 명령 출력
- AC-010 라이브 압축 후 사실 표 행 수 불변(24,294 / 20,913), 청크 수 감소.
  verify: 라이브 읽기 전용 조회 / evidence: 명령 출력
- AC-011 라이브 int8@600 이행: 백업 검증, 세 표 int8, 배율 기록 600, 행 수 불변, 정확한 float32 대비 게이트 통과 집합 일치율 측정값 기록.
  verify: 이행 스크립트 출력 + 품질 비교 스크립트 / evidence: 출력 파일
- AC-012 VACUUM 후 integrity_check ok, 주요 표 행 수 불변, 새 클론에서 콜드 첫 검색 중앙값 측정(목표 ≤ 100ms).
  verify: 측정 스크립트 n=7 / evidence: 출력 파일
- AC-013 이행 뒤 실제 주입 로그(inject-context.jsonl)에 새 버전 행이 생기고 search_ms 가 기록된다.
  verify: 로그 tail / evidence: 로그 줄

**Steps:**
1. `src/db.ts` 표별 양자화 코덱(`getVecQuant`/`VecQuant`), `vec_int8_scale` 표(새 DB 사실 표는 127·기록 없음 — F10) → 호출부 전부 전환(fact-db·ontology-db·sync-import·reembed-worker·vec-compact, 전부 BEGIN IMMEDIATE 안에서 배율 읽기)
   (`src/fact-db.ts` `src/ontology-db.ts` `src/sync-import.ts` `src/search.ts` `src/repeat-detector.ts` `scripts/reembed-worker.js`). 검증: tsc + vec-quant 테스트.
2. `src/vec-compact.ts` 신규(채움률·압축) + `scripts/compact-vec-tables.mjs` 신규. 검증: vec-compact 테스트.
3. `scripts/migrate-vec-facts-int8.mjs` 재작성(배율·백업·복원·프로세스 가드). 검증: 이행 테스트.
4. `src/search.ts` getKnowledgeContext → getSearchDb + id 조회, `src/mcp-server.ts` 실패 stderr. 검증: knowledge-graph 테스트.
5. `scripts/session-start-maintenance.js` 스탬프 스로틀 + 압축 호출. 검증: 유지보수 테스트.
6. `src/node-abi.ts` 신규 + 훅 진입점 7곳 + `cli/mcp-server-wrapper.js` 자식 node 선택. 검증: node-abi 테스트 + 실기 재현.
7. 빌드·전체 테스트 → 구조 리뷰 → QA → 버전 1.7.7 커밋·push·플러그인 갱신 → 라이브 단계(압축 → 이행 → VACUUM) 실측.

**Risks / Stop rules**
- int8@600 이 정확한 float32 대비 게이트 통과 집합 일치가 float32 압축본(45/48)보다 크게 나쁘면(< 40/48) 이행하지 않고 float32 압축 상태로 멈춘다.
- 이행 가드가 이전 버전 프로세스를 찾으면 이행하지 않는다(실시간 적용이 끝날 때까지 재시도, 끝나지 않으면 보고).
- VACUUM 은 작업자 프로세스(재임베딩·추출·백필)가 없을 때만. 실패 시 SQLite 가 원자적으로 되돌린다.
- 디스크 여유 30GB 미만이면 VACUUM 중단.

## Open Questions
- [ ] 대화 색인 노이즈(Warmup·관찰자·워커 프롬프트) 분리 — 졸업 트리거: 사용자가 기본 검색에서 빼는 것을 승인
- [ ] 데몬 메모리 복제본 KNN — 졸업 트리거: int8+VACUUM 후에도 콜드 첫 검색이 100ms 를 넘을 때
- [ ] 탐침 쿼리 재작성 + 커버링 인덱스(라이브에 107MB·생성 중 쓰기 락) — 졸업 트리거: 스로틀 후에도 탐침이 캐시를 비우는 것이 측정될 때
- [ ] MCP 래퍼의 시작 실패 구조(npm install 이 잘못된 node 로 better-sqlite3 를 재빌드할 수 있음) — 졸업 트리거: 재빌드로 ABI 가 뒤바뀐 사례 관측

## Deviations

P3_SNAPSHOT: /tmp/mb-p3.zlQo/snapshot.json
- bench/profile.mjs 는 2026-07-11 대화 표 int8 이행 이후 float32 질의를 보내 이미 깨져 있다(이번 범위 밖). 정적 검사 test/search-perf-guards.test.ts 에 사유와 함께 예외로 둠.
- 구조 리뷰(파울러): 새 냄새 3 (수정 2 · 남김 1)
  - 수정 · Duplicated Code · 사실 벡터 표 목록·DDL 4곳 → `FACT_VEC_TABLES`·`factVecTableDdl`(src/db.ts) 로 통합 — refactor: Extract Function
  - 수정 · Long Function · scripts/session-start-maintenance.js main → `throttleReason` 추출 — refactor: Extract Function
  - 남김 · Duplicated Code(경미) · sqlite_master 존재 확인 SQL 4곳(src/db.ts·src/vec-compact.ts·scripts/migrate-vec-facts-int8.mjs) · 반환 형태(존재/DDL/건수)가 달라 공용 함수는 간접만 늘린다
- int8@600 라이브 이행 보류(중단 기준 발동): 라이브 복사본 48건 측정에서 정확한 float32 대비 게이트 통과 집합 일치 39/48(기준 40/48 미만). 상위 5건 겹침 0.963, 유사도 최대 차이 0.001, 게이트 통과 건수 202=202. 참고: float32 압축 45/48, int8@127 28/48. 콜드 첫 검색 중앙값(n=7, sqlite-vec 0.1.9 — 설치본과 같은 판): 현재 539.4 · 압축 403.2 · 압축+VACUUM 240.2 · int8@600 105.3ms(0.1.6 첫 측정 511.8/389.6/212.7/109.4 는 H3 로 대체). 라이브는 결과 불변인 압축+VACUUM 까지만 적용하고 int8 이행은 코드만 배포(사용자 결정 대기).
- 적대 검토 1차 FAIL(HIGH 5·MEDIUM 5) 반영: F1 사실 KNN 이 모든 예외를 []로 덮던 것 → 표 없음만 [], 나머지 throw(형식 교체 경합 1회 재시도) · F2/F6 복원을 교체 트랜잭션 안으로, 백업 뒤 다시 쓰인 벡터는 백업으로 되돌리지 않음 · F3 설치 플러그인 폴더 버전도 확인 · F5 엄격 인자(src/cli-args.ts) · F7 압축 문구를 "같은 거리, 동점 순서만" 으로(라이브 복사본 48건: 40 같음, 8 동점 순서, 그 외 0) · F8 교체 후 다시 읽은 바이트 해시 대조 + 동시 프로세스 실측(쓰기 대기 최대 2.2s, 오류 0) + 라이브 사실 벡터 JSONL 백업 · F9 동작 테스트 보강 · F10 새 DB 사실 표는 1.7.6 과 같은 127(기록 없음), 600 은 이행 스크립트만 기록 · L1/L2 유지보수 자기 점유만 해제·실패는 failed 로 기록하고 도장 안 찍음 · L5 쓰기 경로 배율을 트랜잭션 안에서 읽음 · H2 래퍼는 자식 프로세스로 ABI 확인 · H3 저장소 node_modules 를 설치본과 같은 sqlite-vec 0.1.9 / better-sqlite3 12.11.1 로 맞춰 재측정 · H5 재실행 30초 제한
- (2차 검토로 철회) ~~카테고리 검색은 예외 시 [] 유지~~ → N2 참조.
- 적대 검토 2차 BLOCK(매우 심각 2·높음 1·중간 4) 반영: T3 sync-import 가 사실 행과 벡터를 따로 커밋하고 배율을 트랜잭션 밖에서 읽던 것 → 임베딩을 먼저 만들고 행+벡터를 BEGIN IMMEDIATE 한 번에(실패 시 행도 남지 않아 다음 가져오기가 다시 들인다) · reembed-worker 사실 경로 2곳도 tx.immediate() (L-a) · T2 현재 작업 트리 테스트 로그를 QA 로그 폴더에 저장 · N1 이행 스크립트가 모드별 인자만 받음(`--restore --dry-run` 거부), 같은 인자 반복 거부(L-k) · N2 카테고리 검색은 표 없음만 [], 그 외 1회 재시도 후 throw — 분류기는 조회 실패를 기억했다가 복구 후에도 후보가 없으면 원인 담은 IndexRepairError(장부 소모 없음) · N3 압축은 표마다 실패를 결과로 돌려줌(앞서 교체한 표 기록 유지), 유지보수는 하위 단계 실패 시 partial + 도장 없음 · N4 ABI 재실행 실패·시간 초과를 주입 로그 error 행으로, 상한 25초(UserPromptSubmit 기본 30초 안에서 기록할 여유) · N5 실프로세스 동시 읽기·쓰기 테스트, `--restore --dry-run`·2번째 표 실패·지연 오픈 프로세스·상대 경로 백업 테스트, 유지보수 점유·부분 실패 테스트, 래퍼 실기 재현, 첫 사용 기준 가드 순서, 검색 재시도 분기 · L-c 이전 이행 스크립트 2개 엄격 인자 · L-e 머리 주석의 부분 교체 서술 · L-f 점유 회수는 pid 생존 확인 + 이름 바꾸기 후 inode 대조 · L-g package.json 없는 설치 폴더 차단 · L-h 백업 뒤 교체 직전 가드 재확인 + DB 를 아직 안 연 memory-bank 프로세스도 명령줄로 판정 · L-j 백업 헤더 DB 경로 정규화
- 적대 검토 3차 WARNING(매우 심각 0·높음 0·중간 2·낮음 19, 2차 지적 16건 중 12 해소·4 부분) 반영: NEW-1 부분 실패한 유지보수도 도장을 찍되 60분 뒤 재시도(영구 실패가 세션마다 44초 점검을 되살리지 않게) · NEW-2 README Configuration·CLAUDE.md 환경변수/모듈 표에 새 변수·모듈, require 예외(node-abi) 명시 · L1 주입 재실행 상한을 훅 시작 기준 남은 예산(30초 − 경과 − 3초)으로, 3초 미만이면 재실행 대신 error 기록 · L2 MCP 래퍼는 DB 를 열지 않으므로 프로세스 검사에서 제외(자식 서버는 검사) · L3 점 폴더(.live-apply.lock) 무시 · L4/L5 점유 회수 주석을 "좁힌다"로 정정, 2시간 넘은 점유는 pid 가 살아 있어도 재사용 pid 로 보고 회수 · L6 범위 제한 변수는 경로 경계로 비교하고 켜지면 이행 출력에 표시 · L7 insertFact/updateFact 자체를 행+벡터 한 트랜잭션으로(모든 호출자에 적용) · L8/L9 주석 정정(F10, 측정 원본 수치) · L10 CHANGELOG 표를 같은 두 지표(상위 5건 순서·게이트 집합)로 · L11 주입 훅 ABI 재실행 실기 재현 시험 · L13 색인 복구 실패 원인 문구 보존 · L14 백업 행과 검증 건수를 한 읽기 트랜잭션에서 · L17 searchAllFacts 도 factKnn 경유 · L18 간격·임계값 근거 주석(측정값/선택값 구분) · L19 sync-import 실패 건수 집계 + logs/sync-import.jsonl 기록. 검증: 전체 72파일 744건 rc=0. 변이 검사는 1차(mutation-r3.log) 5건 중 4건이 실패로 잡혔고 1건(insertfact-no-tx: `.immediate()`→`()`)은 살아남았다 — 지연 트랜잭션도 원자성은 같아 동등 변이였다. 트랜잭션 자체를 없앤 변이로 다시 돌려 '벡터 없는 행 남음(n:2)'으로 잡혔고, 1차에서 원인 줄이 비었던 partial-no-stamp 는 도장 없음(ENOENT) 단언으로 확인했다(mutation-r3b.log)
- 적대 검토 4차 WARNING(매우 심각 0·높음 0·중간 2·낮음 14) 반영: M1 주입 재실행 예산을 순수 함수 rerunBudgetMs 로 빼 단위 시험, 예산이 모자라면 error 줄을 남기는 경로를 실기 시험(MEMORY_BANK_INJECT_HOOK_BUDGET_MS — 훅 시간 제한을 바꾼 사용자용 설정이기도 함) · M2 위 변이 서술 정정 · LO1 도장 주석 정정+ISO 도장 시험 · LO2 claim mkdir 의 EEXIST 외 오류는 원인과 함께 failed · LO4 isInside 의 '..x' 하위 폴더 · LO7 heal 차단 원인 단언 · LO8 sync-import 실패 원인 최대 5건 기록·로그 1MB 회전 · LO9 영어 벡터 성공 후 한국어 벡터 실패 시 전체 롤백 시험 · LO10 측정 원본 perf-quality.jsonl 추가 · LO11 CHANGELOG 에 insertFact/updateFact 원자성 · LO13 지문은 최종 트리에서 다시 생성 · LO14 QA 통과 표시는 커밋 직전 생성
- 남김(4차): LO3 간격 검사 뒤 재확인 없음(창 매우 좁음, 결과는 점검 1회 중복) · LO5 가드는 숫자 이름이 아닌 설치 폴더도 막음(안전한 쪽) · LO6 시험용 범위 제한 변수는 경고 출력만
- 남김(3차): 래퍼 외 DB 를 열지 않는 다른 memory-bank 프로세스(편집기 등)는 여전히 판정 대상 — 차단은 안전한 쪽 · --db 로 사본을 지정해도 잠금·백업 기본 폴더는 라이브 인덱스 폴더(L15, 보수적) · AC-006 "트랜잭션 안에서 읽기"는 리뷰·변이 검사로 확인했고 정적 강제는 없음(L12) · 압축 게이트 집합 3건 차이가 동점 때문인지 건별 미확인(실험 DB 사본 삭제로 재측정 불가)
- 동시 압축 실측 원본(F8·CHANGELOG): 압축 2.36s 동안 검색 1,213건(최대 528ms) · 쓰기 243건(최대 대기 2,195ms) · 오류 0 · 벡터 없는 삽입 0 — 산출물 concurrency.txt 를 QA 로그 폴더에 복사
- 남김: ensureNativeAbi 재실행에는 시간 상한을 두지 않음(재실행이 곧 그 스크립트라 호출자의 상한이 그대로 적용, 고정 상한은 긴 CLI 작업을 끊음) · 이행 뒤 ≤1.7.6 재설치는 막을 수 없음(--restore 후 다운그레이드 — 스크립트 머리 주석) · 느슨한 인자 파싱이 남은 기존 스크립트(purge-llm-sessions·migrate-normalize-facts·backfill 워커·reembed-worker 옵션) — 이번 변경 범위 밖, 후속 제안
- 남김(LOW): L6 이행 잠금 회수 경합(기존 패턴), H1 개발 체크아웃에서 빌드 전 버전만 올린 경우 가드 판정 — 수동 스크립트 범위
