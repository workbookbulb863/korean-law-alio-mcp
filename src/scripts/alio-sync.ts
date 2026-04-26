#!/usr/bin/env node
/**
 * ALIO 공공기관 내부규정 일괄 수집 스크립트
 *
 *   npm run alio:sync                 # 전체 기관
 *   npm run alio:sync -- --only C0xxx # 단일 기관 (apbaId 지정)
 *   npm run alio:sync -- --institutions C0xxx,C0yyy,C0zzz
 *   npm run alio:sync -- --resume     # 실패 기관만 재시도
 *   npm run alio:sync -- --concurrency 3
 *   npm run alio:sync -- --limit 20   # 기관당 처음 N개 규정만 (smoke test)
 *   npm run alio:sync -- --dry-run    # 다운로드 없이 목록만
 *
 * 출력은 모두 stderr (MCP STDIO 와 간섭 방지 — 이 스크립트는 독립 실행이지만 관행 유지).
 */

import fs from "node:fs/promises"
import path from "node:path"
import {
  listInstitutions,
  listAllRegulations,
  getRegulationDetail,
  downloadRegulationFile,
  RULE_REPORT_FORM_ROOT,
} from "../lib/alio/client.js"
import {
  readManifest,
  writeManifest,
  readInstitutionsIndex,
  writeInstitutionsIndex,
  readSyncState,
  writeSyncState,
  hashBuffer,
} from "../lib/alio/manifest.js"
import { institutionDir, regulationMdPath } from "../lib/alio/paths.js"
import type {
  Institution,
  Manifest,
  ManifestEntry,
  RegulationListItem,
  SyncState,
} from "../lib/alio/types.js"
import { parseAnnexFile } from "../lib/annex-file-parser.js"
import { looksLikeWrapperZip, unwrapZip, unwrapZipBundle } from "../lib/alio/unzip.js"
import { isDoclingAvailable, parsePdfWithDocling } from "../lib/alio/docling-fallback.js"
import { isXlsLike, parseXlsFile } from "../lib/alio/xls-fallback.js"
import { isHwp3, parseHwp3 } from "../lib/alio/hwp3-fallback.js"

interface Args {
  only?: string[]
  resume: boolean
  retryFailed: boolean
  retryFallback: boolean
  doclingFallback: boolean
  concurrency: number
  limit?: number
  dryRun: boolean
  keepRaw: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    resume: false,
    retryFailed: false,
    retryFallback: false,
    // 기본값 ON: 스캔 PDF/엑셀/HWP3 같은 특수 케이스를 docling+tesseract 로 자동 fallback.
    // 외부 도구(docling) 가용성은 syncInstitutions() 시작 시 자동 감지해 미설치면 자동 비활성.
    doclingFallback: true,
    concurrency: 3,
    dryRun: false,
    keepRaw: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i]
    const next = argv[i + 1]
    if (v === "--only" || v === "--institutions") {
      a.only = (next || "").split(",").map((s) => s.trim()).filter(Boolean)
      i++
    } else if (v === "--resume") {
      a.resume = true
    } else if (v === "--retry-failed") {
      a.retryFailed = true
    } else if (v === "--retry-fallback") {
      a.retryFallback = true
    } else if (v === "--docling-fallback") {
      // 호환성 유지 — 이제 기본값이 true. 명시 무해.
      a.doclingFallback = true
    } else if (v === "--no-docling-fallback") {
      // 외부 도구(docling) 사용 회피하고 kordoc 만 시도 (시간 빠르게, 특수 케이스는 parseError 로 기록)
      a.doclingFallback = false
    } else if (v === "--concurrency") {
      a.concurrency = Math.max(1, Math.min(8, Number(next) || 3))
      i++
    } else if (v === "--limit") {
      a.limit = Math.max(1, Number(next) || 10)
      i++
    } else if (v === "--dry-run") {
      a.dryRun = true
    } else if (v === "--keep-raw") {
      a.keepRaw = true
    } else if (v === "--help" || v === "-h") {
      process.stderr.write(
        "Usage: npm run alio:sync -- [--only C0xxx] [--resume] [--retry-failed] [--retry-fallback] [--no-docling-fallback] [--concurrency 3] [--limit 10] [--dry-run] [--keep-raw]\n" +
        "       (docling fallback 은 기본 ON. docling 미설치 시 자동 비활성 + 안내. --no-docling-fallback 으로 명시 비활성 가능.)\n"
      )
      process.exit(0)
    }
  }
  return a
}

