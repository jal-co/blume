import { readFile } from "node:fs/promises";

import { dereference, normalize, upgrade } from "@scalar/openapi-parser";
import { isAbsolute, join } from "pathe";

/**
 * Layer 1 — the delegated pipeline (see `plan/24-openapi-native.md`).
 *
 * The "monster" — `$ref` resolution (internal/external/circular), validation,
 * and three input dialects (Swagger 2.0, OpenAPI 3.0, 3.1) — is owned by
 * `@scalar/openapi-parser`. This module is a thin wrapper that loads a spec
 * (local file or remote URL), up-converts it to a single dialect (3.1), and
 * dereferences every `$ref` so everything downstream sees clean, single-dialect,
 * dereferenced data. Circular references survive as real JS object cycles in the
 * result; the IR lowering ({@link ./ir.ts}) breaks them with `ref-cycle` stops.
 */

const URL_SPEC = /^https?:\/\//u;

/** The normalized, dereferenced 3.1 document plus provenance for display. */
export interface ParsedSpec {
  /** Fully dereferenced OpenAPI 3.1 document (may contain object cycles). */
  document: Record<string, unknown>;
  /** The spec version as authored (`2.0`, `3.0`, `3.1`), for the reference header. */
  originalVersion: string;
  /** Non-fatal validation/resolution messages from the parser. */
  warnings: string[];
}

/** A failed parse: the reason, so the caller can warn and skip the source. */
export interface ParseError {
  error: string;
}

export type ParseResult = ParsedSpec | ParseError;

/** Whether a parse produced a usable document. */
export const isParsed = (result: ParseResult): result is ParsedSpec =>
  "document" in result;

/** Read a spec from a remote URL or a local path (resolved against `root`). */
const loadSpecText = async (spec: string, root: string): Promise<string> => {
  if (URL_SPEC.test(spec)) {
    const response = await fetch(spec);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  }
  const absolute = isAbsolute(spec) ? spec : join(root, spec);
  return await readFile(absolute, "utf-8");
};

/** Read the authored spec version from a normalized (pre-upgrade) document. */
const readOriginalVersion = (normalized: Record<string, unknown>): string => {
  if (typeof normalized.swagger === "string") {
    return normalized.swagger;
  }
  if (typeof normalized.openapi === "string") {
    return normalized.openapi;
  }
  return "unknown";
};

/**
 * Load, up-convert, and dereference an OpenAPI spec into a normalized 3.1
 * document. Returns a {@link ParseError} (never throws) so a single bad source
 * degrades to a warning instead of breaking the whole build.
 */
export const parseSpec = async (
  spec: string,
  root: string
): Promise<ParseResult> => {
  let text: string;
  try {
    text = await loadSpecText(spec, root);
  } catch (error) {
    return {
      error: `Could not read API spec "${spec}": ${(error as Error).message}`,
    };
  }

  try {
    const normalized = normalize(text) as Record<string, unknown>;
    const originalVersion = readOriginalVersion(normalized);
    const upgraded = upgrade(normalized);
    const result = await dereference(upgraded.specification);

    const document = (result.schema ?? upgraded.specification) as
      | Record<string, unknown>
      | undefined;
    if (!document || typeof document !== "object") {
      return { error: `API spec "${spec}" did not resolve to a document.` };
    }

    const warnings = (result.errors ?? [])
      .map((entry) => entry.message)
      .filter((message): message is string => typeof message === "string");

    return { document, originalVersion, warnings };
  } catch (error) {
    return {
      error: `Could not parse API spec "${spec}": ${(error as Error).message}`,
    };
  }
};
