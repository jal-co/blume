/**
 * The normalized IR and the lowering step (see `plan/24-openapi-native.md`).
 *
 * This is the insulation layer: the render walk never touches raw OpenAPI. The
 * lowering walks a *dereferenced, single-dialect (3.1)* document and emits a
 * small internal model — a finite set of node types — so Layer 2 stays bounded.
 * Everything the lowering can't model cleanly degrades to a `raw` node rather
 * than breaking (the graceful-degradation contract).
 */

// ---------------------------------------------------------------------------
// IR types
// ---------------------------------------------------------------------------

/** Validation/format facets carried inline next to a primitive or array node. */
export interface Constraints {
  default?: unknown;
  deprecated?: boolean;
  example?: unknown;
  exclusiveMaximum?: number;
  exclusiveMinimum?: number;
  maxItems?: number;
  maxLength?: number;
  maximum?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  multipleOf?: number;
  nullable?: boolean;
  pattern?: string;
  readOnly?: boolean;
  uniqueItems?: boolean;
  writeOnly?: boolean;
}

/** A discriminated union's discriminator (3.x `discriminator`). */
export interface Discriminator {
  mapping?: Record<string, string>;
  propertyName: string;
}

/** One property of an `object` node. */
export interface PropertyNode {
  deprecated?: boolean;
  name: string;
  required: boolean;
  schema: SchemaNode;
}

/**
 * The render walk only ever sees this — never raw JSON Schema. `allOf` is merged
 * during lowering (not a node); `ref-cycle` stops infinite expansion; `raw` is
 * the graceful-degradation escape hatch.
 */
export type SchemaNode =
  | {
      constraints: Constraints;
      description?: string;
      format?: string;
      kind: "primitive";
      title?: string;
      type: string;
    }
  | {
      description?: string;
      kind: "enum";
      names?: string[];
      title?: string;
      type?: string;
      values: unknown[];
    }
  | {
      additional?: SchemaNode | boolean;
      description?: string;
      kind: "object";
      properties: PropertyNode[];
      title?: string;
    }
  | {
      constraints: Constraints;
      description?: string;
      items: SchemaNode;
      kind: "array";
      title?: string;
    }
  | {
      description?: string;
      discriminator?: Discriminator;
      kind: "union";
      options: SchemaNode[];
      title?: string;
      variant: "anyOf" | "oneOf";
    }
  | { kind: "ref-cycle"; label: string }
  | { description?: string; kind: "raw"; schema: unknown; title?: string };

/** A single example, serialized to a displayable string. */
export interface ApiExample {
  name?: string;
  summary?: string;
  /** Pretty-printed value, or the `externalValue` URL. */
  value: string;
  /** True when `value` is a URL reference (`externalValue`) rather than inline. */
  external?: boolean;
}

/** A request/response body variant for one media type. */
export interface ApiMediaType {
  examples: ApiExample[];
  mediaType: string;
  schema?: SchemaNode;
}

/** A request or response body: a set of media-type variants. */
export interface ApiBody {
  content: ApiMediaType[];
  description?: string;
  required: boolean;
}

/** One operation parameter (path/query/header/cookie). */
export interface ApiParameter {
  deprecated?: boolean;
  description?: string;
  in: "cookie" | "header" | "path" | "query";
  name: string;
  required: boolean;
  schema?: SchemaNode;
}

/** A single HTTP response. */
export interface ApiResponse {
  content: ApiMediaType[];
  description?: string;
  status: string;
}

/** One security requirement: an AND of schemes (the array is OR'd by the op). */
export interface ApiSecurityRequirement {
  schemes: { scheme: string; scopes: string[] }[];
}

/** A server entry (operation- or document-level). */
export interface ApiServer {
  description?: string;
  url: string;
}

/** A declared security scheme (`components.securitySchemes`). */
export interface ApiSecurityScheme {
  description?: string;
  /** e.g. `apiKey`, `http`, `oauth2`, `openIdConnect`. */
  flowsSummary?: string;
  name: string;
  /** For `http`: bearer/basic; for `apiKey`: `in`+`name`. */
  detail?: string;
  type: string;
}

/** A single API operation — the unit that becomes a Blume page. */
export interface ApiOperation {
  deprecated: boolean;
  description?: string;
  examples: ApiExample[];
  id: string;
  method: string;
  parameters: ApiParameter[];
  path: string;
  requestBody?: ApiBody;
  responses: ApiResponse[];
  security: ApiSecurityRequirement[];
  summary?: string;
  tag: string;
}

