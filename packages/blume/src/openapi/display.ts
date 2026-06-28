import type { Heading } from "../core/types.ts";
import type {
  ApiOperation,
  ApiSecurityScheme,
  ApiServer,
  ApiTag,
  ApiTagGroup,
  Constraints,
  SchemaNode,
} from "./ir.ts";

/**
 * A compact operation summary shown in the reference overview (one row per
 * operation, grouped by tag).
 */
export interface OpSummary {
  deprecated: boolean;
  method: string;
  path: string;
  route: string;
  summary?: string;
  tag: string;
}

/** The render data for one native reference page, keyed by route in the runtime. */
export type OpenApiPageEntry =
  | {
      description?: string;
      headings: Heading[];
      info: { description?: string; title: string; version: string };
      kind: "overview";
      operations: OpSummary[];
      originalVersion: string;
      playground: boolean;
      security: ApiSecurityScheme[];
      servers: ApiServer[];
      tagGroups: ApiTagGroup[];
      tags: ApiTag[];
      title: string;
    }
  | {
      description?: string;
      headings: Heading[];
      kind: "operation";
      operation: ApiOperation;
      playground: boolean;
      servers: ApiServer[];
      title: string;
    };

/** A header nav tab (label + route) for a reference overview. */
export interface OpenApiTab {
  label: string;
  path: string;
}

/** The generated `openapi.json` runtime module: route → page render data. */
export interface OpenApiRuntime {
  pages: Record<string, OpenApiPageEntry>;
  /** Header nav tabs, one per reference overview. */
  tabs: OpenApiTab[];
}

/**
 * Display helpers shared by the build-time integration ({@link ./native.ts}) and
 * the runtime render components (`components/openapi/*.astro`). Kept free of any
 * node/parser imports so the Astro runtime can import it without pulling in the
 * build-time toolchain.
 */

/** Parameter groups, in display order. */
export const PARAM_GROUPS: {
  in: ApiOperation["parameters"][number]["in"];
  label: string;
}[] = [
  { in: "path", label: "Path parameters" },
  { in: "query", label: "Query parameters" },
  { in: "header", label: "Header parameters" },
  { in: "cookie", label: "Cookie parameters" },
];

const NON_SLUG = /[^a-z0-9]+/gu;
const SLUG_EDGES = /^-+|-+$/gu;

/** GitHub-style slug for a section heading (matches the content slugifier). */
export const slugifyHeading = (text: string): string =>
  text.toLowerCase().replace(NON_SLUG, "-").replace(SLUG_EDGES, "");

/** A Tailwind text/background color pairing per HTTP method, for the badge. */
export const METHOD_STYLES: Record<string, string> = {
  DELETE: "bg-red-500/10 text-red-600 dark:text-red-400",
  GET: "bg-green-500/10 text-green-600 dark:text-green-400",
  PATCH: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  POST: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  PUT: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
};

/** The badge style for a method, falling back to a neutral tone. */
export const methodStyle = (method: string): string =>
  METHOD_STYLES[method.toUpperCase()] ?? "bg-muted text-muted-foreground";

/** The ordered section headings for one operation (drives the page TOC). */
export const operationHeadings = (operation: ApiOperation): Heading[] => {
  const headings: Heading[] = [];
  const add = (text: string): void => {
    headings.push({ depth: 2, slug: slugifyHeading(text), text });
  };

  if (operation.security.length > 0) {
    add("Authorizations");
  }
  for (const group of PARAM_GROUPS) {
    if (operation.parameters.some((parameter) => parameter.in === group.in)) {
      add(group.label);
    }
  }
  if (operation.requestBody && operation.requestBody.content.length > 0) {
    add("Request body");
  }
  if (operation.responses.length > 0) {
    add("Responses");
  }
  return headings;
};

/** A short, human label for a schema node (the right-hand "type" column). */
export const schemaTypeLabel = (node: SchemaNode): string => {
  switch (node.kind) {
    case "primitive": {
      const nullable = node.constraints.nullable ? " | null" : "";
      return `${node.format ? `${node.type}<${node.format}>` : node.type}${nullable}`;
    }
    case "enum": {
      return node.type ? `enum<${node.type}>` : "enum";
    }
    case "object": {
      return node.title ?? "object";
    }
    case "array": {
      return `${schemaTypeLabel(node.items)}[]`;
    }
    case "union": {
      return node.variant;
    }
    case "ref-cycle": {
      return node.label;
    }
    default: {
      return "schema";
    }
  }
};

/** Format the constraints of a primitive/array node as short inline chips. */
/** Render a scalar default/enum value compactly for inline display. */
export const formatScalar = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

export const constraintChips = (constraints: Constraints): string[] => {
  const chips: string[] = [];
  const pushRange = (
    label: string,
    min: number | undefined,
    max: number | undefined
  ): void => {
    if (min !== undefined && max !== undefined) {
      chips.push(`${label} ${min}–${max}`);
    } else if (min !== undefined) {
      chips.push(`${label} ≥ ${min}`);
    } else if (max !== undefined) {
      chips.push(`${label} ≤ ${max}`);
    }
  };
  pushRange("", constraints.minimum, constraints.maximum);
  pushRange("length", constraints.minLength, constraints.maxLength);
  pushRange("items", constraints.minItems, constraints.maxItems);
  if (constraints.pattern) {
    chips.push(`pattern ${constraints.pattern}`);
  }
  if (constraints.multipleOf !== undefined) {
    chips.push(`multiple of ${constraints.multipleOf}`);
  }
  if (constraints.uniqueItems) {
    chips.push("unique");
  }
  if (constraints.default !== undefined) {
    chips.push(`default ${formatScalar(constraints.default)}`);
  }
  if (constraints.readOnly) {
    chips.push("read-only");
  }
  if (constraints.writeOnly) {
    chips.push("write-only");
  }
  return chips;
};
