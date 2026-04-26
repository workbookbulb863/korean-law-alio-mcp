/**
 * get_alio_annexes — 규정 본문에서 [별표 N] 섹션만 추출
 *
 * 패턴은 법제처 `get_annexes` 와 동일하지만, ALIO 는 본문 markdown 에서 정규식 추출.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex, readRegulationMd } from "../../lib/alio/index-loader.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const GetAlioAnnexesSchema = z
  .object({
    institution: z.string().describe("기관코드 또는 기관명"),
    regId: z.string().optional().describe("규정 ID"),
    title: z.string().optional().describe("규정 제목 부분일치 (regId 대신)"),
    annexNumber: z
      .number()
      .optional()
      .describe("특정 별표 번호만 (예: 1 → [별표 1] 만). 생략 시 전체 별표"),
    listOnly: z.boolean().default(false).describe("본문 없이 별표 목록만"),
  })
  .refine((v) => !!(v.regId || v.title), {
    message: "regId 또는 title 중 하나는 필수",
    path: ["regId"],
  })

export type GetAlioAnnexesInput = z.infer<typeof GetAlioAnnexesSchema>

interface AnnexSection {
  number: number | null
  heading: string
  body: string
}

export async function getAlioAnnexes(
  _api: LawApiClient,
  input: GetAlioAnnexesInput
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
    const entry = manifest?.regulations.find((r) =>
      input.regId ? r.regId === input.regId : input.title ? r.title.includes(input.title) : false
    )
    if (!entry) {
      return {
        content: [
          { type: "text", text: `규정을 찾을 수 없습니다. institution=${inst.apbaId}` },
        ],
        isError: true,
      }
    }

    const md = await readRegulationMd(inst.apbaId, entry.regId)
    if (!md) {
      return {
        content: [{ type: "text", text: `본문 파일을 읽을 수 없습니다: ${entry.mdPath}` }],
        isError: true,
      }
    }

    const annexes = extractAnnexes(md)
    const filtered = input.annexNumber
      ? annexes.filter((a) => a.number === input.annexNumber)
      : annexes

    const lines: string[] = []
    lines.push(`# [${inst.apbaId}] ${inst.apbaNa} — ${entry.title}`)
    lines.push(`> 별표 ${annexes.length}개 발견${input.annexNumber ? ` (#${input.annexNumber}만 표시)` : ""}`)
    lines.push("")

    if (filtered.length === 0) {
      lines.push("- 별표가 없거나 해당 번호의 별표가 없습니다.")
      if (annexes.length > 0) {
        lines.push("")
        lines.push("발견된 별표 목록:")
        annexes.forEach((a) => lines.push(`- ${a.heading}`))
      }
    } else if (input.listOnly) {
      filtered.forEach((a) => lines.push(`- ${a.heading}`))
    } else {
      for (const a of filtered) {
        lines.push("---")
        lines.push(`## ${a.heading}`)
        lines.push("")
        lines.push(a.body.trim())
        lines.push("")
      }
    }

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "get_alio_annexes")
  }
}

/** markdown 본문에서 [별표 N] 섹션 추출 */
function extractAnnexes(md: string): AnnexSection[] {
  // 헤딩 패턴: "## [별표 1]" 또는 "[별표 1] 제목" 또는 "[별표1]" / "[별 표 1]"
  const headRe = /^#{0,6}\s*\[\s*별\s*표\s*(\d+)?\s*\]([^\n]*)$/gm
  const matches: Array<{ idx: number; num: number | null; head: string }> = []
  let m: RegExpExecArray | null
  while ((m = headRe.exec(md)) !== null) {
    matches.push({
      idx: m.index,
      num: m[1] ? Number(m[1]) : null,
      head: m[0].replace(/^#+\s*/, "").trim(),
    })
  }
  if (matches.length === 0) return []

  const sections: AnnexSection[] = []
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]
    const next = matches[i + 1]
    const start = cur.idx + matches[i].head.length // heading 직후
    const end = next ? next.idx : md.length
    sections.push({
      number: cur.num,
      heading: cur.head,
      body: md.slice(start, end).trim(),
    })
  }
  return sections
}
