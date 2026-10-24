// fork: limits, see FORK.md.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ResourceLimitsSettings,
  ResourceLimitsStatus,
} from "@t3tools/contracts";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useContext, useEffect, useRef, useState } from "react";

import { usePrimarySettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import type { EnvironmentPresentation } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import {
  limitFieldsFor,
  limitsForm,
  limitsLabel,
  limitsPatch,
  limitsStateLabel,
  readingsLabel,
} from "./MachineLimits.logic";
import { searchableSetting } from "./settingsSearch";

// The server reads its host every 15 s, so a faster refresh would only repeat a reading.
const READINGS_REFRESH_MS = 15_000;
const NO_SAVED_LIMITS: ResourceLimitsSettings = {};

const hasLimits = (environment: EnvironmentPresentation) =>
  environment.serverConfig?.environment.capabilities.resourceLimits === true;

/** Load balancing needs two machines, but one machine's limits still need a home. */
export function MachineLimitsSection({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const machine = environments[0];
  if (machine === undefined || !hasLimits(machine)) return null;
  const { id, title } = searchableSetting("load-balancing");
  return (
    <FoldedSettingsSection id={id} title={title}>
      <EnvironmentRow
        kind={resolveEnvironmentMachineKind(machine.serverConfig)}
        label={machine.label}
        subtitle={environmentTransportLabel(machine)}
        detail={<MachineLimits environment={machine} />}
      />
    </FoldedSettingsSection>
  );
}

/** Mounted only while Load balancing is unfolded, so folded settings never poll a host. */
export function MachineLimits({ environment }: { readonly environment: EnvironmentPresentation }) {
  return hasLimits(environment) ? (
    <MachineLimitsStatus environmentId={environment.environmentId} label={environment.label} />
  ) : null;
}

function MachineLimitsStatus({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const registry = useContext(RegistryContext);
  const resourcesAtom = serverEnvironment.hostResources({ environmentId, input: {} });
  const result = useAtomValue(resourcesAtom);
  const saved =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.resourceLimits ??
    NO_SAVED_LIMITS;
  const canEdit = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => registry.refresh(resourcesAtom), READINGS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [registry, resourcesAtom]);

  // The server applies a save to its status at once, so read it again rather than wait.
  const shownFor = useRef(saved);
  useEffect(() => {
    if (shownFor.current === saved) return;
    shownFor.current = saved;
    registry.refresh(resourcesAtom);
  }, [registry, resourcesAtom, saved]);

  const status = result._tag === "Success" ? result.value.limits : undefined;
  if (status === undefined) return null;
  const formatUntil = (epochMs: number) =>
    formatUpcomingTimestamp(new Date(epochMs).toISOString(), timestampFormat);

  return (
    <div className="mt-1.5 flex items-start justify-between gap-3">
      <div className="min-w-0 text-xs text-muted-foreground">
        <p className="text-foreground">{limitsStateLabel(status, formatUntil)}</p>
        <p>{readingsLabel(status)}</p>
        <p>{limitsLabel(status.limits)}</p>
      </div>
      <Button size="xs" variant="outline" disabled={!canEdit} onClick={() => setEditing(true)}>
        Edit limits
      </Button>
      {editing ? (
        <MachineLimitsDialog
          environmentId={environmentId}
          label={label}
          status={status}
          saved={saved}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

function MachineLimitsDialog({
  environmentId,
  label,
  status,
  saved,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: ResourceLimitsStatus;
  readonly saved: ResourceLimitsSettings;
  readonly onClose: () => void;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [form, setForm] = useState(() => limitsForm(saved));
  const patch = limitsPatch(form, status.limits);

  const save = () => {
    if (patch === null) return;
    updateSettings({ resourceLimits: patch });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Limits on {label}</DialogTitle>
          <DialogDescription>
            {status.limits.usesMemoryPressure
              ? "macOS memory pressure always pauses work at warn and is critical at critical. "
              : null}
            Leave a field empty to use this machine's default.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid grid-cols-2 gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {limitFieldsFor(status.limits).map((field) => {
              const id = `machine-limit-${field.key}`;
              const current = status.limits[field.key];
              return (
                <div key={field.key} className="grid gap-1.5">
                  <Label htmlFor={id}>
                    {field.label} ({field.unit})
                  </Label>
                  <Input
                    id={id}
                    inputMode="decimal"
                    placeholder={
                      saved[field.key] !== undefined
                        ? "Default"
                        : current === null
                          ? "Off"
                          : String(current)
                    }
                    value={form[field.key]}
                    onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
                  />
                </div>
              );
            })}
            <button type="submit" hidden />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={patch === null}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
