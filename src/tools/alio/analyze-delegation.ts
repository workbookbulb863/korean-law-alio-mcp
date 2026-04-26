/**
 * analyze_regulation_delegation — 규정 본문에서 상위 법령/상위 내부규정 참조를 추출
 *
 * ALIO 규정은 본문에 다음과 같은 참조를 자주 포함:
 *   - 「공공기관의 운영에 관한 법률」 제26조
 *   - 방송통신발전 기본법 제19조
 *   - 이 규칙은 회계규정 제60조에 의하여 위임된...
 *
 * 이 도구는:
 *   1. 규정 본문에서 외부 법령 / 내부 상위규정 참조를 정규식으로 추출
 *   2. 내부 참조는 같은 기관 manifest 에서 regId 매칭
 *   3. 선택적으로 외부 법령은 법제처 searchLaw 로 lawId/mst 조회하여 결과 첨부
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, loadIndex, readRegulationMd } from "../../lib/alio/index-loader.js"
import { extractReferences } from "../../lib/alio/compare.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import { DOMParser } from "@xmldom/xmldom"
import type { ToolResponse } from "../../lib/types.js"

export const AnalyzeRegulationDelegationSchema = z
  .object({
    institution: z.string().describe("기관코드(apbaId) 또는 기관명 일부"),
    regId: z.string().optional().describe("규정 ID (list_alio_regulations 의 regId)"),
    title: z.string().optional().describe("규정 제목 일부. regId 대체"),
    includeLawLookup: z
      .boolean()
      .default(false)
      .describe("외부 법령 참조를 법제처 searchLaw 로 조회해 MST/lawId 첨부 (최대 5개, 느림)"),
    lawLookupLimit: z.number().min(1).max(10).default(5).describe("searchLaw 호출 개수 상한"),
  })
  .refine((v) => !!(v.regId || v.title), {
    message: "regId 또는 title 중 하나는 필수",
    path: ["regId"],
  })

export type AnalyzeRegulationDelegationInput = z.infer<typeof AnalyzeRegulationDelegationSchema>

export async function analyzeRegulationDelegation(
  apiClient: LawApiClient,
  input: AnalyzeRegulationDelegationInput
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
        content: [{ type: "text", text: `[${inst.apbaId}] manifest 없음` }],
        isError: true,
      }
    }
    const entry =
      (input.regId && manifest.regulations.find((r) => r.regId === input.regId)) ||
      (input.title && manifest.regulations.find((r) => r.title.includes(input.title!)))
    if (!entry) {
      return {
        content: [{ type: "text", text: "규정을 찾을 수 없습니다." }],
        isError: true,
      }
    }
    if (!entry.mdPath) {
      return {
        content: [
          {
            type: "text",
            text: `${entry.title} — 본문이 없어 참조 추출 불가 (첨부파일 미수집).`,
          },
        ],
      }
    }
    const md = await readRegulationMd(inst.apbaId, entry.regId)
    if (!md || entry.parseError) {
      return {
        content: [
          {
            type: "text",
            text: `${entry.title} — 본문이 파싱되지 않아 참조 추출 불가 (${entry.parseError || "본문 없음"}).`,
          },
        ],
      }
    }

    const refs = extractReferences(md)

    // 내부 참조: 같은 기관 manifest 에서 제목 부분일치로 regId 매칭
    const internalResolved = refs.internal.map((r) => {
      const match = manifest.regulations.find((reg) => reg.title.includes(r.ruleName))
      return {
        ...r,
        resolvedRegId: match?.regId,
        resolvedTitle: match?.title,
      }
    })

    // 외부 법령: 선택적 법제처 조회
    type ExternalResolved = (typeof refs.external)[number] & {
      lawId?: string
      mst?: string
      lookupError?: string
    }
    const externalResolved: ExternalResolved[] = [...refs.external]
    if (input.includeLawLookup && refs.external.length > 0) {
      const limit = Math.min(refs.external.length, input.lawLookupLimit)
      for (let i = 0; i < limit; i++) {
        const ref = externalResolved[i]
        try {
          const xml = await apiClient.searchLaw(ref.lawName)
          const parsed = parseFirstLawFromXml(xml)
          if (parsed) {
            ref.lawId = parsed.lawId
            ref.mst = parsed.mst
          } else {
            ref.lookupError = "검색결과 없음"
          }
        } catch (err) {
          ref.lookupError = (err as Error).message.slice(0, 80)
        }
      }
    }

    // 포맷 출력
    const lines: string[] = []
    lines.push(`▶ [${inst.apbaId}] ${inst.apbaNa} — ${entry.title}`)
    lines.push(`   regId=${entry.regId}, 제·개정 ${entry.issuedAt || "-"} / 수정 ${entry.revisedAt || "-"}`)
    lines.push("")
    lines.push(`● 외부 법령 참조 (${externalResolved.length}건)`)
    if (externalResolved.length === 0) {
      lines.push("   (없음)")
    } else {
      for (const r of externalResolved) {
        const art = r.article ? ` ${r.article}` : ""
        const lookup =
          r.lawId || r.mst
            ? ` [lawId=${r.lawId || "-"}, mst=${r.mst || "-"}]`
            : r.lookupError
              ? ` [조회실패: ${r.lookupError}]`
              : ""
        lines.push(`   - ${r.lawName}${art}${lookup}`)
      }
      if (!input.includeLawLookup) {
        lines.push(`   💡 법제처 조회 원하면 includeLawLookup=true`)
      }
    }

    lines.push("")
    lines.push(`● 내부 상위규정 참조 (${internalResolved.length}건)`)
    if (internalResolved.length === 0) {
      lines.push("   (없음)")
    } else {
      for (const r of internalResolved) {
        const art = r.article ? ` ${r.article}` : ""
        const resolved = r.resolvedRegId
          ? ` → [regId=${r.resolvedRegId}] ${r.resolvedTitle}`
          : " (같은 기관 manifest 에서 매칭 안 됨)"
        lines.push(`   - ${r.ruleName}${art}${resolved}`)
      }
      const solved = internalResolved.filter((r) => r.resolvedRegId)
      if (solved.length > 0) {
        lines.push(
          `   💡 본문 열람: get_alio_regulation(institution="${inst.apbaId}", regId="<resolvedRegId>")`
        )
      }
    }

    lines.push("")
    lines.push("● 활용 힌트")
    if (externalResolved.length > 0) {
      const first = externalResolved[0]
      lines.push(
        `   - 외부 법령 본문: search_law(query="${first.lawName}")${first.article ? ` → get_law_text(mst=<mst>, jo="${first.article}")` : ""}`
      )
    }
    if (internalResolved.filter((r) => r.resolvedRegId).length > 0) {
      lines.push(`   - 내부 상위규정 본문: get_alio_regulation (위 regId 사용)`)
    }

    return { content: [{ type: "text", text: truncateResponse(lines.join("\n")) }] }
  } catch (err) {
    return formatToolError(err, "analyze_regulation_delegation")
  }
}

/** 법제처 searchLaw XML 응답의 첫 law 항목에서 lawId/mst 만 추출 */
function parseFirstLawFromXml(xml: string): { lawId: string; mst: string } | null {
  try {
    const doc = new DOMParser().parseFromString(xml, "text/xml")
    const laws = doc.getElementsByTagName("law")
    if (laws.length === 0) return null
    const first = laws[0]
    const lawId = first.getElementsByTagName("법령ID")[0]?.textContent || ""
    const mst = first.getElementsByTagName("법령일련번호")[0]?.textContent || ""
    if (!lawId && !mst) return null
    return { lawId, mst }
  } catch {
    return null
  }
}
