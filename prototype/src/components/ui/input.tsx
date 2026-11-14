import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 py-1 text-base leading-6 transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground placeholder:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-[rgb(226_230_223/70%)] disabled:text-[rgb(115_136_116/80%)] aria-invalid:border-destructive aria-invalid:bg-[var(--haldir-error-bg)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
