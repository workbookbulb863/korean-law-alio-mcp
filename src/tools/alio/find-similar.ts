/**
 * find_similar_regulations — 한 규정과 유사한 다른 기관 규정 (1:N 매칭)
 *
 * 기준 규정 1건과 제목 유사도가 높은 다른 기관 규정 N개 반환.
 * "우리 ○○ 규정이랑 비슷한 거 다른 기관에선?" — 직접 벤치마킹용.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex } from "../../lib/alio/index-loader.js"
import { titleSimilarity } from "../../lib/alio/compare.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const FindSimilarRegulationsSchema = z.object({
  institution: z.string().describe("기준 기관 코드(apbaId) 또는 기관명 일부"),
  regId: z.string().optional().describe("기준 규정 ID. title 과 둘 중 하나"),
  title: z.string().optional().describe("기준 규정 제목 부분일치. regId 대신 사용 가능"),
  threshold: z.number().min(0).max(1).default(0.4).describe("유사도 하한 (0~1, 기본:0.4)"),
  excludeBase: z.boolean().default(true).describe("기준 기관의 다른 규정 제외 (기본:true — 다른 기관만 검색)"),
  max: z.number().min(1).max(50).default(10).describe("최대 결과 수 (기본:10)"),
})

export type FindSimilarRegulationsInput = z.infer<typeof FindSimilarRegulationsSchema>

export async function findSimilarRegulations(
  _api: LawApiClient,
  input: FindSimilarRegulationsInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()
    const baseInst = findInstitution(idx, input.institution)
    if (!baseInst) {
      return {
        content: [{ type: "text", text: `기준 기관을 찾을 수 없습니다: ${input.institution}` }],
        isError: true,
      }
    }

    const manifest = idx.manifests.get(baseInst.apbaId)
    if (!manifest) {
      return {
        content: [{ type: "text", text: `기준 기관의 manifest 없음: ${baseInst.apbaId}` }],
        isError: true,
      }
    }

    if (!input.regId && !input.title) {
      return {
        content: [{ type: "text", text: "regId 또는 title 중 하나는 필수입니다." }],
        isError: true,
      }
    }

    // 기준 규정 찾기
    let baseReg = input.regId
      ? manifest.regulations.find((r) => r.regId === input.regId)
      : undefined
    if (!baseReg && input.title) {
      const t = input.title.toLowerCase()
      baseReg = manifest.regulations.find((r) => r.title.toLowerCase().includes(t))
    }
    if (!baseReg) {
      return {
        content: [
          {
            type: "text",
            text: `기준 규정을 찾을 수 없습니다. list_alio_regulations(institution="${baseInst.apbaId}") 로 확인하세요.`,
          },
        ],
        isError: true,
      }
    }

    // 모든 다른 규정 vs 기준 — 유사도 계산
    interface Hit {
      score: number
      apbaId: string
      apbaNa: string
      regId: string
      title: string
      category?: string
    }

    const hits: Hit[] = []
    for (const { inst, entry } of idx.flatRegulations) {
      if (input.excludeBase && inst.apbaId === baseInst.apbaId) continue
      // 기준 규정 자체는 항상 제외
      if (inst.apbaId === baseInst.apbaId && entry.regId === baseReg.regId) continue

      const score = titleSimilarity(baseReg.title, entry.title)
      if (score < input.threshold) continue

      hits.push({
        score,
        apbaId: inst.apbaId,
        apbaNa: inst.apbaNa,
        regId: entry.regId,
        title: entry.title,
        category: entry.category,
      })
    }

    hits.sort((a, b) => b.score - a.score)
    const sliced = hits.slice(0, input.max)

    const lines: string[] = []
    lines.push(`# 유사 규정 검색`)
    lines.push("")
    lines.push(`## 기준`)
    lines.push(`- 기관: [${baseInst.apbaId}] ${baseInst.apbaNa}`)
    lines.push(`- 규정: ${baseReg.title} (regId=${baseReg.regId}${baseReg.category ? `, category=${baseReg.category}` : ""})`)
    lines.push(`- 유사도 하한: ${input.threshold} | excludeBase: ${input.excludeBase}`)
    lines.push("")
    lines.push(`## 매칭 (${hits.length}건 / 표시 ${sliced.length}건)`)

    if (sliced.length === 0) {
      lines.push("- 조건을 만족하는 유사 규정이 없습니다. threshold 를 낮춰보세요.")
    } else {
      for (const h of sliced) {
        const cat = h.category ? ` [${h.category}]` : ""
        lines.push(`- [유사도 ${h.score.toFixed(2)}] [${h.apbaId}] ${h.apbaNa} — ${h.title}${cat} (regId=${h.regId})`)
      }
    }

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "find_similar_regulations")
  }
}
