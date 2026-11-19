import * as stylex from "@stylexjs/stylex";
import { tokens } from "./tokens.stylex";

export const prose = stylex.create({
  layout: {
    maxWidth: "1120px",
    margin: "0 auto",
    display: "grid",
    gridTemplateColumns: "220px minmax(0, 1fr)",
    gap: "48px",
    padding: "32px 24px 80px",
    "@media (max-width: 800px)": {
      display: "block",
    },
  },
  navigation: {
    minWidth: 0,
  },
  navTitle: {
    margin: "24px 0 8px",
    fontSize: "0.75rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: tokens.faint,
    fontWeight: 600,
  },
  navList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "grid",
    gap: "6px",
  },
  navLink: {
    color: tokens.muted,
    textDecoration: "none",
    fontSize: "0.9rem",
    ":hover": { color: tokens.fg },
    ":focus-visible": { outline: "none", boxShadow: tokens.focus },
  },
  content: {
    minWidth: 0,
  },
  h1: {
    fontSize: "clamp(2rem, 4vw, 2.8rem)",
    letterSpacing: "-0.045em",
    lineHeight: 1.05,
    margin: "0 0 18px",
  },
  h2: {
    marginTop: "2em",
    letterSpacing: "-0.03em",
  },
  h3: {
    letterSpacing: "-0.03em",
  },
  p: {
    margin: "1em 0",
    maxWidth: "68ch",
  },
  link: {
    color: tokens.accentSolid,
    textUnderlineOffset: "3px",
    ":focus-visible": { outline: "none", boxShadow: tokens.focus },
  },
  inlineCode: {
    fontFamily: tokens.mono,
    fontSize: "0.9em",
  },
  pre: {
    overflow: "auto",
    backgroundColor: tokens.codeBg,
    color: tokens.codeFg,
    padding: "16px",
    borderRadius: "12px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.line,
    maxWidth: "100%",
  },
  blockCode: {
    fontFamily: tokens.mono,
    whiteSpace: "pre",
    color: "inherit",
    backgroundColor: "transparent",
  },
  table: {
    display: "block",
    overflow: "auto",
    borderCollapse: "collapse",
    maxWidth: "100%",
  },
  cell: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.line,
    padding: "8px",
    textAlign: "left",
  },
  cards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "12px",
  },
  card: {
    display: "block",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.line,
    borderRadius: "12px",
    padding: "16px",
    textDecoration: "none",
    backgroundColor: tokens.bgElevated,
    color: "inherit",
  },
  callout: {
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: tokens.accentSolid,
    padding: "12px 16px",
    backgroundColor: tokens.bgSubtle,
  },
  steps: {
    display: "grid",
    gap: "8px",
  },
  step: {
    margin: "16px 0",
  },
  catalog: {
    display: "grid",
    gap: "8px",
  },
  searchPage: {
    maxWidth: "720px",
    margin: "0 auto",
    padding: "48px 24px 80px",
  },
  feedback: {
    display: "grid",
    gap: "12px",
    maxWidth: "40rem",
    marginTop: "32px",
  },
  textarea: {
    width: "100%",
    minHeight: "7rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.line,
    borderRadius: "12px",
    backgroundColor: tokens.bgElevated,
    color: tokens.fg,
    font: "inherit",
    padding: "12px",
    ":focus-visible": { outline: "none", boxShadow: tokens.focus },
  },
});
