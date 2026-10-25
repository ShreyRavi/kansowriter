/**
 * Where letter links point (D4). Production links always use the canonical origin, so a letter
 * sent from a preview deploy or an installed copy still opens on the live reader; dev and e2e
 * builds link to themselves.
 *
 * TODO: switch to https://writer.kansoboard.com once the custom domain is live.
 */
export const CANONICAL_LETTER_ORIGIN = 'https://kansowriter.vercel.app';

export const LETTER_ORIGIN = import.meta.env.PROD ? CANONICAL_LETTER_ORIGIN : location.origin;

/** "v1.<payload>" → the link that opens it in the reader */
export const letterLink = (encoded: string, origin = LETTER_ORIGIN) => `${origin}/l#${encoded}`;
