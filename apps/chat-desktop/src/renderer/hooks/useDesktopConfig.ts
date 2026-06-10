import type { DesktopConfig } from "@/types";

const fallback: Partial<DesktopConfig> = {
  appName: "Lattice Code",
};

export function getDesktopConfig(): Partial<DesktopConfig> {
  return window.desktopConfig ?? fallback;
}
