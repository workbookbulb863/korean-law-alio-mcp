/**
 * search_alio_regulation_text — 전체 수집 규정 본문 키워드 검색
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import {
  findInstitution,
  loadIndex,
  readRegulationMd,
} from "../../lib/alio/index-loader.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const SearchAlioRegulationTextSchema = z.object({
  query: z.string().min(2).describe("검색 키워드(2자 이상)"),
  institutions: z
    .array(z.string())
    .optional()
    .describe("대상 기관코드(또는 기관명) 목록. 생략 시 전체 기관"),
  maxPerRegulation: z.number().min(1).max(5).default(2).describe("규정당 최대 스니펫 수"),
  maxResults: z.number().min(1).max(50).default(20).describe("전체 최대 결과 수"),
})

export type SearchAlioRegulationTextInput = z.infer<typeof SearchAlioRegulationTextSchema>

export async function searchAlioRegulationText(
  _api: LawApiClient,
  input: SearchAlioRegulationTextInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()
    const needle = input.query.trim()
    if (!needle) {
      return { content: [{ type: "text", text: "검색어가 비어 있습니다." }], isError: true }
    }

    // 대상 기관 필터
    const allowedApbaIds: Set<string> | null = input.institutions
      ? new Set(
          input.institutions
            .map((s) => findInstitution(idx, s)?.apbaId)
            .filter((x): x is string => !!x)
        )
      : null

    const targets = idx.flatRegulations.filter(
      (r) => !allowedApbaIds || allowedApbaIds.has(r.inst.apbaId)
    )

    const results: Array<{
      instName: string
      apbaId: string
      title: string
      regId: string
      fallbackParser?: string
      snippets: Array<{ lineNo: number; text: string }>
    }> = []

    for (const { inst, entry } of targets) {
      if (results.length >= input.maxResults) break
      if (!entry.mdPath) continue
      const md = await readRegulationMd(inst.apbaId, entry.regId)
      if (!md) continue
      if (!md.includes(needle)) continue
      const snippets = findSnippets(md, needle, input.maxPerRegulation)
      if (snippets.length === 0) continue
      results.push({
        instName: inst.apbaNa,
        apbaId: inst.apbaId,
        title: entry.title,
        regId: entry.regId,
        fallbackParser: entry.fallbackParser,
        snippets,
      })
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: `'${needle}' 히트 없음` }] }
    }

    const lines: string[] = []
    lines.push(`'${needle}' — ${results.length}개 규정에서 히트`)
    lines.push("")
    for (const r of results) {
      const ocrBadge = r.fallbackParser ? ` [OCR:${r.fallbackParser}]` : ""
      lines.push(`▶ [${r.apbaId}] ${r.instName} — ${r.title} (regId=${r.regId})${ocrBadge}`)
      for (const s of r.snippets) {
        lines.push(`  L${s.lineNo}: ${s.text.slice(0, 180)}`)
      }
      lines.push("")
    }
    const ocrCount = results.filter((r) => r.fallbackParser).length
    if (ocrCount > 0) {
      lines.push(`ℹ️ ${ocrCount}건은 OCR 변환 본문이므로 정확한 인용이 필요하면 원본 PDF 참조 권장.`)
    }
    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "search_alio_regulation_text")
  }
}

function findSnippets(
  md: string,
  needle: string,
  max: number
): Array<{ lineNo: number; text: string }> {
  const out: Array<{ lineNo: number; text: string }> = []
  const lines = md.split(/\r?\n/)
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (lines[i].includes(needle)) {
      out.push({ lineNo: i + 1, text: lines[i] })
    }
  }
  return out
}