function log(msg: string): void {
  process.stderr.write(msg + "\n")
}

// ────────────────────────────────────────
// Per-regulation timeout + retry
// ────────────────────────────────────────
// 한 규정 처리에서 외부 라이브러리/도구가 hang(무한 대기) 되면 워커 슬롯이 영구
// 점유되어 sync 가 끝나지 않는 문제 방지. timeout 시 재시도 후 그래도 실패하면
// 에러를 throw 하여 호출자가 fetchErrors 로 기록하고 다음 규정으로 진행.
//
// 환경변수:
//   ALIO_REG_TIMEOUT_MS  한 시도의 최대 시간 (default 300000 = 5분)
//   ALIO_REG_RETRIES     timeout/throw 시 재시도 횟수 (default 1, 즉 총 2번 시도)
const REG_TIMEOUT_MS = parseInt(process.env.ALIO_REG_TIMEOUT_MS || "300000", 10)
const REG_RETRIES = parseInt(process.env.ALIO_REG_RETRIES || "1", 10)

async function withTimeoutAndRetry<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  const errors: string[] = []
  for (let attempt = 0; attempt <= REG_RETRIES; attempt++) {
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error(`timeout after ${REG_TIMEOUT_MS}ms`)),
            REG_TIMEOUT_MS
          )
        }),
      ])
      if (timer) clearTimeout(timer)
      return result
    } catch (e) {
      if (timer) clearTimeout(timer)
      const msg = (e as Error).message
      errors.push(`attempt ${attempt + 1}: ${msg}`)
      if (attempt < REG_RETRIES) {
        log(`    ⚠️ ${label} — ${msg}. 재시도 ${attempt + 1}/${REG_RETRIES}`)
        // backoff with jitter (2~3초)
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000))
      }
    }
  }
  throw new Error(
    `failed after ${REG_RETRIES + 1} attempts — ${errors.join("; ")}`
  )
}

async function syncInstitutions(args: Args): Promise<Institution[]> {
  // docling 가용성 자동 감지 — 미설치 시 fallback 자동 비활성 + 안내 (스캔 PDF/엑셀/HWP3 등 특수 케이스 영향)
  if (args.doclingFallback) {
    const available = await isDoclingAvailable()
    if (!available) {
      log("  ! docling 미설치 — 스캔 이미지 PDF, Excel 별표, HWP 3.0 등 특수 케이스는 parseError 로 기록됩니다.")
      log("    설치(macOS): brew install docling tesseract tesseract-lang")
      log("    설치 후 재실행: npm run alio:sync -- --retry-failed")
      args.doclingFallback = false
    } else {
      log("  ✓ docling 사용 가능 — 스캔 PDF/엑셀/HWP3 자동 fallback 활성")
    }
  }
  log("▶ ALIO 기관 목록 조회 중...")
  const institutions = await listInstitutions()
  await writeInstitutionsIndex({
    fetchedAt: new Date().toISOString(),
    institutions,
  })
  log(`  ✓ ${institutions.length}개 기관 수집 완료`)
  return institutions
}

async function pickTargets(args: Args, all: Institution[]): Promise<Institution[]> {
  if (args.only && args.only.length > 0) {
    const set = new Set(args.only)
    const picked = all.filter((i) => set.has(i.apbaId))
    const missing = args.only.filter((id) => !all.some((i) => i.apbaId === id))
    if (missing.length > 0) log(`  ! 경고: 기관코드 미존재: ${missing.join(", ")}`)
    return picked
  }
  if (args.resume) {
    const state = await readSyncState()
    return all.filter((i) => {
      const s = state.perInstitution[i.apbaId]
      return !s || s.status === "error"
    })
  }
  return all
}

interface InstitutionStats {
  apbaId: string
  totalRegulations: number
  fetched: number
  parseOk: number
  parseFail: number
  fetchErrors: number
  /** "에러유형 요약": 첫 50자 기준 키 */
  errorCategories: Record<string, number>
}

