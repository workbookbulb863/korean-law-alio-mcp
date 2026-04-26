/**
 * 기관간 규정·조문 비교 유틸
 *
 * - 제목 유사도: 공백 제거 후 집합 토큰 Jaccard
 * - 토픽 매칭: 정규화된 키워드/동의어 집합을 사용한 OR 매칭
 * - 조문 발췌: markdown 에서 "제N조" 헤더 기준 분절
 */

export function tokenizeTitle(s: string): string[] {
  return (s || "")
    .replace(/[()\[\]{}·,.·—\-「」『』]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = new Set([...sa, ...sb]).size
  return union === 0 ? 0 : inter / union
}

export function titleSimilarity(a: string, b: string): number {
  return jaccard(tokenizeTitle(a), tokenizeTitle(b))
}

/** 본문 markdown 에서 조문(제N조) 단위로 분절. 각 조문은 헤더 + 이어지는 내용 */
export function splitArticles(md: string): Array<{ heading: string; body: string }> {
  const lines = md.split(/\r?\n/)
  const sections: Array<{ heading: string; body: string }> = []
  let current: { heading: string; body: string[] } | null = null
  // 허용 포맷:
  //   "제1조"                 — 단독
  //   "제1조(목적)"            — 괄호 붙음(공백 없음)
  //   "제1조 (목적)"           — 괄호 공백
  //   "제10조의2(정의)"        — "의N"
  //   "제1조 이 규칙은..."      — 공백 후 본문
  //   "제1조(목적) 이 규칙은..." — 괄호 + 본문
  const re = /^\s*(제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^)]*\))?)\s*(.*)$/
  for (const raw of lines) {
    const line = raw.replace(/^#+\s*/, "")
    const m = line.match(re)
    if (m) {
      if (current) sections.push({ heading: current.heading, body: current.body.join("\n") })
      current = { heading: m[1].replace(/\s+/g, ""), body: m[2] ? [m[2]] : [] }
    } else if (current) {
      current.body.push(raw)
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join("\n") })
  return sections
}

/** 토픽 키워드가 포함된 줄을 ±contextLines 만큼 함께 반환 */
export function findTopicSnippets(
  md: string,
  topic: string,
  opts: { maxSnippets?: number; contextLines?: number } = {}
): Array<{ lineNo: number; snippet: string }> {
  const { maxSnippets = 5, contextLines = 2 } = opts
  const needles = expandTopicKeywords(topic)
  const lines = md.split(/\r?\n/)
  const hits: Array<{ lineNo: number; snippet: string }> = []
  for (let i = 0; i < lines.length && hits.length < maxSnippets; i++) {
    const l = lines[i]
    if (needles.some((n) => l.includes(n))) {
      const from = Math.max(0, i - contextLines)
      const to = Math.min(lines.length, i + contextLines + 1)
      hits.push({
        lineNo: i + 1,
        snippet: lines.slice(from, to).join("\n"),
      })
    }
  }
  return hits
}

/** 간단한 동의어 사전 — 초기엔 하드코딩, 필요 시 외부화 */
const TOPIC_SYNONYMS: Record<string, string[]> = {
  "블라인드 채용": ["블라인드", "공개채용", "공채", "학력", "출신"],
  휴직: ["휴직", "육아휴직", "병가"],
  징계: ["징계", "해임", "파면", "감봉", "정직", "견책"],
  복무: ["복무", "근무", "출근", "근태"],
  채용: ["채용", "공개채용", "공채", "채용공고"],
  보수: ["보수", "급여", "수당", "연봉", "임금"],
  성과평가: ["성과평가", "성과급", "업적평가"],
  감사: ["감사", "내부감사", "외부감사"],
  윤리: ["윤리", "청렴", "이해충돌"],
}

export function expandTopicKeywords(topic: string): string[] {
  const base = topic.trim()
  if (!base) return []
  const out = new Set<string>([base])
  for (const [key, syns] of Object.entries(TOPIC_SYNONYMS)) {
    if (base.includes(key) || syns.some((s) => base.includes(s))) {
      out.add(key)
      for (const s of syns) out.add(s)
    }
  }
  return Array.from(out)
}

// ─── 법령/상위규정 참조 추출 ──────────────────────────────

export interface ExternalLawRef {
  /** 법령명 (예: "공공기관의 운영에 관한 법률", "방송통신발전 기본법") */
  lawName: string
  /** 조문번호 (예: "제26조", "제10조의2") */
  article?: string
  /** 원본 문맥 라인 */
  line: string
}

export interface InternalRuleRef {
  /** 내부 상위규정명 (예: "회계규정", "인사규정") */
  ruleName: string
  article?: string
  line: string
}

/** 법령 끝말 — "법", "법률", "시행령", "시행규칙", "기본법" */
const LAW_ENDING = /(?:기본법|법률|법|시행령|시행규칙)$/

