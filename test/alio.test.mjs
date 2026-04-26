/**
 * ALIO 도구 23개 — 함수 직접 호출 기반 테스트
 *
 * data/alio/ 가 없으면 모든 케이스 SKIP.
 * 실제 호출에는 환경변수 불필요 (모두 로컬 파일 기반).
 */

import { TestRunner, assert, assertOk, assertContains, assertMinLength, assertIsError, summarize, skip } from "./lib/runner.mjs"
import { loadDotenv, hasAlioData } from "./lib/env.mjs"

loadDotenv()

const r = new TestRunner("ALIO 도구 (23개)")

if (!hasAlioData()) {
  r.skipAll(
    [
      "search_institution", "list_alio_regulations", "get_alio_regulation",
      "search_alio_regulation_text", "compare_alio_regulations", "get_alio_regulation_history",
      "compare_regulation_timeline", "suggest_alio_benchmark",
      "analyze_regulation_delegation", "find_regulations_by_upper_law",
      "get_alio_statistics", "get_recent_alio_revisions", "get_alio_institution_profile",
      "find_similar_regulations", "suggest_alio_regulation_names", "advanced_alio_search",
      "get_alio_external_links", "get_alio_annexes", "compare_alio_articles",
      "get_batch_alio_regulations", "parse_alio_article_links", "analyze_alio_regulation",
      "chain_alio_benchmark",
    ],
    "data/alio 데이터 없음 — `npm run alio:sync` 필요"
  )
  r.print()
  summarize([{ PASS: 0, FAIL: 0, SKIP: r.results.length }])
}

// ─── 1. search_institution ─────────────────────────────────────
await r.run("search_institution: 코드→이름", async () => {
  const m = await import("../build/tools/alio/search-institution.js")
  const result = await m.searchInstitution(null, { query: "C0001", max: 5 })
  assertOk(result)
  assertContains(result, "C0001")
})
await r.run("search_institution: 이름 부분일치", async () => {
  const m = await import("../build/tools/alio/search-institution.js")
  const result = await m.searchInstitution(null, { query: "진흥원", max: 3 })
  assertOk(result)
  assertContains(result, "진흥원")
})

// ─── 2. list_alio_regulations ─────────────────────────────────
await r.run("list_alio_regulations: 코드 지정", async () => {
  const m = await import("../build/tools/alio/list-regulations.js")
  const result = await m.listAlioRegulations(null, { institution: "C0001", max: 5 })
  assertOk(result)
  assertContains(result, "regId")
})

// ─── 3. get_alio_regulation ───────────────────────────────────
await r.run("get_alio_regulation: 본문 조회", async () => {
  const m = await import("../build/tools/alio/get-regulation.js")
  const result = await m.getAlioRegulation(null, { institution: "C0001", regId: "2461" })
  assertOk(result)
  assertMinLength(result, 100)
})

// ─── 4. search_alio_regulation_text ───────────────────────────
await r.run("search_alio_regulation_text: 키워드 전문검색", async () => {
  const m = await import("../build/tools/alio/search-regulation-text.js")
  const result = await m.searchAlioRegulationText(null, { query: "징계", maxResults: 3, maxPerRegulation: 1 })
  assertOk(result)
  assertContains(result, "징계")
})

// ─── 5. compare_alio_regulations ──────────────────────────────
await r.run("compare_alio_regulations: 토픽 N:N (인자 없음 = 전체 자동)", async () => {
  const m = await import("../build/tools/alio/compare-regulations.js")
  const result = await m.compareAlioRegulations(null, { topic: "휴직", maxPerInstitution: 1 })
  assertOk(result)
  assertMinLength(result, 100)
})
await r.run("compare_alio_regulations: institutions 명시", async () => {
  const m = await import("../build/tools/alio/compare-regulations.js")
  const result = await m.compareAlioRegulations(null, {
    topic: "직제", institutions: ["C0001", "C0002", "C0003"], maxPerInstitution: 1,
  })
  assertOk(result)
})

// ─── 6. get_alio_regulation_history ───────────────────────────
await r.run("get_alio_regulation_history: 개정 이력", async () => {
  const m = await import("../build/tools/alio/regulation-history.js")
  const result = await m.getAlioRegulationHistory(null, { institution: "C0001", regId: "2461" })
  assertOk(result)
})

// ─── 7. compare_regulation_timeline ───────────────────────────
await r.run("compare_regulation_timeline: 토픽 타임라인", async () => {
  const m = await import("../build/tools/alio/compare-timeline.js")
  const result = await m.compareRegulationTimeline(null, { topic: "인사", maxPerInstitution: 1 })
  assertOk(result)
})

