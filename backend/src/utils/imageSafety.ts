/**
 * Appearance asset safety: format detection, header-only measurement, structural
 * animation rejection, and mandatory metadata stripping.
 *
 * Spec RH-DESIGN.6 §7 (D6/D7), review findings S-F1 and S-F8. Every rule here is
 * a ratified requirement, not a preference:
 *
 *  - **Format comes from the BYTES.** Never from the declared MIME type, never
 *    from a filename. A caller controls both of those; it does not control the
 *    first eight bytes of what it uploaded.
 *  - **PNG, JPEG and WebP only.** SVG is forbidden outright — it is a
 *    script-bearing document that happens to render, and serving one from our
 *    own origin would hand an uploader same-origin script execution. GIF is not
 *    accepted at all, which also removes a whole animation surface.
 *  - **Animation is rejected structurally**, never by scanning for a substring:
 *    APNG by the presence of an `acTL` chunk, animated WebP by the VP8X
 *    feature-flags **animation bit** and by `ANIM`/`ANMF` chunks. A
 *    substring scan over compressed bytes both misses real cases and fires on
 *    innocent ones.
 *  - **Dimensions are read header-only.** The server never decodes pixel data.
 *    That is the measurement requirement and the decompression-bomb posture in
 *    one: a 40,000 x 40,000 PNG is rejected from its IHDR, having allocated
 *    nothing.
 *  - **Stripping is mandatory and structural (S-F1, blocking at review).** The
 *    stored bytes are RE-SERIALIZED from a filtered chunk/segment list. No
 *    pixel data is decoded or re-encoded, so nothing is degraded — but GPS,
 *    device identifiers, thumbnails and comments cannot survive, because the
 *    containers that carried them are not copied across. Only after stripping
 *    may bytes be called public-safe.
 *
 * Everything is pure: bytes in, bytes and facts out. No I/O, no database, no
 * network — which is what lets the hostile corpus be an ordinary unit test.
 */

export type AssetFormat = 'png' | 'jpeg' | 'webp';

/** Ratified limits (§7). */
export const MAX_ASSET_BYTES = 512 * 1024;
export const MAX_ASSET_DIMENSION = 2048;
export const MIN_FAVICON_DIMENSION = 64;

export const MIME_FOR_FORMAT: Record<AssetFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Why an upload was refused. The caller renders these as exact-reason envelopes. */
export type RejectionReason =
  | 'EMPTY_UPLOAD'
  | 'UNSUPPORTED_FORMAT'
  | 'SVG_FORBIDDEN'
  | 'GIF_FORBIDDEN'
  | 'MALFORMED_IMAGE'
  | 'ANIMATION_FORBIDDEN'
  | 'OVERSIZE_BYTES'
  | 'OVERSIZE_DIMENSIONS'
  | 'FAVICON_NOT_SQUARE'
  | 'FAVICON_TOO_SMALL';

export class AssetRejected extends Error {
  constructor(readonly reason: RejectionReason, message: string) {
    super(message);
    this.name = 'AssetRejected';
  }
}

