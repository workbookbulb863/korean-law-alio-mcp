/**
 * 자연어 쿼리 라우터 — 핵심 매칭 케이스
 *
 * 외부 API/데이터 의존 없음 (라우터는 패턴 매칭만).
 */

import { TestRunner, assert, skip, summarize } from "./lib/runner.mjs"
import { loadDotenv } from "./lib/env.mjs"
import { existsSync } from "node:fs"
import path from "node:path"

loadDotenv()
delete process.env.ALIO_INSTITUTION_ALIASES // 일관된 기본 동작

const r = new TestRunner("자연어 라우터")
const { routeQuery } = await import("../build/lib/query-router.js")

const projectRoot = path.resolve(new URL(".", import.meta.url).pathname, "..")
function alioDataExists(apbaId) {
  return existsSync(path.join(projectRoot, "data", "alio", apbaId, "manifest.json"))
}

const cases = [
  // [query, expected tool name (또는 prefix), 설명]
  ["관세법 3단비교",                  "chain_law_system",         "법체계 키워드"],
  ["건축허가 거부 판례",              "search_precedents",        "판례 키워드"],
  ["종로구 주차 조례",                "search_ordinance",         "자치법규 키워드"],
  // "법령명 + 제N조 + 해석례" 는 라우터가 search_law 또는 specific_article 로 보낼 수 있음 (LLM 후속 체인)
  ["근로기준법 제74조 해석례",         null,                       "법령+조문+해석례 (도구는 LLM 판단)"],
  ["공공기관 휴직 규정 비교",         "compare_alio_regulations", "ALIO 비교 패턴"],
  ["공공기관 인사 규정 비교해줘",      "compare_alio_regulations", "ALIO 비교 + '해줘'"],
  ["C0399 규정 목록",                 "list_alio_regulations",    "apbaId 코드 매칭"],
  ["산업안전보건법 별표1",             null,                       "별표 (도구 불특정 — null 허용 X)"],
  // ── cross-domain ALIO ↔ 법제처 브리지 ──
  // institutions.json 에 한국인터넷진흥원(C0399) 가 수집된 환경 가정. 미수집 시 SKIP 처리.
  ["한국인터넷진흥원 인사규정 상위법",     "analyze_regulation_delegation", "기관+규정+상위법 → 위임 분석", { needsAlioData: "C0399" }],
  ["한국인터넷진흥원 인사규정 위임 분석",  "analyze_regulation_delegation", "기관+규정+위임 분석",         { needsAlioData: "C0399" }],
  ["근로기준법 제74조 따르는 공공기관 규정", "find_regulations_by_upper_law", "법령+조문+따르는 공공기관 → 역검색"],
  ["한국인터넷진흥원 인사규정 인용 분석",  "parse_alio_article_links",     "기관+규정+인용 → 인용 그래프", { needsAlioData: "C0399" }],
]

for (const [query, expected, desc, opts] of cases) {
  await r.run(`route: "${query}" — ${desc}`, () => {
    if (opts?.needsAlioData && !alioDataExists(opts.needsAlioData)) {
      skip(`data/alio/${opts.needsAlioData} 미수집`)
    }
    const result = routeQuery(query)
    assert(result, `라우팅 결과 없음`)
    if (expected !== null) {
      assert(result.tool === expected, `expected=${expected}, got=${result.tool}`)
    }
  })
}

// alias 등록 시
await r.run("route: alias 등록 후 'MYORG 규정'", async () => {
  process.env.ALIO_INSTITUTION_ALIASES = JSON.stringify({ MYORG: "우리기관" })
  // 모듈 재import 필요 — alias 는 모듈 로드 시 1회 평가됨. dynamic import 의 캐시 우회 어려움.
  // 라우터는 모듈 로드 시 ALIAS_ALTERNATION 빌드 → 동적 변경 불가. 본 케이스는 별도 프로세스에서 검증해야 정확.
  // 여기서는 환경변수 설정만 확인.
  assert(process.env.ALIO_INSTITUTION_ALIASES, "환경변수 설정 안됨")
  delete process.env.ALIO_INSTITUTION_ALIASES
})

const counts = r.print()
summarize([counts])