// ─── 8. suggest_alio_benchmark ────────────────────────────────
await r.run("suggest_alio_benchmark: 갭 분석", async () => {
  const m = await import("../build/tools/alio/suggest-benchmark.js")
  const result = await m.suggestAlioBenchmark(null, { base: "C0001", max: 5 })
  assertOk(result)
})

// ─── 9. analyze_regulation_delegation ─────────────────────────
await r.run("analyze_regulation_delegation: 위임 추출", async () => {
  const m = await import("../build/tools/alio/analyze-delegation.js")
  const result = await m.analyzeRegulationDelegation(null, { institution: "C0001", regId: "2461" })
  assertOk(result)
})

// ─── 10. find_regulations_by_upper_law ────────────────────────
await r.run("find_regulations_by_upper_law: 역방향 검색", async () => {
  const m = await import("../build/tools/alio/find-by-upper-law.js")
  const result = await m.findRegulationsByUpperLaw(null, { lawName: "공공기관의 운영에 관한 법률", maxResults: 5 })
  assertOk(result)
})

// ─── 11. get_alio_statistics (신규) ───────────────────────────
await r.run("get_alio_statistics: 데이터 개관", async () => {
  const m = await import("../build/tools/alio/statistics.js")
  const result = await m.getAlioStatistics(null, {
    topN: 5, byType: true, byMinistry: true, byCategory: true,
  })
  assertOk(result)
  assertContains(result, "총 공공기관")
  assertContains(result, "기관 유형 분포")
  assertContains(result, "주무부처 분포")
  assertContains(result, "category")
})

// ─── 12. get_recent_alio_revisions (신규) ─────────────────────
await r.run("get_recent_alio_revisions: 최근 365일 인사", async () => {
  const m = await import("../build/tools/alio/recent-revisions.js")
  const result = await m.getRecentAlioRevisions(null, { days: 365, topic: "인사", max: 5 })
  assertOk(result)
  assertContains(result, "최근 365일")
})

// ─── 13. get_alio_institution_profile (신규) ──────────────────
await r.run("get_alio_institution_profile: 코드", async () => {
  const m = await import("../build/tools/alio/institution-profile.js")
  const result = await m.getAlioInstitutionProfile(null, {
    institution: "C0001", topCategories: 5, recentRevisions: 3,
  })
  assertOk(result)
  assertContains(result, "기관 메타")
  assertContains(result, "규정 통계")
})
await r.run("get_alio_institution_profile: 이름 검색", async () => {
  const m = await import("../build/tools/alio/institution-profile.js")
  const result = await m.getAlioInstitutionProfile(null, {
    institution: "한국인터넷진흥원", topCategories: 5, recentRevisions: 3,
  })
  assertOk(result)
  assertContains(result, "C0399")
})

// ─── 14. find_similar_regulations (신규) ──────────────────────
await r.run("find_similar_regulations: 직제규정 유사", async () => {
  const m = await import("../build/tools/alio/find-similar.js")
  const result = await m.findSimilarRegulations(null, {
    institution: "C0001", title: "직제규정", threshold: 0.4, max: 5, excludeBase: true,
  })
  assertOk(result)
  assertContains(result, "유사도")
})

// ─── 15. suggest_alio_regulation_names (신규) ────────────────
await r.run("suggest_alio_regulation_names: '인사' 자동완성", async () => {
  const m = await import("../build/tools/alio/suggest-regulation-names.js")
  const result = await m.suggestAlioRegulationNames(null, { query: "인사", max: 5 })
  assertOk(result)
  assertContains(result, "인사")
})
await r.run("suggest_alio_regulation_names: 기관 제한", async () => {
  const m = await import("../build/tools/alio/suggest-regulation-names.js")
  const result = await m.suggestAlioRegulationNames(null, { query: "직제", institution: "C0001", max: 3 })
  assertOk(result)
})

// ─── 16. advanced_alio_search (신규) ─────────────────────────
await r.run("advanced_alio_search: category=K1100 + recent 정렬", async () => {
  const m = await import("../build/tools/alio/advanced-search.js")
  const result = await m.advancedAlioSearch(null, { category: "K1100", sortBy: "recent", max: 5 })
  assertOk(result)
  assertContains(result, "K1100")
})
await r.run("advanced_alio_search: 주무부처 + 유형 복합", async () => {
  const m = await import("../build/tools/alio/advanced-search.js")
  const result = await m.advancedAlioSearch(null, {
    ministry: "과학기술", type: "준정부", sortBy: "title", max: 5,
  })
  assertOk(result)
})

