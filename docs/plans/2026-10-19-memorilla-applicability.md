# Memorilla(arXiv 2610.21375) 적용 — 주입 재생 판정 하네스와 그 판정으로 정하는 주입 변경

작성: 2026-10-19 · 분류: `feature`(측정 하네스 신설 + 판정에 따른 조건부 주입 변경) · 대상 저장소: memory-bank
(클라우드 쪽 C5 는 별도 저장소의 계획서에서 다룬다)

## 배경 — 논문에서 옮길 수 있는 것과 없는 것

논문은 Qwen3-Embedding-4B 로 청크를 한 번 임베딩한다. 그다음 질의로 먼저 조건화한 학습 슬롯 K=16 이
cross-attention 2블록으로 저장소 전체를 읽고, 그 결과를 Qwen3-8B 입력 앞에 소프트 토큰으로 붙인다.
Claude 는 닫힌 API 라 소프트 토큰·학습은 옮길 수 없다. 텍스트 주입으로 옮길 수 있는 교훈은 다음과 같다.

- 질의를 본 뒤에 고른다. 질의 무관 풀링은 31.10~34.72, 질의 조건 선택은 43.34~44.04 였다(E.1).
- 관련 없는 문맥은 공짜가 아니다. 전체 문맥은 21개 지표 중 20개에서 Memorilla 보다 낮았고,
  RAG-50 이 전체 문맥을 15개 지표에서 이겼다(M3).
- 평가 없이 넣는 기억은 기억 없음보다 나쁠 수 있다. 학습 안 한 기억 0.153 이 기억 없음 0.186 보다 낮았다(§6.2).
- 기억이 쓰이는지는 노이즈 대조군과의 차이로 판정한다. 문서를 가우시안 노이즈로 바꾸면 기억을 쓰는 모델은
  −5.93 떨어지고, 기억을 안 쓰는 모델은 +0.04 로 변화가 없었다(M12).
- 기준선이 틀리는 하드 부분집합에서는 순위가 뒤집힌다(M13).

후보 7개를 설계한 뒤 독립 반박 검증을 거쳤다. 결과는 유지 0, 수정 후 진행 6(C1~C6), 폐기 1(C7)이다.
공통 결함은 효과 추정에 쓴 재생 표본이었다. 훅을 거치지 않는 합성 턴(스킬 본문·컴팩션 요약·세션 간 메시지)이
대부분이었고, 미래 사실이 13% 섞였고, 같은 자동화 프롬프트 반복이 운영 지표를 부풀렸다. 그래서 이 계획은
**측정 하네스(C1)를 먼저 바로 세우고, 그 판정으로 C2·C3 를 채택할지 정한다.** C4 는 측정만, C6 은 관측만,
C7 은 폐기다.

계획 근거로 잰 값(라이브 DB 와 로그는 읽기 전용, 실행 전후 mtime·크기 동일):
- 운영 로그 `inject-context.jsonl` 16,589줄(2026-07-06~10-19)을 exchanges 와 맞췄다.
  조건은 같은 cwd, 같은 길이, ±180초다. 일치 1,225건 가운데 작업 알림이 860건이고(현행 게이트가 건너뜀),
  현행 게이트를 통과하는 서로 다른 프롬프트는 **303개**(프로젝트 42개)다.
- 그 303개 중 2,000자 초과는 12개뿐이다. C7 의 전제(긴 프롬프트 다수)가 성립하지 않는다.
- 로그 행의 절반가량은 exchanges 에 행이 없다(색인되지 않는 자동화 세션). 이 하네스는 그런 행을 재생하지 않는다(한계).

## Spec (목표/제약/용어)

**목표**: 프롬프트별 사실 주입이 실제로 쓸모 있는 줄을 싣는지 잴 수 있게 하고(재생 + LLM 판정 + 무작위 대조군),
그 판정으로 관계 이웃 게이트(C3)와 저장소 가족 scope(C2)를 채택하거나 버린다. SessionStart 블록과 주입 결정은
로그로 관측되게 한다.

**제약**
- 라이브 DB(`~/.config/superpowers/conversation-index/db.sqlite`, 10.5GB)는 읽기 전용으로만 연다.
  스키마 변경·이행은 이번 범위가 아니다(C4 의 facts FTS 는 판정이 유지여도 사용자 결정 뒤 후속).
- 판정 LLM 호출은 `src/llm.ts` 의 격리 호출(`callHaiku` → `ISOLATED_QUERY_OPTIONS`, memory-bank-llm 작업 폴더)로만 한다.
  raw `claude -p` 금지다. 09-28~10-07 에 채점 세션 42개가 exchanges 에 색인된 전례가 있다.
- 재생 데이터(프롬프트 원문·사실 원문)는 gitignore 폴더 `.bench-out/` 에만 둔다. 커밋하는 판정 문서에는 집계 수치만 싣는다.
- 기본 동작 보존: 판정 전 운영 기본값은 현행(관계 게이트 없음, scope 완전 일치)이다. 판정이 유지일 때만 바꾼다.
- 주입 경로 지연: 로그 필드 추가는 직렬화 수준이어야 한다. 관계 게이트는 seed 당 점조회 30회 상한이다.
- 기존 계약: inject-log 는 최선 노력(throw 금지), 원장 기록은 전달한 쪽의 책임, int8 거리는 `normalizeVecDistance` 를 거친다.
- 사전 등록: 아래 판정 규칙·유효성 기준은 하네스를 돌리기 전에 이 문서에 고정한다.
  돌린 뒤에 고치면 Deviations 에 이유와 함께 적고, 고친 규칙으로 낸 판정은 "사후 규칙"으로 표시한다.

**용어**: 아래 Domain Glossary.

## Plan Summary

**Scope:** 11 tasks · 약 14 files(new 8) — complexity HIGH(측정 설계 + 조건부 운영 변경 + 릴리스)

**Key Deliverables:**
1. `src/inject-select.ts` — 주입 선택 파이프라인을 운영(`computeInjectResult`)과 벤치가 함께 쓰는 함수로 추출(동작 불변)
2. 주입 로그 필드: `gated_ids`·`injected_ids`·`top_margins`·`session_key`·`plugin_version`
   (게이트가 켜졌을 때만 `rel_gated_out`·`rel_unscored`)
3. SessionStart 블록 로그 한 줄(`via:'session-start'`)
4. 관계 이웃 질의 게이트 옵션(`relMargin`)과 저장소 가족 scope 옵션(`scopeFamily`) — 기본 꺼짐
5. `bench/inject-replay.mjs`·`bench/inject-judge.mjs`·`bench/inject-bench-lib.mjs` — 재생·판정·대조군·부트스트랩·사전 등록 판정
6. `docs/bench/2026-10-19-inject-replay.md` — 판정 결과(집계만)
7. 판정에 따른 운영 기본값(`PRODUCTION_SELECT_OPTIONS`)과 v1.7.8 릴리스

