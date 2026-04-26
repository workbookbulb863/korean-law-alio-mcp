/**
 * docling CLI fallback — 스캔 PDF(이미지 기반)를 OCR 로 텍스트 추출
 *
 * kordoc 이 "이미지 기반 PDF" 로 진단한 파일만 대상. HWP/HWPX 는 docling 미지원.
 *
 * OCR 엔진 비교 결과(창업지원규정 16조문 기준) 를 근거로 tesseract 를 기본으로 채택:
 *   - tesseract : 조문 감지 14/16, Claude 답변가능률 100%, 로마자 일부 혼입
 *   - ocrmac   : 조문 감지 13/16, Claude 답변가능률 80%, 레이아웃 약함, macOS 전용
 *   - easyocr  : 조문 감지  8/16, Claude 답변가능률 50% (조문 본문 누락 빈번)
 *
 * 요구사항:
 *   - docling CLI 가 PATH 에 있어야 함 (brew install docling 또는 pip install docling)
 *   - tesseract + kor/eng 언어팩 (brew install tesseract tesseract-lang)
 *
 * 환경변수:
 *   - DOCLING_BIN         : docling 실행 파일 경로 (기본: "docling")
 *   - DOCLING_OCR_ENGINE  : "tesseract"|"easyocr"|"ocrmac"|"rapidocr"|"tesserocr" (기본: "tesseract")
 *   - DOCLING_OCR_LANG    : 엔진별 언어 코드. tesseract="kor+eng", easyocr="ko,en", ocrmac="ko-KR,en-US" (기본: 엔진에 맞춰 자동)
 *   - DOCLING_DEVICE      : "auto"|"cpu"|"cuda"|"mps" (기본: "auto")
 *   - DOCLING_TIMEOUT_MS  : 파일당 timeout (기본: 600000 = 10분)
 */

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"

const DOCLING_BIN = process.env.DOCLING_BIN || "docling"
const DOCLING_OCR_ENGINE = (process.env.DOCLING_OCR_ENGINE || "tesseract").toLowerCase()
const DOCLING_DEVICE = process.env.DOCLING_DEVICE || "auto"
const DOCLING_TIMEOUT_MS = Number(process.env.DOCLING_TIMEOUT_MS || 600_000)

/** 엔진별 기본 언어 코드 (엔진마다 포맷이 다름) */
const DEFAULT_OCR_LANG: Record<string, string> = {
  tesseract: "kor+eng",
  tesserocr: "kor+eng",
  easyocr: "ko,en",
  ocrmac: "ko-KR,en-US",
  rapidocr: "ko,en",
}
const DOCLING_OCR_LANG =
  process.env.DOCLING_OCR_LANG || DEFAULT_OCR_LANG[DOCLING_OCR_ENGINE] || "kor+eng"

export interface DoclingResult {
  success: boolean
  markdown?: string
  error?: string
  /** CLI 전체 실행 시간 (ms) */
  elapsedMs: number
}

let cachedAvailability: boolean | null = null

/** 1회만 docling 실행 가능 여부 체크. 이후 캐시 사용. */
export async function isDoclingAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability
  try {
    const ok = await runDoclingVersion()
    cachedAvailability = ok
    return ok
  } catch {
    cachedAvailability = false
    return false
  }
}

function runDoclingVersion(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(DOCLING_BIN, ["--version"], { stdio: ["ignore", "pipe", "pipe"] })
    let finished = false
    const done = (ok: boolean) => {
      if (finished) return
      finished = true
      resolve(ok)
    }
    child.on("error", () => done(false))
    child.on("exit", (code) => done(code === 0))
    setTimeout(() => {
      child.kill()
      done(false)
    }, 15_000)
  })
}

/**
 * docling CLI 로 PDF 파싱하여 markdown 반환.
 * 성공 시 markdown string, 실패 시 success=false + error.
 */
