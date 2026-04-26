# Contributing to korean-law-alio-mcp

이슈 / 풀 리퀘스트 환영합니다. 본 프로젝트는 [chrisryugj/korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp) 에서 fork 한 파생 작업이며, 원작자 영역과 본 fork 영역이 명확히 구분되어 있습니다 — 기여 시 그 경계를 존중해 주세요.

> **Forked on**: 2026-04-25
> **Maintainer**: [@scvcoder](https://github.com/scvcoder)
> **Original**: [chrisryugj/korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)

---

## 🚀 시작하기

```bash
git clone https://github.com/scvcoder/korean-law-alio-mcp
cd korean-law-alio-mcp
npm install
npm run build
npm test          # 전체 테스트 (LAW_OC 가 .env 에 있으면 외부 API 도 검증)
```

법제처 OpenAPI 키(`LAW_OC`)는 [open.law.go.kr](https://open.law.go.kr/LSO/openApi/guideResult.do) 에서 무료 발급. ALIO 도구를 다루려면 `npm run alio:sync` 로 데이터 수집 (시간 오래).

---

## 📋 PR 전 체크리스트

- [ ] `npm run build` 가 깨끗하게 통과 (TypeScript 에러 0)
- [ ] `npm test` 가 통과 — 신규 도구를 추가했다면 [`test/alio.test.mjs`](./test/alio.test.mjs) 또는 [`test/law.test.mjs`](./test/law.test.mjs) 에 케이스 추가
- [ ] 변경한 도구의 description / Zod 스키마 / `tool-registry.ts` 등록을 일관되게 갱신
- [ ] `truncateResponse()` (50KB 제한) 적용 (Critical Rule #5)
- [ ] 사용자에게 노출되는 변경이면 [`CHANGELOG.md`](./CHANGELOG.md) `[Unreleased]` 섹션에 한 줄 추가
- [ ] 외부 의존성 추가 시 [라이선스 호환성 정책](#-라이선스-호환성-정책) 확인 + [`NOTICE`](./NOTICE) 업데이트

---

## 🧭 코드 변경 가이드

### 어디를 변경하는지에 따라 영역이 다릅니다

| 디렉토리 / 파일 | 영역 | 변경 시 주의 |
|---|---|---|
| `src/tools/alio/*`, `src/lib/alio/*`, `src/scripts/alio-sync.ts` | 본 fork 신규 영역 | 자유롭게 변경. ALIO 모듈 패턴(헬퍼 재사용, 순수 로컬 I/O) 따라가기 |
| `src/tools/*` (alio/ 외) | 원작자 자산 (대부분 변경 없이 유지) | 동작 변경 시 `LawApiClient` 시그니처 호환 유지 |
| `src/lib/search-normalizer.ts`, `law-parser.ts`, `three-tier-parser.ts`, `tools/historical-law.ts` | 본 fork 의 **clean-room 재작성 4파일** | 외부 BSL/Source-Available 코드 도입 절대 금지 (Critical Rule #1) |
| `src/lib/api-client.ts`, `query-router.ts`, `cli*.ts` | 원작자 자산 + fork 의 일부 보강 | 자연어 라우팅에 ALIO 패턴이 추가되어 있으니 변경 시 회귀 주의 |
| `*-UPSTREAM.md` (5종) | **원작자 영역 — 절대 수정 금지** | 원작자(@chrisryugj/@Mongmini) 의 v2.2 시점 원문. 무수정 보존 정책 |

### Critical Rules (전체 12개)

코드 변경 전 [`CLAUDE.md § Critical Rules`](./CLAUDE.md#critical-rules-코드-기여자용) 12개 항목 모두 확인. 핵심:

- **Critical Rule #1** — clean-room 재작성된 4파일에 BSL/Source-Available 코드 절대 도입 금지
- **Critical Rule #5** — 모든 도구 출력에 `truncateResponse()` 50KB 제한
- **Critical Rule #8** — STDIO 모드 보호: `console.log/error` 금지, 에러는 `throw`
- **Critical Rule #11** — `src/tools/alio/*` 는 순수 로컬 I/O. 외부 fetch 는 `npm run alio:sync` 배치에서만

### ALIO 도메인 패턴 (신규 도구 추가 시)

- 입력 스키마: Zod object + `findInstitution(idx, ...)` 헬퍼로 기관 찾기 (apbaId / 기관명 양방향)
- 비교 도구의 fallback 체인: `input.institutions` → 미지정 시 `getCollectedInstitutions(idx)` 자동
- 환경변수에 비교 세트를 박아두지 말 것 (사용자 자연어에 위임 — `feedback_alio_framing` 메모리 참고)

---

## ⚖️ 라이선스 호환성 정책

본 프로젝트는 **MIT 단일 라이선스**입니다. 외부 의존성 추가 시 다음 라이선스만 허용:

✅ **허용**: MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0
⚠️ **조건부 허용**: MPL-2.0 (소스 변경 없이 invoke만), Apache-2.0 with NOTICE (NOTICE 파일 갱신 필요)
❌ **금지**: GPL, AGPL, LGPL, BSL (Business Source License), SSPL, Source-Available (Elastic 2.0 등), Commons Clause, 사용자 정의 비표준 라이선스

PR 에서 새 의존성을 추가하면:
1. `npm install <pkg>` 후 `node_modules/<pkg>/LICENSE` 또는 `package.json` 의 `license` 필드 확인
2. 라이선스가 위 ✅ 목록에 있는지 확인
3. [`NOTICE`](./NOTICE) 의 "Bundled / runtime dependencies" 섹션에 한 줄 추가
4. PR 본문에 라이선스 명시

문제가 있는 라이선스를 추가해야만 한다면 **PR 전에 이슈로 먼저 논의**해 주세요.

---

## 🐛 이슈 / PR 작성 가이드

### 좋은 이슈

- **재현 가능한 단계**: 어떤 도구를 어떤 인자로 호출했는지, 어떤 결과를 기대했고 무엇을 얻었는지
- **환경**: Node 버전, OS, ALIO 데이터 수집 여부, `LAW_OC` 설정 여부 (키 자체는 노출 X)
- **로그**: STDIO 모드 사용 시 Claude Desktop 로그(`~/Library/Logs/Claude/mcp-server-korean-law-alio.log`) 의 관련 부분
- **데이터 의존 이슈**: parseError 사례라면 어떤 기관(apbaId) / 어떤 규정(regId) 인지

### 좋은 PR

- **작은 단위로 분리** — 한 PR 에 한 가지 변경
- **테스트 케이스 동반** — `test/*.test.mjs` 에 PASS 가능한 케이스 추가
- **CHANGELOG `[Unreleased]` 갱신** — 사용자에게 노출되는 변경이라면
- **PR 설명**: 변경 동기 (왜 필요한가) → 접근 (어떻게 구현했나) → 검증 (어떻게 확인했나)

---

## 🤝 행동 강령

기본적인 상호 존중을 따라주시면 충분합니다. 정치/종교/개인 신상 공격 등은 삼가주세요.

본 프로젝트는 한국 공공기관 직원, 법무 실무자, 연구자, 개발자 등 다양한 배경의 사용자를 대상으로 합니다 — **편향 없이 어떤 공공기관/주제로든 자유롭게 사용 가능한 일반 도구** 라는 정체성을 유지합니다.

---

## 📚 추가 참고

- [`CLAUDE.md`](./CLAUDE.md) — 코드베이스 전체 가이드 (구조 / Commands / Critical Rules)
- [`ROADMAP.md`](./ROADMAP.md) — 본 fork 의 변경 동기 + 향후 계획
- [`CHANGELOG.md`](./CHANGELOG.md) — fork 이후 변경 이력
- [`TEST-REPORT.md`](./TEST-REPORT.md) — 종합 테스트 결과 (참고용)
- [`docs/API.md`](./docs/API.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) — 상세 레퍼런스
