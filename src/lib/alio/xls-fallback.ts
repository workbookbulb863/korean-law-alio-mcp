/**
 * .xls / .xlsx fallback — LibreOffice(soffice) + docling 체인
 *
 * ALIO 에 간혹 올라오는 엑셀 파일(예: 서울대병원 "회계계정과목운영세칙-별표1.xls")
 * 은 OLE2 시그니처가 HWP5 와 동일해 kordoc 이 HWP 로 오인식하고 실패한다.
 *
 * 처리 흐름:
 *   1) .xls  → soffice --headless --convert-to xlsx 로 .xlsx 변환
 *      .xlsx 면 이 단계 스킵
 *   2) .xlsx → docling --from xlsx --to md 로 markdown 생성
 *   3) 생성된 .md 읽어서 반환
 *
 * 요구사항:
 *   - LibreOffice 설치 (macOS: brew install --cask libreoffice)
 *   - docling 설치
 *
 * 환경변수:
 *   - SOFFICE_BIN : soffice 경로 (기본: "soffice")
 *   - DOCLING_BIN : docling 경로 (기본: "docling")
 */

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"

const SOFFICE_BIN = process.env.SOFFICE_BIN || "soffice"
const DOCLING_BIN = process.env.DOCLING_BIN || "docling"
const CMD_TIMEOUT_MS = 120_000

export interface XlsResult {
  success: boolean
  markdown?: string
  error?: string
  elapsedMs: number
}

/** 확장자 검사 — .xls / .xlsx 만 이 파이프라인으로 보냄 */
export function isXlsLike(filename: string): boolean {
  const lower = filename.toLowerCase().trim()
  return lower.endsWith(".xls") || lower.endsWith(".xlsx")
}

let cachedAvailability: boolean | null = null

/** soffice + docling 두 개 모두 실행 가능한지 1회 체크 */
export async function isXlsFallbackAvailable(): Promise<boolean> {
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
 * .xls 또는 .xlsx 바이트를 markdown 으로 변환.
 */
export async function parseXlsFile(bytes: Buffer, hintName: string): Promise<XlsResult> {
  const startedAt = Date.now()
  const id = crypto.randomBytes(6).toString("hex")
  const tmpBase = path.join(os.tmpdir(), `alio-xls-${id}`)
  await fs.mkdir(tmpBase, { recursive: true })

  const isXlsx = hintName.toLowerCase().endsWith(".xlsx")
  const inputPath = path.join(tmpBase, isXlsx ? "input.xlsx" : "input.xls")
  await fs.writeFile(inputPath, bytes)

  try {
    // 1) .xls → .xlsx (필요 시)
    let xlsxPath = inputPath
    if (!isXlsx) {
      const conv = await runSofficeToXlsx(inputPath, tmpBase)
      if (!conv.ok) {
        return {
          success: false,
          error: `soffice 변환 실패: ${conv.stderr.slice(-300)}`,
          elapsedMs: Date.now() - startedAt,
        }
      }
      xlsxPath = path.join(tmpBase, "input.xlsx")
    }

    // 2) .xlsx → .md (docling)
    const docRes = await runDoclingXlsx(xlsxPath, tmpBase)
    if (!docRes.ok) {
      return {
        success: false,
        error: `docling 변환 실패: ${docRes.stderr.slice(-300)}`,
        elapsedMs: Date.now() - startedAt,
      }
    }

    // 3) 결과 MD 읽기
    const mdPath = path.join(tmpBase, "input.md")
    let md: string
    try {
      md = await fs.readFile(mdPath, "utf8")
    } catch {
      // fallback: outdir 내 어떤 .md 든 하나 찾기
      const entries = await fs.readdir(tmpBase)
      const found = entries.find((f) => f.endsWith(".md"))
      if (!found) {
        return {
          success: false,
          error: `docling 은 성공했으나 .md 출력 없음 (outdir=${entries.join(",")})`,
          elapsedMs: Date.now() - startedAt,
        }
      }
      md = await fs.readFile(path.join(tmpBase, found), "utf8")
    }

    if (!md.trim()) {
      return {
        success: false,
        error: "변환된 MD 가 비어 있습니다",
        elapsedMs: Date.now() - startedAt,
      }
    }

    const header = `<!-- parsed by soffice+docling (xls fallback), source: ${hintName} -->\n\n`
    return {
      success: true,
      markdown: header + md,
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  }
}

function runSofficeToXlsx(
  inputPath: string,
  outDir: string
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "--headless",
      "--convert-to",
      "xlsx",
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
    }, CMD_TIMEOUT_MS)
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

function runDoclingXlsx(
  inputPath: string,
  outDir: string
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "--from",
      "xlsx",
      "--to",
      "md",
      "--output",
      outDir,
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
    }, CMD_TIMEOUT_MS)
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
