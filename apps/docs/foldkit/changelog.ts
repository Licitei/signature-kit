import * as stylex from "@stylexjs/stylex";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { ContentNode, ReleaseCover } from "./content";
import { renderContent } from "./content";
import { brandMark } from "./home";
import { prose } from "./styles/prose";
import { sx } from "./styles/sx";
import { tokens } from "./styles/tokens.stylex";

type ChangelogEntry = {
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly date: string;
  readonly nodes: ContentNode[];
  readonly packages?: { readonly [name: string]: { readonly version: string } } | undefined;
  readonly cover?: ReleaseCover | undefined;
};

export const groupReleases = <Entry extends ChangelogEntry>(entries: ReadonlyArray<Entry>) => {
  const releases: { id: string; date: string; entries: Entry[] }[] = [];
  for (const entry of entries) {
    const id = entry.date.slice(0, 10);
    const current = releases.at(-1);
    if (current !== undefined && current.id === id) current.entries.push(entry);
    else releases.push({ id, date: entry.date, entries: [entry] });
  }
  return releases.map((release) => {
    const packages = new Map<string, string>();
    for (const entry of release.entries)
      for (const [name, info] of Object.entries(entry.packages ?? {}))
        packages.set(name.replace("@signature-kit/", ""), info.version);
    return { ...release, packages: [...packages] };
  });
};

const backgrounds = stylex.create({
  bg0: { backgroundImage: "url(/landing/release-bg-0.webp)" },
  bg1: { backgroundImage: "url(/landing/release-bg-1.webp)" },
  bg2: { backgroundImage: "url(/landing/release-bg-2.webp)" },
  bg3: { backgroundImage: "url(/landing/release-bg-3.webp)" },
  bg4: { backgroundImage: "url(/landing/release-bg-4.webp)" },
  bg5: { backgroundImage: "url(/landing/release-bg-5.webp)" },
});
const backgroundList = [
  backgrounds.bg0,
  backgrounds.bg1,
  backgrounds.bg2,
  backgrounds.bg3,
  backgrounds.bg4,
  backgrounds.bg5,
];

