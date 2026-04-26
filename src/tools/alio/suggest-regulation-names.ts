/**
 * suggest_alio_regulation_names — ALIO 규정 제목 자동완성/부분일치
 *
 * 사용자가 정확한 제목을 모를 때 키워드로 후보 목록 반환.
 * 패턴은 법제처 `suggest_law_names` 와 동일.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex } from "../../lib/alio/index-loader.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const SuggestAlioRegulationNamesSchema = z.object({
  query: z.string().min(1).describe("규정 제목 키워드 (부분 매칭, 예: '인사', '징계')"),
  institution: z.string().optional().describe("기관 제한 (apbaId 또는 기관명). 생략 시 전체 기관"),
  max: z.number().min(1).max(50).default(20).describe("최대 결과 수 (기본:20)"),
})

export type SuggestAlioRegulationNamesInput = z.infer<typeof SuggestAlioRegulationNamesSchema>

export async function suggestAlioRegulationNames(
  _api: LawApiClient,
  input: SuggestAlioRegulationNamesInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()
    const q = input.query.trim().toLowerCase()
    if (q.length === 0) {
      return { content: [{ type: "text", text: "query 가 비어있습니다." }], isError: true }
    }

    const targetInst = input.institution ? findInstitution(idx, input.institution) : null
    if (input.institution && !targetInst) {
      return {
        content: [{ type: "text", text: `기관을 찾을 수 없습니다: ${input.institution}` }],
        isError: true,
      }
    }

    interface Hit {
      apbaId: string
      apbaNa: string
      regId: string
      title: string
      category?: string
      score: number // 매칭 우선순위 (정확일치=2, 시작일치=1, 부분일치=0)
    }

    const hits: Hit[] = []
    for (const { inst, entry } of idx.flatRegulations) {
      if (targetInst && inst.apbaId !== targetInst.apbaId) continue
      const title = entry.title.toLowerCase()
      let score = -1
      if (title === q) score = 2
      else if (title.startsWith(q)) score = 1
      else if (title.includes(q)) score = 0
      if (score < 0) continue
      hits.push({
        apbaId: inst.apbaId,
        apbaNa: inst.apbaNa,
        regId: entry.regId,
        title: entry.title,
        category: entry.category,
        score,
      })
    }

    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    const sliced = hits.slice(0, input.max)

    const lines: string[] = []
    lines.push(`# 자동완성 결과 — "${input.query}"`)
    if (targetInst) lines.push(`> 기관: [${targetInst.apbaId}] ${targetInst.apbaNa}`)
    lines.push(`> 매칭 ${hits.length}건 / 표시 ${sliced.length}건`)
    lines.push("")

    if (sliced.length === 0) {
      lines.push("- 일치하는 규정이 없습니다.")
    } else {
      for (const h of sliced) {
        const cat = h.category ? ` [${h.category}]` : ""
        const prefix = h.score === 2 ? "★" : h.score === 1 ? "▶" : "•"
        lines.push(`${prefix} [${h.apbaId}] ${h.apbaNa} — ${h.title}${cat} (regId=${h.regId})`)
      }
    }

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "suggest_alio_regulation_names")
  }
}
