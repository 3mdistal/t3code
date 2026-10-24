import { createFileRoute } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { ProviderPoolsSettings } from "../components/settings/ProviderPoolsSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsAccountPoolsRoute() {
  const { environment, scope } = useSettingsScope();
  const gt = useGT();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? gt("Reconnect {environment} to set up its account pools.", { environment: scope.label })
          : gt("Connect an environment to set up its account pools.")}
      </p>
    );
  }
  return <ProviderPoolsSettings environmentId={environment.environmentId} />;
}

export const Route = createFileRoute("/_chat/settings/account-pools")({
  component: SettingsAccountPoolsRoute,
});