/** A tag with its (optional) description. */
export interface ApiTag {
  description?: string;
  name: string;
}

/** A named group of tags (`x-tagGroups`). */
export interface ApiTagGroup {
  name: string;
  tags: string[];
}

/** The whole reference, normalized to a render-ready shape. */
export interface ApiReference {
  info: { description?: string; title: string; version: string };
  operations: ApiOperation[];
  originalVersion: string;
  security: ApiSecurityScheme[];
  servers: ApiServer[];
  tagGroups: ApiTagGroup[];
  tags: ApiTag[];
}

// ---------------------------------------------------------------------------
// Lowering helpers
// ---------------------------------------------------------------------------

/** Depth cap: a backstop against pathological nesting/recursion in huge specs. */
const MAX_DEPTH = 12;

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

/** JSON-Schema keywords we don't model directly; their presence forces `raw`. */
const EXOTIC_KEYWORDS = [
  "if",
  "then",
  "else",
  "not",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentSchemas",
  "propertyNames",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const asBool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** Pull validation/format facets off a schema into a flat {@link Constraints}. */
const readConstraints = (schema: Record<string, unknown>): Constraints => {
  const constraints: Constraints = {};
  const numeric = constraints as Record<string, number>;
  const assignNumber = (key: keyof Constraints, value: unknown): void => {
    const n = asNumber(value);
    if (n !== undefined) {
      numeric[key] = n;
    }
  };
  assignNumber("minimum", schema.minimum);
  assignNumber("maximum", schema.maximum);
  // 3.1 exclusive bounds are numbers; tolerate 3.0 boolean form by ignoring it.
  assignNumber("exclusiveMinimum", schema.exclusiveMinimum);
  assignNumber("exclusiveMaximum", schema.exclusiveMaximum);
  assignNumber("multipleOf", schema.multipleOf);
  assignNumber("minLength", schema.minLength);
  assignNumber("maxLength", schema.maxLength);
  assignNumber("minItems", schema.minItems);
  assignNumber("maxItems", schema.maxItems);

  const pattern = asString(schema.pattern);
  if (pattern !== undefined) {
    constraints.pattern = pattern;
  }
  const uniqueItems = asBool(schema.uniqueItems);
  if (uniqueItems !== undefined) {
    constraints.uniqueItems = uniqueItems;
  }
  if (schema.default !== undefined) {
    constraints.default = schema.default;
  }
  if (schema.example !== undefined) {
    constraints.example = schema.example;
  }
  const readOnly = asBool(schema.readOnly);
  if (readOnly) {
    constraints.readOnly = true;
  }
  const writeOnly = asBool(schema.writeOnly);
  if (writeOnly) {
    constraints.writeOnly = true;
  }
  const deprecated = asBool(schema.deprecated);
  if (deprecated) {
    constraints.deprecated = true;
  }
  return constraints;
};

/** Split a 3.1 `type` (string or array) into its non-null type(s) + nullability. */
const splitType = (raw: unknown): { nullable: boolean; types: string[] } => {
  if (typeof raw === "string") {
    return { nullable: false, types: [raw] };
  }
  if (Array.isArray(raw)) {
    const strings = raw.filter((t): t is string => typeof t === "string");
    return {
      nullable: strings.includes("null"),
      types: strings.filter((t) => t !== "null"),
    };
  }
  return { nullable: false, types: [] };
};

/**
 * Merge an `allOf` intersection chain into a single object schema: combined
 * properties, unioned `required`, and merged constraints. Members that aren't
 * plain objects (a `$ref` to a union, say) are skipped — the merge is
 * best-effort and falls back to `raw` upstream if it can't produce an object.
 */
const mergeAllOf = (
  schema: Record<string, unknown>
): Record<string, unknown> => {
  const members = Array.isArray(schema.allOf) ? schema.allOf : [];
  const merged: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  // The outer schema's own keywords (besides allOf) participate in the merge.
  const parts = [...members, { ...schema, allOf: undefined }];

  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }
    const inner = Array.isArray(part.allOf) ? mergeAllOf(part) : part;
    for (const [key, value] of Object.entries(inner)) {
      if (key === "properties" && isRecord(value)) {
        Object.assign(properties, value);
      } else if (key === "required" && Array.isArray(value)) {
        for (const name of value) {
          if (typeof name === "string") {
            required.add(name);
          }
        }
      } else if (key !== "allOf" && value !== undefined) {
        merged[key] = value;
      }
    }
  }

  merged.type ??= "object";
  if (Object.keys(properties).length > 0) {
    merged.properties = properties;
  }
  if (required.size > 0) {
    merged.required = [...required];
  }
  return merged;
};