async function syncInstitution(
  inst: Institution,
  args: Args
): Promise<InstitutionStats> {
  const log2 = (m: string) => log(`  [${inst.apbaId} ${inst.apbaNa}] ${m}`)
  log2("규정 목록 조회...")
  const allRegs = await listAllRegulations(inst.apbaId, inst.apbaType || "A2005")
  log2(`총 ${allRegs.length}건 중 처리 대상 ${args.limit ? Math.min(args.limit, allRegs.length) : allRegs.length}건`)

  const targets = args.limit ? allRegs.slice(0, args.limit) : allRegs

  const existing = await readManifest(inst.apbaId)
  const existingByRegId = new Map<string, ManifestEntry>()
  if (existing) for (const r of existing.regulations) existingByRegId.set(r.regId, r)

  const stats: InstitutionStats = {
    apbaId: inst.apbaId,
    totalRegulations: allRegs.length,
    fetched: 0,
    parseOk: 0,
    parseFail: 0,
    fetchErrors: 0,
    errorCategories: {},
  }
  const bumpCat = (key: string) => {
    const k = key.slice(0, 60)
    stats.errorCategories[k] = (stats.errorCategories[k] || 0) + 1
  }

  const nextEntries: ManifestEntry[] = []
  let processed = 0

  for (const item of targets) {
    processed++
    // 20건마다 + 마지막 한 건에서 로그 (사용자가 N/N 도달을 시각적으로 확인할 수 있도록)
    if (processed % 20 === 0 || processed === targets.length) {
      log2(`진행 ${processed}/${targets.length}`)
    }
    try {
      const entry = await withTimeoutAndRetry(
        () => processRegulation(inst, item, existingByRegId.get(item.idx), args),
        `${item.idx} "${item.title}"`
      )
      if (entry) {
        nextEntries.push(entry)
        stats.fetched++
        if (!entry.mdPath || entry.fileType === "unknown") {
          // 첨부 없음 — 집계 대상 아님
        } else if (entry.parseError) {
          stats.parseFail++
          bumpCat(entry.parseError)
        } else {
          stats.parseOk++
        }
      }
    } catch (err) {
      const msg = (err as Error).message
      log2(`! ${item.idx} "${item.title}" 실패: ${msg}`)
      stats.fetchErrors++
      bumpCat(msg)
      const prev = existingByRegId.get(item.idx)
      if (prev) nextEntries.push(prev)
    }
  }

  const manifest: Manifest = {
    apbaId: inst.apbaId,
    institutionName: inst.apbaNa,
    typeNa: inst.typeNa,
    jidtNa: inst.jidtNa,
    reportFormRootNo: RULE_REPORT_FORM_ROOT,
    fetchedAt: new Date().toISOString(),
    regulations: nextEntries,
  }
  if (!args.dryRun) await writeManifest(manifest)
  log2(
    `✓ 완료 — manifest ${nextEntries.length}건 (파싱 성공 ${stats.parseOk}, 실패 ${stats.parseFail}, 수집오류 ${stats.fetchErrors})`
  )
  return stats
}

