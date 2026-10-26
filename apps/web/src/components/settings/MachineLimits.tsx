// fork: limits, see FORK.md.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EffectiveResourceLimits,
  EnvironmentId,
  ResourceLimitsSettings,
  ResourceLimitsStatus,
} from "@t3tools/contracts";
import { resolveEnvironmentMachineKind, USE_PERCENT } from "@t3tools/contracts";
import { useContext, useEffect, useId, useRef, useState } from "react";

import { usePrimarySettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import type { EnvironmentPresentation } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import {
  consequences,
  holdLabel,
  limitFieldsFor,
  limitsForm,
  limitsPatch,
  limitsStateLabel,
  percentOnlyLimits,
  previewLimits,
  usageLabel,
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

  // oxlint-disable-next-line t3code/react-effect-budget -- polls this machine's readings on a timer while they are on screen
  useEffect(() => {
    const timer = setInterval(() => registry.refresh(resourcesAtom), READINGS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [registry, resourcesAtom]);

  // The server applies a save to its status at once, so read it again rather than wait.
  const shownFor = useRef(saved);
  // oxlint-disable-next-line t3code/react-effect-budget -- saved limits also change from other clients, so readings refresh whenever they do
  useEffect(() => {
    if (shownFor.current === saved) return;
    shownFor.current = saved;
    registry.refresh(resourcesAtom);
  }, [registry, resourcesAtom, saved]);

  const resources = result._tag === "Success" ? result.value : undefined;
  const status = resources?.limits;
  if (resources === undefined || status === undefined) return null;
  const totalBytes = resources.totalMemoryBytes;
  const formatUntil = (epochMs: number) =>
    formatUpcomingTimestamp(new Date(epochMs).toISOString(), timestampFormat);

  return (
    <div className="mt-1.5 flex items-start justify-between gap-3">
      <div className="min-w-0 text-xs text-muted-foreground">
        <p className="text-foreground">
          {limitsStateLabel(status, formatUntil)} · {usageLabel(status, totalBytes)}
        </p>
        <p>{holdLabel(status.limits, saved, totalBytes)}</p>
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
          totalBytes={totalBytes}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

const gib = (bytes: number) => `${Math.round(bytes / 1024 ** 3)} GiB`;

function MachineLimitsDialog({
  environmentId,
  label,
  status,
  saved,
  totalBytes,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: ResourceLimitsStatus;
  readonly saved: ResourceLimitsSettings;
  readonly totalBytes: number;
  readonly onClose: () => void;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const commitCharge = !status.limits.usesMemoryPressure;
  const [form, setForm] = useState(() => limitsForm(saved, commitCharge));
  const patch = limitsPatch(form, commitCharge);
  const fields = limitFieldsFor(commitCharge);
  const followed = percentOnlyLimits(form, commitCharge, totalBytes);

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
            How full agents may make this machine&apos;s memory before T3 holds their new work.
            Messages you send yourself always start.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {commitCharge ? null : (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Hold work at a share of memory too</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    macOS memory pressure holds new agent work when it warns, and stops the newest
                    turn when it&apos;s critical.
                  </p>
                </div>
                <Switch
                  aria-label="Hold work at a share of memory too"
                  checked={form.usePercent !== null}
                  onCheckedChange={(checked) =>
                    setForm({ ...form, usePercent: checked ? USE_PERCENT.default : null })
                  }
                />
              </div>
            )}
            {form.usePercent === null ? null : (
              <UsePercent
                percent={form.usePercent}
                totalBytes={totalBytes}
                limits={previewLimits(form, commitCharge, totalBytes)}
                onPercent={(usePercent) => setForm({ ...form, usePercent })}
              />
            )}
            <Collapsible defaultOpen={fields.some(({ key }) => saved[key] !== undefined)}>
              <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-4 hover:underline">
                Advanced: set each line yourself
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="grid gap-3 pt-3">
                  <p className="text-xs text-muted-foreground">
                    {form.usePercent === null
                      ? "Empty fields stay off."
                      : "Empty fields follow the percentage. A filled one wins."}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {fields.map((field) => {
                      const id = `machine-limit-${field.key}`;
                      const placeholder = followed[field.key];
                      return (
                        <div key={field.key} className="grid content-end gap-1.5">
                          <Label htmlFor={id}>
                            {field.label} ({field.unit})
                          </Label>
                          <Input
                            id={id}
                            size="sm"
                            inputMode="decimal"
                            placeholder={placeholder === null ? "Off" : String(placeholder)}
                            value={form.lines[field.key]}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                lines: { ...form.lines, [field.key]: event.target.value },
                              })
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </CollapsiblePanel>
            </Collapsible>
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

function UsePercent({
  percent,
  totalBytes,
  limits,
  onPercent,
}: {
  readonly percent: number;
  readonly totalBytes: number;
  readonly limits: EffectiveResourceLimits;
  readonly onPercent: (percent: number) => void;
}) {
  const labelId = useId();
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <p id={labelId} className="text-sm">
            Use up to <span className="text-2xl font-semibold tabular-nums">{percent}%</span> of
            this machine&apos;s memory
          </p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {gib(totalBytes)}
            {percent === USE_PERCENT.default ? " · default" : null}
          </span>
        </div>
        <Slider
          aria-labelledby={labelId}
          value={percent}
          onValueChange={onPercent}
          min={USE_PERCENT.minimum}
          max={USE_PERCENT.maximum}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{USE_PERCENT.minimum}% · more room for you</span>
          <span>{USE_PERCENT.maximum}% · more for agents</span>
        </div>
      </div>
      <div className="grid gap-1.5 text-sm">
        {consequences(limits, totalBytes).map((line) => (
          <p key={line.text}>
            <span className="font-medium">{line.text}</span>{" "}
            <span className="text-muted-foreground">({line.detail})</span>
          </p>
        ))}
        {limits.pauseAvailableGiB === null || limits.usesMemoryPressure ? null : (
          <p className="text-xs text-muted-foreground">
            Also holds work while available memory is under {Math.round(limits.pauseAvailableGiB)}{" "}
            GiB. &ldquo;Left&rdquo; is the room programs can still reserve, so it counts the page
            file.
          </p>
        )}
      </div>
    </div>
  );
}
