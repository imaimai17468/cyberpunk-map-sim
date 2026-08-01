"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const isValidTheme = (t: string): t is "light" | "dark" =>
  t === "dark" || t === "light";

// CSS custom properties are not part of `CSSProperties`, so the object is typed
// as an intersection that admits `--*` keys. Declaring the type is what makes it
// assignable to `style` — no assertion needed, so the value stays type-checked.
const toasterTokens: React.CSSProperties & Record<`--${string}`, string> = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
};

const Toaster = ({ ...props }: ToasterProps) => {
  // `forcedTheme` first: next-themes keeps it as its own context field and
  // never folds it into `theme`, which stays whatever is in storage or the
  // default. Reading `theme` alone therefore hands back `"light"` for anyone
  // whose browser still holds a value written before the app was pinned to
  // dark, and the toasts come up light against a dark page.
  const { theme = "light", forcedTheme } = useTheme();
  const requested = forcedTheme ?? theme;
  const resolvedTheme = isValidTheme(requested) ? requested : "light";

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      style={toasterTokens}
      {...props}
    />
  );
};

export { Toaster };