interface LowerContext {
  ancestors: Set<unknown>;
  depth: number;
}

const refCycle = (schema: Record<string, unknown>): SchemaNode => ({
  kind: "ref-cycle",
  label: asString(schema.title) ?? "Recursive schema",
});

/** Shared title/description metadata pulled off every schema node. */
interface SchemaMeta {
  description?: string;
  title?: string;
}

/** The recursive lowering entrypoint, passed to helpers to avoid forward refs. */
type Recurse = (input: unknown, context?: LowerContext) => SchemaNode;

/** Lower a `oneOf`/`anyOf` schema into a union node, or `null` if neither. */
const lowerUnion = (
  input: Record<string, unknown>,
  child: LowerContext,
  meta: SchemaMeta,
  recurse: Recurse
): SchemaNode | null => {
  for (const variant of ["oneOf", "anyOf"] as const) {
    const options = input[variant];
    if (!Array.isArray(options)) {
      continue;
    }
    const raw = isRecord(input.discriminator) ? input.discriminator : undefined;
    const propertyName = raw ? asString(raw.propertyName) : undefined;
    return {
      description: meta.description,
      discriminator: propertyName
        ? {
            mapping: isRecord(raw?.mapping)
              ? (raw.mapping as Record<string, string>)
              : undefined,
            propertyName,
          }
        : undefined,
      kind: "union",
      options: options.map((option) => recurse(option, child)),
      title: meta.title,
      variant,
    };
  }
  return null;
};

/** Lower an `enum` schema into an enum node. */
const lowerEnum = (
  input: Record<string, unknown>,
  meta: SchemaMeta
): SchemaNode => {
  const { types } = splitType(input.type);
  const rawNames = input["x-enumNames"];
  const names =
    Array.isArray(rawNames) && rawNames.every((n) => typeof n === "string")
      ? (rawNames as string[])
      : undefined;
  return {
    description: meta.description,
    kind: "enum",
    names,
    title: meta.title,
    type: types[0],
    values: input.enum as unknown[],
  };
};

/** Lower an object schema (declared or inferred from `properties`). */
const lowerObject = (
  input: Record<string, unknown>,
  child: LowerContext,
  meta: SchemaMeta,
  recurse: Recurse
): SchemaNode => {
  const properties = isRecord(input.properties) ? input.properties : {};
  const required = new Set(
    Array.isArray(input.required)
      ? input.required.filter((n): n is string => typeof n === "string")
      : []
  );
  let additional: SchemaNode | boolean | undefined;
  if (typeof input.additionalProperties === "boolean") {
    additional = input.additionalProperties;
  } else if (isRecord(input.additionalProperties)) {
    additional = recurse(input.additionalProperties, child);
  }
  return {
    additional,
    description: meta.description,
    kind: "object",
    properties: Object.entries(properties).map(([name, value]) => ({
      deprecated: isRecord(value) ? asBool(value.deprecated) : undefined,
      name,
      required: required.has(name),
      schema: recurse(value, child),
    })),
    title: meta.title,
  };
};

/**
 * Lower one dereferenced JSON Schema node into a {@link SchemaNode}. A finite
 * recursion (the part we own): `allOf` is merged, `oneOf`/`anyOf` become unions,
 * cycles and over-deep nesting stop at `ref-cycle`, and anything exotic degrades
 * to `raw`.
 */
