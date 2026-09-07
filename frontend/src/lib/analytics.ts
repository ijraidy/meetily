/**
 * Analytics facade.
 *
 * Telemetry is permanently disabled in this build. Nothing in this module
 * invokes the Rust analytics commands or performs any network access; every
 * method is a local no-op that keeps its original signature so existing
 * callers continue to compile and behave as if analytics were simply off.
 */

export interface AnalyticsProperties {
  [key: string]: string;
}

export interface DeviceInfo {
  platform: string;
  os_version: string;
  architecture: string;
}

export interface UserSession {
  session_id: string;
  user_id: string;
  start_time: string;
  last_heartbeat: string;
  is_active: boolean;
}

const LOCAL_USER_ID = 'local';

export class Analytics {
  private static initialized = false;
  private static currentUserId: string | null = null;
  private static deviceInfo: DeviceInfo | null = null;

  static async init(): Promise<void> {
    // No-op: analytics is disabled in this build and never initialised.
  }

  static async disable(): Promise<void> {
    this.initialized = false;
    this.currentUserId = null;
  }

  static async isEnabled(): Promise<boolean> {
    return false;
  }

  static async track(_eventName: string, _properties?: AnalyticsProperties): Promise<void> {
    // No-op
  }

  static async identify(_userId: string, _properties?: AnalyticsProperties): Promise<void> {
    // No-op
  }

  static async startSession(_userId: string): Promise<string | null> {
    return null;
  }

  static async endSession(): Promise<void> {
    // No-op
  }

  static async trackDailyActiveUser(): Promise<void> {
    // No-op
  }

  static async trackUserFirstLaunch(): Promise<void> {
    // No-op
  }

  static async isSessionActive(): Promise<boolean> {
    return false;
  }

  // User ID management. No identifier is generated or persisted in this build.
  static async getPersistentUserId(): Promise<string> {
    return LOCAL_USER_ID;
  }

  static async checkAndTrackFirstLaunch(): Promise<void> {
    // No-op
  }

  static async checkAndTrackDailyUsage(): Promise<void> {
    // No-op
  }

  static getCurrentUserId(): string | null {
    return this.currentUserId;
  }

  // Platform/Device detection methods (local only, never transmitted)
  static async getPlatform(): Promise<string> {
    try {
      const userAgent = navigator.userAgent.toLowerCase();
      if (userAgent.includes('mac')) return 'macOS';
      if (userAgent.includes('win')) return 'Windows';
      if (userAgent.includes('linux')) return 'Linux';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  static async getOSVersion(): Promise<string> {
    try {
      const platform = await this.getPlatform();
      return `${platform} (${navigator.userAgent})`;
    } catch {
      return 'unknown';
    }
  }

  static async getDeviceInfo(): Promise<DeviceInfo> {
    if (this.deviceInfo) return this.deviceInfo;

    try {
      const platform = await this.getPlatform();
      const osVersion = await this.getOSVersion();

      const userAgent = navigator.userAgent.toLowerCase();
      let architecture = 'unknown';
      if (userAgent.includes('arm') || userAgent.includes('aarch64')) {
        architecture = 'aarch64';
      } else if (userAgent.includes('x86_64') || userAgent.includes('x64')) {
        architecture = 'x86_64';
      } else if (userAgent.includes('x86')) {
        architecture = 'x86';
      }

      this.deviceInfo = {
        platform,
        os_version: osVersion,
        architecture,
      };

      return this.deviceInfo;
    } catch {
      return {
        platform: 'unknown',
        os_version: 'unknown',
        architecture: 'unknown',
      };
    }
  }

  // Local bookkeeping helpers (inert: nothing is stored or counted)
  static async calculateDaysSince(_dateKey: string): Promise<number | null> {
    return null;
  }

  static async updateMeetingCount(): Promise<void> {
    // No-op
  }

  static async getMeetingsCountToday(): Promise<number> {
    return 0;
  }

  static async hasUsedFeatureBefore(_featureName: string): Promise<boolean> {
    return false;
  }

  static async markFeatureUsed(_featureName: string): Promise<void> {
    // No-op
  }

  // Session tracking
  static async trackSessionStarted(_sessionId: string): Promise<void> {
    // No-op
  }

  static async trackSessionEnded(_sessionId: string): Promise<void> {
    // No-op
  }

  // Meeting completion tracking
  static async trackMeetingCompleted(_meetingId: string, _metrics: {
    duration_seconds: number;
    transcript_segments: number;
    transcript_word_count: number;
    words_per_minute: number;
    meetings_today: number;
  }): Promise<void> {
    // No-op
  }

  static async trackFeatureUsedEnhanced(_featureName: string, _properties?: Record<string, any>): Promise<void> {
    // No-op
  }

  static async trackCopy(_copyType: 'transcript' | 'summary', _properties?: Record<string, any>): Promise<void> {
    // No-op
  }

  // Meeting-specific tracking methods
  static async trackMeetingStarted(_meetingId: string): Promise<void> {
    // No-op
  }

  static async trackRecordingStarted(_meetingId: string): Promise<void> {
    // No-op
  }

  static async trackRecordingStopped(_meetingId: string, _durationSeconds?: number): Promise<void> {
    // No-op
  }

  static async trackMeetingDeleted(_meetingId: string): Promise<void> {
    // No-op
  }

  static async trackSettingsChanged(_settingType: string, _newValue: string): Promise<void> {
    // No-op
  }

  static async trackFeatureUsed(_featureName: string): Promise<void> {
    // No-op
  }

  // Convenience methods for common events
  static async trackPageView(_pageName: string): Promise<void> {
    // No-op
  }

  static async trackButtonClick(_buttonName: string, _location?: string): Promise<void> {
    // No-op
  }

  static async trackError(_errorType: string, _errorMessage: string): Promise<void> {
    // No-op
  }

  static async trackAppStarted(): Promise<void> {
    // No-op
  }

  // Cleanup method for app shutdown
  static async cleanup(): Promise<void> {
    // No-op
  }

  // Reset initialization state (useful for testing)
  static reset(): void {
    this.initialized = false;
    this.currentUserId = null;
  }

  // Analytics is never initialised in this build, so this resolves immediately.
  static async waitForInitialization(_timeout: number = 5000): Promise<boolean> {
    return this.initialized;
  }

  static async trackBackendConnection(_success: boolean, _error?: string): Promise<void> {
    // No-op
  }

  static async trackTranscriptionError(_errorMessage: string): Promise<void> {
    // No-op
  }

  static async trackTranscriptionSuccess(_duration?: number): Promise<void> {
    // No-op
  }

  // Summary generation analytics
  static async trackSummaryGenerationStarted(
    _modelProvider: string,
    _modelName: string,
    _transcriptLength: number,
    _timeSinceRecordingMinutes?: number
  ): Promise<void> {
    // No-op
  }

  static async trackSummaryGenerationCompleted(
    _modelProvider: string,
    _modelName: string,
    _success: boolean,
    _durationSeconds?: number,
    _errorMessage?: string
  ): Promise<void> {
    // No-op
  }

  static async trackSummaryRegenerated(_modelProvider: string, _modelName: string): Promise<void> {
    // No-op
  }

  static async trackModelChanged(_oldProvider: string, _oldModel: string, _newProvider: string, _newModel: string): Promise<void> {
    // No-op
  }

  static async trackCustomPromptUsed(_promptLength: number): Promise<void> {
    // No-op
  }
}

export default Analytics;
