'use client'

import React, { createContext, useContext, useCallback } from 'react';
import { UpdateInfo } from '@/services/updateService';

interface UpdateCheckContextType {
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  checkForUpdates: (force?: boolean) => Promise<void>;
  showUpdateDialog: () => void;
}

const UpdateCheckContext = createContext<UpdateCheckContextType | undefined>(undefined);

/**
 * Update-check provider.
 *
 * Automatic updates are disabled in this build: there is no update server, so
 * this provider never checks for updates, never registers update notifications
 * and never renders the update dialog. The context shape is preserved so that
 * consumers of `useUpdateCheckContext` keep compiling.
 */
export function UpdateCheckProvider({ children }: { children: React.ReactNode }) {
  const checkForUpdates = useCallback(async (_force?: boolean) => {
    // No-op: update checking is disabled in this build.
  }, []);

  const showUpdateDialog = useCallback(() => {
    // No-op: there is no update dialog in this build.
  }, []);

  return (
    <UpdateCheckContext.Provider
      value={{
        updateInfo: null,
        isChecking: false,
        checkForUpdates,
        showUpdateDialog,
      }}
    >
      {children}
    </UpdateCheckContext.Provider>
  );
}

export function useUpdateCheckContext() {
  const context = useContext(UpdateCheckContext);
  if (context === undefined) {
    throw new Error('useUpdateCheckContext must be used within UpdateCheckProvider');
  }
  return context;
}
