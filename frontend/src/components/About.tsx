'use client';

import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Mic, ShieldCheck, Cpu, Languages, Wrench, Github, Mail, Smartphone, Monitor } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

const OWNER = 'Juraydi al-Mansouri';
const OWNER_GITHUB = 'https://github.com/ijraidy';
const OWNER_EMAIL = 'j@mansouri.uk';
const RELEASES_URL = 'https://github.com/ijraidy/meetily/releases';

const FEATURES = [
  {
    icon: ShieldCheck,
    title: 'Private by design',
    text: 'Recording, transcription, and summaries run on this computer. Nothing is uploaded unless you configure an external AI provider yourself.',
  },
  {
    icon: Languages,
    title: 'Arabic and English',
    text: 'Multilingual Whisper handles Arabic, English, and mixed meetings. Summaries follow the meeting language or the language you pin.',
  },
  {
    icon: Cpu,
    title: 'Your models, your choice',
    text: 'Download and switch speech and summary models in Settings. Local GPU acceleration is used when the build supports it.',
  },
  {
    icon: Wrench,
    title: 'Built to be extended',
    text: 'Templates, defaults, and features are tailored here and keep growing on Windows and iPhone.',
  },
];

export default function About() {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, []);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <header className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-gray-900 text-white flex items-center justify-center">
          <Mic className="w-7 h-7" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Minuteman</h1>
          <p className="text-sm text-gray-600">
            Personal meeting assistant{version ? ` · v${version}` : ''}
          </p>
        </div>
      </header>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-gray-800">About this app</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Minuteman records meetings, transcribes them locally, and turns them into summaries, decisions,
          and action plans with owners and deadlines. It is developed and maintained by {OWNER}, who also
          created the Minuteman iPhone app that syncs with this desktop version.
        </p>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <div key={title} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-center gap-2 mb-1">
              <Icon className="w-4 h-4 text-gray-700" />
              <h3 className="font-bold text-sm text-gray-900">{title}</h3>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed">{text}</p>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-gray-800">Developer</h2>
        <p className="text-sm text-gray-600">{OWNER}</p>
        <div className="flex flex-wrap gap-4 text-sm">
          <button
            type="button"
            onClick={() => invoke('open_external_url', { url: OWNER_GITHUB }).catch(() => undefined)}
            className="inline-flex items-center gap-1.5 text-blue-600 hover:underline"
          >
            <Github className="w-4 h-4" /> github.com/ijraidy
          </button>
          <button
            type="button"
            onClick={() => invoke('open_external_url', { url: `mailto:${OWNER_EMAIL}` }).catch(() => undefined)}
            className="inline-flex items-center gap-1.5 text-blue-600 hover:underline"
          >
            <Mail className="w-4 h-4" /> {OWNER_EMAIL}
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-gray-800">Get Minuteman</h2>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => invoke('open_external_url', { url: RELEASES_URL }).catch(() => undefined)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 hover:bg-gray-50"
          >
            <Monitor className="w-4 h-4" /> Windows installer
          </button>
          <button
            type="button"
            onClick={() => invoke('open_external_url', { url: RELEASES_URL }).catch(() => undefined)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 hover:bg-gray-50"
          >
            <Smartphone className="w-4 h-4" /> iPhone (TestFlight)
          </button>
          <span
            className="inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-500"
            title="Android version is planned"
          >
            <Smartphone className="w-4 h-4" /> Android: coming soon
          </span>
        </div>
        <p className="text-xs text-gray-500">Downloads and TestFlight links are published on the GitHub releases page.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-gray-800">Privacy</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Usage analytics and automatic update checks are disabled in this build. Meetings, transcripts,
          recordings, and models stay in your local application data and recordings folders.
        </p>
      </section>

    </div>
  );
}
