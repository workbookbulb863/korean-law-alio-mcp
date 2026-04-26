/**
 * parse_alio_article_links — 규정 본문의 "제N조" 참조 추출 + 같은 규정 내 위치 매칭
 *
 * 패턴은 법제처 `parse_article_links` 와 동일.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex, readRegulationMd } from "../../lib/alio/index-loader.js"
import { splitArticles } from "../../lib/alio/compare.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const ParseAlioArticleLinksSchema = z
  .object({
    institution: z.string().describe("기관코드 또는 기관명"),
    regId: z.string().optional(),
    title: z.string().optional().describe("regId 대신 사용 가능"),
    article: z.string().optional().describe("특정 조문만 분석 (예: '제15조'). 생략 시 전체 본문"),
    max: z.number().min(1).max(200).default(50).describe("최대 참조 표시 (기본:50)"),
  })
  .refine((v) => !!(v.regId || v.title), {
    message: "regId 또는 title 중 하나는 필수",
    path: ["regId"],
  })

export type ParseAlioArticleLinksInput = z.infer<typeof ParseAlioArticleLinksSchema>

export async function parseAlioArticleLinks(
  _api: LawApiClient,
  input: ParseAlioArticleLinksInput
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
        content: [{ type: "text", text: `본문 파일 없음` }],
        isError: true,
      }
    }

    const sections = splitArticles(md)
    // 같은 규정의 모든 조문 키 (정확 매칭용)
    const knownKeys = new Set(sections.map((s) => articleKey(s.heading)))
    const headingByKey = new Map(sections.map((s) => [articleKey(s.heading), s.heading]))

    // 분석 대상 본문
    let analyzeText: string
    let scopeLabel: string
    if (input.article) {
      const target = articleKey(input.article)
      const hit = sections.find((s) => articleKey(s.heading) === target)
      if (!hit) {
        return {
          content: [{ type: "text", text: `'${input.article}' 조문 없음` }],
          isError: true,
        }
      }
      analyzeText = hit.body
      scopeLabel = hit.heading
    } else {
      analyzeText = md
      scopeLabel = "전체 본문"
    }

    // "제N조", "제N조의M", "같은 조", "전조" 패턴 추출
    const refRegex = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g
    interface Ref {
      raw: string
      key: string
      resolved: boolean
      heading?: string
      occurrence: number
    }
    const refMap = new Map<string, Ref>()
    let m: RegExpExecArray | null
    while ((m = refRegex.exec(analyzeText)) !== null) {
      const raw = m[0]
      const key = `제${m[1]}조${m[2] ? `의${m[2]}` : ""}`
      const existing = refMap.get(key)
      if (existing) {
        existing.occurrence++
      } else {
        refMap.set(key, {
          raw: key,
          key,
          resolved: knownKeys.has(key),
          heading: headingByKey.get(key),
          occurrence: 1,
        })
      }
    }

    const refs = [...refMap.values()].sort(
      (a, b) =>
        b.occurrence - a.occurrence ||
        Number((a.key.match(/\d+/) ?? ["0"])[0]) - Number((b.key.match(/\d+/) ?? ["0"])[0])
    )
    const sliced = refs.slice(0, input.max)

    const lines: string[] = []
    lines.push(`# 조문 참조 분석 — [${inst.apbaId}] ${inst.apbaNa}`)
    lines.push(`> 규정: ${entry.title} (regId=${entry.regId})`)
    lines.push(`> 분석 범위: ${scopeLabel}`)
    lines.push(`> 발견된 참조: ${refs.length}개 (표시 ${sliced.length})`)
    lines.push("")

    if (sliced.length === 0) {
      lines.push("- 조문 참조가 없습니다.")
    } else {
      for (const r of sliced) {
        const status = r.resolved ? `→ ${r.heading}` : "(같은 규정 내 미존재 — 외부 참조 가능성)"
        lines.push(`- ${r.key} (${r.occurrence}회) ${status}`)
      }
    }

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "parse_alio_article_links")
  }
}

function articleKey(s: string): string {
  return s.replace(/\s+/g, "").replace(/\([^)]*\)/g, "")
}