export interface InspectedAsset {
  format: AssetFormat;
  width: number;
  height: number;
  /** Bytes as they will be STORED — stripped, never the bytes as uploaded. */
  bytes: Buffer;
  mime: string;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG chunks that survive stripping: the four critical types plus exactly two
 * ancillary ones that change how the image RENDERS rather than describing where
 * it was taken. Anything not on this list is dropped, so a new metadata chunk
 * type invented tomorrow is dropped by default rather than by having been
 * predicted. `eXIf`, `tEXt`, `zTXt` and `iTXt` are the named carriers, and they
 * are absent from this list rather than present in a blocklist for that reason.
 */
const PNG_KEPT_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA']);

/** Detect by magic bytes, and name the two forbidden formats specifically. */
export function detectFormat(bytes: Buffer): AssetFormat {
  if (bytes.length === 0) {
    throw new AssetRejected('EMPTY_UPLOAD', 'The upload contained no bytes.');
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  if (bytes.length >= 6 && bytes.toString('latin1', 0, 3) === 'GIF') {
    throw new AssetRejected('GIF_FORBIDDEN', 'GIF is not an accepted format.');
  }
  // An SVG is text, and its declared type would otherwise be the only clue.
  const head = bytes.toString('latin1', 0, Math.min(bytes.length, 1024)).trimStart();
  if (head.startsWith('<?xml') || head.toLowerCase().startsWith('<svg')) {
    throw new AssetRejected(
      'SVG_FORBIDDEN',
      'SVG is not an accepted upload format: it is a script-bearing document, not an image.'
    );
  }
  throw new AssetRejected('UNSUPPORTED_FORMAT', 'Accepted formats are PNG, JPEG and WebP.');
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

interface PngChunk {
  type: string;
  data: Buffer;
}

function readPngChunks(bytes: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = PNG_MAGIC.length;
  let reachedEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new AssetRejected('MALFORMED_IMAGE', 'The PNG ends inside a chunk header or checksum.');
    }
    const length = bytes.readUInt32BE(offset);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type) || (typeBytes[2] & 0x20) !== 0) {
      throw new AssetRejected('MALFORMED_IMAGE', 'The PNG contains an invalid chunk type.');
    }
    const end = offset + 12 + length;
    if (length > bytes.length || end > bytes.length) {
      throw new AssetRejected('MALFORMED_IMAGE', 'The PNG chunk table runs past the end of the file.');
    }
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBytes, data]));
    if (actualCrc !== expectedCrc) {
      throw new AssetRejected('MALFORMED_IMAGE', `The PNG ${type} chunk checksum is invalid.`);
    }
    chunks.push({ type, data });
    offset = end;
    if (type === 'IEND') {
      reachedEnd = true;
      if (offset !== bytes.length) {
        throw new AssetRejected('MALFORMED_IMAGE', 'The PNG carries bytes after its IEND chunk.');
      }
      break;
    }
  }
  if (!chunks.length || chunks[0].type !== 'IHDR') {
    throw new AssetRejected('MALFORMED_IMAGE', 'The PNG does not begin with an IHDR chunk.');
  }
  if (!reachedEnd) {
    throw new AssetRejected('MALFORMED_IMAGE', 'The PNG has no terminal IEND chunk.');
  }
  return chunks;
}

