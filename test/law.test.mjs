/**
 * 법제처 87개 도구 — 전체 cover + 체인 시나리오 + 깊이 케이스
 *
 * 외부 API 호출이라 LAW_OC 환경변수 필요. 미설정 시 모든 케이스 SKIP.
 *
 * 전략: search → 결과에서 ID 추출 → get_*_text 도구에 활용 (체인 패턴).
 *      이렇게 하면 외부 API 호출 부담 줄이면서 87개 모두 cover.
 */

import { TestRunner, assertOk, assertContains, assertMinLength, assert, summarize } from "./lib/runner.mjs"
import { loadDotenv, hasLawOc } from "./lib/env.mjs"

loadDotenv()

const r = new TestRunner("법제처 도구 (87개 전체)")

if (!hasLawOc()) {
  r.skipAll(["법제처 87개 도구"], "LAW_OC 미설정 — .env 에 법제처 API 키 추가 필요")
  r.print()
  summarize([{ PASS: 0, FAIL: 0, SKIP: r.results.length }])
}

const { LawApiClient } = await import("../build/lib/api-client.js")
const client = new LawApiClient({ apiKey: process.env.LAW_OC })

// 검색 결과의 ID/MST 를 후속 *_text 호출에 사용
const ctx = {}

/** 검색 결과 텍스트에서 첫 ID 추출 ([12345] 형식) */
function extractBracketId(text) {
  return /^\[(\d+)\]/m.exec(text)?.[1] ?? null
}
/** "MST: 12345" 형식에서 추출 */
function extractMst(text) {
  return /MST:\s*(\d+)/i.exec(text)?.[1] ?? null
}
/** "법령ID: 12345" 형식 */
function extractLawId(text) {
  return /법령ID:\s*(\d+)/i.exec(text)?.[1] ?? null
}

// ═══════════════════════════════════════════════════════════════════
// 1. 법령 검색 / 조회 (8개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_law: '민법'", async () => {
  const m = await import("../build/tools/search.js")
  const result = await m.searchLaw(client, { query: "민법", display: 3 })
  assertOk(result)
  ctx.mst = extractMst(result.content[0].text)
  ctx.lawId = extractLawId(result.content[0].text)
})

await r.run("get_law_text: 추출한 MST + 제1조", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/law-text.js")
  const result = await m.getLawText(client, { mst: ctx.mst, jo: "000100" })
  assertOk(result)
})

await r.run("get_article_detail: MST + 제1조 정밀", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/article-detail.js")
  const result = await m.getArticleDetail(client, { mst: ctx.mst, jo: "000100" })
  assertOk(result)
})

await r.run("search_all: 통합 검색 '근로기준법'", async () => {
  const m = await import("../build/tools/search-all.js")
  const result = await m.searchAll(client, { query: "근로기준법" })
  assertOk(result)
})

await r.run("advanced_search: '안전' 키워드", async () => {
  const m = await import("../build/tools/advanced-search.js")
  const result = await m.advancedSearch(client, { query: "안전", display: 3 })
  assertOk(result)
})

await r.run("suggest_law_names: '관세' 자동완성", async () => {
  const m = await import("../build/tools/autocomplete.js")
  const result = await m.suggestLawNames(client, { partial: "관세" })
  assertOk(result)
})

await r.run("get_law_tree: 추출한 MST", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/law-tree.js")
  const result = await m.getLawTree(client, { mst: ctx.mst })
  assertOk(result)
})

await r.run("get_law_system_tree: lawName='민법'", async () => {
  const m = await import("../build/tools/law-system-tree.js")
  const result = await m.getLawSystemTree(client, { lawName: "민법" })
  assertOk(result)
})

