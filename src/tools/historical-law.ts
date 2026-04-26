/**
 * 연혁법령 검색 + 특정 시점 본문 조회 (법제처 lsHstInf / lawjosub API)
 *
 * Clean-room implementation — 법제처 Open API 공개 명세
 * (https://open.law.go.kr/LSO/openApi/guideResult.do) 와 caller 시그니처만
 * 참조해 처음부터 작성됨.
 *
 * lsHstInf 응답은 HTML 만 제공되므로 단순 표 셀 추출 방식으로 파싱.
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { truncateResponse, formatDateDot } from "../lib/schemas.js"
import { formatToolError } from "../lib/errors.js"

// ─── 인터페이스 ────────────────────────────────────────────────────

export interface LawHistoryEntry {
  /** 법령일련번호 (mst). 특정 시점 본문 조회 시 사용 */
  mst: string
  /** 시행일자 (YYYYMMDD) */
  efYd: string
  /** 공포번호 */
  ancNo: string
  /** 공포일자 (YYYYMMDD) */
  ancYd: string
  /** 법령명 */
  lawNm: string
  /** 제·개정 구분 (제정·일부개정·전부개정·폐지 등) */
  rrCls: string
}

// ─── search_historical_law ────────────────────────────────────────

export const searchHistoricalLawSchema = z.object({
  lawName: z.string().describe("법령명 (예: '관세법', '민법', '형법')"),
  display: z.number().min(1).max(100).default(50).describe("결과 개수 (기본값: 50)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
})

export type SearchHistoricalLawInput = z.infer<typeof searchHistoricalLawSchema>

export async function searchHistoricalLaw(
  apiClient: LawApiClient,
  input: SearchHistoricalLawInput
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    // 법제처 lsHstInf 는 type=HTML 만 지원
    const html = await apiClient.fetchApi({
      endpoint: "lawSearch.do",
      target: "lsHstInf",
      type: "HTML",
      extraParams: {
        LM: input.lawName,
        display: String(input.display),
      },
      apiKey: input.apiKey,
    })

    const entries = parseLawHistoryTable(html)
    if (entries.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `[NOT_FOUND] '${input.lawName}'의 연혁이 검색되지 않았습니다.`,
          },
        ],
        isError: true,
      }
    }

    const lines: string[] = [
      `▶ '${input.lawName}' 연혁 — 총 ${entries.length}건`,
      "",
    ]
    for (const e of entries) {
      lines.push(
        `  - ${e.lawNm} (${e.rrCls})`,
        `      MST=${e.mst}  공포 ${formatDateDot(e.ancYd)}(제${e.ancNo}호)  시행 ${formatDateDot(e.efYd)}`
      )
    }
    lines.push(
      "",
      `💡 특정 시점 본문 조회: get_historical_law(mst="<MST>")`
    )

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "search_historical_law")
  }
}

// ─── get_historical_law ──────────────────────────────────────────

export const getHistoricalLawSchema = z.object({
  mst: z.string().describe("법령일련번호 (MST) - search_historical_law 에서 획득"),
  jo: z.string().optional().describe("특정 조문 번호 (예: '제38조')"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
})

export type GetHistoricalLawInput = z.infer<typeof getHistoricalLawSchema>

export async function getHistoricalLaw(
  apiClient: LawApiClient,
  input: GetHistoricalLawInput
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    // 법제처 lawjosub: 특정 시점(MST) 본문. JSON 또는 HTML.
    const extraParams: Record<string, string> = { MST: input.mst }
    if (input.jo) extraParams.JO = input.jo

    let body: string
    try {
      body = await apiClient.fetchApi({
        endpoint: "lawService.do",
        target: "lawjosub",
        type: "JSON",
        extraParams,
        apiKey: input.apiKey,
      })
    } catch {
      // JSON 미지원 시 HTML 폴백
      body = await apiClient.fetchApi({
        endpoint: "lawService.do",
        target: "lawjosub",
        type: "HTML",
        extraParams,
        apiKey: input.apiKey,
      })
    }

    const text = body.trim().startsWith("{") || body.trim().startsWith("[")
      ? formatJsonBody(body)
      : stripHtml(body)

    if (!text || text.length < 20) {
      return {
        content: [
          {
            type: "text",
            text: `[NOT_FOUND] MST=${input.mst} 본문을 가져오지 못했습니다.`,
          },
        ],
        isError: true,
      }
    }

    return {
      content: [{ type: "text", text: truncateResponse(text) }],
    }
  } catch (err) {
    return formatToolError(err, "get_historical_law")
  }
}

