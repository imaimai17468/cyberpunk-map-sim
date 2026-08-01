import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { Header } from "@/components/shared/header/Header";
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
  notFoundComponent: () => <p>ページが見つかりません</p>,
});

function RootComponent() {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body
        className="antialiased"
        style={{
          fontFamily:
            '"Hiragino Kaku Gothic ProN", "ヒラギノ角ゴ ProN W3", "Hiragino Kaku Gothic Pro", "ヒラギノ角ゴ Pro W3", "メイリオ", Meiryo, "游ゴシック", YuGothic, sans-serif',
        }}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          <div className="flex min-h-dvh flex-col gap-16">
            <Header />
            <div className="flex w-full flex-1 justify-center px-6 md:px-4">
              <div className="container w-full">
                <Outlet />
              </div>
            </div>
          </div>
          <Toaster richColors position="top-center" />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