async function processRegulation(
  inst: Institution,
  item: RegulationListItem,
  prev: ManifestEntry | undefined,
  args: Args
): Promise<ManifestEntry | null> {
  const detail = await getRegulationDetail(item)
  if (detail.files.length === 0) {
    // 첨부 없음 → manifest 에 메타만 기록
    return {
      regId: item.idx,
      title: item.title,
      category: item.bidType || "",
      issuedAt: item.stDate || "",
      revisedAt: item.idate || "",
      sourceDetailUrl: buildDetailUrl(item),
      primaryFileNo: "",
      primaryFileName: "",
      fileType: "unknown",
      fileHash: "",
      mdPath: "",
      bytes: 0,
      revisions: [],
    }
  }

  // 개정본 리스트의 마지막이 최신본(HTML 순서가 오래된 → 최신)
  const primary = detail.files[detail.files.length - 1]
  const allFileNos = detail.files.map((f) => f.fileNo)

  // incremental: primary 동일하고 revisions 에 새 것 없으면 그대로 재사용
  // 단, --retry-failed 는 parseError 있는 entry 를 재시도
  //     --retry-fallback 은 fallbackParser 로 만든 entry 를 재시도 (OCR 엔진 교체 후 사용)
  if (prev && prev.primaryFileNo === primary.fileNo) {
    const existingSet = new Set(prev.revisions.map((r) => r.fileNo))
    const hasNew = allFileNos.some((fn) => !existingSet.has(fn) && fn !== prev.primaryFileNo)
    const needsParseRetry = args.retryFailed && !!prev.parseError
    const needsFallbackRetry = args.retryFallback && !!prev.fallbackParser
    if (!hasNew && !needsParseRetry && !needsFallbackRetry) return prev
  }

  if (args.dryRun) {
    return {
      regId: item.idx,
      title: item.title,
      category: item.bidType || "",
      issuedAt: item.stDate || "",
      revisedAt: item.idate || "",
      sourceDetailUrl: buildDetailUrl(item),
      primaryFileNo: primary.fileNo,
      primaryFileName: primary.filename,
      fileType: detectFileType(primary.filename),
      fileHash: "",
      mdPath: `regulations/${item.idx}.md`,
      bytes: 0,
      revisions: detail.files.slice(0, -1),
    }
  }

  const dl = await downloadRegulationFile(primary.fileNo)

  // kordoc 파서가 내부적으로 ArrayBuffer를 detach 할 수 있음(pdfjs-dist 등).
  // 파싱 전에 바이트/해시를 스냅샷하고, 파서에는 독립된 ArrayBuffer 복사본을 전달한다.
  const originalBytes = Buffer.from(new Uint8Array(dl.buffer))
  const fileHash = hashBuffer(originalBytes)
  const byteLength = originalBytes.length

  // ── 묶음 공시 케이스(서울대병원 행정관리지침처럼 1 regulation 안에 수십 개 하위 지침) ──
  // 외부 ZIP 이 여러 내부 스냅샷 ZIP 을 품거나, 직접 여러 문서 파일을 품으면 bundle 처리.
  if (looksLikeWrapperZip(primary.filename)) {
    const bundle = await unwrapZipBundle(originalBytes, primary.filename)
    if (bundle && bundle.files.length >= 2) {
      return await processBundle(inst, item, detail, primary, originalBytes, fileHash, byteLength, bundle, args)
    }
  }

  // ── 엑셀 파일 (.xls / .xlsx) ──
  // OLE2 시그니처가 HWP5 와 동일해 kordoc 이 오인식 → soffice + docling 우회 파이프라인.
  if (isXlsLike(primary.filename)) {
    return await processXls(inst, item, detail, primary, originalBytes, fileHash, byteLength, args)
  }

  // ALIO 가 .zip 으로 연혁 모음을 래핑한 경우 내부 현행본을 추출해 파싱.
  let parseBytes: Buffer = originalBytes
  let parseFilename = primary.filename
  let unwrappedFrom: string | undefined
  if (looksLikeWrapperZip(primary.filename)) {
    const unwrapped = await unwrapZip(originalBytes, primary.filename)
    if (unwrapped) {
      parseBytes = unwrapped.bytes
      parseFilename = unwrapped.filename
      unwrappedFrom = primary.filename
    }
  }

  const arrayBufferCopy = parseBytes.buffer.slice(
    parseBytes.byteOffset,
    parseBytes.byteOffset + parseBytes.byteLength
  ) as ArrayBuffer

  const parsed = await parseAnnexFile(arrayBufferCopy)

  // fallback: kordoc 실패 시 유형별로 시도
  let fallbackParser: "docling" | undefined
  let finalMarkdown: string | undefined = parsed.success ? parsed.markdown : undefined
  let finalError: string | undefined = parsed.success ? undefined : parsed.error || "unknown"
  const fileType = parsed.fileType

  // 1) 이미지 기반 PDF → docling + OCR
  if (
    args.doclingFallback &&
    !parsed.success &&
    parsed.fileType === "pdf" &&
    /이미지\s*기반/.test(parsed.error || "")
  ) {
    const dl = await parsePdfWithDocling(parseBytes, parseFilename)
    if (dl.success && dl.markdown) {
      finalMarkdown = dl.markdown
      finalError = undefined
      fallbackParser = "docling"
    } else {
      finalError = `kordoc: ${parsed.error}; docling: ${dl.error || "unknown"}`
    }
  }

  // 2) HWP 3.0 구포맷 → soffice(HWP→PDF) + docling(tesseract OCR)
  //    kordoc 은 "지원하지 않는 파일 형식" 에러를 내고, 파일 앞바이트가 HWP3 시그니처인 경우
  if (
    args.doclingFallback &&
    !parsed.success &&
    !finalMarkdown &&
    isHwp3(parseBytes)
  ) {
    const h = await parseHwp3(parseBytes, parseFilename)
    if (h.success && h.markdown) {
      finalMarkdown = h.markdown
      finalError = undefined
      fallbackParser = "docling"
    } else {
      finalError = `kordoc: ${parsed.error}; hwp3-fallback: ${h.error || "unknown"}`
    }
  }

  // MD 저장
  const mdRel = `regulations/${item.idx}.md`
  const mdAbs = regulationMdPath(inst.apbaId, item.idx)
  await fs.mkdir(path.dirname(mdAbs), { recursive: true })
  const header = renderMdHeader(inst, item, parseFilename, fileType, unwrappedFrom, fallbackParser)
  const body = finalMarkdown || `⚠️ 파싱 실패: ${finalError || "unknown"}`
  await fs.writeFile(mdAbs, header + "\n\n" + body, "utf8")

  if (args.keepRaw) {
    const ext = inferExt(primary.filename, parsed.fileType)
    const rawAbs = path.join(institutionDir(inst.apbaId), "regulations", `${item.idx}.raw${ext}`)
    await fs.writeFile(rawAbs, originalBytes)
  }

  return {
    regId: item.idx,
    title: item.title,
    category: item.bidType || "",
    issuedAt: item.stDate || "",
    revisedAt: item.idate || "",
    sourceDetailUrl: buildDetailUrl(item),
    primaryFileNo: primary.fileNo,
    primaryFileName: primary.filename,
    fileType,
    fileHash,
    mdPath: mdRel,
    bytes: byteLength,
    parseError: finalError,
    unwrappedFrom,
    fallbackParser,
    revisions: detail.files.slice(0, -1),
  }
}

