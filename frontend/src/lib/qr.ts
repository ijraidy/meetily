/**
 * Self-contained QR Code encoder (ISO/IEC 18004).
 *
 * Supports byte mode (UTF-8), all four error-correction levels and versions
 * 1-40, with automatic version and mask selection. No runtime dependencies;
 * the module is pure TypeScript so it can run in the browser and in Node.
 *
 * Usage:
 *   const qr = encodeQr('minuteman://pair?...', { errorCorrection: 'M' });
 *   qr.size            // modules per side (21 for version 1)
 *   qr.modules[y][x]   // true = dark module
 *   qrToSvgPath(qr)    // SVG path data for the dark modules
 */

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  version: number;
  size: number;
  errorCorrection: QrErrorCorrection;
  mask: number;
  /** modules[y][x] is true when the module is dark. */
  modules: boolean[][];
}

export interface QrEncodeOptions {
  /** Error-correction level. Defaults to 'M'. */
  errorCorrection?: QrErrorCorrection;
  /** Smallest version to consider (1-40). Defaults to 1. */
  minVersion?: number;
  /** Largest version to consider (1-40). Defaults to 40. */
  maxVersion?: number;
  /** Force a particular mask (0-7). Defaults to automatic selection. */
  mask?: number;
}

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

const ECL_INDEX: Record<QrErrorCorrection, number> = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Indexed by [ECL_INDEX][version]; index 0 is unused padding.
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Encodes UTF-8 text into a QR Code matrix. Throws if the data does not fit. */
export function encodeQr(text: string, options: QrEncodeOptions = {}): QrMatrix {
  const errorCorrection = options.errorCorrection ?? 'M';
  const minVersion = clampVersion(options.minVersion ?? QR_MIN_VERSION);
  const maxVersion = clampVersion(options.maxVersion ?? QR_MAX_VERSION);
  if (minVersion > maxVersion) {
    throw new RangeError('minVersion must not exceed maxVersion');
  }
  if (options.mask !== undefined && (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7)) {
    throw new RangeError('mask must be an integer between 0 and 7');
  }

  const data = encodeUtf8(text);
  const version = chooseVersion(data.length, errorCorrection, minVersion, maxVersion);
  const bits = buildDataBits(data, version, errorCorrection);
  const dataCodewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    dataCodewords.push(byte);
  }
  const codewords = addEccAndInterleave(dataCodewords, version, errorCorrection);
  return buildMatrix(version, errorCorrection, codewords, options.mask);
}

/** Returns the largest number of UTF-8 bytes that fit in the given version and level. */
export function qrByteCapacity(version: number, errorCorrection: QrErrorCorrection = 'M'): number {
  const v = clampVersion(version);
  const capacityBits = numDataCodewords(v, errorCorrection) * 8;
  return Math.max(0, Math.floor((capacityBits - 4 - byteModeCountBits(v)) / 8));
}

