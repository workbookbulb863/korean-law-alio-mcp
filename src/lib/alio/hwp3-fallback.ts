/**
 * HWP 3.0 구포맷 fallback — LibreOffice(soffice) + docling 체인
 *
 * kordoc 은 HWP 5 이상만 지원하고, HWP 3.0 파일("HWP Document File V3.00" 시그니처)은
 * "지원하지 않는 파일 형식" 으로 실패한다. 대부분 1990~2000년대 초반에 제정된 옛 규정들.
 *
 * 처리 흐름 (1차 — 본문 품질 최상):
 *   1a) .hwp (HWP3) → soffice --convert-to docx 로 DOCX 변환
 *   2a) .docx → docling --from docx --to md (OCR 불필요, 구조 그대로 파싱)
 *   → 본문 텍스트가 완전 보존되고 문장·조문 구조가 깔끔
 *   (단점: 원본에서 이미지로 그려진 표는 복원 불가)
 *
 * DOCX 경로가 실패 시 2차 fallback:
 *   1b) .hwp → soffice --convert-to pdf
 *   2b) .pdf → docling --ocr-engine tesseract (이미지 OCR)
 *   3b) 한글 자간 공백 후처리(normalizeOcrMarkdown)
 *
 * 요구사항:
 *   - LibreOffice 설치 (macOS: brew install --cask libreoffice)
 *   - docling 설치 (DOCX 경로는 OCR 불필요, 2차 fallback 용으로만 tesseract 필요)
 *
 * 환경변수:
 *   - SOFFICE_BIN        : soffice 경로 (기본: "soffice")
 *   - DOCLING_BIN        : docling 경로 (기본: "docling")
 *   - DOCLING_DEVICE     : "auto"|"cpu"|"cuda"|"mps" (기본: "auto")
 *   - HWP3_TIMEOUT_MS    : 단계별 timeout (기본: 300000 = 5분)
 */

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { normalizeOcrMarkdown } from "./docling-fallback.js"

const SOFFICE_BIN = process.env.SOFFICE_BIN || "soffice"
const DOCLING_BIN = process.env.DOCLING_BIN || "docling"
const DOCLING_DEVICE = process.env.DOCLING_DEVICE || "auto"
const STEP_TIMEOUT_MS = Number(process.env.HWP3_TIMEOUT_MS || 300_000)

const HWP3_SIGNATURE = Buffer.from("HWP Document File V3", "ascii")

/** 파일 바이트 앞부분이 HWP 3.0 시그니처인지 검사 */
export function isHwp3(bytes: Buffer): boolean {
  if (bytes.length < HWP3_SIGNATURE.length) return false
  return bytes.slice(0, HWP3_SIGNATURE.length).equals(HWP3_SIGNATURE)
}

export interface Hwp3Result {
  success: boolean
  markdown?: string
  error?: string
  elapsedMs: number
}

let cachedAvailability: boolean | null = null

export async function isHwp3FallbackAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability
  const [soffice, docling] = await Promise.all([
    checkBinary(SOFFICE_BIN, ["--version"]),
    checkBinary(DOCLING_BIN, ["--version"]),
  ])
  cachedAvailability = soffice && docling
  return cachedAvailability
}

function checkBinary(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"] })
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      resolve(ok)
    }
    child.on("error", () => finish(false))
    child.on("exit", (code) => finish(code === 0))
    setTimeout(() => {
      child.kill()
      finish(false)
    }, 15_000)
  })
}

/**
 * HWP 3.0 바이트를 markdown 으로 변환.
 */
