import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sha256Hex } from "./canonical";

export type VerifyConfig = {
  store_dir?: string;
  evidence_store_dir?: string;
};

/**
 * Storage decision (v0.1), mirroring Evidence philosophy:
 * - Receipts default to user-data space outside any repo, namespaced per
 *   project. Receipts reference claims and criteria that may be sensitive.
 * - Explicit opt-in for project-local stores via OPENCODE_VERIFY_DIR or
 *   <project>/.opencode/verify.json {store_dir, evidence_store_dir}.
 * - Receipts and evidence records are never mixed in one directory.
 */
export function defaultStoreDir(projectDir: string): string {
  const canonical = resolve(projectDir).replace(/\\/g, "/").toLowerCase();
  const slug = sha256Hex(canonical).slice(0, 12);
  return join(userDataDir(), "opencode-verify", "projects", `vr-${slug}`);
}

function userDataDir(): string {
  if (process.platform === "win32") {
    return process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  }
  return process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
}

export function loadFileConfig(projectDir: string): VerifyConfig {
  const path = join(resolve(projectDir), ".opencode", "verify.json");
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`VERIFY_CONFIG_INVALID: ${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`VERIFY_CONFIG_INVALID: ${path} must be a JSON object`);
  }
  const cfg = parsed as Record<string, unknown>;
  const out: VerifyConfig = {};
  for (const key of ["store_dir", "evidence_store_dir"] as const) {
    if (cfg[key] !== undefined) {
      if (typeof cfg[key] !== "string") {
        throw new Error(`VERIFY_CONFIG_INVALID: ${key} must be a string`);
      }
      if ((cfg[key] as string).length > 0) out[key] = cfg[key] as string;
    }
  }
  return out;
}

export function resolveStoreDir(projectDir: string, overrides: VerifyConfig = {}): string {
  const env = process.env["OPENCODE_VERIFY_DIR"];
  if (env && env.length > 0) return resolve(env);
  const fileCfg = loadFileConfig(projectDir);
  const configured = overrides.store_dir ?? fileCfg.store_dir;
  if (configured && configured.length > 0) return resolve(projectDir, configured);
  return defaultStoreDir(projectDir);
}

export function resolveEvidenceStoreDir(
  projectDir: string,
  overrides: VerifyConfig = {},
  perCall?: string,
): string | undefined {
  if (perCall && perCall.length > 0) return resolve(projectDir, perCall);
  const env = process.env["OPENCODE_EVIDENCE_DIR"];
  if (env && env.length > 0) return resolve(env);
  const fileCfg = loadFileConfig(projectDir);
  const configured = overrides.evidence_store_dir ?? fileCfg.evidence_store_dir;
  if (configured && configured.length > 0) return resolve(projectDir, configured);
  return undefined;
}
