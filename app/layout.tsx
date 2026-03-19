import type { Metadata } from "next"
import { Outfit, Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google"
import "./globals.css"

const display = Outfit({
  subsets: ["latin"],
  variable: "--font-nova-display",
  weight: ["300", "400", "500", "600", "700"],
})

const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-nova-sans",
})

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-nova-mono",
})

export const metadata: Metadata = {
  title: "commcare nova",
  description: "Build CommCare mobile apps from natural language",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${display.variable} ${sans.variable} ${mono.variable} antialiased nova-noise`}>
        {children}
      </body>
    </html>
  )
}
