/** Ядро fb2read: разбор книг, вёрстка и поиск без привязки к платформе. */

export type { ByteSource } from "./source.js";
export { MemorySource } from "./source.js";
export type { Block, BlockKind, TocEntry, Ref, Span } from "./block.js";
export { makeBlock } from "./block.js";
export { Book } from "./book.js";
export type { ImageData } from "./book.js";
export { parseXml, parseText, textOf, local, attr, iter, findIn } from "./xml.js";
export type { XmlEl, ParseResult } from "./xml.js";
export { repair, fixEntities, stripBinaries, lightClean } from "./repair.js";
export type { BinaryEntry, BinaryIndex } from "./repair.js";
export { decode, encodeLegacy, declaredEncoding, latin1, fromLatin1, DecodeError, ENCODINGS } from "./encoding.js";
export { isZip, isEpubData, zipNames, zipRead, readBookData } from "./zip.js";
export { epubPath, epubKey, parseEpub } from "./epub.js";
export type { EpubResult } from "./epub.js";
export { fb2Meta, parseFb2Bodies } from "./fb2.js";
export { charWidth, strWidth, cutToWidth, codePointWidth } from "./width.js";
export { wrapWords } from "./wrap.js";
export type { WrapLine } from "./wrap.js";
export { layout, STYLE } from "./layout.js";
export type { Line, LineAttr, LineStyle } from "./layout.js";
export { normalize, findMatches, matchContext } from "./search.js";
export type { Match } from "./search.js";
export { inlineRuns, textAndRefs } from "./inline.js";
export { guessType, guessExtension } from "./mime.js";
export { sha256Hex, sha1Hex } from "./hash.js";
