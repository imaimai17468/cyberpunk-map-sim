import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { ThemeProvider } from "@/components/shared/theme-provider/ThemeProvider";
import { Toaster } from "@/components/ui/sonner";
import "@/styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Cyberpunk city generator" },
    ],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <div className="flex h-dvh items-center justify-center p-6">
      <p className="text-muted-foreground text-sm">ページが見つかりません</p>
    </div>
  ),
});

/**
 * The application shell.
 *
 * There is no header and no centred content column. The app is one screen — a
 * generated city filling the viewport with its controls floating over it — so a
 * chrome band across the top would be a strip of dead space above the thing
 * people came to look at, and a max-width container would letterbox a map that
 * wants every pixel. The route owns the whole viewport instead.
 *
 * The theme is forced dark rather than switchable. The one screen is a city at
 * night; there is no coherent light reading of it, and a toggle offering one
 * would promise something the app cannot deliver. `ThemeProvider` stays because
 * `Toaster` resolves its theme through it.
 *
 * The body font comes from `--font-sans` in `styles.css` rather than an inline
 * style, so the token is the single place it is decided.
 */
function RootComponent() {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="h-dvh overflow-hidden bg-background font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          forcedTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          <Outlet />
          <Toaster richColors position="top-center" />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
