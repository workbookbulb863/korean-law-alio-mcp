/**
 * 별표 파일 파서 — kordoc 위임
 *
 * HWPX / HWP5 / PDF / DOCX / XLSX 모두 kordoc 통합 파서에 위임합니다.
 * kordoc 은 colAddr/rowAddr 기반 HWP5 셀 배치, PDF 라인+클러스터 이중 테이블 감지,
 * ZIP bomb 방지, 깨진 ZIP 복구 등 강화된 파싱 기능을 제공합니다.
 *
 * 의존성: [kordoc](https://github.com/chrisryugj/kordoc) by @chrisryugj (MIT License).
 * 본 파일은 kordoc 의 외부 API 만 호출하는 thin wrapper 입니다.
 */

import { parse } from "kordoc"
import type { ParseResult } from "kordoc"

// ─── 기존 인터페이스 호환 ────────────────────────────

export type AnnexFileType = "hwpx" | "hwp" | "hwpml" | "pdf" | "xlsx" | "docx" | "unknown"

export interface AnnexParseResult {
  success: boolean
  markdown?: string
  fileType: AnnexFileType
  /** 이미지 기반 PDF 여부 (텍스트 추출 불가) */
  isImageBased?: boolean
  /** PDF 페이지 수 */
  pageCount?: number
  error?: string
}

// ─── 메인 엔트리 ─────────────────────────────────────

export async function parseAnnexFile(buffer: ArrayBuffer): Promise<AnnexParseResult> {
  const result: ParseResult = await parse(buffer)

  if (result.success) {
    return {
      success: true,
      fileType: result.fileType,
      markdown: result.markdown,
    }
  }

  return {
    success: false,
    fileType: result.fileType,
    isImageBased: result.isImageBased,
    pageCount: result.pageCount,
    error: result.error,
  }
}