**Domain Glossary**

| Term | Definition | Usage |
|---|---|---|
| 줄(line) | 주입 블록에 실리는 사실 한 줄. 원장 dedup 전, 블록 1,000자 예산 적용 후 | `SelectedLine` |
| margin | `sim(query, fact) − baseline(query)`. 현행 게이트는 ≥ 0.045 | `topMargins`, `relMargin` |
| seed / 이웃 | seed 는 벡터 게이트를 통과한 사실, 이웃은 seed 의 1-hop 관계 사실 | `origin: 'vec' \| 'rel'` |
| 변형(variant) | 선택 옵션 묶음. v0=현행 | `v0`, `rel020`, `rel030`, `rel045`, `family`, `kw` |
| as-of 필터 | 재생 시점 기준 가시성. 프롬프트 시각 이후 생성 사실·같은 세션 exchange 에서 나온 사실·이후 생성 관계 제외 | `visibleFactId`, `visibleRelation` |
| 판정 점수 | 0 무관 / 1 배경(같은 주제지만 이 메시지에 불필요) / 2 이 메시지에 직접 쓸모 | `score` |
| 대조군 | 같은 scope 무작위 사실 3개 + 다른 프로젝트 무작위 사실 3개. 판정기 오탐률 측정용 | `control_same`, `control_other` |
| 하드 부분집합 | v0 가 0줄인 프롬프트 | `hard` |
| 저장소 가족 | cwd 의 git 최상위와 주 worktree 루트, 그 하위 경로 전체 | `resolveRepoRoots`, `scopeMatcher` |
| session_key | `sha256(session_id)` 앞 12자 | 로그 필드 |

## Program Design

```
src/inject-select.ts        (new)  선택 파이프라인 — computeInjectResult 와 bench 공용
src/project-family.ts       (new)  저장소 가족 루트 해석(fs 기반, git 프로세스 없음) + scope 술어
src/inject-core.ts          (mod)  selectInjectFacts·formatInjectBlock 호출, 로그 필드
src/inject-log.ts           (mod)  InjectLogEntry 필드·via 'session-start'
src/fact-db.ts              (mod)  searchSimilarFacts(..., opts?) — inScope·visibleId
src/ontology-db.ts          (mod)  getRelatedFacts(..., opts?) — inScope·visibleRelation
scripts/fact-consolidate-hook.js (mod) SessionStart 로그 한 줄
bench/inject-bench-lib.mjs  (new)  순수 함수: 표본 필터·as-of 술어·분할·kw 레인·판정 응답 검증·부트스트랩·유효성·판정 규칙
bench/inject-replay.mjs     (new)  --build(표본+스냅샷) · --replay · --check-determinism
bench/inject-judge.mjs      (new)  --judge(격리 LLM, 쌍 캐시) · --report(지표·CI·유효성·판정, 문서 생성)
test/inject-select.test.ts, test/project-family.test.ts, test/inject-bench-lib.test.ts (new)
```

```ts
// src/inject-select.ts
export const TOP_K = 5, BASELINE_MARGIN = 0.045, MAX_CONTEXT_FACTS = 8, BLOCK_CHAR_BUDGET = 1000;
export const REL_SCORE_CAP = 30;               // seed 당 점수를 매길 이웃 상한
export interface InjectSelectOptions {
  relMargin: number | null;                     // null = 이웃 게이트 없음(현행)
  scopeFamily: boolean;                         // false = scope 완전 일치(현행)
  visibleFactId?: (id: string) => boolean;      // 벤치 전용 as-of
  visibleRelation?: (r: OntologyRelation) => boolean;
}
export const PRODUCTION_SELECT_OPTIONS: InjectSelectOptions; // 판정 문서가 정한 값
export interface SelectedLine { fact: Fact; note: string; origin: 'vec' | 'rel'; margin: number | null }
export interface InjectSelection {
  candidates: number; topMargins: number[];
  gated: Array<{ fact: Fact; margin: number }>;
  lines: SelectedLine[];                        // 원장 dedup 전, MAX_CONTEXT_FACTS 이하
  relGatedOut: number; relUnscored: number;
  timings: { search_ms: number; related_ms: number };
}
export function selectInjectFacts(db, embedding: number[], baseline: number, project: string, opts: InjectSelectOptions): InjectSelection;
export function neighbourMargin(db, factId: string, embedding: number[], baseline: number): number | null; // min(EN,KR) 정규화 거리
export function formatInjectBlock(items: Array<{ fact: Fact; note: string }>): { lines: string[]; shown: number };
// src/project-family.ts
export function resolveRepoRoots(cwd: string): string[];   // [] = 가족 없음
export function scopeMatcher(project: string | null, family: boolean): (scopeProject: string | null) => boolean;
```

냄새 점검(파울러): computeInjectResult 는 지금 236줄 함수 하나에 선택·형식·로그가 섞인 Long Function 이다.
선택을 Extract Function 으로 떼어 벤치가 같은 코드를 쓰게 한다(Duplicated Code 예방 — 벤치에 파이프라인을 다시 쓰지 않는다).
옵션 객체는 Long Parameter List 대신 Introduce Parameter Object 다. 가족 scope 술어는 searchSimilarFacts·getRelatedFacts·벤치가
한 함수(`scopeMatcher`)를 공유한다. 같은 판정을 두 술어로 구현하면 갈라진다(ephemeral-state 부록 2).
남기는 냄새: searchSimilarFacts 와 searchSimilarFactsSameScope 의 KNN 병합 중복은 이번 범위 밖이라 그대로 둔다(이유: 동작 불변 리팩터를 섞지 않음).

## 사전 등록 — 유효성 기준과 판정 규칙 (하네스 실행 전 고정)

**표본**: 위 303개 중 as-of 필터 뒤 남는 것. 분할은 `sha256(query)` 첫 바이트 짝수 → train, 홀수 → held-out.

**유효성(하나라도 어기면 판정 문서의 결론은 "무효", 모든 후보는 현행 유지)**
- V1 같은 scope 무작위 대조군의 판정 2 비율 ≤ 10%
- V2 다른 프로젝트 무작위 대조군의 판정 2 비율 ≤ 5%
- V3 같은 (프롬프트, 사실) 쌍 재채점 일치율 ≥ 85%. 다른 순서로 재채점한 프롬프트 30개, 쌍 100개 이상
- V4 같은 변형을 두 번 재생하면 줄 파일이 바이트 단위로 같다
- V5 held-out 서로 다른 프롬프트 ≥ 100, 하드 부분집합(전체) ≥ 30
- V6 판정 실패(형식·id 불일치가 1회 재시도 뒤에도 남음) ≤ 판정 호출의 2%

