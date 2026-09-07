'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertCircle,
  Check,
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  Smartphone,
  Wifi,
} from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from './ui/switch';

interface SyncConfig {
  enabled: boolean;
  port: number;
  token: string;
  addresses: string[];
  tailscale_address: string | null;
  preferred_address: string | null;
  device_name: string;
  running: boolean;
  running_port: number | null;
}

function isTailscaleAddress(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function buildPairingString(address: string, port: number, token: string): string {
  return `meetly://pair?url=${encodeURIComponent(`http://${address}:${port}`)}&token=${encodeURIComponent(token)}`;
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error(`Could not copy ${label.toLowerCase()}`);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
      title={`Copy ${label.toLowerCase()}`}
    >
      {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function SyncSettings() {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [portDraft, setPortDraft] = useState('');
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  const applyConfig = useCallback((next: SyncConfig) => {
    setConfig(next);
    setPortDraft(String(next.port));
    setSelectedAddress((current) => {
      if (current && next.addresses.includes(current)) return current;
      return next.preferred_address ?? next.addresses[0] ?? null;
    });
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const next = await invoke<SyncConfig>('sync_get_config');
      applyConfig(next);
      setError(null);
    } catch (err) {
      const message = typeof err === 'string' ? err : (err as Error)?.message || 'Failed to load sync settings';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [applyConfig]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const runCommand = useCallback(
    async (command: string, args: Record<string, unknown>, successMessage?: string) => {
      setBusy(true);
      try {
        const next = await invoke<SyncConfig>(command, args);
        applyConfig(next);
        setError(null);
        if (successMessage) toast.success(successMessage);
      } catch (err) {
        const message = typeof err === 'string' ? err : (err as Error)?.message || 'Sync command failed';
        setError(message);
        toast.error(message);
      } finally {
        setBusy(false);
      }
    },
    [applyConfig],
  );

  const handleToggle = (enabled: boolean) => {
    runCommand('sync_set_enabled', { enabled }, enabled ? 'Sync server enabled' : 'Sync server disabled');
  };

  const handlePortCommit = () => {
    if (!config) return;
    const port = Number.parseInt(portDraft, 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      toast.error('Port must be a number between 1024 and 65535');
      setPortDraft(String(config.port));
      return;
    }
    if (port === config.port) return;
    runCommand('sync_set_port', { port }, `Sync server now uses port ${port}`);
  };

  const handleRegenerate = () => {
    setConfirmRegenerate(false);
    runCommand('sync_regenerate_token', {}, 'New pairing token generated. Re-pair your iPhone.');
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm text-sm text-gray-600">
        Loading sync settings...
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
        <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-red-800">
          <p className="font-medium">Sync settings unavailable</p>
          <p className="mt-1">{error ?? 'Unknown error'}</p>
          <button
            type="button"
            onClick={loadConfig}
            className="mt-2 px-3 py-1.5 text-sm rounded-md border border-red-200 bg-white text-red-700 hover:bg-red-50"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const address = selectedAddress ?? config.preferred_address ?? config.addresses[0] ?? null;
  const baseUrl = address ? `http://${address}:${config.port}` : null;
  const pairingString = address ? buildPairingString(address, config.port, config.token) : null;
  const maskedToken = `${config.token.slice(0, 6)}${'•'.repeat(20)}${config.token.slice(-4)}`;

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Server toggle */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between gap-6">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <Smartphone className="h-5 w-5 text-gray-600" />
              <h3 className="text-lg font-semibold text-gray-900">iPhone sync</h3>
              <span
                className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                  config.running ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'
                }`}
              >
                {config.running ? `Listening on port ${config.running_port ?? config.port}` : 'Stopped'}
              </span>
            </div>
            <p className="text-sm text-gray-600">
              Runs a small local API on this PC so the Meetly iPhone app can upload recordings,
              read transcripts and edit summaries. Only devices that present the pairing token
              below can connect. Nothing leaves your network.
            </p>
          </div>
          <div className="ml-6">
            <Switch checked={config.enabled} onCheckedChange={handleToggle} disabled={busy} />
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <label htmlFor="sync-port" className="text-sm font-medium text-gray-700">
            Port
          </label>
          <input
            id="sync-port"
            type="number"
            min={1024}
            max={65535}
            value={portDraft}
            disabled={busy}
            onChange={(event) => setPortDraft(event.target.value)}
            onBlur={handlePortCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            }}
            className="w-28 px-3 py-1.5 text-sm rounded-md border border-gray-200 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <span className="text-xs text-gray-500">Default 47110. Changing it restarts the server.</span>
        </div>
      </div>

      {/* Addresses */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <Wifi className="h-5 w-5 text-gray-600" />
          <h3 className="text-lg font-semibold text-gray-900">Addresses</h3>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          This PC is <span className="font-medium text-gray-900">{config.device_name}</span>. Pick the
          address your iPhone should use.
        </p>

        {config.tailscale_address ? (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
            <strong>Tailscale detected.</strong> Install Tailscale on this PC and the iPhone, sign in to
            the same account, then use the <span className="font-mono">{config.tailscale_address}</span>{' '}
            address - it works from anywhere, not just on your Wi-Fi.
          </div>
        ) : (
          <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
            <strong>No Tailscale address found.</strong> Install Tailscale on this PC and the iPhone, sign in
            to the same account, and a <span className="font-mono">100.x.x.x</span> address will appear here.
            Until then the LAN addresses below only work while both devices are on the same Wi-Fi.
          </div>
        )}

        {config.addresses.length === 0 ? (
          <p className="text-sm text-gray-600">No network addresses detected.</p>
        ) : (
          <ul className="space-y-2">
            {config.addresses.map((ip) => {
              const tailscale = isTailscaleAddress(ip);
              const selected = ip === address;
              return (
                <li key={ip}>
                  <button
                    type="button"
                    onClick={() => setSelectedAddress(ip)}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md border text-left transition-colors ${
                      selected
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 bg-white hover:bg-gray-50'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-sm text-gray-900">
                        {ip}:{config.port}
                      </span>
                      {tailscale && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded-full">
                          Tailscale
                        </span>
                      )}
                    </span>
                    {selected && <Check className="w-4 h-4 text-blue-600" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Pairing */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Pair your iPhone</h3>
          <p className="text-sm text-gray-600">
            In the Meetly iPhone app choose <em>Pair with PC</em> and paste the pairing string, or enter
            the address and token by hand.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-gray-700">Pairing string</span>
            {pairingString && <CopyButton value={pairingString} label="Pairing string" />}
          </div>
          <div className="px-3 py-2 rounded-md border border-gray-200 bg-gray-50 font-mono text-xs text-gray-800 break-all">
            {pairingString ?? 'Select an address to build the pairing string.'}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-gray-700">Server URL</span>
            {baseUrl && <CopyButton value={baseUrl} label="Server URL" />}
          </div>
          <div className="px-3 py-2 rounded-md border border-gray-200 bg-gray-50 font-mono text-sm text-gray-800 break-all">
            {baseUrl ?? '-'}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-gray-700">Token</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowToken((value) => !value)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                {showToken ? 'Hide' : 'Show'}
              </button>
              <CopyButton value={config.token} label="Token" />
            </div>
          </div>
          <div className="px-3 py-2 rounded-md border border-gray-200 bg-gray-50 font-mono text-sm text-gray-800 break-all">
            {showToken ? config.token : maskedToken}
          </div>
        </div>

        <div className="pt-2 border-t border-gray-200">
          {confirmRegenerate ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-gray-700">
                Regenerating disconnects every paired device until you pair it again. Continue?
              </p>
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                Yes, regenerate
              </button>
              <button
                type="button"
                onClick={() => setConfirmRegenerate(false)}
                className="px-3 py-1.5 text-sm rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRegenerate(true)}
              disabled={busy}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className="w-4 h-4" />
              Regenerate token
            </button>
          )}
        </div>
      </div>

      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <p className="text-sm text-blue-800">
          <strong>Note:</strong> Windows Firewall may ask to allow Meetly on private networks the first time
          the server starts. Tailscale traffic is encrypted end to end; on plain Wi-Fi the token is sent in
          the clear, so only pair on networks you trust.
        </p>
      </div>
    </div>
  );
}
