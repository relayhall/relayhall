/**
 * Hostile corpus for Appearance asset safety (spec RH-DESIGN.6 §7, S-F1/S-F8).
 *
 * The fixtures are BUILT here, byte by byte, rather than checked in as opaque
 * files. Three reasons, all of which cost something to learn elsewhere:
 *
 *  1. A binary fixture in the tree is a fixture nobody can read in a review. A
 *     constructed one states its own attack in code.
 *  2. Several cases are things no encoder will produce on request — a WebP whose
 *     VP8X flags claim animation while carrying a still frame, a PNG with an
 *     `acTL` chunk and no frames. Those are exactly the shapes an attacker
 *     sends, and exactly the shapes a corpus of real photographs never contains.
 *  3. Every added binary would need residue-gating and allowlisting.
 *
 * The rule under test is that stripping is STRUCTURAL: the stored bytes are
 * re-serialized from a filtered container, so metadata cannot survive by being
 * spelled differently.
 */
import {
  AssetRejected,
  MAX_ASSET_BYTES,
  detectFormat,
  findSurvivingMetadataMarker,
  inspectAsset,
} from '../utils/imageSafety';

// --------------------------------------------------------------------------
// Fixture builders
// --------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function ihdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 6; // RGBA
  return pngChunk('IHDR', data);
}

function png(
  width = 64,
  height = 64,
  extra: Buffer[] = []
): Buffer {
  return Buffer.concat([
    PNG_MAGIC,
    ihdr(width, height),
    ...extra,
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function jpeg(width = 64, height = 64, extraSegments: Buffer[] = []): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8; // precision
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3; // components
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...extraSegments,
    jpegSegment(0xc0, sof),
    jpegSegment(0xda, Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00])),
    Buffer.from([0x12, 0x34, 0x56, 0x78, 0xff, 0xd9]), // entropy data + EOI
  ]);
}

/** A JPEG APP1 segment carrying an EXIF header with a GPS-looking payload. */
function exifApp1(): Buffer {
  return jpegSegment(
    0xe1,
    Buffer.concat([
      Buffer.from('Exif\0\0', 'latin1'),
      Buffer.from('MM\0*', 'latin1'),
      Buffer.from('GPSLatitude 51.5074 GPSLongitude -0.1278 SerialNumber 0xDEADBEEF', 'latin1'),
    ])
  );
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  const padding = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([header, data, padding]);
}

function vp8x(width: number, height: number, flags: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  const w = width - 1;
  const h = height - 1;
  data[4] = w & 0xff;
  data[5] = (w >> 8) & 0xff;
  data[6] = (w >> 16) & 0xff;
  data[7] = h & 0xff;
  data[8] = (h >> 8) & 0xff;
  data[9] = (h >> 16) & 0xff;
  return riffChunk('VP8X', data);
}

function vp8Frame(width = 64, height = 64): Buffer {
  const data = Buffer.alloc(10);
  data[3] = 0x9d;
  data[4] = 0x01;
  data[5] = 0x2a;
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return riffChunk('VP8 ', data);
}

function webp(chunks: Buffer[]): Buffer {
  const payload = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(payload.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, payload]);
}

function expectRejection(run: () => unknown, reason: string) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AssetRejected);
    expect((error as AssetRejected).reason).toBe(reason);
    return;
  }
  throw new Error(`expected rejection ${reason}, but the upload was accepted`);
}

// --------------------------------------------------------------------------