export const lowerSchema = (
  input: unknown,
  context?: LowerContext
): SchemaNode => {
  const ctx = context ?? { ancestors: new Set(), depth: 0 };
  if (!isRecord(input)) {
    return { kind: "raw", schema: input };
  }
  if (ctx.ancestors.has(input) || ctx.depth > MAX_DEPTH) {
    return refCycle(input);
  }

  const meta: SchemaMeta = {
    description: asString(input.description),
    title: asString(input.title),
  };
  const child: LowerContext = {
    ancestors: new Set(ctx.ancestors).add(input),
    depth: ctx.depth + 1,
  };

  // Anything with exotic keywords we don't model degrades to a raw box.
  if (EXOTIC_KEYWORDS.some((keyword) => keyword in input)) {
    return {
      description: meta.description,
      kind: "raw",
      schema: input,
      title: meta.title,
    };
  }
  // Intersection: merge then lower the merged object.
  if (Array.isArray(input.allOf)) {
    return lowerSchema(mergeAllOf(input), ctx);
  }
  const union = lowerUnion(input, child, meta, lowerSchema);
  if (union) {
    return union;
  }
  if (Array.isArray(input.enum)) {
    return lowerEnum(input, meta);
  }

  const { nullable, types } = splitType(input.type);
  const constraints = readConstraints(input);
  if (nullable) {
    constraints.nullable = true;
  }

  if (types.includes("object") || isRecord(input.properties)) {
    return lowerObject(input, child, meta, lowerSchema);
  }
  if (types.includes("array") || "items" in input) {
    return {
      constraints,
      description: meta.description,
      items: lowerSchema(input.items, child),
      kind: "array",
      title: meta.title,
    };
  }
  if (types.length === 1) {
    return {
      constraints,
      description: meta.description,
      format: asString(input.format),
      kind: "primitive",
      title: meta.title,
      type: types[0] ?? "string",
    };
  }
  // Untyped/empty schema (`{}`) — accept anything; or multi-type we don't model.
  if (types.length === 0 && Object.keys(input).length === 0) {
    return { constraints, kind: "primitive", title: meta.title, type: "any" };
  }
  return {
    description: meta.description,
    kind: "raw",
    schema: input,
    title: meta.title,
  };
};

// ---------------------------------------------------------------------------
// Operation + document lowering
// ---------------------------------------------------------------------------

/** Serialize an example value for display (JSON, or pass through a string). */
const serializeExample = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/** Collect `example`/`examples` (and `externalValue`) off a media type object. */
const readExamples = (media: Record<string, unknown>): ApiExample[] => {
  const examples: ApiExample[] = [];
  if (media.example !== undefined) {
    examples.push({ value: serializeExample(media.example) });
  }
  if (isRecord(media.examples)) {
    for (const [name, raw] of Object.entries(media.examples)) {
      if (!isRecord(raw)) {
        continue;
      }
      const external = asString(raw.externalValue);
      examples.push({
        external: external ? true : undefined,
        name,
        summary: asString(raw.summary),
        value: external ?? serializeExample(raw.value),
      });
    }
  }
  return examples;
};

/** Lower a `content` map (request or response body) into media-type variants. */
const lowerContent = (content: unknown): ApiMediaType[] => {
  if (!isRecord(content)) {
    return [];
  }
  return Object.entries(content).map(([mediaType, raw]) => ({
    examples: isRecord(raw) ? readExamples(raw) : [],
    mediaType,
    schema:
      isRecord(raw) && raw.schema !== undefined
        ? lowerSchema(raw.schema)
        : undefined,
  }));
};

const lowerParameters = (raw: unknown): ApiParameter[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const params: ApiParameter[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = asString(entry.name);
    const location = asString(entry.in);
    if (!(name && location)) {
      continue;
    }
    params.push({
      deprecated: asBool(entry.deprecated),
      description: asString(entry.description),
      in: location as ApiParameter["in"],
      name,
      required: location === "path" ? true : (asBool(entry.required) ?? false),
      schema:
        entry.schema === undefined ? undefined : lowerSchema(entry.schema),
    });
  }
  return params;
};

const lowerRequestBody = (raw: unknown): ApiBody | undefined => {
  if (!isRecord(raw)) {
    return;
  }
  return {
    content: lowerContent(raw.content),
    description: asString(raw.description),
    required: asBool(raw.required) ?? false,
  };
};

const lowerResponses = (raw: unknown): ApiResponse[] => {
  if (!isRecord(raw)) {
    return [];
  }
  return Object.entries(raw)
    .filter(([, value]) => isRecord(value))
    .map(([status, value]) => {
      const response = value as Record<string, unknown>;
      return {
        content: lowerContent(response.content),
        description: asString(response.description),
        status,
      };
    });
};

/** Lower `security` requirement arrays into AND-of-schemes / OR-of-requirements. */
const lowerSecurity = (raw: unknown): ApiSecurityRequirement[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(isRecord)
    .map((requirement) => ({
      schemes: Object.entries(requirement).map(([scheme, scopes]) => ({
        scheme,
        scopes: Array.isArray(scopes)
          ? scopes.filter((s): s is string => typeof s === "string")
          : [],
      })),
    }))
    .filter((requirement) => requirement.schemes.length > 0);
};

