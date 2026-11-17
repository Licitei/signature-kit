import type * as React from "react";

export type PdfSignatureAnchorProps = {
  readonly token?: string;
  readonly children?: React.ReactNode;
  readonly className?: string;
};

const defaultTextAnchorClass = "text-[4px] text-white";

export function PdfSignatureAnchor({
  token = "{{signature}}",
  children,
  className = defaultTextAnchorClass,
}: PdfSignatureAnchorProps) {
  return <p className={className}>{children ?? token}</p>;
}

export type PdfSignatureLinkAnchorProps = {
  readonly href?: string;
  readonly children?: React.ReactNode;
  readonly className?: string;
};

const defaultLinkAnchorClass = "text-[4px] text-white";

export function PdfSignatureLinkAnchor({
  href = "https://signature.invalid/anchor",
  children = "signature",
  className = defaultLinkAnchorClass,
}: PdfSignatureLinkAnchorProps) {
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