describe('format detection reads bytes, not claims', () => {
  it('accepts exactly PNG, JPEG and WebP', () => {
    expect(detectFormat(png())).toBe('png');
    expect(detectFormat(jpeg())).toBe('jpeg');
    expect(detectFormat(webp([vp8Frame()]))).toBe('webp');
  });

  it('refuses SVG by name, because a script-bearing document is not an image', () => {
    expectRejection(() => detectFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'SVG_FORBIDDEN');
    expectRejection(
      () => detectFormat(Buffer.from('<?xml version="1.0"?><svg onload="fetch(1)"/>')),
      'SVG_FORBIDDEN'
    );
  });

  it('refuses GIF', () => {
    expectRejection(() => detectFormat(Buffer.from('GIF89a....', 'latin1')), 'GIF_FORBIDDEN');
  });

  it('refuses an unknown format and an empty upload', () => {
    expectRejection(() => detectFormat(Buffer.from('not an image at all')), 'UNSUPPORTED_FORMAT');
    expectRejection(() => detectFormat(Buffer.alloc(0)), 'EMPTY_UPLOAD');
  });

  it('is not fooled by a PNG magic on a JPEG body, or vice versa', () => {
    // The declared type is a caller's claim; the first bytes are not.
    const disguised = Buffer.concat([PNG_MAGIC, jpeg().subarray(2)]);
    expectRejection(() => inspectAsset(disguised), 'MALFORMED_IMAGE');
  });
});

describe('animation is rejected structurally', () => {
  it('rejects APNG by its acTL chunk', () => {
    const actl = pngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]));
    expectRejection(() => inspectAsset(png(64, 64, [actl])), 'ANIMATION_FORBIDDEN');
  });

  it('rejects animated WebP by the VP8X flag alone, with no ANIM chunk present', () => {
    // The case a chunk-substring scan misses: the header claims animation and
    // the frames are ordinary. S-F8 names this specifically.
    const bytes = webp([vp8x(64, 64, 0x02), vp8Frame()]);
    expectRejection(() => inspectAsset(bytes), 'ANIMATION_FORBIDDEN');
  });

  it('rejects animated WebP by its ANIM chunk when the flag is not set', () => {
    const bytes = webp([vp8x(64, 64, 0x00), riffChunk('ANIM', Buffer.alloc(6)), vp8Frame()]);
    expectRejection(() => inspectAsset(bytes), 'ANIMATION_FORBIDDEN');
  });
});

