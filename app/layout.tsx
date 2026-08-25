import type { Metadata } from "next"
import { Footer, Layout, Navbar } from "nextra-theme-docs"
import { Head } from "nextra/components"
import { getPageMap } from "nextra/page-map"

import { AskAI } from "./_components/ask-ai"

import "nextra-theme-docs/style.css"
import "./globals.css"

export const metadata: Metadata = {
  title: {
    default: "CaseWize Help",
    template: "%s — CaseWize Help",
  },
  description:
    "How to run a matter in CaseWize: intake, documents, analysis, the client portal, tasks and firm settings.",
}

const navbar = (
  <Navbar
    logo={
      <span className="cw-logo">
        <b>CaseWize</b>
        <span className="cw-logo-sub">Help</span>
      </span>
    }
    projectLink="https://casewize.com"
  >
    <AskAI />
  </Navbar>
)

const footer = (
  <Footer>
    <span>
      CaseWize — legal case intelligence. This help centre describes the product
      as it ships; your firm&apos;s plan and your role decide how much of it you
      see.
    </span>
  </Footer>
)

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={navbar}
          footer={footer}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/casewize/casewize-docs/tree/main"
          sidebar={{ defaultMenuCollapseLevel: 1, autoCollapse: true }}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