**C3 관계 이웃 게이트** — 후보 margin {0.02, 0.03, 0.045}
- train 에서 작은 값부터 다음 두 조건을 처음 만족하는 m* 를 고른다:
  ① 관계 줄의 판정≥1 정밀도가 v0 대비 +10pp 이상
  ② 잃은 판정 2 관계 줄 ≤ v0 판정 2 관계 줄의 10%.
  없으면 폐기.
- held-out 에서 m* 로 다음 두 조건이 모두 맞으면 유지한다:
  ① 프롬프트당 판정 0 관계 줄 Δ 의 95% 부트스트랩 구간 상한 < 0
  ② 잃은 판정 2 관계 줄 ≤ v0 의 10%.
  아니면 폐기 → `relMargin: null`.

**C2 저장소 가족 scope** — 조정할 값이 없으므로 두 분할을 합쳐 영향받는 프롬프트에서만 본다.
영향받는 프롬프트는 가족 술어가 완전 일치보다 넓어지고 넓어진 경로에 사실이 있는 cwd 의 프롬프트다.
- 영향받는 서로 다른 프롬프트 ≥ 30 이 아니면 "판정 불가 → 현행 유지"(측정 갭으로 기록)
- 유지 조건 두 가지: ① 프롬프트당 판정 2 줄 Δ 의 95% 구간 하한 > 0 ② 판정 2 정밀도 Δ 의 95% 구간 하한 > −0.05.
  아니면 폐기 → `scopeFamily: false`
- 이번 범위는 프롬프트별 주입(KNN·관계)만이다. SessionStart `getTopFacts` 적용은 별도 측정이 필요하다(Open Questions).

**C4 식별자 어휘 레인(측정만)**: 사람이 친 부분(게이트 뒤 질의)에서 식별자를 뽑는다(길이 ≥ 6, `_`·`.`·`/`·camelCase·숫자 혼합 중 하나).
그 식별자가 든 as-of 가시·scope 안 사실을 찾는다(df ≤ 20, 대소문자 무시 부분 문자열). 블록에 없는 것만 최대 2줄 붙인다.
게이트·가드 우회 방법을 담은 사실은 제외한다(`우회|bypass|disable` 와 `=0`/`gate`/`guard` 동시 출현).
보고 항목: 프롬프트당 판정 2 줄 Δ(구간), [kw] 줄 정밀도, 우회 패턴 선택 수(0 이어야 함). 운영 변경은 없다(스키마 필요 → Open Questions).

**하드 부분집합(M13 대응)**: 순위 역전 시험이 아니라 변형별 "v0 빈 블록에서 얻은 판정 2 줄 수"로 따로 보고한다.

**C6 SessionStart**: 이번에는 로그만 남긴다. 결정 규칙(같은 scope 무작위 대조군 대비 적중률, constraint·preference 별도,
resume 별도)은 세션 50개가 쌓인 뒤 별도 계획에서 정한다(Open Questions).

## Acceptance Criteria

- **AC-001** 선택 추출은 동작을 바꾸지 않는다. `PRODUCTION_SELECT_OPTIONS` 가 현행 값(`relMargin:null, scopeFamily:false`)일 때
  computeInjectResult 의 블록·원장 키·로그 status 가 추출 전과 같다.
  - verify: `npx vitest run test/inject-core.test.ts test/inject-core-failure.test.ts test/inject-fallback-ledger.test.ts test/inject-select.test.ts` → rc=0,
    inject-select 테스트에 "옵션 현행 = 추출 전 결과" 대조 사례 포함
  - evidence: `.qa-artifacts/ac001-vitest.log`
- **AC-002** 주입 로그의 injected·deduped·no-match 줄에 다음 필드가 실린다:
  - `top_margins`: 후보별 소수 3자리
  - `gated_ids`: 원장 dedup 전 벡터 게이트 통과 id 앞 12자. no-match 면 빈 배열
  - `injected_ids`: injected 줄만, 앞 12자
  - `session_key`: 세션 id 가 있을 때만 `sha256(session_id)` 앞 12자
  - `plugin_version`: package.json 값

  로그 쓰기 실패는 주입을 막지 않는다.
  - verify: `npx vitest run test/inject-log.test.ts test/inject-core.test.ts -t "log fields"` → rc=0
  - evidence: 테스트 이름 `inject log fields*`
- **AC-003** SessionStart 훅이 주입 로그에 `via:'session-start'` 한 줄을 남긴다. 필드: status(injected/no-match/error), injected 개수,
  chars, injected_ids, session_key, source(startup/resume/clear/compact), plugin_version.
  stdout 전달 실패는 status error. 로그 쓰기 실패는 블록 출력을 막지 않는다.
  - verify: `npx vitest run test/session-start-hook.test.ts` → rc=0, 새 사례 3개(injected·no-match·로그 폴더 쓰기 불가)
  - evidence: `.qa-artifacts/ac003-vitest.log`
- **AC-004** `relMargin` 이 숫자이면 SUPPORTS·INFLUENCES 이웃은 margin ≥ relMargin 일 때만 실린다.
  margin 은 vec_facts·vec_facts_kr 점조회 거리 중 작은 값이고 `normalizeVecDistance` 를 거친다.
  CONTRADICTS·SUPERSEDES 이웃은 게이트 면제, 벡터 없는 이웃은 싣지 않고 `rel_unscored` 로 센다,
  seed 당 점수 매기는 이웃은 ≤ 30 이다. `null` 이면 현행과 같다.
  - verify: `npx vitest run test/inject-select.test.ts -t "relation gate"` → rc=0(int8 표 사례·한국어 표만 가까운 사례 포함)
  - evidence: 테스트 이름
- **AC-005** `resolveRepoRoots` 해석 규칙:
  - `.git` 폴더 → 그 조상
  - `.git` 파일(`gitdir: <R>/.git/worktrees/<n>`) → [worktree 최상위, R]
  - 경로가 없고 `/.auto-issue-worktrees/` 를 포함 → 그 앞 경로
  - 그 밖 → []

  `scopeMatcher` 는 정확히 같거나 `루트 + '/'` 접두일 때만 참이다(`<repo>` 가 `<repo>-extra` 를 삼키지 않음).
  `scopeFamily:false` 면 현행 완전 일치와 같다.
  - verify: `npx vitest run test/project-family.test.ts` → rc=0
  - evidence: 테스트 이름(형제 이름 음성 사례 포함)
- **AC-006** `node bench/inject-replay.mjs --build` 가 표본 파일과 스냅샷 DB 를 만든다.
  - 표본: 로그 정렬(같은 cwd·같은 길이·±180초) ∩ 현행 게이트 통과 ∩ 합성 접두 제외, 같은 질의는 하나로 접음
  - 스냅샷: facts·vec_facts·vec_facts_kr·ontology_relations·vec_int8_scale·필요 exchanges(id·session_id)
  - 라이브 DB 의 mtime·크기가 실행 전후 같다
  - as-of 술어는 생성 시각이 프롬프트보다 늦은 사실·같은 session_id exchange 에서 나온 사실·늦게 생긴 관계를 거른다
  - verify: `npx vitest run test/inject-bench-lib.test.ts -t "sample|as-of"` → rc=0 그리고 `--build` 출력 JSON 의
    `live_unchanged:true`, `distinct_prompts` ≥ 200
  - evidence: `.bench-out/inject-replay/build.json`, `.qa-artifacts/ac006-build.log`
