/**
 * ALIO 공통 타입
 */

export interface Institution {
  apbaId: string
  apbaNa: string
  /** 기관 유형 (예: "기타공공기관", "준정부기관") */
  typeNa: string
  /** 주무부처 */
  jidtNa: string
  /** 기관 유형 코드 (예: "A2005") */
  apbaType: string
}

/** ALIO 규정 목록의 원시 항목 (itemReportListSusi.json 응답) */
export interface RegulationListItem {
  apbaId: string
  /** 규정 식별자 (RULE_NO) — 상세 조회/파일 다운로드 시 사용 */
  idx: string
  title: string
  /** 최종 수정일 (YYYY.MM.DD) */
  idate: string
  /** 제·개정일 (YYYY.MM.DD) */
  stDate: string
  /** 규정 분류 코드 (예: K1100=감사, K1400=업무, K1500=정관) */
  bidType: string
  reportFormNo: string
  tableName: string
  idxName: string
  reportGbn: string
}

/** 규정 상세 — 첨부파일(개정본) 목록 포함 */
export interface RegulationDetail {
  apbaId: string
  idx: string
  title: string
  issuedAt?: string
  revisedAt?: string
  files: RegulationFileRef[]
}

export interface RegulationFileRef {
  fileNo: string
  filename: string
}

/** manifest.json 기록 */
export interface ManifestEntry {
  regId: string
  title: string
  category: string
  issuedAt: string
  revisedAt: string
  sourceDetailUrl: string
  primaryFileNo: string
  primaryFileName: string
  fileType: "hwpx" | "hwp" | "hwpml" | "pdf" | "xlsx" | "docx" | "unknown"
  fileHash: string
  mdPath: string
  bytes: number
  /** 파싱 실패 시 kordoc 에러 메시지. 성공이면 undefined */
  parseError?: string
  /** 원본이 zip 래퍼였다면 내부에서 실제로 파싱한 파일명 */
  unwrappedFrom?: string
  /** kordoc 대신 사용된 fallback 파서. (예: "docling") — 현행본이 kordoc 으로 성공하면 undefined */
  fallbackParser?: "docling"
  /** 과거 개정본 (최신이 primary, 나머지는 history) */
  revisions: Array<{
    fileNo: string
    filename: string
  }>
}

export interface Manifest {
  apbaId: string
  institutionName: string
  typeNa?: string
  jidtNa?: string
  reportFormRootNo: number
  fetchedAt: string
  regulations: ManifestEntry[]
}

export interface InstitutionsIndex {
  fetchedAt: string
  institutions: Institution[]
}

export interface SyncState {
  lastFullSync?: string
  lastError?: string
  perInstitution: Record<string, {
    fetchedAt: string
    status: "success" | "error"
    error?: string
    regulationCount: number
  }>
}
