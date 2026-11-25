import { parseContent } from "./content-parse";
import type { ParsedContent } from "./content-parse";

export const contentSources = import.meta.glob<string>(
  "../content/{docs,blog,changelog}/**/*.mdx",
  {
    eager: true,
    query: "?raw",
    import: "default",
  },
);
export const contentMetadata = import.meta.glob<string>("../content/docs/**/meta*.json", {
  eager: true,
  query: "?raw",
  import: "default",
});
export const contentKeys = Object.keys(contentSources);
export const loadContent = (path: string): ParsedContent | undefined => {
  const source = contentSources[path];
  return source === undefined ? undefined : parseContent(source);
};