- **AC-007** 같은 변형을 두 번 재생하면 줄 파일 sha256 이 같다.
  - verify: `node bench/inject-replay.mjs --check-determinism` → rc=0, 변형 6개 전부 `identical:true`
  - evidence: `.bench-out/inject-replay/determinism.json`
- **AC-008** 판정 호출은 `callHaiku` 경유(격리 옵션·memory-bank-llm cwd)다.
  판정 1회 스모크 뒤 주입 로그 줄 수가 같고, cwd 가 LLM 작업 폴더인 exchanges 행이 0 이다.
  - verify: `node bench/inject-judge.mjs --smoke` → rc=0, 출력 `inject_log_delta:0`, `llm_workdir_exchanges:0`
  - evidence: `.qa-artifacts/ac008-smoke.json`
- **AC-009** 판정 응답 검증: 응답 id 집합이 보낸 id 집합과 정확히 같고 점수 ∈ {0,1,2} 일 때만 받는다.
  어기면 1회 재시도, 그래도 어기면 `judge_failures` 로 세고 그 프롬프트를 지표에서 빼며 보고한다(무음 누락 금지).
  - verify: `npx vitest run test/inject-bench-lib.test.ts -t "judge response"` → rc=0
  - evidence: 테스트 이름
- **AC-010** 리포트가 V1~V6 을 계산해 싣는다. 하나라도 어기면 `verdict:"invalid"` 이고 모든 결정이 현행 유지다.
  판정 규칙은 위 사전 등록과 같은 함수로 계산한다.
  - verify: `npx vitest run test/inject-bench-lib.test.ts -t "validity|decision"` → rc=0
    (합성 판정으로 유지·폐기·무효·판정 불가 경로 각각)
  - evidence: 테스트 이름, `.bench-out/inject-replay/report.json`
- **AC-011** `docs/bench/2026-10-19-inject-replay.md` 가 커밋된다. 내용: 변형별 지표·95% 구간·유효성·결정, 표본 크기(서로 다른 프롬프트 수).
  프롬프트 원문·사실 원문은 없다(표본 질의 앞 40자가 하나도 문서에 나오지 않음).
  - verify: `node bench/inject-judge.mjs --report --doc docs/bench/2026-10-19-inject-replay.md` → rc=0 그리고
    `node bench/inject-judge.mjs --leak-check docs/bench/2026-10-19-inject-replay.md` → rc=0
  - evidence: 그 문서, `.qa-artifacts/ac011-leak.log`
- **AC-012** 운영 기본값 `PRODUCTION_SELECT_OPTIONS` 가 판정 문서의 결정과 같다. 테스트가 report.json 의 결정과 상수를 대조한다.
  유지된 변경은 그 경로의 운영 테스트가 있다.
  - verify: `npx vitest run test/inject-select.test.ts -t "production options"` → rc=0
  - evidence: 테스트 이름, 판정 문서의 결정 표
- **AC-013** `npm run build` rc=0, `npm test` rc=0(전체).
  - verify: 두 명령 rc
  - evidence: `.qa-artifacts/build.log`, `.qa-artifacts/test.log`
- **AC-014** v1.7.8 릴리스 표면이 맞고 라이브에 반영된다.
  - 표면: package.json·plugin.json·marketplace.json 의 1.7.8, 태그 v1.7.8, GitHub 릴리스 Latest
  - 라이브: 설치 캐시 1.7.8, 실제 세션의 주입 로그 새 줄에 `plugin_version:"1.7.8"` 과 AC-002 필드
  - verify: `git show HEAD:package.json` 버전, `gh release view v1.7.8 --json tagName,isDraft`, 설치 기록 조회, 로그 마지막 줄 jq
  - evidence: `.qa-artifacts/post-deploy.json`

## Steps

1. **[refactor 모자] 선택 추출** — `src/inject-select.ts`(new), `src/inject-core.ts`.
   Extract Function(selectInjectFacts·formatInjectBlock) + Move(상수). 옵션은 현행값 고정.
   검증: 기존 inject 테스트 전부 rc=0(AC-001). 커밋 1.
2. **[feature] 로그 필드** — `src/inject-log.ts`, `src/inject-core.ts`, `test/inject-log.test.ts`·`test/inject-core.test.ts`. 검증: AC-002.
3. **[feature] SessionStart 로그** — `scripts/fact-consolidate-hook.js`, `src/inject-log.ts`, `test/session-start-hook.test.ts`. 검증: AC-003. 커밋 2(2·3).
4. **[feature] 이웃 게이트 옵션** — `src/inject-select.ts`(neighbourMargin), `src/ontology-db.ts`(opts), `test/inject-select.test.ts`. 기본 꺼짐. 검증: AC-004.
5. **[feature] 가족 scope 옵션** — `src/project-family.ts`(new), `src/fact-db.ts`·`src/ontology-db.ts`(inScope), `test/project-family.test.ts`. 기본 꺼짐. 검증: AC-005. 커밋 3(4·5).
6. **[bench] 라이브러리·재생** — `bench/inject-bench-lib.mjs`, `bench/inject-replay.mjs`, `test/inject-bench-lib.test.ts`, `.gitignore`(`.bench-out/`).
   searchSimilarFacts 의 `visibleId` 는 KNN 자르기 전에 적용한다(가시 행이 50개가 될 때까지 4배씩 더 가져옴, 상한 6,400).
   검증: AC-006·007.
7. **[bench] 판정·리포트** — `bench/inject-judge.mjs`, lib 확장. 판정 모델 기본은 `claude-sonnet-5-5`(`--model` 로 변경), 동시 4.
   검증: AC-008·009·010. 커밋 4(6·7).
8. **[측정 실행]** `--build` → `--replay` → `--check-determinism`(판정이 읽는 줄 파일과 대조하므로 재생 뒤) → `--judge`(train·held-out 전부, 재채점 30개) → `--report --doc`.
   유효성 실패면 원인을 고쳐 다시 잰다(판정기 모델 교체는 Deviations 에 기록). 진전 없이 같은 실패가 3회면 "무효" 로 확정해 현행 유지.
   검증: AC-011.
9. **[feature, 조건부] 운영 기본값** — `src/inject-select.ts` PRODUCTION_SELECT_OPTIONS, 유지된 변경의 운영 테스트.
   C2 가 유지면 데몬의 루트 해석 캐시(cwd 키)를 함께 넣는다. 검증: AC-012. 커밋 5(8·9 — 판정 문서 + 상수).
