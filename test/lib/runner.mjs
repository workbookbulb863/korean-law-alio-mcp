/**
 * 테스트 러너 — 함수 직접 호출 기반의 가벼운 테스트.
 *
 * MCP 프로토콜 통합 테스트는 기존 test/*.cjs 가 담당.
 * 이쪽은 도구 handler 를 직접 호출 → 빠른 PASS/FAIL/SKIP 보고.
 */

import process from "node:process"

export class SkipError extends Error {
  constructor(reason) {
    super(reason)
    this.name = "SkipError"
  }
}

export class TestRunner {
  constructor(label) {
    this.label = label
    this.results = []
  }

  async run(name, fn) {
    const start = Date.now()
    try {
      await fn()
      this.results.push({ name, status: "PASS", ms: Date.now() - start })
    } catch (e) {
      const ms = Date.now() - start
      if (e instanceof SkipError) {
        this.results.push({ name, status: "SKIP", reason: e.message, ms })
      } else {
        this.results.push({ name, status: "FAIL", error: e.message, ms })
      }
    }
  }

  /** 묶어서 skip — 모든 후속 테스트가 동일 사유로 스킵될 때 */
  skipAll(names, reason) {
    for (const name of names) {
      this.results.push({ name, status: "SKIP", reason, ms: 0 })
    }
  }

  print() {
    const counts = { PASS: 0, FAIL: 0, SKIP: 0 }
    for (const r of this.results) counts[r.status]++
    const headerWidth = Math.max(40, this.label.length + 4)
    console.log("\n" + "─".repeat(headerWidth))
    console.log(` ${this.label}  (${this.results.length} cases)`)
    console.log("─".repeat(headerWidth))
    for (const r of this.results) {
      const icon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "⏭"
      const time = r.ms ? `${r.ms}ms` : ""
      const tail =
        r.status === "FAIL" ? ` — ${r.error}` :
        r.status === "SKIP" ? ` — ${r.reason}` : ""
      console.log(`  ${icon} ${r.name.padEnd(50)} ${time.padStart(7)}${tail}`)
    }
    console.log(`  → PASS ${counts.PASS} · FAIL ${counts.FAIL} · SKIP ${counts.SKIP}`)
    return counts
  }
}

/** 어서션 헬퍼 */
export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed")
}

export function assertOk(result, msg = "tool returned isError") {
  if (result?.isError) {
    const text = result.content?.[0]?.text?.slice(0, 200) ?? "(no text)"
    throw new Error(`${msg}: ${text}`)
  }
}

export function assertContains(result, substr, msg) {
  const text = result?.content?.[0]?.text ?? ""
  if (!text.includes(substr)) {
    throw new Error(msg ?? `결과에 "${substr}" 없음 — got: ${text.slice(0, 200)}`)
  }
}

export function assertMinLength(result, minChars, msg) {
  const text = result?.content?.[0]?.text ?? ""
  if (text.length < minChars) {
    throw new Error(msg ?? `응답이 너무 짧음 (${text.length}자 < ${minChars}자)`)
  }
}

export function assertIsError(result, substr) {
  if (!result?.isError) throw new Error("expected isError, got success")
  if (substr) assertContains(result, substr)
}

export function skip(reason) {
  throw new SkipError(reason)
}

/** 종합 요약 + exit code */
export function summarize(allCounts) {
  const total = { PASS: 0, FAIL: 0, SKIP: 0 }
  for (const c of allCounts) {
    total.PASS += c.PASS
    total.FAIL += c.FAIL
    total.SKIP += c.SKIP
  }
  const sum = total.PASS + total.FAIL + total.SKIP
  console.log("\n" + "═".repeat(50))
  console.log(` 종합 — ${sum} cases`)
  console.log("═".repeat(50))
  console.log(`  PASS  ${total.PASS}`)
  console.log(`  FAIL  ${total.FAIL}`)
  console.log(`  SKIP  ${total.SKIP}`)
  console.log("═".repeat(50))
  if (total.FAIL > 0) {
    console.log(" ❌ 실패 케이스 있음")
    process.exit(1)
  } else {
    console.log(" ✅ 전체 통과")
    process.exit(0)
  }
}