/**
 * 묶음 공시 처리 — 하나의 regulation 에 수십 개 하위 PDF 가 포함된 경우.
 *
 * 생성되는 MD 구조:
 *   # {regulation title}  (메타)
 *   > ⚠️ 묶음 공시 안내 + 스냅샷 정보
 *   ## 📑 하위 문서 목차
 *   1. 파일명1
 *   2. 파일명2
 *   ...
 *   ## {파일명1}
 *   (변환된 본문)
 *   ---
 *   ## {파일명2}
 *   ...
 */
async function processBundle(
  inst: Institution,
  item: RegulationListItem,
  detail: { apbaId: string; idx: string; title: string; issuedAt?: string; revisedAt?: string; files: Array<{ fileNo: string; filename: string }> },
  primary: { fileNo: string; filename: string },
  originalBytes: Buffer,
  fileHash: string,
  byteLength: number,
  bundle: { snapshotName: string; files: Array<{ bytes: Buffer; filename: string }> },
  args: Args
): Promise<ManifestEntry> {
  const log3 = (m: string) => log(`    [bundle ${item.idx}] ${m}`)
  log3(`감지 — 스냅샷 "${bundle.snapshotName}" 안에 ${bundle.files.length}개 하위 문서`)

  const sections: string[] = []
  let okCount = 0
  let failCount = 0

  for (let i = 0; i < bundle.files.length; i++) {
    const sub = bundle.files[i]
    const subAb = sub.bytes.buffer.slice(sub.bytes.byteOffset, sub.bytes.byteOffset + sub.bytes.byteLength) as ArrayBuffer
    let subMd = ""
    try {
      const p = await parseAnnexFile(subAb)
      if (p.success && p.markdown) {
        subMd = p.markdown
        okCount++
      } else if (
        args.doclingFallback &&
        !p.success &&
        p.fileType === "pdf" &&
        /이미지\s*기반/.test(p.error || "")
      ) {
        const dl = await parsePdfWithDocling(sub.bytes, sub.filename)
        if (dl.success && dl.markdown) {
          subMd = dl.markdown
          okCount++
        } else {
          subMd = `⚠️ 파싱 실패 (kordoc: ${p.error}; docling: ${dl.error})`
          failCount++
        }
      } else {
        subMd = `⚠️ 파싱 실패 (${p.error || "unknown"})`
        failCount++
      }
    } catch (err) {
      subMd = `⚠️ 파싱 예외: ${(err as Error).message}`
      failCount++
    }
    sections.push(`\n---\n\n## ${i + 1}. ${sub.filename}\n\n${subMd}`)
    if ((i + 1) % 10 === 0) log3(`진행 ${i + 1}/${bundle.files.length}`)
  }
  log3(`완료 — 하위 파싱 성공 ${okCount}, 실패 ${failCount}`)

  // 목차
  const toc = bundle.files.map((f, i) => `${i + 1}. ${f.filename}`).join("\n")
  const header = renderBundleHeader(inst, item, primary.filename, bundle, okCount, failCount)
  const body = `## 📑 하위 문서 목차 (${bundle.files.length}건)\n\n${toc}\n${sections.join("\n")}`

  const mdRel = `regulations/${item.idx}.md`
  const mdAbs = regulationMdPath(inst.apbaId, item.idx)
  await fs.mkdir(path.dirname(mdAbs), { recursive: true })
  await fs.writeFile(mdAbs, header + "\n\n" + body, "utf8")

  if (args.keepRaw) {
    const rawAbs = path.join(institutionDir(inst.apbaId), "regulations", `${item.idx}.raw.zip`)
    await fs.writeFile(rawAbs, originalBytes)
  }

  return {
    regId: item.idx,
    title: item.title,
    category: item.bidType || "",
    issuedAt: item.stDate || "",
    revisedAt: item.idate || "",
    sourceDetailUrl: buildDetailUrl(item),
    primaryFileNo: primary.fileNo,
    primaryFileName: primary.filename,
    fileType: "unknown", // 묶음이라 단일 타입으로 지정 불가
    fileHash,
    mdPath: mdRel,
    bytes: byteLength,
    parseError: failCount > 0 && okCount === 0 ? `묶음 전체 파싱 실패 (${failCount}개)` : undefined,
    unwrappedFrom: `${primary.filename} → ${bundle.snapshotName} (묶음 ${bundle.files.length}건)`,
    fallbackParser: undefined,
    revisions: detail.files.slice(0, -1),
  }
}