const styles = stylex.create({
  cover: {
    position: "relative",
    containerType: "inline-size",
    aspectRatio: "16 / 9",
    overflow: "hidden",
    marginBottom: "36px",
    borderRadius: "20px",
    backgroundColor: "#071820",
    backgroundPosition: "center",
    backgroundSize: "cover",
    backgroundRepeat: "no-repeat",
    imageRendering: "pixelated",
    color: "#ffffff",
  },
  top: {
    position: "absolute",
    top: "5cqw",
    left: "5.5cqw",
    right: "5.5cqw",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: "1cqw",
    fontSize: "2.1cqw",
    fontWeight: 600,
    letterSpacing: "-0.02em",
  },
  chip: {
    padding: "0.5cqw 1.2cqw",
    borderRadius: "999px",
    backgroundColor: "rgba(7, 24, 32, 0.7)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.16)",
    fontFamily: tokens.mono,
    fontSize: "1.45cqw",
    color: "rgba(255, 255, 255, 0.82)",
  },
  caption: {
    position: "absolute",
    left: "5.5cqw",
    bottom: "4.5cqw",
    margin: 0,
    padding: "0.4cqw 1cqw",
    borderRadius: "0.6cqw",
    backgroundColor: "rgba(7, 24, 32, 0.72)",
    fontFamily: tokens.mono,
    fontSize: "1.45cqw",
    color: "rgba(255, 255, 255, 0.72)",
  },
  stage: {
    position: "absolute",
    top: "12cqw",
    bottom: "10cqw",
    left: "5.5cqw",
    right: "5.5cqw",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "2.4cqw",
  },
  card: {
    borderRadius: "1.2cqw",
    backgroundColor: "rgba(7, 22, 29, 0.94)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.13)",
    boxShadow: "0 2.4cqw 6cqw -2cqw rgba(0, 0, 0, 0.65)",
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    gap: "1cqw",
    padding: "1.3cqw 2cqw",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: "rgba(255, 255, 255, 0.09)",
    fontFamily: tokens.mono,
    fontSize: "1.5cqw",
    color: "rgba(255, 255, 255, 0.55)",
  },
  headDot: {
    width: "0.9cqw",
    height: "0.9cqw",
    borderRadius: "0.2cqw",
    backgroundColor: tokens.accent,
  },
  code: {
    padding: "1.4cqw 2.2cqw",
    fontFamily: tokens.mono,
    fontSize: "1.75cqw",
    whiteSpace: "nowrap",
    color: "#e7eef2",
  },
  spans: {
    width: "78cqw",
  },
  spanRows: {
    display: "grid",
    gap: "1.1cqw",
    padding: "2cqw",
  },
  spanRow: {
    display: "grid",
    gridTemplateColumns: "24cqw 1fr",
    alignItems: "center",
    gap: "1.6cqw",
    fontFamily: tokens.mono,
    fontSize: "1.55cqw",
    color: "rgba(255, 255, 255, 0.72)",
  },
  track: {
    position: "relative",
    height: "1.9cqw",
    borderRadius: "0.4cqw",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  bar: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderRadius: "0.4cqw",
    backgroundColor: "#5b93ad",
  },
  barRoot: {
    backgroundColor: "rgba(91, 147, 173, 0.45)",
  },
  barHot: {
    backgroundColor: tokens.accent,
  },
  pages: {
    display: "flex",
    gap: "1.3cqw",
  },
  page: {
    position: "relative",
    width: "5.4cqw",
    height: "7.4cqw",
    borderRadius: "0.5cqw",
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  pageOn: {
    backgroundColor: "#f4f1ea",
    borderColor: "#f4f1ea",
    boxShadow: `0 0 0 0.35cqw ${tokens.accent}`,
    transform: "translateY(-1cqw)",
  },
  pageLines: {
    position: "absolute",
    inset: "1cqw 0.9cqw",
    display: "grid",
    alignContent: "start",
    gap: "0.55cqw",
  },
  pageLine: {
    height: "0.35cqw",
    borderRadius: "0.2cqw",
    backgroundColor: "rgba(13, 26, 32, 0.25)",
  },
  pageIndex: {
    position: "absolute",
    bottom: "-2.8cqw",
    left: 0,
    right: 0,
    textAlign: "center",
    fontFamily: tokens.mono,
    fontSize: "1.3cqw",
    color: tokens.accent,
  },
  metric: {
    display: "grid",
    justifyItems: "center",
    gap: "1.2cqw",
    padding: "3cqw 6cqw",
  },
  metricBefore: {
    fontFamily: tokens.mono,
    fontSize: "2.2cqw",
    color: "rgba(255, 255, 255, 0.45)",
    textDecoration: "line-through",
  },
  metricAfter: {
    fontSize: "8cqw",
    fontWeight: 600,
    lineHeight: 1,
    letterSpacing: "-0.05em",
  },
  delta: {
    padding: "0.5cqw 1.4cqw",
    borderRadius: "999px",
    backgroundColor: tokens.accent,
    fontSize: "2cqw",
    fontWeight: 600,
  },
  anchorRow: {
    display: "flex",
    alignItems: "center",
    gap: "4cqw",
  },
  paper: {
    position: "relative",
    width: "26cqw",
    height: "33cqw",
    padding: "2.4cqw 2.2cqw",
    borderRadius: "0.6cqw",
    backgroundColor: "#f4f1ea",
    boxShadow: "0 2.4cqw 6cqw -2cqw rgba(0, 0, 0, 0.7)",
    display: "grid",
    alignContent: "start",
    gap: "1cqw",
  },
  paperLine: {
    height: "0.55cqw",
    borderRadius: "0.3cqw",
    backgroundColor: "rgba(13, 26, 32, 0.16)",
  },
  link: {
    position: "absolute",
    left: "4cqw",
    right: "7cqw",
    bottom: "6cqw",
    height: "6cqw",
    borderWidth: "0.25cqw",
    borderStyle: "dashed",
    borderColor: "#0B5275",
    borderRadius: "0.4cqw",
  },
  stamp: {
    position: "absolute",
    left: "4cqw",
    right: "7cqw",
    bottom: "6cqw",
    height: "6cqw",
    display: "flex",
    alignItems: "center",
    gap: "1cqw",
    padding: "0 1.2cqw",
    borderWidth: "0.25cqw",
    borderStyle: "solid",
    borderColor: tokens.accent,
    borderRadius: "0.4cqw",
    backgroundColor: "rgba(255, 241, 232, 0.92)",
    color: "#0B5275",
    transform: "translate(1.2cqw, -1cqw)",
  },
  stampMark: {
    width: "6cqw",
    height: "3.8cqw",
  },
  stampText: {
    display: "grid",
    gap: "0.5cqw",
    flex: 1,
  },
  stampLine: {
    height: "0.45cqw",
    borderRadius: "0.3cqw",
    backgroundColor: "rgba(11, 82, 117, 0.45)",
  },
  states: {
    display: "flex",
    alignItems: "center",
    gap: "1.6cqw",
  },
  state: {
    padding: "1.3cqw 2.6cqw",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.22)",
    backgroundColor: "rgba(7, 22, 29, 0.9)",
    fontFamily: tokens.mono,
    fontSize: "2.2cqw",
    color: "rgba(255, 255, 255, 0.75)",
  },
  stateFinal: {
    borderColor: tokens.accent,
    backgroundColor: tokens.accent,
    color: "#ffffff",
  },
  arrow: {
    width: "5cqw",
    height: "1px",
    backgroundColor: "rgba(255, 255, 255, 0.4)",
  },
  hex: {
    display: "grid",
    gridTemplateColumns: "repeat(10, 4.6cqw)",
    gap: "0.7cqw",
    padding: "2.2cqw",
  },
  byte: {
    padding: "0.8cqw 0",
    borderRadius: "0.45cqw",
    textAlign: "center",
    fontFamily: tokens.mono,
    fontSize: "1.9cqw",
    color: "rgba(255, 255, 255, 0.62)",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  byteOn: {
    color: "#ffffff",
    backgroundColor: tokens.accent,
  },
  rows: {
    display: "grid",
    gap: "1.2cqw",
    width: "64cqw",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "1.6cqw",
    padding: "1.6cqw 2.2cqw",
    fontSize: "1.9cqw",
    color: "rgba(255, 255, 255, 0.86)",
  },
  rowOn: {
    borderColor: "#5b93ad",
    color: "#ffffff",
  },
  dot: {
    flexShrink: 0,
    width: "1.2cqw",
    height: "1.2cqw",
    borderRadius: "0.25cqw",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255, 255, 255, 0.5)",
  },
  dotOn: {
    borderColor: tokens.accent,
    backgroundColor: tokens.accent,
  },
  entry: {
    marginTop: "40px",
  },
  entryFirst: {
    marginTop: 0,
  },
});

