import { useCallback, useEffect, useState } from "react";
import {
  buildDefaultLlmGeneralSettings,
  getProviderOption,
  hasDistinctLightModel,
  PROVIDER_OPTIONS,
  type ProviderOption,
} from "@lattice-code/sdk-runtime";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getDesktopConfig } from "@/hooks/useDesktopConfig";
import type { AppSettings, LlmProvider } from "@/types";

const defaultGeneral = buildDefaultLlmGeneralSettings();

const DEFAULT_SETTINGS: AppSettings = {
  general: {
    ...defaultGeneral,
    apiKey: "",
  },
};

function MaskedInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-line bg-white/80 px-3 py-2 pr-10 text-sm text-text placeholder:text-soft focus:border-accent/30 focus:outline-none focus:ring-2 focus:ring-accent/10"
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-text"
        aria-label={visible ? "Hide API key" : "Show API key"}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5">
      <label className="block text-sm font-medium text-text">{children}</label>
      {hint ? <p className="mt-0.5 text-xs text-soft">{hint}</p> : null}
    </div>
  );
}

export function Settings() {
  const config = getDesktopConfig();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    config.getSettings?.().then((next) => {
      if (next) setSettings(next);
    });
  }, [config]);

  const update = useCallback((fn: (draft: AppSettings) => void) => {
    setSettings((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
    setSaved(false);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await config.updateSettings?.(settings);
      setDirty(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [config, settings]);

  const preset = getProviderOption(settings.general.provider);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted">DeepSeek is the default; other providers are optional.</p>
        </div>
        <div className="flex items-center gap-2">
          {saved ? <span className="text-sm text-positive">Saved</span> : null}
          <Button onClick={handleSave} disabled={!dirty || saving} size="sm">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-[620px] space-y-5 px-6 py-8 pb-12">
          <div>
            <FieldLabel hint="Switching provider fills default endpoint and model values. You can still edit them.">
              Provider
            </FieldLabel>
            <select
              value={settings.general.provider}
              onChange={(event) => {
                const provider = event.target.value as LlmProvider;
                update((draft) => {
                  const target = getProviderOption(provider);
                  draft.general.provider = provider;
                  draft.general.baseUrl = target.baseUrl;
                  draft.general.primaryModel = target.defaultPrimaryModel;
                  draft.general.lightModel = target.defaultLightModel;
                });
              }}
              className="w-full rounded-xl border border-line bg-white/80 px-3 py-2 text-sm text-text focus:border-accent/30 focus:outline-none focus:ring-2 focus:ring-accent/10"
            >
              {PROVIDER_OPTIONS.map((option: ProviderOption) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-soft">{preset.description}</p>
          </div>

          <div>
            <FieldLabel hint="Used for normal chat turns and coding work.">Primary Model</FieldLabel>
            <input
              type="text"
              value={settings.general.primaryModel}
              onChange={(event) => update((draft) => { draft.general.primaryModel = event.target.value; })}
              placeholder={preset.defaultPrimaryModel || "model id"}
              className="w-full rounded-xl border border-line bg-white/80 px-3 py-2 text-sm text-text focus:border-accent/30 focus:outline-none focus:ring-2 focus:ring-accent/10"
            />
          </div>

          {hasDistinctLightModel(preset) ? (
            <div>
              <FieldLabel hint="Optional. Leave blank to reuse the primary model.">
                Light Model
              </FieldLabel>
              <input
                type="text"
                value={settings.general.lightModel}
                onChange={(event) => update((draft) => { draft.general.lightModel = event.target.value; })}
                placeholder={preset.defaultLightModel || "optional model id"}
                className="w-full rounded-xl border border-line bg-white/80 px-3 py-2 text-sm text-text focus:border-accent/30 focus:outline-none focus:ring-2 focus:ring-accent/10"
              />
            </div>
          ) : null}

          <div>
            <FieldLabel hint="Leave blank to use the selected provider default.">
              API Base URL
            </FieldLabel>
            <input
              type="url"
              value={settings.general.baseUrl}
              onChange={(event) => update((draft) => { draft.general.baseUrl = event.target.value; })}
              placeholder={preset.baseUrl || "https://..."}
              className="w-full rounded-xl border border-line bg-white/80 px-3 py-2 text-sm text-text placeholder:text-soft focus:border-accent/30 focus:outline-none focus:ring-2 focus:ring-accent/10"
            />
          </div>

          <div>
            <FieldLabel hint="Stored locally in the Electron user data directory.">
              API Key
            </FieldLabel>
            <MaskedInput
              value={settings.general.apiKey}
              onChange={(value) => update((draft) => { draft.general.apiKey = value; })}
              placeholder="Paste your provider API key"
            />
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