// ─── 17. get_alio_external_links (신규) ──────────────────────
await r.run("get_alio_external_links: 원본 + 다운로드 URL", async () => {
  const m = await import("../build/tools/alio/external-links.js")
  const result = await m.getAlioExternalLinks(null, {
    institution: "C0001", regId: "2461", includeRevisions: true,
  })
  assertOk(result)
  assertContains(result, "alio.go.kr")
  assertContains(result, "rulefiledown.json")
})

// ─── 18. get_alio_annexes (신규) ─────────────────────────────
await r.run("get_alio_annexes: 별표 목록 (없어도 OK)", async () => {
  const m = await import("../build/tools/alio/annexes.js")
  const result = await m.getAlioAnnexes(null, {
    institution: "C0001", regId: "2461", listOnly: true,
  })
  // 별표가 0건이어도 OK 응답이어야 함 (isError=false)
  assertOk(result)
})

// ─── 19. compare_alio_articles (신규) ────────────────────────
await r.run("compare_alio_articles: 두 규정 제1조 1:1", async () => {
  const m = await import("../build/tools/alio/compare-articles.js")
  const result = await m.compareAlioArticles(null, {
    pair: [
      { institution: "C0001", regId: "2461" },
      { institution: "C0005", title: "직제규정" },
    ],
    article: "제1조",
  })
  assertOk(result)
  assertContains(result, "제1조")
})

// ─── 20. get_batch_alio_regulations (신규) ───────────────────
await r.run("get_batch_alio_regulations: 2건 일괄 + article 필터", async () => {
  const m = await import("../build/tools/alio/batch-regulations.js")
  const result = await m.getBatchAlioRegulations(null, {
    items: [
      { institution: "C0001", regId: "2461", article: "제1조" },
      { institution: "C0005", title: "직제규정", article: "제1조" },
    ],
    bodyChars: 500,
  })
  assertOk(result)
  assertContains(result, "성공")
})

// ─── 21. parse_alio_article_links (신규) ─────────────────────
await r.run("parse_alio_article_links: 조문 참조 추출", async () => {
  const m = await import("../build/tools/alio/parse-article-links.js")
  const result = await m.parseAlioArticleLinks(null, {
    institution: "C0001", regId: "2461", max: 10,
  })
  assertOk(result)
  assertContains(result, "참조")
})

// ─── 22. analyze_alio_regulation (신규) ──────────────────────
await r.run("analyze_alio_regulation: 메타 + 구조 + 목차", async () => {
  const m = await import("../build/tools/alio/analyze-regulation.js")
  const result = await m.analyzeAlioRegulation(null, {
    institution: "C0001", regId: "2461", showTOC: true, maxTocItems: 5,
  })
  assertOk(result)
  assertContains(result, "메타")
  assertContains(result, "구조")
  assertContains(result, "조문 수")
})

// ─── 23. chain_alio_benchmark (신규) ─────────────────────────
await r.run("chain_alio_benchmark: 종합 (프로파일+토픽+갭)", async () => {
  const m = await import("../build/tools/alio/chain-benchmark.js")
  const result = await m.chainAlioBenchmark(null, {
    institution: "C0399", topic: "징계", max: 5, similarityThreshold: 0.4,
  })
  assertOk(result)
  assertContains(result, "기관 프로파일")
  assertContains(result, "동종 기관")
})

// ─── 에러 케이스 ──────────────────────────────────────────────
await r.run("(에러) search_institution: 존재 안 하는 코드", async () => {
  const m = await import("../build/tools/alio/search-institution.js")
  const result = await m.searchInstitution(null, { query: "C9999" })
  // 결과 없음을 텍스트로 표현 — isError 일 수도 OK 일 수도. 둘 다 허용.
  assert(result?.content?.[0]?.text, "응답 텍스트 없음")
})
await r.run("(에러) get_alio_regulation: 존재 안 하는 regId", async () => {
  const m = await import("../build/tools/alio/get-regulation.js")
  const result = await m.getAlioRegulation(null, { institution: "C0001", regId: "99999999" })
  assertIsError(result)
})

// ─── 깊이 케이스: 옵션 인자 조합 / 양방향 / fallback ──────
await r.run("(깊이) get_alio_regulation: article 인자 (특정 조문만)", async () => {
  const m = await import("../build/tools/alio/get-regulation.js")
  const result = await m.getAlioRegulation(null, { institution: "C0001", regId: "2461", article: "제1조" })
  assertOk(result)
  assertContains(result, "제1조")
})

