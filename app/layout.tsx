import type { Metadata } from "next";
import "./globals.css";
import "./editor/themes.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://cutline-video-editor.vtbyx49kb2.chatgpt.site"),
  title: {
    default: "Cutline — Free local video editor",
    template: "%s · Cutline",
  },
  description:
    "Edit video locally with a fast multitrack timeline, text, filters, captions, and watermark-free export.",
  applicationName: "Cutline",
  keywords: ["video editor", "free video editor", "local video editor", "timeline editor"],
  icons: {
    icon: "/icon.png",
    shortcut: "/icon.png",
    apple: "/icon.png",
  },
  openGraph: {
    type: "website",
    title: "Cutline — Your edit. Your device. Zero paywalls.",
    description: "A fast, private, watermark-free video editor with no account or subscription.",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "Cutline free local video editor" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Cutline — Your edit. Your device. Zero paywalls.",
    description: "A fast, private, watermark-free video editor with no account or subscription.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="cutline-app">{children}</body>
    </html>
  );
}
