/**
 * chain_alio_benchmark — 한 기관 벤치마킹 종합 흐름
 *
 * 흐름:
 *   1. 기관 프로파일 (분류 분포, 최근 활동)
 *   2. 토픽 매칭 규정 목록 (있으면)
 *   3. 동종 기관 갭 분석 (suggest 결과)
 *
 * 한 번 호출로 "이 기관 우리랑 비교해서 어떤가" 시작점 제공.
 */

import { z } from "zod"
import type { LawApiClient } from "../../lib/api-client.js"
import { findInstitution, getCollectedInstitutions, loadIndex } from "../../lib/alio/index-loader.js"
import { titleSimilarity } from "../../lib/alio/compare.js"
import { truncateResponse } from "../../lib/schemas.js"
import { formatToolError } from "../../lib/errors.js"
import type { ToolResponse } from "../../lib/types.js"

export const ChainAlioBenchmarkSchema = z.object({
  institution: z.string().describe("기준 기관 (apbaId 또는 이름) — '우리 기관'"),
  topic: z.string().optional().describe("관심 토픽 키워드 (예: '인사', '징계'). 생략 시 분류 분포 기준"),
  max: z.number().min(1).max(20).default(8).describe("각 섹션 최대 표시 (기본:8)"),
  similarityThreshold: z.number().min(0).max(1).default(0.4).describe("동종 규정 매칭 유사도 하한"),
})

export type ChainAlioBenchmarkInput = z.infer<typeof ChainAlioBenchmarkSchema>

export async function chainAlioBenchmark(
  _api: LawApiClient,
  input: ChainAlioBenchmarkInput
): Promise<ToolResponse> {
  try {
    const idx = await loadIndex()
    const baseInst = findInstitution(idx, input.institution)
    if (!baseInst) {
      return {
        content: [{ type: "text", text: `기관을 찾을 수 없습니다: ${input.institution}` }],
        isError: true,
      }
    }
    const baseManifest = idx.manifests.get(baseInst.apbaId)
    if (!baseManifest) {
      return {
        content: [{ type: "text", text: `${baseInst.apbaNa} — manifest 없음` }],
        isError: true,
      }
    }

    const baseRegs = baseManifest.regulations
    const topic = input.topic?.trim().toLowerCase()

    // [섹션 1] 프로파일
    const catCount = new Map<string, number>()
    for (const r of baseRegs) {
      const c = r.category || "(미분류)"
      catCount.set(c, (catCount.get(c) || 0) + 1)
    }
    const topCats = [...catCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, input.max)

    const profile: string[] = []
    profile.push(`## 1. 기관 프로파일 — [${baseInst.apbaId}] ${baseInst.apbaNa}`)
    profile.push(`- 유형: ${baseInst.typeNa || "(미상)"} | 주무부처: ${baseInst.jidtNa || "(미상)"}`)
    profile.push(`- 보유 규정: ${baseRegs.length}건`)
    profile.push("- 분류 분포 top:")
    topCats.forEach(([c, n]) => profile.push(`  - ${c}: ${n}건`))

    // [섹션 2] 토픽 매칭 규정 (있으면)
    const topicSection: string[] = []
    if (topic) {
      const matched = baseRegs.filter((r) => r.title.toLowerCase().includes(topic))
      topicSection.push(`## 2. 토픽 "${input.topic}" 매칭 규정 (${matched.length}건)`)
      const sliced = matched.slice(0, input.max)
      if (sliced.length === 0) {
        topicSection.push("- 우리 기관에는 해당 토픽 규정이 없음 — 동종 기관 벤치마킹 권장")
      } else {
        for (const r of sliced) {
          topicSection.push(`- ${r.title} (regId=${r.regId}${r.category ? `, ${r.category}` : ""})`)
        }
      }
    } else {
      topicSection.push(`## 2. 토픽 미지정 — 토픽 매칭 섹션 생략 (입력의 topic 인자로 활성화)`)
    }

    // [섹션 3] 동종 기관 갭 분석 — 우리에게 없는 규정
    const gapSection: string[] = []
    gapSection.push(`## 3. 동종 기관에는 있으나 우리에게 없는 규정 후보 (top ${input.max})`)
    const peers = getCollectedInstitutions(idx).filter((p) => p.apbaId !== baseInst.apbaId)
    const baseTitles = baseRegs.map((r) => r.title)

    interface Gap {
      title: string
      score: number // 우리 기관 어떤 규정과도 유사도 ↓
      examples: Array<{ apbaId: string; apbaNa: string; regId: string }>
    }
    const gaps = new Map<string, Gap>()
    for (const peer of peers) {
      const peerManifest = idx.manifests.get(peer.apbaId)
      if (!peerManifest) continue
      // 토픽 필터
      const peerRegs = topic
        ? peerManifest.regulations.filter((r) => r.title.toLowerCase().includes(topic))
        : peerManifest.regulations
      for (const peerReg of peerRegs) {
        // 우리 기관 가장 유사한 규정과의 유사도
        const maxSim = baseTitles.length
          ? Math.max(...baseTitles.map((t) => titleSimilarity(peerReg.title, t)))
          : 0
        if (maxSim >= input.similarityThreshold) continue // 유사한 게 있음 → 갭 아님
        const key = peerReg.title
        const existing = gaps.get(key)
        if (existing) {
          if (existing.examples.length < 3) {
            existing.examples.push({ apbaId: peer.apbaId, apbaNa: peer.apbaNa, regId: peerReg.regId })
          }
        } else {
          gaps.set(key, {
            title: peerReg.title,
            score: 1 - maxSim,
            examples: [{ apbaId: peer.apbaId, apbaNa: peer.apbaNa, regId: peerReg.regId }],
          })
        }
      }
    }
    const topGaps = [...gaps.values()]
      .sort((a, b) => b.examples.length - a.examples.length)
      .slice(0, input.max)
    if (topGaps.length === 0) {
      gapSection.push("- 갭 후보 없음 (또는 유사도 threshold 가 너무 낮음)")
    } else {
      for (const g of topGaps) {
        const ex = g.examples
          .map((e) => `[${e.apbaId}] ${e.apbaNa}`)
          .join(", ")
        gapSection.push(`- ${g.title} — 보유 기관 예시: ${ex} (외 ${Math.max(0, g.examples.length - 3)}개)`)
      }
    }

    const header = `# 벤치마크 종합 — [${baseInst.apbaId}] ${baseInst.apbaNa}`
    const merged =
      header +
      "\n\n" +
      [profile.join("\n"), topicSection.join("\n"), gapSection.join("\n")].join("\n\n")
    return { content: [{ type: "text", text: truncateResponse(merged) }] }
  } catch (err) {
    return formatToolError(err, "chain_alio_benchmark")
  }
}
