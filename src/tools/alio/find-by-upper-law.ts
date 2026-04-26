/**
 * find_regulations_by_upper_law — 특정 상위 법령을 근거로 삼는 공공기관 규정 역검색
 *
 * extractReferences 를 전체 규정 본문에 적용하여 lawName 이 일치/포함되는 것 필터.
 * article 이 주어지면 같은 조문까지 일치해야 매치.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { loadIndex, readRegulationMd, normalize } from "../../lib/alio/index-loader.js"
import { extractReferences } from "../../lib/alio/compare.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const FindRegulationsByUpperLawSchema = z.object({
  lawName: z.string().min(2).describe("상위 법령명 (예: '공공기관의 운영에 관한 법률', '방송통신발전 기본법')"),
  article: z.string().optional().describe("특정 조문 제한 (예: '제26조'). 생략 시 법령명만 매칭"),
  institutions: z
    .array(z.string())
    .optional()
    .describe("조회 대상 기관코드 목록. 생략 시 전체 수집 기관"),
  matchMode: z
    .enum(["exact", "partial"])
    .default("partial")
    .describe("법령명 매칭 방식: exact=정확 일치, partial=부분 일치(기본)"),
  maxResults: z.number().min(1).max(100).default(30).describe("최대 결과 수"),
})

export type FindRegulationsByUpperLawInput = z.infer<typeof FindRegulationsByUpperLawSchema>

export async function findRegulationsByUpperLaw(
  _api: LawApiClient,
  input: FindRegulationsByUpperLawInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()

    const allowedIds: Set<string> | null = input.institutions
      ? new Set(
          input.institutions
            .map((s) => {
              const inst = idx.institutions.find((i) => i.apbaId === s) ||
                idx.institutions.find((i) => normalize(i.apbaNa).includes(normalize(s)))
              return inst?.apbaId
            })
            .filter((x): x is string => !!x)
        )
      : null

    const targetLaw = input.lawName.trim()
    const targetLawNorm = normalize(targetLaw)
    const targetArticle = input.article ? normalizeArticle(input.article) : undefined

    interface Hit {
      apbaId: string
      apbaNa: string
      regId: string
      title: string
      matches: Array<{ lawName: string; article?: string; context: string }>
    }
    const hits: Hit[] = []

    for (const { inst, entry } of idx.flatRegulations) {
      if (allowedIds && !allowedIds.has(inst.apbaId)) continue
      if (!entry.mdPath || entry.parseError) continue
      if (hits.length >= input.maxResults) break

      const md = await readRegulationMd(inst.apbaId, entry.regId)
      if (!md) continue
      // 1차 빠른 필터: 텍스트 상에 법령명 후보가 없으면 파싱 스킵
      if (input.matchMode === "exact") {
        if (!md.includes(targetLaw)) continue
      } else {
        // partial: 공백 제거 후 포함 체크 (관해 -> 관한 등 약간의 변형은 놓칠 수 있지만 충분)
        if (!normalize(md).includes(targetLawNorm)) continue
      }

      const refs = extractReferences(md)
      const matching = refs.external.filter((r) => {
        const nameMatch =
          input.matchMode === "exact"
            ? r.lawName === targetLaw
            : normalize(r.lawName).includes(targetLawNorm) ||
              targetLawNorm.includes(normalize(r.lawName))
        if (!nameMatch) return false
        if (!targetArticle) return true
        return r.article && normalizeArticle(r.article) === targetArticle
      })

      if (matching.length === 0) continue
      hits.push({
        apbaId: inst.apbaId,
        apbaNa: inst.apbaNa,
        regId: entry.regId,
        title: entry.title,
        matches: matching.slice(0, 3).map((r) => ({
          lawName: r.lawName,
          article: r.article,
          context: r.line.slice(0, 140),
        })),
      })
    }

    const lines: string[] = []
    lines.push(
      `▶ '${targetLaw}'${targetArticle ? ` ${targetArticle}` : ""} 를 근거로 삼는 ALIO 공공기관 규정`
    )
    lines.push(`   (매칭모드: ${input.matchMode}, 기관 범위: ${allowedIds ? `${allowedIds.size}개` : "전체"})`)
    lines.push("")

    if (hits.length === 0) {
      lines.push("히트 없음.")
      lines.push("")
      lines.push("💡 제안:")
      lines.push(`   - matchMode="partial" 로 변경 (현재 ${input.matchMode})`)
      lines.push(`   - article 생략하고 법령명만으로 재검색`)
      lines.push(`   - search_alio_regulation_text(query="${targetLaw}") 로 원문 검색도 함께`)
      return { content: [{ type: "text", text: lines.join("\n") }] }
    }

    // 기관별 그룹핑
    const byInst = new Map<string, Hit[]>()
    for (const h of hits) {
      const arr = byInst.get(h.apbaId) || []
      arr.push(h)
      byInst.set(h.apbaId, arr)
    }

    lines.push(`총 ${hits.length}건 / ${byInst.size}개 기관`)
    lines.push("")
    for (const [apbaId, group] of byInst) {
      lines.push(`● [${apbaId}] ${group[0].apbaNa} (${group.length}건)`)
      for (const h of group) {
        lines.push(`  - ${h.title} (regId=${h.regId})`)
        for (const m of h.matches) {
          const art = m.article ? ` ${m.article}` : ""
          lines.push(`      · "${m.lawName}${art}"  …  ${m.context}`)
        }
      }
      lines.push("")
    }

    lines.push(
      `💡 규정 본문: get_alio_regulation(institution="<apbaId>", regId="<regId>")`
    )
    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "find_regulations_by_upper_law")
  }
}

/** "제10조", "제10조의2" 등을 정규화. 공백 제거 + 소문자 (한글은 그대로) */
function normalizeArticle(s: string): string {
  return s.replace(/\s+/g, "")
}