export async function parsePdfWithDocling(
  bytes: Buffer,
  hintName = "input.pdf"
): Promise<DoclingResult> {
  const startedAt = Date.now()

  // 안전한 임시 파일명
  const id = crypto.randomBytes(6).toString("hex")
  const tmpBase = path.join(os.tmpdir(), `alio-docling-${id}`)
  const tmpInput = `${tmpBase}.pdf`
  const tmpOutDir = `${tmpBase}-out`
  await fs.mkdir(tmpOutDir, { recursive: true })
  await fs.writeFile(tmpInput, bytes)

  try {
    const { code, stderr } = await runDoclingConvert(tmpInput, tmpOutDir)
    if (code !== 0) {
      return {
        success: false,
        error: `docling exit code ${code}: ${stderr.slice(-400)}`,
        elapsedMs: Date.now() - startedAt,
      }
    }
    // docling 은 기본적으로 <입력stem>.md 를 outDir 에 생성
    const expected = path.join(tmpOutDir, path.basename(tmpInput, ".pdf") + ".md")
    let md: string
    try {
      md = await fs.readFile(expected, "utf8")
    } catch {
      // 파일명 규칙이 다를 수 있어 outDir 스캔 fallback
      const entries = await fs.readdir(tmpOutDir)
      const mdFile = entries.find((e) => e.endsWith(".md"))
      if (!mdFile) {
        return {
          success: false,
          error: `docling 실행은 성공했으나 .md 출력 파일을 찾지 못함. outDir=${entries.join(", ")}`,
          elapsedMs: Date.now() - startedAt,
        }
      }
      md = await fs.readFile(path.join(tmpOutDir, mdFile), "utf8")
    }

    if (!md.trim()) {
      return {
        success: false,
        error: "docling 출력이 비어 있습니다 (OCR 이 아무 텍스트도 못 찾음)",
        elapsedMs: Date.now() - startedAt,
      }
    }

    // OCR 특유의 자간 공백/파편 정규화 (특히 tesseract 가 한 글자마다 공백 삽입하는 경향 교정)
    const normalized = normalizeOcrMarkdown(md)

    // 출력에 원본 hint 와 엔진 정보를 주석으로 남김
    const header = `<!-- parsed by docling/${DOCLING_OCR_ENGINE} (fallback from kordoc), source: ${hintName} -->\n\n`
    return {
      success: true,
      markdown: header + normalized,
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    // 임시 파일/폴더 정리 (실패해도 무시)
    await fs.rm(tmpInput, { force: true }).catch(() => {})
    await fs.rm(tmpOutDir, { recursive: true, force: true }).catch(() => {})
  }
}

function runDoclingConvert(
  inputPath: string,
  outDir: string
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "--from", "pdf",
      "--to", "md",
      "--ocr-engine", DOCLING_OCR_ENGINE,
      "--ocr-lang", DOCLING_OCR_LANG,
      "--device", DOCLING_DEVICE,
      "--num-threads", "4",
      "--output", outDir,
      "--no-abort-on-error",
      inputPath,
    ]
    const child = spawn(DOCLING_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // pydantic 경고 억제
        PYTHONWARNINGS: "ignore",
      },
    })
    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
      // 버퍼 폭발 방지
      if (stderr.length > 40_000) stderr = stderr.slice(-20_000)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, DOCLING_TIMEOUT_MS)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stderr: stderr + "\nspawn error: " + err.message })
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({ code: -2, stderr: stderr + `\ntimeout after ${DOCLING_TIMEOUT_MS}ms` })
        return
      }
      resolve({ code: code ?? -1, stderr })
    })
  })
}

/**
 * OCR 결과 정규화 — tesseract 특유의 자간 공백 + 잉여 토큰 정리.
 * Claude 가 본문을 조문 단위로 이해할 수 있도록 어절 경계를 복원한다.
 *
 * 규칙(순서 중요):
 *   1) 표 행(|...|) 은 보존 — 셀 내부 정규화만
 *   2) 한글↔한글 사이의 단일 공백 제거 (tesseract "창 업 지 원" → "창업지원")
 *   3) 숫자 조문 번호 정리: "제 10 조" → "제10조", "제 10 조 의 2" → "제10조의2"
 *   4) "( " 와 " )" 공백 제거
 *   5) 항·호 번호 공백 정리: "1 ." → "1.", "①  " → "① "
 *   6) 다중 공백 → 단일, 줄끝 trailing 제거
 *   7) 빈 줄 3개 이상 → 2개로 압축
 */
export function normalizeOcrMarkdown(md: string): string {
  const normalizeLine = (line: string): string => {
    // 표 행은 내부 셀만 정규화하기 위해 별도 처리
    if (/^\s*\|/.test(line)) {
      return line.replace(/(\|[^|\n]*)/g, (_m, cell) => normalizeCell(cell))
    }
    return normalizeCell(line)
  }

  const lines = md.split(/\r?\n/).map(normalizeLine)
  let out = lines.join("\n")

  // 3개 이상 연속 빈 줄 → 2개
  out = out.replace(/\n{3,}/g, "\n\n")
  return out
}

/** 표 셀/일반 줄 공통 정규화 로직 */
function normalizeCell(text: string): string {
  return text
    // 1) 한글↔한글 단일 공백 제거 (여러 번 반복해야 "가 나 다" → "가나다")
    .replace(/([가-힣])\s([가-힣])/g, "$1$2")
    .replace(/([가-힣])\s([가-힣])/g, "$1$2")
    .replace(/([가-힣])\s([가-힣])/g, "$1$2")
    // 2) 조문 / 호 / 항 / 장 / 절 번호 정리
    .replace(/제\s+(\d+)\s*조/g, "제$1조")
    .replace(/제(\d+)조\s*의\s*(\d+)/g, "제$1조의$2")
    .replace(/제\s+(\d+)\s*(호|항|장|절|관|편)/g, "제$1$2")
    // 3) 괄호 주변 공백
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    // 4) 숫자 + 괄호 경계 ("1 (" → "1(")
    .replace(/(\d)\s+(\()/g, "$1$2")
    // 5) 항 번호 뒤 불필요 공백: "1 ." → "1." / "①  " → "① "
    .replace(/^(\s*)(\d+)\s+\./gm, "$1$2.")
    // 6) 여러 공백 → 단일
    .replace(/[ \t]+/g, " ")
    // 7) trailing
    .replace(/ +$/g, "")
}
