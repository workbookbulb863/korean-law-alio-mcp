# Changelog — `korean-law-alio-mcp`

> 본 fork 는 2026-04-25 일자로 [chrisryugj/korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp) v2.2 에서 fork 되었습니다.
> **본 파일은 fork 이후의 변경 이력만 담습니다.** v2.2.0 까지의 원작자 변경 이력은 [CHANGELOG-UPSTREAM.md](./CHANGELOG-UPSTREAM.md) 참고.

---

## [1.0.0] - 2026-04-26

> **Fork + 리네이밍**: `korean-law-mcp` → `korean-law-alio-mcp`
> 법제처 87개 도구 위에 ALIO 공공기관 내부규정 통합 + 라이선스 위생 + 일반화 작업.
> **첫 안정 릴리스** — 141 cases 자동 테스트 통과 + per-regulation timeout/retry 안전망 + 자동 docling fallback 통합. SemVer 1.0 으로 안정 API 약속.

### Added — ALIO 공공기관 내부규정 통합

- **데이터 파이프라인** (`npm run alio:sync`)
  - ALIO 공시 전체 ~344개 공공기관 / 35,208건 내부규정 수집
  - manifest.json 기반 incremental sync (콘텐츠 해시 비교)
  - 실패/재시도/중단복구 (`--resume`, `--retry-failed`, `--retry-fallback`)
- **MCP 도구 23개** — 법제처 87개 도구 패턴을 ALIO 데이터에 적용 (중복 도메인은 법제처 도구 그대로 재사용):

  *조회·검색·자동완성*
  - `search_institution` — 기관명⇄apbaId 양방향 검색
  - `list_alio_regulations` — 기관별 규정 목록
  - `get_alio_regulation` — 규정 본문 / 특정 조문 조회
  - `search_alio_regulation_text` — 전체 규정 본문 키워드 전문검색
  - `suggest_alio_regulation_names` — 규정 제목 자동완성/부분일치
  - `advanced_alio_search` — 분류·기관유형·주무부처·기간·키워드 복합 필터

  *비교·분석*
  - `compare_alio_regulations` — 토픽 기준 N:N 기관간 조문 비교
  - `compare_alio_articles` — 두 규정의 같은 조문 1:1 정밀 비교
  - `compare_regulation_timeline` — 기관간 개정 이력 비교
  - `find_similar_regulations` — 기준 규정 1건과 유사한 다른 기관 규정 1:N
  - `suggest_alio_benchmark` — 우리 기관에 없는 동종 기관 규정 제안

  *이력·변경 모니터링*
  - `get_alio_regulation_history` — 규정 개정 이력
  - `get_recent_alio_revisions` — 최근 N일 내 개정 규정 타임라인

  *법령 연계*
  - `analyze_regulation_delegation` — 상위 법령 자동 추출 + 법제처 검색 연계
  - `find_regulations_by_upper_law` — 상위 법령 역방향 검색

  *데이터 개관·메타*
  - `get_alio_statistics` — 수집 데이터 통계 (기관·규정 수, 분류 분포, 개정 빈도)
  - `get_alio_institution_profile` — 한 기관의 규정 체계 요약
  - `analyze_alio_regulation` — 한 규정의 메타 + 구조(조문 수, 별표 수) + 목차

  *본문 구조·연결*
  - `get_alio_annexes` — 규정 본문에서 [별표 N] 추출
  - `parse_alio_article_links` — 본문의 "제N조" 참조 추출 + 위치 매칭
  - `get_alio_external_links` — ALIO 원본 페이지 + 첨부 다운로드 링크
  - `get_batch_alio_regulations` — 여러 규정/조문 일괄 조회 (최대 20건)

  *체인 (도구 조합)*
  - `chain_alio_benchmark` — 프로파일 + 토픽 매칭 + 동종 기관 갭 분석을 한 번에
- **6단계 파싱 폴백 체인**
  1. kordoc 직접 (HWP/HWPX/PDF) — 일반 케이스 34,908건
  2. docling + tesseract OCR — 스캔 이미지 PDF 261건
  3. soffice + docling DOCX — HWP 3.0 구포맷 10건 (본문만)
  4. soffice + docling XLSX — Excel 별표 1건
  5. JSZip 재귀 언랩 + concat — 묶음 ZIP 1건
  6. parseError 기록 — 24건 (DRM·빈 스캔본 등 원본 한계)
  - **최종 파싱 성공률: 99.923%** (35,181 / 35,208)
