// fork: thread tags, see FORK.md.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { TagIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { threadTagHue, useThreadTags } from "./threadTags";

/** A short upright bar, since a round dot in the sidebar means a status needs attention. */
export const threadTagDotClassName = "h-2.5 w-1 shrink-0 rounded-full";
/** A tag's color, the same on rows, the hover card and the filter menu. */
export const threadTagDotStyle = (tag: string) => ({
  backgroundColor: `oklch(0.7 0.14 ${threadTagHue(tag)})`,
});

/**
 * A thread's tags as small chips; extra tags fold into "+N", and the hover card lists them all.
 * `dots` shows only each tag's color, for one-line rows where a chip would crowd out the title.
 */
export function ThreadTagChips(props: {
  readonly tags: ReadonlyArray<string>;
  readonly max: number;
  readonly dots?: boolean;
  readonly className?: string;
}) {
  if (props.tags.length === 0) return null;
  const shown = props.tags.slice(0, props.max);
  const hidden = props.tags.length - shown.length;
  if (props.dots) {
    return (
      <span
        aria-hidden
        data-testid="sidebar-thread-tags"
        className={cn("flex shrink-0 items-center gap-0.5", props.className)}
      >
        {shown.map((tag) => (
          <span key={tag} className={threadTagDotClassName} style={threadTagDotStyle(tag)} />
        ))}
        {hidden > 0 ? (
          <span className="ms-0.5 text-2xs leading-4 text-muted-foreground">+{hidden}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span
      data-testid="sidebar-thread-tags"
      className={cn("flex min-w-0 shrink items-center gap-1 overflow-hidden", props.className)}
    >
      {shown.map((tag) => (
        <span
          key={tag}
          className="inline-flex min-w-0 max-w-24 items-center gap-1 rounded-sm bg-muted/70 px-1 text-2xs leading-4 text-muted-foreground"
        >
          <span aria-hidden className={threadTagDotClassName} style={threadTagDotStyle(tag)} />
          <span className="min-w-0 truncate">{tag}</span>
        </span>
      ))}
      {hidden > 0 ? (
        <span className="shrink-0 text-2xs leading-4 text-muted-foreground">+{hidden}</span>
      ) : null}
    </span>
  );
}

/** Every tag, for the row's hover card. */
export function ThreadTagsDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const tags = useThreadTags(props.environmentId, props.threadId);
  if (tags.length === 0) return null;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <TagIcon className="mt-0.5 size-3 shrink-0 stroke-muted-foreground" />
      <div className="min-w-0 break-words text-foreground/75">{tags.join(", ")}</div>
    </div>
  );
}
