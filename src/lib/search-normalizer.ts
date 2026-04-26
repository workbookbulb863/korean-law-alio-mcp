/**
 * 법령 검색어 정규화 + 약칭 해결 + 검색 쿼리 확장 유틸리티
 *
 * Clean-room implementation — 한국 법제처(law.go.kr)의 공개 약칭 사전과
 * 일반적인 한국어 텍스트 정규화 규칙만 참조하여 처음부터 작성됨.
 */

// ─── 인터페이스 ─────────────────────────────────────────────────────

export interface LawAliasResolution {
  /** 매핑된 정식 법령명 (매핑 실패 시 입력 그대로) */
  canonical: string
  /** 입력에서 인식된 약칭(있을 때만) */
  matchedAlias?: string
  /** 동음이의 또는 같은 약칭으로 알려진 다른 정식 명칭 */
  alternatives: string[]
}

export interface ExpandedQueries {
  /** 동일 의미의 검색어 변형 목록 (검색 실패 시 폴백용) */
  expanded: string[]
}

// ─── 약칭 사전 ──────────────────────────────────────────────────────
// 출처: 법제처 공식 약칭 페이지 https://www.law.go.kr/lsAbrvSc.do (공개 자료)
// 한국에서 실무·학계가 표준적으로 사용하는 약칭만 등록.

interface AliasEntry {
  /** 정식 법령명 */
  canonical: string
  /** 알려진 약칭들(소문자 비교) */
  aliases: string[]
}

const ALIAS_TABLE: AliasEntry[] = [
  // 노동·산업안전
  { canonical: "근로기준법", aliases: ["근기법"] },
  { canonical: "산업안전보건법", aliases: ["산안법"] },
  { canonical: "중대재해 처벌 등에 관한 법률", aliases: ["중처법", "중대재해처벌법"] },
  { canonical: "노동조합 및 노동관계조정법", aliases: ["노조법", "노동조합법"] },
  {
    canonical: "남녀고용평등과 일·가정 양립 지원에 관한 법률",
    aliases: ["남녀고용평등법", "고용평등법"],
  },

  // 세법
  {
    canonical: "자유무역협정의 이행을 위한 관세법의 특례에 관한 법률",
    aliases: ["fta특례법", "자유무역협정관세법특례법", "fta관세특례법"],
  },
  { canonical: "조세특례제한법", aliases: ["조특법"] },
  { canonical: "국세기본법", aliases: ["국기법"] },

  // 화학·환경
  {
    canonical: "화학물질의 등록 및 평가 등에 관한 법률",
    aliases: ["화관법", "화학물질등록평가법", "k-reach", "화평법"],
  },
  { canonical: "화학물질관리법", aliases: ["화관법"] },
  { canonical: "대기환경보전법", aliases: ["대기환경법"] },
  { canonical: "수질 및 수생태계 보전에 관한 법률", aliases: ["수질법"] },

  // 개인정보·정보통신
  { canonical: "개인정보 보호법", aliases: ["개보법", "개인정보법"] },
  {
    canonical: "정보통신망 이용촉진 및 정보보호 등에 관한 법률",
    aliases: ["정보통신망법", "망법"],
  },
  { canonical: "전기통신사업법", aliases: ["전사법"] },

  // 청렴·이해충돌
  {
    canonical: "부정청탁 및 금품등 수수의 금지에 관한 법률",
    aliases: ["청탁금지법", "김영란법"],
  },
  { canonical: "공직자의 이해충돌 방지법", aliases: ["이해충돌방지법", "이충법"] },

  // 공공계약·공공기관
  {
    canonical: "국가를 당사자로 하는 계약에 관한 법률",
    aliases: ["국가계약법"],
  },
  {
    canonical: "지방자치단체를 당사자로 하는 계약에 관한 법률",
    aliases: ["지방계약법"],
  },
  { canonical: "공공기관의 운영에 관한 법률", aliases: ["공운법", "공공기관운영법"] },

  // 부동산·임대차
  { canonical: "주택임대차보호법", aliases: ["주임법"] },
  { canonical: "상가건물 임대차보호법", aliases: ["상임법", "상가임대차법"] },
  { canonical: "부동산 거래신고 등에 관한 법률", aliases: ["부거법"] },

  // 공정거래
  {
    canonical: "독점규제 및 공정거래에 관한 법률",
    aliases: ["공정거래법", "독점규제법"],
  },
  { canonical: "하도급거래 공정화에 관한 법률", aliases: ["하도급법"] },
  { canonical: "약관의 규제에 관한 법률", aliases: ["약관법", "약관규제법"] },
  { canonical: "표시·광고의 공정화에 관한 법률", aliases: ["표시광고법"] },
  { canonical: "가맹사업거래의 공정화에 관한 법률", aliases: ["가맹사업법"] },

  // 금융
  {
    canonical: "자본시장과 금융투자업에 관한 법률",
    aliases: ["자본시장법", "자금법"],
  },
  {
    canonical: "특정 금융거래정보의 보고 및 이용 등에 관한 법률",
    aliases: ["특금법"],
  },
  { canonical: "전자금융거래법", aliases: ["전금법"] },

  // 도시계획·건축
  {
    canonical: "국토의 계획 및 이용에 관한 법률",
    aliases: ["국토계획법", "국계법"],
  },
  { canonical: "도시 및 주거환경정비법", aliases: ["도정법"] },

  // 보건·의료·식품
  {
    canonical: "감염병의 예방 및 관리에 관한 법률",
    aliases: ["감염병예방법", "감예법"],
  },
  { canonical: "식품위생법", aliases: ["식위법"] },

  // 운수
  { canonical: "여객자동차 운수사업법", aliases: ["여객운수법"] },
  { canonical: "화물자동차 운수사업법", aliases: ["화물운수법"] },

  // 절차법
  { canonical: "민사소송법", aliases: ["민소법"] },
  { canonical: "형사소송법", aliases: ["형소법"] },
  { canonical: "민사집행법", aliases: ["민집법"] },
  { canonical: "행정소송법", aliases: ["행소법"] },

  // 사회보험
  { canonical: "국민건강보험법", aliases: ["건보법", "국건법"] },
  { canonical: "산업재해보상보험법", aliases: ["산재보험법", "산재법"] },
  { canonical: "고용보험법", aliases: ["고보법"] },
  { canonical: "국민연금법", aliases: ["국연법"] },

  // 상사·기업
  { canonical: "주식회사 등의 외부감사에 관한 법률", aliases: ["외감법", "외부감사법"] },

  // 공무원·지방자치
  { canonical: "지방자치법", aliases: ["지자법"] },
  { canonical: "지방공무원법", aliases: ["지공법"] },
  { canonical: "국가공무원법", aliases: ["국공법"] },

  // 행정
  { canonical: "행정절차법", aliases: ["행절법"] },
  { canonical: "행정심판법", aliases: ["행심법"] },
]

