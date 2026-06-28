import type { FolderMeta, ResolvedConfig } from "../core/schema.ts";
import { pageMetaSchema } from "../core/schema.ts";
import type {
  Diagnostic,
  Heading,
  NavTab,
  PageRecord,
  ProjectContext,
} from "../core/types.ts";
import { operationHeadings, slugifyHeading } from "./display.ts";
import type { OpenApiPageEntry, OpenApiRuntime, OpSummary } from "./display.ts";
import type { ApiOperation, ApiReference, SchemaNode } from "./ir.ts";
import { lowerDocument } from "./ir.ts";
import { isParsed, parseSpec } from "./parse.ts";

/**
 * The build-time integration for the native OpenAPI renderer. Resolves enabled
 * sources, runs Layer 1 (parse/deref/up-convert) + the IR lowering, and emits:
 *
 * - **synthetic {@link PageRecord}s** (one overview + one per operation) that are
 *   injected into the content graph, so operations rejoin routing, the sidebar,
 *   search, llms.txt, sitemap, and per-operation SEO/OG with no special cases;
 * - the **runtime data** ({@link OpenApiRuntime}) the catch-all page renders from;
 * - synthetic **folder meta** (nice sidebar group titles/ordering) and **nav tabs**.
 *
 * The actual visual render walk lives in the shipped `components/openapi/*.astro`
 * components — this module never produces markup, only data.
 */

const TRAILING_SLASH = /\/+$/u;
const ROUTE_EDGES = /^\/+|\/+$/gu;
const NON_SLUG = /[^a-z0-9]+/giu;
const SLUG_EDGES = /^-+|-+$/gu;

/** Normalize a configured route to a single leading slash, no trailing slash. */
const normalizeRoute = (route: string): string => {
  const trimmed = route.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const noTrailing = withSlash.replace(TRAILING_SLASH, "");
  return noTrailing === "" ? "/" : noTrailing;
};

/** A URL-safe slug that preserves case (nicer operation/tag URLs). */
const slugSegment = (text: string): string =>
  text.replace(NON_SLUG, "-").replace(SLUG_EDGES, "") || "item";

/** A native source resolved to its base route and label. */
interface NativeSource {
  label: string;
  route: string;
  spec: string;
}

/** Resolve the enabled native OpenAPI sources to base routes + labels. */
const resolveNativeSources = (config: ResolvedConfig): NativeSource[] => {
  const block = config.openapi;
  if (!block.enabled || block.renderer !== "native") {
    return [];
  }
  const sources = [...block.sources];
  if (block.spec) {
    sources.unshift({ spec: block.spec });
  }
  const base = normalizeRoute(block.route);

  return sources.map((source, index) => {
    const label =
      source.label ??
      (sources.length > 1 ? `API Reference ${index + 1}` : "API Reference");
    let route: string;
    if (source.route) {
      route = normalizeRoute(source.route);
    } else if (sources.length === 1) {
      route = base;
    } else {
      route = normalizeRoute(`${base}/${index + 1}`);
    }
    return { label, route, spec: source.spec };
  });
};

/**
 * The ordered tag list for a reference: `x-tagGroups` order first, then declared
 * `tags` order, then any remaining tags seen on operations (alphabetical). Drives
 * sidebar group ordering and the overview layout.
 */
const orderedTags = (reference: ApiReference): string[] => {
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (tag: string): void => {
    if (!seen.has(tag)) {
      seen.add(tag);
      order.push(tag);
    }
  };
  for (const group of reference.tagGroups) {
    for (const tag of group.tags) {
      add(tag);
    }
  }
  for (const tag of reference.tags) {
    add(tag.name);
  }
  for (const tag of [
    ...new Set(reference.operations.map((op) => op.tag)),
  ].toSorted()) {
    add(tag);
  }
  return order;
};