/** CRC-32, needed because stripping re-serializes the chunk table. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function inspectPng(bytes: Buffer): InspectedAsset {
  const chunks = readPngChunks(bytes);

  if (chunks.some((chunk) => chunk.type === 'acTL')) {
    throw new AssetRejected(
      'ANIMATION_FORBIDDEN',
      'Animated PNG is not accepted: the file carries an acTL animation-control chunk.'
    );
  }

  const header = chunks[0].data;
  if (header.length !== 13 || chunks.some((chunk, index) => index > 0 && chunk.type === 'IHDR')) {
    throw new AssetRejected('MALFORMED_IMAGE', 'The PNG must contain one 13-byte IHDR chunk at the start.');
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colourType = header[9];
  const permittedDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !permittedDepths[colourType]?.includes(bitDepth) ||
    header[10] !== 0 ||
    header[11] !== 0 ||
    (header[12] !== 0 && header[12] !== 1)
  ) {
    throw new AssetRejected('MALFORMED_IMAGE', 'The PNG IHDR declares an unsupported image structure.');
  }

  let seenPlte = false;
  let seenGamma = false;
  let seenTransparency = false;
  let seenIdat = false;
  let idatRunEnded = false;
  let idatBytes = 0;
  let paletteEntries = 0;

  for (let index = 1; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (seenIdat && chunk.type !== 'IDAT' && chunk.type !== 'IEND') idatRunEnded = true;

    switch (chunk.type) {
      case 'IHDR':
        throw new AssetRejected('MALFORMED_IMAGE', 'The PNG contains a second IHDR chunk.');
      case 'PLTE':
        if (
          seenPlte ||
          seenIdat ||
          colourType === 0 ||
          colourType === 4 ||
          chunk.data.length === 0 ||
          chunk.data.length % 3 !== 0 ||
          chunk.data.length > 768
        ) {
          throw new AssetRejected('MALFORMED_IMAGE', 'The PNG contains an invalid or misplaced PLTE chunk.');
        }
        seenPlte = true;
        paletteEntries = chunk.data.length / 3;
        break;
      case 'gAMA':
        if (seenGamma || seenPlte || seenIdat || chunk.data.length !== 4 || chunk.data.readUInt32BE(0) === 0) {
          throw new AssetRejected('MALFORMED_IMAGE', 'The PNG contains an invalid or misplaced gAMA chunk.');
        }
        seenGamma = true;
        break;
      case 'tRNS': {
        const validLength =
          (colourType === 0 && chunk.data.length === 2) ||
          (colourType === 2 && chunk.data.length === 6) ||
          (colourType === 3 && seenPlte && chunk.data.length > 0 && chunk.data.length <= paletteEntries);
        if (seenTransparency || seenIdat || !validLength) {
          throw new AssetRejected('MALFORMED_IMAGE', 'The PNG contains an invalid or misplaced tRNS chunk.');
        }
        seenTransparency = true;
        break;
      }
      case 'IDAT':
        if (idatRunEnded) {
          throw new AssetRejected('MALFORMED_IMAGE', 'The PNG IDAT chunks are not consecutive.');
        }
        seenIdat = true;
        idatBytes += chunk.data.length;
        break;
      case 'IEND':
        if (index !== chunks.length - 1 || chunk.data.length !== 0) {
          throw new AssetRejected('MALFORMED_IMAGE', 'The PNG has an invalid IEND chunk.');
        }
        break;
      default:
        // An uppercase first letter marks a critical chunk. Unknown ancillary
        // chunks are safe to drop, but an unknown critical chunk changes the
        // decoding contract and cannot be stripped into a different image.
        if ((chunk.type.charCodeAt(0) & 0x20) === 0) {
          throw new AssetRejected('MALFORMED_IMAGE', `The PNG uses unsupported critical chunk ${chunk.type}.`);
        }
    }
  }

  if (!seenIdat || idatBytes === 0 || (colourType === 3 && !seenPlte)) {
    throw new AssetRejected('MALFORMED_IMAGE', 'The PNG is missing mandatory image-data structure.');
  }

  const kept = chunks.filter((chunk) => PNG_KEPT_CHUNKS.has(chunk.type));
  const pieces: Buffer[] = [PNG_MAGIC];
  for (const chunk of kept) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(chunk.type, 'latin1'), chunk.data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    pieces.push(length, typeAndData, crc);
  }
  return { format: 'png', width, height, bytes: Buffer.concat(pieces), mime: MIME_FOR_FORMAT.png };
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** Frame markers that carry the dimensions. DHT/JPG/DAC share the SOF range and do not. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Markers that stand alone: no length field, no payload. Reading a length for
 * one of these consumes image bytes as a header, which is how a parser starts
 * hallucinating segments.
 */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/** APPn and COM — the metadata carriers, dropped wherever they legally appear. */
function isMetadataMarker(marker: number): boolean {
  return (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
}

/**
 * Find the next marker at or after `from`, honouring JPEG's three escapes.
 *
 * Returns the offset of the 0xFF that INTRODUCES the marker, or `bytes.length`
 * if the data runs out. This is the single place marker alignment is decided —
 * it exists because deciding it inline, twice, is what produced two rounds of
 * the same defect (reviews 0cd2ee83 and bdb1bf94).
 *
 * The three cases that are NOT a marker boundary:
 *   FF 00        stuffed literal 0xFF inside entropy-coded data
 *   FF D0..FF D7 restart markers, which belong to the scan
 *   FF FF ...    FILL BYTES. A marker may legally be preceded by any number of
 *                0xFF octets, so a run must be consumed ONE byte at a time. The
 *                round-2 defect was advancing two: for `FF FF E1` the cursor
 *                landed on E1, the outer parser never saw APP1, and the EXIF
 *                survived into the served bytes.
 */
function nextMarkerBoundary(bytes: Buffer, from: number): number {
  let index = from;
  while (index + 1 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1;
      continue;
    }
    const following = bytes[index + 1];
    if (following === 0x00 || (following >= 0xd0 && following <= 0xd7)) {
      index += 2;                     // stuffing or a restart marker
      continue;
    }
    if (following === 0xff) {
      index += 1;                     // fill byte — advance ONE, re-examine
      continue;
    }
    return index;
  }
  return bytes.length;
}

