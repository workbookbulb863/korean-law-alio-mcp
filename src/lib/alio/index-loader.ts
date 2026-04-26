/**
 * 런타임 인덱서
 *
 * MCP 런타임이 디스크의 institutions.json 과 모든 기관의 manifest.json 을 읽어
 * 메모리에 기관 목록/규정 메타 인덱스를 구축한다. 파일 I/O는 최초 1회만, 이후 TTL 만료시 재로딩.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { alioDataDir, manifestPath, regulationMdPath } from "./paths.js"
import { readJsonIfExists } from "./manifest.js"
import type { Institution, InstitutionsIndex, Manifest, ManifestEntry } from "./types.js"

interface IndexCache {
  loadedAt: number
  institutions: Institution[]
  /** apbaId → Manifest */
  manifests: Map<string, Manifest>
  /** 검색 편의를 위한 평탄화: "apbaId::regId" → { inst, entry } */
  flatRegulations: Array<{ inst: Institution; entry: ManifestEntry }>
}

let cache: IndexCache | null = null
const TTL_MS = 10 * 60 * 1000 // 10분

export async function loadIndex(force = false): Promise<IndexCache> {
  const now = Date.now()
  if (!force && cache && now - cache.loadedAt < TTL_MS) return cache

  const idxFile = await readJsonIfExists<InstitutionsIndex>(
    path.join(alioDataDir(), "institutions.json")
  )
  const institutions = idxFile?.institutions ?? []

  const manifests = new Map<string, Manifest>()
  const flat: IndexCache["flatRegulations"] = []

  // 디스크 존재 기관만 로드 (institutions.json 이 비어있어도 디렉터리 스캔으로 복구)
  const scannedIds = new Set<string>()
  for (const inst of institutions) scannedIds.add(inst.apbaId)
  try {
    const entries = await fs.readdir(alioDataDir(), { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory() && /^[A-Z]\d{4}$/.test(e.name)) scannedIds.add(e.name)
    }
  } catch {
    /* data dir 없음 — OK, 빈 인덱스 반환 */
  }

  for (const apbaId of scannedIds) {
    const mf = await readJsonIfExists<Manifest>(manifestPath(apbaId))
    if (!mf) continue
    manifests.set(apbaId, mf)
    const inst =
      institutions.find((i) => i.apbaId === apbaId) ??
      ({
        apbaId,
        apbaNa: mf.institutionName,
        typeNa: mf.typeNa ?? "",
        jidtNa: mf.jidtNa ?? "",
        apbaType: "",
      } as Institution)
    for (const entry of mf.regulations) flat.push({ inst, entry })
  }

  cache = {
    loadedAt: now,
    institutions,
    manifests,
    flatRegulations: flat,
  }
  return cache
}

/** 한 규정의 본문 markdown 을 디스크에서 읽는다 */
export async function readRegulationMd(apbaId: string, regId: string): Promise<string | null> {
  try {
    return await fs.readFile(regulationMdPath(apbaId, regId), "utf8")
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === "ENOENT") return null
    throw err
  }
}

/** 정규화된 부분일치(공백/대소문자 무시) */
export function normalize(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, "")
}

export function findInstitution(
  cacheRef: IndexCache,
  queryOrId: string
): Institution | undefined {
  const q = normalize(queryOrId)
  // 1. apbaId 완전일치
  const byId = cacheRef.institutions.find((i) => i.apbaId.toLowerCase() === queryOrId.toLowerCase())
  if (byId) return byId
  // 2. manifest 로만 있는 기관 (institutions.json 미업데이트 대비)
  for (const m of cacheRef.manifests.values()) {
    if (m.apbaId.toLowerCase() === queryOrId.toLowerCase()) {
      return {
        apbaId: m.apbaId,
        apbaNa: m.institutionName,
        typeNa: m.typeNa ?? "",
        jidtNa: m.jidtNa ?? "",
        apbaType: "",
      }
    }
  }
  // 3. 기관명 정규화 일치 / 부분일치
  const byName =
    cacheRef.institutions.find((i) => normalize(i.apbaNa) === q) ||
    cacheRef.institutions.find((i) => normalize(i.apbaNa).includes(q))
  return byName
}

/** 캐시 무효화 (sync 직후 호출 가능) */
export function invalidateIndex(): void {
  cache = null
}

/**
 * 디스크에 manifest 가 있는(=수집 완료된) 모든 기관.
 * 비교 도구가 사용자/환경변수로 대상 기관을 받지 못했을 때의 자동 fallback 용.
 */
export function getCollectedInstitutions(cacheRef: IndexCache): Institution[] {
  const seen = new Set<string>()
  const out: Institution[] = []
  for (const { inst } of cacheRef.flatRegulations) {
    if (seen.has(inst.apbaId)) continue
    seen.add(inst.apbaId)
    out.push(inst)
  }
  return out
}
