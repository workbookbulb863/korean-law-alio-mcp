/**
 * 법제처 OpenAPI "3단비교(thdCmp)" 응답 파서.
 *
 * Clean-room implementation — 법제처 공식 OpenAPI 응답 스키마(공개 가이드)와
 * src/lib/types.ts 의 인터페이스 정의만 참조해 처음부터 작성됨.
 *
 * 입력: lawService.do?target=thdCmp&knd=1|2 의 JSON 응답 본문
 *   knd=1: 인용조문(citation)
 *   knd=2: 위임조문(delegation)
 *
 * 출력: ThreeTierData (meta + articles[] + kndType)
 *
 * 응답 wrapper 가 위임/인용에 따라 다른 키를 사용하기 때문에, 다양한 후보 키를 순서대로 탐색.
 */

import type {
  ThreeTierData,
  ThreeTierMeta,
  ThreeTierArticle,
  DelegationItem,
  CitationItem,
} from "./types.js"

// ─── 헬퍼 ──────────────────────────────────────────────────────────

/** 단일 객체 ↔ 배열 정규화 — 법제처 API 가 결과 1건일 때 단일 객체로 반환하는 케이스 대응 */
function toArray<T>(v: unknown): T[] {
  if (v == null) return []
  return Array.isArray(v) ? (v as T[]) : [v as T]
}

/** JSON 객체에서 첫 번째로 존재하는 키의 값을 반환 */
function pickFirst(obj: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined
  for (const k of keys) {
    if (k in obj && obj[k] != null) return obj[k]
  }
  return undefined
}

function asString(v: unknown): string {
  if (v == null) return ""
  return String(v)
}

// ─── 메타데이터(본법/시행령/시행규칙 기본정보) 추출 ────────────────────

function extractMeta(root: Record<string, unknown>): ThreeTierMeta {
  // 본법 / 시행령 / 시행규칙 기본정보 블록은 응답 wrapper 안에 있을 수도, 루트에 있을 수도.
  const law = pickFirst(root, ["본법기본정보", "법령기본정보", "기본정보"]) as
    | Record<string, unknown>
    | undefined
  const sirye = pickFirst(root, ["시행령기본정보"]) as Record<string, unknown> | undefined
  const sigy = pickFirst(root, ["시행규칙기본정보"]) as Record<string, unknown> | undefined

  return {
    lawId: asString(pickFirst(law, ["법령ID", "법령일련번호"])),
    lawName: asString(pickFirst(law, ["법령명한글", "법령명"])),
    lawSummary: asString(pickFirst(law, ["법령내용", "법령요약"])),
    sihyungryungId: asString(pickFirst(sirye, ["법령ID", "법령일련번호"])),
    sihyungryungName: asString(pickFirst(sirye, ["법령명한글", "법령명"])),
    sihyungryungSummary: asString(pickFirst(sirye, ["법령내용", "법령요약"])),
    sihyungkyuchikId: asString(pickFirst(sigy, ["법령ID", "법령일련번호"])),
    sihyungkyuchikName: asString(pickFirst(sigy, ["법령명한글", "법령명"])),
    sihyungkyuchikSummary: asString(pickFirst(sigy, ["법령내용", "법령요약"])),
    exists: !!law || !!sirye || !!sigy,
    basis: "",
  }
}

// ─── 자식 블록(위임/인용) → 항목 배열 ────────────────────────────────

interface RefBlock {
  법령구분?: string
  법령구분명?: string
  법령명?: string
  법령명한글?: string
  조문번호?: string | number
  조문제목?: string
  조문내용?: string
}

function classifyType(raw: unknown): DelegationItem["type"] {
  const s = asString(raw)
  if (s.includes("시행령") || s === "령") return "시행령"
  if (s.includes("시행규칙") || s === "규칙") return "시행규칙"
  if (s.includes("행정규칙") || s.includes("훈령") || s.includes("고시")) return "행정규칙"
  return "시행령"
}