function inspectJpeg(bytes: Buffer): InspectedAsset {
  const pieces: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  let sawEndOfImage = false;

  while (offset + 1 < bytes.length) {
    // Align to the next marker, skipping any legal fill-byte run.
    if (bytes[offset] !== 0xff) {
      throw new AssetRejected('MALFORMED_IMAGE', 'The JPEG segment table is not marker-aligned.');
    }
    let markerOffset = offset;
    while (markerOffset + 1 < bytes.length && bytes[markerOffset + 1] === 0xff) {
      markerOffset += 1;
    }
    const marker = bytes[markerOffset + 1];
    const afterMarker = markerOffset + 2;

    if (marker === 0xd9) {
      sawEndOfImage = true;
      pieces.push(Buffer.from([0xff, 0xd9]));
      break;                          // bytes after EOI are a trailer; dropped
    }

    if (isStandaloneMarker(marker)) {
      pieces.push(Buffer.from([0xff, marker]));
      offset = afterMarker;
      continue;
    }

    if (afterMarker + 2 > bytes.length) {
      throw new AssetRejected('MALFORMED_IMAGE', 'The JPEG ends inside a segment header.');
    }
    const length = bytes.readUInt16BE(afterMarker);
    const segmentEnd = afterMarker + length;
    if (length < 2 || segmentEnd > bytes.length) {
      throw new AssetRejected('MALFORMED_IMAGE', 'A JPEG segment length runs past the end of the file.');
    }

    if (isStartOfFrame(marker)) {
      // SOFn payload: precision(1) height(2) width(2)
      if (segmentEnd - afterMarker < 7) {
        throw new AssetRejected('MALFORMED_IMAGE', 'The JPEG frame header is truncated.');
      }
      height = bytes.readUInt16BE(afterMarker + 3);
      width = bytes.readUInt16BE(afterMarker + 5);
    }

    // APPn and COM are dropped wholesale rather than parsed and pruned, because
    // parsing them is how a stripper acquires a vulnerability of its own.
    if (!isMetadataMarker(marker)) {
      pieces.push(Buffer.from([0xff, marker]), bytes.subarray(afterMarker, segmentEnd));
    }

    if (marker === 0xda) {
      // Entropy-coded data follows the scan header and runs to the next real
      // marker — which may be another scan, EOI, or a metadata segment.
      sawScan = true;
      const boundary = nextMarkerBoundary(bytes, segmentEnd);
      pieces.push(bytes.subarray(segmentEnd, boundary));
      offset = boundary;
      continue;
    }

    offset = segmentEnd;
  }

  if (!sawScan) {
    throw new AssetRejected('MALFORMED_IMAGE', 'The JPEG has no scan segment.');
  }
  if (!sawEndOfImage) {
    // A file that never terminates is malformed, and accepting it means storing
    // bytes whose end we could not account for.
    throw new AssetRejected('MALFORMED_IMAGE', 'The JPEG has no end-of-image marker.');
  }
  if (!width || !height) {
    throw new AssetRejected('MALFORMED_IMAGE', 'The JPEG carries no frame header.');
  }
  return {
    format: 'jpeg',
    width,
    height,
    bytes: Buffer.concat(pieces),
    mime: MIME_FOR_FORMAT.jpeg,
  };
}

/**
 * THE CLASS INVARIANT, checked independently of the walker above.
 *
 * Two review rounds produced the same class of defect: a legal byte sequence the
 * marker walker mis-classified, so a metadata segment was never seen and its
 * bytes survived into what we serve. Patching each instance is what the
 * anti-loop rule forbids, so the rule itself is asserted here instead.
 *
 * In a valid JPEG a 0xFF inside entropy-coded data is ALWAYS followed by 0x00 or
 * a restart marker. So an APPn or COM marker pair appearing anywhere in stripped
 * output can only be a segment the stripper failed to remove. That makes a flat
 * byte scan a sound check — and, crucially, one that shares no logic with the
 * walker, so a blind spot cannot pass both.
 */