10. **[docs]** `CLAUDE.md` 모듈·벤치 표, `README.md`(벤치 사용법 1절), `CHANGELOG.md` [1.7.8], `docs/qa-test-plan.md` TC.
    검증: 문서-구현 대조 grep. 커밋 6.
11. **[release]** 버전 3곳 1.7.8 → 커밋 → push(별도) → 태그·릴리스 → 설치 반영(live-apply) → 실제 세션 로그 확인. 검증: AC-013·014.

## Risks / Stop rules

- 판정기가 LLM 이라 길이·언어 편향이 있을 수 있다. 사람 라벨이 아니다. 대조군(V1·V2)과 재채점(V3)으로만 보정하고 이 한계를 문서에 적는다.
- 재생은 세션 원장(이미 본 사실)과 비활성 전환 이력을 재현하지 못한다. 지금 비활성인 사실은 과거에 활성이었어도 빠진다. 문서에 한계로 적는다.
- 재채점·판정 비용: 판정 약 300호출 + 재채점 30호출(Sonnet 5.5, 구독). 한도(429)에 걸리면 team 규칙 9(중단 지점 재개, 진행 중 회차 무효)를 따른다.
- 표본 편향: exchanges 에 색인된 대화형 세션만 재생된다(자동화 세션 제외). 결론은 그 집단에만 적용된다고 적는다.
- C2 는 상위 칸의 global 사실을 밀어내는 교체다. 그래서 판정 2 줄 증가와 정밀도 비하락을 함께 요구한다.
- 중단 규칙: 유효성 실패가 진전 없이 3회면 무효로 확정하고 운영 기본값은 현행 유지. 하네스·로그·옵션 코드는 그대로 출시한다(벤치가 쓰는 코드라 죽은 코드가 아니다).
- 로그 줄이 약 200바이트 늘어 5MB 회전 주기가 대략 절반으로 줄어든다(현재 약 100일 → 50일 추정).

## Open Questions

`docs/plans/open-questions.md` 에 append:
- [ ] C4 facts FTS(trigram 또는 구 질의) 도입 여부. 졸업 트리거: 판정 문서의 kw 변형이 판정 2 줄 Δ 구간 하한 > 0 이고 우회 패턴 선택 0 → 사용자가 10.5GB DB 스키마 이행을 승인.
- [ ] C6 SessionStart 크기 결정 규칙. 졸업 트리거: `via:'session-start'` 줄이 세션 50개 이상 쌓임 → 같은 scope 무작위 대조군 대비 적중률 계획 작성.
- [ ] C2 를 `getTopFacts`(SessionStart)에 적용할지. 졸업 트리거: C2 가 유지이고 C6 로그 50세션 → 별도 측정.
- [ ] C2 쓰기 쪽 정규화(새 사실 scope_project 를 주 루트로). 졸업 트리거: C2 유지 → 지워진 worktree 고아 사실 수 실측 후 이행 계획.
- [ ] 긴 프롬프트의 붙여 넣은 블록 제거 질의(C7 대체안). 졸업 트리거: 판정 문서에서 사람이 친 긴 프롬프트의 하드 부분집합 손실이 확인됨.

## Deviations

1. **AC-008 기준 정정(2026-10-19, 스모크 첫 실행)**: "cwd 가 LLM 작업 폴더인 exchanges 행 0" 은 사실과 맞지 않았다.
   라이브 DB 에는 그런 행이 6,950개 있고, 전부 2026-07-07~08 에 생겼다(제외 규칙 도입 전 오염 — `src/llm.ts` 주석의 2026-07-05·07-08 관측).
   그 뒤로는 워커가 매일 LLM 을 부르는데도 새 행이 0개다. 그래서 기준을 "최근 30일 안의 LLM 작업 폴더 행 0" 으로 바꾼다.
   주입 로그 새 줄 0, 대화 기록이 제외 대상 폴더에 남음은 그대로 요구한다. 옛 오염 행 정리는 데이터 삭제라 이 범위에서 하지 않는다(보고만).
2. **레벨3 독립 반박 뒤 재측정(2026-10-19)**: 판정 규칙(임계값·판정식·분할)은 바꾸지 않았다. 바꾼 것은 후보 구현과 측정 구현의 결함이다.
   - 가족 술어: 지워진 worktree 경로의 표식 앞 폴더를 저장소인지 보지 않고 루트로 삼았다. 여러 저장소의 worktree 를 담은 상위 폴더가
     가족이 되어 다른 저장소 사실까지 실린 상태로 C2 를 쟀다. 이제 앞 폴더가 저장소 루트일 때만 묶는다. 루트 아래 중첩 저장소·서브모듈은
     가족 밖이고, 저장소가 아닌 `.git`(엉뚱한 파일·빈 폴더·심링크)·상대 경로는 가족이 없다. 계정의 실제 홈도 루트가 될 수 없다.
   - as-of: 스냅샷에 `fact_revisions` 를 복사하지 않아(표만 있음) 프롬프트 뒤에 문장이 바뀐 사실이 지금 문장으로 재생됐다(v0 줄 4개 — 통합의 재작성은 벡터를 바꾸지 않아, 그때의 벡터에 나중 문장이 짝지어 판정됐다).
     이제 숨긴다. `--build` 가 복사하고, 이미 만든 스냅샷은 `--add-revisions` 로 빌드 시각까지의 개정만 넣는다.
   - C2 '영향': 사전 등록 문장("넓어진 경로에 사실이 있는 cwd 의 프롬프트")을 지금 활성인 사실로 셌다. 표본 전체의 as-of 원칙에 맞춰
     그 프롬프트 시점에 보이는 사실로 세도록 바꿨다(해석 변경 — 옛 해석으로도 영향 127개, +0.126 CI 0.047~0.228 로 같은 결론, `.qa-artifacts/level3-c2-alt.log`).
     **이 변경은 사후 규칙이다** — 3번에서 결정을 사전 등록 문장대로 되돌렸다.
   - V3 는 규칙 원문대로 재채점 프롬프트 30개 조건을 함께 본다. V4 는 두 번의 재생이 판정에 쓴 줄 파일과도 같아야 통과한다.
     판정 행은 표본 안의 프롬프트 것만 센다. 끊긴 마지막 줄은 세어 보고하고, 중간의 깨진 줄은 실패로 멈춘다.
   - 결과: 유효, C2 유지(영향 111개, +0.144 CI 0.045~0.261, 정밀도 Δ CI −0.019~0.081 — 사후 해석으로 낸 판정), C3 폐기.
     새로 판정한 쌍은 7개(판정 호출 6회)다. 원래 판정은 한 호출에 노트 4~14개와 대조군 6개를 함께 넣었지만, 이 7쌍은 노트 1~2개만 넣고
     대조군 없이 불렀다(모델·템플릿은 같음). 블록이 달라진 프롬프트에 걸린 쌍은 1개(점수 1)라 결정에는 영향이 없다. 처음에 적은 '28개'는 틀렸다.
   - 판정 규칙 밖 참고 수치를 보고서에 더했다: 블록이 실제로 달라진 프롬프트 수와 루트 분포, 가장 큰 루트를 뺀 민감도, 줄만의 재채점 일치와
     판정 2 의 양성 일치, 하드 부분집합의 판정 0·1 줄. 누출 검사는 정규화한 40자 창(앞 400자까지)으로 넓혔다(양성 대조 확인).