function buildItems<T extends DelegationItem | CitationItem>(
  rawBlock: unknown,
  isDelegation: boolean
): T[] {
  const list = toArray<RefBlock>(rawBlock)
  return list.map((r) => {
    const joRaw = asString(r.조문번호)
    const joNum = joRaw && /^\d+$/.test(joRaw)
      ? `제${parseInt(joRaw, 10)}조`
      : joRaw
    const item = {
      type: isDelegation ? classifyType(r.법령구분 ?? r.법령구분명) : asString(r.법령구분명 ?? r.법령구분),
      lawName: asString(r.법령명한글 ?? r.법령명),
      jo: joRaw || undefined,
      joNum: joNum || undefined,
      title: asString(r.조문제목),
      content: asString(r.조문내용),
    }
    return item as T
  })
}

// ─── 조문(article) 배열 추출 ─────────────────────────────────────────

interface ArticleBlock {
  조문번호?: string | number
  조문제목?: string
  조문내용?: string
  위임조문?: unknown
  인용조문?: unknown
}

function extractArticles(root: Record<string, unknown>, isDelegation: boolean): ThreeTierArticle[] {
  // 조문 컨테이너 후보: 응답 wrapper 가 다양함
  const container = pickFirst(root, ["조문", "조문단위", "Articles", "ArticleList"]) as
    | Record<string, unknown>
    | unknown[]
    | undefined

  // {조문: [...]}, {조문: {조문단위: [...]}} 두 패턴 모두 지원
  let raw: unknown[]
  if (Array.isArray(container)) {
    raw = container
  } else if (container && typeof container === "object") {
    const inner = pickFirst(container as Record<string, unknown>, ["조문단위", "Article"])
    raw = toArray<unknown>(inner ?? container)
  } else {
    raw = []
  }

  return raw.map((rArr) => {
    const r = rArr as ArticleBlock
    const joRaw = asString(r.조문번호)
    const jo = joRaw
    const joNum = joRaw && /^\d+$/.test(joRaw)
      ? `제${parseInt(joRaw, 10)}조`
      : joRaw

    return {
      jo,
      joNum,
      title: asString(r.조문제목),
      content: asString(r.조문내용),
      delegations: isDelegation ? buildItems<DelegationItem>(r.위임조문, true) : [],
      citations: !isDelegation ? buildItems<CitationItem>(r.인용조문, false) : [],
    }
  })
}

// ─── 메인 진입점 ───────────────────────────────────────────────────

/**
 * 법제처 3단비교(thdCmp) 응답을 ThreeTierData 로 파싱.
 *
 * 응답 wrapper 키는 한국 법제처 OpenAPI 가 위임(thdCmpExpInf) / 인용(thdCmpRefInf) 으로
 * 나누는 경우가 있으므로, 다양한 후보를 순서대로 탐색.
 */
export function parseThreeTierDelegation(jsonData: unknown): ThreeTierData {
  if (!jsonData || typeof jsonData !== "object") {
    return {
      meta: emptyMeta(),
      articles: [],
      kndType: "위임조문",
    }
  }

  const obj = jsonData as Record<string, unknown>

  // wrapper 후보 — 위임 응답이면 위임조문 컨테이너, 인용이면 인용 컨테이너
  const delWrap = pickFirst(obj, [
    "thdCmpExpInf",
    "위임조문응답",
    "thdCmpExp",
    "위임",
  ]) as Record<string, unknown> | undefined

  const refWrap = pickFirst(obj, [
    "thdCmpRefInf",
    "인용조문응답",
    "thdCmpRef",
    "인용",
  ]) as Record<string, unknown> | undefined

  const isDelegation = !!delWrap || !refWrap
  const root = (delWrap ?? refWrap ?? obj) as Record<string, unknown>

  return {
    meta: extractMeta(root),
    articles: extractArticles(root, isDelegation),
    kndType: isDelegation ? "위임조문" : "인용조문",
  }
}

function emptyMeta(): ThreeTierMeta {
  return {
    lawId: "",
    lawName: "",
    lawSummary: "",
    sihyungryungId: "",
    sihyungryungName: "",
    sihyungryungSummary: "",
    sihyungkyuchikId: "",
    sihyungkyuchikName: "",
    sihyungkyuchikSummary: "",
    exists: false,
    basis: "",
  }
}
