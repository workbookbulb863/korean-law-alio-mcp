/**
 * advanced_alio_search — ALIO 규정 복합 필터 검색
 *
 * 분류(category) + 기관유형 + 주무부처 + 개정일 기간 + 제목 키워드 + 기관 제한 조합.
 * 패턴은 법제처 `advanced_search` 와 동일.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex } from "../../lib/alio/index-loader.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const AdvancedAlioSearchSchema = z.object({
  query: z.string().optional().describe("규정 제목 키워드 (부분 매칭)"),
  category: z.string().optional().describe("ALIO 분류 코드 (예: 'K1100' 감사, 'K1300' 직제, 'K1400', 'K1500' 정관)"),
  ministry: z.string().optional().describe("주무부처 (예: '과학기술정보통신부')"),
  type: z.string().optional().describe("기관유형 (예: '기타공공기관', '준정부기관')"),
  fromDate: z.string().optional().describe("개정일 from (YYYYMMDD 또는 YYYY-MM-DD)"),
  toDate: z.string().optional().describe("개정일 to (YYYYMMDD 또는 YYYY-MM-DD)"),
  institutions: z.array(z.string()).optional().describe("기관 제한 (apbaId/이름 배열)"),
  sortBy: z.enum(["recent", "institution", "title"]).default("recent").describe("정렬 (recent=개정일 역순, institution=기관코드, title=제목)"),
  max: z.number().min(1).max(100).default(30).describe("최대 결과 수 (기본:30)"),
})

export type AdvancedAlioSearchInput = z.infer<typeof AdvancedAlioSearchSchema>

export async function advancedAlioSearch(
  _api: LawApiClient,
  input: AdvancedAlioSearchInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()

    const q = input.query?.trim().toLowerCase()
    const cat = input.category?.trim().toUpperCase()
    const ministry = input.ministry?.trim().toLowerCase()
    const type = input.type?.trim().toLowerCase()
    const from = input.fromDate ? parseAlioDate(input.fromDate) : null
    const to = input.toDate ? parseAlioDate(input.toDate) : null
    const instFilter = input.institutions?.length
      ? new Set(
          input.institutions
            .map((c) => findInstitution(idx, c)?.apbaId)
            .filter((x): x is string => !!x)
        )
      : null

    interface Hit {
      apbaId: string
      apbaNa: string
      typeNa: string
      jidtNa: string
      regId: string
      title: string
      category?: string
      revisedAt?: string
      revisedDate?: Date | null
    }

    const hits: Hit[] = []
    for (const { inst, entry } of idx.flatRegulations) {
      if (instFilter && !instFilter.has(inst.apbaId)) continue
      if (q && !entry.title.toLowerCase().includes(q)) continue
      if (cat && (entry.category || "").toUpperCase() !== cat) continue
      if (ministry && !(inst.jidtNa || "").toLowerCase().includes(ministry)) continue
      if (type && !(inst.typeNa || "").toLowerCase().includes(type)) continue

      const dateStr = entry.revisedAt || entry.issuedAt || ""
      const date = parseAlioDate(dateStr)
      if (from && (!date || date < from)) continue
      if (to && (!date || date > to)) continue

      hits.push({
        apbaId: inst.apbaId,
        apbaNa: inst.apbaNa,
        typeNa: inst.typeNa,
        jidtNa: inst.jidtNa,
        regId: entry.regId,
        title: entry.title,
        category: entry.category,
        revisedAt: dateStr,
        revisedDate: date,
      })
    }

    if (input.sortBy === "recent") {
      hits.sort((a, b) => (b.revisedDate?.getTime() ?? 0) - (a.revisedDate?.getTime() ?? 0))
    } else if (input.sortBy === "institution") {
      hits.sort((a, b) => a.apbaId.localeCompare(b.apbaId) || a.title.localeCompare(b.title))
    } else {
      hits.sort((a, b) => a.title.localeCompare(b.title))
    }
    const sliced = hits.slice(0, input.max)

    const filterDesc: string[] = []
    if (input.query) filterDesc.push(`제목="${input.query}"`)
    if (input.category) filterDesc.push(`category=${input.category}`)
    if (input.ministry) filterDesc.push(`주무부처="${input.ministry}"`)
    if (input.type) filterDesc.push(`유형="${input.type}"`)
    if (input.fromDate || input.toDate) filterDesc.push(`기간=${input.fromDate ?? ""}~${input.toDate ?? ""}`)
    if (input.institutions?.length) filterDesc.push(`기관=[${input.institutions.length}건]`)

    const lines: string[] = []
    lines.push(`# ALIO 복합 검색`)
    lines.push(`> 필터: ${filterDesc.length ? filterDesc.join(" / ") : "(없음 — 전체)"}`)
    lines.push(`> 정렬: ${input.sortBy} | 매칭 ${hits.length}건 / 표시 ${sliced.length}건`)
    lines.push("")

    if (sliced.length === 0) {
      lines.push("- 조건에 맞는 규정이 없습니다.")
    } else {
      for (const h of sliced) {
        const cat = h.category ? ` [${h.category}]` : ""
        const date = h.revisedAt ? ` (${h.revisedAt})` : ""
        lines.push(`- [${h.apbaId}] ${h.apbaNa} (${h.typeNa}, ${h.jidtNa})`)
        lines.push(`  └ ${h.title}${cat}${date} — regId=${h.regId}`)
      }
    }

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "advanced_alio_search")
  }
}

function parseAlioDate(s: string): Date | null {
  if (!s) return null
  const cleaned = s.trim().replace(/[./]/g, "-")
  let m = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!m && /^\d{8}$/.test(s.trim())) {
    const t = s.trim()
    m = ["", t.slice(0, 4), t.slice(4, 6), t.slice(6, 8)] as RegExpMatchArray
  }
  if (!m) return null
  const [, y, mo, d] = m
  const date = new Date(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00`)
  return isNaN(date.getTime()) ? null : date
}
