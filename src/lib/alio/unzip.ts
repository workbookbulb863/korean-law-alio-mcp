/**
 * ALIO가 연혁 모음을 .zip 으로 래핑해 내려주는 경우 처리.
 * 내부 구조 예:
 *   업무규정(YYYY년도 M월 개정)/
 *     업무규정(YYYY년도 M월 개정).hwpx          ← 현행
 *     업무규정(YYYY-1년도 ...).hwpx              ← 과거본
 *     ...
 *
 * 또는 ZIP 안에 다시 ZIP 이 들어있는 경우(ex. 서울대병원 행정관리지침):
 *   2024년도 1월-2026년도 3월.zip
 *     ├ 지침(2025년도 3월 개정).zip      ← 내부 zip
 *     │   └ 지침(2025년도 3월 개정).hwpx  ← 실제 본문
 *     ├ 지침(2025년도 5월 개정).zip
 *     └ ...
 * 이 경우 재귀 언랩으로 가장 최근 내부 zip 을 들어가 문서 파일을 찾는다.
 *
 * 전략:
 *   1. 파일명이 .zip 으로 끝나거나 magic byte 가 zip 이면서 HWPX signature 가 아닌 경우 래퍼로 판정
 *   2. 내부 .hwp/.hwpx/.pdf 파일 중 외부 파일명 stem 과 일치하는 것을 우선 선택
 *   3. 없으면 lexicographic 최대(연월 기준)
 *   4. 내부에 문서 파일이 없고 .zip 만 있으면 가장 최신 .zip 을 재귀 언랩 (최대 MAX_DEPTH)
 */

import JSZip from "jszip"

export interface UnwrapResult {
  bytes: Buffer
  filename: string
}

/** 묶음 공시용 — 한 regulation 엔트리가 여러 하위 문서의 집합인 경우 */
export interface UnwrapBundleResult {
  /** 선택된 스냅샷(가장 최근 내부 ZIP) 이름 */
  snapshotName: string
  /** 스냅샷 내부의 모든 문서 파일 (hwpx/hwp/pdf) */
  files: UnwrapResult[]
}

const DOC_EXTS = [".hwpx", ".hwp", ".pdf"]
/** ZIP 재귀 언랩 최대 깊이 (무한 루프 방지) */
const MAX_DEPTH = 4

/** 파일명이 .zip 으로 끝나면 래퍼로 간주 */
export function looksLikeWrapperZip(filename: string): boolean {
  return filename.toLowerCase().trim().endsWith(".zip")
}

/**
 * .zip 래퍼에서 현행본 내부 파일을 추출. 중첩 ZIP 의 경우 재귀로 파고든다.
 * 반환 null = 재귀 끝까지 문서 파일을 못 찾음 (원본을 그대로 쓸 것)
 */
export async function unwrapZip(
  bytes: Buffer,
  outerFilename: string,
  depth = 0
): Promise<UnwrapResult | null> {
  if (depth > MAX_DEPTH) return null

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return null
  }

  const docFiles: Array<{ path: string; base: string; ext: string }> = []
  const innerZips: Array<{ path: string; base: string }> = []
  zip.forEach((relativePath, file) => {
    if (file.dir) return
    const base = relativePath.split("/").pop() || relativePath
    const lower = base.toLowerCase()
    const ext = DOC_EXTS.find((e) => lower.endsWith(e))
    if (ext) docFiles.push({ path: relativePath, base, ext })
    else if (lower.endsWith(".zip")) innerZips.push({ path: relativePath, base })
  })

  // 케이스 1: 문서 파일 존재 → 기존 로직
  if (docFiles.length > 0) {
    const outerStem = stem(outerFilename)
    const exactStem = docFiles.find((f) => stem(f.base) === outerStem)
    if (exactStem) return await readEntry(zip, exactStem.path, exactStem.base)

    const includeMatch = docFiles.find(
      (f) => stem(f.base).includes(outerStem) || outerStem.includes(stem(f.base))
    )
    if (includeMatch) return await readEntry(zip, includeMatch.path, includeMatch.base)

    const sorted = [...docFiles].sort((a, b) => a.base.localeCompare(b.base, "ko"))
    const latest = sorted[sorted.length - 1]
    return await readEntry(zip, latest.path, latest.base)
  }

  // 케이스 2: 문서 파일 없고 내부 .zip 만 있음 → 가장 최신 내부 zip 을 재귀 언랩
  if (innerZips.length > 0) {
    // 파일명에서 날짜 추출해 가장 최근 것을 고름 (연월이 문자열 정렬과 일치하는 관행)
    const sortedZips = [...innerZips].sort((a, b) => a.base.localeCompare(b.base, "ko"))
    const latest = sortedZips[sortedZips.length - 1]
    const innerEntry = zip.file(latest.path)
    if (!innerEntry) return null
    const innerBytes = await innerEntry.async("uint8array")
    const innerBuf = Buffer.from(
      innerBytes.buffer.slice(
        innerBytes.byteOffset,
        innerBytes.byteOffset + innerBytes.byteLength
      ) as ArrayBuffer
    )
    return unwrapZip(innerBuf, latest.base, depth + 1)
  }

  // 문서도 ZIP 도 없음
  return null
}

