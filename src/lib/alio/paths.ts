/**
 * ALIO 데이터 디렉터리 경로 해결
 *
 * 배치 스크립트와 런타임 인덱서가 같은 경로 체계를 쓰도록 중앙화.
 * 환경변수 ALIO_DATA_DIR 가 있으면 우선 사용(테스트용),
 * 없으면 패키지 루트 기준 data/alio 경로 사용.
 */

import { fileURLToPath } from "node:url"
import path from "node:path"

function resolvePackageRoot(): string {
  // 이 파일은 빌드 후 build/lib/alio/paths.js 에 위치 → 3단계 상위가 패키지 루트
  // 소스 상태(tsx 등)에서도 src/lib/alio/paths.ts → 3단계 상위가 루트로 동일
  const here = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(here), "..", "..", "..")
}

export function alioDataDir(): string {
  const override = process.env.ALIO_DATA_DIR
  if (override && override.trim()) return path.resolve(override.trim())
  return path.join(resolvePackageRoot(), "data", "alio")
}

export function institutionsIndexPath(): string {
  return path.join(alioDataDir(), "institutions.json")
}

export function syncStatePath(): string {
  return path.join(alioDataDir(), "sync-state.json")
}

export function institutionDir(apbaId: string): string {
  return path.join(alioDataDir(), apbaId)
}

export function manifestPath(apbaId: string): string {
  return path.join(institutionDir(apbaId), "manifest.json")
}

export function regulationMdPath(apbaId: string, regId: string): string {
  return path.join(institutionDir(apbaId), "regulations", `${regId}.md`)
}

/** 모든 manifest 경로를 훑기 위한 루트 */
export function dataRoot(): string {
  return alioDataDir()
}
