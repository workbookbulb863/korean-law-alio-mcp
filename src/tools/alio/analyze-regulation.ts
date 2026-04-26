/**
 * analyze_alio_regulation — 한 규정의 메타 + 구조 분석
 *
 * ALIO 메타(분류, 제정/개정일, 파일 출처) + 본문 구조(조문 수, 별표 수, 본문 길이)
 * + 주요 조문 목차. 패턴은 법제처 `analyze_document` 의 ALIO 특화 버전.
 *
 * 깊은 리스크/금액 분석은 별도의 `analyze_document` 도구에 본문을 넘겨 활용.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex, readRegulationMd } from "../../lib/alio/index-loader.js"
import { splitArticles } from "../../lib/alio/compare.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const AnalyzeAlioRegulationSchema = z
  .object({
    institution: z.string().describe("기관코드 또는 기관명"),
    regId: z.string().optional(),
    title: z.string().optional().describe("regId 대신 사용 가능"),
    showTOC: z.boolean().default(true).describe("조문 목차 표시"),
    maxTocItems: z.number().min(5).max(100).default(30).describe("목차 최대 표시 수"),
  })
  .refine((v) => !!(v.regId || v.title), {
    message: "regId 또는 title 중 하나는 필수",
    path: ["regId"],
  })

export type AnalyzeAlioRegulationInput = z.infer<typeof AnalyzeAlioRegulationSchema>

export async function analyzeAlioRegulation(
  _api: LawApiClient,
  input: AnalyzeAlioRegulationInput
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
        content: [{ type: "text", text: `규정을 찾을 수 없습니다.` }],
        isError: true,
      }
    }
    const md = await readRegulationMd(inst.apbaId, entry.regId)
    if (!md) {
      return {
        content: [{ type: "text", text: `본문 파일 없음 (parseError: ${entry.parseError ?? "(없음)"})` }],
        isError: true,
      }
    }

    const articles = splitArticles(md)
    const annexCount = (md.match(/\[\s*별\s*표\s*\d*\s*\]/g) || []).length
    const formCount = (md.match(/\[\s*별\s*지\s*\d*\s*\]/g) || []).length
    const tableCount = (md.match(/^\|.*\|.*$/gm) || []).length // markdown 표 행
    const lineCount = md.split("\n").length

    const lines: string[] = []
    lines.push(`# 규정 분석 — [${inst.apbaId}] ${inst.apbaNa}`)
    lines.push("")
    lines.push("## 메타")
    lines.push(`- 규정명: ${entry.title}`)
    lines.push(`- regId: ${entry.regId}`)
    lines.push(`- 분류: ${entry.category ?? "(미분류)"}`)
    lines.push(`- 제정: ${entry.issuedAt ?? "(미상)"} | 최근 개정: ${entry.revisedAt ?? "(미상)"}`)
    lines.push(`- 개정 이력: ${entry.revisions?.length ?? 0}회`)
    lines.push(`- 원본 파일: ${entry.primaryFileName ?? "(이름 없음)"} (${entry.fileType ?? "?"})`)
    if (entry.fallbackParser) {
      lines.push(`- ⚠️ OCR 변환: ${entry.fallbackParser} (정확도 한계 가능)`)
    }
    lines.push("")
    lines.push("## 구조")
    lines.push(`- 본문 라인 수: ${lineCount.toLocaleString()}`)
    lines.push(`- 본문 길이: ${md.length.toLocaleString()}자`)
    lines.push(`- 조문 수: ${articles.length}개`)
    lines.push(`- 별표: ${annexCount}건`)
    lines.push(`- 별지/서식: ${formCount}건`)
    lines.push(`- 마크다운 표 행: ${tableCount}행`)

    if (input.showTOC && articles.length > 0) {
      lines.push("")
      lines.push(`## 조문 목차 (top ${Math.min(input.maxTocItems, articles.length)})`)
      const topArts = articles.slice(0, input.maxTocItems)
      for (const a of topArts) {
        lines.push(`- ${a.heading}`)
      }
      if (articles.length > input.maxTocItems) {
        lines.push(`- ... (총 ${articles.length}개 중 ${input.maxTocItems}개 표시)`)
      }
    }

    lines.push("")
    lines.push("> 💡 깊은 리스크/금액/조항 충돌 분석은 본문을 `analyze_document` 도구에 전달.")

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "analyze_alio_regulation")
  }
}
