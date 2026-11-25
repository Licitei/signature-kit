import { Option, Schema, pipe } from "effect";
import * as Url from "foldkit/url";
import * as Route from "foldkit/route";

const Home = Schema.TaggedStruct("Home", {});
const Page = Schema.TaggedStruct("Page", { path: Schema.String });
export const homeRoute = pipe(Route.root, Route.mapTo(Home));
export const pageRoute = pipe(Route.restString("path"), Route.mapTo(Page));
export const publicRoutes = Route.oneOf(homeRoute, pageRoute);

const NotFound = Schema.TaggedStruct("NotFound", { path: Schema.String });
const parseUrl = Route.parseUrlWithFallback(publicRoutes, NotFound);
export const parsePublicUrl = (input: string) => {
  const parsed = Url.fromString(input);
  if (Option.isNone(parsed)) return undefined;
  const route = parseUrl(parsed.value);
  if (route._tag === "NotFound") return undefined;
  const path = route._tag === "Home" ? homeRoute(route) : pageRoute(route);
  return path === parsed.value.pathname ? route : undefined;
};

export const legacyLocaleRedirect = (pathname: string) => {
  const match = /^\/(?:en-US|pt-BR)(\/.*)?$/.exec(pathname);
  if (match === null) return undefined;
  const rest = match[1] ?? "/";
  return rest === "/sign-free" ? "/assine-documentos-gratis" : rest;
};
