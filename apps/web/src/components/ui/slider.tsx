// fork: limits, see FORK.md.
import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "~/lib/utils";

/** A one-thumb slider. Label it with `aria-labelledby`, which reaches the thumb's range input. */
function Slider({ className, ...props }: SliderPrimitive.Root.Props<number>) {
  return (
    <SliderPrimitive.Root className={cn("w-full", className)} data-slot="slider" {...props}>
      <SliderPrimitive.Control
        className="flex h-5 w-full touch-none select-none items-center data-disabled:pointer-events-none data-disabled:opacity-64"
        data-slot="slider-control"
      >
        <SliderPrimitive.Track
          className="relative h-1.5 w-full rounded-full bg-input"
          data-slot="slider-track"
        >
          <SliderPrimitive.Indicator
            className="rounded-full bg-primary"
            data-slot="slider-indicator"
          />
          <SliderPrimitive.Thumb
            className="size-4 rounded-full border border-primary bg-background shadow-xs/5 outline-none transition-shadow has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring"
            data-slot="slider-thumb"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