3. **레벨3 2차 독립 반박 뒤 재측정(2026-10-19)**: 판정 규칙(임계값·판정식·분할)은 그대로다.
   - 결정은 사전 등록 문장의 cwd 단위 해석으로 낸다: 영향 = 넓어진 경로에 사실이 있는 cwd 의 프롬프트(127개). 원문에 시점이 없어 사실은
     지금 활성인 것으로 센다 — 이것도 해석이지만 처음 실행에 쓴 해석이고, as-of 해석은 결과를 본 뒤에 바꾼 것이다. as-of 해석(111개)은 보고서에
     '사후 해석'으로 함께 싣고 결정에 쓰지 않는다. 두 해석 모두 유지 조건을 넘는다.
   - 참고 수치의 묶음 단위를 저장소로 바꿨다(연결 worktree 는 본 저장소로 — `resolveRepoRoots` 의 마지막 원소). 처음 보고서의 '루트 5곳·가장 큰
     루트를 빼도 +0.08'은 한 저장소의 본체와 연결 worktree 들을 따로 센 값이었다. 판정 2 이득 16줄은 전부 한 저장소에서 나왔고(cwd 루트 10곳),
     나머지 저장소 3곳의 영향 프롬프트 22개는 이득 0·30개 미만이라 따로 판정할 수 없다. 결정 규칙은 영향 프롬프트 전체에 대한 것이라 유지는
     그대로지만, 일반화 근거는 아니다 — 운영 상수 주석·CHANGELOG·README 에 이 한계를 적고 Open Questions 에 재판정 트리거를 둔다.
   - 가족 술어: 루트 아래 지금은 없는 사실 경로는 그 루트의 worktree 보관 폴더 안일 때만 가족이다(지워진 다른 저장소의 사실이 들어오던 결함).
     홈 폴더 비교는 macOS·Windows 에서 대소문자를 가리지 않고, 루트 해석 캐시는 1분 뒤 다시 읽고, `gitdir` 역참조는 일반 파일일 때만 읽는다.
   - as-of: 통합의 CONTRADICTION 병합은 새 사실의 문장을 바꾸면서 개정 행은 옛 사실 이름으로 남긴다. 개정 행의 새 문장을 지금 가진, 그 전부터 있던
     다른 사실도 그 시각에 문장이 바뀐 것으로 보고 숨긴다(새로 숨는 사실 280개, 활성 45개 — 병합 없이 새 사실 문장을 그대로 쓴 경우까지 숨겨 보수적).
   - 보고는 replay-meta 의 해시가 지금 읽는 줄 파일과 같을 때만 낸다. `--check-determinism` 은 줄 파일이 없으면 순서를 안내하고 멈춘다.
     누출 검사 창은 원문 전체에서 20자 간격(59자 이상 그대로 옮긴 인용은 반드시 잡음)으로 넓혔다.
   - 결과: 유효(V1~V6 통과, 결정론 6/6), C2 유지(127개, +0.126 CI 0.047~0.228, 정밀도 Δ CI −0.015~0.069), C3 폐기. family 줄 파일은 이전과
     바이트가 같다. 다른 변형의 줄 파일은 바뀌었지만 v0 표시 줄의 판정 비율(≥1 0.554·=2 0.205)은 이전 보고와 같고, 바뀐 블록의 줄은 모두 이미 판정된 쌍이다. 새 판정 호출 0회. 누출 검사 창 12,673개 0건(양성 대조는 잡음).
4. **레벨3 3차 독립 반박 뒤(2026-10-19)**: 판정 규칙 그대로, 재생 줄 파일은 3번과 바이트가 같다.
   - AC-012 의 남은 절반: 관계 확장 경로의 가족 scope 운영 테스트(나가는·들어오는 가족 이웃은 켰을 때만, 형제 저장소·다른 경로는 없음,
     운영 옵션이 같은 경로를 탐). 변이(가족 옵션 무시·항상 가족·양방향 scope 필터 삭제)가 모두 잡힌다.
   - 가족 술어: `.git` 파일이 가리키는 폴더는 HEAD 를 가진 git 폴더일 때만 저장소다(`gitdir: .` 이 아무 폴더나 루트로 만들던 경로).
   - 보고 결속: 재생이 표본·스냅샷 sha256 을 기록하고 보고가 다시 계산해 대조하며, 표본의 모든 프롬프트가 모든 줄 파일에 있어야 한다.
     판정 파일과 코드(git·dist) 해시는 보고서·판정 문서에 남긴다(문서의 결정 블록을 읽는 테스트는 `.bench-out/` 이 없는 환경에서도 돌아야
     하므로 그 해시를 다시 계산하지 않는다 — 문서의 해시는 재현 기록이다). 보고 경로는 합성 픽스처로 실행 시험한다.
   - 서술 정정: as-of 숨김의 근거는 벡터가 아니라 문장(통합 재작성은 벡터를 바꾸지 않는다), 등록 정의는 cwd 단위 '해석'(원문에 시점 없음),
     저장소 밖 worktree 는 한 방향, 심링크 cwd 는 가족 없음.
   - 확인: 대조군으로 판정된 750쌍 중 어느 변형의 줄로도 쓰인 것은 0쌍. 핫패스 최악 사례(한 프롬프트의 matcher 4개로 스코프 경로 286개
     전부 판정, 표본 cwd 42곳) 루트 캐시를 비운 상태 p95 3.3ms·최대 4.3ms, lstat 최대 147회 — OS 디렉터리 캐시는 데워진 상태라 느린
     마운트는 대표하지 못한다. 운영은 후보 행만 판정한다.
   - 결과: 유효, C2 유지(127개, +0.126 CI 0.047~0.228), C3 폐기 — 3번과 같다. 보고서는 커밋 `cb79b04`(src·bench·dist 깨끗함)로 냈다.
