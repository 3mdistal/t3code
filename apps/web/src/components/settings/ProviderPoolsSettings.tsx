import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../state/server";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { ProviderLimitedUntil } from "./ProviderLimitedUntil";
import {
  buildProviderPoolCards,
  buildProviderPoolPatch,
  modelCoverageLabel,
  type ProviderPoolChange,
} from "./ProviderPoolsSettings.logic";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function ProviderPoolsSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const providerPools = useEnvironmentSettings(environmentId, (settings) => settings.providerPools);
  const supportsProviderPools = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.providerPools === true,
  );
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const gt = useGT();
  const messages = useMessages();
  const cards = buildProviderPoolCards(providers, providerPools, messages);
  const searchableSetting = useSearchableSetting();
  const { id, title } = searchableSetting("account-pools");

  if (!supportsProviderPools) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          <T>This environment's server is too old for account pools. Update it to use them.</T>
        </p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer className="gap-8">
      <SettingsSection id={id} title={title}>
        <SettingsRow
          title={gt("Share the work across accounts")}
          description={gt(
            "Pool a provider's accounts into one model picker entry. A thread runs on the account with the most usage left until it hits a limit, then moves on: Claude from a summary, a shared Codex home natively.",
          )}
        />
      </SettingsSection>
      {cards.length === 0 ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          <T>Add a second account for a provider on the Providers page to pool them.</T>
        </p>
      ) : (
        cards.map((card) => {
          const update = (change: ProviderPoolChange) =>
            updateSettings({ providerPools: buildProviderPoolPatch(card.driver, change) });
          return (
            <SettingsSection key={card.driver} title={card.label}>
              <SettingsRow
                title={gt("Pool these accounts")}
                description={
                  card.canEnable
                    ? gt(
                        "One {provider} entry in the model picker, with turns routed across the ticked accounts.",
                        { provider: card.label },
                      )
                    : gt("Tick at least two accounts to turn the pool on.")
                }
                status={
                  card.modelCoverage ? modelCoverageLabel(card.modelCoverage, messages) : undefined
                }
                control={
                  // The server ignores a pool with fewer than two accounts, so the
                  // switch shows the pool as off there even though the setting stays on.
                  <Switch
                    aria-label={gt("Pool {provider} accounts", { provider: card.label })}
                    checked={card.enabled && card.canEnable}
                    disabled={!canManage || !card.canEnable}
                    onCheckedChange={(enabled) => update({ type: "enabled", enabled })}
                  />
                }
              />
              {card.candidates.map((candidate) => (
                <SettingsRow
                  key={candidate.instanceId}
                  title={candidate.displayName}
                  description={
                    <>
                      <span className="block">
                        {candidate.status}
                        <ProviderLimitedUntil
                          provider={candidate.provider}
                          className="ms-1.5 text-warning-foreground"
                        />
                      </span>
                      {candidate.continuationHint ? (
                        <span className="block">{candidate.continuationHint}</span>
                      ) : null}
                      {candidate.sameLoginHint ? (
                        <span className="block text-muted-foreground">
                          {candidate.sameLoginHint}
                        </span>
                      ) : null}
                    </>
                  }
                  control={
                    <Checkbox
                      aria-label={gt("Include {account} in the {provider} pool", {
                        account: candidate.displayName,
                        provider: card.label,
                      })}
                      checked={candidate.ticked}
                      disabled={!canManage}
                      onCheckedChange={(ticked) =>
                        update({ type: "tick", instanceId: candidate.instanceId, ticked })
                      }
                    />
                  }
                />
              ))}
            </SettingsSection>
          );
        })
      )}
    </SettingsPageContainer>
  );
}