const backgroundFor = (id: string) =>
  backgroundList[Number(id.replaceAll("-", "")) % backgroundList.length] ?? null;

const paperLines = [92, 100, 84, 96, 70, 0, 88, 100, 62].map((width, line) => ({
  id: `line-${String(line)}`,
  width,
}));

type Release = ReturnType<typeof groupReleases<ChangelogEntry>>[number];

const codeCard = <Message>(h: HtmlBuilder<Message>, file: string, code: string) =>
  h.div(
    [...sx(h, styles.card)],
    [
      h.div([...sx(h, styles.cardHead)], [h.span([...sx(h, styles.headDot)]), file]),
      h.div([...sx(h, styles.code)], [code]),
    ],
  );

const stage = <Message>(
  h: HtmlBuilder<Message>,
  cover: ReleaseCover | undefined,
  release: Release,
) => {
  if (cover === undefined)
    return [
      h.div(
        [...sx(h, styles.rows)],
        release.entries
          .slice(0, 3)
          .map((entry, index) =>
            h.keyed("div")(
              entry.slug,
              [...sx(h, styles.card, styles.row, index === 0 && styles.rowOn)],
              [h.span([...sx(h, styles.dot, index === 0 && styles.dotOn)]), entry.title],
            ),
          ),
      ),
    ];
  switch (cover.kind) {
    case "spans":
      return [
        h.div(
          [...sx(h, styles.card, styles.spans)],
          [
            h.div([...sx(h, styles.cardHead)], [h.span([...sx(h, styles.headDot)]), "trace"]),
            h.div(
              [...sx(h, styles.spanRows)],
              cover.spans.map((span, index) =>
                h.keyed("div")(
                  span.name,
                  [...sx(h, styles.spanRow)],
                  [
                    span.name,
                    h.span(
                      [...sx(h, styles.track)],
                      [
                        h.span([
                          ...sx(
                            h,
                            styles.bar,
                            index === 0 && styles.barRoot,
                            span.name.endsWith(".run") && styles.barHot,
                          ),
                          h.Style({ left: `${span.start}%`, width: `${span.width}%` }),
                        ]),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ];
    case "pages":
      return [
        h.div(
          [...sx(h, styles.pages)],
          Array.from({ length: cover.total }, (_, index) =>
            h.keyed("span")(
              String(index),
              [...sx(h, styles.page, cover.selected.includes(index) && styles.pageOn)],
              [
                h.span(
                  [...sx(h, styles.pageLines)],
                  [0, 1, 2, 3].map((line) =>
                    h.keyed("span")(String(line), [...sx(h, styles.pageLine)]),
                  ),
                ),
                ...(cover.selected.includes(index)
                  ? [h.span([...sx(h, styles.pageIndex)], [String(index)])]
                  : []),
              ],
            ),
          ),
        ),
        h.div([h.Style({ marginTop: "3cqw" })], [codeCard(h, "extract.ts", cover.code)]),
      ];
    case "metric":
      return [
        h.div(
          [...sx(h, styles.card, styles.metric)],
          [
            h.span([...sx(h, styles.metricBefore)], [cover.before]),
            h.span([...sx(h, styles.metricAfter)], [cover.after]),
            h.span([...sx(h, styles.delta)], [cover.delta]),
          ],
        ),
      ];
    case "anchor":
      return [
        h.div(
          [...sx(h, styles.anchorRow)],
          [
            h.div(
              [...sx(h, styles.paper)],
              [
                ...paperLines.map((line) =>
                  h.keyed("span")(line.id, [
                    ...sx(h, styles.paperLine),
                    h.Style({ width: `${line.width}%`, opacity: line.width === 0 ? "0" : "1" }),
                  ]),
                ),
                h.span([...sx(h, styles.link)]),
                h.span(
                  [...sx(h, styles.stamp)],
                  [
                    h.svg(
                      [h.ViewBox("0 0 34 22"), ...sx(h, styles.stampMark)],
                      [
                        h.path([
                          h.D("M2 15c3 0 4-10 7-10s-2 12 2 12 3-8 6-8-1 6 2 6 3-4 6-4 2 2 4 2"),
                          h.Fill("none"),
                          h.Stroke("currentColor"),
                          h.StrokeWidth("2.2"),
                          h.StrokeLinecap("round"),
                        ]),
                      ],
                    ),
                    h.span(
                      [...sx(h, styles.stampText)],
                      [h.span([...sx(h, styles.stampLine)]), h.span([...sx(h, styles.stampLine)])],
                    ),
                  ],
                ),
              ],
            ),
            codeCard(h, "anchors.ts", cover.code),
          ],
        ),
      ];
    case "states":
      return [
        h.div(
          [...sx(h, styles.states)],
          cover.states.flatMap((state, index) => [
            ...(index > 0 ? [h.keyed("span")(`arrow-${state}`, [...sx(h, styles.arrow)])] : []),
            h.keyed("span")(
              state,
              [...sx(h, styles.state, index === cover.states.length - 1 && styles.stateFinal)],
              [state],
            ),
          ]),
        ),
        codeCard(h, "wait.ts", cover.code),
      ];
    case "bytes": {
      const bytes = cover.bytes
        .split(" ")
        .map((value, position) => ({ id: `byte-${String(position)}`, value, position }));
      return [
        h.div(
          [...sx(h, styles.card)],
          [
            h.div(
              [...sx(h, styles.cardHead)],
              [h.span([...sx(h, styles.headDot)]), "signature.p7s"],
            ),
            h.div(
              [...sx(h, styles.hex)],
              bytes.map((byte) =>
                h.keyed("span")(
                  byte.id,
                  [
                    ...sx(
                      h,
                      styles.byte,
                      byte.position >= cover.highlight[0] &&
                        byte.position < cover.highlight[1] &&
                        styles.byteOn,
                    ),
                  ],
                  [byte.value],
                ),
              ),
            ),
          ],
        ),
        codeCard(h, "buffers.ts", cover.code),
      ];
    }
  }
};

const cover = <Message>(h: HtmlBuilder<Message>, release: Release): Html => {
  const featured = release.entries.find((entry) => entry.cover !== undefined) ?? release.entries[0];
  const declared = featured?.cover;
  const packages = Object.entries(featured?.packages ?? {});
  const [featuredPackage] =
    declared?.package !== undefined
      ? packages.filter(([name]) => name === `@signature-kit/${declared.package}`)
      : packages;
  const chip =
    featuredPackage !== undefined
      ? `${featuredPackage[0].replace("@signature-kit/", "")} ${featuredPackage[1].version}`
      : release.packages[0] !== undefined
        ? `${release.packages[0][0]} ${release.packages[0][1]}`
        : undefined;
  return h.div(
    [...sx(h, "release-cover", styles.cover, backgroundFor(release.id)), h.AriaHidden(true)],
    [
      h.div(
        [...sx(h, styles.top)],
        [
          h.span([...sx(h, styles.brand)], [brandMark(h), "SignatureKit"]),
          ...(chip !== undefined ? [h.span([...sx(h, styles.chip)], [chip])] : []),
        ],
      ),
      h.div([...sx(h, styles.stage)], stage(h, declared, release)),
      ...(declared !== undefined ? [h.p([...sx(h, styles.caption)], [declared.caption])] : []),
    ],
  );
};

export const releaseView = <Message>(
  h: HtmlBuilder<Message>,
  input: {
    release: ReturnType<typeof groupReleases<ChangelogEntry>>[number];
    formatDate: (value: string) => string;
    linkTitles: boolean;
  },
): Html =>
  h.keyed("article")(
    input.release.id,
    [...sx(h, prose.release), h.Id(input.release.id)],
    [
      h.div(
        [...sx(h, prose.releaseMeta)],
        [
          h.p(
            [...sx(h, prose.releaseDate)],
            [
              new Date(input.release.date)
                .toLocaleDateString("pt-BR", { day: "numeric", month: "short", timeZone: "UTC" })
                .replace(".", ""),
            ],
          ),
          h.p(
            [...sx(h, prose.releaseYear)],
            [
              `${input.release.date.slice(0, 4)} · ${
                input.release.entries.length === 1
                  ? "1 novidade"
                  : `${String(input.release.entries.length)} novidades`
              }`,
            ],
          ),
          h.ul(
            [
              ...sx(h, prose.releasePackages),
              h.Title(
                input.release.packages.map(([name, version]) => `${name} ${version}`).join("\n"),
              ),
            ],
            [
              ...input.release.packages
                .slice(0, 3)
                .map(([name, version]) =>
                  h.keyed("li")(
                    name,
                    [...sx(h, prose.releasePackage)],
                    [h.span([], [name]), h.span([...sx(h, prose.releaseVersion)], [version])],
                  ),
                ),
              ...(input.release.packages.length > 3
                ? [
                    h.li(
                      [...sx(h, prose.releaseMore)],
                      [`+${String(input.release.packages.length - 3)} pacotes`],
                    ),
                  ]
                : []),
            ],
          ),
        ],
      ),
      h.div(
        [],
        [
          cover(h, input.release),
          ...input.release.entries.map((entry, index) =>
            h.keyed("section")(
              entry.slug,
              [...sx(h, styles.entry, index === 0 && styles.entryFirst), h.Id(entry.slug)],
              [
                h.h2(
                  [...sx(h, prose.releaseTitle)],
                  [
                    input.linkTitles
                      ? h.a([...sx(h, prose.releaseTitleLink), h.Href(entry.href)], [entry.title])
                      : entry.title,
                  ],
                ),
                h.div(
                  [...sx(h, prose.releaseBody)],
                  renderContent(
                    entry.nodes.filter(
                      (node, nodeIndex) => !(nodeIndex === 0 && node.type === "heading"),
                    ),
                    h,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    ],
  );