5. **레벨3 4차 독립 반박 뒤(2026-10-19)**: 판정 규칙 그대로, 재생 줄 파일은 3·4번과 바이트가 같다.
   - 3차 반영 때 CHANGELOG 에 '이득은 저장소 밖 보관 폴더 worktree 배치에서 나왔다'고 적었는데, 데이터로 확인하지 않은 문장이었고 사실과
     반대였다(4차 반박이 다시 셈). 지우고, 보고서가 cwd 배치별 이득을 직접 계산한다: 저장소 안 worktree 17개 프롬프트 +12, 저장소 밖 연결
     worktree 34개 +4, 저장소 폴더(본체·하위 폴더) 76개 0.
   - 결속: 재생이 cwd 별 가족 루트와 코드 파일 해시(벤치·dist 8개)를 기록하고, 보고는 그 루트로 묶고 지금 코드와 대조한다(어긋나면 정지).
     스냅샷 해시에 WAL 을 넣었다. 표시된 줄에 판정이 없는 프롬프트가 있으면 보고가 멈춘다(이번 0개). 판정 파일 해시는 기록만 한다.
   - 합성 보고 픽스처를 유효한 하네스로 바꿔 결정·문서 결정 블록까지 단언한다(사후 해석이 결정하게 바꾸는 변이·결정 블록 상수 변이가 잡힌다).
   - 가족 술어: 심링크·파일인 cwd 는 가족 없음(보관 폴더 안 심링크가 그 저장소를 빌리던 경로), HEAD 는 일반 파일 또는 심링크, 읽을 수 없는
     경로는 가족 밖(닫힌 쪽), 살아 있는 worktree 안에서 지워진 사실 경로는 가족 밖(cwd 쪽은 6번에서 같은 규칙으로 맞췄다). 진짜 git 배치(연결
     worktree·서브모듈·detach)는 HEAD 를 가져 거부되지 않는다(4차 반박 확인, 픽스처 테스트). 재생 줄 파일이 바이트 동일한 것은 표본 cwd 42곳에서
     줄이 하나도 바뀌지 않았다는 실측일 뿐이다 — 표본에 서브모듈·bare·detach 배치는 없다(5차 반박 지적으로 고침).
   - 결과: 유효, C2 유지(127개, +0.126 CI 0.047~0.228), C3 폐기. 보고서는 재생 코드 `04dbc37`(깨끗함)로 냈다.
