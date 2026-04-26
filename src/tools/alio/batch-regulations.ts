/**
 * get_batch_alio_regulations — 여러 ALIO 규정/조문 일괄 조회
 *
 * LLM 토큰/호출 효율 — 단건씩 호출하는 대신 한 번에. 패턴은 법제처 `get_batch_articles` 와 동일.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex, readRegulationMd } from "../../lib/alio/index-loader.js"
import { splitArticles } from "../../lib/alio/compare.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

const ItemSchema = z.object({
  institution: z.string().describe("기관코드 또는 기관명"),
  regId: z.string().optional(),
  title: z.string().optional().describe("regId 대신 사용 가능"),
  article: z.string().optional().describe("특정 조문만 (예: '제15조'). 생략 시 전체 본문"),
})

export const GetBatchAlioRegulationsSchema = z.object({
  items: z.array(ItemSchema).min(1).max(20).describe("조회할 규정 목록 (최대 20건)"),
  bodyChars: z
    .number()
    .min(200)
    .max(10000)
    .default(2000)
    .describe("규정당 본문 최대 글자 수 (article 미지정 시 적용, 기본:2000)"),
})

export type GetBatchAlioRegulationsInput = z.infer<typeof GetBatchAlioRegulationsSchema>

export async function getBatchAlioRegulations(
  _api: LawApiClient,
  input: GetBatchAlioRegulationsInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()

    const sections: string[] = []
    let okCount = 0
    let errCount = 0

    for (const item of input.items) {
      const block: string[] = []
      const inst = findInstitution(idx, item.institution)
      if (!inst) {
        block.push(`## ❌ ${item.institution}`)
        block.push(`> 기관을 찾을 수 없습니다.`)
        sections.push(block.join("\n"))
        errCount++
        continue
      }
      const manifest = idx.manifests.get(inst.apbaId)
      const entry = manifest?.regulations.find((r) =>
        item.regId ? r.regId === item.regId : item.title ? r.title.includes(item.title) : false
      )
      if (!entry) {
        block.push(`## ❌ [${inst.apbaId}] ${inst.apbaNa}`)
        block.push(`> 규정을 찾을 수 없습니다 (${item.regId || item.title}).`)
        sections.push(block.join("\n"))
        errCount++
        continue
      }
      const md = await readRegulationMd(inst.apbaId, entry.regId)
      if (!md) {
        block.push(`## ⚠️ [${inst.apbaId}] ${inst.apbaNa} — ${entry.title}`)
        block.push(`> 본문 파일 없음`)
        sections.push(block.join("\n"))
        errCount++
        continue
      }

      block.push(`## [${inst.apbaId}] ${inst.apbaNa} — ${entry.title} (regId=${entry.regId})`)
      if (item.article) {
        const target = articleKey(item.article)
        const arts = splitArticles(md)
        const hit = arts.find((s) => articleKey(s.heading) === target)
        if (hit) {
          block.push(`### ${hit.heading}`)
          block.push("")
          block.push(hit.body.trim())
        } else {
          block.push(`> ⚠️ '${item.article}' 조문 없음`)
        }
      } else {
        const body = md.length > input.bodyChars ? md.slice(0, input.bodyChars) + "\n\n... (이하 생략)" : md
        block.push(body)
      }
      sections.push(block.join("\n"))
      okCount++
    }

    const header = `# 일괄 조회 — ${input.items.length}건 (성공 ${okCount} / 실패 ${errCount})\n\n`
    const merged = header + sections.join("\n\n---\n\n")
    return { content: [{ type: "text", text: truncateResponse(merged) }] }
  } catch (err) {
    return formatToolError(err, "get_batch_alio_regulations")
  }
}

function articleKey(s: string): string {
  return s.replace(/\s+/g, "").replace(/\([^)]*\)/g, "")
}
