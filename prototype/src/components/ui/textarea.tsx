import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-background px-2.5 py-2 text-base leading-6 transition-colors outline-none placeholder:text-muted-foreground placeholder:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-3 disabled:cursor-not-allowed disabled:bg-[rgb(226_230_223/70%)] disabled:text-[rgb(115_136_116/80%)] aria-invalid:border-destructive aria-invalid:bg-[var(--haldir-error-bg)]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