await r.run("(깊이) advanced_alio_search: 복합 필터 (분류+부처+키워드)", async () => {
  const m = await import("../build/tools/alio/advanced-search.js")
  const result = await m.advancedAlioSearch(null, {
    category: "K1100", ministry: "과학기술", query: "감사", sortBy: "recent", max: 5,
  })
  assertOk(result)
})

await r.run("(깊이) get_alio_annexes: annexNumber 특정", async () => {
  const m = await import("../build/tools/alio/annexes.js")
  const result = await m.getAlioAnnexes(null, { institution: "C0001", regId: "2461", annexNumber: 1 })
  assertOk(result)
})

await r.run("(깊이) get_batch_alio_regulations: 4건 + 일부 article", async () => {
  const m = await import("../build/tools/alio/batch-regulations.js")
  const result = await m.getBatchAlioRegulations(null, {
    items: [
      { institution: "C0001", regId: "2461", article: "제1조" },
      { institution: "C0001", regId: "2461" },
      { institution: "C0005", title: "직제규정", article: "제1조" },
      { institution: "C0005", title: "직제규정" },
    ],
    bodyChars: 300,
  })
  assertOk(result)
  assertContains(result, "성공 4")
})

await r.run("(깊이) parse_alio_article_links: 특정 조문만 분석", async () => {
  const m = await import("../build/tools/alio/parse-article-links.js")
  const result = await m.parseAlioArticleLinks(null, {
    institution: "C0001", regId: "2461", article: "제1조", max: 5,
  })
  assertOk(result)
})

await r.run("(깊이) get_recent_alio_revisions: 30일 + 토픽 필터", async () => {
  const m = await import("../build/tools/alio/recent-revisions.js")
  const result = await m.getRecentAlioRevisions(null, { days: 30, topic: "직제", max: 5 })
  assertOk(result)
})

await r.run("(깊이) chain_alio_benchmark: 토픽 미지정 (분류 분포 위주)", async () => {
  const m = await import("../build/tools/alio/chain-benchmark.js")
  const result = await m.chainAlioBenchmark(null, { institution: "C0001", max: 5, similarityThreshold: 0.5 })
  assertOk(result)
  assertContains(result, "기관 프로파일")
})

// ─── 통합 시나리오: search → list → get → analyze 체인 (사용자 흐름) ──
await r.run("(통합) 시나리오: 기관 검색 → 규정 목록 → 본문 → 분석", async () => {
  const search = await import("../build/tools/alio/search-institution.js")
  const list = await import("../build/tools/alio/list-regulations.js")
  const analyze = await import("../build/tools/alio/analyze-regulation.js")

  // 1. 기관 검색 ('진흥원' → 매칭 다수)
  const r1 = await search.searchInstitution(null, { query: "진흥원", max: 1 })
  assertOk(r1)
  const apbaId = /\[(C\d{4})\]/.exec(r1.content[0].text)?.[1]
  assert(apbaId, "검색 결과에서 apbaId 추출 실패")

  // 2. 그 기관의 규정 목록 (첫 1건)
  const r2 = await list.listAlioRegulations(null, { institution: apbaId, max: 1 })
  assertOk(r2)
  const regId = /regId=(\d+)/.exec(r2.content[0].text)?.[1]
  assert(regId, "규정 목록에서 regId 추출 실패")

  // 3. 그 규정 분석 (메타 + 구조)
  const r3 = await analyze.analyzeAlioRegulation(null, { institution: apbaId, regId, showTOC: true, maxTocItems: 3 })
  assertOk(r3)
  assertContains(r3, "메타")
  assertContains(r3, "조문 수")
})

await r.run("(통합) 시나리오: 토픽 → compare → similar (사용자 벤치마킹 흐름)", async () => {
  const compare = await import("../build/tools/alio/compare-regulations.js")
  const similar = await import("../build/tools/alio/find-similar.js")

  // 1. 토픽 비교 (수집된 전체 자동)
  const r1 = await compare.compareAlioRegulations(null, {
    topic: "직제", institutions: ["C0001", "C0002", "C0003"], maxPerInstitution: 1,
  })
  assertOk(r1)

  // 2. 그 중 한 규정과 유사한 다른 기관 규정 찾기
  const r2 = await similar.findSimilarRegulations(null, {
    institution: "C0001", title: "직제규정", threshold: 0.6, max: 3, excludeBase: true,
  })
  assertOk(r2)
})

const counts = r.print()
summarize([counts])
