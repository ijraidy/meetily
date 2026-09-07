const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

function loadPreferences(values = new Map()) {
  const calls = [];
  const context = {
    window: { localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    } },
  };
  function load(relativePath) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const exports = {};
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, { ...context, exports, require: name => {
      if (name === '@/lib/summary-languages') return load('src/lib/summary-languages.ts');
      if (name === '@tauri-apps/api/core') return { invoke: async (command, args) => {
        calls.push({ command, args });
        return { language: args.summaryLanguage, storage: 'metadata' };
      } };
      throw new Error(`Unexpected import: ${name}`);
    } });
    return exports;
  }
  return { prefs: load('src/lib/summary-language-preferences.ts'), calls };
}

test('with no saved preference, new meetings follow automatic language detection', async () => {
  const { prefs, calls } = loadPreferences();
  assert.equal(prefs.readPinnedSummaryLanguageDefault(), null);
  assert.equal(await prefs.applyPinnedSummaryLanguageToMeeting('meeting-1'), null);
  assert.equal(calls.length, 0);
});

test('a pinned Arabic default is applied to new meetings through the persistence command', async () => {
  const { prefs, calls } = loadPreferences(new Map([['summaryLanguageDefault', 'ar']]));
  assert.equal(await prefs.applyPinnedSummaryLanguageToMeeting('meeting-1'), 'ar');
  assert.equal(calls[0].command, 'api_save_meeting_summary_language');
  assert.equal(calls[0].args.summaryLanguage, 'ar');
});

test('an existing language choice is preserved', () => {
  const { prefs } = loadPreferences(new Map([['summaryLanguageDefault', 'en']]));
  assert.equal(prefs.readPinnedSummaryLanguageDefault(), 'en');
});

test('unpinning Arabic persists Auto and does not reapply Arabic on reload', async () => {
  const values = new Map();
  loadPreferences(values).prefs.writePinnedSummaryLanguageDefault(null);
  const { prefs, calls } = loadPreferences(values);
  assert.equal(prefs.readPinnedSummaryLanguageDefault(), null);
  assert.equal(await prefs.applyPinnedSummaryLanguageToMeeting('meeting-2'), null);
  assert.equal(calls.length, 0);
});

test('Arabic regional preferences normalize to the supported summary language', () => {
  const { prefs } = loadPreferences(new Map([['summaryLanguageDefault', 'ar-SA']]));
  assert.equal(prefs.readPinnedSummaryLanguageDefault(), 'ar');
});