/** SVG path data (in module units) covering every dark module. */
export function qrToSvgPath(qr: QrMatrix, offset = 0): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y += 1) {
    const row = qr.modules[y];
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < qr.size && row[x + run]) run += 1;
      parts.push(`M${x + offset} ${y + offset}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return parts.join('');
}

/* ------------------------------------------------------------------ */
/* Encoding helpers                                                    */
/* ------------------------------------------------------------------ */

function clampVersion(version: number): number {
  if (!Number.isInteger(version) || version < QR_MIN_VERSION || version > QR_MAX_VERSION) {
    throw new RangeError(`QR version must be an integer between ${QR_MIN_VERSION} and ${QR_MAX_VERSION}`);
  }
  return version;
}

/** Manual UTF-8 encoder so the module does not depend on TextEncoder being present. */
export function encodeUtf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

function byteModeCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function chooseVersion(
  byteLength: number,
  ecl: QrErrorCorrection,
  minVersion: number,
  maxVersion: number,
): number {
  for (let version = minVersion; version <= maxVersion; version += 1) {
    const needed = 4 + byteModeCountBits(version) + byteLength * 8;
    if (needed <= numDataCodewords(version, ecl) * 8) return version;
  }
  throw new RangeError(`Data too long for a QR Code up to version ${maxVersion} at level ${ecl}`);
}

function buildDataBits(data: number[], version: number, ecl: QrErrorCorrection): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // byte mode indicator
  appendBits(bits, data.length, byteModeCountBits(version));
  for (const byte of data) appendBits(bits, byte, 8);

  const capacity = numDataCodewords(version, ecl) * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length)); // terminator
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8); // byte-align
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  return bits;
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number, ecl: QrErrorCorrection): number {
  const index = ECL_INDEX[ecl];
  return (
    Math.floor(numRawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[index][version] * NUM_ERROR_CORRECTION_BLOCKS[index][version]
  );
}

/* ------------------------------------------------------------------ */
/* Reed-Solomon over GF(2^8) with the QR polynomial 0x11D              */
/* ------------------------------------------------------------------ */

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsGeneratorPolynomial(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

function rsRemainder(data: number[], generator: number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < generator.length; i += 1) {
      result[i] ^= gfMultiply(generator[i], factor);
    }
  }
  return result;
}

function addEccAndInterleave(data: number[], version: number, ecl: QrErrorCorrection): number[] {
  const index = ECL_INDEX[ecl];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[index][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[index][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const generator = rsGeneratorPolynomial(blockEccLen);
  const blocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i += 1) {
    const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + dataLen);
    offset += dataLen;
    const ecc = rsRemainder(block, generator);
    if (i < numShortBlocks) block.push(0); // placeholder so every block has equal length
    blocks.push(block.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    for (let j = 0; j < blocks.length; j += 1) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Matrix construction                                                 */
/* ------------------------------------------------------------------ */

class MatrixBuilder {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(readonly version: number, readonly ecl: QrErrorCorrection) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  build(codewords: number[], forcedMask?: number): QrMatrix {
    this.drawFunctionPatterns();
    this.drawCodewords(codewords);

    let mask = forcedMask ?? -1;
    if (mask === -1) {
      let bestPenalty = Number.POSITIVE_INFINITY;
      for (let candidate = 0; candidate < 8; candidate += 1) {
        this.applyMask(candidate);
        this.drawFormatBits(candidate);
        const penalty = this.penaltyScore();
        if (penalty < bestPenalty) {
          bestPenalty = penalty;
          mask = candidate;
        }
        this.applyMask(candidate); // XOR is its own inverse
      }
    }
    this.applyMask(mask);
    this.drawFormatBits(mask);

    return {
      version: this.version,
      size: this.size,
      errorCorrection: this.ecl,
      mask,
      modules: this.modules.map((row) => row.slice()),
    };
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i += 1) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }

    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const positions = alignmentPatternPositions(this.version);
    const n = positions.length;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const overlapsFinder =
          (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
        if (!overlapsFinder) this.drawAlignment(positions[i], positions[j]);
      }
    }

    this.drawFormatBits(0); // reserves the modules; rewritten once the mask is chosen
    this.drawVersion();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunction(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private drawFormatBits(mask: number): void {
    const data = (ECL_FORMAT_BITS[this.ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i += 1) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i += 1) this.setFunction(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i += 1) this.setFunction(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i += 1) this.setFunction(8, this.size - 15 + i, getBit(bits, i));
    this.setFunction(8, this.size - 8, true); // the always-dark module
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  private drawCodewords(codewords: number[]): void {
    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && bitIndex < totalBits) {
            this.modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex += 1;
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (!this.isFunction[y][x] && maskBit(mask, x, y)) {
          this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
  }

  private penaltyScore(): number {
    let result = 0;
    const size = this.size;
    const modules = this.modules;

    // Adjacent modules in a row/column with the same colour, and finder-like patterns.
    for (let y = 0; y < size; y += 1) {
      let runColor = false;
      let runLength = 0;
      const history = new RunHistory();
      for (let x = 0; x < size; x += 1) {
        if (modules[y][x] === runColor) {
          runLength += 1;
          if (runLength === 5) result += PENALTY_N1;
          else if (runLength > 5) result += 1;
        } else {
          history.add(runLength, runColor);
          if (!runColor) result += history.finderPenalty(size) * PENALTY_N3;
          runColor = modules[y][x];
          runLength = 1;
        }
      }
      result += history.terminateAndCount(runColor, runLength, size) * PENALTY_N3;
    }
    for (let x = 0; x < size; x += 1) {
      let runColor = false;
      let runLength = 0;
      const history = new RunHistory();
      for (let y = 0; y < size; y += 1) {
        if (modules[y][x] === runColor) {
          runLength += 1;
          if (runLength === 5) result += PENALTY_N1;
          else if (runLength > 5) result += 1;
        } else {
          history.add(runLength, runColor);
          if (!runColor) result += history.finderPenalty(size) * PENALTY_N3;
          runColor = modules[y][x];
          runLength = 1;
        }
      }
      result += history.terminateAndCount(runColor, runLength, size) * PENALTY_N3;
    }

    // 2x2 blocks of the same colour.
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // Balance of dark and light modules.
    let dark = 0;
    for (const row of modules) for (const module of row) if (module) dark += 1;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }
}

/** Tracks the last seven run lengths for finder-like pattern detection. */
class RunHistory {
  private readonly runs = [0, 0, 0, 0, 0, 0, 0];

  add(runLength: number, runColor: boolean): void {
    if (this.runs[0] === 0 && !runColor) {
      // Leading light run: treat the border as extra light modules.
      this.runs[0] = runLength;
      return;
    }
    this.runs.pop();
    this.runs.unshift(runLength);
  }

  finderPenalty(size: number): number {
    const r = this.runs;
    const n = r[1];
    const core = n > 0 && r[2] === n && r[3] === n * 3 && r[4] === n && r[5] === n;
    if (!core) return 0;
    let count = 0;
    if (r[0] >= n * 4 && r[6] >= n * 4) count += 1;
    if (r[0] >= n * 4 || r[6] >= n * 4) count += 1;
    void size;
    return Math.min(count, 2);
  }

  terminateAndCount(currentColor: boolean, currentLength: number, size: number): number {
    let length = currentLength;
    if (currentColor) {
      this.add(length, true);
      length = 0;
    }
    length += size; // trailing border counts as light modules
    this.add(length, false);
    return this.finderPenalty(size);
  }
}

function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new RangeError(`Invalid mask ${mask}`);
  }
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function buildMatrix(
  version: number,
  ecl: QrErrorCorrection,
  codewords: number[],
  mask?: number,
): QrMatrix {
  return new MatrixBuilder(version, ecl).build(codewords, mask);
}