describe('metadata is stripped structurally, not blocked', () => {
  it('serves a JPEG with known EXIF GPS carrying no APP1 at all', () => {
    const uploaded = jpeg(64, 64, [exifApp1()]);
    expect(uploaded.includes(Buffer.from('GPSLatitude'))).toBe(true);

    const stored = inspectAsset(uploaded).bytes;
    expect(stored.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(stored.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    expect(stored.includes(Buffer.from('SerialNumber'))).toBe(false);
    // The APP1 marker itself is gone, not merely emptied.
    for (let i = 0; i + 1 < stored.length; i++) {
      expect(stored[i] === 0xff && stored[i + 1] === 0xe1).toBe(false);
    }
  });

  it('strips an APP1 placed AFTER the scan data (review 0cd2ee83, F1)', () => {
    // The blocking finding, stated as the attack that produced it. The first cut
    // stopped parsing at the first Start-of-Scan and copied the remainder
    // verbatim, so metadata simply moved past the scan and was stored and served
    // with its GPS intact. Metadata does not have to sit where a stripper finds
    // convenient.
    const uploaded = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegSegment(0xc0, (() => {
        const sof = Buffer.alloc(15);
        sof[0] = 8; sof.writeUInt16BE(64, 1); sof.writeUInt16BE(64, 3); sof[5] = 3;
        return sof;
      })()),
      jpegSegment(0xda, Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00])),
      // Entropy data carrying a stuffed 0xFF00 and a restart marker, both of
      // which belong to the scan and must survive the walk.
      Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
      exifApp1(),                                   // <- after the scan
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(uploaded.includes(Buffer.from('GPSLatitude'))).toBe(true);

    const stored = inspectAsset(uploaded).bytes;
    expect(stored.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(stored.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    for (let i = 0; i + 1 < stored.length; i++) {
      expect(stored[i] === 0xff && stored[i + 1] === 0xe1).toBe(false);
    }
    // The scan itself is intact — stripping must not damage the image.
    expect(stored.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]))).toBe(true);
  });

  it('strips metadata between two scans of a progressive JPEG', () => {
    // The same class one step further out: a progressive image has several
    // scans, so "after the scan" is not a single place.
    const sof = Buffer.alloc(15);
    sof[0] = 8; sof.writeUInt16BE(32, 1); sof.writeUInt16BE(32, 3); sof[5] = 3;
    const scanHeader = Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
    const uploaded = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegSegment(0xc2, sof),                       // SOF2 = progressive
      jpegSegment(0xda, scanHeader),
      Buffer.from([0xaa, 0xbb]),
      jpegSegment(0xfe, Buffer.from('between-scan comment naming a person', 'latin1')),
      jpegSegment(0xda, scanHeader),
      Buffer.from([0xcc, 0xdd]),
      Buffer.from([0xff, 0xd9]),
    ]);
    const stored = inspectAsset(uploaded).bytes;
    expect(stored.includes(Buffer.from('between-scan'))).toBe(false);
    expect(stored.includes(Buffer.from([0xaa, 0xbb]))).toBe(true);
    expect(stored.includes(Buffer.from([0xcc, 0xdd]))).toBe(true);
  });

  it('drops a trailer hidden after end-of-image', () => {
    const uploaded = Buffer.concat([jpeg(64, 64), Buffer.from('TRAILING SECRET PAYLOAD', 'latin1')]);
    const stored = inspectAsset(uploaded).bytes;
    expect(stored.includes(Buffer.from('TRAILING SECRET'))).toBe(false);
  });

  it('drops every JPEG comment and application segment, including ones it has never seen', () => {
    const uploaded = jpeg(64, 64, [
      jpegSegment(0xe0, Buffer.from('JFIF\0', 'latin1')),
      jpegSegment(0xee, Buffer.from('Adobe photoshop trail', 'latin1')),
      jpegSegment(0xfe, Buffer.from('a comment naming the photographer', 'latin1')),
    ]);
    const stored = inspectAsset(uploaded).bytes;
    expect(stored.includes(Buffer.from('photoshop'))).toBe(false);
    expect(stored.includes(Buffer.from('photographer'))).toBe(false);
    expect(stored.includes(Buffer.from('JFIF'))).toBe(false);
  });

  it('drops PNG text and eXIf chunks while keeping the rendering-relevant ones', () => {
    const uploaded = png(64, 64, [
      pngChunk('tEXt', Buffer.from('Author\0Someone Identifiable', 'latin1')),
      pngChunk('iTXt', Buffer.from('Comment\0\0\0\0taken at home', 'latin1')),
      pngChunk('eXIf', Buffer.from('MM\0*GPSLatitude', 'latin1')),
      pngChunk('gAMA', Buffer.from([0x00, 0x00, 0xb1, 0x8f])),
    ]);
    const stored = inspectAsset(uploaded).bytes;
    expect(stored.includes(Buffer.from('Someone Identifiable'))).toBe(false);
    expect(stored.includes(Buffer.from('taken at home'))).toBe(false);
    expect(stored.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(stored.includes(Buffer.from('tEXt'))).toBe(false);
    expect(stored.includes(Buffer.from('eXIf'))).toBe(false);
    // gAMA changes how it renders, so it survives.
    expect(stored.includes(Buffer.from('gAMA'))).toBe(true);
    expect(stored.includes(Buffer.from('IDAT'))).toBe(true);
  });

  it('drops WebP EXIF and XMP chunks AND clears the flag bits that advertise them', () => {
    // A header still claiming EXIF after the chunk is gone describes a file that
    // does not exist, and some decoders go looking for it.
    const flags = 0x08 | 0x04; // EXIF | XMP
    const uploaded = webp([
      vp8x(64, 64, flags),
      vp8Frame(),
      riffChunk('EXIF', Buffer.from('MM\0*GPSLatitude 51.5074', 'latin1')),
      riffChunk('XMP ', Buffer.from('<x:xmpmeta>creator</x:xmpmeta>', 'latin1')),
    ]);
    const stored = inspectAsset(uploaded).bytes;
    expect(stored.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(stored.includes(Buffer.from('xmpmeta'))).toBe(false);
    expect(stored.includes(Buffer.from('EXIF', 'latin1'))).toBe(false);

    const vp8xIndex = stored.indexOf(Buffer.from('VP8X', 'latin1'));
    expect(vp8xIndex).toBeGreaterThan(-1);
    expect(stored[vp8xIndex + 8] & flags).toBe(0);
  });

  it('leaves the stored bytes a valid file of the same size and format', () => {
    for (const uploaded of [png(80, 40), jpeg(80, 40), webp([vp8x(80, 40, 0), vp8Frame(80, 40)])]) {
      const inspected = inspectAsset(uploaded);
      expect(inspected.width).toBe(80);
      expect(inspected.height).toBe(40);
      // Re-inspecting stored bytes must be a fixed point: stripping is idempotent.
      const second = inspectAsset(inspected.bytes);
      expect(second.bytes.equals(inspected.bytes)).toBe(true);
      expect(second.width).toBe(80);
      expect(second.height).toBe(40);
    }
  });
});