function renderBundleHeader(
  inst: Institution,
  item: RegulationListItem,
  outerFilename: string,
  bundle: { snapshotName: string; files: Array<{ filename: string }> },
  okCount: number,
  failCount: number
): string {
  const lines: string[] = []
  lines.push(`# ${item.title}`)
  lines.push("")
  lines.push(`- 기관: ${inst.apbaNa} (${inst.apbaId})`)
  if (inst.jidtNa) lines.push(`- 주무부처: ${inst.jidtNa}`)
  if (inst.typeNa) lines.push(`- 기관유형: ${inst.typeNa}`)
  if (item.stDate) lines.push(`- 제·개정일: ${item.stDate}`)
  if (item.idate) lines.push(`- 최종 수정일: ${item.idate}`)
  lines.push(`- 원본: ${outerFilename} (묶음 ZIP)`)
  lines.push(`- 스냅샷: ${bundle.snapshotName}`)
  lines.push(`- 하위 문서: ${bundle.files.length}건 (파싱 성공 ${okCount}, 실패 ${failCount})`)
  lines.push("")
  lines.push(`> ⚠️ **묶음 공시 안내**: 이 규정 항목은 기관이 ALIO 에 하나의 ZIP 으로 올린 `)
  lines.push(`> 여러 하위 지침의 모음입니다. 아래 목차에서 개별 지침 섹션을 참조하세요.`)
  return lines.join("\n")
}

/**
 * .xls / .xlsx 처리 — soffice + docling 파이프라인 사용.
 * kordoc 이 OLE2 시그니처를 HWP 로 오인식하는 문제를 우회.
 */
