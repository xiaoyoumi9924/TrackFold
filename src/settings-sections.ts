export const settingsSections = ["general", "files", "accounts", "notifications", "separation", "maintenance"] as const;
export type SettingsSection = typeof settingsSections[number];
export function lastSettingsSection(): SettingsSection {
  const stored = localStorage.getItem("shiyin-settings-section");
  const section = (stored === "audio" ? "general" : stored) as SettingsSection;
  return settingsSections.includes(section) ? section : "general";
}