/** Shallow field-name harvest for the search/llms text of an operation. */
const fieldNames = (schema: SchemaNode | undefined): string[] => {
  if (!schema) {
    return [];
  }
  if (schema.kind === "object") {
    return schema.properties.map((property) => property.name);
  }
  if (schema.kind === "array") {
    return fieldNames(schema.items);
  }
  if (schema.kind === "union") {
    return schema.options.flatMap(fieldNames);
  }
  return [];
};

/** Plain-text body for an operation page (search index + llms corpus). */
const operationText = (operation: ApiOperation): string => {
  const lines = [`${operation.method} ${operation.path}`];
  if (operation.summary) {
    lines.push(operation.summary);
  }
  if (operation.description) {
    lines.push(operation.description);
  }
  const params = operation.parameters.map((parameter) => parameter.name);
  if (params.length > 0) {
    lines.push(`Parameters: ${params.join(", ")}`);
  }
  const requestFields = operation.requestBody?.content.flatMap((media) =>
    fieldNames(media.schema)
  );
  if (requestFields && requestFields.length > 0) {
    lines.push(`Request fields: ${[...new Set(requestFields)].join(", ")}`);
  }
  const statuses = operation.responses.map((response) => response.status);
  if (statuses.length > 0) {
    lines.push(`Responses: ${statuses.join(", ")}`);
  }
  const responseFields = operation.responses.flatMap((response) =>
    response.content.flatMap((media) => fieldNames(media.schema))
  );
  if (responseFields.length > 0) {
    lines.push(`Response fields: ${[...new Set(responseFields)].join(", ")}`);
  }
  return lines.join("\n");
};

/** Plain-text body for the overview page. */
const overviewText = (reference: ApiReference): string => {
  const lines = [`${reference.info.title} ${reference.info.version}`.trim()];
  if (reference.info.description) {
    lines.push(reference.info.description);
  }
  for (const operation of reference.operations) {
    lines.push(
      `${operation.method} ${operation.path}${operation.summary ? ` — ${operation.summary}` : ""}`
    );
  }
  return lines.join("\n");
};

/** A synthetic page record (no file on disk; body served from memory). */
const syntheticPage = (input: {
  body: string;
  description?: string;
  headings: Heading[];
  id: string;
  route: string;
  title: string;
}): PageRecord => ({
  body: input.body,
  contentType: "openapi",
  description: input.description,
  format: "mdx",
  groups: [],
  headings: input.headings,
  id: input.id,
  links: [],
  meta: pageMetaSchema.parse({
    description: input.description,
    title: input.title,
    type: "openapi",
  }),
  route: input.route,
  segments: input.route.replace(ROUTE_EDGES, "").split("/").filter(Boolean),
  sourcePath: "",
  title: input.title,
});

/** The fully built integration output for all native references. */
export interface NativeApiBuild {
  diagnostics: Diagnostic[];
  /** Synthetic folder meta for nice sidebar group titles/order. */
  folderMeta: Map<string, FolderMeta>;
  /** Synthetic page records to inject into the content graph. */
  pages: PageRecord[];
  /** The runtime render data, written to `generated/openapi.json`. */
  runtime: OpenApiRuntime;
  /** Header nav tabs for each reference overview. */
  tabs: NavTab[];
  warnings: string[];
}

/**
 * Module-level cache so the dev server doesn't re-fetch/re-parse a (often remote)
 * spec on every content change. Keyed by the spec string; cleared on process
 * restart, which is when a changed local spec is picked up.
 */
const cache = new Map<string, ApiReference>();

