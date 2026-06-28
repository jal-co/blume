import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "pathe";

import { buildLlmsFiles } from "../src/ai/llms.ts";
import type { BlumeProject } from "../src/core/project-graph.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ProjectContext } from "../src/core/types.ts";
import {
  deriveOperationId,
  lowerDocument,
  lowerSchema,
} from "../src/openapi/ir.ts";
import { buildNativeApi } from "../src/openapi/native.ts";
import { isParsed, parseSpec } from "../src/openapi/parse.ts";
import { buildSearchDocuments } from "../src/search/documents.ts";

// ---------------------------------------------------------------------------
// IR lowering (Layer 2 input)
// ---------------------------------------------------------------------------

describe("openapi lowering", () => {
  it("merges allOf into a single object with combined required", () => {
    const node = lowerSchema({
      allOf: [
        {
          properties: { id: { type: "integer" } },
          required: ["id"],
          type: "object",
        },
        { properties: { bark: { type: "boolean" } }, required: ["bark"] },
      ],
    });
    expect(node.kind).toBe("object");
    if (node.kind === "object") {
      const names = node.properties.map((p) => p.name).toSorted();
      expect(names).toStrictEqual(["bark", "id"]);
      expect(node.properties.every((p) => p.required)).toBe(true);
    }
  });

  it("treats a 3.1 nullable type array as a nullable primitive", () => {
    const node = lowerSchema({ type: ["string", "null"] });
    expect(node.kind).toBe("primitive");
    if (node.kind === "primitive") {
      expect(node.type).toBe("string");
      expect(node.constraints.nullable).toBe(true);
    }
  });

  it("lowers enums with x-enumNames", () => {
    const node = lowerSchema({
      enum: ["a", "b"],
      type: "string",
      "x-enumNames": ["Apple", "Banana"],
    });
    expect(node.kind).toBe("enum");
    if (node.kind === "enum") {
      expect(node.values).toStrictEqual(["a", "b"]);
      expect(node.names).toStrictEqual(["Apple", "Banana"]);
    }
  });

  it("lowers oneOf into a discriminated union", () => {
    const node = lowerSchema({
      discriminator: { propertyName: "kind" },
      oneOf: [{ type: "string" }, { type: "number" }],
    });
    expect(node.kind).toBe("union");
    if (node.kind === "union") {
      expect(node.variant).toBe("oneOf");
      expect(node.options).toHaveLength(2);
      expect(node.discriminator?.propertyName).toBe("kind");
    }
  });

  it("extracts numeric and string constraints", () => {
    const node = lowerSchema({
      maximum: 100,
      minimum: 1,
      multipleOf: 5,
      type: "integer",
    });
    expect(node.kind).toBe("primitive");
    if (node.kind === "primitive") {
      expect(node.constraints.minimum).toBe(1);
      expect(node.constraints.maximum).toBe(100);
      expect(node.constraints.multipleOf).toBe(5);
    }
  });

  it("degrades exotic keywords (patternProperties) to a raw node", () => {
    const node = lowerSchema({
      patternProperties: { "^x-": { type: "string" } },
      type: "object",
    });
    expect(node.kind).toBe("raw");
  });

  it("breaks circular references with a ref-cycle stop (finite IR)", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.properties = { self: cyclic, value: { type: "string" } };
    const node = lowerSchema(cyclic);
    // The whole lowered tree must be JSON-serializable (no cycles survive).
    expect(() => JSON.stringify(node)).not.toThrow();
    const json = JSON.stringify(node);
    expect(json).toContain('"ref-cycle"');
  });

  it("derives a stable operation id from method + path", () => {
    expect(deriveOperationId("GET", "/pets/{petId}")).toBe("get-pets-by-petId");
    expect(deriveOperationId("POST", "/")).toBe("post-root");
  });

  it("lowers a document into operations grouped by tag with security", () => {
    const reference = lowerDocument(
      {
        components: {
          securitySchemes: {
            apiKey: { in: "header", name: "X-Key", type: "apiKey" },
          },
        },
        info: { title: "Demo", version: "2.0.0" },
        paths: {
          "/health": {
            get: { responses: { "200": { description: "ok" } } },
          },
          "/pets": {
            get: {
              operationId: "listPets",
              responses: { "200": { description: "ok" } },
              security: [{ apiKey: [] }],
              summary: "List",
              tags: ["pets"],
            },
            parameters: [
              { in: "query", name: "limit", schema: { type: "integer" } },
            ],
          },
        },
      },
      "3.0.0"
    );
    expect(reference.info.title).toBe("Demo");
    expect(reference.operations).toHaveLength(2);
    const list = reference.operations.find((op) => op.id === "listPets");
    expect(list?.tag).toBe("pets");
    expect(list?.parameters.map((p) => p.name)).toContain("limit");
    expect(list?.security[0]?.schemes[0]?.scheme).toBe("apiKey");
    // An operation without a tag falls back to "default" and a derived id.
    const health = reference.operations.find((op) => op.tag === "default");
    expect(health?.id).toBe("get-health");
    expect(reference.security[0]?.name).toBe("apiKey");
  });
});

