import type { Metadata } from "next";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { adminConfig } from "@/server/admin-config";
import { Inter, Vazirmatn } from "next/font/google";
import { isLocale } from "@/i18n/config";
import { Providers } from "@/components/layout/providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const vazir = Vazirmatn({
  subsets: ["arabic", "latin"],
  variable: "--font-vazir",
  display: "swap",
});

export const metadata: Metadata = {
  title: "NodeGuard | Infrastructure Monitoring",
  description: "NodeGuard infrastructure monitoring and management",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  const adminMode = Boolean(adminConfig());
  const localeCookie = (await cookies()).get("nodeguard-locale")?.value;
  const locale = isLocale(localeCookie) ? localeCookie : "en-US";
  const direction = locale === "fa-IR" ? "rtl" : "ltr";
  return (
    <html lang={locale} dir={direction} className={`${inter.variable} ${vazir.variable} h-full`} suppressHydrationWarning>
      <body className="min-h-full antialiased">
        <Providers adminMode={adminMode} initialLocale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