export function findSurvivingMetadataMarker(stored: Buffer): number | null {
  for (let index = 0; index + 1 < stored.length; index += 1) {
    if (stored[index] === 0xff && isMetadataMarker(stored[index + 1])) {
      return index;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

/** VP8X feature flags, MSB-first in the first payload byte. */
const VP8X_FLAG_ANIMATION = 0x02;
const VP8X_FLAG_XMP = 0x04;
const VP8X_FLAG_EXIF = 0x08;

interface RiffChunk {
  fourcc: string;
  data: Buffer;
}

function readRiffChunks(bytes: Buffer): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  let offset = 12; // 'RIFF' + size + 'WEBP'
  while (offset + 8 <= bytes.length) {
    const fourcc = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (size > bytes.length || dataStart + size > bytes.length) {
      throw new AssetRejected('MALFORMED_IMAGE', 'A WebP chunk runs past the end of the file.');
    }
    chunks.push({ fourcc, data: bytes.subarray(dataStart, dataStart + size) });
    offset = dataStart + size + (size % 2); // chunks are padded to even length
  }
  if (!chunks.length) {
    throw new AssetRejected('MALFORMED_IMAGE', 'The WebP container has no chunks.');
  }
  return chunks;
}

function webpDimensions(chunks: RiffChunk[]): { width: number; height: number } {
  // A VP8X extended header can state a canvas size without the file carrying any
  // image at all. Requiring a data chunk FIRST means the dimensions we accept
  // always belong to something that renders — caught by the corpus, which fed a
  // VP8X-only container and watched it be accepted and stored.
  const hasImageData = chunks.some((chunk) => chunk.fourcc === 'VP8 ' || chunk.fourcc === 'VP8L');
  if (!hasImageData) {
    throw new AssetRejected(
      'MALFORMED_IMAGE',
      'The WebP carries no image data chunk: an extended header alone is not an image.'
    );
  }

  const vp8x = chunks.find((chunk) => chunk.fourcc === 'VP8X');
  if (vp8x) {
    if (vp8x.data.length < 10) {
      throw new AssetRejected('MALFORMED_IMAGE', 'The WebP VP8X chunk is truncated.');
    }
    const width = 1 + (vp8x.data[4] | (vp8x.data[5] << 8) | (vp8x.data[6] << 16));
    const height = 1 + (vp8x.data[7] | (vp8x.data[8] << 8) | (vp8x.data[9] << 16));
    return { width, height };
  }
  const lossy = chunks.find((chunk) => chunk.fourcc === 'VP8 ');
  if (lossy) {
    // frame tag (3) + start code 0x9D 0x01 0x2A (3) + width (2) + height (2)
    if (lossy.data.length < 10) {
      throw new AssetRejected('MALFORMED_IMAGE', 'The WebP VP8 frame header is truncated.');
    }
    if (lossy.data[3] !== 0x9d || lossy.data[4] !== 0x01 || lossy.data[5] !== 0x2a) {
      throw new AssetRejected('MALFORMED_IMAGE', 'The WebP VP8 start code is wrong.');
    }
    return {
      width: lossy.data.readUInt16LE(6) & 0x3fff,
      height: lossy.data.readUInt16LE(8) & 0x3fff,
    };
  }
  const lossless = chunks.find((chunk) => chunk.fourcc === 'VP8L');
  if (lossless) {
    if (lossless.data.length < 5 || lossless.data[0] !== 0x2f) {
      throw new AssetRejected('MALFORMED_IMAGE', 'The WebP VP8L header is truncated or mis-signed.');
    }
    const bits = lossless.data.readUInt32LE(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new AssetRejected('MALFORMED_IMAGE', 'The WebP carries no image data chunk.');
}

function inspectWebp(bytes: Buffer): InspectedAsset {
  const chunks = readRiffChunks(bytes);

  const vp8x = chunks.find((chunk) => chunk.fourcc === 'VP8X');
  const animatedByFlag = !!vp8x && vp8x.data.length > 0 && (vp8x.data[0] & VP8X_FLAG_ANIMATION) !== 0;
  const animatedByChunk = chunks.some((chunk) => chunk.fourcc === 'ANIM' || chunk.fourcc === 'ANMF');
  if (animatedByFlag || animatedByChunk) {
    throw new AssetRejected(
      'ANIMATION_FORBIDDEN',
      animatedByFlag
        ? 'Animated WebP is not accepted: the VP8X header sets the animation feature bit.'
        : 'Animated WebP is not accepted: the file carries animation frame chunks.'
    );
  }

  const { width, height } = webpDimensions(chunks);

  // Drop the metadata chunks AND clear the flag bits that advertise them: a
  // header still claiming EXIF after the chunk is gone describes a file that
  // does not exist, and some decoders will go looking.
  const kept = chunks.filter((chunk) => chunk.fourcc !== 'EXIF' && chunk.fourcc !== 'XMP ');
  const pieces: Buffer[] = [];
  for (const chunk of kept) {
    let data = chunk.data;
    if (chunk.fourcc === 'VP8X' && data.length > 0) {
      data = Buffer.from(data);
      data[0] &= ~(VP8X_FLAG_EXIF | VP8X_FLAG_XMP);
    }
    const header = Buffer.alloc(8);
    header.write(chunk.fourcc, 0, 'latin1');
    header.writeUInt32LE(data.length, 4);
    pieces.push(header, data);
    if (data.length % 2 === 1) pieces.push(Buffer.from([0x00]));
  }
  const payload = Buffer.concat(pieces);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(payload.length + 4, 4);
  riff.write('WEBP', 8, 'latin1');
  return {
    format: 'webp',
    width,
    height,
    bytes: Buffer.concat([riff, payload]),
    mime: MIME_FOR_FORMAT.webp,
  };
}

// ---------------------------------------------------------------------------

/**
 * Validate, measure and strip an uploaded asset.
 *
 * The byte ceiling is ALSO enforced by the multipart parser's streaming
 * `fileSize` limit, which aborts mid-stream (§7). This check is the second half
 * of that rule, not the whole of it: by the time bytes reach here they have
 * already been accepted into memory, so a check here alone would be a check
 * that arrived too late.
 */
export function inspectAsset(
  bytes: Buffer,
  options: { kind?: string } = {}
): InspectedAsset {
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new AssetRejected(
      'OVERSIZE_BYTES',
      `The upload is ${bytes.length} bytes; the limit is ${MAX_ASSET_BYTES}.`
    );
  }

  const format = detectFormat(bytes);
  const inspected =
    format === 'png' ? inspectPng(bytes) : format === 'jpeg' ? inspectJpeg(bytes) : inspectWebp(bytes);

  if (inspected.width <= 0 || inspected.height <= 0) {
    throw new AssetRejected('MALFORMED_IMAGE', 'The image declares a zero dimension.');
  }
  if (inspected.width > MAX_ASSET_DIMENSION || inspected.height > MAX_ASSET_DIMENSION) {
    throw new AssetRejected(
      'OVERSIZE_DIMENSIONS',
      `The image is ${inspected.width}x${inspected.height}; the limit is ` +
        `${MAX_ASSET_DIMENSION}px on either side.`
    );
  }

  if (options.kind === 'favicon') {
    if (inspected.width !== inspected.height) {
      throw new AssetRejected(
        'FAVICON_NOT_SQUARE',
        `A favicon must be square; this one is ${inspected.width}x${inspected.height}.`
      );
    }
    if (inspected.width < MIN_FAVICON_DIMENSION) {
      throw new AssetRejected(
        'FAVICON_TOO_SMALL',
        `A favicon must be at least ${MIN_FAVICON_DIMENSION}px; this one is ${inspected.width}px.`
      );
    }
  }

  return inspected;
}
