const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

function loadQr() {
  const source = fs.readFileSync(path.join(root, 'src/lib/qr.ts'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: name => { throw new Error(`qr.ts must stay dependency-free, but imported ${name}`); },
  });
  return exports;
}

const qr = loadQr();
const PAIRING = 'minuteman://pair?url=http%3A%2F%2F192.168.1.23%3A47110&token=0123456789abcdef0123456789abcdef0123456789abcdef';
const ARABIC_GREETING = 'مرحبا بالعالم';

// 7x7 finder pattern: dark ring, light ring, dark 3x3 centre.
function assertFinder(matrix, left, top) {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      const onOuterRing = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const inCentre = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      const expected = onOuterRing || inCentre;
      assert.equal(matrix[top + dy][left + dx], expected, `finder module at (${left + dx},${top + dy})`);
    }
  }
}

// One module of light separator around the finder, inside the symbol.
function assertSeparator(matrix, size, left, top) {
  for (let i = -1; i <= 7; i += 1) {
    for (const [x, y] of [[left + i, top - 1], [left + i, top + 7], [left - 1, top + i], [left + 7, top + i]]) {
      if (x >= 0 && y >= 0 && x < size && y < size) {
        assert.equal(matrix[y][x], false, `separator module at (${x},${y})`);
      }
    }
  }
}

// Format information is a (15,5) BCH code XOR-masked with 0x5412.
function decodeFormatBits(bits) {
  const unmasked = bits ^ 0x5412;
  const data = unmasked >>> 10;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.equal(((data << 10) | rem), unmasked, 'format information fails its BCH check');
  return { ecl: data >>> 3, mask: data & 7 };
}

function readFormatBits(matrix, size) {
  // Copy 1: around the top-left finder.
  let a = 0;
  for (let i = 0; i <= 5; i += 1) a |= (matrix[i][8] ? 1 : 0) << i;
  a |= (matrix[7][8] ? 1 : 0) << 6;
  a |= (matrix[8][8] ? 1 : 0) << 7;
  a |= (matrix[8][7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i += 1) a |= (matrix[8][14 - i] ? 1 : 0) << i;
  // Copy 2: split between the other two finders.
  let b = 0;
  for (let i = 0; i < 8; i += 1) b |= (matrix[8][size - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i += 1) b |= (matrix[size - 15 + i][8] ? 1 : 0) << i;
  return { a, b };
}

test('the pairing string encodes to a deterministic square matrix of the documented size', () => {
  const first = qr.encodeQr(PAIRING, { errorCorrection: 'M' });
  const second = qr.encodeQr(PAIRING, { errorCorrection: 'M' });

  assert.ok(first.version >= 1 && first.version <= 10, `version ${first.version} should be within 1-10`);
  assert.equal(first.size, first.version * 4 + 17);
  assert.equal(first.modules.length, first.size);
  for (const row of first.modules) {
    assert.equal(row.length, first.size);
    for (const module of row) assert.equal(typeof module, 'boolean');
  }
  assert.deepEqual(first, second);
  assert.equal(first.errorCorrection, 'M');
});

test('finder patterns, separators, timing patterns and the dark module are in place', () => {
  for (const text of ['A', 'HELLO WORLD', PAIRING, 'x'.repeat(200)]) {
    const { modules, size, version } = qr.encodeQr(text, { errorCorrection: 'M' });
    assertFinder(modules, 0, 0);
    assertFinder(modules, size - 7, 0);
    assertFinder(modules, 0, size - 7);
    assertSeparator(modules, size, 0, 0);
    assertSeparator(modules, size, size - 7, 0);
    assertSeparator(modules, size, 0, size - 7);
    // Timing patterns alternate starting dark at (8,6)/(6,8).
    for (let i = 8; i < size - 8; i += 1) {
      assert.equal(modules[6][i], i % 2 === 0, `horizontal timing at x=${i} (v${version})`);
      assert.equal(modules[i][6], i % 2 === 0, `vertical timing at y=${i} (v${version})`);
    }
    assert.equal(modules[size - 8][8], true, 'dark module');
  }
});

test('both copies of the format information decode to level M and the chosen mask', () => {
  for (const text of ['A', PAIRING, 'x'.repeat(120)]) {
    const result = qr.encodeQr(text, { errorCorrection: 'M' });
    const { a, b } = readFormatBits(result.modules, result.size);
    assert.equal(a, b, 'the two format copies must match');
    const decoded = decodeFormatBits(a);
    assert.equal(decoded.ecl, 0, 'level M is encoded as 00');
    assert.equal(decoded.mask, result.mask);
  }
});

test('the smallest version that fits is chosen, versions 1-10 at level M', () => {
  const expectedCapacity = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  for (let version = 1; version <= 10; version += 1) {
    const capacity = qr.qrByteCapacity(version, 'M');
    assert.equal(capacity, expectedCapacity[version], `capacity of version ${version}`);
    const full = qr.encodeQr('z'.repeat(capacity), { errorCorrection: 'M' });
    assert.equal(full.version, version);
    assert.equal(full.size, version * 4 + 17);
    const overflow = qr.encodeQr('z'.repeat(capacity + 1), { errorCorrection: 'M' });
    assert.equal(overflow.version, version + 1);
  }
});

// qr.ts runs in its own vm realm, so its arrays and errors carry that realm's
// prototypes; compare by value / by name rather than by identity.
const bytes = text => Array.from(qr.encodeUtf8(text));

test('text is encoded as UTF-8 bytes (Arabic and emoji)', () => {
  assert.deepEqual(bytes('A'), [0x41]);
  assert.deepEqual(bytes('é'), [0xc3, 0xa9]);
  assert.deepEqual(bytes('م'), [0xd9, 0x85]);
  assert.deepEqual(bytes('\u{1f600}'), [0xf0, 0x9f, 0x98, 0x80]);
  const arabic = qr.encodeQr(ARABIC_GREETING, { errorCorrection: 'M' });
  assert.equal(arabic.size, arabic.version * 4 + 17);
});

test('data that does not fit in the allowed versions is rejected', () => {
  const isRangeError = err => err.name === 'RangeError' && /too long/i.test(err.message);
  assert.throws(() => qr.encodeQr('z'.repeat(214), { errorCorrection: 'M', maxVersion: 10 }), isRangeError);
  assert.throws(() => qr.encodeQr('z'.repeat(3000)), isRangeError);
});

test('the SVG path covers exactly the dark modules', () => {
  const result = qr.encodeQr('HELLO WORLD', { errorCorrection: 'M' });
  const pathData = qr.qrToSvgPath(result, 4);
  const painted = new Set();
  for (const match of pathData.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, run] = [Number(match[1]) - 4, Number(match[2]) - 4, Number(match[3])];
    for (let i = 0; i < run; i += 1) painted.add(`${x + i},${y}`);
  }
  let dark = 0;
  for (let y = 0; y < result.size; y += 1) {
    for (let x = 0; x < result.size; x += 1) {
      if (result.modules[y][x]) {
        dark += 1;
        assert.ok(painted.has(`${x},${y}`), `dark module (${x},${y}) is painted`);
      }
    }
  }
  assert.equal(painted.size, dark);
});
