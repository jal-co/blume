import { readFile } from "node:fs/promises";

import type { BlumeProject } from "../core/project-graph.ts";

/**
 * Map every route to its raw source Markdown. Powers the `<route>.md` and
 * `<route>.mdx` endpoints, which serve the original source so AI tools — and
 * readers — can fetch any page as plain Markdown.
 */
export const buildRawMarkdown = async (
  project: BlumeProject
): Promise<Record<string, string>> => {
  const bodyById = new Map(
    project.graph.pages.map((page) => [page.id, page.body])
  );
  const entries = await Promise.all(
    project.manifest.routes.map(async (route) => {
      // Synthetic pages (native OpenAPI operations) serve their in-memory body;
      // file-backed pages serve their source verbatim.
      const body = bodyById.get(route.id);
      return [
        route.path,
        body === undefined ? await readFile(route.sourcePath, "utf-8") : body,
      ] as const;
    })
  );
  return Object.fromEntries(entries);
};
