import type { DesktopAction } from "../shared/preferences";

export type GeneralPreferences = {
  loginSupported: boolean;
  openAtLogin: boolean;
  loginStatus?: string;
  shortcut: string;
  shortcutActive: boolean;
};
const bridge = () => (window as typeof window & { shiyinDesktop?: {
  preferences: (patch?: Partial<GeneralPreferences>) => Promise<GeneralPreferences>;
  confirmPlaybackStopped: () => void;
  shutdownTimer: (minutes?: number | null) => Promise<number | null>;
  onAction: (handler: (action: DesktopAction) => void) => () => void;
} }).shiyinDesktop;
export function generalPreferences(patch?: Partial<GeneralPreferences>) {
  const desktop = bridge();
  if (!desktop) return Promise.reject(new Error("此设置在拾音 Mac 桌面版可用。"));
  return desktop.preferences(patch);
}
export function shutdownTimer(minutes?: number | null) {
  const desktop = bridge();
  if (!desktop) return Promise.reject(new Error("定时关闭在拾音桌面版可用。"));
  return desktop.shutdownTimer(minutes);
}
export const onDesktopAction = (handler: (action: DesktopAction) => void) => bridge()?.onAction(handler);
export const confirmPlaybackStopped = () => bridge()?.confirmPlaybackStopped();