async function processXls(
  inst: Institution,
  item: RegulationListItem,
  detail: { files: Array<{ fileNo: string; filename: string }> },
  primary: { fileNo: string; filename: string },
  originalBytes: Buffer,
  fileHash: string,
  byteLength: number,
  args: Args
): Promise<ManifestEntry> {
  const xls = await parseXlsFile(originalBytes, primary.filename)
  const mdRel = `regulations/${item.idx}.md`
  const mdAbs = regulationMdPath(inst.apbaId, item.idx)
  await fs.mkdir(path.dirname(mdAbs), { recursive: true })

  const lower = primary.filename.toLowerCase()
  const ext: "xls" | "xlsx" = lower.endsWith(".xlsx") ? "xlsx" : "xls"

  const lines: string[] = []
  lines.push(`# ${item.title}`)
  lines.push("")
  lines.push(`- 기관: ${inst.apbaNa} (${inst.apbaId})`)
  if (inst.jidtNa) lines.push(`- 주무부처: ${inst.jidtNa}`)
  if (inst.typeNa) lines.push(`- 기관유형: ${inst.typeNa}`)
  if (item.stDate) lines.push(`- 제·개정일: ${item.stDate}`)
  if (item.idate) lines.push(`- 최종 수정일: ${item.idate}`)
  lines.push(`- 원본: ${primary.filename} (${ext})`)
  lines.push(`- 파서: soffice → docling (엑셀 전용 우회 파이프라인)`)
  const header = lines.join("\n")

  const body = xls.success && xls.markdown
    ? xls.markdown
    : `⚠️ 파싱 실패: ${xls.error || "unknown"}`
  await fs.writeFile(mdAbs, header + "\n\n" + body, "utf8")

  if (args.keepRaw) {
    const rawAbs = path.join(institutionDir(inst.apbaId), "regulations", `${item.idx}.raw.${ext}`)
    await fs.writeFile(rawAbs, originalBytes)
  }

  return {
    regId: item.idx,
    title: item.title,
    category: item.bidType || "",
    issuedAt: item.stDate || "",
    revisedAt: item.idate || "",
    sourceDetailUrl: buildDetailUrl(item),
    primaryFileNo: primary.fileNo,
    primaryFileName: primary.filename,
    fileType: ext === "xlsx" ? "xlsx" : "unknown", // .xls 는 타입 셋에 없음 → unknown 유지
    fileHash,
    mdPath: mdRel,
    bytes: byteLength,
    parseError: xls.success ? undefined : xls.error || "unknown",
    unwrappedFrom: undefined,
    fallbackParser: "docling",
    revisions: detail.files.slice(0, -1),
  }
}

function buildDetailUrl(item: RegulationListItem): string {
  const q = new URLSearchParams({
    disclosureNo: "",
    apbaId: item.apbaId,
    nowcode: item.reportFormNo,
    reportFormNo: item.reportFormNo,
    table_name: item.tableName,
    idx_name: item.idxName,
    idx: item.idx,
    reportGbn: item.reportGbn,
    bid_type: item.bidType,
  })
  return `https://www.alio.go.kr/item/itemBoard21110.do?${q.toString()}`
}

function renderMdHeader(
  inst: Institution,
  item: RegulationListItem,
  filename: string,
  fileType: string,
  unwrappedFrom?: string,
  fallbackParser?: "docling"
): string {
  const lines: string[] = []
  lines.push(`# ${item.title}`)
  lines.push("")
  lines.push(`- 기관: ${inst.apbaNa} (${inst.apbaId})`)
  if (inst.jidtNa) lines.push(`- 주무부처: ${inst.jidtNa}`)
  if (inst.typeNa) lines.push(`- 기관유형: ${inst.typeNa}`)
  if (item.stDate) lines.push(`- 제·개정일: ${item.stDate}`)
  if (item.idate) lines.push(`- 최종 수정일: ${item.idate}`)
  lines.push(`- 원본: ${filename} (${fileType})`)
  if (unwrappedFrom) lines.push(`- 래퍼ZIP: ${unwrappedFrom} 에서 추출`)
  if (fallbackParser) lines.push(`- 파서: ${fallbackParser} (kordoc 이 이미지 기반 PDF 로 판정하여 OCR fallback)`)
  return lines.join("\n")
}

function detectFileType(
  filename: string
): "hwpx" | "hwp" | "hwpml" | "pdf" | "xlsx" | "docx" | "unknown" {
  const ext = filename.toLowerCase().split(".").pop() || ""
  if (ext === "hwpx" || ext === "hwp" || ext === "hwpml" || ext === "pdf" || ext === "xlsx" || ext === "docx") {
    return ext
  }
  return "unknown"
}

