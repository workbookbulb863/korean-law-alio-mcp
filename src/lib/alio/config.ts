/**
 * ALIO 자연어 라우팅 설정 — 환경변수 기반 (선택)
 *
 * 자연어 입력에서 기관 약어를 인식하려면 ALIO_INSTITUTION_ALIASES 등록.
 * 미설정 시에도 정식 기관명/apbaId 코드 매칭은 정상 동작.
 *
 * 비교 대상 기관 자체는 환경변수로 박지 않는다 — 사용자가 호출 시
 * institutions 인자로 자유롭게 지정하거나, 미지정 시 수집된 전체 기관 자동 사용.
 */

let cachedAliases: Record<string, string> | null = null

/** 자연어 라우팅용 기관 약어 매핑 (ALIO_INSTITUTION_ALIASES, JSON object) */
export function getInstitutionAliases(): Record<string, string> {
  if (cachedAliases !== null) return cachedAliases
  const raw = process.env.ALIO_INSTITUTION_ALIASES?.trim()
  if (!raw) {
    cachedAliases = {}
    return cachedAliases
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === "string" && typeof v === "string" && k && v) out[k] = v
      }
      cachedAliases = out
    } else {
      cachedAliases = {}
    }
  } catch {
    cachedAliases = {}
  }
  return cachedAliases
}

/** 테스트/리로드용 — 캐시 초기화 */
export function resetAlioConfigCache(): void {
  cachedAliases = null
}
