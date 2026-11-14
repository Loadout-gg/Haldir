import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-3 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:bg-[rgb(226_230_223/70%)] disabled:bg-none disabled:text-[rgb(115_136_116/80%)] disabled:shadow-none aria-invalid:border-destructive aria-invalid:bg-[var(--haldir-error-bg)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-[linear-gradient(180deg,var(--primary),var(--haldir-accent-depth))] text-primary-foreground shadow-[inset_0_1px_0_var(--haldir-ivory),inset_0_-1px_0_var(--haldir-lichen),0_2px_4px_rgb(21_37_31/25%)] enabled:hover:bg-[linear-gradient(180deg,var(--haldir-accent-depth),var(--primary))]",
        "brand-preparatory": "whitespace-normal text-base leading-5 font-semibold tracking-[.012em] bg-primary text-primary-foreground shadow-none enabled:hover:bg-primary/90",
        "brand-primary": "whitespace-normal text-base leading-5 font-semibold tracking-[.012em] bg-[linear-gradient(180deg,var(--haldir-accent-depth),var(--primary))] text-primary-foreground shadow-[inset_0_-1px_0_var(--haldir-ivory),inset_0_1px_0_var(--haldir-lichen),0_2px_4px_rgb(21_37_31/25%),0_0_24px_rgb(213_231_163/80%)] enabled:hover:bg-[linear-gradient(180deg,var(--primary),var(--haldir-accent-depth))]",
        "brand-dark": "bg-[linear-gradient(180deg,var(--haldir-forest),var(--haldir-dark-forest))] text-[var(--haldir-ivory)] shadow-[inset_0_1px_0_var(--haldir-dark-edge),inset_0_-1px_0_var(--haldir-ink),0_2px_4px_rgb(21_37_31/25%)] enabled:hover:bg-[linear-gradient(180deg,var(--haldir-dark-forest),var(--haldir-forest))]",
        outline:
          "border-input bg-background shadow-none enabled:hover:bg-muted enabled:hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "border-destructive bg-[var(--haldir-error-bg)] text-destructive enabled:hover:underline",
        link: "text-[var(--haldir-forest)] underline underline-offset-4",
      },
      size: {
        brand: "h-auto min-h-13 gap-2.5 px-8 py-4",
        "action-secondary": "h-auto min-h-[54px] gap-2 px-4 py-4 leading-5",
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-11",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = variant === "brand-primary" || variant === "brand-preparatory" ? "brand" : "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