/** 본문 markdown 에서 외부 법령 / 내부 상위규정 참조를 추출. */
export function extractReferences(md: string): {
  external: ExternalLawRef[]
  internal: InternalRuleRef[]
} {
  const external: ExternalLawRef[] = []
  const internal: InternalRuleRef[] = []
  const lines = md.split(/\r?\n/)

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    // 1) 「 」 꺾쇠 인용 — 법/법률/시행령/시행규칙 끝나면 외부, 아니면 내부
    for (const m of line.matchAll(/「([^」\n]{2,40})」/g)) {
      const inner = m[1].trim()
      const after = line.slice((m.index || 0) + m[0].length, (m.index || 0) + m[0].length + 40)
      const articleMatch = after.match(/^\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/)
      const article = articleMatch
        ? `제${articleMatch[1]}조${articleMatch[2] ? `의${articleMatch[2]}` : ""}`
        : undefined
      if (LAW_ENDING.test(inner)) {
        external.push({ lawName: inner, article, line })
      } else if (/규정$|규칙$|지침$|예규$|세칙$|내규$/.test(inner)) {
        internal.push({ ruleName: inner, article, line })
      }
    }

    // 2) 꺾쇠 없이 "XX법 제N조" / "XX법률 제N조" / "XX 시행령 제N조"
    //    한 토큰 단위(공백 구분, 최대 8토큰)로 훑고, 마지막 토큰이 법/법률/시행령/시행규칙/기본법으로
    //    끝나는지는 isLikelyLawName 으로 후처리 검증. 이렇게 해야 "...법률"이 토큰에 흡수된 뒤
    //    다시 법끝말을 요구해 매칭이 깨지는 문제를 피할 수 있음.
    for (const m of line.matchAll(
      /([가-힣][가-힣·]*(?:\s[가-힣][가-힣·]*){0,7})\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g
    )) {
      const lawName = m[1].replace(/\s+/g, " ").trim()
      if (!isLikelyLawName(lawName)) continue
      external.push({
        lawName,
        article: `제${m[2]}조${m[3] ? `의${m[3]}` : ""}`,
        line,
      })
    }

    // 3) 내부 위임 패턴: "OO규정 제N조에 의하여", "OO규칙 제N조에 근거"
    for (const m of line.matchAll(
      /([가-힣][가-힣\s]{1,20}(?:규정|규칙|지침|예규|세칙|내규))\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*(?:에\s*(?:의하여|의거하여|따라|근거))/g
    )) {
      const ruleName = m[1].replace(/\s+/g, " ").trim()
      internal.push({
        ruleName,
        article: `제${m[2]}조${m[3] ? `의${m[3]}` : ""}`,
        line,
      })
    }
  }

  return {
    external: dedupByKey(external, (r) => `${r.lawName}::${r.article || ""}`),
    internal: dedupByKey(internal, (r) => `${r.ruleName}::${r.article || ""}`),
  }
}

/** 추출한 문자열이 법령명일 개연성이 있는지 휴리스틱 검증 */
function isLikelyLawName(s: string): boolean {
  if (s.length < 4 || s.length > 40) return false
  if (!LAW_ENDING.test(s)) return false
  // 구체적 법령명 없이 끝말 단독 → 거부 ("시행규칙 제9조", "법률 제5조" 같은 일반어)
  if (/^(법|법률|시행령|시행규칙|기본법)$/.test(s)) return false
  // 전형적 연결어·조사로 시작 금지
  if (/^(은|는|이|가|을|를|에|의|로|와|과|및|또는|그|이|저|그밖에|그외|등|한)\s/.test(s)) return false
  // 중간에 명백한 동사/조사 어미 포함 금지 (본문 연결어 흡수 차단)
  if (/(하여|하는|한다|되는|된다|따라|위하여|관하여|대하여|있는|된|될|할)\s/.test(s)) return false
  // 순수 한글+공백+· 만 허용 (괄호 등 특수문자 들어가면 노이즈)
  if (/[()「」<>『』]/.test(s)) return false
  return true
}

function dedupByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const k = keyFn(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

// ─── 개정 타임라인 날짜 파싱 ───────────────────────────────

/** "(220630)", "(2026년도 3월 12일 일부개정)", "(240715)" 같은 패턴에서 YYYY-MM-DD 를 추정 */
export function parseRevisionDate(filename: string): string | undefined {
  // 1) 8자리 연속 숫자 YYYYMMDD
  const ymd8 = filename.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/)
  if (ymd8) return `${ymd8[1]}-${ymd8[2]}-${ymd8[3]}`

  // 2) 6자리 YYMMDD (HWP 관행 — 예: 220630)
  const ymd6 = filename.match(/\((\d{2})(\d{2})(\d{2})\)/)
  if (ymd6) {
    const yy = Number(ymd6[1])
    const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy
    return `${yyyy}-${ymd6[2]}-${ymd6[3]}`
  }

  // 3) "YYYY년(도) M월 D일" 또는 "YYYY.M.D"
  const ymdKor = filename.match(/(\d{4})[년도.\s]+(\d{1,2})[월.\s]+(\d{1,2})/)
  if (ymdKor) {
    return `${ymdKor[1]}-${String(ymdKor[2]).padStart(2, "0")}-${String(ymdKor[3]).padStart(2, "0")}`
  }

  // 4) "YYYY.MM" (일자 생략)
  const ymKor = filename.match(/(\d{4})[년도.\s]+(\d{1,2})[월.\s]/)
  if (ymKor) {
    return `${ymKor[1]}-${String(ymKor[2]).padStart(2, "0")}-01`
  }

  return undefined
}