const buildOne = async (
  source: NativeSource,
  root: string,
  playground: boolean,
  output: NativeApiBuild
): Promise<void> => {
  let reference = cache.get(source.spec);
  if (!reference) {
    const parsed = await parseSpec(source.spec, root);
    if (!isParsed(parsed)) {
      output.warnings.push(parsed.error);
      return;
    }
    for (const warning of parsed.warnings) {
      output.warnings.push(`API spec "${source.spec}": ${warning}`);
    }
    reference = lowerDocument(parsed.document, parsed.originalVersion);
    cache.set(source.spec, reference);
  }

  const base = normalizeRoute(source.route);
  const baseId = base.replace(ROUTE_EDGES, "") || "reference";
  const tags = orderedTags(reference);
  const tagOrder = new Map(tags.map((tag, index) => [tag, index]));

  // Nice sidebar labels: the reference label as the top group title.
  output.folderMeta.set(baseId, { title: source.label });

  const overviewSummaries: OpSummary[] = [];

  for (const operation of reference.operations) {
    const tagSlug = slugSegment(operation.tag);
    const opSlug = slugSegment(operation.id);
    const route = `${base === "/" ? "" : base}/${tagSlug}/${opSlug}`;
    const id = `${baseId}/${tagSlug}/${opSlug}.mdx`;
    const title = operation.summary ?? `${operation.method} ${operation.path}`;
    const headings = operationHeadings(operation);

    output.runtime.pages[route] = {
      description: operation.description ?? operation.summary,
      headings,
      kind: "operation",
      operation,
      playground,
      servers: reference.servers,
      title,
    };
    output.pages.push(
      syntheticPage({
        body: operationText(operation),
        description: operation.description ?? operation.summary,
        headings,
        id,
        route,
        title,
      })
    );
    overviewSummaries.push({
      deprecated: operation.deprecated,
      method: operation.method,
      path: operation.path,
      route,
      summary: operation.summary,
      tag: operation.tag,
    });

    // Order tag groups by the resolved tag order; leave titles to humanization.
    const tagGroupPath = `${baseId}/${tagSlug}`;
    if (!output.folderMeta.has(tagGroupPath)) {
      output.folderMeta.set(tagGroupPath, {
        order: tagOrder.get(operation.tag) ?? tags.length,
      });
    }
  }

  // Overview page at the base route.
  const overviewHeadings: Heading[] = tags
    .filter((tag) => overviewSummaries.some((summary) => summary.tag === tag))
    .map((tag) => ({ depth: 2, slug: slugifyHeading(tag), text: tag }));

  const overview: OpenApiPageEntry = {
    description: reference.info.description,
    headings: overviewHeadings,
    info: reference.info,
    kind: "overview",
    operations: overviewSummaries,
    originalVersion: reference.originalVersion,
    playground,
    security: reference.security,
    servers: reference.servers,
    tagGroups: reference.tagGroups,
    tags: reference.tags,
    title: source.label,
  };
  output.runtime.pages[base] = overview;
  output.pages.push(
    syntheticPage({
      body: overviewText(reference),
      description: reference.info.description,
      headings: overviewHeadings,
      id: `${baseId}/index.mdx`,
      route: base,
      title: source.label,
    })
  );

  output.runtime.tabs.push({ label: source.label, path: base });
};

/**
 * Build every enabled native OpenAPI reference. Network/parse failures degrade
 * to warnings (the reference is skipped), never throwing — so one bad spec can't
 * break the whole build.
 */
export const buildNativeApi = async (options: {
  config: ResolvedConfig;
  context: ProjectContext;
}): Promise<NativeApiBuild> => {
  const output: NativeApiBuild = {
    diagnostics: [],
    folderMeta: new Map(),
    pages: [],
    runtime: { pages: {}, tabs: [] },
    tabs: [],
    warnings: [],
  };

  const sources = resolveNativeSources(options.config);
  const { playground } = options.config.openapi;
  // Serialize source builds (they're cached and usually one); keeps page/tab
  // order deterministic and avoids hammering a remote host with parallel fetches.
  for (const source of sources) {
    // eslint-disable-next-line no-await-in-loop
    await buildOne(source, options.context.root, playground, output);
  }
  output.tabs = output.runtime.tabs;
  return output;
};