function inferExt(filename: string, fileType: string): string {
  const t = filename.toLowerCase().split(".").pop()
  if (t && t.length <= 5) return `.${t}`
  if (fileType === "hwpx") return ".hwpx"
  if (fileType === "hwp") return ".hwp"
  if (fileType === "pdf") return ".pdf"
  return ".bin"
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  // docling fallback 플래그가 켜져 있으면 CLI 가용성 사전 체크
  if (args.doclingFallback) {
    const ok = await isDoclingAvailable()
    if (!ok) {
      log("✗ --docling-fallback 지정되었지만 docling CLI 를 실행할 수 없습니다.")
      log("  → 'brew install docling' 또는 'pip install docling' 후 재시도.")
      log("  → 다른 경로에 있다면 환경변수 DOCLING_BIN=/path/to/docling 설정.")
      process.exit(1)
    }
    log("✓ docling fallback 활성화 (이미지 기반 PDF 를 OCR 로 재시도)")
  }

  // institutions.json — 존재하면 재사용, 없으면 조회
  let all: Institution[]
  const existingIdx = await readInstitutionsIndex()
  if (!existingIdx || args.resume === false) {
    all = await syncInstitutions(args)
  } else {
    log(`✓ 기존 institutions.json 재사용 (${existingIdx.institutions.length}개 기관)`)
    all = existingIdx.institutions
  }

  const targets = await pickTargets(args, all)
  log(`▶ 동기화 대상: ${targets.length}개 기관 (concurrency=${args.concurrency})`)

  const state = await readSyncState()
  state.perInstitution ??= {}

  // 간단한 동시성 제어 (p-limit 없이)
  const queue = [...targets]
  const workers: Promise<void>[] = []
  const startedAt = Date.now()
  let doneCount = 0
  const collected: InstitutionStats[] = []

  for (let w = 0; w < args.concurrency; w++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const inst = queue.shift()
          if (!inst) break
          try {
            const r = await syncInstitution(inst, args)
            collected.push(r)
            state.perInstitution[inst.apbaId] = {
              fetchedAt: new Date().toISOString(),
              status: "success",
              regulationCount: r.fetched,
            }
          } catch (err) {
            state.perInstitution[inst.apbaId] = {
              fetchedAt: new Date().toISOString(),
              status: "error",
              error: (err as Error).message,
              regulationCount: 0,
            }
            log(`  ! [${inst.apbaId}] 실패: ${(err as Error).message}`)
          }
          doneCount++
          if (doneCount % 5 === 0) {
            const elapsed = (Date.now() - startedAt) / 1000
            log(`  … 진행 ${doneCount}/${targets.length} (${elapsed.toFixed(0)}s)`)
          }
        }
      })()
    )
  }

  await Promise.all(workers)

  state.lastFullSync = new Date().toISOString()
  if (!args.dryRun) await writeSyncState(state)

  printFinalReport(collected, startedAt, state)

  // 배경 파이프/리다이렉트 환경에서 Node 가 stderr 버퍼를 flush 하기 전에
  // 자연 종료하면 최종 리포트가 누락될 수 있음. 명시적 drain 으로 안전 확보.
  await new Promise<void>((resolve) => {
    process.stderr.write("", () => resolve())
  })
}

function printFinalReport(
  stats: InstitutionStats[],
  startedAt: number,
  state: SyncState
): void {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  const succInst = Object.values(state.perInstitution).filter((s) => s.status === "success").length
  const failInst = Object.values(state.perInstitution).filter((s) => s.status === "error").length

  let totalRegs = 0
  let totalFetched = 0
  let totalParseOk = 0
  let totalParseFail = 0
  let totalFetchErr = 0
  const catAgg: Record<string, number> = {}
  for (const s of stats) {
    totalRegs += s.totalRegulations
    totalFetched += s.fetched
    totalParseOk += s.parseOk
    totalParseFail += s.parseFail
    totalFetchErr += s.fetchErrors
    for (const [k, v] of Object.entries(s.errorCategories)) catAgg[k] = (catAgg[k] || 0) + v
  }

  log("")
  log("══════════════════ 최종 리포트 ══════════════════")
  log(`소요 시간       : ${elapsed}s`)
  log(`기관 성공/실패  : ${succInst} / ${failInst}`)
  log(`규정 총 대상    : ${totalRegs}`)
  log(`규정 수집 완료  : ${totalFetched}`)
  log(`  └ 파싱 성공   : ${totalParseOk}`)
  log(`  └ 파싱 실패   : ${totalParseFail}`)
  log(`  └ 수집 오류   : ${totalFetchErr}`)

  const catSorted = Object.entries(catAgg).sort((a, b) => b[1] - a[1])
  if (catSorted.length > 0) {
    log("")
    log("상위 에러 유형:")
    for (const [cat, count] of catSorted.slice(0, 10)) {
      log(`  · [${count}건] ${cat}`)
    }
  }
  log("════════════════════════════════════════════════")
}

main().catch((err) => {
  process.stderr.write(`\n✗ 치명적 오류: ${err?.stack || err}\n`)
  process.exit(1)
})
