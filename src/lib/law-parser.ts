/**
 * 법령 조문 번호 파싱 및 JO 코드 변환 유틸리티
 *
 * Clean-room implementation — 법제처 Open API 의 JO 코드 명세(공개)와
 * 일반적인 한국어 조문 표기 규칙만 참조하여 처음부터 작성됨.
 *
 * JO 코드 형식:
 *   - 일반 법령(법률·시행령·시행규칙):  AAAABB (6자리, zero-padded)
 *       AAAA = 조 번호 (1~9999, 4자리)
 *       BB   = 의X 번호 (없으면 00)
 *     예: 제38조 → "003800", 제10조의2 → "001002", 제100조의15 → "010015"
 *
 *   - 자치법규(조례/규칙):  AABBCC (또 다른 6자리 체계, 일부 도구에서 사용)
 *       AA = 조 번호 상위
 *       BB = 의X 번호
 *       CC = 추가 분류 자릿수
 *     자치법규 API 가 미세하게 다른 코딩을 요구할 때만 사용.
 *
 * 한국어 조문 표기 → 코드 정규식: 제(\d+)조(?:의(\d+))?
 */

import { normalizeLawSearchText, resolveLawAlias } from "./search-normalizer.js"

// ─── 인터페이스 ────────────────────────────────────────────────────

export interface ParsedSearchQuery {
  /** 추출한 법령명 (약칭 해결 후 canonical) */
  lawName: string
  /** 조문 표기 (예: "제38조", "제10조의2"). 없으면 undefined */
  article?: string
}

// ─── 조문 표기 정규화 ───────────────────────────────────────────────

/**
 * 조문 표기를 표준 형태로 정규화.
 *   "제 38 조" → "제38조"
 *   "38조"     → "제38조"
 *   "제 10 조의 2" → "제10조의2"
 *   "제100조의15"  → "제100조의15"
 */
export function normalizeArticle(article: string): string {
  if (!article) return ""
  // 공백 제거
  let s = article.replace(/\s+/g, "")
  // "38조" → "제38조" (앞에 "제" 없으면 보강)
  if (/^\d/.test(s)) s = "제" + s
  // "조의" 사이 공백/'·' 정리
  s = s.replace(/조의(\d+)/, "조의$1")
  return s
}

// ─── JO 코드 빌드 (한글 → 6자리) ────────────────────────────────────

/**
 * 한글 조문 표기를 일반 법령용 JO 코드(AAAABB)로 변환.
 *   "제38조"     → "003800"
 *   "제10조의2"  → "001002"
 *   "제100조의15" → "010015"
 *
 * 입력이 이미 6자리 숫자면 그대로 반환 (idempotent).
 */
export function buildJO(input: string): string {
  if (!input) return "000000"

  // 이미 6자리 숫자면 그대로
  const stripped = input.replace(/\s+/g, "")
  if (/^\d{6}$/.test(stripped)) return stripped

  const norm = normalizeArticle(input)
  const m = norm.match(/^제(\d+)조(?:의(\d+))?$/)
  if (!m) return "000000"

  const main = parseInt(m[1], 10)
  const branch = m[2] ? parseInt(m[2], 10) : 0
  if (Number.isNaN(main)) return "000000"

  return String(main).padStart(4, "0") + String(branch).padStart(2, "0")
}

/**
 * 자치법규(조례·규칙)용 JO 코드.
 * AABBCC 형식을 요구하는 일부 자치법규 API 용.
 * 조 번호 99 이하면 AA(조)+BB(의X)+CC(00) 형태.
 *   "제8조"    → "080000"
 *   "제8조의2" → "080200"
 */
export function buildOrdinanceJO(input: string): string {
  if (!input) return "000000"

  const stripped = input.replace(/\s+/g, "")
  if (/^\d{6}$/.test(stripped)) return stripped

  const norm = normalizeArticle(input)
  const m = norm.match(/^제(\d+)조(?:의(\d+))?$/)
  if (!m) return "000000"

  const main = parseInt(m[1], 10)
  const branch = m[2] ? parseInt(m[2], 10) : 0
  if (Number.isNaN(main)) return "000000"

  // 자치법규는 조 번호가 보통 99 이하 → 2자리 AA, 의X 2자리 BB, 추가 2자리 CC=00
  return (
    String(main).padStart(2, "0") +
    String(branch).padStart(2, "0") +
    "00"
  )
}

// ─── JO 코드 → 한글 ────────────────────────────────────────────────

/**
 * 6자리 JO 코드를 사람 표기로 변환.
 *   "003800" → "제38조"
 *   "001002" → "제10조의2"
 *   "010015" → "제100조의15"
 *
 * isOrdinance=true 면 자치법규(AABBCC) 디코드.
 *   "080200" → "제8조의2"
 */
export function formatJO(jo: string, isOrdinance = false): string {
  if (!jo) return ""
  const code = jo.replace(/\D/g, "")
  if (code.length !== 6) return jo

  let main: number
  let branch: number

  if (isOrdinance) {
    // AABBCC: AA=조, BB=의X, CC=무시 (보통 00)
    main = parseInt(code.slice(0, 2), 10)
    branch = parseInt(code.slice(2, 4), 10)
  } else {
    // AAAABB: AAAA=조, BB=의X
    main = parseInt(code.slice(0, 4), 10)
    branch = parseInt(code.slice(4, 6), 10)
  }

  if (!main || Number.isNaN(main)) return jo

  let out = `제${main}조`
  if (branch > 0) out += `의${branch}`
  return out
}

// ─── 검색 쿼리 파싱 (법령명 + 조문 분리) ────────────────────────────

/**
 * 자연어 쿼리에서 법령명과 조문을 분리.
 *   "민법 제1조"            → { lawName: "민법", article: "제1조" }
 *   "관세법 제38조"          → { lawName: "관세법", article: "제38조" }
 *   "fta특례법 제3조의2"     → { lawName: "자유무역협정의 이행을 위한 관세법의 특례에 관한 법률", article: "제3조의2" }
 *   "근로기준법"            → { lawName: "근로기준법" }   (article 없음)
 *
 * 약칭은 자동으로 정식 명칭으로 변환.
 */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  const norm = normalizeLawSearchText(query)
  if (!norm) return { lawName: "" }

  // "제N조[의M]" 패턴을 마지막에서 찾음
  const articleRe = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/
  const m = norm.match(articleRe)

  if (m) {
    const articleText = normalizeArticle(m[0])
    // 조문 앞부분이 법령명
    const beforeArticle = norm.slice(0, m.index).trim()
    const r = resolveLawAlias(beforeArticle)
    return {
      lawName: r.canonical || beforeArticle,
      article: articleText,
    }
  }

  // 조문 없으면 전체를 법령명으로
  const r = resolveLawAlias(norm)
  return { lawName: r.canonical || norm }
}
