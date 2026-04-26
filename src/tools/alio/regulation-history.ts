/**
 * get_alio_regulation_history — manifest 에 기록된 개정 이력 조회
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex } from "../../lib/alio/index-loader.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const GetAlioRegulationHistorySchema = z.object({
  institution: z.string().describe("기관코드 또는 기관명 일부"),
  regId: z.string().optional().describe("규정 ID"),
  title: z.string().optional().describe("제목 부분일치 (regId 대신)"),
}).refine((v) => !!(v.regId || v.title), {
  message: "regId 또는 title 중 하나는 필수입니다",
  path: ["regId"],
})

export type GetAlioRegulationHistoryInput = z.infer<typeof GetAlioRegulationHistorySchema>

export async function getAlioRegulationHistory(
  _api: LawApiClient,
  input: GetAlioRegulationHistoryInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()
    const inst = findInstitution(idx, input.institution)
    if (!inst) {
      return {
        content: [{ type: "text", text: `기관을 찾을 수 없습니다: '${input.institution}'` }],
        isError: true,
      }
    }
    const manifest = idx.manifests.get(inst.apbaId)
    if (!manifest) {
      return {
        content: [{ type: "text", text: `manifest 없음: ${inst.apbaId}` }],
        isError: true,
      }
    }
    const entry =
      (input.regId && manifest.regulations.find((r) => r.regId === input.regId)) ||
      (input.title && manifest.regulations.find((r) => r.title.includes(input.title!)))
    if (!entry) {
      return { content: [{ type: "text", text: "규정을 찾을 수 없습니다." }], isError: true }
    }

    const lines: string[] = []
    lines.push(`[${inst.apbaId}] ${inst.apbaNa} — ${entry.title}`)
    lines.push(`제·개정일: ${entry.issuedAt || "-"} / 최종 수정일: ${entry.revisedAt || "-"}`)
    lines.push("")
    lines.push("● 개정본 이력 (ALIO 공시 기준, 최신이 아래):")
    for (const rev of entry.revisions) {
      lines.push(`  - ${rev.filename} (fileNo=${rev.fileNo})`)
    }
    lines.push(`  ★ ${entry.primaryFileName} (fileNo=${entry.primaryFileNo}) [현행]`)
    lines.push("")
    lines.push(`원본 페이지: ${entry.sourceDetailUrl}`)
    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "get_alio_regulation_history")
  }
}
