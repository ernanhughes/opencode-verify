export const PLUGIN_ID = "opencode-verify" as const;
export const PLUGIN_VERSION = "0.1.0" as const;
export const VERIFICATION_SCHEMA = "opencode.verification.v1" as const;

/**
 * Evidence contract this verifier was built and tested against.
 * There is no runtime dependency on opencode-evidence (it is a local-only
 * package with no registry presence); instead src/evidence-contract.ts
 * vendors a pinned read-only copy of the validation + integrity rules,
 * and tests/fixtures/evidence-example.json pins byte-level compatibility.
 */
export const EVIDENCE_CONTRACT_REF = "opencode-evidence@88cc2e6" as const;
export const SUPPORTED_EVIDENCE_SCHEMAS: readonly string[] = ["opencode.evidence.v1"];