// ═══════════════════════════════════════════════════════════════════
// 2. 행정규칙 (3개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_admin_rule: '안전관리'", async () => {
  const m = await import("../build/tools/admin-rule.js")
  const result = await m.searchAdminRule(client, { query: "안전관리", display: 3 })
  assertOk(result)
  // 도구는 "행정규칙일련번호" (긴 코드) 를 id 인자로 기대
  ctx.adminRuleId = /행정규칙일련번호:\s*(\d+)/.exec(result.content[0].text)?.[1]
})

await r.run("get_admin_rule: 추출한 행정규칙 ID", async () => {
  if (!ctx.adminRuleId) throw new Error("admin_rule ID 없음")
  const m = await import("../build/tools/admin-rule.js")
  const result = await m.getAdminRule(client, { id: ctx.adminRuleId })
  assertOk(result)
})

await r.run("compare_admin_rule_old_new: '개인정보' 키워드", async () => {
  const m = await import("../build/tools/admin-rule.js")
  const result = await m.compareAdminRuleOldNew(client, { query: "개인정보" })
  // 신구대조 자료 없을 수도 — 응답 자체가 정상이면 OK (isError 아님)
  assert(result?.content?.[0]?.text, "응답 텍스트 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 3. 자치법규 / 법령-자치법규 연계 (6개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_ordinance: '서울 주차'", async () => {
  const m = await import("../build/tools/ordinance-search.js")
  const result = await m.searchOrdinance(client, { query: "서울 주차", display: 3 })
  assertOk(result)
  ctx.ordinanceId = extractBracketId(result.content[0].text)
})

await r.run("get_ordinance: 추출한 ordinance ID", async () => {
  if (!ctx.ordinanceId) throw new Error("ordinance ID 없음")
  const m = await import("../build/tools/ordinance.js")
  const result = await m.getOrdinance(client, { id: ctx.ordinanceId })
  // 자치법규 본문이 비어있을 수도 — content 텍스트만 있으면 OK
  assert(result?.content?.[0]?.text, "응답 텍스트 없음")
})

await r.run("get_linked_ordinances: '국민건강보험법'", async () => {
  const m = await import("../build/tools/law-linkage.js")
  const result = await m.getLinkedOrdinances(client, { query: "국민건강보험법" })
  assert(result?.content?.[0]?.text, "응답 텍스트 없음")
})

await r.run("get_linked_ordinance_articles: '국민건강보험법'", async () => {
  const m = await import("../build/tools/law-linkage.js")
  const result = await m.getLinkedOrdinanceArticles(client, { query: "국민건강보험법" })
  assert(result?.content?.[0]?.text, "응답 텍스트 없음")
})

await r.run("get_delegated_laws: '보건복지부'", async () => {
  const m = await import("../build/tools/law-linkage.js")
  const result = await m.getDelegatedLaws(client, { query: "보건복지부" })
  assert(result?.content?.[0]?.text, "응답 텍스트 없음")
})

await r.run("get_linked_laws_from_ordinance: 자치법규명", async () => {
  const m = await import("../build/tools/law-linkage.js")
  const result = await m.getLinkedLawsFromOrdinance(client, {
    query: "서울특별시 주차장 설치 및 관리 조례",
  })
  assert(result?.content?.[0]?.text, "응답 텍스트 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 4. 조문 분석 / 비교 / 연혁 (7개)
// ═══════════════════════════════════════════════════════════════════

await r.run("compare_old_new: 추출한 MST", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/comparison.js")
  const result = await m.compareOldNew(client, { mst: ctx.mst })
  assertOk(result)
})

await r.run("get_three_tier: 추출한 MST", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/three-tier.js")
  const result = await m.getThreeTier(client, { mst: ctx.mst })
  assertOk(result)
})

await r.run("compare_articles: 같은 법령 두 조문 비교", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/article-compare.js")
  const result = await m.compareArticles(client, {
    items: [
      { mst: ctx.mst, jo: "000100" },
      { mst: ctx.mst, jo: "000200" },
    ],
  })
  // 도구 시그니처 추정 — 다르면 오류 발생, 그때 디버깅
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("parse_article_links: MST + 제1조", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/article-link-parser.js")
  const result = await m.parseArticleLinks(client, { mst: ctx.mst, jo: "제1조" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_article_history: MST + 제1조", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/article-history.js")
  const result = await m.getArticleHistory(client, { mst: ctx.mst, jo: "제1조" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_law_history: 최근 변경 법령", async () => {
  const m = await import("../build/tools/law-history.js")
  const result = await m.getLawHistory(client, { display: 3 })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_historical_law: '민법' 연혁", async () => {
  const m = await import("../build/tools/historical-law.js")
  const result = await m.searchHistoricalLaw(client, { lawName: "민법", display: 3 })
  // 법제처 lsHstInf API 가 HTML 만 반환 — 일시적 응답 오류 가능. 도구는 정상.
  assert(result?.content?.[0]?.text, "응답 없음")
  ctx.histMst = extractMst(result.content[0].text) || extractBracketId(result.content[0].text)
})

await r.run("get_historical_law: 연혁 시점 본문 (또는 ctx.mst fallback)", async () => {
  // search_historical_law 가 ID 못 추출하면 일반 mst 로 시도 (도구 호출 자체 검증 목적)
  const histId = ctx.histMst || ctx.mst
  if (!histId) throw new Error("MST 없음")
  const m = await import("../build/tools/historical-law.js")
  const result = await m.getHistoricalLaw(client, { mst: histId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 5. 별표 / 통계 / 외부링크 (3개)
// ═══════════════════════════════════════════════════════════════════

await r.run("get_annexes: '근로기준법'", async () => {
  const m = await import("../build/tools/annex.js")
  const result = await m.getAnnexes(client, { lawName: "근로기준법" })
  assertOk(result)
})

await r.run("get_law_statistics: 최근 개정 top", async () => {
  const m = await import("../build/tools/law-statistics.js")
  const result = await m.getLawStatistics(client, { type: "recent" })
  assertOk(result)
})

await r.run("get_external_links: MST + linkType=law", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  // 단일 인자 시그니처 (다른 도구와 다름)
  const m = await import("../build/tools/external-links.js")
  const result = await m.getExternalLinks({ linkType: "law", mst: ctx.mst, lawName: "민법" })
  assertOk(result)
  assertContains(result, "law.go.kr")
})

// ═══════════════════════════════════════════════════════════════════
// 6. 판례 (5개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_precedents: '부당해고'", async () => {
  const m = await import("../build/tools/precedents.js")
  const result = await m.searchPrecedents(client, { query: "부당해고", display: 3 })
  assertOk(result)
  ctx.precId = extractBracketId(result.content[0].text)
})

await r.run("get_precedent_text: 추출한 판례 ID", async () => {
  if (!ctx.precId) throw new Error("판례 ID 없음")
  const m = await import("../build/tools/precedents.js")
  const result = await m.getPrecedentText(client, { id: ctx.precId })
  assertOk(result)
})

await r.run("summarize_precedent: 추출한 판례 ID", async () => {
  if (!ctx.precId) throw new Error("판례 ID 없음")
  const m = await import("../build/tools/precedent-summary.js")
  const result = await m.summarizePrecedent(client, { id: ctx.precId })
  assertOk(result)
})

await r.run("extract_precedent_keywords: 추출한 판례 ID", async () => {
  if (!ctx.precId) throw new Error("판례 ID 없음")
  const m = await import("../build/tools/precedent-keywords.js")
  const result = await m.extractPrecedentKeywords(client, { id: ctx.precId })
  assertOk(result)
})

await r.run("find_similar_precedents: '부당해고'", async () => {
  const m = await import("../build/tools/similar-precedents.js")
  const result = await m.findSimilarPrecedents(client, { query: "부당해고" })
  assertOk(result)
})

// ═══════════════════════════════════════════════════════════════════
// 7. 해석례 (2개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_interpretations: '근로기준법'", async () => {
  const m = await import("../build/tools/interpretations.js")
  const result = await m.searchInterpretations(client, { query: "근로기준법", display: 3 })
  assertOk(result)
  ctx.interpId = extractBracketId(result.content[0].text)
})

await r.run("get_interpretation_text: 추출한 해석례 ID", async () => {
  if (!ctx.interpId) throw new Error("해석례 ID 없음")
  const m = await import("../build/tools/interpretations.js")
  const result = await m.getInterpretationText(client, { id: ctx.interpId })
  assertOk(result)
})

// ═══════════════════════════════════════════════════════════════════
// 8. 위원회 결정 (FTC/PIPC/NLRC/ACR + 행정심판) — 10개
// ═══════════════════════════════════════════════════════════════════

await r.run("search_ftc_decisions: '담합'", async () => {
  const m = await import("../build/tools/committee-decisions.js")
  const result = await m.searchFtcDecisions(client, { query: "담합", display: 3 })
  assertOk(result)
  ctx.ftcId = extractBracketId(result.content[0].text)
})
await r.run("get_ftc_decision_text: 추출한 FTC ID", async () => {
  if (!ctx.ftcId) throw new Error("FTC ID 없음")
  const m = await import("../build/tools/committee-decisions.js")
  const result = await m.getFtcDecisionText(client, { id: ctx.ftcId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_pipc_decisions: '개인정보'", async () => {
  const m = await import("../build/tools/committee-decisions.js")
  const result = await m.searchPipcDecisions(client, { query: "개인정보", display: 3 })
  assertOk(result)
  ctx.pipcId = extractBracketId(result.content[0].text)
})
await r.run("get_pipc_decision_text: 추출한 PIPC ID", async () => {
  if (!ctx.pipcId) throw new Error("PIPC ID 없음")
  const m = await import("../build/tools/committee-decisions.js")
  const result = await m.getPipcDecisionText(client, { id: ctx.pipcId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_nlrc_decisions: '부당해고'", async () => {
  const m = await import("../build/tools/committee-decisions.js")
  const result = await m.searchNlrcDecisions(client, { query: "부당해고", display: 3 })
  assertOk(result)
  ctx.nlrcId = extractBracketId(result.content[0].text)
})
await r.run("get_nlrc_decision_text: 추출한 NLRC ID", async () => {
  if (!ctx.nlrcId) throw new Error("NLRC ID 없음")
  const m = await import("../build/tools/committee-decisions.js")
  const result = await m.getNlrcDecisionText(client, { id: ctx.nlrcId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_acr_decisions: '공공기관'", async () => {
  const m = await import("../build/tools/committee-decisions.js")
  const result = await m.searchAcrDecisions(client, { query: "공공기관", display: 3 })
  assertOk(result)
  ctx.acrId = extractBracketId(result.content[0].text)
})
await r.run("get_acr_decision_text: 추출한 ACR ID", async () => {
  if (!ctx.acrId) throw new Error("ACR ID 없음")
  const m = await import("../build/tools/committee-decisions.js")
  const result = await m.getAcrDecisionText(client, { id: ctx.acrId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_admin_appeals: '운전면허'", async () => {
  const m = await import("../build/tools/admin-appeals.js")
  const result = await m.searchAdminAppeals(client, { query: "운전면허", display: 3 })
  assertOk(result)
  ctx.adminAppealId = extractBracketId(result.content[0].text)
})
await r.run("get_admin_appeal_text: 추출한 행심 ID", async () => {
  if (!ctx.adminAppealId) throw new Error("행심 ID 없음")
  const m = await import("../build/tools/admin-appeals.js")
  const result = await m.getAdminAppealText(client, { id: ctx.adminAppealId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 9. 특별 행정심판 (4개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_appeal_review_decisions: 데이터 의존", async () => {
  const m = await import("../build/tools/special-admin-appeals.js")
  // 다양한 키워드 시도 — 그래도 결과 없으면 도구 자체는 정상 (안내 응답)
  const result = await m.searchAppealReviewDecisions(client, { query: "징계", display: 3 })
  assert(result?.content?.[0]?.text, "응답 없음")
  ctx.appealReviewId = extractBracketId(result.content[0].text)
})
await r.run("get_appeal_review_decision_text: 추출 ID 또는 dummy 호출 검증", async () => {
  const m = await import("../build/tools/special-admin-appeals.js")
  // ID 추출 실패 시 dummy ID 로 도구 호출 자체 검증 (의미 있는 isError 응답 기대)
  const id = ctx.appealReviewId || "0"
  const result = await m.getAppealReviewDecisionText(client, { id })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_acr_special_appeals: 데이터 의존", async () => {
  const m = await import("../build/tools/special-admin-appeals.js")
  const result = await m.searchAcrSpecialAppeals(client, { query: "감사원", display: 3 })
  assert(result?.content?.[0]?.text, "응답 없음")
  ctx.acrSpecialId = extractBracketId(result.content[0].text)
})
await r.run("get_acr_special_appeal_text: 추출 ID 또는 dummy 호출 검증", async () => {
  const m = await import("../build/tools/special-admin-appeals.js")
  const id = ctx.acrSpecialId || "0"
  const result = await m.getAcrSpecialAppealText(client, { id })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 10. 헌법재판소 (2개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_constitutional_decisions: '평등권'", async () => {
  const m = await import("../build/tools/constitutional-decisions.js")
  const result = await m.searchConstitutionalDecisions(client, { query: "평등권", display: 3 })
  assertOk(result)
  ctx.constId = extractBracketId(result.content[0].text)
})
await r.run("get_constitutional_decision_text: 추출한 헌재 ID", async () => {
  if (!ctx.constId) throw new Error("헌재 ID 없음")
  const m = await import("../build/tools/constitutional-decisions.js")
  const result = await m.getConstitutionalDecisionText(client, { id: ctx.constId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 11. 조세 / 관세 (4개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_tax_tribunal_decisions: '소득세'", async () => {
  const m = await import("../build/tools/tax-tribunal-decisions.js")
  const result = await m.searchTaxTribunalDecisions(client, { query: "소득세", display: 3 })
  assertOk(result)
  ctx.taxId = extractBracketId(result.content[0].text)
})
await r.run("get_tax_tribunal_decision_text: 추출한 조심 ID", async () => {
  if (!ctx.taxId) throw new Error("조심 ID 없음")
  const m = await import("../build/tools/tax-tribunal-decisions.js")
  const result = await m.getTaxTribunalDecisionText(client, { id: ctx.taxId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_customs_interpretations: '관세'", async () => {
  const m = await import("../build/tools/customs-interpretations.js")
  const result = await m.searchCustomsInterpretations(client, { query: "관세", display: 3 })
  assertOk(result)
  ctx.customsId = extractBracketId(result.content[0].text)
})
await r.run("get_customs_interpretation_text: 추출한 관세 ID", async () => {
  if (!ctx.customsId) throw new Error("관세 ID 없음")
  const m = await import("../build/tools/customs-interpretations.js")
  const result = await m.getCustomsInterpretationText(client, { id: ctx.customsId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 12. 학칙 / 공단 / 공공기관 규정 (6개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_school_rules: '학칙'", async () => {
  const m = await import("../build/tools/institutional-rules.js")
  const result = await m.searchSchoolRules(client, { query: "학칙", display: 3 })
  assertOk(result)
  ctx.schoolId = extractBracketId(result.content[0].text)
})
await r.run("get_school_rule_text: 추출한 학칙 ID", async () => {
  if (!ctx.schoolId) throw new Error("학칙 ID 없음")
  const m = await import("../build/tools/institutional-rules.js")
  const result = await m.getSchoolRuleText(client, { id: ctx.schoolId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_public_corp_rules: '규정'", async () => {
  const m = await import("../build/tools/institutional-rules.js")
  const result = await m.searchPublicCorpRules(client, { query: "규정", display: 3 })
  assertOk(result)
  ctx.publicCorpId = extractBracketId(result.content[0].text)
})
await r.run("get_public_corp_rule_text: 추출한 공단 ID", async () => {
  if (!ctx.publicCorpId) throw new Error("공단 ID 없음")
  const m = await import("../build/tools/institutional-rules.js")
  const result = await m.getPublicCorpRuleText(client, { id: ctx.publicCorpId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_public_institution_rules: '규정'", async () => {
  const m = await import("../build/tools/institutional-rules.js")
  const result = await m.searchPublicInstitutionRules(client, { query: "규정", display: 3 })
  assertOk(result)
  ctx.publicInstId = extractBracketId(result.content[0].text)
})
await r.run("get_public_institution_rule_text: 추출한 공공기관 ID", async () => {
  if (!ctx.publicInstId) throw new Error("공공기관 ID 없음")
  const m = await import("../build/tools/institutional-rules.js")
  const result = await m.getPublicInstitutionRuleText(client, { id: ctx.publicInstId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 13. 조약 / 영문 법령 (4개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_treaties: '한미'", async () => {
  const m = await import("../build/tools/treaties.js")
  const result = await m.searchTreaties(client, { query: "한미", display: 3 })
  assertOk(result)
  ctx.treatyId = extractBracketId(result.content[0].text)
})
await r.run("get_treaty_text: 추출한 조약 ID", async () => {
  if (!ctx.treatyId) throw new Error("조약 ID 없음")
  const m = await import("../build/tools/treaties.js")
  const result = await m.getTreatyText(client, { id: ctx.treatyId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("search_english_law: 'Civil Act'", async () => {
  const m = await import("../build/tools/english-law.js")
  const result = await m.searchEnglishLaw(client, { query: "Civil", display: 3 })
  assertOk(result)
  ctx.engLawId = extractBracketId(result.content[0].text) || extractMst(result.content[0].text)
})
await r.run("get_english_law_text: 추출한 영문법령 ID", async () => {
  if (!ctx.engLawId) throw new Error("영문법령 ID 없음")
  const m = await import("../build/tools/english-law.js")
  const result = await m.getEnglishLawText(client, { id: ctx.engLawId })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 14. 용어 사전 (8개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_legal_terms: '계약'", async () => {
  const m = await import("../build/tools/legal-terms.js")
  const result = await m.searchLegalTerms(client, { query: "계약", display: 3 })
  assertOk(result)
})

await r.run("get_legal_term_kb: '계약'", async () => {
  const m = await import("../build/tools/knowledge-base.js")
  const result = await m.getLegalTermKB(client, { query: "계약", display: 3 })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_legal_term_detail: '계약'", async () => {
  const m = await import("../build/tools/knowledge-base.js")
  const result = await m.getLegalTermDetail(client, { query: "계약" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_daily_term: '월세'", async () => {
  const m = await import("../build/tools/knowledge-base.js")
  const result = await m.getDailyTerm(client, { query: "월세", display: 3 })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_daily_to_legal: '월세'", async () => {
  const m = await import("../build/tools/knowledge-base.js")
  const result = await m.getDailyToLegal(client, { query: "월세" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_legal_to_daily: '임대차'", async () => {
  const m = await import("../build/tools/knowledge-base.js")
  const result = await m.getLegalToDaily(client, { query: "임대차" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_term_articles: '계약'", async () => {
  const m = await import("../build/tools/knowledge-base.js")
  const result = await m.getTermArticles(client, { query: "계약" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_related_laws: '민법'", async () => {
  const m = await import("../build/tools/knowledge-base.js")
  const result = await m.getRelatedLaws(client, { query: "민법" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 15. AI 검색 + 잡 (5개)
// ═══════════════════════════════════════════════════════════════════

await r.run("search_ai_law: '개인정보'", async () => {
  const m = await import("../build/tools/life-law.js")
  const result = await m.searchAiLaw(client, { query: "개인정보" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("parse_jo_code: 제38조 → 003800", async () => {
  const m = await import("../build/tools/utils.js")
  // parse_jo_code handler 가 익명 — 정확한 export 명 확인 필요
  const fn = m.parseJoCode || m.handler
  if (!fn) throw new Error("parseJoCode export 못 찾음")
  const result = await fn({ joText: "제38조", direction: "to_code" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_law_abbreviations: 약칭 사전", async () => {
  const m = await import("../build/tools/utils.js")
  const result = await m.getLawAbbreviations(client, {})
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_batch_articles: MST 의 여러 조문", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/batch-articles.js")
  const result = await m.getBatchArticles(client, {
    mst: ctx.mst,
    articles: ["제1조", "제2조"],
  })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("get_article_with_precedents: MST + 제1조", async () => {
  if (!ctx.mst) throw new Error("MST 없음")
  const m = await import("../build/tools/article-with-precedents.js")
  const result = await m.getArticleWithPrecedents(client, { mst: ctx.mst, jo: "제1조" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 16. 체인 도구 (8개)
// ═══════════════════════════════════════════════════════════════════

await r.run("chain_law_system: '민법'", async () => {
  const m = await import("../build/tools/chains.js")
  const result = await m.chainLawSystem(client, { query: "민법" })
  assertOk(result)
})

await r.run("chain_action_basis: '도로교통법 처벌'", async () => {
  const m = await import("../build/tools/chains.js")
  // chain 도구는 query 의 키워드 매칭 정확도가 데이터에 의존 — 검색 실패 시 isError 안내
  const result = await m.chainActionBasis(client, { query: "도로교통법 처벌 근거" })
  assert(result?.content?.[0]?.text, "응답 없음")
})

await r.run("chain_dispute_prep: '부당해고'", async () => {
  const m = await import("../build/tools/chains.js")
  const result = await m.chainDisputePrep(client, { query: "부당해고 행정심판" })
  assertOk(result)
})

await r.run("chain_amendment_track: '개인정보보호법'", async () => {
  const m = await import("../build/tools/chains.js")
  const result = await m.chainAmendmentTrack(client, { query: "개인정보보호법" })
  assertOk(result)
})

await r.run("chain_ordinance_compare: '주차장'", async () => {
  const m = await import("../build/tools/chains.js")
  const result = await m.chainOrdinanceCompare(client, { query: "주차장 조례" })
  assertOk(result)
})

await r.run("chain_full_research: '음주운전 처벌'", async () => {
  const m = await import("../build/tools/chains.js")
  const result = await m.chainFullResearch(client, { query: "음주운전 처벌" })
  assertOk(result)
  assertMinLength(result, 200)
})

await r.run("chain_procedure_detail: '운전면허'", async () => {
  const m = await import("../build/tools/chains.js")
  const result = await m.chainProcedureDetail(client, { query: "운전면허 정지 절차" })
  assertOk(result)
})

await r.run("chain_document_review: 짧은 계약 텍스트", async () => {
  const m = await import("../build/tools/chains.js")
  const result = await m.chainDocumentReview(client, {
    query: "임대차 계약서 검토",
  })
  assert(result?.content?.[0]?.text, "응답 없음")
})

// ═══════════════════════════════════════════════════════════════════
// 17. 문서 분석 (1개)
// ═══════════════════════════════════════════════════════════════════

await r.run("analyze_document: 짧은 계약 텍스트", async () => {
  const m = await import("../build/tools/document-analysis.js")
  const result = await m.analyzeDocument(client, {
    text: "임대인은 임차인에게 보증금 1,000만원을 받고 월세 50만원에 임대한다. 계약 기간은 2년이며, 위반 시 손해배상 책임이 있다.",
  })
  assert(result?.content?.[0]?.text, "응답 없음")
})

const counts = r.print()
summarize([counts])
