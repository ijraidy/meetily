'use client';

import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Mic, ShieldCheck, Cpu, Languages, Wrench } from 'lucide-react';

const OWNER = 'Juraydi al-Mansouri';

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
    text: 'This is a personal tool. Templates, defaults, and features are customized here and can keep growing.',
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
          <h1 className="text-2xl font-bold text-gray-900">Meetly</h1>
          <p className="text-sm text-gray-600">
            Personal meeting assistant{version ? ` · v${version}` : ''}
          </p>
        </div>
      </header>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-gray-800">About this app</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Meetly records meetings, transcribes them locally, and turns them into summaries, decisions,
          and action plans with owners and deadlines. It is customized and maintained by {OWNER} for
          personal use on Windows, with an iPhone companion in development.
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
        <h2 className="text-base font-semibold text-gray-800">Privacy</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Usage analytics and automatic update checks are disabled in this build. Meetings, transcripts,
          recordings, and models stay in your local application data and recordings folders.
        </p>
      </section>

      <footer className="text-xs text-gray-500 border-t border-gray-200 pt-4">
        Based on the open-source Meetily project (MIT License) with local modifications by {OWNER}.
      </footer>
    </div>
  );
}
