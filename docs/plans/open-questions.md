# Open Questions

## 2026-10-19 Memorilla 적용 (`docs/plans/2026-10-19-memorilla-applicability.md`)

- [ ] C4 facts FTS(trigram 또는 구 질의) 도입. 졸업 트리거: 재생 판정의 kw 변형이 판정2 줄 Δ 구간 하한 > 0 이고 우회 패턴 선택 0 → 사용자가 10.5GB DB 스키마 이행 승인. (2026-10-19 측정: Δ +0.003 [0, 0.010] — 미충족)
- [ ] C6 SessionStart 크기 결정 규칙. 졸업 트리거: `via:'session-start'` 줄이 세션 50개 이상 → 같은 scope 무작위 대조군 대비 적중률 계획.
- [ ] 가족 scope 를 `getTopFacts`(SessionStart)에 적용. 졸업 트리거: C6 로그 50세션 → 별도 측정.
- [ ] 가족 scope 쓰기 쪽 정규화(새 사실 scope_project 를 주 루트로). 졸업 트리거: 지워진 worktree 고아 사실 수 실측 후 이행 계획.
- [ ] 긴 프롬프트의 붙여 넣은 블록 제거 질의(C7 대체안). 졸업 트리거: 사람이 친 긴 프롬프트의 하드 부분집합 손실 확인.
- [ ] 관계 확장 재설계. 졸업 트리거: 관계 줄 판정≥1 51.7% 를 올릴 다른 방식(예: 이웃의 관계 유형별 가중, 확장 seed 수)을 재생 판정으로 비교할 계획.
