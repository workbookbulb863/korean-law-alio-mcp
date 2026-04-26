/**
 * compare_alio_articles — 두 규정의 같은 조문 1:1 정밀 비교
 *
 * compare_alio_regulations 는 토픽 기반 N:N 매칭. 이 도구는 *지정한 두 규정* 의
 * 같은 조문(예: 제15조)을 나란히 출력. 패턴은 법제처 `compare_articles` 와 동일.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex, readRegulationMd } from "../../lib/alio/index-loader.js"
import { splitArticles } from "../../lib/alio/compare.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

const RegRefSchema = z.object({
  institution: z.string().describe("기관코드 또는 기관명"),
  regId: z.string().optional(),
  title: z.string().optional().describe("regId 대신 사용 가능"),
})

export const CompareAlioArticlesSchema = z.object({
  pair: z.array(RegRefSchema).length(2).describe("비교할 두 규정 — [{institution, regId|title}, {...}]"),
  article: z.string().describe("비교할 조문 (예: '제15조', '제10조의2')"),
})

export type CompareAlioArticlesInput = z.infer<typeof CompareAlioArticlesSchema>

export async function compareAlioArticles(
  _api: LawApiClient,
  input: CompareAlioArticlesInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()
    const target = articleKey(input.article)

    const sides: Array<{ label: string; section: { heading: string; body: string } | null; warn?: string }> = []

    for (const ref of input.pair) {
      const inst = findInstitution(idx, ref.institution)
      if (!inst) {
        sides.push({ label: ref.institution, section: null, warn: `기관 못 찾음: ${ref.institution}` })
        continue
      }
      const manifest = idx.manifests.get(inst.apbaId)
      const entry = manifest?.regulations.find((r) =>
        ref.regId ? r.regId === ref.regId : ref.title ? r.title.includes(ref.title) : false
      )
      if (!entry) {
        sides.push({ label: `[${inst.apbaId}] ${inst.apbaNa}`, section: null, warn: "규정 못 찾음" })
        continue
      }
      const md = await readRegulationMd(inst.apbaId, entry.regId)
      if (!md) {
        sides.push({
          label: `[${inst.apbaId}] ${inst.apbaNa} — ${entry.title}`,
          section: null,
          warn: "본문 파일 없음",
        })
        continue
      }
      const sections = splitArticles(md)
      const hit = sections.find((s) => articleKey(s.heading) === target)
      sides.push({
        label: `[${inst.apbaId}] ${inst.apbaNa} — ${entry.title}`,
        section: hit ? { heading: hit.heading, body: hit.body } : null,
        warn: hit ? undefined : `'${input.article}' 조문 없음 (사용 가능: ${sections.slice(0, 8).map((s) => s.heading).join(", ")})`,
      })
    }

    const lines: string[] = []
    lines.push(`# 조문 1:1 비교 — ${input.article}`)
    lines.push("")

    const sectionTexts: string[] = []
    for (const side of sides) {
      const part: string[] = []
      part.push(`## ▶ ${side.label}`)
      if (side.warn) part.push(`> ⚠️ ${side.warn}`)
      if (side.section) {
        part.push("")
        part.push(`### ${side.section.heading}`)
        part.push("")
        part.push(side.section.body.trim())
      }
      sectionTexts.push(part.join("\n"))
    }

    const merged = lines.join("\n") + "\n\n" + sectionTexts.join("\n\n---\n\n")
    return { content: [{ type: "text", text: truncateResponse(merged) }] }
  } catch (err) {
    return formatToolError(err, "compare_alio_articles")
  }
}

function articleKey(s: string): string {
  return s.replace(/\s+/g, "").replace(/\([^)]*\)/g, "")
}
