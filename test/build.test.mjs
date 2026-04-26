/**
 * 빌드 / 모듈 로드 sanity test
 */

import { TestRunner, assert, summarize } from "./lib/runner.mjs"
import { execSync } from "node:child_process"
import { loadDotenv, projectRoot } from "./lib/env.mjs"

loadDotenv()

const r = new TestRunner("빌드 + 모듈 로드")

await r.run("tsc --noEmit (타입체크)", () => {
  try {
    execSync("npx tsc --noEmit", { cwd: projectRoot(), stdio: "pipe" })
  } catch (e) {
    throw new Error(`타입체크 실패: ${e.stderr?.toString()?.slice(0, 200) ?? e.message}`)
  }
})

await r.run("tool-registry 모듈 로드 + 도구 수", async () => {
  const { allTools } = await import("../build/tool-registry.js")
  assert(Array.isArray(allTools), "allTools 배열 아님")
  assert(allTools.length === 110, `도구 수 불일치: expected 110, got ${allTools.length}`)
})

await r.run("ALIO 도구 23개 등록 확인", async () => {
  const { allTools } = await import("../build/tool-registry.js")
  const alioTools = allTools.filter((t) => t.description?.startsWith("[ALIO"))
  assert(alioTools.length === 23, `ALIO 도구 수: expected 23, got ${alioTools.length}`)
})

await r.run("query-router 모듈 로드", async () => {
  const m = await import("../build/lib/query-router.js")
  assert(typeof m.routeQuery === "function", "routeQuery 함수 없음")
})

await r.run("api-client 모듈 로드", async () => {
  const m = await import("../build/lib/api-client.js")
  assert(typeof m.LawApiClient === "function", "LawApiClient 클래스 없음")
})

await r.run("alio config 모듈 로드 (빈 환경변수)", async () => {
  delete process.env.ALIO_INSTITUTION_ALIASES
  // resetCache 위해 캐시 바이패스 — 새 query string import
  const m = await import("../build/lib/alio/config.js?v=" + Date.now())
  m.resetAlioConfigCache()
  const aliases = m.getInstitutionAliases()
  assert(Object.keys(aliases).length === 0, `미설정 시 빈 객체여야 함, got ${JSON.stringify(aliases)}`)
})

const counts = r.print()
summarize([counts])
