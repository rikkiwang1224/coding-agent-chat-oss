import type { DesktopConfig } from "@/types";

const fallback: Partial<DesktopConfig> = {
  appName: "Forgelet",
};

export function getDesktopConfig(): Partial<DesktopConfig> {
  return window.desktopConfig ?? fallback;
}