export async function parseHwp3(bytes: Buffer, hintName: string): Promise<Hwp3Result> {
  const startedAt = Date.now()
  const id = crypto.randomBytes(6).toString("hex")
  const tmpBase = path.join(os.tmpdir(), `alio-hwp3-${id}`)
  await fs.mkdir(tmpBase, { recursive: true })

  const inputPath = path.join(tmpBase, "input.hwp")
  await fs.writeFile(inputPath, bytes)

  try {
    // ── 1차: DOCX 경로 (본문 품질 최상) ──
    const docxConv = await runSofficeConvert(inputPath, tmpBase, "docx")
    if (docxConv.ok) {
      const docxPath = path.join(tmpBase, "input.docx")
      const docxStat = await fs.stat(docxPath).catch(() => null)
      if (docxStat && docxStat.size > 500) {
        const doc = await runDoclingDocx(docxPath, tmpBase)
        if (doc.ok) {
          const md = await readFirstMd(tmpBase)
          if (md && md.trim()) {
            const header =
              `<!-- parsed by soffice(hwp→docx)+docling/docx (HWP3 fallback), source: ${hintName} -->\n` +
              `<!-- 주의: 본문 텍스트는 완전히 복원되나, 표 구조는 LibreOffice 의 HWP3 필터 -->\n` +
              `<!-- 제약으로 인해 DOCX 로 전달되지 않아 누락됩니다. 표 내용이 필요하면 -->\n` +
              `<!-- sourceDetailUrl 의 원본 HWP 파일을 한컴오피스에서 직접 확인하세요. -->\n\n`
            return {
              success: true,
              markdown: header + md,
              elapsedMs: Date.now() - startedAt,
            }
          }
        }
      }
    }

    // ── 2차: PDF + OCR 경로 (DOCX 실패 시 fallback) ──
    const pdfConv = await runSofficeConvert(inputPath, tmpBase, "pdf")
    if (!pdfConv.ok) {
      return {
        success: false,
        error: `soffice DOCX 변환 실패 + PDF 변환도 실패: ${pdfConv.stderr.slice(-200)}`,
        elapsedMs: Date.now() - startedAt,
      }
    }

    const pdfPath = path.join(tmpBase, "input.pdf")
    const pdfStat = await fs.stat(pdfPath).catch(() => null)
    if (!pdfStat || pdfStat.size < 500) {
      return {
        success: false,
        error: `PDF 변환 성공이지만 유효 파일 없음 (size=${pdfStat?.size ?? 0})`,
        elapsedMs: Date.now() - startedAt,
      }
    }

    const ocrRes = await runDoclingOcr(pdfPath, tmpBase)
    if (!ocrRes.ok) {
      return {
        success: false,
        error: `docling OCR 실패: ${ocrRes.stderr.slice(-300)}`,
        elapsedMs: Date.now() - startedAt,
      }
    }

    const md = await readFirstMd(tmpBase)
    if (!md || !md.trim()) {
      return {
        success: false,
        error: "OCR 결과가 비어 있습니다",
        elapsedMs: Date.now() - startedAt,
      }
    }

    const normalized = normalizeOcrMarkdown(md)
    const header = `<!-- parsed by soffice(hwp→pdf)+docling/tesseract (HWP3 fallback, OCR 2차), source: ${hintName} -->\n\n`
    return {
      success: true,
      markdown: header + normalized,
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  }
}

/** outDir 에서 가장 최근 .md 파일을 읽음 (파일명 규칙이 변환기마다 달라서 보수적으로 스캔) */
async function readFirstMd(outDir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(outDir)
    const mdFile = entries.find((f) => f.endsWith(".md"))
    if (!mdFile) return null
    return await fs.readFile(path.join(outDir, mdFile), "utf8")
  } catch {
    return null
  }
}

function runSofficeConvert(
  inputPath: string,
  outDir: string,
  targetFormat: "pdf" | "docx" | "odt"
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "--headless",
      "--convert-to",
      targetFormat,
      "--outdir",
      outDir,
      inputPath,
    ]
    const child = spawn(SOFFICE_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr?.on("data", (c) => {
      stderr += c.toString("utf8")
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000)
    })
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGKILL")
      resolve({ ok: false, stderr: stderr + "\ntimeout" })
    }, STEP_TIMEOUT_MS)
    child.on("error", (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stderr: stderr + "\nspawn error: " + err.message })
    })
    child.on("exit", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr })
    })
  })
}

function runDoclingDocx(
  inputPath: string,
  outDir: string
): Promise<{ ok: boolean; stderr: string }> {
  // DOCX 는 이미 구조화된 포맷이므로 OCR 불필요 — 빠르고 품질 높음
  return new Promise((resolve) => {
    const args = [
      "--from", "docx",
      "--to", "md",
      "--output", outDir,
      "--no-abort-on-error",
      inputPath,
    ]
    const child = spawn(DOCLING_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONWARNINGS: "ignore" },
    })
    let stderr = ""
    child.stderr?.on("data", (c) => {
      stderr += c.toString("utf8")
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000)
    })
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGKILL")
      resolve({ ok: false, stderr: stderr + "\ntimeout" })
    }, STEP_TIMEOUT_MS)
    child.on("error", (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stderr: stderr + "\nspawn error: " + err.message })
    })
    child.on("exit", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr })
    })
  })
}

function runDoclingOcr(
  inputPath: string,
  outDir: string
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "--from", "pdf",
      "--to", "md",
      "--ocr-engine", "tesseract",
      "--ocr-lang", "kor+eng",
      "--device", DOCLING_DEVICE,
      "--num-threads", "4",
      "--output", outDir,
      "--no-abort-on-error",
      inputPath,
    ]
    const child = spawn(DOCLING_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONWARNINGS: "ignore" },
    })
    let stderr = ""
    child.stderr?.on("data", (c) => {
      stderr += c.toString("utf8")
      if (stderr.length > 40_000) stderr = stderr.slice(-20_000)
    })
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGKILL")
      resolve({ ok: false, stderr: stderr + "\ntimeout" })
    }, STEP_TIMEOUT_MS)
    child.on("error", (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stderr: stderr + "\nspawn error: " + err.message })
    })
    child.on("exit", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr })
    })
  })
}