describe('limits are enforced from the header, never by decoding', () => {
  it('rejects an oversize declared dimension without allocating it', () => {
    // 40,000 x 40,000 RGBA would be 6.4 GB decoded. It is refused from 13 bytes
    // of IHDR — the measurement rule and the decompression-bomb posture are the
    // same rule.
    expectRejection(() => inspectAsset(png(40000, 40000)), 'OVERSIZE_DIMENSIONS');
    expectRejection(() => inspectAsset(jpeg(2049, 100)), 'OVERSIZE_DIMENSIONS');
  });

  it('rejects an oversize byte count', () => {
    const huge = Buffer.concat([png(), Buffer.alloc(MAX_ASSET_BYTES)]);
    expectRejection(() => inspectAsset(huge), 'OVERSIZE_BYTES');
  });

  it('holds the favicon slot to square and at least 64px', () => {
    expectRejection(() => inspectAsset(png(64, 32), { kind: 'favicon' }), 'FAVICON_NOT_SQUARE');
    expectRejection(() => inspectAsset(png(32, 32), { kind: 'favicon' }), 'FAVICON_TOO_SMALL');
    expect(inspectAsset(png(64, 64), { kind: 'favicon' }).width).toBe(64);
    // The same image is fine in a slot with no squareness requirement.
    expect(inspectAsset(png(64, 32), { kind: 'logo' }).height).toBe(32);
  });

  it('rejects a zero dimension and a truncated container', () => {
    expectRejection(() => inspectAsset(png(0, 64)), 'MALFORMED_IMAGE');
    expectRejection(() => inspectAsset(png().subarray(0, 20)), 'MALFORMED_IMAGE');
    expectRejection(() => inspectAsset(webp([vp8x(64, 64, 0)])), 'MALFORMED_IMAGE');
  });

  it('rejects a chunk length that claims more than the file holds', () => {
    const bytes = png();
    // Overstate the IDAT length so a naive parser would read past the buffer.
    const idatIndex = bytes.indexOf(Buffer.from('IDAT', 'latin1'));
    bytes.writeUInt32BE(0x7fffffff, idatIndex - 4);
    expectRejection(() => inspectAsset(bytes), 'MALFORMED_IMAGE');
  });
});