// ─── HTML 파싱 헬퍼 ────────────────────────────────────────────────

/**
 * 법제처 lsHstInf 응답 HTML 의 표(table) 에서 LawHistoryEntry 배열을 추출.
 * 응답 구조에 의존하므로 표 내 셀 패턴(법령명·공포일·공포번호·시행일·구분)을 휴리스틱 매칭.
 */
function parseLawHistoryTable(html: string): LawHistoryEntry[] {
  const rows: string[][] = []
  // <tr>...</tr> 추출
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let m: RegExpExecArray | null
  while ((m = trRe.exec(html)) !== null) {
    const cells = extractCells(m[1])
    if (cells.length >= 4) rows.push(cells)
  }

  // 각 셀 패턴에서 mst·날짜·공포번호 추출
  const out: LawHistoryEntry[] = []
  for (const cells of rows) {
    // 헤더 행은 보통 "법령명", "공포일자" 같은 라벨이 들어있어 mst 가 없음
    const mst = findMstFromCells(cells)
    if (!mst) continue

    const lawNm = pickLawName(cells)
    const ancYd = findFirstYmd(cells)
    const efYd = findLastYmd(cells)
    const ancNo = findAncNo(cells)
    const rrCls = findRrCls(cells)

    out.push({
      mst,
      lawNm,
      ancYd,
      efYd,
      ancNo,
      rrCls,
    })
  }
  return out
}

function extractCells(rowHtml: string): string[] {
  const cells: string[] = []
  const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
  let m: RegExpExecArray | null
  while ((m = tdRe.exec(rowHtml)) !== null) {
    cells.push(stripHtml(m[1]).trim())
  }
  return cells
}

function findMstFromCells(cells: string[]): string {
  // mst 는 보통 링크 hidden 데이터로 존재 — anchor href 같은 것이 들어있을 수 있음
  // 셀 내부 텍스트만 본다고 가정 시, 숫자 6자리 이상이 나오면 후보
  for (const c of cells) {
    const m = c.match(/\b(\d{5,7})\b/)
    if (m) return m[1]
  }
  return ""
}

function pickLawName(cells: string[]): string {
  // 한글이 가장 많은 셀을 법령명으로 간주
  let best = ""
  let bestCount = 0
  for (const c of cells) {
    const count = (c.match(/[가-힣]/g) || []).length
    if (count > bestCount) {
      bestCount = count
      best = c
    }
  }
  return best
}

function findFirstYmd(cells: string[]): string {
  for (const c of cells) {
    const m = c.match(/(\d{4})[.\-\s]?(\d{1,2})[.\-\s]?(\d{1,2})/)
    if (m) return `${m[1]}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}`
  }
  return ""
}

function findLastYmd(cells: string[]): string {
  for (let i = cells.length - 1; i >= 0; i--) {
    const m = cells[i].match(/(\d{4})[.\-\s]?(\d{1,2})[.\-\s]?(\d{1,2})/)
    if (m) return `${m[1]}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}`
  }
  return ""
}

function findAncNo(cells: string[]): string {
  for (const c of cells) {
    const m = c.match(/제\s*(\d+)\s*호/)
    if (m) return m[1]
  }
  return ""
}

function findRrCls(cells: string[]): string {
  const keywords = ["제정", "일부개정", "전부개정", "폐지", "타법개정", "타법폐지"]
  for (const c of cells) {
    for (const k of keywords) if (c.includes(k)) return k
  }
  return ""
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

function formatJsonBody(jsonText: string): string {
  try {
    const j = JSON.parse(jsonText)
    return typeof j === "string" ? j : JSON.stringify(j, null, 2)
  } catch {
    return jsonText
  }
}