6. **레벨3 5차 독립 반박 뒤(2026-10-19)**: 판정 규칙 그대로, 재생 줄 파일 6개는 4·5번과 바이트가 같다(새 거부 규칙·관계 경로 정규화가 표본의
   줄을 바꾸지 않음).
   - 코드 결속의 범위: 재생이 기록하던 코드 파일 8개는 재생이 불러오는 모듈의 일부였다(사실 문장 자르기 `fact-text`·모델 이름 `embedding-version`·
     project 정규화 `project-canon` 등 7개가 빠짐). 재생 진입 파일에서 import 를 끝까지 따라가 모은 모듈 전부(15개), 그 모듈이 쓰는 패키지 버전(3개),
     임베딩 모델 이름과 모델 파일(4개)의 해시로 바꿨다. 따라갈 수 없는 로드(계산된 import·require)나 없는 파일을 가리키는 import 는 오류다.
     재생은 이 해시와 입력 해시를 시작할 때 기록하고 끝날 때 다시 재어 다르면 실패한다.
   - 판정 결속: 판정 행은 점수만 있고 판정한 문장에 묶여 있지 않았다(스냅샷을 다시 만들면 옛 문장에 매긴 점수가 그대로 쓰일 수 있었다). 판정 행에
     시드와 판정기가 받은 메시지(판정 지시문·프롬프트·사실 문장)의 sha256 을 기록하고, 보고는 지금 스냅샷으로 메시지를 다시 만들어 다르면 멈춘다.
     기존 행 161개는 `--bind-legacy` 로 판정 호출 기록(격리 작업 폴더의 대화 기록 336개)에서 판정기가 실제로 받은 메시지와 바이트가 같은 것을
     찾아 모두 묶었다(못 찾은 행 0). 보충 판정 행(대조군 없이 빠진 줄만 다시 부른 main 행) 6개를 따로 센다.
   - 가족 술어: 지워진 cwd 에도 사실 경로와 같은 규칙(보관 폴더 자체나 그 바로 아래 worktree 가 지워졌을 때만)을 적용했다. 심링크를 거쳐
     저장소에 닿는 cwd·사실 경로는 가족 밖(루트로 가는 링크는 그 루트). 관계 확장의 scope 도 벡터 검색처럼 슬러그 project 를 정규화한다.
     bare 저장소의 worktree 끼리는 묶지 않는다(한계 — 각자 한 가족, 좁은 쪽).
   - 보고: 배치 칸을 전부 싣고 합이 영향 프롬프트 수와 다르면 멈춘다. 배치별 수치는 "프롬프트의 cwd 자리별"이지 이득이 된 사실의 출처가 아니다
     (README 문장 고침). 문서 결정 블록 옆에 그 블록을 낸 `report.json` 의 sha256 을 적고, 그 파일이 있으면 테스트가 블록과 대조한다.
     공개 저장소 파일에서 비공개 저장소 이름을 뺐다(이미 push 된 커밋 이력에는 남는다).
   - 누출 검사를 판정 문서뿐 아니라 CHANGELOG·README·이 계획서·시험 계획에도 돌렸다. 판정 문서는 0건이다. 나머지 넷의 일치는 20줄(창 23개, 서로 다른
     창 17개)이고 세 종류다: 긴 사실 문장 끝의 짧은 창이 흔한 영어 낱말 조각과 겹친 것 11개(12~16자), v1.7.0 공개 README 45행에 이미
     있던 문구의 창 2개(사실 1개), v1.7.0 공개 `CLAUDE.md` 58행·`docs/tagging-guide.md` 179행에 이미 있던 DB 경로의 창 4개(사실 2개 — 40자 창 2개 포함).
     창마다 공개 파일의 줄 번호와 v1.7.0 존재 여부를 `.qa-artifacts/r6-leak-docs-classified.jsonl` 에 남겼다. 비공개 문장은 0건이다(6번에서 "흔한 낱말
     15개 + 2개"로 적은 분류는 틀렸다 — 7번에서 고침).
   - 결과: 유효, C2 유지(127개, +0.126 CI 0.047~0.228), C3 폐기 — 5번과 같다.
7. **레벨3 6차 독립 반박 뒤(2026-10-19)**: 6차는 높음 이상 0건(통과)이었고, 중간 2·낮음 8 을 반영했다. 판정 규칙 그대로.
   - 지워진 경로 규칙을 닫는 쪽으로: 지워진 경로는 보관 폴더 바로 아래 worktree 폴더 그 자체이고, 그 보관 폴더가 지금 있으며 그 안의 폴더가 모두 그
     루트의 연결 worktree 일 때만 가족이다. 보관 폴더 바로 아래가 지워진 것만 보던 규칙은 저장소 안에 둔 보관 폴더가 여러 저장소의 worktree 층
     (`ORG-REPO/…`)을 담는 배치에서 다른 저장소의 사실을 들였고, 지워진 worktree 안에 있던 clone 의 사실도 들였다. 표본에서 가족이 더한 줄 83개 중
     지워진 경로에서 온 줄은 0개였다(루트 경로 자체 80·살아 있는 경로 1·넓힘 아님 2).
   - 루트로 가는 링크도 가족 밖(문서와 코드가 어긋났다 — 링크 대상은 같은 경로에서 바뀔 수 있다). 홈이 git 작업 트리일 때 그 연결 worktree 는 자기만의 가족.
   - 판정 결속: `--bind-legacy` 가 판정 호출 기록에서 메시지뿐 아니라 그 호출의 답을 함께 찾는다(답의 점수가 행 점수와 같고 답한 모델이 행의 모델일 때만
     결속). 찾은 호출(메시지·답)을 `.bench-out/` 의 `judge-calls.jsonl` 에 보존하고, 보고가 결속마다 그 호출을 다시 확인한다 — 호출 없이 손으로 쓴 결속
     파일은 통과하지 못한다. 결속 파일에 만든 코드(git·스크립트 해시)를 적는다. 판정 때 기록하는 결속은 보고가 쓰는 함수와 같은 함수로 계산한다.
     첫 호출이 실패한 프롬프트는 대조군까지 다시 묻고, 대조군이 판정되지 않은 프롬프트 수를 보고에 싣는다.
   - 코드 결속: 하위 의존 패키지(85개, 버전)·네이티브 바이너리(18개)·Node 버전을 더했다. 계산된 dist 이름 로드는 오류, 심링크인 모델 파일도 해시한다.
   - 문서: 슬러그 project 는 대화 색인으로 경로를 찾은 뒤 그 경로의 가족을 쓴다(찾지 못하면 없음)로 고쳤다. 잠금 행을 본문 줄까지 고정했다.
   - 변이 검사 7차: 처음 20/24. 살아남은 4개 중 2개(읽을 수 없는 보관 폴더, 계산된 dist 경로를 자식 프로세스로 실행)는 시험이 다른 경로에서 먼저
     막혀 그 분기에 닿지 않았고, 2개(다른 저장소의 worktree 를 담은 보관 폴더, 보존 답과 그 해시를 함께 고친 위조)는 시험이 없었다. 6차 반영 때 넣은
     "보존 답의 점수 변조" 시험은 실제로는 메시지 안의 판정 지시문 예시를 바꾸고 있었다(메시지 해시로 막혀 답 검사를 시험하지 못함) — 답 칸만 바꾸도록
     고쳤다. 시험 4개를 더한 뒤 24/24.
   - 이번 범위 밖(보고만): 7월에 추적된 `bench/verify-*.mjs`·`analyze-*.mjs` 등 13개 파일에 로컬 절대경로가 있다.
8. **레벨3 7차 독립 반박 뒤(2026-10-19)**: 7차는 높음 이상 0건(통과)이었고, 중간·낮음 지적을 반영했다. 판정 규칙 그대로.
   - 지워진 경로 — 트레이드오프 선언: 6차에서 좁힌 규칙(보관 폴더 바로 아래 worktree 폴더 그 자체, 보관 폴더에 그 루트의 연결 worktree 만 있을 때)도
     "지금 보관 폴더가 어떻게 보이는가"로 "지워진 폴더가 무엇이었는가"를 추론하고, 7차가 다시 반례를 냈다. 넓히면 다른 저장소의 사실이 새고 좁히면 지운
     worktree 의 지식이 빠지는, 두 지적을 동시에 만족하는 상태가 없는 축이라 라운드를 더 돌리지 않고 격리 쪽으로 정한다: 지워진 경로(cwd·사실)는 어느
     가족에도 들지 않는다. 잃는 것: 지운 worktree 에서 쓴 사실은 운영에서도 가족으로 들어오지 않는다. 측정: 재생 표본에서 가족이 더한 83줄 중 지워진
     경로에서 온 줄 0(루트 경로 자체 80·살아 있는 경로 1·넓힘 아님 2), cwd 가 지워진 프롬프트 9개(cwd 4곳)는 7차 규칙에서도 루트가 없었다.
   - 보관 폴더 안에서는 그 루트의 연결 worktree 만 가족이다(보관 폴더 안의 다른 폴더·링크·다른 저장소의 worktree 는 밖). 본 저장소를 링크로 가리키는
     연결 worktree 는 본 저장소와 묶지 않는다.
   - 판정 결속: 판정 때 쓰는 행에 받은 답 원문을 싣고 보고가 그 답의 점수와 행 점수를 대조한다. 점수 키가 항목과 다르거나 대조군으로 적힌 항목이 지금
     표시된 줄이면(그 점수가 줄 점수로 읽힌다), 한 호출이 두 행을 결속하면, 보존 호출 파일이 결속 파일이 가리키는 해시가 아니면 보고가 멈춘다.
     처음에는 '줄로 적힌 항목은 지금 표시된 줄'까지 요구했는데 실제 판정 행 10개(줄 항목 14개)가 걸렸다 — 가족 술어를 고치기 전 재생이 표시해 판정된
     캐시(판정은 프롬프트·사실 단위로 남는다)로, 줄 점수로는 읽히지 않는다. 그래서 그 항목은 세어 판정 문서에 싣고 멈추지 않는다. 항목의 분류는
     판정기가 보지 않아 결속되지 않는다 — 대조군을 줄로 바꿔 적은 위조는 이 항목과 구별되지 않는다(한계로 적음). 원래 대화 기록이 남아 있으면 보존 호출과
     대조한다(다르면 멈춤, 없으면 수만 보고). `--bind-legacy` 를 다시 돌려도 검증이 유지되는 보존 호출은 지우지 않는다(대화 기록은 만료된다) — 결속하지
     못한 행이 생기면 아무것도 쓰지 않는다. 결속은 서명이 아니다: 세 로컬 파일을 맞춰 고치면 막지 못한다(판정 문서 한계에 적음).
   - 코드 결속: 하위 의존 패키지를 Node 방식(가까운 `node_modules` 부터 위로)으로 찾는다. 보고 시점의 Node 버전은 비교하지 않는다(기록·표시만 —
     재생은 시작과 끝에 같은지 본다).
   - 잠금: 잠금 행이 목록 기호(`- LOCK|`)로 시작해 잠금 훅(`^LOCK|` 행만 읽음)이 한 행도 검사하지 않고 있었다 — 8차 수정으로 INJ19 앵커가 끊긴 상태에서도
     통과했다. 줄 머리를 `LOCK|` 로 고치고 INJ13·INJ19·INJ23 앵커를 새 코드에 맞췄으며 INJ25~28 을 더했다(훅 rc 0, 앵커를 지운 사본에서 rc 2).
   - 문서: `PRODUCTION_SELECT_OPTIONS` 주석의 "이득이 한 저장소의 본체와 연결 worktree 에서" 를 cwd 위치 기준(안쪽 worktree +12·바깥 연결 worktree +4·
     저장소 폴더 0)으로 고쳤다.
   - 이번 범위 밖(보고만): 다른 저장소의 잠금 파일도 같은 목록 기호 형식이라 검사되지 않는다.
