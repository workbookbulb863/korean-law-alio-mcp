/**
 * 통합 러너 — build + router + alio + law 모두 순차 실행 후 종합.
 *
 * 각 파일은 단독 실행도 가능 (자체적으로 summarize 호출 + exit).
 * 여기서는 자식 프로세스로 실행해 격리 + 종합.
 */

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const suites = [
  ["빌드/모듈",  "build.test.mjs"],
  ["라우터",     "router.test.mjs"],
  ["CLI 표면",   "cli.test.mjs"],
  ["ALIO 도구",  "alio.test.mjs"],
  ["법제처 도구", "law.test.mjs"],
]

const summary = []
for (const [label, file] of suites) {
  console.log(`\n${"━".repeat(60)}\n  ▶ ${label} (${file})\n${"━".repeat(60)}`)
  const result = spawnSync("node", [path.join(__dirname, file)], {
    stdio: "inherit",
    cwd: path.resolve(__dirname, ".."),
  })
  summary.push({ label, file, code: result.status })
}

console.log("\n" + "═".repeat(60))
console.log(" 통합 결과")
console.log("═".repeat(60))
let totalFail = 0
for (const s of summary) {
  const icon = s.code === 0 ? "✅" : "❌"
  console.log(`  ${icon} ${s.label.padEnd(15)} (exit=${s.code})`)
  if (s.code !== 0) totalFail++
}
console.log("═".repeat(60))
process.exit(totalFail > 0 ? 1 : 0)
