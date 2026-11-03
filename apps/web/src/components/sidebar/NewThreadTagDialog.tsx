// fork: thread tags, see FORK.md.
import { normalizeThreadTag, THREAD_TAG_MAX_LENGTH } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

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

type Request = {
  readonly existing: ReadonlyArray<string>;
  readonly resolve: (tag: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks for a tag name; resolves null when the dialog is dismissed. */
export function requestNewThreadTag(existing: ReadonlyArray<string>): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { existing, resolve } }));
}

function finish(tag: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(tag);
}

export function NewThreadTagDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending tag request promise with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <NewThreadTagDialog existing={request.existing} /> : null;
}

function NewThreadTagDialog({ existing }: { readonly existing: ReadonlyArray<string> }) {
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const tag = normalizeThreadTag(value);
            if (tag === "") {
              setError("Enter a tag name.");
              return;
            }
            finish(tag);
          }}
        >
          <DialogHeader>
            <DialogTitle>New tag</DialogTitle>
            <DialogDescription>Tags show on the thread's row in the sidebar.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-tag`}>Tag</Label>
              <Input
                id={`${id}-tag`}
                nativeInput
                autoFocus
                autoComplete="off"
                list={existing.length > 0 ? `${id}-existing` : undefined}
                maxLength={THREAD_TAG_MAX_LENGTH}
                placeholder="e.g. waiting on review"
                value={value}
                onChange={(event) => {
                  setValue(event.currentTarget.value);
                  setError(null);
                }}
              />
              {existing.length > 0 && (
                <datalist id={`${id}-existing`}>
                  {existing.map((tag) => (
                    <option key={tag} value={tag} />
                  ))}
                </datalist>
              )}
            </div>
            {error && (
              <p role="alert" className="mt-2 text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Add tag</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
