/**
 * get_alio_external_links — ALIO 원본 페이지 + 첨부파일 다운로드 링크
 *
 * 사용자/검증자가 원본을 직접 확인하고 싶을 때.
 * 패턴은 법제처 `get_external_links` 와 동일.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex } from "../../lib/alio/index-loader.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

const ALIO_DOWNLOAD = "https://www.alio.go.kr/download/rulefiledown.json"

export const GetAlioExternalLinksSchema = z
  .object({
    institution: z.string().describe("기관코드(apbaId) 또는 기관명 일부"),
    regId: z.string().optional().describe("규정 ID (list_alio_regulations 의 regId)"),
    title: z.string().optional().describe("규정 제목 부분일치 (regId 대신)"),
    includeRevisions: z.boolean().default(true).describe("과거 개정본 다운로드 링크 포함"),
  })
  .refine((v) => !!(v.regId || v.title), {
    message: "regId 또는 title 중 하나는 필수",
    path: ["regId"],
  })

export type GetAlioExternalLinksInput = z.infer<typeof GetAlioExternalLinksSchema>

export async function getAlioExternalLinks(
  _api: LawApiClient,
  input: GetAlioExternalLinksInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()
    const inst = findInstitution(idx, input.institution)
    if (!inst) {
      return {
        content: [{ type: "text", text: `기관을 찾을 수 없습니다: ${input.institution}` }],
        isError: true,
      }
    }
    const manifest = idx.manifests.get(inst.apbaId)
    if (!manifest) {
      return {
        content: [
          { type: "text", text: `[${inst.apbaId}] ${inst.apbaNa} — manifest 없음` },
        ],
        isError: true,
      }
    }
    const entry =
      (input.regId && manifest.regulations.find((r) => r.regId === input.regId)) ||
      (input.title && manifest.regulations.find((r) => r.title.includes(input.title!)))
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: `규정을 찾을 수 없습니다. list_alio_regulations(institution="${inst.apbaId}") 로 확인.`,
          },
        ],
        isError: true,
      }
    }

    const lines: string[] = []
    lines.push(`# 외부 링크 — [${inst.apbaId}] ${inst.apbaNa}`)
    lines.push(`> 규정: ${entry.title} (regId=${entry.regId}${entry.category ? `, ${entry.category}` : ""})`)
    lines.push(`> 제정: ${entry.issuedAt ?? "(미상)"} | 최근 개정: ${entry.revisedAt ?? "(미상)"}`)
    lines.push("")

    lines.push("## ALIO 원본 페이지")
    lines.push(`- ${entry.sourceDetailUrl}`)

    if (entry.primaryFileNo) {
      lines.push("")
      lines.push("## 현행본 다운로드")
      lines.push(`- ${entry.primaryFileName ?? "(이름 없음)"}`)
      lines.push(`  ${ALIO_DOWNLOAD}?fileNo=${entry.primaryFileNo}`)
    }

    if (input.includeRevisions && entry.revisions?.length) {
      lines.push("")
      lines.push(`## 과거 개정본 다운로드 (${entry.revisions.length}건)`)
      for (const rev of entry.revisions) {
        lines.push(`- ${rev.filename ?? "(이름 없음)"}`)
        lines.push(`  ${ALIO_DOWNLOAD}?fileNo=${rev.fileNo}`)
      }
    }

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "get_alio_external_links")
  }
}