// ─── 정규화 함수 ────────────────────────────────────────────────────

/**
 * 검색어 정규화.
 * 동작:
 *   1) 좌우 공백 trim
 *   2) 다중 공백·전각 공백 → 단일 반각 공백
 *   3) 영문은 소문자 → 대문자 (FTA 등 약어 대조 일관성)
 *   4) 한자/한글 그대로 보존
 */
export function normalizeLawSearchText(input: string): string {
  if (typeof input !== "string") return ""
  return input
    .trim()
    .replace(/　/g, " ") // 전각 공백
    .replace(/\s+/g, " ")
    .replace(/[a-z]+/g, (m) => m.toUpperCase())
}

// ─── 약칭 해결 ─────────────────────────────────────────────────────

/**
 * 입력 법령명을 정식 명칭으로 매핑.
 * 매핑 실패 시 입력값을 canonical 로 반환 + alternatives 빈 배열.
 */
export function resolveLawAlias(lawName: string): LawAliasResolution {
  const norm = normalizeLawSearchText(lawName).toLowerCase()
  if (!norm) {
    return { canonical: lawName, alternatives: [] }
  }

  // 1) 정식명 정확 일치
  for (const e of ALIAS_TABLE) {
    if (e.canonical.toLowerCase() === norm) {
      const dups = ALIAS_TABLE
        .filter((x) => x !== e && x.aliases.some((a) => e.aliases.includes(a)))
        .map((x) => x.canonical)
      return { canonical: e.canonical, alternatives: dups }
    }
  }

  // 2) 약칭 일치 (대소문자 무시)
  for (const e of ALIAS_TABLE) {
    const matched = e.aliases.find((a) => a.toLowerCase() === norm)
    if (matched) {
      const dups = ALIAS_TABLE
        .filter((x) => x !== e && x.aliases.some((a) => a.toLowerCase() === norm))
        .map((x) => x.canonical)
      return {
        canonical: e.canonical,
        matchedAlias: matched,
        alternatives: dups,
      }
    }
  }

  // 3) 매핑 없음 — 입력 그대로
  return { canonical: lawName.trim(), alternatives: [] }
}

// ─── 쿼리 확장 ─────────────────────────────────────────────────────

/**
 * 자치법규(조례/규칙) 검색용 쿼리 변형 목록.
 * 검색 실패 시 폴백으로 시도할 변형들을 반환.
 */
export function expandOrdinanceQuery(query: string): ExpandedQueries {
  const base = normalizeLawSearchText(query)
  if (!base) return { expanded: [] }

  const variants = new Set<string>()

  // "조례", "규칙" 끝말 제거
  const noTypeWord = base.replace(/\s*(조례|규칙)\s*$/, "").trim()
  if (noTypeWord && noTypeWord !== base) variants.add(noTypeWord)

  // 토큰 분해해서 일부만 사용
  const tokens = base.split(/\s+/).filter(Boolean)
  if (tokens.length >= 2) {
    // 첫 토큰(주로 지역명)만
    variants.add(tokens[0])
    // 첫 토큰 제외하고 나머지
    variants.add(tokens.slice(1).join(" "))
    // 마지막 토큰만 (주제어)
    variants.add(tokens[tokens.length - 1])
  }

  // 자기 자신은 제외
  return { expanded: Array.from(variants).filter((v) => v && v !== base) }
}

/**
 * 법령(법률·시행령·시행규칙·행정규칙) 검색용 쿼리 변형.
 */
export function expandLawQuery(query: string): ExpandedQueries {
  const base = normalizeLawSearchText(query)
  if (!base) return { expanded: [] }

  const variants = new Set<string>()

  // 약칭이면 정식명도 추가
  const r = resolveLawAlias(base)
  if (r.canonical !== base) variants.add(r.canonical)
  if (r.matchedAlias) variants.add(r.matchedAlias)
  for (const alt of r.alternatives) variants.add(alt)

  // "에 관한 법률", "법", "령", "규칙" 어미 제거 후 핵심 키워드만
  const stripped = base.replace(/(에\s*관한)?\s*(법률|법|령|규칙|규정)$/, "").trim()
  if (stripped && stripped !== base) variants.add(stripped)

  // 시행령/시행규칙 토큰 떼고 모법명만
  const baseLawName = base.replace(/\s*(시행령|시행규칙)$/, "").trim()
  if (baseLawName !== base) variants.add(baseLawName)

  return { expanded: Array.from(variants).filter((v) => v && v !== base) }
}
