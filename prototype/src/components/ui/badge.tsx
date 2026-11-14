import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "group/badge inline-flex w-fit max-w-full items-center gap-1 rounded-sm border border-transparent px-2 py-1 text-xs leading-4.5 font-semibold whitespace-normal focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-3 [&>svg]:pointer-events-none [&>svg]:size-3.5 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "border-destructive bg-[var(--haldir-error-bg)] text-destructive",
        info: "border-[var(--haldir-info)] bg-[var(--haldir-info-bg)] text-[var(--haldir-info)]",
        success: "border-[var(--haldir-success)] bg-[var(--haldir-success-bg)] text-[var(--haldir-success)]",
        warning: "border-[var(--haldir-warning)] bg-[var(--haldir-warning-bg)] text-[var(--haldir-warning)]",
        error: "border-[var(--haldir-error)] bg-[var(--haldir-error-bg)] text-[var(--haldir-error)]",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-[var(--haldir-forest)] underline underline-offset-4",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