async function readEntry(
  zip: JSZip,
  path: string,
  filename: string
): Promise<UnwrapResult | null> {
  const entry = zip.file(path)
  if (!entry) return null
  const arr = await entry.async("uint8array")
  // Buffer<ArrayBuffer> 형태를 강제 — kordoc 에 넘길 때 ArrayBuffer 복사가 필요하므로
  const bytes = Buffer.from(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer)
  return { bytes, filename }
}

function stem(filename: string): string {
  const base = filename.split("/").pop() || filename
  const dotIdx = base.lastIndexOf(".")
  return dotIdx > 0 ? base.slice(0, dotIdx) : base
}

// ─── 묶음 공시 대응 (예: 서울대병원 행정관리지침) ───────────────────────

/**
 * "묶음 ZIP"에서 가장 최신 스냅샷의 모든 문서 파일을 배열로 반환.
 *
 * 두 가지 케이스 지원:
 *   A) 외부 ZIP 안에 스냅샷 ZIP 들이 여러 개 있는 경우 (중첩 묶음)
 *      → 이름에서 날짜를 파싱해 가장 최근 내부 ZIP 선택
 *      → 그 안의 문서 파일들을 모두 반환
 *   B) 외부 ZIP 안에 문서 파일이 직접 2개 이상 있는 경우 (단일 스냅샷 묶음)
 *      → 전부 반환
 *
 * 단일 문서인 경우(대부분의 일반 래퍼 ZIP)는 null 반환 → 호출측이 unwrapZip 을 쓰도록 유도.
 */
export async function unwrapZipBundle(
  bytes: Buffer,
  outerFilename: string
): Promise<UnwrapBundleResult | null> {
  let outerZip: JSZip
  try {
    outerZip = await JSZip.loadAsync(bytes)
  } catch {
    return null
  }

  const docs: Array<{ path: string; base: string }> = []
  const innerZips: Array<{ path: string; base: string }> = []
  outerZip.forEach((p, f) => {
    if (f.dir) return
    const base = p.split("/").pop() || p
    const lower = base.toLowerCase()
    if (DOC_EXTS.some((e) => lower.endsWith(e))) docs.push({ path: p, base })
    else if (lower.endsWith(".zip")) innerZips.push({ path: p, base })
  })

  // 케이스 B: 외부 ZIP 안에 문서 파일이 다수 있으면 그걸로 bundle 구성
  if (docs.length >= 2 && innerZips.length === 0) {
    const files: UnwrapResult[] = []
    for (const d of docs) {
      const r = await readEntry(outerZip, d.path, d.base)
      if (r) files.push(r)
    }
    return files.length >= 2 ? { snapshotName: outerFilename, files } : null
  }

  // 케이스 A: 외부 ZIP 안에 여러 스냅샷 ZIP 존재 → 가장 최근 스냅샷 선택
  if (innerZips.length >= 2) {
    const sorted = [...innerZips].sort((a, b) => {
      const da = extractDate(a.base)
      const db = extractDate(b.base)
      if (da && db) return da.localeCompare(db) // YYYY-MM-DD 문자열 비교
      if (da && !db) return 1 // 날짜 있는 게 뒤로
      if (!da && db) return -1
      return a.base.localeCompare(b.base, "ko")
    })
    const latest = sorted[sorted.length - 1]
    const innerEntry = outerZip.file(latest.path)
    if (!innerEntry) return null
    const innerBytes = await innerEntry.async("uint8array")
    const innerBuf = Buffer.from(
      innerBytes.buffer.slice(
        innerBytes.byteOffset,
        innerBytes.byteOffset + innerBytes.byteLength
      ) as ArrayBuffer
    )
    let innerZip: JSZip
    try {
      innerZip = await JSZip.loadAsync(innerBuf)
    } catch {
      return null
    }

    const innerDocs: Array<{ path: string; base: string }> = []
    innerZip.forEach((p, f) => {
      if (f.dir) return
      const base = p.split("/").pop() || p
      if (DOC_EXTS.some((e) => base.toLowerCase().endsWith(e))) {
        innerDocs.push({ path: p, base })
      }
    })

    if (innerDocs.length < 2) return null
    const files: UnwrapResult[] = []
    for (const d of innerDocs) {
      const r = await readEntry(innerZip, d.path, d.base)
      if (r) files.push(r)
    }
    return files.length >= 2 ? { snapshotName: latest.base, files } : null
  }

  return null
}

/** "YYYY년도 M월 D일" 또는 "YYYY년M월" 등에서 정렬 가능한 YYYY-MM-DD 추출 */
function extractDate(filename: string): string | null {
  // "2026년도 03월 30일" / "2026년도 3월"
  const m = filename.match(/(\d{4})\s*년도?\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/)
  if (!m) return null
  const y = m[1]
  const mo = String(m[2]).padStart(2, "0")
  const d = String(m[3] || "01").padStart(2, "0")
  return `${y}-${mo}-${d}`
}