- **OCR 출처 배지** — MCP 응답에 `[OCR:docling]` 등 변환 출처 표시
- 자연어 query-router 에 ALIO 키워드 패턴 추가 (공공기관 약어, "공공기관 규정 비교" 등)

### Added — 외부 도구 의존성 (선택)

- LibreOffice (`soffice`) — HWP 3.0 / Excel 변환
- docling (Python CLI) — OCR / DOCX / XLSX 파싱
- tesseract + tesseract-lang — OCR 엔진 (한글)

### Changed

- **패키지명** `korean-law-mcp` → `korean-law-alio-mcp`
- **bin** `korean-law-mcp` / `korean-law` → `korean-law-alio-mcp` / `korean-law-alio`
- **kordoc 메이저 업그레이드** `1.6.1` → `2.5.2` (PDF "subOps is not iterable" 등 다수 버그 수정 + hwpml/xlsx/docx 추가 지원)
- **자체 파서 5개 → kordoc 통합 파서로 교체** — `lib/hwpx-parser.ts`, `lib/hwp5-parser.ts`, `lib/pdf-parser.ts` 등 제거. `lib/annex-file-parser.ts` 가 [kordoc](https://github.com/chrisryugj/kordoc) 으로 위임
- **ALIO 비교 도구 — 사용자 자연어에 위임**: `institutions`/`peers` 인자 미지정 시 수집된 전체 기관 자동 비교. 비교 세트를 환경변수에 박지 않음 (사용자가 "A·B·C 기관과 비교", "랜덤", "전체" 같이 자유롭게 표현 → LLM이 인자 만들거나 비움)
- `data/alio/` 디렉터리 추가 + `.gitignore` 등록 (1.1GB 재생성 가능)

### Security / License Hygiene

- **4개 도메인 파일 clean-room 재작성** — BSL 1.1 라이선스 코드와의 결합 회피
  - `src/lib/search-normalizer.ts` — 법령 검색어 정규화·약칭 해결
  - `src/lib/law-parser.ts` — JO 코드(AAAABB / AABBCC) 변환
  - `src/lib/three-tier-parser.ts` — 법제처 3단비교 응답 파서
  - `src/tools/historical-law.ts` — 연혁법령 검색·본문 조회
- 각 파일은 caller 시그니처 + 법제처 OpenAPI 공개 명세만 참조하여 작성
- 약칭 사전은 법제처 공식 약칭 페이지(공개 자료)에서 직접 정리
- 결과: 본 프로젝트는 외부 BSL/Source-Available 코드를 포함하지 않음. 모든 자체 코드는 **MIT** 단일 라이선스

### Docs

- 한글 README 기본화 (`README.md` = 한글, `README-EN.md` = English)
- 인트로 데모 GIF 추가 + README 참조
- 원작자 보존 문서 분리: [CLAUDE-UPSTREAM.md](./CLAUDE-UPSTREAM.md), [CHANGELOG-UPSTREAM.md](./CHANGELOG-UPSTREAM.md), [ROADMAP-UPSTREAM.md](./ROADMAP-UPSTREAM.md)
- **두 운영 모드 정책 명시** ([NOTICE](./NOTICE) "Data sources" 섹션):
  - Local MCP (STDIO) — 사용자가 자기 환경에서 sync, 모든 책임 사용자
  - Remote MCP (HTTP/SSE) — 운영자(scvcoder) 가 비영리·자발적으로 **무료** 운영. sync 주기를 약속하지 않으며(best-effort), 모든 응답에 `fetchedAt` 와 `sourceDetailUrl` 보존하여 사용자가 원본 검증 가능. 스냅샷과 ALIO 현재 게시본의 차이로 인한 결과는 전적으로 사용자 책임. AS-IS / AS-AVAILABLE 제공, 한국 민법상 무상 제공자 면책 범위에서 모든 책임 배제(고의·중과실 제외)
  - 두 모드 모두 저작권법 §24-2 + 공공데이터법 §3 자유이용 원칙 하에 동작

### Known Limitations

- **DRM 암호화** 7건 (DRMONE / DOCUMENTSAFER) — 원본 기관 정책에 의존, 우리가 해결 불가
- **빈 스캔 PDF** 16건 — OCR이 0~수자만 추출 (원본 품질 한계)
- **HWP 3.0 표** — LibreOffice 필터가 표 구조를 변환 못함 (본문만 복원)
- 위 27건이 35,208건 중 미파싱 잔존 → 최종 파싱 성공률 **99.923%**