/** A stable, URL-safe operation id when the spec omits `operationId`. */
export const deriveOperationId = (method: string, path: string): string => {
  const cleaned = path
    .replaceAll(/\{(?<name>[^}]+)\}/gu, "by-$<name>")
    .replaceAll(/[^a-zA-Z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return `${method.toLowerCase()}-${cleaned || "root"}`;
};

const lowerServers = (raw: unknown): ApiServer[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(isRecord)
    .map((server) => ({
      description: asString(server.description),
      url: asString(server.url) ?? "",
    }))
    .filter((server) => server.url !== "");
};

const lowerSecuritySchemes = (raw: unknown): ApiSecurityScheme[] => {
  if (!isRecord(raw)) {
    return [];
  }
  return Object.entries(raw)
    .filter(([, value]) => isRecord(value))
    .map(([name, value]) => {
      const scheme = value as Record<string, unknown>;
      const type = asString(scheme.type) ?? "unknown";
      let detail: string | undefined;
      if (type === "http") {
        detail = asString(scheme.scheme);
      } else if (type === "apiKey") {
        detail =
          `${asString(scheme.in) ?? ""} ${asString(scheme.name) ?? ""}`.trim();
      }
      return {
        description: asString(scheme.description),
        detail,
        flowsSummary: isRecord(scheme.flows)
          ? Object.keys(scheme.flows).join(", ")
          : undefined,
        name,
        type,
      };
    });
};

/** Read `tags` (array of `{name, description}`) into {@link ApiTag}s. */
const lowerTags = (raw: unknown): ApiTag[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(isRecord)
    .map((tag) => ({
      description: asString(tag.description),
      name: asString(tag.name) ?? "",
    }))
    .filter((tag) => tag.name !== "");
};

const lowerTagGroups = (raw: unknown): ApiTagGroup[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(isRecord)
    .map((group) => ({
      name: asString(group.name) ?? "",
      tags: Array.isArray(group.tags)
        ? group.tags.filter((t): t is string => typeof t === "string")
        : [],
    }))
    .filter((group) => group.name !== "" && group.tags.length > 0);
};

/**
 * Lower a dereferenced, up-converted (3.1) document into the {@link ApiReference}
 * IR. Pure data, no rendering. Every operation gets a stable id and a tag; the
 * schema walk inserts `ref-cycle`/`raw` nodes so the result is finite and
 * serializable even when the source had circular references.
 */
export const lowerDocument = (
  document: Record<string, unknown>,
  originalVersion: string
): ApiReference => {
  const info = isRecord(document.info) ? document.info : {};
  const components = isRecord(document.components) ? document.components : {};
  const docSecurity = document.security;
  const paths = isRecord(document.paths) ? document.paths : {};

  const operations: ApiOperation[] = [];
  const seenIds = new Set<string>();

  for (const [path, pathItemRaw] of Object.entries(paths)) {
    if (!isRecord(pathItemRaw)) {
      continue;
    }
    const sharedParameters = pathItemRaw.parameters;
    for (const method of HTTP_METHODS) {
      const operationRaw = pathItemRaw[method];
      if (!isRecord(operationRaw)) {
        continue;
      }

      const tags = Array.isArray(operationRaw.tags)
        ? operationRaw.tags.filter((t): t is string => typeof t === "string")
        : [];

      let id =
        asString(operationRaw.operationId) ?? deriveOperationId(method, path);
      while (seenIds.has(id)) {
        id = `${id}-${method}`;
      }
      seenIds.add(id);

      const parameters = [
        ...lowerParameters(sharedParameters),
        ...lowerParameters(operationRaw.parameters),
      ];

      operations.push({
        deprecated: asBool(operationRaw.deprecated) ?? false,
        description: asString(operationRaw.description),
        examples: [],
        id,
        method: method.toUpperCase(),
        parameters,
        path,
        requestBody: lowerRequestBody(operationRaw.requestBody),
        responses: lowerResponses(operationRaw.responses),
        security:
          operationRaw.security === undefined
            ? lowerSecurity(docSecurity)
            : lowerSecurity(operationRaw.security),
        summary: asString(operationRaw.summary),
        tag: tags[0] ?? "default",
      });
    }
  }

  return {
    info: {
      description: asString(info.description),
      title: asString(info.title) ?? "API Reference",
      version: asString(info.version) ?? "",
    },
    operations,
    originalVersion,
    security: lowerSecuritySchemes(components.securitySchemes),
    servers: lowerServers(document.servers),
    tagGroups: lowerTagGroups(document["x-tagGroups"]),
    tags: lowerTags(document.tags),
  };
};
