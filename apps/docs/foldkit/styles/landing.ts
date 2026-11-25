import * as stylex from "@stylexjs/stylex";
import { tokens } from "./tokens.stylex";

const desktop = "@media (min-width: 960px)";
const phone = "@media (max-width: 640px)";

export const landing = stylex.create({
  brandMark: {
    width: "22px",
    height: "22px",
    flexShrink: 0,
  },
  markDisc: {
    fill: tokens.fg,
  },
  markCheck: {
    fill: "none",
    stroke: tokens.bg,
    strokeWidth: 2.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  hero: {
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr) auto",
    minHeight: { default: "auto", [desktop]: "calc(100svh - 64px)" },
    maxWidth: "1440px",
    marginInline: "auto",
    paddingInline: "24px",
  },
  heroGrid: {
    display: "grid",
    alignItems: "center",
    justifyItems: { default: "center", [desktop]: "stretch" },
    gap: { default: "32px", [desktop]: "24px" },
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [desktop]: "minmax(0, 1fr) auto minmax(0, 1fr)",
    },
    paddingBlock: { default: "56px 40px", [desktop]: "48px" },
    textAlign: { default: "center", [desktop]: "left" },
  },
  heroCopy: {
    display: "grid",
    justifyItems: { default: "center", [desktop]: "start" },
    width: "100%",
  },
  title: {
    margin: 0,
    maxWidth: "10ch",
    fontSize: "clamp(3rem, 5.4vw, 4.75rem)",
    lineHeight: 1,
    letterSpacing: "-0.055em",
    fontWeight: 500,
  },
  actions: {
    display: "flex",
    flexDirection: { default: "row", [phone]: "column" },
    alignItems: "center",
    gap: "12px",
    width: { default: "auto", [phone]: "100%" },
    marginTop: "32px",
  },
  wide: {
    width: { default: "auto", [phone]: "100%" },
  },
  visual: {
    order: { default: -1, [desktop]: 0 },
    display: "grid",
    placeItems: "center",
    width: "clamp(220px, 28vw, 400px)",
    aspectRatio: "1",
    borderRadius: "999px",
    backgroundImage: `radial-gradient(closest-side, ${tokens.halo}, transparent)`,
  },
  seal: {
    width: "72%",
    height: "auto",
    overflow: "visible",
    filter: `drop-shadow(0 28px 40px ${tokens.sealShadow})`,
  },
  sealRing: {
    fill: tokens.bgElevated,
    stroke: tokens.fg,
    strokeWidth: 1.5,
  },
  sealDash: {
    fill: "none",
    stroke: tokens.faint,
    strokeWidth: 2,
    strokeDasharray: "0.5 7",
    strokeLinecap: "round",
  },
  sealText: {
    fill: tokens.fg,
    fontFamily: tokens.mono,
    fontSize: "11.5px",
    letterSpacing: "0.12em",
  },
  sealCore: {
    fill: tokens.fg,
  },
  sealCheck: {
    fill: "none",
    stroke: tokens.accent,
    strokeWidth: 10,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
});