describe('PNG structural completeness is checked before stripping', () => {
  const iend = () => pngChunk('IEND', Buffer.alloc(0));
  const idat = (data = Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])) =>
    pngChunk('IDAT', data);

  const malformed: Array<[string, () => Buffer]> = [
    ['header only, with no pixel data or end marker', () => Buffer.concat([PNG_MAGIC, ihdr(64, 64)])],
    ['header and end marker, with no pixel data', () => Buffer.concat([PNG_MAGIC, ihdr(64, 64), iend()])],
    ['pixel data with no end marker', () => Buffer.concat([PNG_MAGIC, ihdr(64, 64), idat()])],
    ['a zero-byte image-data run', () => Buffer.concat([PNG_MAGIC, ihdr(64, 64), idat(Buffer.alloc(0)), iend()])],
    ['a second header chunk', () => Buffer.concat([PNG_MAGIC, ihdr(64, 64), ihdr(64, 64), idat(), iend()])],
    ['non-consecutive image-data chunks', () => Buffer.concat([
      PNG_MAGIC,
      ihdr(64, 64),
      idat(),
      pngChunk('tEXt', Buffer.from('separator\0value', 'latin1')),
      idat(),
      iend(),
    ])],
    ['an unknown critical chunk', () => Buffer.concat([
      PNG_MAGIC,
      ihdr(64, 64),
      pngChunk('ABCD', Buffer.alloc(0)),
      idat(),
      iend(),
    ])],
    ['a palette after image data', () => Buffer.concat([
      PNG_MAGIC,
      ihdr(64, 64),
      idat(),
      pngChunk('PLTE', Buffer.from([0, 0, 0])),
      iend(),
    ])],
    ['bytes after the end marker', () => Buffer.concat([png(), Buffer.from('trailer', 'latin1')])],
    ['an invalid header checksum', () => {
      const bytes = png();
      bytes[32] ^= 0x01;
      return bytes;
    }],
    ['an invalid ancillary checksum', () => {
      const bytes = png(64, 64, [pngChunk('tEXt', Buffer.from('Author\0Name', 'latin1'))]);
      const text = bytes.indexOf(Buffer.from('tEXt', 'latin1'));
      bytes[text + 4] ^= 0x01;
      return bytes;
    }],
    ['a header with an unsupported compression method', () => {
      const data = Buffer.alloc(13);
      data.writeUInt32BE(64, 0);
      data.writeUInt32BE(64, 4);
      data[8] = 8;
      data[9] = 6;
      data[10] = 1;
      return Buffer.concat([PNG_MAGIC, pngChunk('IHDR', data), idat(), iend()]);
    }],
    ['an indexed-colour header with no palette', () => {
      const data = Buffer.alloc(13);
      data.writeUInt32BE(64, 0);
      data.writeUInt32BE(64, 4);
      data[8] = 8;
      data[9] = 3;
      return Buffer.concat([PNG_MAGIC, pngChunk('IHDR', data), idat(), iend()]);
    }],
  ];

  test.each(malformed)('rejects %s', (_name, makeBytes) => {
    expectRejection(() => inspectAsset(makeBytes()), 'MALFORMED_IMAGE');
  });

  it('keeps a complete indexed-colour container within the supported grammar', () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(64, 0);
    header.writeUInt32BE(64, 4);
    header[8] = 8;
    header[9] = 3;
    const bytes = Buffer.concat([
      PNG_MAGIC,
      pngChunk('IHDR', header),
      pngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
      pngChunk('tRNS', Buffer.from([0, 255])),
      idat(),
      iend(),
    ]);
    expect(inspectAsset(bytes)).toMatchObject({ format: 'png', width: 64, height: 64 });
  });
});

