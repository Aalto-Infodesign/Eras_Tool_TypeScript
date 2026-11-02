/**
 * Matches the normalisation the original applied via lodash `snakeCase`, but
 * memoised: the old pipeline called it once per event (millions of calls over a
 * large file) even though a dataset only ever holds a few dozen distinct labels.
 */
const cache = new Map();
/**
 * The words in a label, as lodash finds them: a run of capitals is one word
 * (`DX`, and the `XML` of `XMLHttp`), a capital starts a word only when
 * lowercase follows (`fooBar`), digits stand alone, and anything else —
 * spaces, punctuation, underscores — only separates.
 *
 * Unicode classes rather than `[A-Za-z]`, so an accented label keeps its
 * letters. The previous split ran *before every capital* not at a word
 * boundary, which spelled an all-caps label out letter by letter: `DX` → `d_x`.
 */
const WORDS = /\p{Lu}+(?![\p{Ll}\p{M}])|\p{Lu}?[\p{Ll}\p{M}]+|\p{L}+|\p{N}+/gu;
export function snakeCase(input) {
    const hit = cache.get(input);
    if (hit !== undefined)
        return hit;
    const out = (input.normalize("NFC").match(WORDS) ?? []).map((w) => w.toLowerCase()).join("_");
    cache.set(input, out);
    return out;
}
