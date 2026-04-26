/**
 * ALIO 공공기관 경영정보 공개시스템 HTTP 클라이언트
 *
 * 엔드포인트는 브라우저 Vue 앱이 호출하는 AJAX 경로를 그대로 사용.
 * - POST /item/itemOrganListSusi.json — 전체 기관 목록 (reportFormRootNo 필터)
 * - POST /item/itemReportListSusi.json — 특정 기관의 규정 목록(페이지네이션)
 * - GET  /item/itemBoard21110.do — 규정 상세(HTML) — fileNo 추출용
 * - GET  /download/rulefiledown.json?fileNo= — 규정 파일 바이너리 다운로드
 */

import { fetchWithRetry } from "../fetch-with-retry.js"
import type { Institution, RegulationListItem, RegulationDetail } from "./types.js"

const ALIO_BASE = "https://www.alio.go.kr"
/** '정관 및 내부규정' 공시 루트 번호 */
export const RULE_REPORT_FORM_ROOT = 21110

const JSON_HEADERS = {
  "Content-Type": "application/json;charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ko,en;q=0.8",
  Referer: `${ALIO_BASE}/item/itemOrganList.do?reportFormRootNo=${RULE_REPORT_FORM_ROOT}`,
  "User-Agent":
    "Mozilla/5.0 (korean-law-alio-mcp) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
} as const

const HTML_HEADERS = {
  ...JSON_HEADERS,
  Accept: "text/html,application/xhtml+xml",
} as const

function throwIfNotOk(res: Response, endpoint: string): void {
  if (!res.ok) {
    throw new Error(`ALIO ${endpoint} HTTP ${res.status}`)
  }
}

export async function listInstitutions(): Promise<Institution[]> {
  const res = await fetchWithRetry(`${ALIO_BASE}/item/itemOrganListSusi.json`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      apbaType: [],
      jidtDptm: [],
      area: [],
      apbaId: "",
      reportFormRootNo: String(RULE_REPORT_FORM_ROOT),
    }),
  })
  throwIfNotOk(res, "itemOrganListSusi")
  const json = (await res.json()) as { data?: { organList?: Institution[] } }
  const list = json?.data?.organList
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("ALIO 기관 목록이 비어 있습니다 — API 응답 포맷 변경 가능성")
  }
  return list
}

export interface RegulationListPage {
  items: RegulationListItem[]
  pageNo: number
  totalPages: number
  totalCount: number
  /** 해당 기관의 기본 정보(응답에 포함됨) */
  organInfo?: { apbaId?: string; apbaNa?: string; typeNa?: string; jidtNa?: string }
}

export async function listRegulations(
  apbaId: string,
  pageNo = 1,
  apbaType = "A2005"
): Promise<RegulationListPage> {
  const res = await fetchWithRetry(`${ALIO_BASE}/item/itemReportListSusi.json`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      pageNo: String(pageNo),
      apbaId: String(apbaId),
      apbaType: String(apbaType),
      reportFormRootNo: String(RULE_REPORT_FORM_ROOT),
      search_word: "",
      search_flag: "title",
      bid_type: "",
      enfc_istt: "",
    }),
  })
  throwIfNotOk(res, "itemReportListSusi")
  const json = (await res.json()) as {
    data?: {
      result?: RegulationListItem[]
      page?: { totalCount?: number; totalPage?: number }
      organInfo?: RegulationListPage["organInfo"]
    }
  }
  return {
    items: Array.isArray(json?.data?.result) ? json!.data!.result! : [],
    pageNo,
    totalPages: Number(json?.data?.page?.totalPage ?? 1),
    totalCount: Number(json?.data?.page?.totalCount ?? 0),
    organInfo: json?.data?.organInfo,
  }
}

/** 기관의 모든 규정(페이지네이션 통합) */
export async function listAllRegulations(
  apbaId: string,
  apbaType: string,
  onPage?: (page: RegulationListPage) => void
): Promise<RegulationListItem[]> {
  const first = await listRegulations(apbaId, 1, apbaType)
  onPage?.(first)
  const all: RegulationListItem[] = [...first.items]
  for (let p = 2; p <= first.totalPages; p++) {
    const page = await listRegulations(apbaId, p, apbaType)
    onPage?.(page)
    all.push(...page.items)
  }
  return all
}

/**
 * 규정 상세 HTML 에서 개정본별 fileNo + 파일명 추출.
 * 상세 페이지는 정적 서버사이드 렌더링이라 HTML 파싱으로 충분.
 */
export async function getRegulationDetail(
  item: RegulationListItem
): Promise<RegulationDetail> {
  const params = new URLSearchParams({
    disclosureNo: "",
    apbaId: item.apbaId,
    nowcode: item.reportFormNo,
    reportFormNo: item.reportFormNo,
    table_name: item.tableName,
    idx_name: item.idxName,
    idx: item.idx,
    reportGbn: item.reportGbn,
    bid_type: item.bidType,
  })
  const url = `${ALIO_BASE}/item/itemBoard21110.do?${params.toString()}`
  const res = await fetchWithRetry(url, { headers: HTML_HEADERS })
  throwIfNotOk(res, "itemBoard21110")
  const html = await res.text()

  const files = extractFileRefs(html)
  return {
    apbaId: item.apbaId,
    idx: item.idx,
    title: item.title,
    issuedAt: item.stDate || undefined,
    revisedAt: item.idate || undefined,
    files,
  }
}

/** 상세 HTML 에서 `<a href="/download/rulefiledown.json?fileNo=...">파일명</a>` 패턴을 추출 */
function extractFileRefs(html: string): RegulationDetail["files"] {
  const out: RegulationDetail["files"] = []
  const re = /<a\s+href="\/download\/rulefiledown\.json\?fileNo=(\d+)"[^>]*>([^<]+)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const fileNo = m[1]
    const filename = decodeHtmlEntities(m[2].trim())
    if (out.some((f) => f.fileNo === fileNo)) continue
    out.push({ fileNo, filename })
  }
  return out
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
}

export interface DownloadedFile {
  fileNo: string
  /** Content-Disposition 에서 파싱한 파일명(없으면 빈 문자열) */
  filename: string
  buffer: ArrayBuffer
  /** 서버가 내려준 Content-Type (참고용) */
  contentType: string
}

export async function downloadRegulationFile(fileNo: string): Promise<DownloadedFile> {
  const url = `${ALIO_BASE}/download/rulefiledown.json?fileNo=${encodeURIComponent(fileNo)}`
  const res = await fetchWithRetry(url, {
    headers: {
      ...JSON_HEADERS,
      Accept: "*/*",
    },
    timeout: 120_000,
  })
  throwIfNotOk(res, "rulefiledown")
  const contentType = res.headers.get("content-type") || ""
  const filename = parseContentDispositionFilename(res.headers.get("content-disposition"))
  const buffer = await res.arrayBuffer()
  return { fileNo, filename, buffer, contentType }
}

function parseContentDispositionFilename(header: string | null): string {
  if (!header) return ""
  // filename*=UTF-8''... 우선
  const star = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (star) {
    try {
      return decodeURIComponent(star[1]).replace(/^"+|"+$/g, "")
    } catch {
      /* fallthrough */
    }
  }
  const plain = header.match(/filename=("?)([^";]+)\1/i)
  if (plain) return plain[2].replace(/^"+|"+$/g, "")
  return ""
}