// ---------------------------------------------------------------------------
// Layer 1 parse + native integration (local fixtures)
// ---------------------------------------------------------------------------

const SPEC = JSON.stringify({
  components: {
    schemas: {
      Pet: {
        properties: {
          id: { type: "integer" },
          name: { nullable: true, type: "string" },
        },
        required: ["id"],
        title: "Pet",
        type: "object",
      },
    },
  },
  info: { title: "Petstore", version: "1.0.0" },
  openapi: "3.0.0",
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  items: { $ref: "#/components/schemas/Pet" },
                  type: "array",
                },
              },
            },
            description: "A list of pets",
          },
        },
        summary: "List pets",
        tags: ["pets"],
      },
    },
  },
});

describe("openapi parse + native build", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "blume-openapi-"));
    await writeFile(join(root, "openapi.json"), SPEC);
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("parses, up-converts, and dereferences a local spec", async () => {
    const result = await parseSpec("openapi.json", root);
    expect(isParsed(result)).toBe(true);
    if (isParsed(result)) {
      expect(result.originalVersion).toBe("3.0.0");
      expect(result.document.openapi).toBe("3.1.1");
      // $ref resolved: the array items are the inlined Pet object.
      const reference = lowerDocument(result.document, result.originalVersion);
      const items = reference.operations[0]?.responses[0]?.content[0]?.schema;
      expect(items?.kind).toBe("array");
    }
  });

  it("returns a parse error (never throws) for a missing spec", async () => {
    const result = await parseSpec("does-not-exist.yaml", root);
    expect(isParsed(result)).toBe(false);
  });

  it("builds synthetic pages, runtime data, tabs, and a nav group", async () => {
    const config = blumeConfigSchema.parse({
      openapi: { enabled: true, route: "/api", spec: "openapi.json" },
    });
    const build = await buildNativeApi({
      config,
      context: { root } as ProjectContext,
    });

    // One overview + one operation page.
    expect(build.pages).toHaveLength(2);
    const overview = build.pages.find((p) => p.route === "/api");
    const operation = build.pages.find((p) => p.route === "/api/pets/listPets");
    expect(overview?.contentType).toBe("openapi");
    expect(operation?.title).toBe("List pets");
    expect(operation?.body).toContain("GET /pets");

    // Runtime render data is keyed by route.
    expect(build.runtime.pages["/api"]?.kind).toBe("overview");
    expect(build.runtime.pages["/api/pets/listPets"]?.kind).toBe("operation");

    // A header tab and a sidebar group title for the reference.
    expect(build.tabs).toStrictEqual([
      { label: "API Reference", path: "/api" },
    ]);
    expect(build.folderMeta.get("api")?.title).toBe("API Reference");
  });

  it("emits nothing for the scalar renderer (handled by the Scalar embed)", async () => {
    const config = blumeConfigSchema.parse({
      openapi: {
        enabled: true,
        renderer: "scalar",
        spec: "openapi.json",
      },
    });
    const build = await buildNativeApi({
      config,
      context: { root } as ProjectContext,
    });
    expect(build.pages).toStrictEqual([]);
    expect(Object.keys(build.runtime.pages)).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic pages flow into search + llms via their in-memory body
// ---------------------------------------------------------------------------

const syntheticProject = (): BlumeProject =>
  ({
    config: blumeConfigSchema.parse({ title: "Docs" }),
    graph: {
      pages: [
        {
          body: "GET /pets\nList pets\nResponses: 200",
          description: "List pets",
          id: "api/pets/listPets.mdx",
          meta: { draft: false, search: {}, sidebar: {} },
          route: "/api/pets/listPets",
          sourcePath: "",
          title: "List pets",
        },
      ],
    },
    manifest: {
      routes: [
        {
          id: "api/pets/listPets.mdx",
          indexable: true,
          path: "/api/pets/listPets",
          sourcePath: "",
          title: "List pets",
        },
      ],
    },
  }) as unknown as BlumeProject;

describe("synthetic page graph integration", () => {
  it("indexes a synthetic page's body for search (no file read)", async () => {
    const documents = await buildSearchDocuments(syntheticProject());
    expect(documents).toHaveLength(1);
    expect(documents[0]?.route).toBe("/api/pets/listPets");
    expect(documents[0]?.content).toContain("List pets");
  });

  it("includes a synthetic page's body in llms-full.txt", async () => {
    const { index, full } = await buildLlmsFiles(syntheticProject());
    expect(index).toContain("/api/pets/listPets");
    expect(full).toContain("GET /pets");
  });
});
