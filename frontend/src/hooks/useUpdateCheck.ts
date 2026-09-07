import { useState } from 'react';
import { updateService, UpdateInfo } from '@/services/updateService';

interface UseUpdateCheckOptions {
  checkOnMount?: boolean;
  showNotification?: boolean;
  onUpdateAvailable?: (info: UpdateInfo) => void;
}

/**
 * Update-check hook.
 *
 * Automatic updates are disabled in this build. The hook keeps its public
 * shape, but it never checks on mount, never shows notifications and never
 * reports an available update. `checkForUpdates` resolves with the inert
 * "up to date" result from `updateService`.
 */
export function useUpdateCheck(_options: UseUpdateCheckOptions = {}) {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const checkForUpdates = async (_force = false) => {
    setIsChecking(true);
    try {
      const info = await updateService.checkForUpdates(true);
      setUpdateInfo(info);
    } catch (error) {
      console.error('Failed to check for updates:', error);
    } finally {
      setIsChecking(false);
    }
  };

  return {
    updateInfo,
    isChecking,
    checkForUpdates,
  };
}
