/**
 * 테스트용 .env 로더 + 데이터 가용성 확인 헬퍼
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..", "..")

export function loadDotenv() {
  const envPath = path.join(ROOT, ".env")
  if (!fs.existsSync(envPath)) return
  const text = fs.readFileSync(envPath, "utf8")
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx < 0) continue
    const key = trimmed.slice(0, idx).trim()
    const val = trimmed.slice(idx + 1).trim()
    if (key && val && !process.env[key]) process.env[key] = val
  }
}

export function hasLawOc() {
  return !!(process.env.LAW_OC && process.env.LAW_OC.length > 0)
}

export function hasAlioData() {
  const dir = process.env.ALIO_DATA_DIR || path.join(ROOT, "data", "alio")
  if (!fs.existsSync(dir)) return false
  try {
    const entries = fs.readdirSync(dir).filter((d) => /^C\d{4}$/.test(d))
    return entries.length > 0
  } catch {
    return false
  }
}

export function projectRoot() {
  return ROOT
}