describe('THE CLASS INVARIANT: no metadata marker survives, whatever its legal spelling', () => {
  /**
   * Two review rounds produced the SAME class of defect — a legal byte sequence
   * the marker walker mis-classified, so a metadata segment was never seen and
   * survived into the served bytes. Round 1: a segment after the scan. Round 2:
   * `FF FF E1`, a marker preceded by a legal fill byte.
   *
   * Enumerating a third case would be patching instances, which is exactly what
   * the anti-loop rule forbids. So this generates the structural variants
   * combinatorially and asserts the RULE over all of them: whatever we accept,
   * the stored bytes carry no APPn or COM marker anywhere. The check shares no
   * logic with the walker, so a blind spot cannot pass both.
   */
  const SECRET = 'PRIVATE-LOCATION-PAYLOAD';

  function sof(width: number, height: number, progressive = false) {
    const payload = Buffer.alloc(15);
    payload[0] = 8;
    payload.writeUInt16BE(height, 1);
    payload.writeUInt16BE(width, 3);
    payload[5] = 3;
    return jpegSegment(progressive ? 0xc2 : 0xc0, payload);
  }

  const scanHeader = Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);

  /** A metadata segment, optionally preceded by a legal run of 0xFF fill bytes. */
  function metadata(marker: number, fill: number): Buffer {
    const segment = jpegSegment(marker, Buffer.concat([
      Buffer.from('Exif\0\0', 'latin1'),
      Buffer.from(SECRET, 'latin1'),
    ]));
    return Buffer.concat([Buffer.alloc(fill, 0xff), segment]);
  }

  const ENTROPY = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]);

  const MARKERS = [0xe0, 0xe1, 0xee, 0xef, 0xfe];   // APP0, APP1, APP14, APP15, COM
  const FILLS = [0, 1, 2, 3];                        // legal fill-byte runs
  const PLACEMENTS = ['before-frame', 'after-frame', 'after-scan', 'between-scans'] as const;

  const cases: Array<{ name: string; bytes: Buffer }> = [];
  for (const marker of MARKERS) {
    for (const fill of FILLS) {
      for (const placement of PLACEMENTS) {
        const block = metadata(marker, fill);
        const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
        if (placement === 'before-frame') parts.push(block);
        parts.push(sof(64, 64, placement === 'between-scans'));
        if (placement === 'after-frame') parts.push(block);
        parts.push(jpegSegment(0xda, scanHeader), ENTROPY);
        if (placement === 'after-scan') parts.push(block);
        if (placement === 'between-scans') {
          parts.push(block, jpegSegment(0xda, scanHeader), ENTROPY);
        }
        parts.push(Buffer.from([0xff, 0xd9]));
        cases.push({
          name: `marker 0x${marker.toString(16)} with ${fill} fill byte(s), ${placement}`,
          bytes: Buffer.concat(parts),
        });
      }
    }
  }

  test(`covers ${MARKERS.length * FILLS.length * PLACEMENTS.length} structural variants`, () => {
    expect(cases).toHaveLength(80);
  });

  test.each(cases)('$name', ({ bytes }) => {
    expect(bytes.includes(Buffer.from(SECRET))).toBe(true);

    let stored: Buffer;
    try {
      stored = inspectAsset(bytes).bytes;
    } catch (error) {
      // Refusing the file is an acceptable answer — what is never acceptable is
      // accepting it and keeping the metadata.
      expect(error).toBeInstanceOf(AssetRejected);
      return;
    }

    const survivor = findSurvivingMetadataMarker(stored);
    expect(survivor === null
      ? 'no metadata marker survived'
      : `metadata marker at byte ${survivor}`).toBe('no metadata marker survived');
    expect(stored.includes(Buffer.from(SECRET))).toBe(false);
    expect(stored.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);

    // Stripping must not damage the image, and must be a fixed point.
    expect(stored.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]))).toBe(true);
    expect(inspectAsset(stored).bytes.equals(stored)).toBe(true);
  });

  test('the invariant checker is not vacuous — it finds a marker that IS present', () => {
    // A checker that never fires would make all eighty cases above meaningless.
    const withMarker = Buffer.concat([Buffer.from([0xff, 0xd8]), metadata(0xe1, 0)]);
    expect(findSurvivingMetadataMarker(withMarker)).not.toBeNull();
    expect(findSurvivingMetadataMarker(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });

  test('a JPEG with no end-of-image marker is refused', () => {
    const truncated = Buffer.concat([
      Buffer.from([0xff, 0xd8]), sof(64, 64), jpegSegment(0xda, scanHeader), ENTROPY,
    ]);
    expectRejection(() => inspectAsset(truncated), 'MALFORMED_IMAGE');
  });
});
